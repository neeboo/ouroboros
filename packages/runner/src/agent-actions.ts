import {
  optionalStrictIsoTimestamp,
  requireStrictIsoTimestamp,
} from "@ouroboros/harness";
import type {
  AttemptOutput,
  DesignDecisionActorKind,
  DesignDecisionKind,
  DesignOutcomeRecommendation,
  DesignOutcomeStage,
  DesignProposalData,
  PlannedRun,
  PlannedTask,
  StrategySignalClass,
} from "@ouroboros/harness";

export type AgentAction =
  | CreateTasksAction
  | CreateRunsAction
  | SetRunDecisionAction
  | RecordSignalAction
  | ProposeDesignAction
  | DecideDesignAction
  | RecordDesignOutcomeAction
  | CreateRunsFromDesignAction;

export interface CreateTasksAction {
  type: "createTasks";
  payload: {
    tasks: PlannedTask[];
  };
}

export interface CreateRunsAction {
  type: "createRuns";
  payload: {
    runs: PlannedRun[];
  };
}

export interface SetRunDecisionAction {
  type: "setRunDecision";
  payload: {
    decision: NonNullable<AttemptOutput["runDecision"]>;
  };
}

export interface RecordSignalAction {
  type: "recordSignal";
  payload: {
    projectId: string;
    signalClass: StrategySignalClass;
    source: string;
    title: string;
    summary: string;
    observationTime: string;
    confidence: number;
    evidence?: unknown[];
    expiresAt?: string | null;
    conflictingSignalIds?: string[];
    proposalId?: string | null;
    payload?: Record<string, unknown>;
  };
}

export interface ProposeDesignAction {
  type: "proposeDesign";
  payload: {
    projectId: string;
    title: string;
    proposal: DesignProposalData;
    charterId?: string | null;
    status?: "draft" | "proposed" | "experimenting";
  };
}

export interface DecideDesignAction {
  type: "decideDesign";
  payload: {
    proposalId: string;
    decision: DesignDecisionKind;
    actorKind?: DesignDecisionActorKind;
    actorRef?: string | null;
    charterId?: string | null;
    reasons?: string[];
    authority?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  };
}

export interface RecordDesignOutcomeAction {
  type: "recordDesignOutcome";
  payload: {
    proposalId: string;
    stage: DesignOutcomeStage;
    recommendation: DesignOutcomeRecommendation;
    baseline?: Record<string, unknown>;
    observed?: Record<string, unknown>;
    evidence?: unknown[];
    unexpectedEffects?: unknown[];
    reviewAt?: string | null;
    payload?: Record<string, unknown>;
  };
}

export interface CreateRunsFromDesignAction {
  type: "createRunsFromDesign";
  payload: {
    proposalId: string;
    runs: PlannedRun[];
  };
}

export interface AgentOutputInput {
  summary: string;
  changedFiles?: string[];
  checks?: unknown[];
  artifacts?: unknown[];
  problems?: string[];
  actions?: AgentAction[];
}

export type AgentOutput = Omit<AttemptOutput, "nextTasks" | "nextRuns" | "runDecision"> & {
  actions?: AgentAction[];
};

const DESIGN_PROPOSAL_STATUSES = new Set(["draft", "proposed", "experimenting"]);
const STRATEGY_SIGNAL_CLASSES = new Set([
  "user",
  "delivery",
  "technology",
  "market",
  "economics",
  "system",
]);
const DESIGN_DECISION_KINDS = new Set(["approved", "rejected", "deferred", "retired", "revise"]);
const DESIGN_DECISION_ACTOR_KINDS = new Set(["auto", "human", "governance"]);
const DESIGNER_DECISION_KINDS = new Set(["rejected", "deferred", "retired", "revise"]);
const DESIGN_OUTCOME_STAGES = new Set(["experiment", "release", "review"]);
const DESIGN_OUTCOME_RECOMMENDATIONS = new Set(["retain", "revise", "retire"]);
const DESIGN_INVESTMENT_REVERSIBILITY = new Set(["easy", "moderate", "hard"]);
const DESIGN_INVESTMENT_PORTFOLIO = new Set(["core", "growth", "exploration"]);

export function createTasksAction(tasks: PlannedTask[]): CreateTasksAction {
  requireArray(tasks, "createTasksAction tasks");
  return { type: "createTasks", payload: { tasks } };
}

export function createRunsAction(runs: PlannedRun[]): CreateRunsAction {
  requireArray(runs, "createRunsAction runs");
  return { type: "createRuns", payload: { runs } };
}

export function setRunDecisionAction(decision: NonNullable<AttemptOutput["runDecision"]>): SetRunDecisionAction {
  if (decision !== "complete" && decision !== "continue" && decision !== "verify" && decision !== "defer") {
    throw new Error("setRunDecisionAction decision must be complete, continue, verify, or defer");
  }
  return { type: "setRunDecision", payload: { decision } };
}

