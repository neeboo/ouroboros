import { createHash } from "node:crypto";
import type { Harness, Status } from "@ouroboros/harness";
import {
  INITIAL_LINEAR_INTAKE_POLLING_STATE,
  getLinearIntakeState,
  type LinearIntakePollingState,
} from "./linear-intake";
import type {
  DashboardLinearIntakeEventSummary,
  DashboardLinearIntakeLifecycle,
  DashboardLinearIntakePollingSummary,
  DashboardLinearIntakeRunnerSummary,
} from "./dashboard-workspace-model";

/**
 * Harness shape accepted by the lifecycle builder. The dashboard server already
 * resolves runner/supervisor status objects when serving `/api/runs/:runId`;
 * reusing them here keeps intake rendering consistent with the runner card.
 */
export interface DashboardLinearIntakeRunnerStatus {
  status: "idle" | "running" | "exited";
  pid?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  exitCode?: number | null;
  lastOutput?: string;
  externallyManaged?: boolean;
}

export interface BuildDashboardLinearIntakeLifecycleInput {
  harness: Harness;
  rootRunId: string;
  /** When false, polling is not configured for this installation. */
  configured?: boolean;
  /** Run-level runner status, when known. */
  runner?: DashboardLinearIntakeRunnerStatus | null;
  /** Self-improvement supervisor status, when known. */
  supervisor?: DashboardLinearIntakeRunnerStatus | null;
  /** Cap the number of intake events rendered to bound dashboard payload. */
  eventLimit?: number;
}

const DEFAULT_INTAKE_EVENT_LIMIT = 25;
const LINEAR_PROVIDER = "linear";
const LINEAR_ISSUE_EVENT_TYPE = "issue.created";

/**
 * Build a read-only snapshot of the Linear intake lifecycle for the dashboard.
 * Pulls durable polling state from the supervised root run context, lists
 * provider=linear inbox events, and joins each event to its derived Designer
 * run/task and any run-to-issue external reference. Tokens are never read or
 * returned; only durable harness rows and run context are surfaced.
 *
 * Persisted polling state is always read, even when `configured` is false. This
 * keeps a durable terminal failure (e.g. a persisted `config_error` recorded
 * before the configuration became unreadable) visible to operators instead of
 * being silently replaced by the initial idle state.
 */
export function buildDashboardLinearIntakeLifecycle(
  input: BuildDashboardLinearIntakeLifecycleInput,
): DashboardLinearIntakeLifecycle {
  const configured = input.configured !== false;
  const pollingState = safePollingState(input.harness, input.rootRunId);

  const eventLimit = Math.max(1, input.eventLimit ?? DEFAULT_INTAKE_EVENT_LIMIT);
  const inboxEvents = input.harness.listInboxEvents({
    provider: LINEAR_PROVIDER,
    limit: eventLimit,
  });

  const events: DashboardLinearIntakeEventSummary[] = [];
  for (const event of inboxEvents) {
    if (event.eventType !== LINEAR_ISSUE_EVENT_TYPE) continue;
    events.push(summarizeEvent(input.harness, input.rootRunId, event));
  }

  return {
    polling: summarizePolling(configured, pollingState),
    runner: summarizeRunner(input.runner ?? null, input.supervisor ?? null),
    events,
  };
}

function safePollingState(harness: Harness, rootRunId: string): LinearIntakePollingState {
  try {
    return getLinearIntakeState(harness, rootRunId);
  } catch {
    return { ...INITIAL_LINEAR_INTAKE_POLLING_STATE };
  }
}

function summarizePolling(
  configured: boolean,
  state: LinearIntakePollingState,
): DashboardLinearIntakePollingSummary {
  return {
    configured,
    lastStatus: state.lastStatus,
    terminalFailure: redactSecrets(state.terminalFailure),
    lastError: redactSecrets(state.lastError),
    lastCycleAt: state.lastCycleAt,
    nextEligiblePollAt: state.nextEligiblePollTime,
    retryAttempt: state.retryAttempt,
    cyclesCompleted: state.cyclesCompleted,
    issuesIngested: state.issuesIngested,
    issuesDeduplicated: state.issuesDeduplicated,
    issuesRejected: state.issuesRejected,
    issuesMalformed: state.issuesMalformed,
  };
}

