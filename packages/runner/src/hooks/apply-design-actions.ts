import {
  type AttemptOutput,
  evaluateAuthority,
  type AuthorityCharterContext,
  type AuthorityEvidenceReference,
  type AuthorityEvaluation,
  type AuthorityPortfolioUsage,
  type AuthorityProposalRiskSurface,
  type DesignActionInput,
  type DesignProposal,
  type FounderCharter,
  type Harness,
  type HarnessDatabase,
  type Run,
  type StrategySignal,
  type Task,
} from "@ouroboros/harness";
import { optionalStrictIsoTimestamp } from "@ouroboros/harness";
import { createHash } from "node:crypto";
import type { StopHook, StopHookResult } from "../types";

export interface ApplyDesignActionsHookOptions {
  harness: Harness;
}

export interface AppliedDesignAction {
  kind:
    | "design_signal"
    | "design_proposal"
    | "design_decision"
    | "design_outcome"
    | "design_continuation"
    | "design_authority_checkpoint"
    | "design_intake_finalized";
  signalId?: string;
  proposalId?: string;
  decisionId?: string;
  outcomeId?: string;
  taskId?: string;
  checkpointDecisionId?: string;
  disposition?: string;
  intakeEventId?: string;
  externalRefId?: string;
}

const NOW_EPOCH = () => Date.now();

// High-risk flag fields derived conservatively by the production adapter.
// Each flag is forced to `true` when (a) the designer declares it `true`, (b)
// the designer declares a non-boolean value (fail-closed on malformed data),
// OR (c) the proposal/evidence text matches a domain-specific risk keyword.
// Missing declarations default to `false` because the production Designer
// prompt does not require an explicit `riskSurface` field; the keyword matcher
// remains the durable safety net that catches the same risk vocabulary the
// prompt forbids the cycle from crossing without a human checkpoint.
const RISK_FLAG_FIELDS = [
  "amendsMission",
  "amendsCapitalPolicy",
  "legalOrPrivacy",
  "sensitiveData",
  "destructiveOperation",
  "productionDeployment",
  "unplannedDependency",
  "schemaMigration",
  "recurringInfrastructure",
] as const;

type RiskFlagField = (typeof RISK_FLAG_FIELDS)[number];

const RISK_KEYWORDS: Record<RiskFlagField, RegExp[]> = {
  amendsMission: [/mission statement|charter amendment|amend mission/i],
  amendsCapitalPolicy: [/capital policy|recurring spend|budget amendment/i],
  legalOrPrivacy: [/legal|privacy|gdpr|\bpii\b|personally identifiable/i],
  sensitiveData: [/sensitive data|credentials|secrets|api keys|private keys/i],
  destructiveOperation: [/destructive|drop table|delete from|truncate/i],
  productionDeployment: [/production deployment|production deploy|deploy to prod/i],
  unplannedDependency: [/unplanned dependency|new dependency|add dependency/i],
  schemaMigration: [/schema migration|database migration|ddl change/i],
  recurringInfrastructure: [/recurring infrastructure|managed service|recurring spend on infrastructure/i],
};

