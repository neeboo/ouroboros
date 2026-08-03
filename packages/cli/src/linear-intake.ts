import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Harness, InboxEvent } from "@ouroboros/harness";
import {
  pollLinearIssues,
  type LinearPollingCycleResult,
  type LinearPollingConfig,
  type LinearPollingState,
  type LinearPollingStatus,
} from "./linear";
import type { ResolvedLinearPollingConfig } from "./config";

/**
 * Durable Linear polling state. Stored under `context.linearIntake.polling` on
 * the supervised root run so it survives Harness reconstruction and daemon
 * restarts. Permanent failures (auth/scope/config, or exhausted retries on a
 * retryable failure) flip `terminalFailure` to a non-null message and clear
 * `nextEligiblePollTime` so the supervisor stops busy-looping.
 */
export interface LinearIntakePollingState {
  /** Relay cursor pointing past the last durably ingested page. */
  cursor: string | null;
  /** createdAt watermark of the last durably ingested issue. */
  overlapBoundary: string | null;
  /** Durable intra-page continuation key captured when a page is truncated by the per-cycle cap. */
  intraPageContinuation: { createdAt: string; issueId: string } | null;
  /** Number of retry attempts on the current retryable failure. Reset to 0 on success. */
  retryAttempt: number;
  /** ISO timestamp; the next poll is suppressed while now() < nextEligiblePollTime. */
  nextEligiblePollTime: string | null;
  /** Status returned by the most recent cycle (`idle` before any cycle has run). */
  lastStatus: LinearPollingStatus | "idle";
  /** Error message from the most recent failure, when any. */
  lastError: string | null;
  /** Set when polling hit a permanent failure and must not retry without operator action. */
  terminalFailure: string | null;
  /** ISO timestamp of the most recent cycle. */
  lastCycleAt: string | null;
  /**
   * Cached resolved Linear project ID for project_url-only configurations.
   * Re-resolved when the operator-supplied project URL changes.
   */
  resolvedProjectId: string | null;
  /** The project URL that produced `resolvedProjectId`. */
  resolvedProjectUrl: string | null;
  /** Informational counters accumulated since the supervisor started polling. */
  cyclesCompleted: number;
  issuesIngested: number;
  issuesDeduplicated: number;
  issuesRejected: number;
  issuesMalformed: number;
}

export const INITIAL_LINEAR_INTAKE_POLLING_STATE: LinearIntakePollingState = {
  cursor: null,
  overlapBoundary: null,
  intraPageContinuation: null,
  retryAttempt: 0,
  nextEligiblePollTime: null,
  lastStatus: "idle",
  lastError: null,
  terminalFailure: null,
  lastCycleAt: null,
  resolvedProjectId: null,
  resolvedProjectUrl: null,
  cyclesCompleted: 0,
  issuesIngested: 0,
  issuesDeduplicated: 0,
  issuesRejected: 0,
  issuesMalformed: 0,
};

const LINEAR_INTAKE_CONTEXT_KEY = "linearIntake";
const LINEAR_INTAKE_POLLING_KEY = "polling";

export interface LinearTokenInput {
  tokenFile?: string | null;
  tokenEnv?: string | null;
}

export async function readLinearToken(input: LinearTokenInput): Promise<{ token: string; source: string }> {
  const tokenEnv = input.tokenEnv ?? "LINEAR_API_KEY";
  const envValue = process.env[tokenEnv]?.trim();
  if (envValue) {
    return { token: envValue, source: tokenEnv };
  }
  const path = input.tokenFile ?? join(process.cwd(), ".linear");
  const token = (await readFile(path, "utf8")).trim();
  if (!token) {
    throw new Error(`Linear token file is empty: ${path}`);
  }
  return { token, source: path };
}