function summarizeRunner(
  runner: DashboardLinearIntakeRunnerStatus | null,
  supervisor: DashboardLinearIntakeRunnerStatus | null,
): DashboardLinearIntakeRunnerSummary {
  const runnerStatus = runner?.status ?? "idle";
  const supervisorStatus = supervisor?.status ?? "idle";
  return {
    supervisorRunning: supervisorStatus === "running",
    supervisorStatus,
    runnerRunning: runnerStatus === "running",
    runnerStatus,
  };
}

function summarizeEvent(
  harness: Harness,
  rootRunId: string,
  event: {
    id: string;
    provider: string;
    eventType: string;
    externalId: string;
    payload: Record<string, unknown>;
    status: Status;
    createdAt: string | null;
    processedAt: string | null;
  },
): DashboardLinearIntakeEventSummary {
  const issue = readIssuePayload(event.payload);
  const stable = stableIssueScopedIds(rootRunId, event.externalId);
  const designerRun = stable.runId ? harness.getRun(stable.runId) : null;
  const designerTask = stable.taskId ? harness.getTask(stable.taskId) : null;
  const designerRunContext = designerRun?.context ?? {};
  const contextProposalId =
    readString(designerRunContext, "designProposalId") ??
    readString(designerRunContext, "proposalId");
  const durableProposal = designerRun
    ? findDesignerProposal(harness, designerRun.id, stable.taskId)
    : null;
  const proposal = (contextProposalId ? harness.getDesignProposal({ id: contextProposalId }) : null) ?? durableProposal;
  const proposalId = proposal?.id ?? contextProposalId ?? null;
  const decisionId = readString(designerRunContext, "designDecisionId") ?? readString(designerRunContext, "decisionId");
  const decisions = proposalId ? harness.listDesignDecisions({ proposalId, limit: 5 }) : [];
  const latestDecision = decisions[decisions.length - 1] ?? null;
  const decision = latestDecision ?? (decisionId ? null : null);

  // Planning run: located via the createRunsFromDesign fixed action. The action
  // stamps the child run with linearIntake provenance; we read it defensively
  // so the inspector renders missing or partial provenance without crashing.
  let planningRunId: string | null = null;
  let planningRunStatus: Status | "unknown" = "unknown";
  let externalRefId: string | null = null;
  if (designerRun) {
    const planned = findLinearIntakePlanningRun(harness, designerRun.id, event.externalId, proposalId);
    if (planned) {
      planningRunId = planned.runId;
      planningRunStatus = planned.runStatus;
      externalRefId = planned.externalRefId;
    }
  }

  const blocked = event.status === "blocked";
  const blockedReason = blocked
    ? redactSecrets(
        readString(event.payload, "error") ?? readString(event.payload, "reason") ?? "blocked",
      )
    : null;

  return {
    eventId: event.id,
    externalId: event.externalId,
    status: event.status,
    createdAt: event.createdAt,
    processedAt: event.processedAt,
    issue: {
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      teamKey: issue.teamKey,
    },
    designerRunId: stable.runId,
    designerTaskId: stable.taskId,
    designerTaskStatus: designerTask?.status ?? "unknown",
    proposalId: proposal?.id ?? proposalId,
    proposalStatus: proposal?.status ?? null,
    decisionId: decision?.id ?? decisionId,
    decision: decision?.decision ?? null,
    decisionActorKind: decision?.actorKind ?? null,
    planningRunId,
    planningRunStatus,
    externalRefId,
    blocked,
    blockedReason,
  };
}