export function createApplyDesignActionsHook(options: ApplyDesignActionsHookOptions): StopHook {
  return ({ run, task, output }: { run: Run; task: Task; output: AttemptOutput }): StopHookResult => {
    if (output.status !== "done") {
      return { decision: "exit" };
    }
    const actions = output.designActions ?? [];
    if (actions.length === 0) {
      // No-action Designer result: stay mutation-free and quiescent for
      // non-intake runs. For an issue-scoped Linear intake run, a quiescent
      // outcome is a bounded terminal decision — the Designer considered the
      // issue and chose not to propose or record a signal this cycle. The
      // matching inbox event is finalized running → done so the intake cannot
      // stay pending forever. The transition is fail-safe: an already-done
      // event (replay) or a missing intake block (non-intake run) is a no-op.
      finalizeQuiescentLinearIntake(options.harness, { run, task });
      return { decision: "exit" };
    }

    const artifacts: unknown[] = [];
    const problems: string[] = [];
    const checks: unknown[] = [];
    const createdRuns: Array<{ runId: string; plannerTaskId: string; proposalId: string }> = [];
    let nextDecision: StopHookResult["decision"] = "exit";

    actions.forEach((action, actionIndex) => {
      try {
        const result = applyActionAtomically(options.harness, action, {
          run,
          task,
          now: NOW_EPOCH(),
          actionIndex,
        });
        for (const artifact of result.artifacts) {
          artifacts.push(artifact);
        }
        for (const check of result.checks) {
          checks.push(check);
        }
        if (result.createdRuns.length > 0) {
          for (const created of result.createdRuns) {
            createdRuns.push(created);
          }
          nextDecision = "continue";
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        problems.push(message);
        checks.push({
          name: `design action ${action.type}`,
          status: "failed",
          evidence: message,
        });
        // The blocked audit event is recorded in its own transaction. If THIS
        // write also fails, the hook surfaces the audit failure as a second
        // problem rather than swallowing it. A successful mutation cannot be
        // missing from the audit log: any mutation that survived is already
        // paired with a `done` audit row written in the same transaction, and
        // a mutation that failed never reached the database.
        try {
          recordBlockedActionEventWithOwnTransaction(options.harness, action, {
            run,
            task,
            actionIndex,
            error: message,
          });
        } catch (auditError) {
          const auditMessage = auditError instanceof Error ? auditError.message : String(auditError);
          problems.push(`design action ${action.type} audit failure: ${auditMessage}`);
          checks.push({
            name: `design action ${action.type} audit`,
            status: "failed",
            evidence: auditMessage,
          });
        }
      }
    });

    if (problems.length > 0) {
      return {
        decision: "exit",
        problems,
        checks,
        artifacts,
      };
    }

    return {
      decision: nextDecision,
      artifacts: [...artifacts, ...createdRuns.map((created) => ({ kind: "created_run" as const, ...created }))],
      checks,
    };
  };
}

interface ApplyActionResult {
  artifacts: AppliedDesignAction[];
  checks: unknown[];
  createdRuns: Array<{ runId: string; plannerTaskId: string; proposalId: string }>;
  eventResult: Record<string, unknown>;
}

interface ActionContext {
  run: Run;
  task: Task;
  now: number;
  actionIndex: number;
}

// Each design action — together with its generated transitions and successful
// audit event — is committed inside a single transaction. A failure on either
// side rolls back the entire action, so a successful audit-write can never
// diverge from a durable mutation. Replay safety is enforced by computing a
// stable audit-row identity from (actionType, runId, taskId, actionIndex,
// durable entity identity). If a prior `done` row already exists for the same
// identity, the action is replayed from the stored result and no duplicate
// signal, proposal, decision, continuation, or child run is created.
function applyActionAtomically(
  harness: Harness,
  action: DesignActionInput,
  context: ActionContext,
): ApplyActionResult {
  return harness.runInTransaction((db) => {
    const auditId = stableActionAuditId(context.run.id, context.task.id, context.actionIndex, action);
    const priorEvent = harness.getHarnessActionEventWithDb(db, { id: auditId });
    if (priorEvent && priorEvent.status === "done") {
      return reconstructActionResultFromAudit(action, priorEvent.result);
    }

    const result = applyActionWithDb(harness, db, action, context);
    harness.recordHarnessActionEventWithDb(db, {
      id: auditId,
      actionType: `design.${action.type}`,
      status: "done",
      request: {
        type: action.type,
        payload: action.payload,
        runId: context.run.id,
        taskId: context.task.id,
        actionIndex: context.actionIndex,
      },
      result: result.eventResult,
    });
    return result;
  });
}

function applyActionWithDb(
  harness: Harness,
  db: HarnessDatabase,
  action: DesignActionInput,
  context: ActionContext,
): ApplyActionResult {
  if (action.type === "recordSignal") {
    return applyRecordSignalWithDb(harness, db, action, context);
  }
  if (action.type === "proposeDesign") {
    return applyProposeDesignWithDb(harness, db, action, context);
  }
  if (action.type === "decideDesign") {
    return applyDecideDesignWithDb(harness, db, action, context);
  }
  if (action.type === "recordDesignOutcome") {
    return applyRecordDesignOutcomeWithDb(harness, db, action, context);
  }
  if (action.type === "createRunsFromDesign") {
    return applyCreateRunsFromDesignWithDb(harness, db, action, context);
  }
  throw new Error(
    `unknown design action type ${(action as { type?: string }).type ?? "<missing>"}`,
  );
}

function applyRecordSignalWithDb(
  harness: Harness,
  db: HarnessDatabase,
  action: Extract<DesignActionInput, { type: "recordSignal" }>,
  context: ActionContext,
): ApplyActionResult {
  const payload = action.payload;
  const projectId = requiredProjectId(payload.projectId);
  const expiresAt = optionalIsoTimestamp(payload.expiresAt, "recordSignal payload.expiresAt");
  if (expiresAt !== null && expiresAt !== undefined) {
    if (Date.parse(expiresAt) < context.now) {
      throw new Error("recordSignal payload.expiresAt must be a future timestamp");
    }
  }
  const signal = harness.createStrategySignalWithDb(db, {
    projectId,
    signalClass: requiredString(payload.signalClass, "recordSignal payload.signalClass") as
      | "user"
      | "delivery"
      | "technology"
      | "market"
      | "economics"
      | "system",
    source: requiredString(payload.source, "recordSignal payload.source"),
    title: requiredString(payload.title, "recordSignal payload.title"),
    summary: requiredString(payload.summary, "recordSignal payload.summary"),
    observationTime: requiredString(payload.observationTime, "recordSignal payload.observationTime"),
    confidence: requiredFiniteNumber(payload.confidence, "recordSignal payload.confidence"),
    evidence: optionalArray(payload.evidence, "recordSignal payload.evidence") ?? [],
    expiresAt,
    conflictingSignalIds: optionalStringArray(payload.conflictingSignalIds, "recordSignal payload.conflictingSignalIds") ?? [],
    proposalId: optionalString(payload.proposalId, "recordSignal payload.proposalId") ?? null,
    runId: context.run.id,
    taskId: context.task.id,
    attemptId: null,
    payload: optionalRecord(payload.payload, "recordSignal payload.payload") ?? {},
  });

  // Bounded transition: emit at most one Designer continuation carrying the
  // durable generated signal ID. The continuation permits the next bounded
  // choice — propose a design anchored to this signal, or stop with a
  // justified no-action result — but cannot mutate strategy state directly.
  // The continuation task identity is derived from (runId, taskId,
  // actionIndex, signalId), so a replay reuses the existing task instead of
  // spawning a duplicate designer cycle.
  const continuationTaskId = ensureDesignerContinuationTaskWithDb(
    harness,
    db,
    {
      runId: context.run.id,
      sourceTaskId: context.task.id,
      actionIndex: context.actionIndex,
      kind: "after-recordSignal",
      entityId: signal.id,
      role: "designer",
      goal: `Designer continuation: drain signal ${signal.id}`,
      prompt: buildSignalContinuationPrompt(signal),
      doneWhen: [
        "Designer either emits one proposeDesign anchored to the recorded signal, or returns a no-action result with justification",
        "Designer does not re-record the signal",
        "Designer does not amend strategy state directly",
      ],
      config: {
        designContinuation: {
          kind: "after-recordSignal",
          signalId: signal.id,
          sourceTaskId: context.task.id,
          actionIndex: context.actionIndex,
        },
      },
      dependsOn: [context.task.id],
    },
  );

  return {
    artifacts: [
      { kind: "design_signal", signalId: signal.id },
      { kind: "design_continuation", taskId: continuationTaskId, signalId: signal.id },
    ],
    checks: [
      { name: "design signal recorded", status: "passed", evidence: signal.id },
      { name: "design continuation created", status: "passed", evidence: continuationTaskId },
    ],
    createdRuns: [],
    eventResult: { signalId: signal.id, continuationTaskId },
  };
}

function applyProposeDesignWithDb(
  harness: Harness,
  db: HarnessDatabase,
  action: Extract<DesignActionInput, { type: "proposeDesign" }>,
  context: ActionContext,
): ApplyActionResult {
  const payload = action.payload;
  const projectId = requiredProjectId(payload.projectId);
  const title = requiredString(payload.title, "proposeDesign payload.title");
  const proposalData = payload.proposal as Record<string, unknown> | undefined;
  if (!proposalData) {
    throw new Error("proposeDesign payload.proposal must be present");
  }
  const problem = requiredString(proposalData.problem, "proposeDesign payload.proposal.problem");
  const recommendation = requiredString(proposalData.recommendation, "proposeDesign payload.proposal.recommendation");
  const evidenceRefs = optionalStringArray(proposalData.evidenceRefs, "proposeDesign payload.proposal.evidenceRefs");
  if (!evidenceRefs || evidenceRefs.length === 0) {
    throw new Error("proposeDesign payload.proposal.evidenceRefs must reference at least one signal or observation");
  }
  const contract = proposalData.evaluationContract as Record<string, unknown> | undefined;
  if (!contract) {
    throw new Error("proposeDesign payload.proposal.evaluationContract must be present");
  }
  requireContractEvidence(contract);
  const investment = proposalData.investment as Record<string, unknown> | undefined;
  if (!investment) {
    throw new Error("proposeDesign payload.proposal.investment must be present");
  }
  validateInvestment(investment);

  const status = optionalString(payload.status, "proposeDesign payload.status") as
    | "draft"
    | "proposed"
    | "experimenting"
    | undefined;
  if (status !== undefined && status !== "draft" && status !== "proposed" && status !== "experimenting") {
    throw new Error("proposeDesign payload.status must be draft, proposed, or experimenting");
  }

  const proposal = harness.createDesignProposalWithDb(db, {
    projectId,
    title,
    problem,
    recommendation,
    proposal: proposalData as never,
    charterId: optionalString(payload.charterId, "proposeDesign payload.charterId") ?? null,
    runId: context.run.id,
    taskId: context.task.id,
    attemptId: null,
    status: status ?? "proposed",
  });

  // Production transition: pin the active charter for the proposal project,
  // resolve every evidence reference from durable signals, derive a
  // conservative risk surface, compute current portfolio usage, and run the
  // existing authority evaluator. The evaluation is the only path that may
  // produce an `approved` auto decision; the designer-output decideDesign
  // action remains forbidden from approving.
  const transition = runAuthorityTransitionWithDb(harness, db, proposal, context);

  return {
    artifacts: [
      { kind: "design_proposal", proposalId: proposal.id },
      ...transition.artifacts,
    ],
    checks: [
      { name: "design proposal recorded", status: "passed", evidence: proposal.id },
      { name: "design proposal status", status: "passed", evidence: transition.resultingStatus },
      { name: "design authority evaluation", status: "passed", evidence: transition.evaluationSummary },
      ...transition.checks,
    ],
    createdRuns: [],
    eventResult: {
      proposalId: proposal.id,
      status: transition.resultingStatus,
      authorityDisposition: transition.evaluation.disposition,
      authorityDecisionId: transition.authorityDecisionId ?? null,
      continuationTaskId: transition.continuationTaskId ?? null,
      checkpointDecisionId: transition.checkpointDecisionId ?? null,
    },
  };
}

interface AuthorityTransitionResult {
  evaluation: AuthorityEvaluation;
  evaluationSummary: string;
  resultingStatus: DesignProposal["status"];
  authorityDecisionId: string | null;
  checkpointDecisionId: string | null;
  continuationTaskId: string | null;
  artifacts: AppliedDesignAction[];
  checks: unknown[];
}

export interface ReconcileDeferredDesignAuthorityInput {
  harness: Harness;
  projectId?: string;
  now?: number;
}

export interface ReconcileDeferredDesignAuthorityResult {
  inspected: number;
  approved: number;
  rejected: number;
  deferredForCost: number;
  skipped: number;
  proposalIds: string[];
}

export function reconcileDeferredDesignAuthority(
  input: ReconcileDeferredDesignAuthorityInput,
): ReconcileDeferredDesignAuthorityResult {
  const proposals = input.harness.listDesignProposals({
    projectId: input.projectId,
    statuses: ["proposed"],
    limit: 200,
  });
  const result: ReconcileDeferredDesignAuthorityResult = {
    inspected: 0,
    approved: 0,
    rejected: 0,
    deferredForCost: 0,
    skipped: 0,
    proposalIds: [],
  };

  for (const proposal of proposals) {
    const decisions = input.harness.listDesignDecisions({ proposalId: proposal.id, limit: 200 });
    const latest = decisions.at(-1);
    if (latest?.decision !== "deferred" || latest.authority?.disposition !== "human-required") {
      result.skipped += 1;
      continue;
    }
    const run = proposal.runId ? input.harness.getRun(proposal.runId) : null;
    const task = proposal.taskId ? input.harness.getTask(proposal.taskId) : null;
    if (!run || !task) {
      result.skipped += 1;
      continue;
    }
    const rawActionIndex = latest.payload?.actionIndex;
    const actionIndex = typeof rawActionIndex === "number" && Number.isInteger(rawActionIndex) && rawActionIndex >= 0
      ? rawActionIndex
      : 0;
    const transition = input.harness.runInTransaction((db) => {
      const current = input.harness.getDesignProposalWithDb(db, { id: proposal.id });
      if (!current || current.status !== "proposed") {
        return null;
      }
      const next = runAuthorityTransitionWithDb(input.harness, db, current, {
        run,
        task,
        now: input.now ?? NOW_EPOCH(),
        actionIndex,
      });
      if (next.evaluation.disposition === "automatic" && run.status === "blocked") {
        input.harness.updateRunStatusWithDb(db, { runId: run.id, status: "todo" });
      }
      return next;
    });
    if (!transition) {
      result.skipped += 1;
      continue;
    }
    result.inspected += 1;
    result.proposalIds.push(proposal.id);
    if (transition.evaluation.disposition === "automatic") {
      result.approved += 1;
    } else if (transition.evaluation.disposition === "rejected") {
      result.rejected += 1;
    } else {
      result.deferredForCost += 1;
    }
  }
  return result;
}

function runAuthorityTransitionWithDb(
  harness: Harness,
  db: HarnessDatabase,
  proposal: DesignProposal,
  context: ActionContext,
): AuthorityTransitionResult {
  const projectId = proposal.projectId ?? "";
  if (projectId.length === 0) {
    throw new Error(`proposeDesign cannot evaluate authority for proposal ${proposal.id} without a project`);
  }

  // Pin the active founder charter. A missing, inactive, or ambiguous charter
  // cannot grant any automatic authority — the adapter fails closed by routing
  // to human review with no continuation and no delivery run.
  const charter = harness.getActiveFounderCharterWithDb(db, { projectId });
  if (!charter) {
    const evaluation = humanRequiredEvaluationWithoutCharter(proposal, context.now);
    return recordHumanRequiredCheckpointWithDb(harness, db, proposal, evaluation, context, {
      reason: "missing-active-charter",
    });
  }
  if (charter.isActive !== true) {
    const evaluation = humanRequiredEvaluationWithoutCharter(proposal, context.now);
    return recordHumanRequiredCheckpointWithDb(harness, db, proposal, evaluation, context, {
      reason: "inactive-charter",
      charterId: charter.id,
    });
  }

  const charterContext = buildCharterContext(charter);

  // Resolve every evidence reference from durable signals through one strict
  // adapter. The adapter never normalizes invalid state into a clean value:
  // missing signals are omitted so the evaluator fails closed on missing
  // evidence; cross-project signals are omitted so a citation that belongs to
  // another project cannot authorize work here; corrupt conflict metadata is
  // surfaced to the evaluator's invalid-conflict-metadata hard rule instead of
  // being silently coerced to a clean boolean.
  const evidenceRefs = readEvidenceRefs(proposal);
  const evidence = resolveProposalEvidence(harness, db, projectId, evidenceRefs, context.now);

  // Derive a conservative risk surface. Unknown, ambiguous, or missing risk
  // data cannot lower a flag to `false`; the adapter either accepts an
  // explicit designer declaration (validated strictly) or routes to human.
  const { riskSurface, derivationReasons } = deriveConservativeRiskSurface(proposal, evidence.signals);

  // Compute current portfolio usage from stored proposals in the same category
  // (excluding the proposal under evaluation). The first investment counts as
  // one unit when the prior share is zero — the evaluator's existing logic.
  const portfolioUsage = computePortfolioUsageWithDb(harness, db, proposal, riskSurface.portfolio);

  const evaluation = evaluateAuthority({
    charter: charterContext,
    proposal: riskSurface,
    evidence: evidence.references,
    portfolioUsage,
    actor: {
      kind: "auto",
      ref: null,
      isProposer: false,
    },
    evaluatedAt: strictEvaluationTime(context.now),
  });

  // Adapter-level findings make the human checkpoint explicit. The evaluator
  // already fails closed on each finding (missing-evidence for cross-project
  // citations, invalid-conflict-metadata for corrupt conflict data); these
  // notes add a concise, human-readable summary to the recorded reasons so a
  // reviewer sees WHY authority was unavailable, not just THAT it was.
  // derivationReasons explain the conservative risk surface the adapter built
  // (keyword-forced flags, defaulted reversibility/portfolio/cost) and are
  // recorded alongside the decision so the audit trail is self-contained.
  const adapterFindings = describeEvidenceFindings(evidence);

  if (evaluation.disposition === "automatic") {
    return recordAutomaticApprovalWithDb(harness, db, proposal, evaluation, context, {
      charterId: charter.id,
      continuationRiskSurface: riskSurface,
      derivationNotes: derivationReasons,
    });
  }
  if (evaluation.disposition === "rejected") {
    return recordRejectedEvaluationWithDb(harness, db, proposal, evaluation, context, {
      charterId: charter.id,
      adapterFindings,
      derivationNotes: derivationReasons,
    });
  }
  return recordHumanRequiredCheckpointWithDb(harness, db, proposal, evaluation, context, {
    reason: "human-required",
    charterId: charter.id,
    adapterFindings,
    derivationNotes: derivationReasons,
  });
}

function recordAutomaticApprovalWithDb(
  harness: Harness,
  db: HarnessDatabase,
  proposal: DesignProposal,
  evaluation: AuthorityEvaluation,
  context: ActionContext,
  options: {
    charterId: string;
    continuationRiskSurface: AuthorityProposalRiskSurface;
    derivationNotes?: string[];
  },
): AuthorityTransitionResult {
  const decisionId = stableDecisionId(context.run.id, context.task.id, context.actionIndex, proposal.id);
  const existing = harness.listDesignDecisionsWithDb(db, { proposalId: proposal.id, limit: 50 })
    .find((decision) => decision.id === decisionId);
  let authorityDecisionId: string;
  if (existing && existing.decision === "approved" && existing.actorKind === "auto") {
    authorityDecisionId = existing.id;
  } else {
    const recorded = harness.recordDesignDecisionWithDb(db, {
      id: decisionId,
      proposalId: proposal.id,
      decision: "approved",
      actorKind: "auto",
      actorRef: null,
      charterId: options.charterId,
      reasons: evaluation.reasons.map((reason) => `${reason.kind}: ${reason.message}`),
      authority: evaluation as unknown as Record<string, unknown>,
      payload: {
        runId: context.run.id,
        taskId: context.task.id,
        actionIndex: context.actionIndex,
        transition: "automatic",
        riskSurface: options.continuationRiskSurface,
        derivationNotes: options.derivationNotes ?? [],
      },
    });
    authorityDecisionId = recorded.id;
  }

  if (proposal.status !== "accepted") {
    harness.updateDesignProposalStatusWithDb(db, { proposalId: proposal.id, status: "accepted" });
  }

  // Bounded delivery continuation: narrowly instructed to emit exactly one
  // createRunsFromDesign action anchored to the stored proposal. The
  // continuation carries the durable proposal ID; its identity is stable so
  // a replay cannot duplicate the task.
  const continuationTaskId = ensureDesignerContinuationTaskWithDb(
    harness,
    db,
    {
      runId: context.run.id,
      sourceTaskId: context.task.id,
      actionIndex: context.actionIndex,
      kind: "after-approveDesign",
      entityId: proposal.id,
      role: "designer",
      goal: `Designer delivery continuation: emit createRunsFromDesign for ${proposal.id}`,
      prompt: buildDeliveryContinuationPrompt(proposal),
      doneWhen: [
        "Designer emits exactly one createRunsFromDesign action against the stored proposal",
        "Designer does not amend or supersede the frozen proposal envelope",
        "Designer does not record additional signals or proposals in this continuation",
      ],
      config: {
        designContinuation: {
          kind: "after-approveDesign",
          proposalId: proposal.id,
          sourceTaskId: context.task.id,
          actionIndex: context.actionIndex,
        },
      },
      dependsOn: [context.task.id],
    },
  );

  return {
    evaluation,
    evaluationSummary: `automatic; approved=${authorityDecisionId} continuation=${continuationTaskId}`,
    resultingStatus: "accepted",
    authorityDecisionId,
    checkpointDecisionId: null,
    continuationTaskId,
    artifacts: [
      { kind: "design_decision", proposalId: proposal.id, decisionId: authorityDecisionId, disposition: "automatic" },
      { kind: "design_continuation", taskId: continuationTaskId, proposalId: proposal.id },
    ],
    checks: [
      { name: "design authority auto-approved", status: "passed", evidence: authorityDecisionId },
      { name: "design delivery continuation", status: "passed", evidence: continuationTaskId },
    ],
  };
}

function recordHumanRequiredCheckpointWithDb(
  harness: Harness,
  db: HarnessDatabase,
  proposal: DesignProposal,
  evaluation: AuthorityEvaluation,
  context: ActionContext,
  detail: { reason: string; charterId?: string; adapterFindings?: string[]; derivationNotes?: string[] },
): AuthorityTransitionResult {
  // The deferred checkpoint is recorded as a `deferred` auto decision that
  // preserves the complete evaluation. The proposal remains unavailable to
  // delivery (status is left unchanged from "proposed"); no continuation is
  // created; no child run is spawned.
  const checkpointId = stableCheckpointId(context.run.id, context.task.id, context.actionIndex, proposal.id);
  const existing = harness.listDesignDecisionsWithDb(db, { proposalId: proposal.id, limit: 50 })
    .find((decision) => decision.id === checkpointId);
  let checkpointDecisionId: string;
  if (existing && existing.decision === "deferred") {
    checkpointDecisionId = existing.id;
  } else {
    const recorded = harness.recordDesignDecisionWithDb(db, {
      id: checkpointId,
      proposalId: proposal.id,
      decision: "deferred",
      actorKind: "auto",
      actorRef: null,
      charterId: detail.charterId ?? proposal.charterId ?? null,
      reasons: [
        detail.reason,
        ...(detail.adapterFindings ?? []),
        ...evaluation.reasons.map((reason) => `${reason.kind}: ${reason.message}`),
      ],
      authority: evaluation as unknown as Record<string, unknown>,
      payload: {
        runId: context.run.id,
        taskId: context.task.id,
        actionIndex: context.actionIndex,
        transition: "human-required",
        reason: detail.reason,
        adapterFindings: detail.adapterFindings ?? [],
        derivationNotes: detail.derivationNotes ?? [],
      },
    });
    checkpointDecisionId = recorded.id;
  }

  return {
    evaluation,
    evaluationSummary: `human-required; checkpoint=${checkpointDecisionId} reason=${detail.reason}`,
    resultingStatus: proposal.status,
    authorityDecisionId: null,
    checkpointDecisionId,
    continuationTaskId: null,
    artifacts: [
      { kind: "design_authority_checkpoint", proposalId: proposal.id, checkpointDecisionId, disposition: "human-required" },
    ],
    checks: [
      { name: "design authority checkpoint", status: "passed", evidence: checkpointDecisionId },
    ],
  };
}

function recordRejectedEvaluationWithDb(
  harness: Harness,
  db: HarnessDatabase,
  proposal: DesignProposal,
  evaluation: AuthorityEvaluation,
  context: ActionContext,
  options: { charterId: string; adapterFindings?: string[]; derivationNotes?: string[] },
): AuthorityTransitionResult {
  const decisionId = stableDecisionId(context.run.id, context.task.id, context.actionIndex, proposal.id);
  const existing = harness.listDesignDecisionsWithDb(db, { proposalId: proposal.id, limit: 50 })
    .find((decision) => decision.id === decisionId);
  let authorityDecisionId: string;
  if (existing && existing.decision === "rejected") {
    authorityDecisionId = existing.id;
  } else {
    const recorded = harness.recordDesignDecisionWithDb(db, {
      id: decisionId,
      proposalId: proposal.id,
      decision: "rejected",
      actorKind: "auto",
      actorRef: null,
      charterId: options.charterId,
      reasons: [
        ...(options.adapterFindings ?? []),
        ...evaluation.reasons.map((reason) => `${reason.kind}: ${reason.message}`),
      ],
      authority: evaluation as unknown as Record<string, unknown>,
      payload: {
        runId: context.run.id,
        taskId: context.task.id,
        actionIndex: context.actionIndex,
        transition: "rejected",
        adapterFindings: options.adapterFindings ?? [],
        derivationNotes: options.derivationNotes ?? [],
      },
    });
    authorityDecisionId = recorded.id;
  }

  if (proposal.status !== "rejected") {
    harness.updateDesignProposalStatusWithDb(db, { proposalId: proposal.id, status: "rejected" });
  }

  return {
    evaluation,
    evaluationSummary: `rejected; decision=${authorityDecisionId}`,
    resultingStatus: "rejected",
    authorityDecisionId,
    checkpointDecisionId: null,
    continuationTaskId: null,
    artifacts: [
      { kind: "design_decision", proposalId: proposal.id, decisionId: authorityDecisionId, disposition: "rejected" },
    ],
    checks: [
      { name: "design authority rejected", status: "passed", evidence: authorityDecisionId },
    ],
  };
}

function applyDecideDesignWithDb(
  harness: Harness,
  db: HarnessDatabase,
  action: Extract<DesignActionInput, { type: "decideDesign" }>,
  context: ActionContext,
): ApplyActionResult {
  const payload = action.payload;
  const proposalId = requiredString(payload.proposalId, "decideDesign payload.proposalId");
  const decision = requiredString(payload.decision, "decideDesign payload.decision") as
    | "approved"
    | "rejected"
    | "deferred"
    | "retired"
    | "revise";
  if (!["approved", "rejected", "deferred", "retired", "revise"].includes(decision)) {
    throw new Error(
      "decideDesign payload.decision must be approved, rejected, deferred, retired, or revise",
    );
  }
  if (decision === "approved") {
    throw new Error(
      "decideDesign payload.decision approved is not allowed from designer output; record approvals through the authority evaluator or human CLI path",
    );
  }
  const actorKindRaw = optionalString(payload.actorKind, "decideDesign payload.actorKind");
  if (actorKindRaw !== undefined && actorKindRaw !== "auto") {
    throw new Error(
      `decideDesign payload.actorKind ${actorKindRaw} is not allowed from designer output; human and governance decisions are recorded through the authority evaluator or human CLI path`,
    );
  }
  const actorKind = "auto";

  const proposal = harness.getDesignProposalWithDb(db, { id: proposalId });
  if (!proposal) {
    throw new Error(`design proposal not found: ${proposalId}`);
  }

  const decisionId = stableDecideDesignId(context.run.id, context.task.id, context.actionIndex, proposalId);
  const existing = harness.listDesignDecisionsWithDb(db, { proposalId, limit: 50 })
    .find((row) => row.id === decisionId);
  const recorded = existing ?? harness.recordDesignDecisionWithDb(db, {
    id: decisionId,
    proposalId,
    decision,
    actorKind,
    actorRef: optionalString(payload.actorRef, "decideDesign payload.actorRef") ?? null,
    charterId: optionalString(payload.charterId, "decideDesign payload.charterId") ?? proposal.charterId ?? null,
    reasons: optionalStringArray(payload.reasons, "decideDesign payload.reasons") ?? [],
    authority: optionalRecord(payload.authority, "decideDesign payload.authority") ?? {},
    payload: {
      ...(optionalRecord(payload.payload, "decideDesign payload.payload") ?? {}),
      runId: context.run.id,
      taskId: context.task.id,
      actionIndex: context.actionIndex,
    },
  });

  const nextStatus: "rejected" | "retired" | "revise" =
    decision === "rejected"
      ? "rejected"
      : decision === "retired"
        ? "retired"
        : "revise";
  if (nextStatus !== proposal.status) {
    harness.updateDesignProposalStatusWithDb(db, { proposalId, status: nextStatus });
  }

  // Bounded terminal finalization for Linear intake. A non-approve decision
  // ends the issue-scoped Designer cycle without producing a delivery run, so
  // the matching inbox event must transition out of `running` here. The
  // transition is inside the same decideDesign transaction; an already-done
  // event (replay of the same decision) is treated as success. Non-intake
  // runs have no linearIntake block and skip this path entirely.
  const terminalIntake = finalizeLinearIntakeTerminalWithDb(
    harness,
    db,
    context,
    `decideDesign:${decision}`,
  );

  return {
    artifacts: [
      { kind: "design_decision", proposalId, decisionId: recorded.id },
      ...(terminalIntake
        ? [
            {
              kind: "design_intake_finalized" as const,
              proposalId,
              decisionId: recorded.id,
              intakeEventId: terminalIntake.inboxEventId,
            },
          ]
        : []),
    ],
    checks: [
      { name: "design decision recorded", status: "passed", evidence: recorded.id },
      { name: "design proposal status", status: "passed", evidence: nextStatus },
      ...(terminalIntake
        ? [
            {
              name: "linear intake inbox finalized",
              status: "passed" as const,
              evidence: terminalIntake.inboxEventId,
            },
          ]
        : []),
    ],
    createdRuns: [],
    eventResult: {
      decisionId: recorded.id,
      decision,
      nextStatus,
      ...(terminalIntake ? { intake: terminalIntake } : {}),
    },
  };
}

function applyRecordDesignOutcomeWithDb(
  harness: Harness,
  db: HarnessDatabase,
  action: Extract<DesignActionInput, { type: "recordDesignOutcome" }>,
  context: ActionContext,
): ApplyActionResult {
  const payload = action.payload;
  const proposalId = requiredString(payload.proposalId, "recordDesignOutcome payload.proposalId");
  const proposal = harness.getDesignProposalWithDb(db, { id: proposalId });
  if (!proposal) {
    throw new Error(`design proposal not found: ${proposalId}`);
  }
  const stage = requiredString(payload.stage, "recordDesignOutcome payload.stage") as
    | "experiment"
    | "release"
    | "review";
  if (!["experiment", "release", "review"].includes(stage)) {
    throw new Error("recordDesignOutcome payload.stage must be experiment, release, or review");
  }
  const recommendation = requiredString(payload.recommendation, "recordDesignOutcome payload.recommendation") as
    | "retain"
    | "revise"
    | "retire";
  if (!["retain", "revise", "retire"].includes(recommendation)) {
    throw new Error("recordDesignOutcome payload.recommendation must be retain, revise, or retire");
  }
  const reviewAt = optionalIsoTimestamp(payload.reviewAt, "recordDesignOutcome payload.reviewAt");
  const evidence = optionalArray(payload.evidence, "recordDesignOutcome payload.evidence") ?? [];
  if (stage === "review" && evidence.length === 0) {
    throw new Error("recordDesignOutcome stage review requires evidence observations");
  }

  const outcomeId = stableOutcomeId(context.run.id, context.task.id, context.actionIndex, proposalId);
  const existingOutcome = harness.listDesignOutcomes({ proposalId, limit: 50 })
    .find((row) => row.id === outcomeId);
  const outcome = existingOutcome ?? harness.recordDesignOutcomeWithDb(db, {
    id: outcomeId,
    proposalId,
    stage,
    recommendation,
    baseline: optionalRecord(payload.baseline, "recordDesignOutcome payload.baseline") ?? {},
    observed: optionalRecord(payload.observed, "recordDesignOutcome payload.observed") ?? {},
    evidence,
    unexpectedEffects: optionalArray(payload.unexpectedEffects, "recordDesignOutcome payload.unexpectedEffects") ?? [],
    reviewAt,
    runId: context.run.id,
    taskId: context.task.id,
    attemptId: null,
    payload: optionalRecord(payload.payload, "recordDesignOutcome payload.payload") ?? {},
  });

  if (stage === "review" && recommendation === "revise") {
    harness.updateDesignProposalStatusWithDb(db, { proposalId, status: "revise" });
  }
  if (stage === "review" && recommendation === "retire") {
    harness.updateDesignProposalStatusWithDb(db, { proposalId, status: "retired" });
  }
  if (stage === "review" && recommendation === "retain") {
    harness.updateDesignProposalStatusWithDb(db, { proposalId, status: "retained" });
  }

  // Adverse outcomes (revise/retire) become a fresh strategy signal so the
  // next designer pass can pick the discrepancy up. The completed delivery
  // task is never silently reopened: the signal is observable, sourced, and
  // time-bound, and the original run stays in its measuring status until a
  // new proposal explicitly supersedes it.
  let adverseSignalId: string | null = null;
  if (recommendation === "revise" || recommendation === "retire") {
    const adverseSignalStableId = stableAdverseSignalId(context.run.id, context.task.id, context.actionIndex, proposalId);
    const existingSignal = harness.listStrategySignalsWithDb(db, { projectId: proposal.projectId ?? "", limit: 200 })
      .find((row) => row.id === adverseSignalStableId);
    if (existingSignal) {
      adverseSignalId = existingSignal.id;
    } else {
      const signal = harness.createStrategySignalWithDb(db, {
        id: adverseSignalStableId,
        projectId: proposal.projectId ?? "",
        signalClass: "delivery",
        source: "outcome-review",
        title: `${recommendation} outcome for ${proposal.title}`,
        summary: adverseSignalSummary(proposal, recommendation, payload.unexpectedEffects),
        observationTime: new Date(context.now).toISOString(),
        confidence: 0.8,
        evidence: [
          `design_outcome:${outcome.id}`,
          `design_proposal:${proposal.id}`,
          ...(evidence.length > 0 ? evidence : []),
        ],
        expiresAt: null,
        conflictingSignalIds: [],
        proposalId,
        runId: context.run.id,
        taskId: context.task.id,
        attemptId: null,
        payload: {
          outcomeId: outcome.id,
          outcomeRecommendation: recommendation,
          unexpectedEffects: optionalArray(payload.unexpectedEffects, "recordDesignOutcome payload.unexpectedEffects") ?? [],
          baseline: optionalRecord(payload.baseline, "recordDesignOutcome payload.baseline") ?? {},
          observed: optionalRecord(payload.observed, "recordDesignOutcome payload.observed") ?? {},
        },
      });
      adverseSignalId = signal.id;
    }
  }

  return {
    artifacts: [
      { kind: "design_outcome", proposalId, outcomeId: outcome.id },
      ...(adverseSignalId
        ? [{ kind: "design_signal" as const, signalId: adverseSignalId }]
        : []),
    ],
    checks: [
      { name: "design outcome recorded", status: "passed", evidence: outcome.id },
      { name: "design outcome recommendation", status: "passed", evidence: recommendation },
      ...(adverseSignalId
        ? [{ name: "adverse outcome signal", status: "passed" as const, evidence: adverseSignalId }]
        : []),
    ],
    createdRuns: [],
    eventResult: {
      outcomeId: outcome.id,
      stage,
      recommendation,
      adverseSignalId,
    },
  };
}

function applyCreateRunsFromDesignWithDb(
  harness: Harness,
  db: HarnessDatabase,
  action: Extract<DesignActionInput, { type: "createRunsFromDesign" }>,
  context: ActionContext,
): ApplyActionResult {
  const payload = action.payload;
  const proposalId = requiredString(payload.proposalId, "createRunsFromDesign payload.proposalId");
  const proposal = harness.getDesignProposalWithDb(db, { id: proposalId });
  if (!proposal) {
    throw new Error(`design proposal not found: ${proposalId}`);
  }
  if (proposal.status !== "accepted") {
    throw new Error(
      `createRunsFromDesign requires an accepted proposal; ${proposalId} status is ${proposal.status}`,
    );
  }

  const decisions = harness.listDesignDecisionsWithDb(db, { proposalId });
  const approval = decisions.find((decision) => decision.decision === "approved");
  if (!approval) {
    throw new Error(`createRunsFromDesign requires an approved decision for ${proposalId}`);
  }
  if (approval.actorKind !== "auto" && approval.actorKind !== "human" && approval.actorKind !== "governance") {
    throw new Error(`createRunsFromDesign approved actor ${approval.actorKind} is not allowed`);
  }
  if (approval.actorKind === "human" || approval.actorKind === "governance") {
    if (!approval.actorRef || approval.actorRef.trim().length === 0) {
      throw new Error(
        `createRunsFromDesign approved ${approval.actorKind} decision for ${proposalId} is missing actorRef; authenticated human checkpoints require a non-empty actorRef`,
      );
    }
  }

  // Linear intake provenance. When createRunsFromDesign is invoked from an
  // issue-scoped Designer run, context.run.context.linearIntake carries the
  // immutable Linear issue ID, inbox event ID, and root lineage stamped by the
  // intake path. The intake contract requires exactly one accepted and approved
  // delivery run per issue; that run must carry forward the full provenance
  // block, link to the immutable Linear issue through exactly one external_refs
  // row, and finalize the matching inbox event (running → done) only after the
  // run, task, and reference are durable. A malformed intake block, a proposal
  // whose durable source run/task does not match the issue-scoped Designer
  // cycle, an attempt to spawn multiple Linear intake runs from one proposal,
  // or any reference mismatch throws inside the createRunsFromDesign
  // transaction so the entire atomic step rolls back without marking the
  // inbox done.
  //
  // The legitimate production delivery path runs the action from the
  // deterministic after-approveDesign continuation task generated by
  // recordAutomaticApprovalWithDb. That task has its own task ID (distinct
  // from proposal.taskId, which is the original Designer task that ran
  // proposeDesign) but carries config.designContinuation = { kind:
  // "after-approveDesign", proposalId, sourceTaskId, actionIndex } binding it
  // to the original cycle. Accept the legitimate continuation by validating
  // every binding field; reject cross-run, cross-proposal, or forged
  // continuations. The durable sourceDesignerTaskId stamped onto the child
  // run's linearIntake block is the ORIGINAL Designer task (the one that ran
  // proposeDesign) — recovered from continuation.sourceTaskId when the
  // legitimate continuation path is in use — so a downstream planner or
  // verifier always traces the canonical planning run back to the cycle that
  // produced the proposal, not to the deterministic delivery vehicle.
  const linearIntake = readLinearIntakeProvenance(context.run.context);
  let linearIntakeSourceDesignerTaskId: string | null = null;
  if (linearIntake) {
    const sameCycle = proposal.runId === context.run.id && proposal.taskId === context.task.id;
    const continuation = readAfterApproveDesignContinuation(context.task.config);
    // The deterministic continuation identity is derived from
    // (runId, sourceTaskId, actionIndex, kind, proposalId) — exactly the
    // fields stamped into config.designContinuation by
    // recordAutomaticApprovalWithDb when it creates the legitimate
    // after-approveDesign continuation task. Any task claiming this
    // metadata must literally BE that task: a forged task that copies the
    // metadata bindings but carries a different task ID cannot satisfy
    // the deterministic ID check. This closes the forgery vector where a
    // stray or malicious task copies kind=after-approveDesign plus the
    // legitimate proposalId/sourceTaskId/runId bindings and supplies any
    // finite actionIndex to satisfy the loose ownership guard.
    const expectedContinuationTaskId = continuation !== null
      ? stableContinuationTaskId(
          context.run.id,
          continuation.sourceTaskId,
          continuation.actionIndex,
          continuation.kind,
          continuation.proposalId,
        )
      : null;
    const continuationTaskIdMatches = continuation !== null
      && expectedContinuationTaskId === context.task.id;
    const legitContinuation =
      continuation !== null
      && continuationTaskIdMatches
      && continuation.proposalId === proposal.id
      && continuation.sourceTaskId === proposal.taskId
      && proposal.runId === context.run.id;
    if (continuation !== null && !continuationTaskIdMatches) {
      // Continuation metadata was present on a task that is NOT the
      // canonical deterministic continuation. This is either a producer
      // defect (continuation metadata drifted onto an unrelated task) or
      // an adversarial forgery attempt. Either way the guard fails
      // closed: the intake contract requires the delivery vehicle to be
      // the exact task whose ID is derived from the metadata bindings.
      throw new Error(
        `createRunsFromDesign for Linear intake proposal ${proposalId} rejects task ${context.task.id} because its designContinuation metadata does not resolve to the canonical after-approveDesign continuation (expected ${expectedContinuationTaskId}); forged continuations are not a valid delivery path`,
      );
    }
    if (!sameCycle && !legitContinuation) {
      throw new Error(
        `createRunsFromDesign for Linear intake proposal ${proposalId} must originate from the same issue-scoped Designer cycle; proposal runId=${proposal.runId ?? "<null>"} taskId=${proposal.taskId ?? "<null>"} does not match context runId=${context.run.id} taskId=${context.task.id}${continuation ? ` or continuation bindings proposalId=${continuation.proposalId} sourceTaskId=${continuation.sourceTaskId}` : ""}`,
      );
    }
    // Provenance of the canonical planning run is the ORIGINAL Designer
    // task that ran proposeDesign — the one whose task ID is recorded as
    // proposal.taskId. The sameCycle branch IS that task
    // (proposal.taskId === context.task.id). The legitContinuation branch
    // recovers it from continuation.sourceTaskId, which is the original
    // Designer task that the deterministic continuation was bound to at
    // creation time. Stray continuation metadata on the same-cycle task
    // never overrides this: sameCycle authorizes via the durable proposal
    // columns, and the source task ID is taken from those columns, not
    // from the metadata block.
    linearIntakeSourceDesignerTaskId = sameCycle
      ? context.task.id
      : (legitContinuation ? continuation!.sourceTaskId : context.task.id);
  }

  // Issue-level canonical guard. Before creating any new state, verify that
  // any prior run-to-issue external reference for this immutable Linear issue
  // points at the same canonical planning run we are about to create. A
  // reference pointing at a different run under the same issue is a producer
  // defect or an attempt to deliver two distinct proposals for one immutable
  // issue — fail closed rather than mutate the canonical state. The lookup
  // runs inside the createRunsFromDesign transaction so a concurrent writer
  // cannot slip a duplicate reference between check and create.
  let canonicalChildRunId: string | null = null;
  let canonicalPlannerTaskId: string | null = null;
  if (linearIntake) {
    canonicalChildRunId = stableLinearIntakeChildRunId(linearIntake.rootRunId, linearIntake.linearIssueId);
    canonicalPlannerTaskId = stableLinearIntakePlannerTaskId(linearIntake.rootRunId, linearIntake.linearIssueId);
    const prior = harness
      .findExternalRefsWithDb(db, {
        provider: "linear",
        externalType: "issue",
        externalId: linearIntake.linearIssueId,
        localType: "run",
      })
      .filter((ref) => ref.provider === "linear" && ref.externalType === "issue");
    if (prior.length > 0) {
      const first = prior[0];
      if (first.localId !== canonicalChildRunId) {
        throw new Error(
          `createRunsFromDesign for Linear intake issue ${linearIntake.linearIssueId} cannot create canonical planning run ${canonicalChildRunId}; existing reference ${first.id} already links issue to run ${first.localId}`,
        );
      }
      for (const ref of prior.slice(1)) {
        if (ref.localId !== canonicalChildRunId) {
          throw new Error(
            `createRunsFromDesign for Linear intake issue ${linearIntake.linearIssueId} found duplicate canonical references ${first.id} (run ${first.localId}) and ${ref.id} (run ${ref.localId}); exactly one run-to-issue reference is allowed`,
          );
        }
      }
    }
  }

  const runs = Array.isArray(payload.runs) ? payload.runs : [];
  if (runs.length === 0) {
    throw new Error("createRunsFromDesign payload.runs must include at least one planned run");
  }

  // Charter resolution. Automatic production approvals carry the durable
  // resolved founder charter pinned during authority evaluation, so they — and
  // the child runs they spawn — always inherit the same non-null charter. The
  // production Designer prompt does not require charterId on proposeDesign, so
  // proposal.charterId may be null even for a successfully accepted proposal.
  //
  // Legacy/manual (human or governance) approvals recorded before the
  // coordinator persisted the resolved charter may lack charterId on both the
  // approval and the proposal. To preserve compatibility for those existing
  // decisions, fall back to a validated current active founder charter for the
  // proposal's project; if none is active either, the legacy/manual child run
  // is still created (with a null charter). Only automatic approvals are
  // required to carry a non-null resolved charter — the resolved charter is
  // already recorded on the approval by the authority evaluator, so a missing
  // one is a producer defect, not a legacy envelope. Evidence and authority
  // checks above are unaffected: this resolution only stamps the charter on the
  // child run context; it does not mint, alter, or bypass any decision.
  const isLegacyManualApproval =
    approval.actorKind === "human" || approval.actorKind === "governance";
  let resolvedCharterId: string | null = approval.charterId ?? proposal.charterId ?? null;
  if (!resolvedCharterId && isLegacyManualApproval && proposal.projectId) {
    const fallbackCharter = harness.getActiveFounderCharterWithDb(db, {
      projectId: proposal.projectId,
    });
    if (fallbackCharter && fallbackCharter.isActive === true) {
      resolvedCharterId = fallbackCharter.id;
    }
  }
  if (!resolvedCharterId && !isLegacyManualApproval) {
    throw new Error(
      `createRunsFromDesign requires a resolved founder charter for ${proposalId}; automatic approvals must inherit the active charter recorded during authority evaluation`,
    );
  }

  const frozenContract = { ...proposal.proposal.evaluationContract };
  // Preserve the complete stored proposal envelope — including any extension
  // fields the designer recorded beyond the canonical contract — so planners,
  // workers, and verifiers inherit a single durable source of truth. The
  // canonical top-level fields are re-pinned from the stored columns to defend
  // against a proposal_json payload that drifts away from them.
  const frozenProposal: Record<string, unknown> = {
    ...proposal.proposal,
    problem: proposal.problem,
    recommendation: proposal.recommendation,
    title: proposal.title,
    options: proposal.proposal.options ?? [],
    targetOutcome: proposal.proposal.targetOutcome ?? null,
    assumptions: proposal.proposal.assumptions ?? [],
    uncertainty: proposal.proposal.uncertainty ?? [],
    experiment: proposal.proposal.experiment ?? null,
    evidenceRefs: proposal.proposal.evidenceRefs ?? [],
    additions: proposal.proposal.additions ?? [],
    removals: proposal.proposal.removals ?? [],
  };
  const frozenInvestment: Record<string, unknown> = { ...proposal.proposal.investment };
  const frozenAdditions: string[] = proposal.proposal.additions ?? [];
  const frozenRemovals: string[] = proposal.proposal.removals ?? [];
  const approvalAuthority: Record<string, unknown> = {
    decisionId: approval.id,
    decision: approval.decision,
    actorKind: approval.actorKind,
    actorRef: approval.actorRef,
    reasons: approval.reasons,
    authority: approval.authority,
    charterId: resolvedCharterId,
  };

  // Linear intake provenance for this run was read and validated above. The
  // single-run contract for Linear intake proposals is enforced here, after
  // the runs payload is parsed.
  if (linearIntake && runs.length !== 1) {
    throw new Error(
      `createRunsFromDesign for Linear intake proposal ${proposalId} must create exactly one run; received ${runs.length}`,
    );
  }

  const createdRuns: Array<{ runId: string; plannerTaskId: string; proposalId: string }> = [];
  let intakeFinalization: LinearIntakeFinalization | null = null;
  runs.forEach((plannedRun, runIndex) => {
    // Linear intake proposals derive canonical planning-run and planner-task
    // IDs from the immutable Linear issue ID (rooted at the supervised run).
    // Distinct proposals, action replays, and the legitimate
    // after-approveDesign continuation task all converge on the same canonical
    // IDs so exactly one planning run and one planner task exist per issue.
    // Non-intake proposals keep the existing derivation keyed on the
    // proposing run/task/action/proposal/runIndex.
    const childRunId = linearIntake && canonicalChildRunId
      ? canonicalChildRunId
      : stableChildRunId(context.run.id, context.task.id, context.actionIndex, proposalId, runIndex);
    const plannerTaskId = linearIntake && canonicalPlannerTaskId
      ? canonicalPlannerTaskId
      : stablePlannerTaskId(context.run.id, context.task.id, context.actionIndex, proposalId, runIndex);
    // Idempotent replay: a prior run with the same stable ID already encodes
    // the planned delivery. We never recreate or duplicate the run.
    const existingRun = harness.getRun(childRunId);
    if (!existingRun) {
      const childContext: Record<string, unknown> = {
        ...(plannedRun.context ?? {}),
        ...inheritedControlContext(context.run.context),
        parentRunId: context.run.id,
        sourceTaskId: context.task.id,
        source: "design",
        designProposalId: proposal.id,
        designCharterId: resolvedCharterId,
        designDecisionId: approval.id,
        designEvaluationContract: frozenContract,
        designProposal: frozenProposal,
        designInvestment: frozenInvestment,
        designAdditions: frozenAdditions,
        designRemovals: frozenRemovals,
        designApprovalAuthority: approvalAuthority,
      };
      if (linearIntake) {
        childContext.linearIntake = buildChildRunLinearIntakeBlock({
          parent: linearIntake,
          proposalId: proposal.id,
          decisionId: approval.id,
          sourceDesignerRunId: context.run.id,
          sourceDesignerTaskId: linearIntakeSourceDesignerTaskId ?? context.task.id,
        });
      }
      harness.createRunWithDb(db, {
        id: childRunId,
        goal: plannedRun.goal,
        context: childContext,
      });
    } else if (linearIntake) {
      verifyExistingRunIntakeProvenance(existingRun.context, {
        parent: linearIntake,
        proposalId: proposal.id,
        decisionId: approval.id,
        sourceDesignerRunId: context.run.id,
        sourceDesignerTaskId: linearIntakeSourceDesignerTaskId ?? context.task.id,
        childRunId,
      });
    }
    const existingTask = harness.getTask(plannerTaskId);
    if (!existingTask) {
      harness.createTaskWithDb(db, {
        id: plannerTaskId,
        runId: childRunId,
        role: "planner",
        goal: `Plan run: ${plannedRun.goal}`,
        prompt: plannedRun.prompt,
        doneWhen: plannedRun.doneWhen ?? [
          "Planner returns a small nextTasks graph for this run",
          "Every generated task honors the frozen design evaluation contract",
          "The run can be drained by the supervisor without manual task injection",
        ],
        config: plannedRun.modelPreference ? { modelPreference: plannedRun.modelPreference } : {},
      });
    }
    createdRuns.push({ runId: childRunId, plannerTaskId, proposalId: proposal.id });
  });

  // After every planned run, planner task, and the durable child context are in
  // place inside the same transaction, finalize the Linear intake lifecycle:
  // one external_refs row linking the planning run to the immutable Linear
  // issue, then the matching inbox event transitions running → done. A failure
  // here rolls back the entire action — including the just-created run, task,
  // and reference — so no partial delivery can survive.
  if (linearIntake) {
    const childRun = createdRuns[0];
    intakeFinalization = finalizeLinearIntakeWithDb(harness, db, {
      intake: linearIntake,
      runId: childRun.runId,
      plannerTaskId: childRun.plannerTaskId,
      proposalId: proposal.id,
      decisionId: approval.id,
    });
  }

  const artifacts: AppliedDesignAction[] = createdRuns.map((created) => ({
    kind: "design_proposal" as const,
    proposalId: created.proposalId,
  }));
  if (intakeFinalization) {
    artifacts.push({
      kind: "design_intake_finalized",
      proposalId: proposal.id,
      decisionId: approval.id,
      intakeEventId: intakeFinalization.inboxEventId,
      externalRefId: intakeFinalization.externalRefId,
    });
  }

  return {
    artifacts,
    checks: [
      { name: "design proposal accepted", status: "passed", evidence: proposal.id },
      { name: "design decision approved", status: "passed", evidence: approval.id },
      { name: "design child runs created", status: "passed", evidence: String(createdRuns.length) },
      ...(intakeFinalization
        ? [
            { name: "linear intake external reference", status: "passed" as const, evidence: intakeFinalization.externalRefId },
            { name: "linear intake inbox finalized", status: "passed" as const, evidence: intakeFinalization.inboxEventId },
          ]
        : []),
    ],
    createdRuns,
    eventResult: {
      proposalId: proposal.id,
      decisionId: approval.id,
      runs: createdRuns.map(({ runId, plannerTaskId }) => ({ runId, plannerTaskId })),
      ...(intakeFinalization
        ? {
            intake: {
              inboxEventId: intakeFinalization.inboxEventId,
              externalRefId: intakeFinalization.externalRefId,
              linearIssueId: intakeFinalization.linearIssueId,
            },
          }
        : {}),
    },
  };
}

function inheritedControlContext(context: Record<string, unknown>) {
  return Object.fromEntries(
    [
      "modelDefaults",
      "agentDefaults",
      "agentBackends",
      "guardrails",
      "integrationBoundary",
      "goalContract",
      "founderCharterId",
    ]
      .filter((key) => context[key] !== undefined)
      .map((key) => [key, context[key]]),
  );
}

// ---------------------------------------------------------------------------
// Linear intake provenance helpers
// ---------------------------------------------------------------------------
//
// The issue-scoped Designer run created by the intake path stamps a
// `linearIntake` block on its run context (see
// packages/cli/src/linear-intake.ts:buildIssueScopedRunContext). That block is
// the immutable transport contract between intake and the fixed design action
// path: the immutable Linear issue ID, the durable inbox event ID, the
// supervised root run, and the issue's stable display metadata. The createRuns
// FromDesign action runs from the same Designer run (including its delivery
// continuation), so context.run.context.linearIntake carries the block through
// proposeDesign, the recorded authority decision, and the bounded delivery
// continuation into the planning-run creation step.

interface LinearIntakeProvenance {
  rootRunId: string;
  inboxEventId: string;
  linearIssueId: string;
  issueIdentifier: string | null;
  issueUrl: string | null;
  issueTitle: string | null;
  issueCreatedAt: string | null;
  issueTeamKey: string | null;
  issueTeamId: string | null;
  issueProjectId: string | null;
  // Extended fields stamped onto the canonical planning run by
  // buildChildRunLinearIntakeBlock. These are absent on the issue-scoped
  // Designer run (the parent) and present on the canonical planning run
  // (the child). verifyExistingRunIntakeProvenance compares every field of
  // the child block, so readNullableString returns the raw value here.
  proposalId?: string | null;
  decisionId?: string | null;
  sourceDesignerRunId?: string | null;
  sourceDesignerTaskId?: string | null;
}

// Read and strictly validate the intake provenance block off a Designer run's
// context. Returns null when the block is absent (the typical non-Linear
// design action path). Throws when the block exists but is missing required
// immutable fields (rootRunId, inboxEventId, linearIssueId) — a malformed
// intake block cannot be safely linked to an inbox event or external reference
// and must not silently degrade into a non-intake path. Optional extended
// child-run fields (proposalId, decisionId, sourceDesignerRunId,
// sourceDesignerTaskId) are returned when present so the verify helper can
// compare the full canonical block.
function readLinearIntakeProvenance(
  context: Record<string, unknown>,
): LinearIntakeProvenance | null {
  const raw = context.linearIntake;
  if (raw === undefined || raw === null) {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      "createRunsFromDesign run context.linearIntake must be an object when present",
    );
  }
  const rec = raw as Record<string, unknown>;
  const rootRunId = readNullableString(rec.rootRunId);
  const inboxEventId = readNullableString(rec.inboxEventId);
  const linearIssueId = readNullableString(rec.linearIssueId);
  if (!rootRunId) {
    throw new Error(
      "createRunsFromDesign run context.linearIntake.rootRunId must be a non-empty string",
    );
  }
  if (!inboxEventId) {
    throw new Error(
      "createRunsFromDesign run context.linearIntake.inboxEventId must be a non-empty string",
    );
  }
  if (!linearIssueId) {
    throw new Error(
      "createRunsFromDesign run context.linearIntake.linearIssueId must be a non-empty string",
    );
  }
  return {
    rootRunId,
    inboxEventId,
    linearIssueId,
    issueIdentifier: readNullableString(rec.issueIdentifier),
    issueUrl: readNullableString(rec.issueUrl),
    issueTitle: readNullableString(rec.issueTitle),
    issueCreatedAt: readNullableString(rec.issueCreatedAt),
    issueTeamKey: readNullableString(rec.issueTeamKey),
    issueTeamId: readNullableString(rec.issueTeamId),
    issueProjectId: readNullableString(rec.issueProjectId),
    proposalId: readNullableString(rec.proposalId),
    decisionId: readNullableString(rec.decisionId),
    sourceDesignerRunId: readNullableString(rec.sourceDesignerRunId),
    sourceDesignerTaskId: readNullableString(rec.sourceDesignerTaskId),
  };
}

