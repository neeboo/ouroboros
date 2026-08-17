export {
  buildTaskPrompt,
  normalizedLessonSummary,
  protectedPromptContractFingerprint,
  protectedPromptContractFingerprintForSource,
} from "./prompt";
export {
  blockedOutput,
  createRunsAction,
  createRunsFromDesignAction,
  createTasksAction,
  decideDesignAction,
  doneOutput,
  proposeDesignAction,
  recordDesignOutcomeAction,
  recordSignalAction,
  setRunDecisionAction,
} from "./agent-actions";
export { applyStartHooks, runNextReadyTask, runReadyTasks, runUntilIdle } from "./runner";
export {
  resumeCodexResumableAttempt,
  runCodexAutopilot,
  runCodexResumableLoop,
  runtimeGenerationAllowsLeasing,
  startCodexResumableAttempt,
  superviseCodexDaemon,
  superviseCodexRuns,
} from "./codex-resumable-runner";
export { createAcpxAgentExecutor, createAcpxCodexExecutor } from "./executors/acpx";
export { createDurableAttemptReplayCache, createInMemoryAttemptReplayCache } from "./executors/replay";
export {
  acpxSubsessionBaseCommand,
  buildAcpxPromptCommand,
  createAcpxSubsessionRunner,
  SUBSESSION_DEFAULT_TIMEOUT_MS,
  SUBSESSION_DEFAULT_IDLE_TIMEOUT_MS,
} from "./acpx-subsessions";
export type {
  AcpxSubsessionRunnerOptions,
  AcpxSubsessionSpawnInput,
  AcpxSubsessionSpawnResult,
} from "./acpx-subsessions";
export { createCodexCliExecutor } from "./executors/codex-cli";
export {
  createDshCliExecutor,
  DSH_PROMPT_ARGUMENT_MAX_CHARACTERS,
  DSH_PROMPT_ARGUMENT_MAX_UTF8_BYTES,
} from "./executors/dsh-cli";
export { inspectDshReadiness, resolveDshCommand } from "./dsh-readiness";
export { createCodexResumableClient } from "./executors/codex-resumable";
export { prepareCodexHostExecution, protectedCodexConfig } from "./executors/codex-host-execution";
export { defaultCodexBin, resolveDefaultCodexBin } from "./executors/codex-bin";
export { createRouteExecutor } from "./route-executor";
export {
  hostExecutionCapabilityAttemptInput,
  parseHostExecutionCapabilities,
  resolveHostExecutionCapabilities,
} from "./executors/host-execution-capabilities";
export { parseAttemptOutput } from "./executors/output";
export { codexOnlyAgentDefaults, resolveAgentBackend } from "./agent-backends";
export { resolveExecutionRoute } from "./execution-routing";
export { resolveModelPreference } from "./model-preferences";
export { readHostCapabilityReadback } from "./host-capability-readback";
export type { HostCapabilityReadback, HostReadbackForTask } from "./host-capability-readback";
export {
  assertPersistedVerifierExecutionEnvironmentReceipt,
  blockedVerifierExecutionEnvironmentOutput,
  parseVerifierExecutionEnvironment,
  prepareVerifierExecutionEnvironment,
  verifierExecutionEnvironmentAttemptInput,
  withVerifierExecutionEnvironmentReceipt,
} from "./verifier-execution-environment";
export type {
  PreparedVerifierExecutionEnvironment,
  VerifierExecutionEnvironmentHost,
  VerifierExecutionEnvironmentReceiptV1,
  VerifierExecutionEnvironmentV1,
} from "./verifier-execution-environment";
export {
  descendantPidsFromPsOutputForTest,
  runLocalCommand,
  terminateProcessTree,
  terminateProcessTreeSync,
} from "./executors/command";
export {
  childEnvForProcess,
  childToolchainEnvEvidence,
  proxyEnvForChildProcess,
  proxyEnvFromScutilOutput,
} from "./executors/proxy-env";
export {
  createApplyDesignActionsHook,
  projectOverallGoalIntegrationDesignActions,
  reconcileDeferredDesignAuthority,
} from "./hooks/apply-design-actions";
export type {
  ApplyDesignActionsHookOptions,
  ReconcileDeferredDesignAuthorityInput,
  ReconcileDeferredDesignAuthorityResult,
} from "./hooks/apply-design-actions";
export { createContextSubagentHook, createContextSummaryHook } from "./hooks/context-summary";
export { createCollectSubsessionsHook } from "./hooks/collect-subsessions";
export type { CollectSubsessionsHookOptions } from "./hooks/collect-subsessions";
export {
  createRepairTaskHook,
  DEFAULT_REPAIR_REPLAN_BUDGET_LIMIT,
  reconcileTerminalBlockedVerifierRepair,
} from "./hooks/create-repair";
export {
  chargeRepairBudget,
  chargeRepairBudgetState,
  goalReviewRepairTrigger,
  readRepairBudget,
  reconcileGoalReviewRepairBudget,
  repairBudgetExhausted,
  type RepairBudgetEntry,
  type RepairBudgetState,
} from "./hooks/repair-budget";
export { createRunsFromOutputHook } from "./hooks/create-runs";
export { createTasksFromOutputHook } from "./hooks/create-tasks";
export {
  createVerifierTaskHook,
  reconcileTerminalDoneWorkerVerifiers,
  type TerminalDoneWorkerVerifierReconciliation,
} from "./hooks/create-verifier";
export { createGitWorktreeHook } from "./hooks/git-worktree";
export { createGoalReviewDecisionHook, inferExplicitRunDecision } from "./hooks/goal-review";
export {
  reconcileTerminalDesignDeliveries,
  type TerminalDesignReconciliationResult,
} from "./terminal-design-reconciliation";
export { createRefreshGuardrailProposalsHook } from "./hooks/refresh-guardrail-proposals";
export type {
  AgentAction,
  AgentOutput,
  AgentOutputInput,
  CreateRunsAction,
  CreateRunsFromDesignAction,
  CreateTasksAction,
  DecideDesignAction,
  ProposeDesignAction,
  RecordDesignOutcomeAction,
  RecordSignalAction,
  SetRunDecisionAction,
} from "./agent-actions";
export type {
  AttemptInputFactory,
  ExecutorEventRecorder,
  ExecutorInput,
  PromptInput,
  RunNextReadyTaskInput,
  RunNextReadyTaskResult,
  RunReadyTasksInput,
  RunReadyTasksResult,
  RunUntilIdleInput,
  RunUntilIdleResult,
  StartHook,
  StartHookInput,
  StartHookResult,
  StopDecision,
  StopHook,
  StopHookInput,
  StopHookResult,
  StopHooksByRole,
  TaskExecutor,
  TaskExecutorFactory,
} from "./types";
export type { AgentBackendKind, AgentBackendSource, ResolvedAgentBackend } from "./agent-backends";
export type { ExecutionRouteMode, ResolvedExecutionRoute } from "./execution-routing";
export type { ResolvedModelPreference, ResolvedModelPreferenceSource } from "./model-preferences";
export type {
  AcpxAgentExecutorOptions,
  AcpxBuiltInAgent,
  AcpxCodexExecutorOptions,
  ApprovalMode,
  AttemptReplayCache,
  BrowserProcessPolicy,
  CodexCliExecutorOptions,
  CodexSandbox,
  CommandResult,
  DshCliExecutorOptions,
  DshFilePolicy,
  RunCommand,
  RunCommandInput,
  WorktreeEvidenceProbe,
} from "./executors/types";
export type {
  DshCommandResolution,
  DshCommandResolver,
  DshInstallationState,
  DshProbeReceipt,
  DshReadinessReceipt,
  DshResolutionMode,
  InspectDshReadinessInput,
  ResolveDshCommandInput,
} from "./dsh-readiness";
export type { RouteExecutorOptions } from "./route-executor";
export type {
  CodexResumableClientOptions,
  CodexResumableResumeInput,
  CodexResumableResult,
  CodexResumableStartInput,
} from "./executors/codex-resumable";
export type {
  CodexResumableClientFactory,
  CodexResumableOrchestrationInput,
  RunCodexAutopilotInput,
  RunCodexResumableLoopInput,
  SuperviseCodexDaemonInput,
  SuperviseCodexRunsInput,
} from "./codex-resumable-runner";
export { reconcileHostEvidenceMaintenance } from "./host-evidence-maintenance";
export { reconcileAdditiveEvidenceContract } from "./additive-evidence-contract";
export { reconcileRuntimeIntegrationHostEvidence } from "./runtime-integration-host-evidence";
export type { HostEvidenceMaintenanceReconciliation } from "./host-evidence-maintenance";
export type {
  ContextSubagent,
  ContextSubagentEntry,
  ContextSubagentOutput,
  StopHookOutputPatch,
} from "./types";