function findLinearIntakePlanningRun(
  harness: Harness,
  designerRunId: string,
  externalIssueId: string,
  proposalId?: string | null,
): { runId: string; runStatus: Status | "unknown"; externalRefId: string | null } | null {
  // The fixed-action path stamps child run context with linearIntake.linearIssueId
  // and creates one external_refs row linking planning run to the immutable issue
  // id. Walk design_proposals → decisions → child runs to find it without
  // assuming the exact context key spelling; either signal is sufficient.
  const refs = harness.listExternalRefs({ localType: "run", localId: designerRunId });
  for (const ref of refs) {
    if (ref.provider === "linear" && ref.externalType === "issue" && ref.externalId === externalIssueId) {
      // designerRun itself was linked — older path; surface it.
      const run = harness.getRun(designerRunId);
      return {
        runId: designerRunId,
        runStatus: run?.status ?? "unknown",
        externalRefId: ref.id,
      };
    }
  }
  // Look for any run whose context carries this issue id and that cites the
  // designer run as the source. This covers the createRunsFromDesign path
  // where the child planning run carries linearIntake provenance.
  const recentRuns = harness.listRuns?.({ limit: 200 }) ?? [];
  for (const run of recentRuns) {
    const ctx = run.context ?? {};
    const intake = recordValue(ctx.linearIntake);
    if (!intake) continue;
    const linkedIssue = readString(intake, "linearIssueId");
    const sourceRun =
      readString(intake, "sourceRunId") ??
      readString(intake, "sourceDesignerRunId") ??
      readString(intake, "designerRunId");
    if (linkedIssue !== externalIssueId) continue;
    if (sourceRun && sourceRun !== designerRunId) continue;
    if (proposalId && readString(intake, "proposalId") && readString(intake, "proposalId") !== proposalId) continue;
    const refsForRun = harness.listExternalRefs({ localType: "run", localId: run.id });
    const match = refsForRun.find(
      (ref) => ref.provider === "linear" && ref.externalType === "issue" && ref.externalId === externalIssueId,
    );
    return {
      runId: run.id,
      runStatus: run.status,
      externalRefId: match?.id ?? null,
    };
  }

  // Older fixed-action deliveries preserve durable run relationships but may
  // predate the optional child linearIntake block. The proposal row is keyed
  // to the Designer run, while the planning run points back with parentRunId
  // and designProposalId. Keep that partial provenance visible.
  for (const run of recentRuns) {
    const ctx = run.context ?? {};
    if (readString(ctx, "parentRunId") !== designerRunId) continue;
    if (proposalId && readString(ctx, "designProposalId") !== proposalId) continue;
    const refsForRun = harness.listExternalRefs({ localType: "run", localId: run.id });
    const match = refsForRun.find(
      (ref) => ref.provider === "linear" && ref.externalType === "issue" && ref.externalId === externalIssueId,
    );
    return {
      runId: run.id,
      runStatus: run.status,
      externalRefId: match?.id ?? null,
    };
  }
  return null;
}

function findDesignerProposal(
  harness: Harness,
  designerRunId: string,
  designerTaskId: string,
) {
  try {
    const proposals = harness.listDesignProposals({ limit: 200 });
    return proposals
      .filter((proposal) => proposal.runId === designerRunId)
      .filter((proposal) => !proposal.taskId || proposal.taskId === designerTaskId)
      .sort((left, right) => {
        const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
        const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
        return rightTime - leftTime || right.id.localeCompare(left.id);
      })[0] ?? null;
  } catch {
    // Preserve issue and inbox visibility for legacy or partially initialized
    // databases where strategy tables cannot be read yet.
    return null;
  }
}

function readIssuePayload(payload: unknown): {
  identifier: string | null;
  title: string | null;
  url: string | null;
  teamKey: string | null;
} {
  const rec = recordValue(payload);
  return {
    identifier: readString(rec, "identifier"),
    title: readString(rec, "title"),
    url: readString(rec, "url"),
    teamKey: readString(rec, "teamKey"),
  };
}

function stableIssueScopedIds(rootRunId: string, externalIssueId: string): { runId: string; taskId: string } {
  // Mirrors the derivation in linear-intake.ts so the dashboard can resolve
  // the same durable identities. Stable id format: run_linear_<sha256(rootRunId|issueId)>.
  const material = `${rootRunId}|${externalIssueId}`;
  const digest = createHash("sha256").update(material, "utf8").digest("hex");
  return {
    runId: `run_linear_${digest}`,
    taskId: `task_linear_${digest}`,
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Redact credential-like material from a string before it is exposed to the
 * browser. HTML escaping alone does not stop disclosure: an error message that
 * echoes a `Bearer lin_api_…` token or an `Authorization:` header is still
 * readable in the rendered DOM. This drops the common Linear/OAuth token
 * shapes and HTTP authorization headers, replacing them with `[REDACTED]`.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+\-/]+/gi,
  /\blin_api_[A-Za-z0-9_]+/gi,
  /\blin_oauth_[A-Za-z0-9_]+/gi,
  /\bAuthorization\s*:\s*[^\s,;}\])]+/gi,
];

export function redactSecrets(value: string | null): string | null {
  if (!value) return value;
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}