function readNullableString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("linearIntake metadata value must be a string when present");
  }
  return value;
}

// Build the durable linearIntake block stamped onto each Linear intake
// planning run. The child run inherits the immutable issue identity and inbox
// event ID from the intake path, plus the new design provenance: the
// source Designer run/task that produced the proposal, the proposal ID, and
// the approved decision ID that authorized the delivery run. Every downstream
// planner, worker, and verifier reads the same immutable provenance from this
// block — it is the durable source of truth for "where did this run come
// from and what Linear issue does it serve?".
function buildChildRunLinearIntakeBlock(input: {
  parent: LinearIntakeProvenance;
  proposalId: string;
  decisionId: string;
  sourceDesignerRunId: string;
  sourceDesignerTaskId: string;
}): Record<string, unknown> {
  const parent = input.parent;
  return {
    rootRunId: parent.rootRunId,
    inboxEventId: parent.inboxEventId,
    linearIssueId: parent.linearIssueId,
    issueIdentifier: parent.issueIdentifier,
    issueUrl: parent.issueUrl,
    issueTitle: parent.issueTitle,
    issueCreatedAt: parent.issueCreatedAt,
    issueTeamKey: parent.issueTeamKey,
    issueTeamId: parent.issueTeamId,
    issueProjectId: parent.issueProjectId,
    proposalId: input.proposalId,
    decisionId: input.decisionId,
    sourceDesignerRunId: input.sourceDesignerRunId,
    sourceDesignerTaskId: input.sourceDesignerTaskId,
  };
}