export interface PollCycleInput {
  harness: Harness;
  rootRunId: string;
  token: string;
  apiUrl: string;
  projectId: string;
  teamKey: string;
  config: ResolvedLinearPollingConfig;
  now?: number;
  fetchImpl?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export type PollCycleReason = "polled" | "not-due" | "terminal" | "disabled";

export interface PollCycleResult {
  reason: PollCycleReason;
  status: LinearPollingStatus | "idle";
  state: LinearIntakePollingState;
  cycle?: LinearPollingCycleResult;
  /** True when the cycle advanced cursor or overlap boundary. */
  advanced: boolean;
}

/**
 * Cheap pre-check that reads durable polling state and returns whether the next
 * cycle would run, be deferred by `nextEligiblePollTime`, or be skipped due to
 * a terminal failure. Performs no token read and no network IO. Use this
 * before paying the cost of resolving a token or project selector.
 */
export function peekLinearPollCycle(
  harness: Harness,
  rootRunId: string,
  now: number = Date.now(),
): { reason: "terminal" | "not-due" | "ready"; state: LinearIntakePollingState } {
  const previous = getLinearIntakeState(harness, rootRunId);
  if (previous.terminalFailure) {
    return { reason: "terminal", state: previous };
  }
  if (previous.nextEligiblePollTime) {
    const eligibleAt = Date.parse(previous.nextEligiblePollTime);
    if (Number.isFinite(eligibleAt) && eligibleAt > now) {
      return { reason: "not-due", state: previous };
    }
  }
  return { reason: "ready", state: previous };
}

/**
 * Persist a terminal blocked intake state. Idempotent: if the durable state is
 * already terminal, leaves it as-is so the original failure remains visible.
 * Otherwise records the failure, clears `nextEligiblePollTime`, and marks
 * `terminalFailure` so subsequent ticks exit fast.
 */
export function persistLinearIntakeTerminal(
  harness: Harness,
  rootRunId: string,
  input: { status: LinearPollingStatus; error: string; now?: number },
): LinearIntakePollingState {
  const previous = getLinearIntakeState(harness, rootRunId);
  if (previous.terminalFailure) {
    return previous;
  }
  const now = input.now ?? Date.now();
  const nextState: LinearIntakePollingState = {
    ...previous,
    lastStatus: input.status,
    lastError: input.error,
    terminalFailure: input.error,
    nextEligiblePollTime: null,
    lastCycleAt: new Date(now).toISOString(),
  };
  setLinearIntakeState(harness, rootRunId, nextState);
  return nextState;
}

/**
 * Persist the cached resolved project selector so subsequent ticks do not pay
 * for a redundant project_url → project_id resolution. Preserves all other
 * durable state.
 */
export function cacheResolvedProjectSelector(
  harness: Harness,
  rootRunId: string,
  input: { projectUrl: string; projectId: string },
): LinearIntakePollingState {
  const previous = getLinearIntakeState(harness, rootRunId);
  if (previous.resolvedProjectUrl === input.projectUrl && previous.resolvedProjectId === input.projectId) {
    return previous;
  }
  const nextState: LinearIntakePollingState = {
    ...previous,
    resolvedProjectId: input.projectId,
    resolvedProjectUrl: input.projectUrl,
  };
  setLinearIntakeState(harness, rootRunId, nextState);
  return nextState;
}

/**
 * Drive one bounded Linear polling cycle for the supervised root run. Reads
 * the durable polling state, refuses to run before `nextEligiblePollTime` or
 * when `terminalFailure` is set, invokes the verified polling primitive, then
 * writes the new state back through `harness.updateRun` only after the
 * primitive returns. State advances only after durable ingestion; the
 * primitive never advances past an ingestion failure, so neither does this
 * driver.
 */
export async function runLinearPollCycle(input: PollCycleInput): Promise<PollCycleResult> {
  const now = input.now ?? Date.now();
  const previous = getLinearIntakeState(input.harness, input.rootRunId);
  if (previous.terminalFailure) {
    return {
      reason: "terminal",
      status: previous.lastStatus,
      state: previous,
      advanced: false,
    };
  }
  if (previous.nextEligiblePollTime) {
    const eligibleAt = Date.parse(previous.nextEligiblePollTime);
    if (Number.isFinite(eligibleAt) && eligibleAt > now) {
      return {
        reason: "not-due",
        status: "idle",
        state: previous,
        advanced: false,
      };
    }
  }
  const pollingConfig: LinearPollingConfig = {
    pageSize: input.config.pageSize,
    maxPagesPerCycle: input.config.maxPagesPerCycle,
    maxIssuesPerCycle: input.config.maxIssuesPerCycle,
    overlapMs: input.config.overlapMs,
    maxRetries: input.config.maxRetries,
    backoffBaseMs: input.config.backoffBaseMs,
    backoffMaxMs: input.config.backoffMaxMs,
  };
  const primitiveState: LinearPollingState = {
    cursor: previous.cursor,
    overlapBoundary: previous.overlapBoundary,
    intraPageContinuation: previous.intraPageContinuation,
  };
  const cycle = await pollLinearIssues({
    harness: input.harness,
    apiUrl: input.apiUrl,
    token: input.token,
    projectId: input.projectId,
    teamKey: input.teamKey,
    config: pollingConfig,
    state: primitiveState,
    retryAttempt: previous.retryAttempt,
    fetchImpl: input.fetchImpl,
  });

  const terminalFailure = classifyTerminalFailure(cycle);
  const advanced =
    cycle.status === "ok" &&
    (cycle.state.cursor !== previous.cursor ||
      cycle.state.overlapBoundary !== previous.overlapBoundary ||
      cycle.state.intraPageContinuation !== previous.intraPageContinuation);
  const nextRetryAttempt = computeNextRetryAttempt({
    status: cycle.status,
    previous: previous.retryAttempt,
    exhausted: cycle.exhausted,
  });
  const nextEligiblePollTime = computeNextEligiblePollTime({
    status: cycle.status,
    intervalMs: input.config.intervalMs,
    retryAfterMs: cycle.retryAfterMs,
    backoffBaseMs: input.config.backoffBaseMs,
    backoffMaxMs: input.config.backoffMaxMs,
    retryAttempt: previous.retryAttempt,
    now,
    terminalFailure,
  });

  const nextState: LinearIntakePollingState = {
    cursor: cycle.state.cursor,
    overlapBoundary: cycle.state.overlapBoundary,
    intraPageContinuation: cycle.state.intraPageContinuation ?? null,
    retryAttempt: nextRetryAttempt,
    nextEligiblePollTime,
    lastStatus: cycle.status,
    lastError: cycle.error ?? null,
    terminalFailure,
    lastCycleAt: new Date(now).toISOString(),
    resolvedProjectId: previous.resolvedProjectId,
    resolvedProjectUrl: previous.resolvedProjectUrl,
    cyclesCompleted: previous.cyclesCompleted + 1,
    issuesIngested: previous.issuesIngested + cycle.issuesIngested,
    issuesDeduplicated: previous.issuesDeduplicated + cycle.issuesDeduplicated,
    issuesRejected: previous.issuesRejected + cycle.issuesRejected,
    issuesMalformed: previous.issuesMalformed + cycle.issuesMalformed,
  };
  setLinearIntakeState(input.harness, input.rootRunId, nextState);
  return {
    reason: "polled",
    status: cycle.status,
    state: nextState,
    cycle,
    advanced,
  };
}

function classifyTerminalFailure(cycle: LinearPollingCycleResult): string | null {
  if (cycle.status === "auth_failure") {
    return cycle.error ?? "Linear authentication failed";
  }
  if (cycle.status === "scope_error") {
    return cycle.error ?? "Linear scope error";
  }
  if (cycle.status === "config_error") {
    return cycle.error ?? "Linear configuration error";
  }
  if (
    (cycle.status === "rate_limited" ||
      cycle.status === "transient_failure" ||
      cycle.status === "ingestion_failure") &&
    cycle.exhausted
  ) {
    return cycle.error ?? `Linear polling exhausted retries (${cycle.status})`;
  }
  return null;
}

function computeNextRetryAttempt(input: {
  status: LinearPollingStatus;
  previous: number;
  exhausted: boolean;
}): number {
  if (input.status === "ok") {
    return 0;
  }
  if (input.exhausted) {
    return input.previous;
  }
  return input.previous + 1;
}

function computeNextEligiblePollTime(input: {
  status: LinearPollingStatus;
  intervalMs: number;
  retryAfterMs: number | null;
  backoffBaseMs: number;
  backoffMaxMs: number;
  retryAttempt: number;
  now: number;
  terminalFailure: string | null;
}): string | null {
  if (input.terminalFailure) {
    return null;
  }
  if (input.status === "ok") {
    return new Date(input.now + Math.max(1, input.intervalMs)).toISOString();
  }
  if (input.status === "rate_limited" && input.retryAfterMs !== null && input.retryAfterMs > 0) {
    return new Date(input.now + Math.min(input.retryAfterMs, input.backoffMaxMs)).toISOString();
  }
  const exponent = Math.min(Math.max(0, input.retryAttempt), 16);
  const backoff = Math.min(
    Math.max(1, input.backoffBaseMs) * 2 ** exponent,
    Math.max(1, input.backoffMaxMs),
  );
  return new Date(input.now + Math.max(1, Math.floor(backoff))).toISOString();
}

export function getLinearIntakeState(harness: Harness, rootRunId: string): LinearIntakePollingState {
  const run = harness.getRun(rootRunId);
  if (!run) {
    return { ...INITIAL_LINEAR_INTAKE_POLLING_STATE };
  }
  const container = recordValue(run.context[LINEAR_INTAKE_CONTEXT_KEY]);
  const stored = recordValue(container[LINEAR_INTAKE_POLLING_KEY]);
  if (!stored) {
    return { ...INITIAL_LINEAR_INTAKE_POLLING_STATE };
  }
  return normalizePollingState(stored);
}

export function setLinearIntakeState(
  harness: Harness,
  rootRunId: string,
  state: LinearIntakePollingState,
): void {
  const run = harness.getRun(rootRunId);
  if (!run) {
    return;
  }
  const existingContainer = recordValue(run.context[LINEAR_INTAKE_CONTEXT_KEY]);
  harness.updateRun({
    runId: rootRunId,
    contextPatch: {
      [LINEAR_INTAKE_CONTEXT_KEY]: {
        ...existingContainer,
        [LINEAR_INTAKE_POLLING_KEY]: state,
      },
    },
  });
}

function normalizePollingState(value: Record<string, unknown>): LinearIntakePollingState {
  return {
    cursor: typeof value.cursor === "string" ? value.cursor : null,
    overlapBoundary: typeof value.overlapBoundary === "string" ? value.overlapBoundary : null,
    intraPageContinuation: readContinuation(value.intraPageContinuation),
    retryAttempt:
      typeof value.retryAttempt === "number" && Number.isFinite(value.retryAttempt)
        ? Math.max(0, Math.floor(value.retryAttempt))
        : 0,
    nextEligiblePollTime:
      typeof value.nextEligiblePollTime === "string" ? value.nextEligiblePollTime : null,
    lastStatus:
      typeof value.lastStatus === "string"
        ? (value.lastStatus as LinearPollingStatus | "idle")
        : "idle",
    lastError: typeof value.lastError === "string" ? value.lastError : null,
    terminalFailure: typeof value.terminalFailure === "string" ? value.terminalFailure : null,
    lastCycleAt: typeof value.lastCycleAt === "string" ? value.lastCycleAt : null,
    resolvedProjectId: typeof value.resolvedProjectId === "string" ? value.resolvedProjectId : null,
    resolvedProjectUrl:
      typeof value.resolvedProjectUrl === "string" ? value.resolvedProjectUrl : null,
    cyclesCompleted:
      typeof value.cyclesCompleted === "number" && Number.isFinite(value.cyclesCompleted)
        ? Math.max(0, Math.floor(value.cyclesCompleted))
        : 0,
    issuesIngested:
      typeof value.issuesIngested === "number" && Number.isFinite(value.issuesIngested)
        ? Math.max(0, Math.floor(value.issuesIngested))
        : 0,
    issuesDeduplicated:
      typeof value.issuesDeduplicated === "number" && Number.isFinite(value.issuesDeduplicated)
        ? Math.max(0, Math.floor(value.issuesDeduplicated))
        : 0,
    issuesRejected:
      typeof value.issuesRejected === "number" && Number.isFinite(value.issuesRejected)
        ? Math.max(0, Math.floor(value.issuesRejected))
        : 0,
    issuesMalformed:
      typeof value.issuesMalformed === "number" && Number.isFinite(value.issuesMalformed)
        ? Math.max(0, Math.floor(value.issuesMalformed))
        : 0,
  };
}

function readContinuation(value: unknown): { createdAt: string; issueId: string } | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const rec = value as Record<string, unknown>;
  const createdAt = typeof rec.createdAt === "string" ? rec.createdAt : null;
  const issueId = typeof rec.issueId === "string" ? rec.issueId : null;
  if (!createdAt || !issueId) {
    return null;
  }
  return { createdAt, issueId };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------------------
// Issue-scoped Designer consumption
// ---------------------------------------------------------------------------
//
// Each durable Linear `issue.created` inbox event must be claimed (todo →
// running) and deterministically mapped to one issue-scoped Designer run and
// task. The mapping is restart-safe and replay-safe: the issue's immutable
// Linear ID derives a stable run ID and task ID scoped to the supervised root
// run. Repeated consumption attempts for the same event reuse the existing run
// and task instead of duplicating them, and the inbox lifecycle transitions
// are bounded by compare-and-set so concurrent ticks cannot double-claim.

const LINEAR_ISSUE_EVENT_TYPE = "issue.created";

export interface LinearIntakeIssuePayload {
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  projectId?: string | null;
  teamId?: string | null;
  teamKey?: string | null;
}

export interface ConsumeInboxInput {
  harness: Harness;
  rootRunId: string;
  /** Maximum number of todo events to process in one call. Defaults to 25. */
  batchSize?: number;
}

export type ConsumeInboxOutcomeKind =
  | "claimed"
  | "skipped"
  | "deduplicated"
  | "blocked";

export interface ConsumeInboxEventOutcome {
  eventId: string;
  externalId: string;
  kind: ConsumeInboxOutcomeKind;
  runId: string;
  taskId: string;
  runCreated: boolean;
  taskCreated: boolean;
  error?: string;
}

export interface ConsumeInboxResult {
  processed: number;
  claimed: number;
  deduplicated: number;
  skipped: number;
  blocked: number;
  outcomes: ConsumeInboxEventOutcome[];
}

/**
 * Claim every durable todo Linear `issue.created` inbox event into one
 * issue-scoped Designer cycle. Each event is claimed with a compare-and-set
 * todo → running transition; the claimed event then creates or reuses exactly
 * one Designer run and task keyed by (root run, immutable Linear issue id) and
 * leaves the event in `running`. The running → done transition is owned by
 * the fixed design action path: `createRunsFromDesign` finalizes the
 * lifecycle atomically after the planning run, planner task, and external
 * reference are durable; non-delivery terminal outcomes (quiescent,
 * rejected, or signal-only Designer cycles) are finalized by the design
 * action hook so the intake cannot stay pending forever. Permanent creation
 * failures (run/task cannot be persisted) flip the event to blocked so the
 * failure becomes visible without changing schema or dependencies.
 *
 * Restart safety: events stuck in `running` after a crash between claim and
 * the eventual fixed-action finalization are also processed. The durable
 * state already reflects ownership; the same idempotent create/reuse run/task
 * path preserves the deterministic mapping regardless of which caller
 * claimed first.
 */
export function consumeLinearInbox(input: ConsumeInboxInput): ConsumeInboxResult {
  const batchSize = Math.max(0, Math.min(input.batchSize ?? 25, 200));
  const outcomes: ConsumeInboxEventOutcome[] = [];
  let claimed = 0;
  let deduplicated = 0;
  let skipped = 0;
  let blocked = 0;

  if (batchSize <= 0) {
    return { processed: 0, claimed, deduplicated, skipped, blocked, outcomes };
  }

  // Process fresh todo events first, then resume any running events left
  // behind by a crash between claim and complete. The same idempotent
  // create/reuse logic handles both: stable run/task IDs prevent duplicates.
  const todoEvents = input.harness.listInboxEvents({
    provider: "linear",
    status: "todo",
    limit: batchSize,
  });
  const runningEvents =
    batchSize > todoEvents.length
      ? input.harness.listInboxEvents({
          provider: "linear",
          status: "running",
          limit: batchSize - todoEvents.length,
        })
      : [];

  for (const event of [...todoEvents, ...runningEvents]) {
    if (event.eventType !== LINEAR_ISSUE_EVENT_TYPE) {
      skipped += 1;
      outcomes.push({
        eventId: event.id,
        externalId: event.externalId,
        kind: "skipped",
        runId: "",
        taskId: "",
        runCreated: false,
        taskCreated: false,
      });
      continue;
    }
    const outcome = claimAndPlan(input.harness, input.rootRunId, event);
    outcomes.push(outcome);
    if (outcome.kind === "claimed") {
      claimed += 1;
    } else if (outcome.kind === "deduplicated") {
      deduplicated += 1;
    } else if (outcome.kind === "blocked") {
      blocked += 1;
    } else if (outcome.kind === "skipped") {
      skipped += 1;
    }
  }

  return {
    processed: outcomes.length,
    claimed,
    deduplicated,
    skipped,
    blocked,
    outcomes,
  };
}

function claimAndPlan(
  harness: Harness,
  rootRunId: string,
  event: InboxEvent,
): ConsumeInboxEventOutcome {
  const rootRun = harness.getRun(rootRunId);
  if (!rootRun) {
    return blockedOutcome(event, "supervised root run not found", "", "");
  }

  // Compare-and-set claim from todo. A `running` event (left behind by a
  // crash between claim and complete) skips this transition and resumes from
  // the durable state. CAS failure (concurrent caller raced and won the
  // claim) returns skipped so the durable run/task is reused without
  // duplicating; the immutable Linear issue ID derives the same stable IDs
  // regardless of which caller claimed first.
  if (event.status === "todo") {
    let claim;
    try {
      claim = harness.transitionInboxEvent({
        id: event.id,
        from: "todo",
        to: "running",
      });
    } catch (error) {
      const message = (error as Error).message;
      const stable = stableIssueScopedIds(rootRunId, event.externalId);
      if (/found running/.test(message)) {
        return {
          eventId: event.id,
          externalId: event.externalId,
          kind: "skipped",
          runId: stable.runId,
          taskId: stable.taskId,
          runCreated: false,
          taskCreated: false,
        };
      }
      return blockedOutcome(event, message, stable.runId, stable.taskId);
    }
    if (!claim.updated) {
      const stable = stableIssueScopedIds(rootRunId, event.externalId);
      return {
        eventId: event.id,
        externalId: event.externalId,
        kind: "skipped",
        runId: stable.runId,
        taskId: stable.taskId,
        runCreated: false,
        taskCreated: false,
      };
    }
  }

  // Now that the event is durably claimed (running), validate the payload. A
  // malformed payload cannot drive a Designer cycle and becomes a visible
  // blocked intake row so the dashboard surfaces the failure.
  const issue = readIssuePayload(event);
  if (!issue) {
    return finalizeBlocked(event, harness, "Linear inbox event payload could not be normalized", "", "");
  }
  if (!issue.identifier && !issue.title) {
    return finalizeBlocked(
      event,
      harness,
      "Linear inbox event payload is missing issue identifier and title",
      "",
      "",
    );
  }

  const stable = stableIssueScopedIds(rootRunId, event.externalId);
  const summary = summarizeIssue(issue);
  const designerGoal = `Decide what Ouroboros should do about Linear issue ${issue.identifier ?? event.externalId}: ${summary}`;

  let runCreated = false;
  let taskCreated = false;
  try {
    const existingRun = harness.getRun(stable.runId);
    if (!existingRun) {
      harness.createRun({
        id: stable.runId,
        goal: designerGoal,
        context: buildIssueScopedRunContext({
          rootRun,
          event,
          issue,
          runId: stable.runId,
        }),
      });
      runCreated = true;
    } else if (!isSameIssueScopedRun(existingRun.context, event, rootRunId)) {
      // Defensive: the deterministic run ID collided with a non-intake run.
      // Surface as blocked rather than mutating unrelated state.
      return finalizeBlocked(
        event,
        harness,
        "deterministic run id collision with non-intake run",
        stable.runId,
        stable.taskId,
      );
    }

    const existingTask = harness.getTask(stable.taskId);
    if (!existingTask) {
      harness.createTask({
        id: stable.taskId,
        runId: stable.runId,
        role: "designer",
        goal: designerGoal,
        prompt: buildIssueScopedDesignerPrompt(issue, event),
        doneWhen: LINEAR_ISSUE_DESIGNER_DONE_WHEN,
      });
      taskCreated = true;
    } else if (existingTask.runId !== stable.runId) {
      return finalizeBlocked(
        event,
        harness,
        "deterministic task id collision with non-intake task",
        stable.runId,
        stable.taskId,
      );
    }
  } catch (error) {
    const message = (error as Error).message;
    return finalizeBlocked(event, harness, message, stable.runId, stable.taskId);
  }

  // The Designer run/task are durable and the inbox event is in `running`.
  // Finalization (running → done) is deferred to the fixed design action path
  // so the transition is atomic with the planning run, planner task, and
  // external reference. Re-processing this running event on a later tick is
  // safe: the same deterministic run/task IDs are reused, the inbox stays
  // running, and the eventual createRunsFromDesign (or a bounded terminal
  // decision) finalizes the lifecycle exactly once.
  return {
    eventId: event.id,
    externalId: event.externalId,
    kind: runCreated ? "claimed" : "deduplicated",
    runId: stable.runId,
    taskId: stable.taskId,
    runCreated,
    taskCreated,
  };
}

function finalizeBlocked(
  event: InboxEvent,
  harness: Harness,
  message: string,
  runId: string,
  taskId: string,
): ConsumeInboxEventOutcome {
  try {
    harness.transitionInboxEvent({ id: event.id, from: "running", to: "blocked" });
  } catch {
    // ignore — preserve the original creation error in the outcome
  }
  return blockedOutcome(event, message, runId, taskId);
}

function blockedOutcome(
  event: InboxEvent,
  error: string,
  runId: string,
  taskId: string,
): ConsumeInboxEventOutcome {
  return {
    eventId: event.id,
    externalId: event.externalId,
    kind: "blocked",
    runId,
    taskId,
    runCreated: false,
    taskCreated: false,
    error,
  };
}

function stableIssueScopedIds(rootRunId: string, externalIssueId: string): { runId: string; taskId: string } {
  const material = `${rootRunId}|${externalIssueId}`;
  const digest = createHash("sha256").update(material, "utf8").digest("hex");
  return {
    runId: `run_linear_${digest}`,
    taskId: `task_linear_${digest}`,
  };
}

function readIssuePayload(event: InboxEvent): LinearIntakeIssuePayload | null {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return null;
  }
  const rec = event.payload as Record<string, unknown>;
  return {
    identifier: typeof rec.identifier === "string" ? rec.identifier : null,
    title: typeof rec.title === "string" ? rec.title : null,
    description: typeof rec.description === "string" ? rec.description : null,
    url: typeof rec.url === "string" ? rec.url : null,
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : null,
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : null,
    projectId: typeof rec.projectId === "string" ? rec.projectId : null,
    teamId: typeof rec.teamId === "string" ? rec.teamId : null,
    teamKey: typeof rec.teamKey === "string" ? rec.teamKey : null,
  };
}