export function recordSignalAction(payload: RecordSignalAction["payload"]): RecordSignalAction {
  return { type: "recordSignal", payload: parseRecordSignalPayload(payload) };
}

export function proposeDesignAction(payload: ProposeDesignAction["payload"]): ProposeDesignAction {
  return { type: "proposeDesign", payload: parseProposeDesignPayload(payload) };
}

export function decideDesignAction(payload: DecideDesignAction["payload"]): DecideDesignAction {
  return { type: "decideDesign", payload: parseDecideDesignPayload(payload) };
}

export function recordDesignOutcomeAction(payload: RecordDesignOutcomeAction["payload"]): RecordDesignOutcomeAction {
  return { type: "recordDesignOutcome", payload: parseRecordDesignOutcomePayload(payload) };
}

export function createRunsFromDesignAction(payload: CreateRunsFromDesignAction["payload"]): CreateRunsFromDesignAction {
  if (!payload || typeof payload !== "object") {
    throw new Error("createRunsFromDesignAction payload must be an object");
  }
  requireNonEmptyString(payload.proposalId, "createRunsFromDesignAction payload.proposalId");
  requireArray(payload.runs, "createRunsFromDesignAction payload.runs");
  return { type: "createRunsFromDesign", payload: { proposalId: payload.proposalId, runs: payload.runs } };
}

export function doneOutput(input: AgentOutputInput): AgentOutput {
  return agentOutput("done", input);
}

export function blockedOutput(input: AgentOutputInput): AgentOutput {
  return agentOutput("blocked", input);
}

function agentOutput(status: AttemptOutput["status"], input: AgentOutputInput): AgentOutput {
  if (typeof input.summary !== "string" || input.summary.trim().length === 0) {
    throw new Error("agent output summary must be a non-empty string");
  }
  if (input.actions !== undefined) {
    requireArray(input.actions, "agent output actions");
  }
  return {
    status,
    summary: input.summary,
    changedFiles: input.changedFiles ?? [],
    checks: input.checks ?? [],
    artifacts: input.artifacts ?? [],
    problems: input.problems ?? [],
    actions: input.actions,
  };
}

function requireArray(value: unknown, label: string) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
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

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`${label}[${index}] must be a non-empty string`);
    }
    return item;
  });
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function requireConfidence(value: unknown, label: string): number {
  const num = requireNumber(value, label);
  if (num < 0 || num > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return num;
}

function requireEnumValue<T extends string>(value: unknown, allowed: Set<string>, label: string): T {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`${label} must be one of ${[...allowed].join(", ")}`);
  }
  return value as T;
}

function optionalEnumValue<T extends string>(
  value: unknown,
  allowed: Set<string>,
  label: string,
): T | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requireEnumValue<T>(value, allowed, label);
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return { ...requireObject(value, label) };
}

function optionalJsonArray(value: unknown, label: string): unknown[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return [...value];
}

function optionalIsoTimestamp(value: unknown, label: string): string | null | undefined {
  return optionalStrictIsoTimestamp(value, label);
}

function requireIsoTimestamp(value: unknown, label: string): string {
  return requireStrictIsoTimestamp(value, label);
}

export function parseRecordSignalPayload(payload: unknown): RecordSignalAction["payload"] {
  const record = requireObject(payload, "recordSignal payload");
  return {
    projectId: requireNonEmptyString(record.projectId, "recordSignal payload.projectId"),
    signalClass: requireEnumValue<StrategySignalClass>(
      record.signalClass,
      STRATEGY_SIGNAL_CLASSES,
      "recordSignal payload.signalClass",
    ),
    source: requireNonEmptyString(record.source, "recordSignal payload.source"),
    title: requireNonEmptyString(record.title, "recordSignal payload.title"),
    summary: requireNonEmptyString(record.summary, "recordSignal payload.summary"),
    observationTime: requireIsoTimestamp(
      record.observationTime,
      "recordSignal payload.observationTime",
    ),
    confidence: requireConfidence(record.confidence, "recordSignal payload.confidence"),
    evidence: optionalJsonArray(record.evidence, "recordSignal payload.evidence"),
    expiresAt: optionalIsoTimestamp(record.expiresAt, "recordSignal payload.expiresAt"),
    conflictingSignalIds: optionalStringArray(
      record.conflictingSignalIds,
      "recordSignal payload.conflictingSignalIds",
    ),
    proposalId: optionalString(record.proposalId, "recordSignal payload.proposalId"),
    payload: optionalRecord(record.payload, "recordSignal payload.payload"),
  };
}