// When the deterministic child run ID already exists (replay of the same fixed
// action), verify the prior run carries the same intake provenance before
// reusing it. A run with the same stable ID but mismatched intake metadata is
// a producer defect or a deterministic-id collision — fail closed instead of
// mutating unrelated state.
function verifyExistingRunIntakeProvenance(
  context: Record<string, unknown>,
  expected: {
    parent: LinearIntakeProvenance;
    proposalId: string;
    decisionId: string;
    sourceDesignerRunId: string;
    sourceDesignerTaskId: string;
    childRunId: string;
  },
) {
  const existing = readLinearIntakeProvenance(context);
  if (!existing) {
    throw new Error(
      `createRunsFromDesign Linear intake replay found child run ${expected.childRunId} without linearIntake provenance`,
    );
  }
  const expectedBlock = buildChildRunLinearIntakeBlock({
    parent: expected.parent,
    proposalId: expected.proposalId,
    decisionId: expected.decisionId,
    sourceDesignerRunId: expected.sourceDesignerRunId,
    sourceDesignerTaskId: expected.sourceDesignerTaskId,
  });
  for (const key of Object.keys(expectedBlock)) {
    const want = expectedBlock[key];
    const got = (existing as unknown as Record<string, unknown>)[key];
    if (want !== got) {
      throw new Error(
        `createRunsFromDesign Linear intake replay found child run ${expected.childRunId} with mismatched linearIntake.${key}: expected ${JSON.stringify(want)}, found ${JSON.stringify(got)}`,
      );
    }
  }
}