function summarizeIssue(issue: LinearIntakeIssuePayload): string {
  const title = (issue.title ?? "").trim();
  if (title) {
    return title;
  }
  const identifier = (issue.identifier ?? "").trim();
  return identifier || "Linear issue";
}

function isSameIssueScopedRun(
  context: Record<string, unknown>,
  event: InboxEvent,
  rootRunId: string,
): boolean {
  const linearIntake = recordValue(context.linearIntake);
  if (linearIntake.inboxEventId !== event.id) {
    return false;
  }
  if (linearIntake.linearIssueId !== event.externalId) {
    return false;
  }
  return linearIntake.rootRunId === rootRunId;
}

function buildIssueScopedRunContext(input: {
  rootRun: ReturnType<Harness["getRun"]>;
  event: InboxEvent;
  issue: LinearIntakeIssuePayload;
  runId: string;
}): Record<string, unknown> {
  const root = input.rootRun!;
  const inherited = selfImprovementControlContext(root.context);
  const founderCharterId =
    typeof root.context.founderCharterId === "string" ? root.context.founderCharterId : null;
  const designCharterId =
    typeof root.context.designCharterId === "string" ? root.context.designCharterId : founderCharterId;
  return {
    ...inherited,
    parentRunId: root.id,
    source: "linear-intake",
    planDoc: root.context.planDoc ?? null,
    designDoc: root.context.designDoc ?? null,
    goalContract: root.context.goalContract ?? null,
    founderCharterId,
    designCharterId,
    linearIntake: {
      rootRunId: root.id,
      inboxEventId: input.event.id,
      linearIssueId: input.event.externalId,
      issueIdentifier: input.issue.identifier ?? null,
      issueUrl: input.issue.url ?? null,
      issueTitle: input.issue.title ?? null,
      issueCreatedAt: input.issue.createdAt ?? null,
      issueTeamKey: input.issue.teamKey ?? null,
      issueTeamId: input.issue.teamId ?? null,
      issueProjectId: input.issue.projectId ?? null,
    },
  };
}