export function parseProposeDesignPayload(payload: unknown): ProposeDesignAction["payload"] {
  const record = requireObject(payload, "proposeDesign payload");
  const projectId = requireNonEmptyString(record.projectId, "proposeDesign payload.projectId");
  const title = requireNonEmptyString(record.title, "proposeDesign payload.title");
  const proposal = parseDesignProposalData(record.proposal, "proposeDesign payload.proposal");
  const status = optionalEnumValue<"draft" | "proposed" | "experimenting">(
    record.status,
    DESIGN_PROPOSAL_STATUSES,
    "proposeDesign payload.status",
  );
  const charterId = optionalString(record.charterId, "proposeDesign payload.charterId");
  return {
    projectId,
    title,
    proposal,
    status,
    charterId: charterId ?? null,
  };
}

function parseDesignProposalData(value: unknown, label: string): DesignProposalData {
  const record = requireObject(value, label);
  const problem = requireNonEmptyString(record.problem, `${label}.problem`);
  const recommendation = requireNonEmptyString(record.recommendation, `${label}.recommendation`);
  const evidenceRefs = requireStringArray(record.evidenceRefs, `${label}.evidenceRefs`);
  if (evidenceRefs.length === 0) {
    throw new Error(`${label}.evidenceRefs must include at least one referenced signal or observation`);
  }
  const options = parseDesignOptions(record.options, `${label}.options`);
  if (options === undefined) {
    throw new Error(`${label}.options must include at least one alternative`);
  }
  if (options.length === 0) {
    throw new Error(`${label}.options must include at least one alternative`);
  }
  const evaluationContract = parseDesignEvaluationContract(record.evaluationContract, `${label}.evaluationContract`);
  const investment = parseDesignInvestment(record.investment, `${label}.investment`);
  const experiment = record.experiment === undefined ? undefined : parseDesignExperiment(record.experiment, `${label}.experiment`);
  const additions = optionalStringArray(record.additions, `${label}.additions`);
  const removals = optionalStringArray(record.removals, `${label}.removals`);
  const targetOutcome = optionalString(record.targetOutcome, `${label}.targetOutcome`);
  const assumptions = optionalStringArray(record.assumptions, `${label}.assumptions`);
  const uncertainty = optionalStringArray(record.uncertainty, `${label}.uncertainty`);
  const data: DesignProposalData = {
    problem,
    recommendation,
    evidenceRefs,
    options,
    evaluationContract,
    investment,
  };
  if (experiment !== undefined) data.experiment = experiment;
  if (additions !== undefined) data.additions = additions;
  if (removals !== undefined) data.removals = removals;
  if (targetOutcome !== undefined) data.targetOutcome = targetOutcome;
  if (assumptions !== undefined) data.assumptions = assumptions;
  if (uncertainty !== undefined) data.uncertainty = uncertainty;
  return data;
}

function parseDesignOptions(value: unknown, label: string) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((option, index) => {
    const record = requireObject(option, `${label}[${index}]`);
    return {
      name: requireNonEmptyString(record.name, `${label}[${index}].name`),
      benefits: optionalStringArray(record.benefits, `${label}[${index}].benefits`),
      costs: optionalStringArray(record.costs, `${label}[${index}].costs`),
      risks: optionalStringArray(record.risks, `${label}[${index}].risks`),
      lockIn: optionalStringArray(record.lockIn, `${label}[${index}].lockIn`),
    };
  });
}

function parseDesignEvaluationContract(value: unknown, label: string) {
  const record = requireObject(value, label);
  const baseline = optionalStringArray(record.baseline, `${label}.baseline`);
  const successMetrics = optionalStringArray(record.successMetrics, `${label}.successMetrics`);
  const guardMetrics = optionalStringArray(record.guardMetrics, `${label}.guardMetrics`);
  const requiredEvidence = optionalStringArray(record.requiredEvidence, `${label}.requiredEvidence`);
  const reviewAtRaw = optionalIsoTimestamp(record.reviewAt, `${label}.reviewAt`);
  if ((!successMetrics || successMetrics.length === 0) && (!requiredEvidence || requiredEvidence.length === 0)) {
    throw new Error(`${label} must define successMetrics or requiredEvidence`);
  }
  const contract: {
    baseline: string[];
    successMetrics: string[];
    guardMetrics: string[];
    requiredEvidence: string[];
    reviewAt?: string;
  } = {
    baseline: baseline ?? [],
    successMetrics: successMetrics ?? [],
    guardMetrics: guardMetrics ?? [],
    requiredEvidence: requiredEvidence ?? [],
  };
  if (reviewAtRaw !== undefined && reviewAtRaw !== null) {
    contract.reviewAt = reviewAtRaw;
  }
  return contract;
}