interface LinearIntakeFinalization {
  inboxEventId: string;
  linearIssueId: string;
  externalRefId: string;
}

// The atomic finalization step for one Linear intake issue. Creates or reuses
// one canonical external_refs row linking the planning run to the immutable
// Linear issue (provider=linear, external_type=issue, external_id=immutable
// issue id, local_type=run, local_id=canonical planning run id), then
// transitions the matching inbox event running → done. The reference ID is
// derived from the immutable issue identity alone, so distinct proposals,
// action replays, and the legitimate after-approveDesign continuation all
// converge on the same row. Both writes participate in the surrounding
// createRunsFromDesign transaction: a failure on either side rolls back the
// run, task, and reference so no partial delivery can survive.
//
// Idempotent replay reuses the existing reference. An already-done inbox row
// is treated as success ONLY after verifying the canonical reference and
// planning run are still durable; without that check, a no-action
// after-approveDesign continuation that previously marked the inbox done
// without creating a planning run/reference could mask the missing delivery.
function finalizeLinearIntakeWithDb(
  harness: Harness,
  db: HarnessDatabase,
  input: {
    intake: LinearIntakeProvenance;
    runId: string;
    plannerTaskId: string;
    proposalId: string;
    decisionId: string;
  },
): LinearIntakeFinalization {
  const externalRefId = stableLinearExternalRefId({
    provider: "linear",
    externalType: "issue",
    externalId: input.intake.linearIssueId,
  });
  const ensureResult = harness.ensureExternalRefWithDb(db, {
    id: externalRefId,
    localType: "run",
    localId: input.runId,
    provider: "linear",
    externalType: "issue",
    externalId: input.intake.linearIssueId,
    externalUrl: input.intake.issueUrl,
  });

  // Verify any pre-existing reference still binds to the same canonical
  // planning run and issue. A reference pointing at a different run or issue
  // under the same deterministic issue-level id is a producer defect — fail
  // closed rather than mutate the existing row.
  if (!ensureResult.created) {
    const ref = ensureResult.ref;
    if (
      ref.localId !== input.runId ||
      ref.externalId !== input.intake.linearIssueId ||
      ref.provider !== "linear" ||
      ref.externalType !== "issue" ||
      ref.localType !== "run"
    ) {
      throw new Error(
        `createRunsFromDesign Linear intake external reference ${ref.id} mismatched: local_id=${ref.localId} external_id=${ref.externalId}`,
      );
    }
  }

  // Verify the canonical state is consistent before treating an already-done
  // inbox as idempotent success. The pre-check in applyCreateRunsFromDesign
  // withDb guarantees no other planning run can claim this issue; this check
  // guarantees the matching planning run referenced by `input.runId` exists
  // and carries the matching linearIntake block. A missing or mismatched
  // planning run indicates a torn write or a stale done inbox event — surface
  // the failure instead of finalizing silently.
  const canonicalRun = harness.getRunWithDb(db, input.runId);
  if (!canonicalRun) {
    throw new Error(
      `createRunsFromDesign Linear intake canonical planning run ${input.runId} not found while finalizing issue ${input.intake.linearIssueId}`,
    );
  }
  const canonicalRunIntake = readLinearIntakeProvenance(canonicalRun.context);
  if (!canonicalRunIntake) {
    throw new Error(
      `createRunsFromDesign Linear intake canonical planning run ${input.runId} missing linearIntake provenance for issue ${input.intake.linearIssueId}`,
    );
  }
  if (canonicalRunIntake.linearIssueId !== input.intake.linearIssueId) {
    throw new Error(
      `createRunsFromDesign Linear intake canonical planning run ${input.runId} carries issue ${canonicalRunIntake.linearIssueId}; expected ${input.intake.linearIssueId}`,
    );
  }

  // The intake path leaves the inbox event in `running` after the issue-scoped
  // Designer run and task are durable; finalization transitions it to `done`
  // only after the planning run, planner task, and external reference are
  // durable in this transaction. An event that has already transitioned to
  // done is acceptable ONLY when the canonical reference, canonical planning
  // run, and matching linearIntake block have just been verified above; we
  // surface every other unexpected state as a hook failure so a stuck
  // after-approveDesign continuation cannot quietly finalize intake without
  // the durable delivery.
  try {
    harness.transitionInboxEventWithDb(db, {
      id: input.intake.inboxEventId,
      from: "running",
      to: "done",
    });
  } catch (error) {
    const message = (error as Error).message;
    if (!/found done/.test(message)) {
      throw error;
    }
  }

  return {
    inboxEventId: input.intake.inboxEventId,
    linearIssueId: input.intake.linearIssueId,
    externalRefId,
  };
}

