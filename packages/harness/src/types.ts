export type Status = "todo" | "running" | "done" | "blocked";

export interface Run {
  id: string;
  projectId: string | null;
  projectRoot: string | null;
  goal: string;
  status: Status;
  context: Record<string, unknown>;
  createdAt?: string | null;
}

export interface ModelPreference {
  model: string;
  reasoning_effort?: string;
  reason?: string;
  provider?: string;
  profile?: string;
  base_url?: string;
  env_key?: string;
}

export interface TaskConfig {
  modelPreference?: ModelPreference;
  verifierContract?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  context: Record<string, unknown>;
}

export interface Task {
  id: string;
  runId: string;
  parentId: string | null;
  cycleId: string;
  status: Status;
  role: string;
  goal: string;
  prompt: string;
  dependsOn: string[];
  doneWhen: string[];
  config?: TaskConfig;
  worktreePath: string | null;
  sessionRef: string | null;
  contextVersion: number;
}

export interface Attempt {
  id: string;
  taskId: string;
  status: Exclude<Status, "todo">;
  input: Record<string, unknown>;
  output: AttemptOutput;
  checks: unknown[];
  artifacts: unknown[];
  error: string | null;
}

export type AttemptEventStream = "stdout" | "stderr" | "codex-json" | "system";

export interface AttemptEvent {
  id: string;
  attemptId: string;
  sequence: number;
  stream: AttemptEventStream;
  text: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ListRunsInput {
  statuses?: Status[];
  limit?: number;
}

export type RunStatusCounts = Record<Status, number>;

export interface HarnessActionEvent {
  id: string;
  actionType: string;
  status: "done" | "blocked";
  request: Record<string, unknown>;
  result: Record<string, unknown>;
  createdAt: string;
}

export type ExecutionThreadStatus = "running" | "done" | "blocked" | "interrupted" | "orphaned";

export interface ExecutionThread {
  id: string;
  runId: string;
  taskId: string | null;
  attemptId: string | null;
  parentThreadId: string | null;
  ownerType: string;
  ownerId: string | null;
  role: string;
  status: ExecutionThreadStatus;
  pid: number | null;
  sessionName: string | null;
  agentSessionId: string | null;
  worktreePath: string | null;
  heartbeatAt: string;
  interruptedAt: string | null;
  interruptReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttemptOutput {
  status: "done" | "blocked";
  runDecision?: "complete" | "continue" | "verify" | "defer";
  summary: string;
  changedFiles?: string[];
  checks?: unknown[];
  artifacts?: unknown[];
  problems?: string[];
  nextTasks?: PlannedTask[];
  nextRuns?: PlannedRun[];
  designActions?: DesignActionInput[];
}

export type DesignActionInput =
  | { type: "recordSignal"; payload: Record<string, unknown> }
  | { type: "proposeDesign"; payload: Record<string, unknown> }
  | { type: "decideDesign"; payload: Record<string, unknown> }
  | { type: "recordDesignOutcome"; payload: Record<string, unknown> }
  | { type: "createRunsFromDesign"; payload: Record<string, unknown> };

export interface DependencyAttempt {
  taskId: string;
  attemptId: string;
  status: AttemptOutput["status"];
  summary: string;
  changedFiles: string[];
  checks: unknown[];
  artifacts: unknown[];
  problems: string[];
}

export interface PlannedTask {
  role: string;
  goal: string;
  prompt: string;
  dependsOn?: string[];
  doneWhen?: string[];
  modelPreference?: ModelPreference;
  verifierContract?: Record<string, unknown>;
}

export interface ExternalRef {
  id: string;
  localType: string;
  localId: string;
  provider: string;
  externalType: string;
  externalId: string;
  externalUrl: string | null;
}

export type LessonKind = "experience" | "lesson";

export interface Lesson {
  id: string;
  runId: string;
  taskId: string;
  attemptId: string;
  kind: LessonKind;
  summary: string;
  evidence: Record<string, unknown>;
}

export interface PromptTemplate {
  key: string;
  contentMd: string;
}

export interface CreateRunInput {
  goal: string;
  context?: Record<string, unknown>;
  projectId?: string | null;
  projectRoot?: string | null;
  id?: string;
}

export interface CreateProjectInput {
  name: string;
  rootPath: string;
  context?: Record<string, unknown>;
  id?: string;
}

export interface UpdateRunStatusInput {
  runId: string;
  status: Status;
}

export interface UpdateRunInput {
  runId: string;
  goal?: string;
  status?: Status;
  contextPatch?: Record<string, unknown>;
}

export interface CreateTaskInput {
  runId: string;
  role: string;
  goal: string;
  prompt: string;
  dependsOn?: string[];
  doneWhen?: string[];
  worktreePath?: string | null;
  config?: TaskConfig;
  parentId?: string | null;
  cycleId?: string | null;
  id?: string;
}

export interface RecordAttemptInput {
  taskId: string;
  input: Record<string, unknown>;
  output: AttemptOutput;
  id?: string;
}

export interface StartAttemptInput {
  taskId: string;
  input: Record<string, unknown>;
  id?: string;
}

export interface FinishAttemptInput {
  attemptId: string;
  output: AttemptOutput;
}

export interface UpdateAttemptInputInput {
  attemptId: string;
  input: Record<string, unknown>;
}

export interface RecordAttemptEventInput {
  attemptId: string;
  stream: AttemptEventStream;
  sequence: number;
  text?: string | null;
  payload?: Record<string, unknown>;
  id?: string;
}

export interface GetRunOverviewInput {
  runId: string;
  eventLimit?: number;
}

export interface ObservableSession {
  role: string;
  taskId: string;
  taskGoal: string;
  attemptId: string;
  status: Exclude<Status, "todo">;
  output: Partial<AttemptOutput>;
  model: Record<string, unknown> | null;
  backend: Record<string, unknown> | null;
  sessionName: string | null;
  codexSessionId: string | null;
  cwd: string | null;
  worktreePath: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  latestText: string;
  events: AttemptEvent[];
}

export interface RunOverview {
  run: Run | null;
  project: Project | null;
  tasks: Task[];
  sessions: ObservableSession[];
  threads: ExecutionThread[];
  lessons: Lesson[];
}

export interface PlannedRun {
  goal: string;
  prompt: string;
  doneWhen?: string[];
  context?: Record<string, unknown>;
  modelPreference?: ModelPreference;
}

export interface ListRunningAttemptsInput {
  runId: string;
}

export interface ReclaimRunningTasksInput {
  runId: string;
}

export interface ReclaimedRunningTask {
  taskId: string;
  sessionRef: string | null;
  worktreePath: string | null;
  reason: string;
}

export interface BlockedUnfinishedTask {
  taskId: string;
  role: string;
  previousStatus: Extract<Status, "todo" | "running">;
  reason: string;
}

export interface BlockUnfinishedTasksForRunInput {
  runId: string;
  reason: string;
}

export interface BlockedDependencyTask {
  taskId: string;
  role: string;
  previousStatus: Extract<Status, "todo">;
  dependencyIds: string[];
  reason: string;
}

export interface BlockTasksWithBlockedDependenciesInput {
  runId: string;
  reason: string;
}

export interface SharedRootCauseRecord {
  rootTaskId: string;
  rootAttemptId?: string;
  reason: string;
  terminalReason?: string;
  descendantTaskIds: string[];
  recordedAt: string;
}

export interface BlockTasksWithSharedRootCauseInput {
  runId: string;
  reason: string;
}

export interface BlockTasksWithSharedRootCauseResult {
  blocked: BlockedDependencyTask[];
  sharedRootCauses: SharedRootCauseRecord[];
}

export interface LeaseReadyTasksInput {
  runId: string;
  limit: number;
  sessionForTask: (task: Task) => string;
  worktreeForTask?: (task: Task) => string | null;
}

export interface RetryTaskInput {
  taskId: string;
}

export interface CreateExternalRefInput {
  localType: string;
  localId: string;
  provider: string;
  externalType: string;
  externalId: string;
  externalUrl?: string | null;
  id?: string;
}

export interface EnsureExternalRefInput {
  /** Caller-supplied deterministic id (typically derived from local_id, provider, external_type, external_id). */
  id: string;
  localType: string;
  localId: string;
  provider: string;
  externalType: string;
  externalId: string;
  externalUrl?: string | null;
}

export interface EnsureExternalRefResult {
  ref: ExternalRef;
  /** True when this call inserted a new row, false when an identical row already existed. */
  created: boolean;
}

export interface ListExternalRefsInput {
  localType: string;
  localId: string;
}

export interface FindExternalRefsInput {
  provider: string;
  externalType: string;
  externalId: string;
  localType?: string;
}

export interface InboxEvent {
  id: string;
  provider: string;
  eventType: string;
  externalId: string;
  payload: Record<string, unknown>;
  status: Status;
  createdAt: string | null;
  processedAt: string | null;
}

export interface CreateInboxEventInput {
  provider: string;
  eventType: string;
  externalId: string;
  payload: Record<string, unknown>;
  status?: Status;
  id?: string;
}

export interface EnsureInboxEventInput {
  /** Caller-supplied deterministic id (typically derived from provider, event type, and immutable external id). */
  id: string;
  provider: string;
  eventType: string;
  externalId: string;
  payload: Record<string, unknown>;
}

export interface EnsureInboxEventResult {
  event: InboxEvent;
  /** True when this call inserted a new row, false when an identical row already existed. */
  created: boolean;
}

export type InboxTransitionTarget = "running" | "done" | "blocked";

export interface TransitionInboxEventInput {
  id: string;
  from: Extract<Status, "todo" | "running">;
  to: InboxTransitionTarget;
}

export interface TransitionInboxEventResult {
  event: InboxEvent;
  /** True when the compare-and-set update changed the row. */
  updated: boolean;
}

export interface GetInboxEventInput {
  id: string;
}

export interface ListInboxEventsInput {
  provider?: string;
  status?: Status;
  limit?: number;
}

export interface ListLessonsInput {
  runId: string;
  limit?: number;
}

export interface SetPromptTemplateInput {
  key: string;
  contentMd: string;
}

export interface UpsertExecutionThreadInput {
  id?: string;
  runId: string;
  taskId?: string | null;
  attemptId?: string | null;
  parentThreadId?: string | null;
  ownerType: string;
  ownerId?: string | null;
  role: string;
  status?: ExecutionThreadStatus;
  pid?: number | null;
  sessionName?: string | null;
  agentSessionId?: string | null;
  worktreePath?: string | null;
  interruptReason?: string | null;
}

export interface UpdateExecutionThreadInput {
  id: string;
  status?: ExecutionThreadStatus;
  ownerId?: string | null;
  pid?: number | null;
  sessionName?: string | null;
  agentSessionId?: string | null;
  worktreePath?: string | null;
  interruptReason?: string | null;
  heartbeat?: boolean;
}

export interface ListExecutionThreadsInput {
  runId: string;
}

export interface RecordHarnessActionEventInput {
  actionType: string;
  status: "done" | "blocked";
  request: Record<string, unknown>;
  result: Record<string, unknown>;
  id?: string;
}

export interface ListHarnessActionEventsInput {
  limit?: number;
}

export interface GetHarnessActionEventInput {
  id: string;
}

export type CharterStatus = "draft" | "active" | "superseded";

export interface FounderCharterCapitalPolicy {
  currency?: string;
  monthlyBudget?: number;
  experimentBudget?: number;
  recurringSpendApprovalAbove?: number;
  runwayFloorMonths?: number;
  portfolio?: {
    core?: number;
    growth?: number;
    exploration?: number;
  };
  [key: string]: unknown;
}

export interface FounderCharterAuthority {
  autoResearch?: boolean;
  autoReversibleExperiments?: boolean;
  autoIntegrateVerifiedCode?: boolean;
  humanApprovalPolicy?: "risk-and-cost" | "cost-only";
  requireHumanFor?: string[];
  [key: string]: unknown;
}

export interface FounderCharterData {
  mission: string;
  targetUsers?: string[];
  valueMetrics?: string[];
  principles?: string[];
  nonGoals?: string[];
  constraints?: string[];
  capitalPolicy?: FounderCharterCapitalPolicy;
  authority?: FounderCharterAuthority;
  reviewCadenceDays?: number;
  [key: string]: unknown;
}

export interface FounderCharter {
  id: string;
  projectId: string | null;
  version: number;
  isActive: boolean;
  activatedAt: string | null;
  supersededAt: string | null;
  mission: string;
  charter: FounderCharterData;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFounderCharterInput {
  projectId: string;
  mission: string;
  charter?: FounderCharterData;
  activate?: boolean;
  id?: string;
}

export interface ActivateFounderCharterInput {
  charterId: string;
}

export interface GetFounderCharterInput {
  id: string;
}

export interface GetActiveFounderCharterInput {
  projectId: string;
}

export interface ListFounderChartersInput {
  projectId: string;
  includeInactive?: boolean;
  limit?: number;
}

export type StrategySignalClass =
  | "user"
  | "delivery"
  | "technology"
  | "market"
  | "economics"
  | "system";

export type StrategySignalStatus = "active" | "expired" | "superseded";

export interface StrategySignal {
  id: string;
  projectId: string | null;
  signalClass: StrategySignalClass;
  source: string;
  title: string;
  summary: string;
  observationTime: string;
  confidence: number;
  evidence: unknown[];
  expiresAt: string | null;
  status: StrategySignalStatus;
  conflictingSignalIds: string[];
  proposalId: string | null;
  runId: string | null;
  taskId: string | null;
  attemptId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStrategySignalInput {
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
  runId?: string | null;
  taskId?: string | null;
  attemptId?: string | null;
  payload?: Record<string, unknown>;
  status?: StrategySignalStatus;
  id?: string;
}

export interface GetStrategySignalInput {
  id: string;
}

export interface ListStrategySignalsInput {
  projectId?: string;
  signalClass?: StrategySignalClass;
  statuses?: StrategySignalStatus[];
  limit?: number;
}

export type DesignProposalStatus =
  | "draft"
  | "proposed"
  | "experimenting"
  | "accepted"
  | "implemented"
  | "measuring"
  | "retained"
  | "rejected"
  | "retired"
  | "revise";

export interface DesignProposalOption {
  name: string;
  benefits?: string[];
  costs?: string[];
  risks?: string[];
  lockIn?: string[];
  [key: string]: unknown;
}

export interface DesignEvaluationContract {
  baseline: string[];
  successMetrics: string[];
  guardMetrics: string[];
  requiredEvidence: string[];
  reviewAt?: string;
  [key: string]: unknown;
}

export interface DesignInvestment {
  oneTimeCost?: number;
  recurringCost?: number;
  timeBudget?: string;
  reversibility: "easy" | "moderate" | "hard";
  portfolio: "core" | "growth" | "exploration";
  [key: string]: unknown;
}

export interface DesignExperiment {
  hypothesis: string;
  smallestTest: string;
  stopConditions: string[];
  rollback: string;
  [key: string]: unknown;
}

export interface DesignProposalData {
  problem: string;
  evidenceRefs?: string[];
  targetOutcome?: string;
  options?: DesignProposalOption[];
  recommendation: string;
  additions?: string[];
  removals?: string[];
  assumptions?: string[];
  uncertainty?: string[];
  evaluationContract: DesignEvaluationContract;
  investment: DesignInvestment;
  experiment?: DesignExperiment;
  [key: string]: unknown;
}

export interface DesignProposal {
  id: string;
  projectId: string | null;
  runId: string | null;
  taskId: string | null;
  attemptId: string | null;
  charterId: string | null;
  title: string;
  problem: string;
  recommendation: string;
  status: DesignProposalStatus;
  proposal: DesignProposalData;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDesignProposalInput {
  projectId: string;
  title: string;
  problem: string;
  recommendation: string;
  proposal: DesignProposalData;
  charterId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  attemptId?: string | null;
  status?: DesignProposalStatus;
  id?: string;
}

export interface UpdateDesignProposalStatusInput {
  proposalId: string;
  status: DesignProposalStatus;
}

export interface GetDesignProposalInput {
  id: string;
}

export interface ListDesignProposalsInput {
  projectId?: string;
  statuses?: DesignProposalStatus[];
  limit?: number;
}

export type DesignDecisionKind =
  | "approved"
  | "rejected"
  | "deferred"
  | "retired"
  | "revise";

export type DesignDecisionActorKind = "auto" | "human" | "governance";

export interface DesignDecision {
  id: string;
  proposalId: string;
  charterId: string | null;
  decision: DesignDecisionKind;
  actorKind: DesignDecisionActorKind;
  actorRef: string | null;
  reasons: string[];
  authority: Record<string, unknown>;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RecordDesignDecisionInput {
  proposalId: string;
  decision: DesignDecisionKind;
  actorKind: DesignDecisionActorKind;
  actorRef?: string | null;
  charterId?: string | null;
  reasons?: string[];
  authority?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  id?: string;
}

export interface ListDesignDecisionsInput {
  proposalId: string;
  limit?: number;
}

export type DesignOutcomeStage = "experiment" | "release" | "review";

export type DesignOutcomeRecommendation = "retain" | "revise" | "retire";

export interface DesignOutcome {
  id: string;
  proposalId: string;
  runId: string | null;
  taskId: string | null;
  attemptId: string | null;
  stage: DesignOutcomeStage;
  recommendation: DesignOutcomeRecommendation;
  baseline: Record<string, unknown>;
  observed: Record<string, unknown>;
  evidence: unknown[];
  unexpectedEffects: unknown[];
  reviewAt: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RecordDesignOutcomeInput {
  proposalId: string;
  stage: DesignOutcomeStage;
  recommendation: DesignOutcomeRecommendation;
  baseline?: Record<string, unknown>;
  observed?: Record<string, unknown>;
  evidence?: unknown[];
  unexpectedEffects?: unknown[];
  reviewAt?: string | null;
  runId?: string | null;
  taskId?: string | null;
  attemptId?: string | null;
  payload?: Record<string, unknown>;
  id?: string;
}

export interface ListDesignOutcomesInput {
  proposalId?: string;
  projectId?: string;
  stage?: DesignOutcomeStage;
  dueBefore?: string;
  limit?: number;
}

export interface LinkProposalOutcomeReviewInput {
  runId: string;
  /** Epoch milliseconds. Defaults to Date.now(). */
  now?: number;
  /** Skip the reviewAt check and treat the review as due now. */
  immediateProxyReview?: boolean;
}

export interface LinkProposalOutcomeReviewResult {
  proposalId: string | null;
  proposalStatus: DesignProposalStatus | null;
  outcomeReviewTaskId: string | null;
  reviewDue: boolean;
  reviewAt: string | null;
  reason: string;
}

export type AuthorityDisposition = "automatic" | "human-required" | "rejected";

export type AuthorityReasonKind =
  | "expired-evidence"
  | "missing-evidence"
  | "conflicting-evidence"
  | "invalid-evidence-expiry"
  | "invalid-conflict-metadata"
  | "malformed-evidence-item"
  | "budget-experiment-exceeded"
  | "recurring-spend-over-threshold"
  | "missing-experiment-budget-policy"
  | "missing-recurring-spend-policy"
  | "missing-currency-policy"
  | "hard-reversibility"
  | "moderate-reversibility"
  | "charter-amendment-mission"
  | "charter-amendment-capital"
  | "legal-or-privacy"
  | "sensitive-data"
  | "destructive-operation"
  | "production-deployment"
  | "unplanned-dependency"
  | "schema-migration"
  | "recurring-infrastructure"
  | "require-human-category"
  | "auto-reversible-experiments-disabled"
  | "portfolio-not-configured"
  | "portfolio-allocation-missing"
  | "portfolio-allocation-exceeded"
  | "portfolio-usage-unavailable"
  | "portfolio-usage-category-mismatch"
  | "invalid-portfolio-usage"
  | "invalid-cost-shape"
  | "cost-requires-human-decision"
  | "proposer-cannot-self-authorize"
  | "actor-not-allowed-for-high-risk"
  | "charter-inactive"
  | "unknown-risk-data";

export type AuthorityHardRule =
  | "expired-evidence"
  | "missing-evidence"
  | "charter-inactive"
  | "budget-experiment-exceeded"
  | "portfolio-not-configured"
  | "portfolio-allocation-missing"
  | "portfolio-allocation-exceeded"
  | "portfolio-usage-unavailable"
  | "portfolio-usage-category-mismatch"
  | "invalid-portfolio-usage"
  | "missing-experiment-budget-policy"
  | "missing-currency-policy"
  | "invalid-cost-shape"
  | "invalid-evidence-expiry"
  | "invalid-conflict-metadata"
  | "malformed-evidence-item"
  | "unknown-risk-data";

export interface AuthorityReason {
  kind: AuthorityReasonKind;
  message: string;
  evidenceRefs?: string[];
}

export interface AuthorityEvidenceReference {
  ref: string;
  kind: "signal" | "evidence-ref" | "external";
  expiresAt: string | null;
  hasConflict: boolean;
}

export interface AuthorityEvidenceEvaluation {
  referenced: string[];
  expired: string[];
  conflicting: string[];
  invalidExpiry: string[];
  invalidConflictMetadata: string[];
  missing: string[];
  malformedItems: number;
  evaluatedAtValid: boolean;
}

export interface AuthorityBudgetEvaluation {
  currency: string | null;
  oneTimeCost: number;
  recurringCost: number;
  experimentBudget: number | null;
  recurringThreshold: number | null;
  withinExperimentBudget: boolean;
  withinRecurringThreshold: boolean;
}

export interface AuthorityPortfolioEvaluation {
  category: "core" | "growth" | "exploration";
  configuredShare: number | null;
  currentShare: number | null;
  proposedShare: number | null;
  withinShare: boolean;
}

export interface AuthorityActorContext {
  kind: DesignDecisionActorKind;
  ref: string | null;
  isProposer: boolean;
}

export interface AuthorityProposalRiskSurface {
  proposalId: string | null;
  reversibility: "easy" | "moderate" | "hard";
  portfolio: "core" | "growth" | "exploration";
  oneTimeCost: number;
  recurringCost: number;
  evidenceRefs: string[];
  amendsMission: boolean;
  amendsCapitalPolicy: boolean;
  legalOrPrivacy: boolean;
  sensitiveData: boolean;
  destructiveOperation: boolean;
  productionDeployment: boolean;
  unplannedDependency: boolean;
  schemaMigration: boolean;
  recurringInfrastructure: boolean;
  declaredHumanCategories: string[];
}

export interface AuthorityCharterContext {
  id: string;
  version: number;
  isActive: boolean;
  mission: string;
  capitalPolicy?: FounderCharterCapitalPolicy;
  authority?: FounderCharterAuthority;
}

export interface AuthorityPortfolioUsage {
  category: "core" | "growth" | "exploration";
  currentShare: number | null;
}

export interface AuthorityEvaluationInput {
  charter: AuthorityCharterContext;
  proposal: AuthorityProposalRiskSurface;
  evidence: AuthorityEvidenceReference[];
  portfolioUsage?: AuthorityPortfolioUsage | null;
  actor: AuthorityActorContext;
  evaluatedAt: string;
}

export interface AuthorityEvaluation {
  disposition: AuthorityDisposition;
  reasons: AuthorityReason[];
  charterId: string;
  charterVersion: number;
  proposalId: string | null;
  evaluatedAt: string;
  evidence: AuthorityEvidenceEvaluation;
  budget: AuthorityBudgetEvaluation;
  portfolio: AuthorityPortfolioEvaluation;
  reversibility: "easy" | "moderate" | "hard";
  actor: AuthorityActorContext;
}