function parseDesignInvestment(value: unknown, label: string) {
  const record = requireObject(value, label);
  const reversibility = requireEnumValue<"easy" | "moderate" | "hard">(
    record.reversibility,
    DESIGN_INVESTMENT_REVERSIBILITY,
    `${label}.reversibility`,
  );
  const portfolio = requireEnumValue<"core" | "growth" | "exploration">(
    record.portfolio,
    DESIGN_INVESTMENT_PORTFOLIO,
    `${label}.portfolio`,
  );
  const investment: DesignProposalData["investment"] = { reversibility, portfolio };
  if (record.oneTimeCost !== undefined && record.oneTimeCost !== null) {
    if (typeof record.oneTimeCost !== "number" || !Number.isFinite(record.oneTimeCost) || record.oneTimeCost < 0) {
      throw new Error(`${label}.oneTimeCost must be a non-negative finite number`);
    }
    investment.oneTimeCost = record.oneTimeCost;
  }
  if (record.recurringCost !== undefined && record.recurringCost !== null) {
    if (typeof record.recurringCost !== "number" || !Number.isFinite(record.recurringCost) || record.recurringCost < 0) {
      throw new Error(`${label}.recurringCost must be a non-negative finite number`);
    }
    investment.recurringCost = record.recurringCost;
  }
  if (record.timeBudget !== undefined && record.timeBudget !== null) {
    if (typeof record.timeBudget !== "string" || record.timeBudget.trim().length === 0) {
      throw new Error(`${label}.timeBudget must be a non-empty string`);
    }
    investment.timeBudget = record.timeBudget;
  }
  return investment;
}

function parseDesignExperiment(value: unknown, label: string) {
  const record = requireObject(value, label);
  return {
    hypothesis: requireNonEmptyString(record.hypothesis, `${label}.hypothesis`),
    smallestTest: requireNonEmptyString(record.smallestTest, `${label}.smallestTest`),
    stopConditions: optionalStringArray(record.stopConditions, `${label}.stopConditions`) ?? [],
    rollback: requireNonEmptyString(record.rollback, `${label}.rollback`),
  };
}

export function parseDecideDesignPayload(payload: unknown): DecideDesignAction["payload"] {
  const record = requireObject(payload, "decideDesign payload");
  const decision = requireEnumValue<DesignDecisionKind>(
    record.decision,
    DESIGN_DECISION_KINDS,
    "decideDesign payload.decision",
  );
  if (!DESIGNER_DECISION_KINDS.has(decision)) {
    throw new Error(
      "decideDesign payload.decision approved is not allowed from designer output; record approvals through the authority evaluator or human CLI path",
    );
  }
  const actorKindRaw = optionalEnumValue<DesignDecisionActorKind>(
    record.actorKind,
    DESIGN_DECISION_ACTOR_KINDS,
    "decideDesign payload.actorKind",
  );
  if (actorKindRaw !== undefined && actorKindRaw !== "auto") {
    throw new Error(
      `decideDesign payload.actorKind ${actorKindRaw} is not allowed from designer output; human and governance decisions are recorded through the authority evaluator or human CLI path`,
    );
  }
  return {
    proposalId: requireNonEmptyString(record.proposalId, "decideDesign payload.proposalId"),
    decision,
    actorKind: "auto" as DesignDecisionActorKind,
    actorRef: optionalString(record.actorRef, "decideDesign payload.actorRef"),
    charterId: optionalString(record.charterId, "decideDesign payload.charterId"),
    reasons: optionalStringArray(record.reasons, "decideDesign payload.reasons"),
    authority: optionalRecord(record.authority, "decideDesign payload.authority"),
    payload: optionalRecord(record.payload, "decideDesign payload.payload"),
  };
}

export function parseRecordDesignOutcomePayload(payload: unknown): RecordDesignOutcomeAction["payload"] {
  const record = requireObject(payload, "recordDesignOutcome payload");
  return {
    proposalId: requireNonEmptyString(record.proposalId, "recordDesignOutcome payload.proposalId"),
    stage: requireEnumValue<DesignOutcomeStage>(
      record.stage,
      DESIGN_OUTCOME_STAGES,
      "recordDesignOutcome payload.stage",
    ),
    recommendation: requireEnumValue<DesignOutcomeRecommendation>(
      record.recommendation,
      DESIGN_OUTCOME_RECOMMENDATIONS,
      "recordDesignOutcome payload.recommendation",
    ),
    baseline: optionalRecord(record.baseline, "recordDesignOutcome payload.baseline"),
    observed: optionalRecord(record.observed, "recordDesignOutcome payload.observed"),
    evidence: optionalJsonArray(record.evidence, "recordDesignOutcome payload.evidence"),
    unexpectedEffects: optionalJsonArray(record.unexpectedEffects, "recordDesignOutcome payload.unexpectedEffects"),
    reviewAt: optionalIsoTimestamp(record.reviewAt, "recordDesignOutcome payload.reviewAt"),
    payload: optionalRecord(record.payload, "recordDesignOutcome payload.payload"),
  };
}