// Bounded terminal finalization for Linear intake cycles that end without an
// accepted delivery proposal. The intake path leaves the inbox event in
// `running` after the issue-scoped Designer run/task are durable; the lifecycle
// must still terminate when the Designer reaches a quiescent, rejected,
// deferred, revised, retired, or signal-only outcome instead of an accepted
// delivery. This helper transitions running → done inside the caller's
// transaction (or its own transaction when invoked from the hook's no-action
// path) so the intake cannot stay pending forever. Idempotent replay treats an
// already-done event as success.
function finalizeLinearIntakeTerminalWithDb(
  harness: Harness,
  db: HarnessDatabase,
  context: ActionContext,
  reason: string,
): { inboxEventId: string; linearIssueId: string; reason: string } | null {
  const intake = readLinearIntakeProvenance(context.run.context);
  if (!intake) {
    return null;
  }
  // The after-approveDesign continuation must never terminalize intake — the
  // proposal is already accepted and the only legitimate finalization is
  // createRunsFromDesign. A decideDesign call from this continuation would
  // indicate a producer defect (the continuation is bounded to
  // createRunsFromDesign) or an attempt to bypass the delivery contract.
  // Surface the failure as a hook problem instead of silently finalizing.
  const continuation = readAfterApproveDesignContinuation(context.task.config);
  if (continuation) {
    throw new Error(
      `after-approveDesign continuation ${context.task.id} for proposal ${continuation.proposalId} cannot terminalize Linear intake via ${reason}; createRunsFromDesign is the only legitimate delivery path`,
    );
  }
  try {
    harness.transitionInboxEventWithDb(db, {
      id: intake.inboxEventId,
      from: "running",
      to: "done",
    });
  } catch (error) {
    const message = (error as Error).message;
    if (!/found done/.test(message)) {
      throw error;
    }
  }
  return {
    inboxEventId: intake.inboxEventId,
    linearIssueId: intake.linearIssueId,
    reason,
  };
}

// Hook-level wrapper for the quiescent (no design actions emitted) terminal
// path. Opens its own transaction via the public `transitionInboxEvent` helper
// so the inbox lifecycle advances even when no design action ran. A missing
// intake block (non-intake run) is a no-op; an already-done event (replay or
// prior finalization) is treated as success.
//
// The after-approveDesign continuation task is the production delivery path
// for an accepted Linear intake proposal. A no-action result from this
// continuation must NOT terminalize intake — the proposal is already accepted
// and the only legitimate finalization is createRunsFromDesign creating the
// canonical planning run, planner task, and run-to-issue reference. Leaving
// the inbox running preserves the repair path so a later retry can deliver.
function finalizeQuiescentLinearIntake(
  harness: Harness,
  record: { run: Run; task: Task },
): { inboxEventId: string; linearIssueId: string } | null {
  const intake = readLinearIntakeProvenance(record.run.context);
  if (!intake) {
    return null;
  }
  const continuation = readAfterApproveDesignContinuation(record.task.config);
  if (continuation) {
    return null;
  }
  try {
    harness.transitionInboxEvent({
      id: intake.inboxEventId,
      from: "running",
      to: "done",
    });
  } catch (error) {
    const message = (error as Error).message;
    if (!/found done/.test(message)) {
      // Surface unexpected failures as a hook problem so the audit trail and
      // the dashboard expose the stuck intake row.
      throw error;
    }
  }
  return {
    inboxEventId: intake.inboxEventId,
    linearIssueId: intake.linearIssueId,
  };
}

// The canonical run-to-issue external reference ID is derived from the
// immutable Linear issue identity alone. Different proposals, action replays,
// and the legitimate after-approveDesign continuation all converge on the same
// row, so exactly one run-to-issue reference exists per immutable Linear
// issue. The pre-check in applyCreateRunsFromDesignWithDb guarantees the
// referenced planning run is also the canonical one.
function stableLinearExternalRefId(input: {
  provider: string;
  externalType: string;
  externalId: string;
}): string {
  const key = `${input.provider}|${input.externalType}|${input.externalId}`;
  return `ref_${sha1Hex(key)}`;
}

// Canonical planning-run and planner-task IDs for Linear intake are derived
// from the supervised root run and immutable Linear issue id. Different
// proposals, action replays, and the legitimate after-approveDesign
// continuation all converge on the same canonical IDs. The verifyExisting
// RunIntakeProvenance helper below defends against a collision that carries
// mismatched intake metadata.
function stableLinearIntakeChildRunId(rootRunId: string, linearIssueId: string): string {
  return `run_${sha1Hex(`linear-intake-child|${rootRunId}|${linearIssueId}`)}`;
}

function stableLinearIntakePlannerTaskId(rootRunId: string, linearIssueId: string): string {
  return `task_${sha1Hex(`linear-intake-planner|${rootRunId}|${linearIssueId}`)}`;
}

// Reads the `after-approveDesign` continuation metadata stamped onto a task
// config by recordAutomaticApprovalWithDb. Returns null when the task is not
// such a continuation. Used by the createRunsFromDesign ownership guard to
// accept the legitimate production delivery path while rejecting cross-run,
// cross-proposal, or forged continuations.
function readAfterApproveDesignContinuation(
  config: Record<string, unknown> | undefined,
): {
  kind: string;
  proposalId: string;
  sourceTaskId: string;
  actionIndex: number;
} | null {
  if (!config) {
    return null;
  }
  const raw = config.designContinuation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.kind !== "string" || rec.kind !== "after-approveDesign") {
    return null;
  }
  if (typeof rec.proposalId !== "string" || rec.proposalId.length === 0) {
    return null;
  }
  if (typeof rec.sourceTaskId !== "string" || rec.sourceTaskId.length === 0) {
    return null;
  }
  if (typeof rec.actionIndex !== "number" || !Number.isFinite(rec.actionIndex)) {
    return null;
  }
  return {
    kind: rec.kind,
    proposalId: rec.proposalId,
    sourceTaskId: rec.sourceTaskId,
    actionIndex: rec.actionIndex,
  };
}

// Records a `blocked` audit event for an action whose mutation never reached
// the database (validation/authorization failure, or a transaction that rolled
// back). The audit row is committed in its own transaction; if it fails, the
// caller surfaces the audit-write error rather than silently dropping the
// trail. This cannot diverge from a durable mutation because no mutation
// survived.
function recordBlockedActionEventWithOwnTransaction(
  harness: Harness,
  action: DesignActionInput,
  record: {
    run: Run;
    task: Task;
    actionIndex: number;
    error: string;
  },
) {
  harness.recordHarnessActionEvent({
    actionType: `design.${action.type}`,
    status: "blocked",
    request: {
      type: action.type,
      payload: action.payload,
      runId: record.run.id,
      taskId: record.task.id,
      actionIndex: record.actionIndex,
    },
    result: { error: record.error },
  });
}

function ensureDesignerContinuationTaskWithDb(
  harness: Harness,
  db: HarnessDatabase,
  input: {
    runId: string;
    sourceTaskId: string;
    actionIndex: number;
    kind: string;
    entityId: string;
    role: string;
    goal: string;
    prompt: string;
    doneWhen: string[];
    config: Record<string, unknown>;
    dependsOn: string[];
  },
): string {
  const taskId = stableContinuationTaskId(input.runId, input.sourceTaskId, input.actionIndex, input.kind, input.entityId);
  const existing = harness.getTask(taskId);
  if (existing) {
    return taskId;
  }
  harness.createTaskWithDb(db, {
    id: taskId,
    runId: input.runId,
    role: input.role,
    goal: input.goal,
    prompt: input.prompt,
    doneWhen: input.doneWhen,
    config: input.config,
    dependsOn: input.dependsOn,
  });
  return taskId;
}

