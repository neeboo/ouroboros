import {
  type AttemptOutput,
  type DesignActionInput,
  type Harness,
  type HarnessDatabase,
  type Run,
  type Task,
} from "@ouroboros/harness";
import { optionalStrictIsoTimestamp } from "@ouroboros/harness";
import type { StopHook, StopHookResult } from "../types";

export interface ApplyDesignActionsHookOptions {
  harness: Harness;
}

export interface AppliedDesignAction {
  kind:
    | "design_signal"
    | "design_proposal"
    | "design_decision"
    | "design_outcome";
  signalId?: string;
  proposalId?: string;
  decisionId?: string;
  outcomeId?: string;
}

const NOW_EPOCH = () => Date.now();

export function createApplyDesignActionsHook(options: ApplyDesignActionsHookOptions): StopHook {
  return ({ run, task, output }: { run: Run; task: Task; output: AttemptOutput }): StopHookResult => {
    if (output.status !== "done") {
      return { decision: "exit" };
    }
    const actions = output.designActions ?? [];
    if (actions.length === 0) {
      return { decision: "exit" };
    }

    const artifacts: unknown[] = [];
    const problems: string[] = [];
    const checks: unknown[] = [];
    const createdRuns: Array<{ runId: string; plannerTaskId: string; proposalId: string }> = [];
    let nextDecision: StopHookResult["decision"] = "exit";

    for (const action of actions) {
      try {
        const result = applyActionAtomically(options.harness, action, { run, task, now: NOW_EPOCH() });
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
    }

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

// Each design action is committed together with its `done` audit row inside a
// single transaction. A failure on either side rolls back the entire action,
// so a successful audit-write can never diverge from a durable mutation.
function applyActionAtomically(
  harness: Harness,
  action: DesignActionInput,
  context: { run: Run; task: Task; now: number },
): ApplyActionResult {
  return harness.runInTransaction((db) => {
    const result = applyActionWithDb(harness, db, action, context);
    harness.recordHarnessActionEventWithDb(db, {
      actionType: `design.${action.type}`,
      status: "done",
      request: {
        type: action.type,
        payload: action.payload,
        runId: context.run.id,
        taskId: context.task.id,
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
  context: { run: Run; task: Task; now: number },
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
  context: { run: Run; task: Task; now: number },
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
  return {
    artifacts: [{ kind: "design_signal", signalId: signal.id }],
    checks: [
      { name: "design signal recorded", status: "passed", evidence: signal.id },
    ],
    createdRuns: [],
    eventResult: { signalId: signal.id },
  };
}

function applyProposeDesignWithDb(
  harness: Harness,
  db: HarnessDatabase,
  action: Extract<DesignActionInput, { type: "proposeDesign" }>,
  context: { run: Run; task: Task; now: number },
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
  return {
    artifacts: [{ kind: "design_proposal", proposalId: proposal.id }],
    checks: [
      { name: "design proposal recorded", status: "passed", evidence: proposal.id },
      { name: "design proposal status", status: "passed", evidence: proposal.status },
    ],
    createdRuns: [],
    eventResult: { proposalId: proposal.id, status: proposal.status },
  };
}

function applyDecideDesignWithDb(
  harness: Harness,
  db: HarnessDatabase,
  action: Extract<DesignActionInput, { type: "decideDesign" }>,
  context: { run: Run; task: Task; now: number },
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

  const recorded = harness.recordDesignDecisionWithDb(db, {
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

  return {
    artifacts: [{ kind: "design_decision", proposalId, decisionId: recorded.id }],
    checks: [
      { name: "design decision recorded", status: "passed", evidence: recorded.id },
      { name: "design proposal status", status: "passed", evidence: nextStatus },
    ],
    createdRuns: [],
    eventResult: { decisionId: recorded.id, decision, nextStatus },
  };
}

function applyRecordDesignOutcomeWithDb(
  harness: Harness,
  db: HarnessDatabase,
  action: Extract<DesignActionInput, { type: "recordDesignOutcome" }>,
  context: { run: Run; task: Task; now: number },
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

  const outcome = harness.recordDesignOutcomeWithDb(db, {
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
    const signal = harness.createStrategySignalWithDb(db, {
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
  context: { run: Run; task: Task; now: number },
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

  const runs = Array.isArray(payload.runs) ? payload.runs : [];
  if (runs.length === 0) {
    throw new Error("createRunsFromDesign payload.runs must include at least one planned run");
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
    charterId: approval.charterId,
  };
  const createdRuns: Array<{ runId: string; plannerTaskId: string; proposalId: string }> = [];
  for (const plannedRun of runs) {
    const childRunId = harness.createRunWithDb(db, {
      goal: plannedRun.goal,
      context: {
        ...(plannedRun.context ?? {}),
        ...inheritedControlContext(context.run.context),
        parentRunId: context.run.id,
        sourceTaskId: context.task.id,
        source: "design",
        designProposalId: proposal.id,
        designCharterId: proposal.charterId,
        designDecisionId: approval.id,
        designEvaluationContract: frozenContract,
        designProposal: frozenProposal,
        designInvestment: frozenInvestment,
        designAdditions: frozenAdditions,
        designRemovals: frozenRemovals,
        designApprovalAuthority: approvalAuthority,
      },
    });
    const plannerTaskId = harness.createTaskWithDb(db, {
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
    createdRuns.push({ runId: childRunId, plannerTaskId, proposalId: proposal.id });
  }

  return {
    artifacts: createdRuns.map((created) => ({ kind: "design_proposal" as const, proposalId: created.proposalId })),
    checks: [
      { name: "design proposal accepted", status: "passed", evidence: proposal.id },
      { name: "design decision approved", status: "passed", evidence: approval.id },
      { name: "design child runs created", status: "passed", evidence: String(createdRuns.length) },
    ],
    createdRuns,
    eventResult: {
      proposalId: proposal.id,
      decisionId: approval.id,
      runs: createdRuns.map(({ runId, plannerTaskId }) => ({ runId, plannerTaskId })),
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
    },
    result: { error: record.error },
  });
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