function selfImprovementControlContext(context: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    [
      "modelDefaults",
      "agentDefaults",
      "agentBackends",
      "guardrails",
      "integrationBoundary",
    ]
      .filter((key) => context[key] !== undefined)
      .map((key) => [key, context[key]]),
  );
}

function buildIssueScopedDesignerPrompt(issue: LinearIntakeIssuePayload, event: InboxEvent): string {
  const identifier = issue.identifier ?? event.externalId;
  return [
    "Act as Ouroboros' Designer for one Linear intake issue. Decide whether to record a strategy signal, propose a bounded design, defer, or stay quiescent for this issue. Do not invent a new product direction from issue prose: every durable conclusion must return through one of the fixed designer actions.",
    "",
    "Linear issue provenance:",
    `- immutable issue id: ${event.externalId}`,
    `- identifier: ${identifier}`,
    `- title: ${issue.title ?? "(none)"}`,
    `- url: ${issue.url ?? "(none)"}`,
    `- createdAt: ${issue.createdAt ?? "(unknown)"}`,
    `- team: ${issue.teamKey ?? "(unknown)"}`,
    "",
    "Issue description:",
    "```text",
    (issue.description ?? "(no description)").trim(),
    "```",
    "",
    "Inspect the active founder charter, current strategy signals, recent run evidence, attempts, lessons, repository state, and due design outcomes before deciding. The Linear intake event is already durably claimed; do not mutate inbox state directly through prose.",
    "",
    "Return one of the following outcomes through the `actions` array:",
    "- `recordSignal` if this issue is evidence of a strategy gap or behavior gap worth tracking",
    "- `proposeDesign` if a bounded, evidence-backed design proposal can be derived from this issue (frozen evaluation contract, options, recommendation, additions, removals, investment envelope)",
    "- `decideDesign` only with `auto` actor kind for `rejected`, `deferred`, or `revise` when a recorded proposal already covers this issue",
    "- no actions when the issue is out of scope, already covered by an active proposal, or too ambiguous for evidence-backed work this cycle",
    "",
    "Planning begins only from an accepted proposal. Never create a delivery run for an unaccepted proposal, and never bypass the authority gate by adding `nextRuns` for a design conclusion.",
  ].join("\n");
}

const LINEAR_ISSUE_DESIGNER_DONE_WHEN = [
  "The assessment cites the Linear issue provenance, active charter, current signals, recent run evidence, repository state, and due design outcomes",
  "The output derives one evidence-backed design proposal or records a justified quiescent or signal-only decision for this issue",
  "Durable conclusions return only through the fixed designer actions: recordSignal, proposeDesign, decideDesign, recordDesignOutcome, createRunsFromDesign",
  "Planning begins only from an accepted proposal and preserves the frozen evaluation contract, authority context, budget, and integration boundary",
  "No delivery run is created from an unaccepted proposal or without an approved stored decision",
];