function buildSignalContinuationPrompt(signal: { id: string; title: string; summary: string }): string {
  return [
    "Designer cycle continuation after recordSignal.",
    `The cycle recorded signal ${signal.id} (title: ${JSON.stringify(signal.title)}; summary: ${JSON.stringify(signal.summary)}).`,
    "Choose the next bounded step:",
    "  (a) proposeDesign anchored to this signal — its evidenceRefs MUST include this signal ID, OR",
    "  (b) emit no design actions and stop with a justified no-action result.",
    "Do not re-record the signal. Do not mutate strategy state directly.",
    `Durable signal ID: ${signal.id}`,
  ].join("\n");
}

function buildDeliveryContinuationPrompt(proposal: { id: string; title: string; recommendation: string }): string {
  return [
    "Designer delivery continuation after automatic approval.",
    `Proposal ${proposal.id} (${JSON.stringify(proposal.title)}) was approved automatically by the authority evaluator.`,
    "Emit exactly one createRunsFromDesign action against the stored proposal ID below.",
    "Do not amend, supersede, or re-propose the frozen envelope. Do not record additional signals or proposals in this continuation.",
    `Durable proposal ID: ${proposal.id}`,
  ].join("\n");
}

function requireContractEvidence(contract: Record<string, unknown>) {
  const successMetrics = optionalStringArray(
    (contract as Record<string, unknown>).successMetrics,
    "proposeDesign payload.proposal.evaluationContract.successMetrics",
  );
  const requiredEvidence = optionalStringArray(
    (contract as Record<string, unknown>).requiredEvidence,
    "proposeDesign payload.proposal.evaluationContract.requiredEvidence",
  );
  if ((!successMetrics || successMetrics.length === 0) && (!requiredEvidence || requiredEvidence.length === 0)) {
    throw new Error(
      "proposeDesign payload.proposal.evaluationContract must define successMetrics or requiredEvidence",
    );
  }
}

function validateInvestment(investment: Record<string, unknown>) {
  const reversibility = investment.reversibility;
  if (!["easy", "moderate", "hard"].includes(reversibility as string)) {
    throw new Error("proposeDesign payload.proposal.investment.reversibility must be easy, moderate, or hard");
  }
  const portfolio = investment.portfolio;
  if (!["core", "growth", "exploration"].includes(portfolio as string)) {
    throw new Error("proposeDesign payload.proposal.investment.portfolio must be core, growth, or exploration");
  }
  for (const key of ["oneTimeCost", "recurringCost"] as const) {
    const value = investment[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`proposeDesign payload.proposal.investment.${key} must be a non-negative finite number`);
    }
  }
  if (investment.timeBudget !== undefined && investment.timeBudget !== null) {
    if (typeof investment.timeBudget !== "string" || (investment.timeBudget as string).length === 0) {
      throw new Error("proposeDesign payload.proposal.investment.timeBudget must be a non-empty string");
    }
  }
}

function readEvidenceRefs(proposal: DesignProposal): string[] {
  const refs = proposal.proposal.evidenceRefs ?? [];
  if (!Array.isArray(refs)) {
    return [];
  }
  return refs.filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
}

interface ProposalEvidence {
  references: AuthorityEvidenceReference[];
  // Same-project resolved signals keyed by id, used only to compose the
  // free-form risk-keyword text. Cross-project and missing citations are
  // intentionally excluded — their text cannot shape this proposal's risk.
  signals: Map<string, StrategySignal>;
  // Adapter-level findings used to make the human-checkpoint audit trail
  // explicit. The evaluator already fails closed on each of these via its
  // hard rules (missing-evidence / invalid-conflict-metadata); these lists
  // add a concise summary to the recorded checkpoint reasons.
  crossProjectRefs: string[];
  malformedConflictMetadataRefs: string[];
}

// The evaluator's invalid-conflict-metadata hard rule fires whenever an
// evidence reference's `hasConflict` field is not a strict boolean
// (packages/harness/src/design-authority.ts). The production evidence
// adapter uses this non-boolean sentinel — cast at the single boundary
// where untyped stored JSON meets the typed evaluator — to mark evidence
// whose stored conflict metadata is corrupt, so the canonical audit list
// populates and the proposal routes to human review instead of being
// silently coerced to a clean boolean.
const CONFLICT_METADATA_INVALID = "invalid-conflict-metadata";

function resolveProposalEvidence(
  harness: Harness,
  db: HarnessDatabase,
  projectId: string,
  evidenceRefs: string[],
  now: number,
): ProposalEvidence {
  const references: AuthorityEvidenceReference[] = [];
  const signals = new Map<string, StrategySignal>();
  const crossProjectRefs: string[] = [];
  const malformedConflictMetadataRefs: string[] = [];

  // Load same-project peers once for reverse-conflict detection. Only signals
  // in the proposal's own project can legitimately conflict with the cited
  // evidence; a signal from another project is not authority for this proposal.
  const sameProjectPeers = projectId.length > 0
    ? harness.listStrategySignalsWithDb(db, { projectId, limit: 500 })
    : [];

  for (const ref of evidenceRefs) {
    const signal = harness.getStrategySignalWithDb(db, { id: ref });
    if (!signal) {
      // Missing evidence: omit. The evaluator treats any cited ref absent from
      // the evidence array as missing — a hard fail-closed path. A synthetic
      // record here would mask the missing-data signal.
      continue;
    }
    if (projectId.length > 0 && signal.projectId !== projectId) {
      // Cross-project evidence is not authority for this proposal. Omit it so
      // the evaluator classifies the citation as missing/unresolvable rather
      // than authorizing work against another project's signal.
      crossProjectRefs.push(ref);
      continue;
    }
    signals.set(ref, signal);
    const expiresAt = computeEvidenceExpiry(signal, now);
    if (!isCleanStringArray(signal.conflictingSignalIds)) {
      // Corrupt conflict metadata cannot be coerced into a trustworthy boolean.
      // Surface the malformation to the evaluator's invalid-conflict-metadata
      // hard rule via the non-boolean sentinel so the canonical audit list
      // populates and the proposal cannot be auto-approved.
      malformedConflictMetadataRefs.push(ref);
      references.push({
        ref,
        kind: "signal",
        expiresAt,
        hasConflict: CONFLICT_METADATA_INVALID as unknown as boolean,
      });
      continue;
    }
    // Reverse conflict: a same-project peer with clean metadata names this ref.
    const reverseConflict = sameProjectPeers.some(
      (peer) =>
        peer.id !== signal.id &&
        isCleanStringArray(peer.conflictingSignalIds) &&
        (peer.conflictingSignalIds as string[]).includes(ref),
    );
    references.push({
      ref,
      kind: "signal",
      expiresAt,
      hasConflict: signal.conflictingSignalIds.length > 0 || reverseConflict,
    });
  }
  return { references, signals, crossProjectRefs, malformedConflictMetadataRefs };
}

function isCleanStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function computeEvidenceExpiry(signal: StrategySignal, now: number): string | null {
  // Stale status cannot authorize investment. A non-active signal is treated
  // as expired regardless of the expiresAt field, by pinning the expiry to a
  // strict ISO timestamp that is already in the past.
  const statusExpired = signal.status !== "active";
  const declaredExpiry = signal.expiresAt;
  const parsedDeclared = declaredExpiry === null || declaredExpiry === undefined
    ? null
    : Date.parse(declaredExpiry);
  const declaredInPast = parsedDeclared !== null && Number.isFinite(parsedDeclared) && parsedDeclared <= now;
  if (statusExpired || declaredInPast) {
    return strictIsoInPast();
  }
  // A non-ISO or unparseable expiry is forwarded unchanged so the evaluator's
  // invalid-evidence-expiry hard rule fails closed on it.
  return declaredExpiry ?? null;
}

function strictIsoInPast(): string {
  // A strict ISO 8601 timestamp that is safely in the past for any reasonable
  // evaluation time. The evaluator treats expired evidence as a hard reject.
  return "1970-01-01T00:00:00.000Z";
}

function describeEvidenceFindings(evidence: ProposalEvidence): string[] {
  const findings: string[] = [];
  if (evidence.crossProjectRefs.length > 0) {
    findings.push(
      `cross-project evidence cited: ${evidence.crossProjectRefs.join(", ")}; only signals in the proposal's own project can authorize work`,
    );
  }
  if (evidence.malformedConflictMetadataRefs.length > 0) {
    findings.push(
      `malformed conflict metadata on evidence: ${evidence.malformedConflictMetadataRefs.join(", ")}; corrupt conflictingSignalIds cannot be trusted and route to human review`,
    );
  }
  return findings;
}

function buildCharterContext(charter: FounderCharter): AuthorityCharterContext {
  return {
    id: charter.id,
    version: charter.version,
    isActive: charter.isActive === true,
    mission: charter.mission,
    capitalPolicy: charter.charter.capitalPolicy,
    authority: charter.charter.authority,
  };
}

function computePortfolioUsageWithDb(
  harness: Harness,
  db: HarnessDatabase,
  proposal: DesignProposal,
  category: AuthorityPortfolioUsage["category"],
): AuthorityPortfolioUsage {
  const projectId = proposal.projectId ?? "";
  if (projectId.length === 0) {
    return { category, currentShare: null };
  }
  const all = harness.listDesignProposalsWithDb(db, { projectId, limit: 200 });
  let count = 0;
  for (const other of all) {
    if (other.id === proposal.id) continue;
    const otherInvestment = other.proposal.investment as { portfolio?: unknown } | undefined;
    if (otherInvestment && otherInvestment.portfolio === category) {
      count += 1;
    }
  }
  return { category, currentShare: count };
}

interface DerivedRiskSurface {
  riskSurface: AuthorityProposalRiskSurface;
  derivationReasons: string[];
}

function deriveDeclaredHumanCategories(raw: unknown): string[] {
  // An omitted or null field is valid: the production Designer prompt does not
  // require an explicit riskSurface, and a low-risk envelope legitimately
  // declares no human-only categories.
  if (raw === undefined || raw === null) {
    return [];
  }
  // A clean string array is passed through unchanged.
  if (isCleanStringArray(raw)) {
    return raw;
  }
  // A malformed declaration (non-array, or an array with non-string entries)
  // is forwarded to the evaluator unchanged. The cast is localized to this
  // untyped-proposal-JSON -> typed-risk-surface boundary; the evaluator's
  // collectRequireHumanReasons explicitly defends against non-array and
  // non-string entries, failing closed with an auditable unknown-risk-data
  // reason. Normalizing to [] here would silently authorize whenever the
  // charter requires no categories.
  return raw as string[];
}

function deriveConservativeRiskSurface(
  proposal: DesignProposal,
  signalsById: Map<string, StrategySignal>,
): DerivedRiskSurface {
  const derivationReasons: string[] = [];
  const proposalEnvelope = proposal.proposal as Record<string, unknown>;
  const investment = (proposalEnvelope.investment ?? {}) as Record<string, unknown>;
  const reversibilityRaw = investment.reversibility;
  const portfolioRaw = investment.portfolio;
  const oneTimeCostRaw = investment.oneTimeCost;
  const recurringCostRaw = investment.recurringCost;
  const evidenceRefs = readEvidenceRefs(proposal);
  const declared = (proposalEnvelope.riskSurface ?? {}) as Record<string, unknown>;

  const reversibility = reversibilityRaw === "easy" || reversibilityRaw === "moderate" || reversibilityRaw === "hard"
    ? reversibilityRaw
    : "hard";
  if (reversibilityRaw !== "easy" && reversibilityRaw !== "moderate" && reversibilityRaw !== "hard") {
    derivationReasons.push(`investment.reversibility ${JSON.stringify(reversibilityRaw)} is not easy/moderate/hard; defaulting to hard`);
  }
  const portfolio = portfolioRaw === "core" || portfolioRaw === "growth" || portfolioRaw === "exploration"
    ? portfolioRaw
    : "exploration";
  if (portfolioRaw !== "core" && portfolioRaw !== "growth" && portfolioRaw !== "exploration") {
    derivationReasons.push(`investment.portfolio ${JSON.stringify(portfolioRaw)} is not core/growth/exploration; defaulting to exploration`);
  }

  const oneTimeCost = typeof oneTimeCostRaw === "number" && Number.isFinite(oneTimeCostRaw) && oneTimeCostRaw >= 0
    ? oneTimeCostRaw
    : Number.NaN;
  const recurringCost = typeof recurringCostRaw === "number" && Number.isFinite(recurringCostRaw) && recurringCostRaw >= 0
    ? recurringCostRaw
    : Number.NaN;
  if (!Number.isFinite(oneTimeCost)) {
    derivationReasons.push(`investment.oneTimeCost ${JSON.stringify(oneTimeCostRaw)} is not a finite non-negative number; treating as invalid`);
  }
  if (!Number.isFinite(recurringCost)) {
    derivationReasons.push(`investment.recurringCost ${JSON.stringify(recurringCostRaw)} is not a finite non-negative number; treating as invalid`);
  }

  // Compose text used for conservative keyword matching. Any keyword hit
  // forces the corresponding flag to `true` regardless of declaration.
  const evidenceText = evidenceRefs
    .map((ref) => signalsById.get(ref))
    .filter((signal): signal is StrategySignal => Boolean(signal))
    .map((signal) => `${signal.title}\n${signal.summary}`)
    .join("\n");
  const optionRisks = Array.isArray(proposalEnvelope.options)
    ? (proposalEnvelope.options as Array<Record<string, unknown>>)
        .filter((option) => option && typeof option === "object")
        .flatMap((option) => (Array.isArray(option.risks) ? option.risks : []))
        .map((value) => String(value))
        .join("\n")
    : "";
  const combinedText = `${proposal.title}\n${proposal.problem}\n${proposal.recommendation}\n${evidenceText}\n${optionRisks}`;

  // Flags default to `false` (low-risk). A flag is forced to `true` only when
  // (a) the proposal declares it `true`, (b) the declaration is a non-boolean
  // value that cannot be trusted, or (c) the proposal or evidence text matches
  // a domain-specific risk keyword. The keyword matcher is the durable safety
  // net that catches risk vocabulary even when the production Designer prompt
  // (which does not require an explicit riskSurface field) omits the flag.
  const flags: Record<RiskFlagField, boolean> = {
    amendsMission: false,
    amendsCapitalPolicy: false,
    legalOrPrivacy: false,
    sensitiveData: false,
    destructiveOperation: false,
    productionDeployment: false,
    unplannedDependency: false,
    schemaMigration: false,
    recurringInfrastructure: false,
  };

  for (const field of RISK_FLAG_FIELDS) {
    const keywordMatched = RISK_KEYWORDS[field].some((pattern) => pattern.test(combinedText));
    const declaredValue = declared[field];
    if (declaredValue === undefined) {
      // No declaration: rely on the keyword matcher. A keyword hit forces the
      // flag to `true`; otherwise the flag stays `false` because the production
      // Designer prompt does not require this field.
      if (keywordMatched) {
        flags[field] = true;
        derivationReasons.push(`risk flag ${field} forced true; keyword matched in evidence/text with no explicit declaration`);
      }
      continue;
    }
    if (declaredValue === true) {
      flags[field] = true;
      continue;
    }
    if (declaredValue === false) {
      if (keywordMatched) {
        flags[field] = true;
        derivationReasons.push(`risk flag ${field} declared false but keyword matched in evidence/text; forced true`);
      } else {
        flags[field] = false;
      }
      continue;
    }
    // Non-boolean declarations cannot be trusted and must fail closed.
    flags[field] = true;
    derivationReasons.push(`risk flag ${field} declared ${JSON.stringify(declaredValue)} is not a strict boolean; forced true`);
  }

  // declaredHumanCategories is validated strictly, never normalized away. A
  // clean string array (or an omitted/null field, which is valid for a
  // genuinely low-risk production envelope) is passed through as-is. A
  // malformed declaration (a non-array, or an array containing non-strings)
  // is forwarded unchanged so the evaluator's collectRequireHumanReasons
  // fails closed with an auditable unknown-risk-data reason — coercing it to
  // [] would silently authorize whenever the charter requires no categories.
  const declaredHumanCategories = deriveDeclaredHumanCategories(declared.declaredHumanCategories);

  const riskSurface: AuthorityProposalRiskSurface = {
    proposalId: proposal.id,
    reversibility,
    portfolio,
    oneTimeCost: Number.isFinite(oneTimeCost) ? oneTimeCost : Number.NaN,
    recurringCost: Number.isFinite(recurringCost) ? recurringCost : Number.NaN,
    evidenceRefs,
    amendsMission: flags.amendsMission,
    amendsCapitalPolicy: flags.amendsCapitalPolicy,
    legalOrPrivacy: flags.legalOrPrivacy,
    sensitiveData: flags.sensitiveData,
    destructiveOperation: flags.destructiveOperation,
    productionDeployment: flags.productionDeployment,
    unplannedDependency: flags.unplannedDependency,
    schemaMigration: flags.schemaMigration,
    recurringInfrastructure: flags.recurringInfrastructure,
    declaredHumanCategories,
  };

  return { riskSurface, derivationReasons };
}

function humanRequiredEvaluationWithoutCharter(proposal: DesignProposal, now: number): AuthorityEvaluation {
  // Build a conservative synthetic evaluation that fails closed when no
  // active charter exists. The proposal cannot receive automatic authority
  // without an active charter to grant it.
  const evaluatedAt = strictEvaluationTime(now);
  return {
    disposition: "human-required",
    reasons: [
      {
        kind: "charter-inactive",
        message: "No active founder charter is pinned to the proposal project; authority cannot be granted.",
      },
    ],
    charterId: "",
    charterVersion: 0,
    proposalId: proposal.id,
    evaluatedAt,
    evidence: {
      referenced: [],
      expired: [],
      conflicting: [],
      invalidExpiry: [],
      invalidConflictMetadata: [],
      missing: [],
      malformedItems: 0,
      evaluatedAtValid: true,
    },
    budget: {
      currency: null,
      oneTimeCost: 0,
      recurringCost: 0,
      experimentBudget: null,
      recurringThreshold: null,
      withinExperimentBudget: false,
      withinRecurringThreshold: false,
    },
    portfolio: {
      category: "core",
      configuredShare: null,
      currentShare: null,
      proposedShare: null,
      withinShare: false,
    },
    reversibility: "hard",
    actor: { kind: "auto", ref: null, isProposer: false },
  };
}

function strictEvaluationTime(now: number): string {
  return new Date(now).toISOString();
}

function reconstructActionResultFromAudit(
  action: DesignActionInput,
  result: Record<string, unknown>,
): ApplyActionResult {
  // Replay: return artifacts/checks/createdRuns matching the original
  // completion. We do not re-execute any mutation.
  void action;
  const artifacts: AppliedDesignAction[] = [];
  const createdRuns: Array<{ runId: string; plannerTaskId: string; proposalId: string }> = [];
  const checks: unknown[] = [
    { name: "design action replay", status: "passed", evidence: "idempotent reuse of prior audit row" },
  ];
  if (typeof result.signalId === "string") {
    artifacts.push({ kind: "design_signal", signalId: result.signalId });
  }
  if (typeof result.continuationTaskId === "string") {
    artifacts.push({ kind: "design_continuation", taskId: result.continuationTaskId });
  }
  if (typeof result.proposalId === "string") {
    artifacts.push({ kind: "design_proposal", proposalId: result.proposalId });
    if (typeof result.authorityDecisionId === "string") {
      artifacts.push({
        kind: "design_decision",
        proposalId: result.proposalId,
        decisionId: result.authorityDecisionId,
        disposition: typeof result.authorityDisposition === "string" ? result.authorityDisposition : undefined,
      });
    }
    if (typeof result.checkpointDecisionId === "string") {
      artifacts.push({
        kind: "design_authority_checkpoint",
        proposalId: result.proposalId,
        checkpointDecisionId: result.checkpointDecisionId,
        disposition: typeof result.authorityDisposition === "string" ? result.authorityDisposition : undefined,
      });
    }
  }
  if (typeof result.decisionId === "string" && typeof result.proposalId === "string") {
    artifacts.push({ kind: "design_decision", proposalId: result.proposalId, decisionId: result.decisionId });
  }
  if (typeof result.outcomeId === "string" && typeof result.proposalId === "string") {
    artifacts.push({ kind: "design_outcome", proposalId: result.proposalId, outcomeId: result.outcomeId });
  }
  if (Array.isArray(result.runs)) {
    for (const entry of result.runs as Array<Record<string, unknown>>) {
      const runId = typeof entry.runId === "string" ? entry.runId : "";
      const plannerTaskId = typeof entry.plannerTaskId === "string" ? entry.plannerTaskId : "";
      const proposalId = typeof result.proposalId === "string" ? result.proposalId : "";
      if (runId && plannerTaskId && proposalId) {
        createdRuns.push({ runId, plannerTaskId, proposalId });
      }
    }
  }
  if (result.intake && typeof result.intake === "object") {
    const intake = result.intake as Record<string, unknown>;
    const inboxEventId = typeof intake.inboxEventId === "string" ? intake.inboxEventId : "";
    const externalRefId = typeof intake.externalRefId === "string" ? intake.externalRefId : "";
    const proposalId = typeof result.proposalId === "string" ? result.proposalId : "";
    const decisionId = typeof result.decisionId === "string" ? result.decisionId : "";
    if (inboxEventId && externalRefId && proposalId) {
      artifacts.push({
        kind: "design_intake_finalized",
        proposalId,
        decisionId: decisionId || undefined,
        intakeEventId: inboxEventId,
        externalRefId,
      });
    }
  }
  return {
    artifacts,
    checks,
    createdRuns,
    eventResult: result,
  };
}

function stableActionAuditId(runId: string, taskId: string, actionIndex: number, action: DesignActionInput): string {
  const entityRef = action.type === "decideDesign" || action.type === "recordDesignOutcome" || action.type === "createRunsFromDesign"
    ? String((action.payload as { proposalId?: unknown }).proposalId ?? "")
    : "";
  const key = `${action.type}|${runId}|${taskId}|${actionIndex}|${entityRef}`;
  return `action_${sha1Hex(key)}`;
}

function stableContinuationTaskId(
  runId: string,
  taskId: string,
  actionIndex: number,
  kind: string,
  entityId: string,
): string {
  return `task_${sha1Hex(`continuation|${runId}|${taskId}|${actionIndex}|${kind}|${entityId}`)}`;
}

function stableDecisionId(runId: string, taskId: string, actionIndex: number, proposalId: string): string {
  return `decision_${sha1Hex(`authority-approved|${runId}|${taskId}|${actionIndex}|${proposalId}`)}`;
}

function stableCheckpointId(runId: string, taskId: string, actionIndex: number, proposalId: string): string {
  return `decision_${sha1Hex(`authority-checkpoint|${runId}|${taskId}|${actionIndex}|${proposalId}`)}`;
}

function stableDecideDesignId(runId: string, taskId: string, actionIndex: number, proposalId: string): string {
  return `decision_${sha1Hex(`designer-decide|${runId}|${taskId}|${actionIndex}|${proposalId}`)}`;
}

function stableOutcomeId(runId: string, taskId: string, actionIndex: number, proposalId: string): string {
  return `outcome_${sha1Hex(`designer-outcome|${runId}|${taskId}|${actionIndex}|${proposalId}`)}`;
}

function stableAdverseSignalId(runId: string, taskId: string, actionIndex: number, proposalId: string): string {
  return `signal_${sha1Hex(`adverse-outcome|${runId}|${taskId}|${actionIndex}|${proposalId}`)}`;
}

function stableChildRunId(
  runId: string,
  taskId: string,
  actionIndex: number,
  proposalId: string,
  runIndex: number,
): string {
  return `run_${sha1Hex(`design-child|${runId}|${taskId}|${actionIndex}|${proposalId}|${runIndex}`)}`;
}

function stablePlannerTaskId(
  runId: string,
  taskId: string,
  actionIndex: number,
  proposalId: string,
  runIndex: number,
): string {
  return `task_${sha1Hex(`design-planner|${runId}|${taskId}|${actionIndex}|${proposalId}|${runIndex}`)}`;
}

function sha1Hex(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex");
}

function requiredProjectId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("design action payload.projectId must be a non-empty string");
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`${label}[${index}] must be a string`);
    }
    return item;
  });
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function optionalArray(value: unknown, label: string): unknown[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return [...value];
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return { ...(value as Record<string, unknown>) };
}

function optionalIsoTimestamp(value: unknown, label: string): string | null | undefined {
  return optionalStrictIsoTimestamp(value, label);
}

function adverseSignalSummary(
  proposal: { id: string; title: string; problem: string; recommendation: string },
  recommendation: "revise" | "retire",
  unexpectedEffects: unknown,
): string {
  const effects = Array.isArray(unexpectedEffects) ? unexpectedEffects : [];
  const effectText = effects.length > 0
    ? ` Unexpected effects: ${effects.map((effect) => String(effect)).join("; ")}.`
    : "";
  return `Outcome reviewer recommends ${recommendation} for proposal ${proposal.id} ("${proposal.title}"). The post-integration evidence did not satisfy the frozen evaluation contract.${effectText}`;
}
