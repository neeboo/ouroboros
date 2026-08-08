import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { acceptGuardrailProposal, proposeGuardrailsFromLessons } from "./guardrails";
import {
  GOAL_REVIEW_TASK_DONE_WHEN,
  GOAL_REVIEW_TASK_GOAL,
  GOAL_REVIEW_TASK_PROMPT,
  inferExplicitRunDecision,
  resolveRunDecision,
} from "./goal-review";
import { Harness } from "./harness";
import { filterOuroborosRuntimePaths } from "./runtime-paths";
import type {
  AttemptOutput,
  ExecutionThread,
  ReclaimedRunningTask,
  RunOverview,
  Task,
} from "./types";

export interface UnintegratedVerifiedWorker {
  taskId: string;
  role: string;
  verifierTaskId: string;
  changedFiles: string[];
}

export interface IntegrationReadiness {
  unintegrated: UnintegratedVerifiedWorker[];
  integratedWorkerTaskIds: ReadonlySet<string>;
}

export type HarnessAction =
  | { type: "reclaimRunningTasks"; runId: string; reason?: string }
  | { type: "retryTask"; taskId: string; reason?: string }
  | { type: "markRunTodo"; runId: string; reason?: string }
  | {
      type: "updateRunContext";
      runId: string;
      contextPatch: Record<string, unknown>;
      goal?: string;
      status?: "todo" | "running" | "done" | "blocked";
      reason?: string;
    }
  | { type: "retireRun"; runId: string; reason: string }
  | { type: "prepareRunDrain"; runId: string; maxTries?: number; reason?: string }
  | { type: "completeSystemTask"; taskId: string; actionEventId: string; reason?: string }
  | {
      type: "integrateVerifiedRun";
      runId: string;
      workerTaskId?: string;
      repoPath?: string;
      targetBranch?: string;
      commitMessage?: string;
      push?: boolean;
      reason?: string;
      /** Treat the linked design proposal's outcome review as due immediately. */
      immediateOutcomeReview?: boolean;
    }
  | {
      type: "pushExactGitRef";
      runId: string;
      contractId: string;
      repoPath: string;
      remoteHost: string;
      repository: string;
      ref: string;
      expectedOldSha: string;
      newSha: string;
      reason?: string;
    }
  | {
      type: "createExactGitRef";
      runId: string;
      contractId: string;
      repoPath: string;
      remoteHost: string;
      repository: string;
      ref: string;
      newSha: string;
      expectedAbsent: true;
    }
  | {
      type: "commitExactGitIndex";
      contractId: string;
      runId: string;
      taskId: string;
      repoPath: string;
      branch: string;
      expectedParentSha: string;
      commitMessage: string;
      files: ExactGitIndexFile[];
    }
  | {
      type: "interruptAttemptAndCreateTask";
      attemptId: string;
      reason: string;
      followUpTask: {
        role: string;
        goal: string;
        prompt: string;
        doneWhen?: string[];
      };
    }
  | {
      type: "interruptRunningAttemptsAndCreateTask";
      attemptIds: string[];
      reason: string;
      followUpTask: {
        role: string;
        goal: string;
        prompt: string;
        doneWhen?: string[];
      };
    }
  | {
      type: "acceptGuardrailProposal";
      runId: string;
      proposalId: string;
      acceptedBy: string;
      reason?: string;
    }
  | {
      type: "amendRunContract";
      runId: string;
      contractKey: string;
      value: unknown;
      version: number;
      expectedVersion?: number;
      reason?: string;
    }
  | {
      type: "startSubsession";
      parentTaskId: string;
      purpose: string;
      prompt: string;
      role?: string;
      backend?: string;
      sessionName?: string;
      timeoutMs?: number;
      idleTimeoutMs?: number;
    }
  | {
      type: "collectSubsessions";
      parentTaskId: string;
      status?: ExecutionThreadStatusFilter;
      reason?: string;
    }
  | {
      type: "cancelSubsessions";
      parentTaskId: string;
      threadIds?: string[];
      reason: string;
    };

export type ExecutionThreadStatusFilter = "running" | "done" | "blocked" | "interrupted" | "orphaned";

export type SubsessionAction = Extract<HarnessAction, { type: "startSubsession" | "collectSubsessions" | "cancelSubsessions" }>;

export interface ContractAmendmentEntry {
  contractKey: string;
  version: number;
  previousValue: unknown;
  value: unknown;
  reason: string | null;
  amendedAt: string;
}

export interface SubsessionRunnerStartInput {
  threadId: string;
  parentTaskId: string;
  parentAttemptId: string | null;
  parentThreadId: string | null;
  runId: string;
  worktreePath: string;
  sessionName: string;
  purpose: string;
  prompt: string;
  role: string;
  backend: ResolvedSubsessionBackend;
  timeoutMs: number;
  idleTimeoutMs: number;
}

export interface SubsessionRunnerStartResult {
  threadId: string;
  sessionName: string;
  agentSessionId?: string | null;
  pid?: number | null;
  status: ExecutionThreadStatusFilter;
  summary?: string;
  message?: string;
  checks?: HarnessActionResult["checks"];
  artifacts?: HarnessActionResult["artifacts"];
  problems?: string[];
}

export interface SubsessionRunnerCollectChild {
  threadId: string;
  sessionName: string | null;
  agentSessionId: string | null;
  backend: ResolvedSubsessionBackend;
  worktreePath: string;
}

export interface SubsessionRunnerCollectResult {
  threadId: string;
  status: ExecutionThreadStatusFilter;
  summary: string;
  agentSessionId?: string | null;
}

export interface SubsessionRunnerCancelChild {
  threadId: string;
  sessionName: string | null;
  agentSessionId: string | null;
  backend: ResolvedSubsessionBackend;
  worktreePath: string;
}

export interface SubsessionRunnerCancelResult {
  threadId: string;
  canceled: boolean;
  message?: string;
}

export interface ResolvedSubsessionBackend {
  id: string;
  kind: string;
  agent?: string;
  agentCommand?: string;
  approval?: string;
  format?: string;
}

export interface SubsessionRunner {
  start(input: SubsessionRunnerStartInput): SubsessionRunnerStartResult;
  collect(children: SubsessionRunnerCollectChild[]): SubsessionRunnerCollectResult[];
  cancel(children: SubsessionRunnerCancelChild[], reason: string): SubsessionRunnerCancelResult[];
}

export interface HarnessActionResult {
  status: "done" | "blocked";
  actionType: HarnessAction["type"] | "invalid";
  summary: string;
  checks: Array<{ name: string; status: "passed" | "failed"; evidence?: string }>;
  artifacts: Array<Record<string, unknown>>;
  problems: string[];
}

export interface HarnessActionOptions {
  runGit?: GitRunner;
  subsessionRunner?: SubsessionRunner;
}

interface GitCommandInput {
  cwd: string;
  args: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type GitRunner = (input: GitCommandInput) => GitCommandResult;

interface ExactGitIndexFile {
  status: "A";
  path: string;
  mode: "100644";
  blobOid: string;
}

const EXACT_GIT_INDEX_MAX_FILES = 256;
const EXACT_GIT_INDEX_MAX_PATH_BYTES = 1024;
const EXACT_GIT_INDEX_MAX_COMMIT_MESSAGE_BYTES = 4096;
const EXACT_GIT_REMOTE_TIMEOUT_MS = 30_000;
const EXACT_GIT_REMOTE_MAX_OUTPUT_BYTES = 24 * 1024;

// Bump when integration preflight semantics change so a previously converged
// blocked action is re-evaluated under the new contract.
const INTEGRATION_CONTRACT_VERSION = 2;

export function parseHarnessAction(value: unknown): HarnessAction {
  const record = objectRecord(value, "harness action");
  const type = stringField(record, "type");
  if (type === "reclaimRunningTasks") {
    return { type, runId: stringField(record, "runId"), reason: optionalStringField(record, "reason") };
  }
  if (type === "retryTask") {
    return { type, taskId: stringField(record, "taskId"), reason: optionalStringField(record, "reason") };
  }
  if (type === "markRunTodo") {
    return { type, runId: stringField(record, "runId"), reason: optionalStringField(record, "reason") };
  }
  if (type === "updateRunContext") {
    return {
      type,
      runId: stringField(record, "runId"),
      contextPatch: objectRecord(record["contextPatch"], "contextPatch"),
      goal: optionalStringField(record, "goal"),
      status: optionalStatusField(record, "status"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "retireRun") {
    return { type, runId: stringField(record, "runId"), reason: stringField(record, "reason") };
  }
  if (type === "prepareRunDrain") {
    return {
      type,
      runId: stringField(record, "runId"),
      maxTries: optionalPositiveInteger(record, "maxTries"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "completeSystemTask") {
    return {
      type,
      taskId: stringField(record, "taskId"),
      actionEventId: stringField(record, "actionEventId"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "integrateVerifiedRun") {
    const push = optionalBooleanField(record, "push");
    if (push === true) {
      throw new Error("integrateVerifiedRun push is disabled; freeze and invoke pushExactGitRef instead");
    }
    return {
      type,
      runId: stringField(record, "runId"),
      workerTaskId: optionalStringField(record, "workerTaskId"),
      repoPath: optionalStringField(record, "repoPath"),
      targetBranch: optionalStringField(record, "targetBranch"),
      commitMessage: optionalStringField(record, "commitMessage"),
      push,
      reason: optionalStringField(record, "reason"),
      immediateOutcomeReview: optionalBooleanField(record, "immediateOutcomeReview"),
    };
  }
  if (type === "pushExactGitRef") {
    assertOnlyFields(record, type, [
      "type",
      "runId",
      "contractId",
      "repoPath",
      "remoteHost",
      "repository",
      "ref",
      "expectedOldSha",
      "newSha",
      "reason",
    ]);
    return {
      type,
      runId: stringField(record, "runId"),
      contractId: safeIdentifierField(record, "contractId"),
      repoPath: absolutePathField(record, "repoPath"),
      remoteHost: gitRemoteHostField(record, "remoteHost"),
      repository: gitRepositoryField(record, "repository"),
      ref: gitBranchRefField(record, "ref"),
      expectedOldSha: gitCommitShaField(record, "expectedOldSha"),
      newSha: gitCommitShaField(record, "newSha"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "createExactGitRef") {
    assertOnlyFields(record, type, [
      "type",
      "runId",
      "contractId",
      "repoPath",
      "remoteHost",
      "repository",
      "ref",
      "newSha",
      "expectedAbsent",
    ]);
    if (record.expectedAbsent !== true) {
      throw new Error("expectedAbsent must be true");
    }
    return {
      type,
      runId: exactNonEmptyStringField(record, "runId"),
      contractId: exactSafeIdentifierField(record, "contractId"),
      repoPath: exactAbsolutePathField(record, "repoPath"),
      remoteHost: exactGitRemoteHostField(record, "remoteHost"),
      repository: exactGitRepositoryField(record, "repository"),
      ref: exactCreatableBranchRefField(record, "ref"),
      newSha: exactGitCommitShaField(record, "newSha"),
      expectedAbsent: true,
    };
  }
  if (type === "commitExactGitIndex") {
    assertOnlyFields(record, type, [
      "type",
      "contractId",
      "runId",
      "taskId",
      "repoPath",
      "branch",
      "expectedParentSha",
      "commitMessage",
      "files",
    ]);
    return {
      type,
      contractId: exactSafeIdentifierField(record, "contractId"),
      runId: exactNonEmptyStringField(record, "runId"),
      taskId: exactNonEmptyStringField(record, "taskId"),
      repoPath: exactAbsolutePathField(record, "repoPath"),
      branch: exactGitBranchField(record, "branch"),
      expectedParentSha: exactGitCommitShaField(record, "expectedParentSha"),
      commitMessage: exactCommitMessageField(record, "commitMessage"),
      files: exactGitIndexFilesField(record, "files"),
    };
  }
  if (type === "interruptAttemptAndCreateTask") {
    return {
      type,
      attemptId: stringField(record, "attemptId"),
      reason: stringField(record, "reason"),
      followUpTask: followUpTaskField(record, "followUpTask"),
    };
  }
  if (type === "interruptRunningAttemptsAndCreateTask") {
    return {
      type,
      attemptIds: stringArrayField(record, "attemptIds"),
      reason: stringField(record, "reason"),
      followUpTask: followUpTaskField(record, "followUpTask"),
    };
  }
  if (type === "acceptGuardrailProposal") {
    return {
      type,
      runId: stringField(record, "runId"),
      proposalId: stringField(record, "proposalId"),
      acceptedBy: stringField(record, "acceptedBy"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "amendRunContract") {
    return {
      type,
      runId: stringField(record, "runId"),
      contractKey: stringField(record, "contractKey"),
      value: requiredValueField(record, "value"),
      version: positiveIntegerField(record, "version"),
      expectedVersion: optionalNonNegativeIntegerField(record, "expectedVersion"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "startSubsession") {
    return {
      type,
      parentTaskId: stringField(record, "parentTaskId"),
      purpose: stringField(record, "purpose"),
      prompt: stringField(record, "prompt"),
      role: optionalStringField(record, "role"),
      backend: optionalStringField(record, "backend"),
      sessionName: optionalStringField(record, "sessionName"),
      timeoutMs: optionalPositiveInteger(record, "timeoutMs"),
      idleTimeoutMs: optionalPositiveInteger(record, "idleTimeoutMs"),
    };
  }
  if (type === "collectSubsessions") {
    return {
      type,
      parentTaskId: stringField(record, "parentTaskId"),
      status: optionalThreadStatusFilter(record, "status"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "cancelSubsessions") {
    return {
      type,
      parentTaskId: stringField(record, "parentTaskId"),
      threadIds: optionalStringArrayField(record, "threadIds"),
      reason: stringField(record, "reason"),
    };
  }
  throw new Error(
    "harness action type must be reclaimRunningTasks, retryTask, markRunTodo, updateRunContext, amendRunContract, retireRun, prepareRunDrain, completeSystemTask, integrateVerifiedRun, pushExactGitRef, createExactGitRef, commitExactGitIndex, interruptAttemptAndCreateTask, interruptRunningAttemptsAndCreateTask, acceptGuardrailProposal, startSubsession, collectSubsessions, or cancelSubsessions",
  );
}

export function applyHarnessAction(
  harness: Harness,
  rawAction: unknown,
  options: HarnessActionOptions = {},
): HarnessActionResult & { eventId: string } {
  let action: HarnessAction;
  try {
    action = parseHarnessAction(rawAction);
  } catch (error) {
    const result = blockedResult("invalid", `Invalid harness action: ${errorMessage(error)}`, [errorMessage(error)]);
    const eventId = harness.recordHarnessActionEvent({
      actionType: "invalid",
      status: result.status,
      request: safeRequest(rawAction),
      result: resultToRecord(result),
    });
    return { ...result, eventId };
  }

  if (action.type === "startSubsession" || action.type === "collectSubsessions" || action.type === "cancelSubsessions") {
    const result = applySubsessionAction(harness, action, options);
    const eventId = recordSubsessionEvent(harness, action, result);
    return { ...result, eventId };
  }

  if (action.type === "integrateVerifiedRun") {
    const replay = findBlockedIntegrationReplay(harness, action, options);
    if (replay) {
      return replay;
    }
  }

  const result = applyParsedHarnessAction(harness, action, options);
  const eventId = harness.recordHarnessActionEvent({
    actionType: action.type,
    status: result.status,
    request: action,
    result: resultToRecord(result),
  });
  if (action.type === "integrateVerifiedRun" && result.status === "blocked") {
    recordBlockedIntegration(harness, action, options, eventId);
  }
  return { ...result, eventId };
}

type IntegrationConvergenceRecord = {
  operationKey: string;
  actionEventId: string;
  recordedAt: string;
};

function findBlockedIntegrationReplay(
  harness: Harness,
  action: Extract<HarnessAction, { type: "integrateVerifiedRun" }>,
  options: HarnessActionOptions,
): (HarnessActionResult & { eventId: string }) | null {
  const operation = integrationOperationKey(harness, action, options.runGit ?? defaultGitRunner);
  if (!operation) {
    return null;
  }
  const records = integrationConvergenceRecords(harness, action.runId);
  const record = records[operation.slot];
  if (!record || record.operationKey !== operation.key) {
    return null;
  }
  const event = harness.getHarnessActionEvent({ id: record.actionEventId });
  if (!event || event.status !== "blocked" || event.actionType !== "integrateVerifiedRun") {
    return null;
  }
  return { ...(event.result as unknown as HarnessActionResult), eventId: event.id };
}

function recordBlockedIntegration(
  harness: Harness,
  action: Extract<HarnessAction, { type: "integrateVerifiedRun" }>,
  options: HarnessActionOptions,
  actionEventId: string,
) {
  const operation = integrationOperationKey(harness, action, options.runGit ?? defaultGitRunner);
  if (!operation) {
    return;
  }
  const records = integrationConvergenceRecords(harness, action.runId);
  harness.updateRun({
    runId: action.runId,
    contextPatch: {
      integrationConvergence: {
        ...records,
        [operation.slot]: {
          operationKey: operation.key,
          actionEventId,
          recordedAt: new Date().toISOString(),
        },
      },
    },
  });
}

function integrationConvergenceRecords(harness: Harness, runId: string) {
  const raw = harness.getRun(runId)?.context.integrationConvergence;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {} as Record<string, IntegrationConvergenceRecord>;
  }
  return raw as Record<string, IntegrationConvergenceRecord>;
}

function applyParsedHarnessAction(harness: Harness, action: Exclude<HarnessAction, SubsessionAction>, options: HarnessActionOptions): HarnessActionResult {
  if (action.type === "reclaimRunningTasks") {
    const run = harness.getRun(action.runId);
    if (!run) {
      return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
    }
    const reclaimed = harness.reclaimRunningTasksWithoutAttempts({ runId: action.runId });
    return doneResult(action.type, `Reclaimed ${reclaimed.length} running task lease${reclaimed.length === 1 ? "" : "s"}.`, [
      { name: "run exists", status: "passed", evidence: action.runId },
      { name: "orphaned leases reclaimed", status: "passed", evidence: String(reclaimed.length) },
    ], reclaimedArtifacts(reclaimed));
  }

  if (action.type === "retryTask") {
    const task = harness.getTask(action.taskId);
    if (!task) {
      return blockedResult(action.type, `Task not found: ${action.taskId}`, [`task not found: ${action.taskId}`]);
    }
    harness.retryTask({ taskId: action.taskId });
    return doneResult(action.type, `Task ${action.taskId} returned to todo.`, [
      { name: "task exists", status: "passed", evidence: action.taskId },
      { name: "task status", status: "passed", evidence: "todo" },
    ], [{ kind: "task", taskId: action.taskId, runId: task.runId, status: "todo", reason: action.reason ?? null }]);
  }

  if (action.type === "markRunTodo") {
    const run = harness.getRun(action.runId);
    if (!run) {
      return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
    }
    harness.clearRunPause(action.runId);
    harness.updateRunStatus({ runId: action.runId, status: "todo" });
    return doneResult(action.type, `Run ${action.runId} marked todo.`, [
      { name: "run exists", status: "passed", evidence: action.runId },
      { name: "run status", status: "passed", evidence: "todo" },
    ], [{ kind: "run", runId: action.runId, previousStatus: run.status, status: "todo", reason: action.reason ?? null }]);
  }

  if (action.type === "updateRunContext") {
    const run = harness.getRun(action.runId);
    if (!run) {
      return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
    }
    const updated = harness.updateRun({
      runId: action.runId,
      goal: action.goal,
      status: action.status,
      contextPatch: action.contextPatch,
    });
    if (!updated) {
      return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
    }
    const patchedKeys = Object.keys(action.contextPatch).sort();
    return doneResult(action.type, `Run ${action.runId} context updated.`, [
      { name: "run exists", status: "passed", evidence: action.runId },
      { name: "patched context keys", status: "passed", evidence: patchedKeys.join(",") || "none" },
      { name: "run status", status: "passed", evidence: updated.status },
    ], [
      {
        kind: "run_context_update",
        runId: action.runId,
        previousGoal: run.goal,
        goal: updated.goal,
        previousStatus: run.status,
        status: updated.status,
        patchedKeys,
        reason: action.reason ?? null,
      },
    ]);
  }

  if (action.type === "retireRun") {
    const run = harness.getRun(action.runId);
    if (!run) {
      return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
    }
    const blockedTasks = harness.blockUnfinishedTasksForRun({ runId: action.runId, reason: action.reason });
    harness.updateRun({
      runId: action.runId,
      status: "blocked",
      contextPatch: {
        retired: true,
        retiredAt: new Date().toISOString(),
        retiredReason: action.reason,
      },
    });
    return doneResult(action.type, `Run ${action.runId} retired from the active queue.`, [
      { name: "run exists", status: "passed", evidence: action.runId },
      { name: "previous run status", status: "passed", evidence: run.status },
      { name: "retired run status", status: "passed", evidence: "blocked" },
      { name: "retired context", status: "passed", evidence: "retired=true" },
      { name: "unfinished tasks blocked", status: "passed", evidence: String(blockedTasks.length) },
    ], [
      {
        kind: "run",
        runId: action.runId,
        previousStatus: run.status,
        status: "blocked",
        retired: true,
        reason: action.reason,
        unfinishedTasksBlocked: blockedTasks.length,
      },
      ...blockedTasks.map((task) => ({
        kind: "blocked_task",
        taskId: task.taskId,
        role: task.role,
        previousStatus: task.previousStatus,
        reason: task.reason,
      })),
    ]);
  }

  if (action.type === "completeSystemTask") {
    return completeSystemTask(harness, action);
  }

  if (action.type === "integrateVerifiedRun") {
    return finalizeIntegrationOutcomeReview(harness, action, integrateVerifiedRun(harness, action, options));
  }

  if (action.type === "pushExactGitRef") {
    return pushExactGitRef(harness, action, options);
  }

  if (action.type === "createExactGitRef") {
    return createExactGitRef(harness, action, options);
  }

  if (action.type === "commitExactGitIndex") {
    return commitExactGitIndex(harness, action, options);
  }

  if (action.type === "interruptAttemptAndCreateTask") {
    return interruptAttemptAndCreateTask(harness, action);
  }

  if (action.type === "interruptRunningAttemptsAndCreateTask") {
    return interruptRunningAttemptsAndCreateTask(harness, action);
  }

  if (action.type === "acceptGuardrailProposal") {
    return acceptGuardrailProposalAction(harness, action);
  }

  if (action.type === "amendRunContract") {
    return amendRunContract(harness, action);
  }

  return prepareRunDrain(harness, action);
}

const SUBSESSION_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const SUBSESSION_MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const SUBSESSION_DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const SUBSESSION_MAX_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const SUBSESSION_MAX_PER_TASK = 3;
const SUBSESSION_MIN_PROMPT_LENGTH = 24;
const SUBSESSION_BUILT_IN_BACKEND_IDS = new Set([
  "claude-code",
  "codex",
  "codex-resumable",
  "codex-cli",
  "acpx-codex",
  "noop",
]);

function applySubsessionAction(
  harness: Harness,
  action: Extract<HarnessAction, { type: "startSubsession" | "collectSubsessions" | "cancelSubsessions" }>,
  options: HarnessActionOptions,
): HarnessActionResult {
  if (action.type === "startSubsession") {
    return applyStartSubsession(harness, action, options);
  }
  if (action.type === "collectSubsessions") {
    return applyCollectSubsessions(harness, action, options);
  }
  return applyCancelSubsessions(harness, action, options);
}

function recordSubsessionEvent(
  harness: Harness,
  action: Extract<HarnessAction, { type: "startSubsession" | "collectSubsessions" | "cancelSubsessions" }>,
  result: HarnessActionResult,
) {
  return harness.recordHarnessActionEvent({
    actionType: action.type,
    status: result.status,
    request: action as unknown as Record<string, unknown>,
    result: resultToRecord(result),
  });
}

interface SubsessionValidationContext {
  task: NonNullable<ReturnType<Harness["getTask"]>>;
  run: NonNullable<ReturnType<Harness["getRun"]>>;
  worktreePath: string;
  backend: ResolvedSubsessionBackend;
  checks: HarnessActionResult["checks"];
}

function resolveParentTaskWithRun(harness: Harness, parentTaskId: string, actionType: string) {
  const task = harness.getTask(parentTaskId);
  if (!task) {
    return {
      ok: false as const,
      result: blockedResult(actionType, `Parent task not found: ${parentTaskId}`, [`parent task not found: ${parentTaskId}`]),
    };
  }
  const run = harness.getRun(task.runId);
  if (!run) {
    return {
      ok: false as const,
      result: blockedResult(actionType, `Run not found for parent task: ${parentTaskId}`, [`run not found for parent task: ${parentTaskId}`]),
    };
  }
  return { ok: true as const, task, run };
}

function resolveParentWorktree(task: Task, run: NonNullable<ReturnType<Harness["getRun"]>>): string | null {
  if (task.worktreePath) {
    return task.worktreePath;
  }
  const projectRoot = run.projectRoot ?? null;
  return projectRoot;
}

function normalizeSubsessionName(taskId: string, suggestion: string | undefined): string {
  const slug = safeSlug(suggestion ?? "child");
  return `${taskId}__${slug}`;
}

function safeSlug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return cleaned || "child";
}

function enforceSubsessionLimit(existing: ExecutionThread[], actionType: string): { ok: true } | { ok: false; result: HarnessActionResult } {
  const running = existing.filter((thread) => thread.status === "running");
  if (running.length >= SUBSESSION_MAX_PER_TASK) {
    return {
      ok: false,
      result: blockedResult(
        actionType,
        `Parent task already has ${running.length} running subsession${running.length === 1 ? "" : "s"} (max ${SUBSESSION_MAX_PER_TASK}).`,
        [`subsession limit reached: ${running.length}/${SUBSESSION_MAX_PER_TASK}`],
      ),
    };
  }
  return { ok: true };
}

function resolveSubsessionBackend(
  run: NonNullable<ReturnType<Harness["getRun"]>>,
  requested: string | undefined,
  actionType: string,
): { ok: true; backend: ResolvedSubsessionBackend } | { ok: false; result: HarnessActionResult } {
  const id = requested ?? "claude-code";
  const fromContext = readSubsessionBackendDefinition(run.context, id);
  if (fromContext) {
    return { ok: true, backend: fromContext };
  }
  if (SUBSESSION_BUILT_IN_BACKEND_IDS.has(id)) {
    return { ok: true, backend: builtInSubsessionBackend(id) };
  }
  return {
    ok: false,
    result: blockedResult(
      actionType,
      `Unknown subsession backend: ${id}`,
      [`backend ${id} is not declared in run.context.agentBackends and is not a built-in backend`],
    ),
  };
}

function readSubsessionBackendDefinition(
  context: Record<string, unknown>,
  id: string,
): ResolvedSubsessionBackend | null {
  const map = context.agentBackends;
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return null;
  }
  const definition = (map as Record<string, unknown>)[id];
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    return null;
  }
  const record = definition as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : null;
  if (kind !== "acpx" && kind !== "codex-cli" && kind !== "codex-resumable" && kind !== "noop") {
    return null;
  }
  const backend: ResolvedSubsessionBackend = { id, kind };
  if (typeof record.agent === "string") {
    backend.agent = record.agent;
  }
  if (typeof record.agentCommand === "string") {
    backend.agentCommand = record.agentCommand;
  }
  if (typeof record.approval === "string") {
    backend.approval = record.approval;
  }
  if (typeof record.format === "string") {
    backend.format = record.format;
  }
  return backend;
}

function builtInSubsessionBackend(id: string): ResolvedSubsessionBackend {
  if (id === "claude-code") {
    return { id, kind: "acpx", agent: "claude", approval: "approve-reads" };
  }
  if (id === "codex" || id === "acpx-codex") {
    return { id, kind: "acpx", agent: "codex", approval: "approve-reads" };
  }
  if (id === "codex-resumable") {
    return { id, kind: "codex-resumable" };
  }
  if (id === "codex-cli") {
    return { id, kind: "codex-cli" };
  }
  return { id, kind: "noop" };
}

function clampSubsessionTimeouts(timeoutMs: number | undefined, idleTimeoutMs: number | undefined) {
  const timeout = clampPositive(timeoutMs, SUBSESSION_DEFAULT_TIMEOUT_MS, SUBSESSION_MAX_TIMEOUT_MS);
  const idle = clampPositive(idleTimeoutMs, SUBSESSION_DEFAULT_IDLE_TIMEOUT_MS, SUBSESSION_MAX_IDLE_TIMEOUT_MS);
  return { timeout, idle };
}

function clampPositive(value: number | undefined, defaultValue: number, maxValue: number) {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return defaultValue;
  }
  return Math.min(Math.floor(value), maxValue);
}

function listSubsessionThreadsForTask(harness: Harness, parentTaskId: string): ExecutionThread[] {
  const task = harness.getTask(parentTaskId);
  if (!task) {
    return [];
  }
  return harness
    .listExecutionThreads({ runId: task.runId })
    .filter((thread) => thread.ownerType === "subsession" && thread.taskId === parentTaskId);
}

function findParentAttemptThread(harness: Harness, task: Task): ExecutionThread | null {
  const threads = harness.listExecutionThreads({ runId: task.runId });
  const attempt = task.id ? harness.listLatestAttemptsForTasks([task.id])[0] : null;
  if (attempt) {
    const byAttempt = threads.find((thread) => thread.attemptId === attempt.attemptId && thread.ownerType !== "subsession");
    if (byAttempt) {
      return byAttempt;
    }
  }
  const byTask = threads.find((thread) => thread.taskId === task.id && thread.ownerType !== "subsession");
  return byTask ?? null;
}

function applyStartSubsession(
  harness: Harness,
  action: Extract<HarnessAction, { type: "startSubsession" }>,
  options: HarnessActionOptions,
): HarnessActionResult {
  const actionType = action.type;
  const checks: HarnessActionResult["checks"] = [];
  const validation = validateParentTaskForSubsession(harness, action.parentTaskId, actionType, checks);
  if (!validation.ok) {
    return validation.result;
  }
  const { task, run } = validation;

  const worktreePath = resolveParentWorktree(task, run);
  if (!worktreePath) {
    return blockedResult(actionType, `Parent task ${task.id} has no resolvable worktree cwd.`, [
      `parent task ${task.id} has no worktreePath and run has no projectRoot`,
    ]);
  }
  checks.push({ name: "parent worktree", status: "passed", evidence: worktreePath });

  if (action.prompt.trim().length < SUBSESSION_MIN_PROMPT_LENGTH) {
    return blockedResult(
      actionType,
      `Subsession prompt must be at least ${SUBSESSION_MIN_PROMPT_LENGTH} characters.`,
      [`prompt too short: ${action.prompt.trim().length}/${SUBSESSION_MIN_PROMPT_LENGTH}`],
    );
  }
  checks.push({ name: "prompt length", status: "passed", evidence: `${action.prompt.trim().length} chars` });

  const backendResult = resolveSubsessionBackend(run, action.backend, actionType);
  if (!backendResult.ok) {
    return backendResult.result;
  }
  const backend = backendResult.backend;
  checks.push({ name: "backend resolved", status: "passed", evidence: `${backend.id} (${backend.kind})` });

  const existing = listSubsessionThreadsForTask(harness, task.id);
  const limit = enforceSubsessionLimit(existing, actionType);
  if (!limit.ok) {
    return limit.result;
  }
  checks.push({
    name: "subsession limit",
    status: "passed",
    evidence: `${existing.filter((thread) => thread.status === "running").length}/${SUBSESSION_MAX_PER_TASK} running`,
  });

  const { timeout, idle } = clampSubsessionTimeouts(action.timeoutMs, action.idleTimeoutMs);
  checks.push({ name: "timeout policy", status: "passed", evidence: `${timeout}ms/${idle}ms idle` });

  const sessionName = normalizeSubsessionName(task.id, action.sessionName ?? action.purpose);
  const parentThread = findParentAttemptThread(harness, task);
  const latestAttempt = harness.listLatestAttemptsForTasks([task.id])[0] ?? null;
  const threadId = harness.upsertExecutionThread({
    runId: run.id,
    taskId: task.id,
    attemptId: latestAttempt?.attemptId ?? null,
    parentThreadId: parentThread?.id ?? null,
    ownerType: "subsession",
    ownerId: null,
    role: action.role ?? "subsession",
    status: "running",
    sessionName,
    agentSessionId: sessionName,
    worktreePath,
  });
  harness.updateExecutionThread({ id: threadId, ownerId: threadId, heartbeat: true });
  checks.push({ name: "thread recorded", status: "passed", evidence: threadId });

  const runner = options.subsessionRunner;
  if (!runner) {
    harness.updateExecutionThread({
      id: threadId,
      status: "blocked",
      interruptReason: "no subsessionRunner injected",
    });
    const result: HarnessActionResult = {
      status: "blocked",
      actionType,
      summary: `Subsession ${threadId} recorded but no runner was injected to start acpx.`,
      checks: [...checks, { name: "subsession runner", status: "failed", evidence: "no subsessionRunner provided" }],
      artifacts: [{
        kind: "subsession_thread",
        threadId,
        sessionName,
        parentTaskId: task.id,
        runId: run.id,
        backend,
        worktreePath,
        status: "blocked",
        reason: "no subsessionRunner injected",
      }],
      problems: ["no subsessionRunner injected; harness cannot start acpx child sessions in this process"],
    };
    return result;
  }

  let startResult: SubsessionRunnerStartResult;
  try {
    startResult = runner.start({
      threadId,
      parentTaskId: task.id,
      parentAttemptId: latestAttempt?.attemptId ?? null,
      parentThreadId: parentThread?.id ?? null,
      runId: run.id,
      worktreePath,
      sessionName,
      purpose: action.purpose,
      prompt: action.prompt,
      role: action.role ?? "subsession",
      backend,
      timeoutMs: timeout,
      idleTimeoutMs: idle,
    });
  } catch (error) {
    harness.updateExecutionThread({
      id: threadId,
      status: "blocked",
      interruptReason: errorMessage(error),
    });
    return {
      status: "blocked",
      actionType,
      summary: `Subsession start threw: ${errorMessage(error)}`,
      checks: [...checks, { name: "subsession runner start", status: "failed", evidence: errorMessage(error) }],
      artifacts: [{
        kind: "subsession_thread",
        threadId,
        sessionName,
        parentTaskId: task.id,
        runId: run.id,
        backend,
        worktreePath,
        status: "blocked",
        reason: errorMessage(error),
      }],
      problems: [`subsessionRunner.start threw: ${errorMessage(error)}`],
    };
  }

  harness.updateExecutionThread({
    id: threadId,
    status: startResult.status,
    agentSessionId: startResult.agentSessionId ?? startResult.sessionName,
    pid: startResult.pid ?? null,
  });

  const runnerReturnedDifferentThreadId = Boolean(startResult.threadId && startResult.threadId !== threadId);

  return {
    status: "done",
    actionType,
    summary: startResult.summary ?? startResult.message ?? `Subsession ${threadId} started as ${sessionName}.`,
    checks: [
      ...checks,
      {
        name: "harness thread id retained",
        status: "passed",
        evidence: runnerReturnedDifferentThreadId
          ? `ignored runner thread id ${startResult.threadId}; persisted ${threadId}`
          : threadId,
      },
      { name: "subsession started", status: "passed", evidence: startResult.sessionName },
      ...(startResult.checks ?? []),
    ],
    artifacts: [
      {
        kind: "subsession_thread",
        threadId,
        runnerThreadId: runnerReturnedDifferentThreadId ? startResult.threadId : null,
        sessionName: startResult.sessionName,
        agentSessionId: startResult.agentSessionId ?? null,
        parentTaskId: task.id,
        parentThreadId: parentThread?.id ?? null,
        runId: run.id,
        backend,
        worktreePath,
        status: startResult.status,
        timeoutMs: timeout,
        idleTimeoutMs: idle,
      },
      ...(startResult.artifacts ?? []),
    ],
    problems: startResult.problems ?? [],
  };
}

function validateParentTaskForSubsession(
  harness: Harness,
  parentTaskId: string,
  actionType: string,
  checks: HarnessActionResult["checks"],
): { ok: true; task: Task; run: NonNullable<ReturnType<Harness["getRun"]>> } | { ok: false; result: HarnessActionResult } {
  const resolved = resolveParentTaskWithRun(harness, parentTaskId, actionType);
  if (!resolved.ok) {
    return resolved;
  }
  checks.push({ name: "parent task exists", status: "passed", evidence: resolved.task.id });
  checks.push({ name: "parent run exists", status: "passed", evidence: resolved.run.id });
  return { ok: true, task: resolved.task, run: resolved.run };
}

function applyCollectSubsessions(
  harness: Harness,
  action: Extract<HarnessAction, { type: "collectSubsessions" }>,
  options: HarnessActionOptions,
): HarnessActionResult {
  const actionType = action.type;
  const checks: HarnessActionResult["checks"] = [];
  const validation = validateParentTaskForSubsession(harness, action.parentTaskId, actionType, checks);
  if (!validation.ok) {
    return validation.result;
  }
  const { task, run } = validation;

  const allChildren = listSubsessionThreadsForTask(harness, task.id);
  if (allChildren.length === 0) {
    return blockedResult(actionType, `Parent task ${task.id} has no recorded subsession threads.`, [
      `no subsession threads recorded for parent task ${task.id}`,
    ]);
  }
  checks.push({ name: "child threads", status: "passed", evidence: String(allChildren.length) });

  const filtered = action.status ? allChildren.filter((thread) => thread.status === action.status) : allChildren;
  if (filtered.length === 0) {
    return blockedResult(actionType, `No child threads matched status filter ${action.status}.`, [
      `no child threads matched status=${action.status ?? "(any)"}`,
    ]);
  }

  const backendByThread = collectSubsessionBackends(harness, filtered);
  const runner = options.subsessionRunner;
  if (!runner) {
    const artifacts = filtered.map((thread) => buildCollectedArtifactWithoutRunner(thread));
    return {
      status: "done",
      actionType,
      summary: `Collected ${filtered.length} subsession thread(s) without a runner.`,
      checks: [...checks, { name: "subsession runner", status: "failed", evidence: "no subsessionRunner provided" }],
      artifacts,
      problems: ["no subsessionRunner injected; collection is best-effort from thread state only"],
    };
  }

  const children: SubsessionRunnerCollectChild[] = filtered.map((thread) => ({
    threadId: thread.id,
    sessionName: thread.sessionName,
    agentSessionId: thread.agentSessionId,
    backend: backendByThread.get(thread.id) ?? { id: thread.role || "subsession", kind: "noop" },
    worktreePath: thread.worktreePath ?? run.projectRoot ?? "",
  }));

  let collected: SubsessionRunnerCollectResult[];
  try {
    collected = runner.collect(children);
  } catch (error) {
    return {
      status: "blocked",
      actionType,
      summary: `Subsession collect threw: ${errorMessage(error)}`,
      checks: [...checks, { name: "subsession runner collect", status: "failed", evidence: errorMessage(error) }],
      artifacts: [],
      problems: [`subsessionRunner.collect threw: ${errorMessage(error)}`],
    };
  }

  const artifacts: HarnessActionResult["artifacts"] = [];
  for (const result of collected) {
    harness.updateExecutionThread({
      id: result.threadId,
      status: result.status,
      agentSessionId: result.agentSessionId ?? null,
      heartbeat: true,
    });
    artifacts.push({
      kind: "subsession_summary",
      threadId: result.threadId,
      status: result.status,
      summary: result.summary,
      collectedAt: new Date().toISOString(),
    });
  }

  return {
    status: "done",
    actionType,
    summary: `Collected ${collected.length} subsession thread(s).`,
    checks: [...checks, { name: "subsession summaries", status: "passed", evidence: String(collected.length) }],
    artifacts,
    problems: [],
  };
}

function applyCancelSubsessions(
  harness: Harness,
  action: Extract<HarnessAction, { type: "cancelSubsessions" }>,
  options: HarnessActionOptions,
): HarnessActionResult {
  const actionType = action.type;
  const checks: HarnessActionResult["checks"] = [];
  const validation = validateParentTaskForSubsession(harness, action.parentTaskId, actionType, checks);
  if (!validation.ok) {
    return validation.result;
  }
  const { run } = validation;

  const allChildren = listSubsessionThreadsForTask(harness, action.parentTaskId);
  if (allChildren.length === 0) {
    return blockedResult(actionType, `Parent task ${action.parentTaskId} has no recorded subsession threads.`, [
      `no subsession threads recorded for parent task ${action.parentTaskId}`,
    ]);
  }
  checks.push({ name: "child threads", status: "passed", evidence: String(allChildren.length) });

  const idFilter = action.threadIds ? new Set(action.threadIds) : null;
  const targets = idFilter
    ? allChildren.filter((thread) => idFilter.has(thread.id))
    : allChildren.filter((thread) => thread.status === "running" || thread.status === "blocked");
  if (targets.length === 0) {
    return blockedResult(actionType, `No matching child threads to cancel for parent task ${action.parentTaskId}.`, [
      `no child threads matched threadIds=${idFilter ? [...idFilter].join(",") : "(running/blocked)"}`,
    ]);
  }
  checks.push({ name: "cancel targets", status: "passed", evidence: String(targets.length) });

  const runner = options.subsessionRunner;
  const problems: string[] = [];
  const artifacts: HarnessActionResult["artifacts"] = [];

  if (!runner) {
    for (const thread of targets) {
      harness.updateExecutionThread({
        id: thread.id,
        status: "interrupted",
        interruptReason: action.reason,
        heartbeat: true,
      });
      artifacts.push({
        kind: "subsession_cancel",
        threadId: thread.id,
        canceled: false,
        status: "interrupted",
        reason: action.reason,
        message: "no subsessionRunner injected; acpx cancel signal not sent",
      });
    }
    problems.push("no subsessionRunner injected; acpx cancel signal was not sent");
    return {
      status: "done",
      actionType,
      summary: `Marked ${targets.length} subsession thread(s) interrupted without acpx cancel.`,
      checks: [...checks, { name: "subsession runner", status: "failed", evidence: "no subsessionRunner provided" }],
      artifacts,
      problems,
    };
  }

  const backendByThread = collectSubsessionBackends(harness, targets);
  const children: SubsessionRunnerCancelChild[] = targets.map((thread) => ({
    threadId: thread.id,
    sessionName: thread.sessionName,
    agentSessionId: thread.agentSessionId,
    backend: backendByThread.get(thread.id) ?? { id: thread.role || "subsession", kind: "noop" },
    worktreePath: thread.worktreePath ?? run.projectRoot ?? "",
  }));

  let canceled: SubsessionRunnerCancelResult[];
  try {
    canceled = runner.cancel(children, action.reason);
  } catch (error) {
    for (const child of children) {
      harness.updateExecutionThread({
        id: child.threadId,
        status: "interrupted",
        interruptReason: action.reason,
        heartbeat: true,
      });
    }
    return {
      status: "blocked",
      actionType,
      summary: `Subsession cancel threw: ${errorMessage(error)}`,
      checks: [...checks, { name: "subsession runner cancel", status: "failed", evidence: errorMessage(error) }],
      artifacts,
      problems: [`subsessionRunner.cancel threw: ${errorMessage(error)}`],
    };
  }

  for (const result of canceled) {
    harness.updateExecutionThread({
      id: result.threadId,
      status: "interrupted",
      interruptReason: action.reason,
      heartbeat: true,
    });
    artifacts.push({
      kind: "subsession_cancel",
      threadId: result.threadId,
      canceled: result.canceled,
      reason: action.reason,
      message: result.message ?? null,
    });
    if (!result.canceled) {
      problems.push(`cancel reported failure for ${result.threadId}${result.message ? `: ${result.message}` : ""}`);
    }
  }

  return {
    status: "done",
    actionType,
    summary: `Canceled ${canceled.length} subsession thread(s).`,
    checks: [...checks, { name: "subsession cancels", status: "passed", evidence: String(canceled.length) }],
    artifacts,
    problems,
  };
}

function collectSubsessionBackends(harness: Harness, threads: ExecutionThread[]): Map<string, ResolvedSubsessionBackend> {
  const byThread = new Map<string, ResolvedSubsessionBackend>();
  const events = harness.listHarnessActionEvents({ limit: 500 });
  for (const thread of threads) {
    const event = events.find((candidate) => {
      if (candidate.actionType !== "startSubsession" || candidate.status !== "done") {
        return false;
      }
      const artifacts = Array.isArray(candidate.result.artifacts) ? candidate.result.artifacts : [];
      return artifacts.some((artifact) => {
        if (!artifact || typeof artifact !== "object") {
          return false;
        }
        const record = artifact as Record<string, unknown>;
        return record.kind === "subsession_thread" && record.threadId === thread.id;
      });
    });
    if (event) {
      const artifacts = Array.isArray(event.result.artifacts) ? event.result.artifacts : [];
      for (const artifact of artifacts) {
        const record = artifact as Record<string, unknown> | null;
        if (!record || record.kind !== "subsession_thread" || record.threadId !== thread.id) {
          continue;
        }
        const backend = record.backend as Record<string, unknown> | undefined;
        if (!backend) continue;
        byThread.set(thread.id, {
          id: typeof backend.id === "string" ? backend.id : thread.role || "subsession",
          kind: typeof backend.kind === "string" ? backend.kind : "noop",
          agent: typeof backend.agent === "string" ? backend.agent : undefined,
          agentCommand: typeof backend.agentCommand === "string" ? backend.agentCommand : undefined,
          approval: typeof backend.approval === "string" ? backend.approval : undefined,
        });
        break;
      }
    }
  }
  return byThread;
}

function buildCollectedArtifactWithoutRunner(thread: ExecutionThread) {
  return {
    kind: "subsession_summary",
    threadId: thread.id,
    status: thread.status,
    summary: thread.interruptReason ?? `thread status ${thread.status}`,
    collectedAt: new Date().toISOString(),
  };
}

function completeSystemTask(
  harness: Harness,
  action: Extract<HarnessAction, { type: "completeSystemTask" }>,
): HarnessActionResult {
  const task = harness.getTask(action.taskId);
  if (!task) {
    return blockedResult(action.type, `Task not found: ${action.taskId}`, [`task not found: ${action.taskId}`]);
  }
  const event = harness.getHarnessActionEvent({ id: action.actionEventId });
  if (!event) {
    return blockedResult(action.type, `Harness action event not found: ${action.actionEventId}`, [
      `harness action event not found: ${action.actionEventId}`,
    ]);
  }
  const resultSummary = typeof event.result.summary === "string" ? event.result.summary : `${event.actionType} ${event.status}`;
  const eventChecks = Array.isArray(event.result.checks) ? event.result.checks : [];
  const eventArtifacts = Array.isArray(event.result.artifacts) ? event.result.artifacts : [];
  const eventProblems = Array.isArray(event.result.problems)
    ? event.result.problems.filter((problem): problem is string => typeof problem === "string")
    : [];
  const output = {
    status: event.status,
    summary: `System task completed from harness action ${event.id}: ${resultSummary}`,
    changedFiles: [],
    checks: [
      { name: "harness action event", status: "passed", evidence: event.id },
      { name: "harness action type", status: "passed", evidence: event.actionType },
      ...eventChecks,
    ],
    artifacts: [
      { kind: "harness_action_event", actionEventId: event.id, actionType: event.actionType, reason: action.reason ?? null },
      ...eventArtifacts,
    ],
    problems: event.status === "blocked" ? eventProblems.length > 0 ? eventProblems : [resultSummary] : [],
  };
  const attemptId = harness.recordAttempt({
    taskId: action.taskId,
    input: {
      executor: "harness-action",
      actionType: action.type,
      actionEventId: event.id,
      reason: action.reason ?? null,
    },
    output,
  });
  return doneResult(action.type, `Recorded ${event.status} system attempt ${attemptId} for task ${action.taskId}.`, [
    { name: "task exists", status: "passed", evidence: action.taskId },
    { name: "harness action event exists", status: "passed", evidence: event.id },
    { name: "system attempt recorded", status: "passed", evidence: attemptId },
  ], [
    { kind: "attempt", attemptId, taskId: action.taskId, status: event.status },
    { kind: "harness_action_event", actionEventId: event.id, actionType: event.actionType },
  ]);
}

function integrateVerifiedRun(
  harness: Harness,
  action: Extract<HarnessAction, { type: "integrateVerifiedRun" }>,
  options: HarnessActionOptions,
): HarnessActionResult {
  const overview = harness.getRunOverview({ runId: action.runId, eventLimit: 0 });
  const run = overview.run;
  if (!run) {
    return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
  }

  const checks: HarnessActionResult["checks"] = [
    { name: "run exists", status: "passed", evidence: action.runId },
  ];
  const isExplicitWorkerIntegration = action.workerTaskId !== undefined;
  const isPreCompletionIntegration = run.status !== "done" && isExplicitWorkerIntegration;
  if (run.status !== "done" && !isExplicitWorkerIntegration) {
    return blockedIntegration(action.type, "Run is not complete.", checks, [`run status is ${run.status}`]);
  }
  checks.push({
    name: "run status",
    status: "passed",
    evidence: isPreCompletionIntegration ? `pre-completion explicit worker integration from ${run.status}` : "done",
  });

  const selectedWorker = selectIntegrationWorker(overview, action.workerTaskId);
  if (!selectedWorker) {
    return blockedIntegration(action.type, "No completed execution task with a worktree was found.", checks, [
      action.workerTaskId ? `worker task not integration-ready: ${action.workerTaskId}` : "no integration-ready worker task",
    ]);
  }
  let worker = selectedWorker;
  checks.push({ name: "execution task", status: "passed", evidence: worker.id });

  const workerSession = latestSessionForTask(overview, worker.id);
  const changedFiles = filterOuroborosRuntimePaths(
    Array.isArray(workerSession?.output.changedFiles) ? workerSession.output.changedFiles : [],
  );
  if (changedFiles.length === 0) {
    return blockedIntegration(action.type, `Worker task ${worker.id} has no changedFiles evidence.`, checks, [
      `worker ${worker.id} has no changedFiles evidence`,
    ]);
  }
  checks.push({ name: "worker changed files", status: "passed", evidence: changedFiles.join(",") });

  const verifier = selectVerifierForWorker(overview, worker.id);
  if (!verifier) {
    return blockedIntegration(action.type, `Worker task ${worker.id} has no completed verifier evidence.`, checks, [
      `worker ${worker.id} has no completed verifier evidence`,
    ]);
  }
  checks.push({ name: "verifier evidence", status: "passed", evidence: verifier.id });

  const goalReview = isPreCompletionIntegration ? null : selectCompletedGoalReview(overview);
  if (!isPreCompletionIntegration && !goalReview) {
    return blockedIntegration(action.type, "Run has no completed goal-review decision.", checks, [
      "missing goal-review runDecision complete",
    ]);
  }
  checks.push({
    name: "goal review",
    status: "passed",
    evidence: goalReview?.id ?? "deferred until run completion",
  });

  const repoPath = action.repoPath ?? run.projectRoot ?? overview.project?.rootPath;
  if (!repoPath) {
    return blockedIntegration(action.type, "No repository path was provided for integration.", checks, [
      "repoPath or run projectRoot is required",
    ]);
  }
  if (!existsSync(repoPath)) {
    return blockedIntegration(action.type, `Repository path does not exist: ${repoPath}`, checks, [
      `repo path does not exist: ${repoPath}`,
    ]);
  }
  let worktreePath = resolveWorktreePath(repoPath, worker.worktreePath);
  if (!worktreePath || !existsSync(worktreePath)) {
    return blockedIntegration(action.type, `Worker worktree does not exist: ${worker.worktreePath ?? "missing"}`, checks, [
      `worker worktree does not exist: ${worker.worktreePath ?? "missing"}`,
    ]);
  }
  checks.push({ name: "repository path", status: "passed", evidence: repoPath });
  checks.push({ name: "worktree path", status: "passed", evidence: worktreePath });

  const git = options.runGit ?? defaultGitRunner;
  const redirectedFromRepair = redirectRepairWorkerToSource({
    overview,
    worker,
    worktreePath,
    repoPath,
    git,
    changedFiles,
  });
  if (redirectedFromRepair) {
    worktreePath = redirectedFromRepair.worktreePath;
    checks.push({
      name: "repair redirected to source worktree",
      status: "passed",
      evidence: `${worker.id} -> ${redirectedFromRepair.sourceWorkerId} (${worktreePath})`,
    });
    worker = { ...worker, worktreePath };
  }

  const targetBranch = action.targetBranch ?? "main";
  const commitMessage = action.commitMessage ?? `Integrate verified task ${worker.id}`;
  const targetBranchResult = runGitStep(git, repoPath, ["branch", "--show-current"]);
  if (!targetBranchResult.ok) {
    return blockedCommand(action.type, "Could not read target repository branch.", checks, targetBranchResult);
  }
  const currentBranch = targetBranchResult.stdout.trim();
  if (currentBranch !== targetBranch) {
    return blockedIntegration(action.type, `Target repository is on ${currentBranch || "detached HEAD"}, not ${targetBranch}.`, checks, [
      `target repository branch is ${currentBranch || "detached HEAD"}`,
    ]);
  }
  checks.push({ name: "target branch", status: "passed", evidence: targetBranch });

  const targetStatus = runGitStep(git, repoPath, ["status", "--short"]);
  if (!targetStatus.ok) {
    return blockedCommand(action.type, "Could not inspect target repository status.", checks, targetStatus);
  }
  const mergeHeadCheck = runGitStep(git, repoPath, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]);
  if (mergeHeadCheck.exitCode === 0) {
    return blockedIntegration(action.type, "Target repository has an unfinished merge (MERGE_HEAD).", checks, [
      `another integration is in progress on ${targetBranch}; MERGE_HEAD exists`,
    ]);
  }
  checks.push({ name: "no concurrent merge", status: "passed", evidence: "no MERGE_HEAD" });

  const sourceBranchResult = runGitStep(git, worktreePath, ["branch", "--show-current"]);
  if (!sourceBranchResult.ok) {
    return blockedCommand(action.type, "Could not read worker worktree branch.", checks, sourceBranchResult);
  }
  const sourceBranch = sourceBranchResult.stdout.trim();
  if (!sourceBranch) {
    return blockedIntegration(action.type, "Worker worktree is not on an integration branch.", checks, [
      "source branch is detached HEAD",
    ]);
  }

  const targetCommonDirResult = runGitStep(git, repoPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!targetCommonDirResult.ok) {
    return blockedCommand(action.type, "Could not identify the target Git repository.", checks, targetCommonDirResult);
  }
  const workerCommonDirResult = runGitStep(git, worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!workerCommonDirResult.ok) {
    return blockedCommand(action.type, "Could not identify the worker Git repository.", checks, workerCommonDirResult);
  }
  let targetCommonDir: string;
  let workerCommonDir: string;
  try {
    targetCommonDir = realpathSync(targetCommonDirResult.stdout.trim());
    workerCommonDir = realpathSync(workerCommonDirResult.stdout.trim());
  } catch {
    return blockedIntegration(action.type, "Could not resolve Git repository identity.", checks, [
      "target and worker Git common directories must both resolve to existing directories",
    ]);
  }
  if (workerCommonDir !== targetCommonDir) {
    return blockedIntegration(action.type, "Worker worktree does not belong to the target repository.", checks, [
      "worker worktree does not belong to the target repository",
    ]);
  }
  checks.push({ name: "worker repository identity", status: "passed", evidence: targetCommonDir });
  const isContainedSameBranch = sourceBranch === targetBranch;

  if (targetStatus.stdout.trim().length > 0) {
    if (isContainedSameBranch) {
      return blockedIntegration(action.type, "Target repository is dirty during same-branch integration.", checks, [
        "target repository must be clean for same-branch integration",
      ]);
    }
    return integrateMaterializedTargetChanges({
      action,
      checks,
      changedFiles,
      commitMessage,
      git,
      goalReview,
      isPreCompletionIntegration,
      repoPath,
      targetBranch,
      verifier,
      worker,
      worktreePath,
    });
  }
  checks.push({ name: "target repository clean", status: "passed", evidence: "clean" });
  checks.push({ name: "source branch", status: "passed", evidence: sourceBranch });

  const workerStatus = runGitStep(git, worktreePath, ["status", "--short"]);
  if (!workerStatus.ok) {
    return blockedCommand(action.type, "Could not inspect worker worktree status.", checks, workerStatus);
  }
  if (isContainedSameBranch) {
    if (workerStatus.stdout.trim().length > 0) {
      return blockedIntegration(action.type, "Same-branch worker worktree is dirty.", checks, [
        "same-branch worker worktree must be clean",
      ]);
    }
    checks.push({ name: "worker worktree clean", status: "passed", evidence: "no uncommitted changes" });
    return recordContainedWorkerCommitIntegration({
      action,
      checks,
      git,
      goalReview,
      isPreCompletionIntegration,
      overview,
      repoPath,
      sourceBranch,
      targetBranch,
      verifier,
      worker,
      worktreePath,
      changedFiles,
    });
  }
  let workerCommit: string | null = null;
  if (workerStatus.stdout.trim().length > 0) {
    const add = runGitStep(git, worktreePath, ["add", "-A"]);
    if (!add.ok) {
      return blockedCommand(action.type, "Could not stage worker changes.", checks, add);
    }
    const commit = runGitStep(git, worktreePath, ["commit", "-m", commitMessage]);
    if (!commit.ok) {
      return blockedCommand(action.type, "Could not commit worker changes.", checks, commit);
    }
    workerCommit = readGitStdout(git, worktreePath, ["rev-parse", "--short", "HEAD"]);
    checks.push({ name: "worker commit", status: "passed", evidence: workerCommit ?? "created" });
  } else {
    checks.push({ name: "worker worktree clean", status: "passed", evidence: "no uncommitted changes" });
  }

  const aheadResult = runGitStep(git, repoPath, ["rev-list", "--count", `${targetBranch}..${sourceBranch}`]);
  if (!aheadResult.ok) {
    return blockedCommand(action.type, "Could not compare source and target branches.", checks, aheadResult);
  }
  const ahead = Number.parseInt(aheadResult.stdout.trim(), 10);
  if (!Number.isFinite(ahead) || ahead < 1) {
    const ancestor = runGitStep(git, repoPath, ["merge-base", "--is-ancestor", sourceBranch, targetBranch]);
    if (ancestor.ok) {
      const mergeCommit = readGitStdout(git, repoPath, ["rev-parse", "--short", "HEAD"]);
      checks.push({
        name: "source already merged",
        status: "passed",
        evidence: `${sourceBranch} is ancestor of ${targetBranch}`,
      });
      return doneResult(action.type, `Verified task ${worker.id} is already integrated into ${targetBranch}.`, checks, [
        {
          kind: "integration",
          mode: "branch_merge",
          runId: action.runId,
          workerTaskId: worker.id,
          verifierTaskId: verifier.id,
          goalReviewTaskId: goalReview?.id ?? null,
          preCompletion: isPreCompletionIntegration,
          repoPath,
          worktreePath,
          targetBranch,
          sourceBranch,
          workerCommit,
          mergeCommit,
          pushed: false,
          changedFiles,
          reason: action.reason ?? null,
          alreadyMerged: true,
        },
      ]);
    }
    return blockedIntegration(action.type, `Source branch ${sourceBranch} has no commits to merge into ${targetBranch}.`, checks, [
      `source branch ${sourceBranch} has no commits ahead of ${targetBranch}`,
    ]);
  }
  checks.push({ name: "source commits ahead", status: "passed", evidence: String(ahead) });

  const merge = runGitStep(git, repoPath, ["merge", "--no-ff", sourceBranch, "-m", commitMessage]);
  if (!merge.ok) {
    const mergeHead = runGitStep(git, repoPath, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]);
    if (mergeHead.exitCode === 0) {
      const abort = runGitStep(git, repoPath, ["merge", "--abort"]);
      if (!abort.ok) {
        return blockedCommand(action.type, "Merge failed and the target repository could not be restored.", checks, abort);
      }
      checks.push({
        name: "failed merge cleanup",
        status: "passed",
        evidence: `aborted conflicted merge on ${targetBranch}`,
      });
    }
    return blockedCommand(action.type, "Could not merge verified worker branch.", checks, merge);
  }
  const mergeCommit = readGitStdout(git, repoPath, ["rev-parse", "--short", "HEAD"]);
  checks.push({ name: "merge", status: "passed", evidence: mergeCommit ?? sourceBranch });

  let pushed = false;
  if (action.push === true) {
    const push = runGitStep(git, repoPath, ["push", "origin", targetBranch]);
    if (!push.ok) {
      return blockedCommand(action.type, "Could not push target branch.", checks, push);
    }
    pushed = true;
    checks.push({ name: "push", status: "passed", evidence: `origin ${targetBranch}` });
  }

  return doneResult(action.type, `Integrated verified task ${worker.id} into ${targetBranch}.`, checks, [
    {
      kind: "integration",
      mode: "branch_merge",
      runId: action.runId,
      workerTaskId: worker.id,
      verifierTaskId: verifier.id,
      goalReviewTaskId: goalReview?.id ?? null,
      preCompletion: isPreCompletionIntegration,
      repoPath,
      worktreePath,
      targetBranch,
      sourceBranch,
      workerCommit,
      mergeCommit,
      pushed,
      changedFiles,
      reason: action.reason ?? null,
    },
  ]);
}

function recordContainedWorkerCommitIntegration(input: {
  action: Extract<HarnessAction, { type: "integrateVerifiedRun" }>;
  checks: HarnessActionResult["checks"];
  changedFiles: string[];
  git: GitRunner;
  goalReview: Task | null;
  isPreCompletionIntegration: boolean;
  overview: RunOverview;
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
  verifier: Task;
  worker: Task;
  worktreePath: string;
}): HarnessActionResult {
  const workerSession = latestSessionForTask(input.overview, input.worker.id);
  const artifacts = Array.isArray(workerSession?.output.artifacts) ? workerSession.output.artifacts : [];
  const commitArtifacts = artifacts.filter((artifact) =>
    artifact !== null &&
    typeof artifact === "object" &&
    !Array.isArray(artifact) &&
    (artifact as Record<string, unknown>).kind === "git_commit"
  ) as Array<Record<string, unknown>>;
  if (commitArtifacts.length !== 1) {
    return blockedIntegration(
      input.action.type,
      `Worker task ${input.worker.id} must provide exactly one git_commit artifact.`,
      input.checks,
      [`latest done attempt has ${commitArtifacts.length} git_commit artifacts; expected exactly one git_commit artifact`],
    );
  }

  const artifact = commitArtifacts[0];
  const rawSha = artifact.sha;
  if (typeof rawSha !== "string" || !isGitCommitSha(rawSha) || /^0+$/.test(rawSha)) {
    return blockedIntegration(input.action.type, "Worker git_commit artifact has an invalid SHA.", input.checks, [
      "git_commit artifact sha must be a non-zero full 40-character SHA",
    ]);
  }
  const workerCommit = rawSha.toLowerCase();
  if (artifact.branch !== input.targetBranch) {
    return blockedIntegration(input.action.type, "Worker git_commit artifact branch does not match the target branch.", input.checks, [
      `git_commit artifact branch ${String(artifact.branch)} does not match target branch ${input.targetBranch}`,
    ]);
  }
  input.checks.push({ name: "worker commit artifact", status: "passed", evidence: workerCommit });

  const commitExists = runGitStep(input.git, input.repoPath, ["cat-file", "-e", `${workerCommit}^{commit}`]);
  if (!commitExists.ok) {
    return blockedIntegration(input.action.type, "Worker commit does not belong to the target repository.", input.checks, [
      `git_commit ${workerCommit} does not belong to the target repository`,
    ]);
  }
  input.checks.push({ name: "worker commit belongs to repository", status: "passed", evidence: workerCommit });

  const targetHeadResult = runGitStep(input.git, input.repoPath, ["rev-parse", "HEAD"]);
  if (!targetHeadResult.ok) {
    return blockedCommand(input.action.type, "Could not read target repository HEAD.", input.checks, targetHeadResult);
  }
  const targetHead = targetHeadResult.stdout.trim().toLowerCase();
  if (!isGitCommitSha(targetHead) || /^0+$/.test(targetHead)) {
    return blockedIntegration(input.action.type, "Target repository HEAD is not a full commit SHA.", input.checks, [
      "target HEAD must be a non-zero full 40-character SHA",
    ]);
  }
  const ancestor = runGitStep(input.git, input.repoPath, [
    "merge-base",
    "--is-ancestor",
    workerCommit,
    targetHead,
  ]);
  if (!ancestor.ok) {
    return blockedIntegration(input.action.type, "Worker commit is not contained by the target branch.", input.checks, [
      `git_commit ${workerCommit} is not an ancestor of target HEAD ${targetHead}`,
    ]);
  }
  input.checks.push({
    name: "worker commit contained by target HEAD",
    status: "passed",
    evidence: `${workerCommit}..${targetHead}`,
  });

  const commitFilesResult = runGitStep(input.git, input.repoPath, [
    "diff-tree",
    "--root",
    "--no-commit-id",
    "--name-only",
    "-r",
    "-z",
    workerCommit,
  ]);
  if (!commitFilesResult.ok) {
    return blockedCommand(input.action.type, "Could not read worker commit changed files.", input.checks, commitFilesResult);
  }
  const rawCommitFiles = commitFilesResult.stdout.split("\0").filter(Boolean);
  const evidenceFiles = normalizeRelativeFiles(input.changedFiles);
  const commitFiles = normalizeRelativeFiles(rawCommitFiles);
  const sortedEvidenceFiles = [...new Set(evidenceFiles)].sort();
  const sortedCommitFiles = [...new Set(commitFiles)].sort();
  if (
    evidenceFiles.length !== input.changedFiles.length ||
    commitFiles.length !== rawCommitFiles.length ||
    sortedEvidenceFiles.length !== input.changedFiles.length ||
    sortedCommitFiles.length !== rawCommitFiles.length ||
    sortedEvidenceFiles.join("\0") !== sortedCommitFiles.join("\0")
  ) {
    return blockedIntegration(input.action.type, "Worker changedFiles do not match the git_commit artifact.", input.checks, [
      `attempt changedFiles do not match git_commit ${workerCommit}`,
    ]);
  }
  input.checks.push({
    name: "worker changed files match commit",
    status: "passed",
    evidence: sortedCommitFiles.join(","),
  });

  return doneResult(
    input.action.type,
    `Verified task ${input.worker.id} commit is already integrated into ${input.targetBranch}.`,
    input.checks,
    [{
      kind: "integration",
      mode: "contained_worker_commit",
      runId: input.action.runId,
      workerTaskId: input.worker.id,
      verifierTaskId: input.verifier.id,
      goalReviewTaskId: input.goalReview?.id ?? null,
      preCompletion: input.isPreCompletionIntegration,
      repoPath: input.repoPath,
      worktreePath: input.worktreePath,
      targetBranch: input.targetBranch,
      sourceBranch: input.sourceBranch,
      workerCommit,
      mergeCommit: targetHead,
      pushed: false,
      changedFiles: input.changedFiles,
      reason: input.action.reason ?? null,
      alreadyMerged: true,
    }],
  );
}

function integrateMaterializedTargetChanges(input: {
  action: Extract<HarnessAction, { type: "integrateVerifiedRun" }>;
  checks: HarnessActionResult["checks"];
  changedFiles: string[];
  commitMessage: string;
  git: GitRunner;
  goalReview: Task | null;
  isPreCompletionIntegration: boolean;
  repoPath: string;
  targetBranch: string;
  verifier: Task;
  worker: Task;
  worktreePath: string;
}): HarnessActionResult {
  const dirtyFiles = readTargetDirtyFiles(input.git, input.repoPath);
  if (!dirtyFiles.ok) {
    return blockedCommand(input.action.type, "Could not inspect target repository dirty files.", input.checks, dirtyFiles.result);
  }

  const normalizedChangedFiles = normalizeRelativeFiles(input.changedFiles);
  if (normalizedChangedFiles.length !== input.changedFiles.length) {
    return blockedIntegration(input.action.type, "Worker changedFiles contain unsafe paths.", input.checks, [
      "changedFiles must be relative paths inside the repository",
    ]);
  }
  const changedFileSet = new Set(normalizedChangedFiles);
  const unexpected = dirtyFiles.files.filter((file) => !changedFileSet.has(file));
  if (unexpected.length > 0) {
    return blockedIntegration(input.action.type, "Target repository has uncommitted changes outside the verified worker output.", input.checks, [
      `unexpected target changes: ${unexpected.join(",")}`,
    ]);
  }

  const mismatched = dirtyFiles.files.filter((file) =>
    !sameMaterializedFile(input.repoPath, input.worktreePath, file)
  );
  if (mismatched.length > 0) {
    return blockedIntegration(input.action.type, "Target repository dirty files do not match the verified worker worktree.", input.checks, [
      `mismatched target files: ${mismatched.join(",")}`,
    ]);
  }

  input.checks.push({
    name: "target materialized worker changes",
    status: "passed",
    evidence: dirtyFiles.files.join(","),
  });

  const add = runGitStep(input.git, input.repoPath, ["add", "-A", "--", ...dirtyFiles.files]);
  if (!add.ok) {
    return blockedCommand(input.action.type, "Could not stage materialized target changes.", input.checks, add);
  }
  const commit = runGitStep(input.git, input.repoPath, ["commit", "-m", input.commitMessage]);
  if (!commit.ok) {
    return blockedCommand(input.action.type, "Could not commit materialized target changes.", input.checks, commit);
  }
  const mergeCommit = readGitStdout(input.git, input.repoPath, ["rev-parse", "--short", "HEAD"]);
  input.checks.push({ name: "target commit", status: "passed", evidence: mergeCommit ?? "created" });

  let pushed = false;
  if (input.action.push === true) {
    const push = runGitStep(input.git, input.repoPath, ["push", "origin", input.targetBranch]);
    if (!push.ok) {
      return blockedCommand(input.action.type, "Could not push target branch.", input.checks, push);
    }
    pushed = true;
    input.checks.push({ name: "push", status: "passed", evidence: `origin ${input.targetBranch}` });
  }

  const sourceBranch = readGitStdout(input.git, input.worktreePath, ["branch", "--show-current"]);
  return doneResult(input.action.type, `Committed materialized verified task ${input.worker.id} on ${input.targetBranch}.`, input.checks, [
    {
      kind: "integration",
      mode: "materialized_target_commit",
      runId: input.action.runId,
      workerTaskId: input.worker.id,
      verifierTaskId: input.verifier.id,
      goalReviewTaskId: input.goalReview?.id ?? null,
      preCompletion: input.isPreCompletionIntegration,
      repoPath: input.repoPath,
      worktreePath: input.worktreePath,
      targetBranch: input.targetBranch,
      sourceBranch,
      workerCommit: null,
      mergeCommit,
      pushed,
      changedFiles: input.changedFiles,
      materializedFiles: dirtyFiles.files,
      reason: input.action.reason ?? null,
    },
  ]);
}

type ExactGitIndexCommitAction = Extract<HarnessAction, { type: "commitExactGitIndex" }>;

type ExactGitIndexCommitStatus =
  | "committed"
  | "reused"
  | "response_loss_recovered"
  | "scope_mismatch"
  | "task_invalid"
  | "verification_invalid"
  | "repo_invalid"
  | "index_mismatch"
  | "commit_failed"
  | "cas_failed"
  | "readback_mismatch";

function commitExactGitIndex(
  harness: Harness,
  action: ExactGitIndexCommitAction,
  options: HarnessActionOptions,
): HarnessActionResult {
  const checks: HarnessActionResult["checks"] = [];
  const run = harness.getRun(action.runId);
  if (!run) {
    return failedGitIndexCommit(action, "scope_mismatch", `Run not found: ${action.runId}`, checks);
  }
  checks.push({ name: "run exists", status: "passed", evidence: action.runId });

  const frozen = frozenGitIndexCommitContract(run.context, action.contractId);
  if (!frozen || !sameGitIndexCommitContract(frozen, action)) {
    return failedGitIndexCommit(
      action,
      "scope_mismatch",
      `Git index commit request does not match frozen contract ${action.contractId}.`,
      checks,
    );
  }
  checks.push({ name: "frozen contract", status: "passed", evidence: action.contractId });

  const task = harness.getTask(action.taskId);
  if (
    !task ||
    task.runId !== action.runId ||
    task.status !== "done" ||
    ["planner", "verifier", "goal-review"].includes(task.role)
  ) {
    return failedGitIndexCommit(
      action,
      "task_invalid",
      `Task ${action.taskId} is not a completed execution task in run ${action.runId}.`,
      checks,
    );
  }
  checks.push({ name: "execution task", status: "passed", evidence: action.taskId });

  const overview = harness.getRunOverview({ runId: action.runId, eventLimit: 0 });
  const attempt = latestSessionForTask(overview, action.taskId);
  const contractPaths = action.files.map((file) => file.path);
  const changedFiles = Array.isArray(attempt?.output.changedFiles) ? attempt.output.changedFiles : [];
  if (!attempt || !sameUniqueStrings(changedFiles, contractPaths)) {
    return failedGitIndexCommit(
      action,
      "task_invalid",
      `Task ${action.taskId} done attempt changedFiles do not exactly match the frozen files.`,
      checks,
    );
  }
  checks.push({ name: "worker changedFiles", status: "passed", evidence: contractPaths.join(",") });

  const verifierEvidence = exactCommitVerifierEvidence(overview, action.taskId);
  if (!verifierEvidence.ok) {
    return failedGitIndexCommit(
      action,
      "verification_invalid",
      `Task ${action.taskId} dependency verifier evidence is incomplete or failed: ${verifierEvidence.reason}.`,
      checks,
    );
  }
  checks.push({
    name: "all verifier evidence",
    status: "passed",
    evidence: verifierEvidence.verifiers.map((verifier) => verifier.id).join(","),
  });

  if (!existsSync(action.repoPath)) {
    return failedGitIndexCommit(action, "repo_invalid", "Repository path does not exist.", checks);
  }
  const taskWorktreePath = task.worktreePath
    ? resolveWorktreePath(action.repoPath, task.worktreePath)
    : null;
  if (!taskWorktreePath || !existsSync(taskWorktreePath)) {
    return failedGitIndexCommit(action, "task_invalid", `Task ${action.taskId} has no existing worktree.`, checks);
  }
  try {
    if (realpathSync(taskWorktreePath) !== realpathSync(action.repoPath)) {
      return failedGitIndexCommit(
        action,
        "task_invalid",
        `Task ${action.taskId} worktree does not match the frozen repository path.`,
        checks,
      );
    }
  } catch {
    return failedGitIndexCommit(action, "task_invalid", `Task ${action.taskId} worktree could not be resolved.`, checks);
  }
  checks.push({ name: "task worktree", status: "passed", evidence: action.repoPath });
  const git = options.runGit ?? defaultGitRunner;
  const topLevel = safeGitStep(git, action.repoPath, ["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok) {
    return failedGitIndexCommit(action, "repo_invalid", "Could not read the repository top-level.", checks, topLevel);
  }
  let requestedTopLevel: string;
  let actualTopLevel: string;
  try {
    requestedTopLevel = realpathSync(action.repoPath);
    actualTopLevel = realpathSync(topLevel.stdout.trim());
  } catch {
    return failedGitIndexCommit(action, "repo_invalid", "Could not resolve the repository top-level.", checks);
  }
  if (requestedTopLevel !== actualTopLevel) {
    return failedGitIndexCommit(action, "repo_invalid", "repoPath must be the exact repository top-level.", checks);
  }
  checks.push({ name: "repository top-level", status: "passed", evidence: action.repoPath });

  const branch = safeGitStep(git, action.repoPath, ["branch", "--show-current"]);
  if (!branch.ok || branch.stdout.trim() !== action.branch) {
    return failedGitIndexCommit(action, "repo_invalid", `Repository is not on frozen branch ${action.branch}.`, checks, branch);
  }
  checks.push({ name: "branch", status: "passed", evidence: action.branch });

  const mergeHead = safeGitStep(git, action.repoPath, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]);
  if (mergeHead.ok) {
    return failedGitIndexCommit(action, "repo_invalid", "Repository has an unfinished merge (MERGE_HEAD).", checks);
  }
  if (mergeHead.exitCode !== 1) {
    return failedGitIndexCommit(action, "repo_invalid", "Could not verify MERGE_HEAD absence.", checks, mergeHead);
  }
  checks.push({ name: "no MERGE_HEAD", status: "passed", evidence: "absent" });

  const initialWorktreeState = exactGitWorktreeState(git, action.repoPath);
  if (!initialWorktreeState.ok) {
    return failedGitIndexCommit(
      action,
      "repo_invalid",
      initialWorktreeState.summary,
      checks,
      initialWorktreeState.result,
    );
  }
  checks.push({ name: "worktree state", status: "passed", evidence: "no unstaged, untracked, or conflicted files" });

  const head = safeGitStep(git, action.repoPath, ["rev-parse", "HEAD"]);
  if (!head.ok || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) {
    return failedGitIndexCommit(action, "repo_invalid", "Could not read repository HEAD.", checks, head);
  }
  const observedHead = head.stdout.trim();
  if (observedHead !== action.expectedParentSha) {
    const reusedTree = safeGitStep(git, action.repoPath, ["write-tree"]);
    if (!reusedTree.ok || !/^[0-9a-f]{40}$/.test(reusedTree.stdout.trim())) {
      return failedGitIndexCommit(action, "readback_mismatch", "Could not read the existing index tree.", checks, reusedTree);
    }
    const reusedReadback = verifyExactGitIndexCommit(git, action, observedHead, reusedTree.stdout.trim());
    if (!reusedReadback.ok) {
      return failedGitIndexCommit(
        action,
        "repo_invalid",
        `Repository HEAD does not equal expectedParentSha ${action.expectedParentSha}.`,
        checks,
        reusedReadback.result,
      );
    }
    checks.push(...reusedReadback.checks);
    return verifiedGitIndexCommit(
      action,
      verifierEvidence.verifiers.map((verifier) => verifier.id),
      observedHead,
      reusedTree.stdout.trim(),
      "reused",
      checks,
    );
  }
  checks.push({ name: "expected parent", status: "passed", evidence: action.expectedParentSha });

  const staged = safeGitStep(git, action.repoPath, [
    "diff",
    "--cached",
    "--name-status",
    "-z",
    "--diff-filter=ACDMRTUXB",
    action.expectedParentSha,
    "--",
  ]);
  if (!staged.ok) {
    return failedGitIndexCommit(action, "repo_invalid", "Could not inspect the staged index delta.", checks, staged);
  }
  const stagedFiles = parseNameStatusZ(staged.stdout);
  if (!stagedFiles || !sameExactIndexFileSet(stagedFiles, action.files)) {
    return failedGitIndexCommit(action, "index_mismatch", "Staged paths and statuses do not match the frozen additions.", checks);
  }

  for (const file of action.files) {
    const entry = safeGitStep(git, action.repoPath, ["ls-files", "--stage", "-z", "--", file.path]);
    if (!entry.ok || !sameExactIndexEntry(entry.stdout, file)) {
      return failedGitIndexCommit(
        action,
        "index_mismatch",
        `Staged mode or blob does not match the frozen addition ${file.path}.`,
        checks,
        entry,
      );
    }
    const blob = safeGitStep(git, action.repoPath, ["cat-file", "-e", `${file.blobOid}^{blob}`]);
    if (!blob.ok) {
      return failedGitIndexCommit(
        action,
        "index_mismatch",
        `Frozen blob OID is not a local blob for ${file.path}.`,
        checks,
        blob,
      );
    }
  }
  checks.push({ name: "exact staged index", status: "passed", evidence: contractPaths.join(",") });

  const tree = safeGitStep(git, action.repoPath, ["write-tree"]);
  if (!tree.ok || !/^[0-9a-f]{40}$/.test(tree.stdout.trim())) {
    return failedGitIndexCommit(action, "commit_failed", "Could not write the exact index tree.", checks, tree);
  }
  const treeOid = tree.stdout.trim();
  const exactTree = verifyExactGitIndexTree(git, action, treeOid);
  if (!exactTree.ok) {
    return failedGitIndexCommit(
      action,
      "index_mismatch",
      "Written index tree does not exactly match the frozen additions.",
      checks,
      exactTree.result,
    );
  }
  checks.push(...exactTree.checks);
  const commit = safeGitStep(git, action.repoPath, [
    "-c",
    "commit.gpgSign=false",
    "commit-tree",
    treeOid,
    "-p",
    action.expectedParentSha,
    "-m",
    action.commitMessage,
  ]);
  const commitSha = commit.stdout.trim();
  if (!commit.ok || !/^[0-9a-f]{40}$/.test(commitSha)) {
    return failedGitIndexCommit(action, "commit_failed", "Could not create the exact unsigned commit object.", checks, commit);
  }
  checks.push({ name: "commit object", status: "passed", evidence: commitSha });

  const lateIndexTree = safeGitStep(git, action.repoPath, ["write-tree"]);
  if (!lateIndexTree.ok || lateIndexTree.stdout.trim() !== treeOid) {
    return failedGitIndexCommit(
      action,
      "index_mismatch",
      "Repository index tree changed after commit creation; branch was not updated.",
      checks,
      lateIndexTree,
    );
  }
  const lateWorktreeState = exactGitWorktreeState(git, action.repoPath);
  if (!lateWorktreeState.ok) {
    return failedGitIndexCommit(
      action,
      "repo_invalid",
      `Repository state changed after commit creation; branch was not updated. ${lateWorktreeState.summary}`,
      checks,
      lateWorktreeState.result,
    );
  }
  checks.push({ name: "pre-CAS index and worktree", status: "passed", evidence: treeOid });

  const update = safeGitStep(git, action.repoPath, [
    "update-ref",
    `refs/heads/${action.branch}`,
    commitSha,
    action.expectedParentSha,
  ]);
  const headAfter = safeGitStep(git, action.repoPath, ["rev-parse", "HEAD"]);
  if (!headAfter.ok || headAfter.stdout.trim() !== commitSha) {
    return failedGitIndexCommit(
      action,
      update.ok ? "readback_mismatch" : "cas_failed",
      update.ok ? "CAS update returned success but HEAD readback mismatched." : "CAS update failed.",
      checks,
      update.ok ? headAfter : update,
    );
  }

  const readback = verifyExactGitIndexCommit(git, action, commitSha, treeOid);
  if (!readback.ok) {
    return failedGitIndexCommit(action, "readback_mismatch", "Independent commit readback failed.", checks, readback.result);
  }
  checks.push(...readback.checks);
  return verifiedGitIndexCommit(
    action,
    verifierEvidence.verifiers.map((verifier) => verifier.id),
    commitSha,
    treeOid,
    update.ok ? "committed" : "response_loss_recovered",
    checks,
  );
}

function frozenGitIndexCommitContract(context: Record<string, unknown>, contractId: string) {
  const contracts = context.gitIndexCommitContracts;
  if (!contracts || typeof contracts !== "object" || Array.isArray(contracts)) {
    return null;
  }
  const value = (contracts as Record<string, unknown>)[contractId];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameGitIndexCommitContract(frozen: Record<string, unknown>, action: ExactGitIndexCommitAction) {
  const fields = ["branch", "commitMessage", "expectedParentSha", "files", "repoPath", "runId", "taskId"];
  if (Object.keys(frozen).sort().join("\0") !== fields.join("\0")) {
    return false;
  }
  return frozen.runId === action.runId &&
    frozen.taskId === action.taskId &&
    frozen.repoPath === action.repoPath &&
    frozen.branch === action.branch &&
    frozen.expectedParentSha === action.expectedParentSha &&
    frozen.commitMessage === action.commitMessage &&
    JSON.stringify(frozen.files) === JSON.stringify(action.files);
}

function sameUniqueStrings(actual: unknown[], expected: string[]) {
  if (actual.some((value) => typeof value !== "string")) {
    return false;
  }
  const strings = actual as string[];
  return strings.length === new Set(strings).size &&
    strings.length === expected.length &&
    [...strings].sort().join("\0") === [...expected].sort().join("\0");
}

function exactCommitVerifierEvidence(
  overview: RunOverview,
  workerTaskId: string,
): { ok: true; verifiers: Task[] } | { ok: false; reason: string } {
  const verifiers = overview.tasks.filter((task) =>
    task.role === "verifier" && task.dependsOn.includes(workerTaskId)
  );
  if (verifiers.length === 0) {
    return { ok: false, reason: "no dependency verifier exists" };
  }
  for (const verifier of verifiers) {
    if (verifier.status !== "done") {
      return { ok: false, reason: `verifier ${verifier.id} task status is ${verifier.status}` };
    }
    const latestAttempt = [...overview.sessions].reverse().find((session) => session.taskId === verifier.id);
    if (!latestAttempt || latestAttempt.status !== "done" || latestAttempt.output.status !== "done") {
      return { ok: false, reason: `verifier ${verifier.id} latest attempt is not done` };
    }
    const checks = Array.isArray(latestAttempt.output.checks) ? latestAttempt.output.checks : [];
    if (checks.some(isFailedCheck)) {
      return { ok: false, reason: `verifier ${verifier.id} has failed checks` };
    }
  }
  return { ok: true, verifiers };
}

function parseNameStatusZ(value: string) {
  const fields = value.split("\0");
  if (fields[fields.length - 1] === "") {
    fields.pop();
  }
  if (fields.length % 2 !== 0) {
    return null;
  }
  const entries: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < fields.length; index += 2) {
    entries.push({ status: fields[index]!, path: fields[index + 1]! });
  }
  return entries;
}

function sameExactIndexFileSet(actual: Array<{ status: string; path: string }>, expected: ExactGitIndexFile[]) {
  return actual.length === expected.length && expected.every((file) =>
    actual.some((entry) => entry.status === file.status && entry.path === file.path)
  );
}

function sameExactIndexEntry(value: string, file: ExactGitIndexFile) {
  const match = value.match(/^([0-9]{6}) ([0-9a-f]{40}) ([0-3])\t([^\0]+)\0$/);
  return Boolean(
    match &&
    match[1] === file.mode &&
    match[2] === file.blobOid &&
    match[3] === "0" &&
    match[4] === file.path,
  );
}

function exactGitWorktreeState(
  git: GitRunner,
  repoPath: string,
):
  | { ok: true }
  | { ok: false; summary: string; result: ReturnType<typeof safeGitStep> } {
  const unstaged = safeGitStep(git, repoPath, ["diff", "--name-only", "-z"]);
  if (!unstaged.ok || unstaged.stdout.length > 0) {
    return { ok: false, summary: "Repository has unstaged changes.", result: unstaged };
  }
  const untracked = safeGitStep(git, repoPath, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!untracked.ok || untracked.stdout.length > 0) {
    return { ok: false, summary: "Repository has untracked files.", result: untracked };
  }
  const conflicts = safeGitStep(git, repoPath, ["ls-files", "--unmerged", "-z"]);
  if (!conflicts.ok || conflicts.stdout.length > 0) {
    return { ok: false, summary: "Repository index contains conflicts.", result: conflicts };
  }
  return { ok: true };
}

function verifyExactGitIndexTree(
  git: GitRunner,
  action: ExactGitIndexCommitAction,
  treeOid: string,
): { ok: true; checks: HarnessActionResult["checks"] } | { ok: false; result?: ReturnType<typeof safeGitStep> } {
  const changed = safeGitStep(git, action.repoPath, [
    "diff-tree",
    "--no-commit-id",
    "--name-status",
    "-r",
    "-z",
    action.expectedParentSha,
    treeOid,
    "--",
  ]);
  const changedFiles = changed.ok ? parseNameStatusZ(changed.stdout) : null;
  if (!changed.ok || !changedFiles || !sameExactIndexFileSet(changedFiles, action.files)) {
    return { ok: false, result: changed };
  }
  for (const file of action.files) {
    const entry = safeGitStep(git, action.repoPath, ["ls-tree", "-z", treeOid, "--", file.path]);
    const match = entry.stdout.match(/^([0-9]{6}) blob ([0-9a-f]{40})\t([^\0]+)\0$/);
    if (!entry.ok || !match || match[1] !== file.mode || match[2] !== file.blobOid || match[3] !== file.path) {
      return { ok: false, result: entry };
    }
  }
  return {
    ok: true,
    checks: [{
      name: "exact tree readback",
      status: "passed",
      evidence: `${treeOid}:${action.files.map((file) => file.path).join(",")}`,
    }],
  };
}

function verifyExactGitIndexCommit(
  git: GitRunner,
  action: ExactGitIndexCommitAction,
  commitSha: string,
  expectedTree: string,
): { ok: true; checks: HarnessActionResult["checks"] } | { ok: false; result?: ReturnType<typeof safeGitStep> } {
  const commit = safeGitStep(git, action.repoPath, ["cat-file", "-p", commitSha]);
  if (!commit.ok) {
    return { ok: false, result: commit };
  }
  const separator = commit.stdout.indexOf("\n\n");
  if (separator < 0) {
    return { ok: false, result: { ...commit, ok: false, exitCode: 1, stderr: "commit readback has no message separator" } };
  }
  const headers = commit.stdout.slice(0, separator).split("\n");
  const storedMessage = commit.stdout.slice(separator + 2);
  const treeHeaders = headers.filter((line) => line.startsWith("tree "));
  const parentHeaders = headers.filter((line) => line.startsWith("parent "));
  const hasSignature = headers.some((line) => line.startsWith("gpgsig "));
  if (
    treeHeaders.length !== 1 || treeHeaders[0] !== `tree ${expectedTree}` ||
    parentHeaders.length !== 1 || parentHeaders[0] !== `parent ${action.expectedParentSha}` ||
    hasSignature ||
    storedMessage !== `${action.commitMessage}\n`
  ) {
    return { ok: false, result: { ...commit, ok: false, exitCode: 1, stdout: "", stderr: "commit parent tree message or signature readback mismatch" } };
  }

  const exactTree = verifyExactGitIndexTree(git, action, expectedTree);
  if (!exactTree.ok) {
    return exactTree;
  }
  const clean = safeGitStep(git, action.repoPath, ["status", "--porcelain=v1", "-z"]);
  if (!clean.ok || clean.stdout.length > 0) {
    return { ok: false, result: clean };
  }
  return {
    ok: true,
    checks: [
      { name: "independent commit readback", status: "passed", evidence: commitSha },
      { name: "parent tree message signature", status: "passed", evidence: "exact unsigned commit" },
      ...exactTree.checks,
      { name: "worktree clean", status: "passed", evidence: "clean" },
    ],
  };
}

function verifiedGitIndexCommit(
  action: ExactGitIndexCommitAction,
  verifierTaskIds: string[],
  sha: string,
  tree: string,
  status: Extract<ExactGitIndexCommitStatus, "committed" | "reused" | "response_loss_recovered">,
  checks: HarnessActionResult["checks"],
) {
  const verifierTaskId = verifierTaskIds[verifierTaskIds.length - 1]!;
  return doneResult(action.type, `Exact Git index commit verified on ${action.branch}.`, checks, [
    {
      kind: "git_commit",
      status,
      runId: action.runId,
      taskId: action.taskId,
      contractId: action.contractId,
      repoPath: action.repoPath,
      branch: action.branch,
      sha,
      parentSha: action.expectedParentSha,
      tree,
      files: action.files,
      signed: false,
      verifiedBy: "independent_readback",
    },
    {
      kind: "integration",
      mode: "exact_git_index_commit",
      runId: action.runId,
      workerTaskId: action.taskId,
      verifierTaskId,
      verifierTaskIds,
      repoPath: action.repoPath,
      targetBranch: action.branch,
      mergeCommit: sha,
      changedFiles: action.files.map((file) => file.path),
      alreadyMerged: true,
      pushed: false,
    },
  ]);
}

function failedGitIndexCommit(
  action: ExactGitIndexCommitAction,
  status: Exclude<ExactGitIndexCommitStatus, "committed" | "reused" | "response_loss_recovered">,
  summary: string,
  checks: HarnessActionResult["checks"],
  result?: ReturnType<typeof safeGitStep>,
): HarnessActionResult {
  const error = sanitizeGitRemoteText(result?.stderr.trim() || summary);
  return {
    status: "blocked",
    actionType: action.type,
    summary,
    checks: [...checks, { name: "exact Git index commit", status: "failed", evidence: status }],
    artifacts: [{
      kind: "git_index_commit",
      outcome: "failed",
      status,
      runId: action.runId,
      taskId: action.taskId,
      contractId: action.contractId,
      repoPath: action.repoPath,
      branch: action.branch,
      error,
    }],
    problems: [error],
  };
}

type ExactGitRemoteWriteAction = Extract<HarnessAction, { type: "pushExactGitRef" }>;

type ExactGitRemoteWriteStatus =
  | "pushed"
  | "reused"
  | "response_loss_recovered"
  | "scope_mismatch"
  | "repo_invalid"
  | "remote_read_failed"
  | "remote_state_mismatch"
  | "non_fast_forward"
  | "push_failed"
  | "readback_mismatch";

function pushExactGitRef(
  harness: Harness,
  action: ExactGitRemoteWriteAction,
  options: HarnessActionOptions,
): HarnessActionResult {
  const checks: HarnessActionResult["checks"] = [];
  const run = harness.getRun(action.runId);
  if (!run) {
    return failedGitRemoteWrite(action, "scope_mismatch", `Run not found: ${action.runId}`, checks);
  }
  checks.push({ name: "run exists", status: "passed", evidence: action.runId });

  const frozen = frozenGitRemoteWriteContract(run.context, action.contractId);
  if (!frozen || !sameGitRemoteWriteContract(frozen, action)) {
    return failedGitRemoteWrite(
      action,
      "scope_mismatch",
      `Git remote write request does not match frozen contract ${action.contractId}.`,
      checks,
    );
  }
  checks.push({ name: "frozen write contract", status: "passed", evidence: action.contractId });

  if (!existsSync(action.repoPath)) {
    return failedGitRemoteWrite(action, "repo_invalid", `Repository path does not exist: ${action.repoPath}`, checks);
  }

  const git = options.runGit ?? defaultGitRunner;
  const remoteUrl = safeGitStep(git, action.repoPath, ["remote", "get-url", "--push", "origin"]);
  if (!remoteUrl.ok) {
    return failedGitRemoteWrite(action, "repo_invalid", "Could not read the origin push URL.", checks, remoteUrl);
  }
  const remoteIdentity = parseGitRemoteIdentity(remoteUrl.stdout.trim());
  if (
    !remoteIdentity ||
    remoteIdentity.host !== action.remoteHost ||
    remoteIdentity.repository !== action.repository
  ) {
    return failedGitRemoteWrite(
      action,
      "scope_mismatch",
      "Configured origin does not match the frozen host and repository.",
      checks,
    );
  }
  checks.push({
    name: "origin scope",
    status: "passed",
    evidence: `${action.remoteHost}/${action.repository}`,
  });

  const head = safeGitStep(git, action.repoPath, ["rev-parse", "HEAD"]);
  if (!head.ok || head.stdout.trim().toLowerCase() !== action.newSha) {
    return failedGitRemoteWrite(
      action,
      "repo_invalid",
      `Repository HEAD must equal frozen newSha ${action.newSha}.`,
      checks,
      head,
    );
  }
  const commit = safeGitStep(git, action.repoPath, ["cat-file", "-e", `${action.newSha}^{commit}`]);
  if (!commit.ok) {
    return failedGitRemoteWrite(action, "repo_invalid", "Frozen newSha is not a local commit.", checks, commit);
  }
  checks.push({ name: "local commit", status: "passed", evidence: action.newSha });

  const ancestor = safeGitStep(git, action.repoPath, [
    "merge-base",
    "--is-ancestor",
    action.expectedOldSha,
    action.newSha,
  ]);
  if (!ancestor.ok) {
    return failedGitRemoteWrite(
      action,
      "non_fast_forward",
      "Frozen newSha is not a fast-forward descendant of expectedOldSha.",
      checks,
    );
  }
  checks.push({
    name: "fast-forward ancestry",
    status: "passed",
    evidence: `${action.expectedOldSha}..${action.newSha}`,
  });

  const before = readExactRemoteRef(git, action);
  if (!before.ok) {
    return failedGitRemoteWrite(action, "remote_read_failed", "Could not read the exact remote ref.", checks, before.result);
  }
  if (before.sha === action.newSha) {
    checks.push({ name: "independent remote readback", status: "passed", evidence: action.newSha });
    return verifiedGitRemoteWrite(action, "reused", checks);
  }
  if (before.sha !== action.expectedOldSha) {
    return failedGitRemoteWrite(
      action,
      "remote_state_mismatch",
      `Remote ref does not equal expectedOldSha ${action.expectedOldSha}.`,
      checks,
      undefined,
      before.sha,
    );
  }
  checks.push({ name: "remote expected old SHA", status: "passed", evidence: before.sha });

  const push = safeGitStep(git, action.repoPath, [
    "push",
    "--no-verify",
    "--porcelain",
    "origin",
    `${action.newSha}:${action.ref}`,
  ]);
  const after = readExactRemoteRef(git, action);
  if (after.ok && after.sha === action.newSha) {
    checks.push({ name: "independent remote readback", status: "passed", evidence: after.sha });
    return verifiedGitRemoteWrite(action, push.ok ? "pushed" : "response_loss_recovered", checks);
  }
  if (!after.ok) {
    return failedGitRemoteWrite(
      action,
      push.ok ? "readback_mismatch" : "push_failed",
      push.ok
        ? "Push returned success but independent remote readback failed."
        : "Push failed and independent remote readback could not confirm recovery.",
      checks,
      push.ok ? after.result : push,
    );
  }
  if (!push.ok && after.sha !== action.expectedOldSha) {
    return failedGitRemoteWrite(
      action,
      "non_fast_forward",
      "Remote ref changed during the exact push.",
      checks,
      push,
      after.sha,
    );
  }
  return failedGitRemoteWrite(
    action,
    push.ok ? "readback_mismatch" : "push_failed",
    push.ok
      ? "Push returned success but independent remote readback did not match newSha."
      : "Push failed and the remote ref still equals expectedOldSha.",
    checks,
    push,
    after.sha,
  );
}

function frozenGitRemoteWriteContract(context: Record<string, unknown>, contractId: string) {
  const contracts = context.gitRemoteWriteContracts;
  if (!contracts || typeof contracts !== "object" || Array.isArray(contracts)) {
    return null;
  }
  const value = (contracts as Record<string, unknown>)[contractId];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function sameGitRemoteWriteContract(frozen: Record<string, unknown>, action: ExactGitRemoteWriteAction) {
  const fields = ["expectedOldSha", "newSha", "ref", "remoteHost", "repoPath", "repository"];
  if (Object.keys(frozen).sort().join("\0") !== fields.join("\0")) {
    return false;
  }
  return frozen.repoPath === action.repoPath &&
    frozen.remoteHost === action.remoteHost &&
    frozen.repository === action.repository &&
    frozen.ref === action.ref &&
    frozen.expectedOldSha === action.expectedOldSha &&
    frozen.newSha === action.newSha;
}

function parseGitRemoteIdentity(value: string): { host: string; repository: string } | null {
  let host = "";
  let path = "";
  try {
    if (value.includes("://")) {
      const url = new URL(value);
      host = url.hostname.toLowerCase();
      path = url.pathname;
    } else {
      const scp = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
      if (!scp) {
        return null;
      }
      host = scp[1].toLowerCase();
      path = scp[2];
    }
  } catch {
    return null;
  }
  const repository = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  if (!isGitRemoteHost(host) || !isGitRepository(repository)) {
    return null;
  }
  return { host, repository };
}

function readExactRemoteRef(
  git: GitRunner,
  action: ExactGitRemoteWriteAction,
): { ok: true; sha: string } | { ok: false; result: ReturnType<typeof safeGitStep> } {
  const result = safeGitStep(git, action.repoPath, ["ls-remote", "--exit-code", "origin", action.ref]);
  if (!result.ok) {
    return { ok: false, result };
  }
  const rows = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 2);
  if (rows.length !== 1 || rows[0][1] !== action.ref || !isGitCommitSha(rows[0][0])) {
    return {
      ok: false,
      result: {
        ...result,
        ok: false,
        exitCode: 1,
        stderr: "exact ls-remote readback returned an invalid or ambiguous ref",
      },
    };
  }
  return { ok: true, sha: rows[0][0].toLowerCase() };
}

function verifiedGitRemoteWrite(
  action: ExactGitRemoteWriteAction,
  status: Extract<ExactGitRemoteWriteStatus, "pushed" | "reused" | "response_loss_recovered">,
  checks: HarnessActionResult["checks"],
) {
  return doneResult(action.type, `Exact Git remote write verified for ${action.ref}.`, checks, [
    gitRemoteWriteArtifact(action, "verified", status),
  ]);
}

function failedGitRemoteWrite(
  action: ExactGitRemoteWriteAction,
  status: Exclude<ExactGitRemoteWriteStatus, "pushed" | "reused" | "response_loss_recovered">,
  summary: string,
  checks: HarnessActionResult["checks"],
  result?: ReturnType<typeof safeGitStep>,
  observedSha?: string,
): HarnessActionResult {
  const error = sanitizeGitRemoteText(
    result?.stderr.trim() || result?.stdout.trim() || summary,
  );
  return {
    status: "blocked",
    actionType: action.type,
    summary,
    checks: [
      ...checks,
      { name: "exact Git remote write", status: "failed", evidence: status },
    ],
    artifacts: [
      {
        ...gitRemoteWriteArtifact(action, "failed", status),
        ...(observedSha ? { observedSha } : {}),
        error,
      },
    ],
    problems: [error],
  };
}

function gitRemoteWriteArtifact(
  action: ExactGitRemoteWriteAction,
  outcome: "verified" | "failed",
  status: ExactGitRemoteWriteStatus,
) {
  return {
    kind: "git_remote_write",
    outcome,
    status,
    runId: action.runId,
    contractId: action.contractId,
    repoPath: action.repoPath,
    remoteHost: action.remoteHost,
    repository: action.repository,
    ref: action.ref,
    expectedOldSha: action.expectedOldSha,
    newSha: action.newSha,
    verifiedBy: outcome === "verified" ? "independent_readback" : null,
    reason: action.reason ?? null,
  };
}

type ExactGitRefCreationAction = Extract<HarnessAction, { type: "createExactGitRef" }>;

type ExactGitRefCreationStatus =
  | "created"
  | "reused"
  | "response_loss_recovered"
  | "scope_mismatch"
  | "repo_invalid"
  | "remote_read_failed"
  | "conflict"
  | "push_failed"
  | "readback_mismatch";

function createExactGitRef(
  harness: Harness,
  action: ExactGitRefCreationAction,
  options: HarnessActionOptions,
): HarnessActionResult {
  const checks: HarnessActionResult["checks"] = [];
  const run = harness.getRun(action.runId);
  if (!run) {
    return failedGitRefCreation(action, "scope_mismatch", `Run not found: ${action.runId}`, checks);
  }
  checks.push({ name: "run exists", status: "passed", evidence: action.runId });

  const frozen = frozenGitRefCreationContract(run.context, action.contractId);
  if (!frozen || !sameGitRefCreationContract(frozen, action)) {
    return failedGitRefCreation(
      action,
      "scope_mismatch",
      `Git ref creation request does not match frozen contract ${action.contractId}.`,
      checks,
    );
  }
  checks.push({ name: "frozen creation contract", status: "passed", evidence: action.contractId });

  if (!existsSync(action.repoPath)) {
    return failedGitRefCreation(action, "repo_invalid", `Repository path does not exist: ${action.repoPath}`, checks);
  }

  const git = options.runGit ?? defaultGitRunner;
  const remoteUrl = safeBoundedGitRemoteStep(git, action.repoPath, ["remote", "get-url", "--push", "origin"]);
  if (!remoteUrl.ok) {
    return failedGitRefCreation(action, "repo_invalid", "Could not read the origin push URL.", checks, remoteUrl);
  }
  const identity = parseGitRemoteIdentity(remoteUrl.stdout.trim());
  if (!identity || identity.host !== action.remoteHost || identity.repository !== action.repository) {
    return failedGitRefCreation(
      action,
      "scope_mismatch",
      "Configured origin does not match the frozen host and repository.",
      checks,
    );
  }
  checks.push({ name: "origin scope", status: "passed", evidence: `${action.remoteHost}/${action.repository}` });

  const head = safeBoundedGitRemoteStep(git, action.repoPath, ["rev-parse", "HEAD"]);
  if (!head.ok || head.stdout.trim().toLowerCase() !== action.newSha) {
    return failedGitRefCreation(
      action,
      "repo_invalid",
      `Repository HEAD must equal frozen newSha ${action.newSha}.`,
      checks,
      head,
    );
  }
  const commit = safeBoundedGitRemoteStep(git, action.repoPath, ["cat-file", "-e", `${action.newSha}^{commit}`]);
  if (!commit.ok) {
    return failedGitRefCreation(action, "repo_invalid", "Frozen newSha is not a local commit.", checks, commit);
  }
  checks.push({ name: "local commit", status: "passed", evidence: action.newSha });

  const before = readExactRemoteRefAllowAbsent(git, action);
  if (!before.ok) {
    return failedGitRefCreation(action, "remote_read_failed", "Could not read the exact remote ref.", checks, before.result);
  }
  if (before.sha === action.newSha) {
    checks.push({ name: "independent remote readback", status: "passed", evidence: action.newSha });
    return verifiedGitRefCreation(action, "reused", checks);
  }
  if (before.sha !== null) {
    return failedGitRefCreation(
      action,
      "conflict",
      "Remote ref already exists at a different SHA.",
      checks,
      undefined,
      before.sha,
    );
  }
  checks.push({ name: "remote ref absent", status: "passed", evidence: action.ref });

  const push = safeBoundedGitRemoteStep(git, action.repoPath, [
    "push",
    "--no-verify",
    "--porcelain",
    "origin",
    `${action.newSha}:${action.ref}`,
  ]);
  const after = readExactRemoteRefAllowAbsent(git, action);
  if (after.ok && after.sha === action.newSha) {
    checks.push({ name: "independent remote readback", status: "passed", evidence: action.newSha });
    return verifiedGitRefCreation(action, push.ok ? "created" : "response_loss_recovered", checks);
  }
  if (!after.ok) {
    return failedGitRefCreation(
      action,
      push.ok ? "readback_mismatch" : "push_failed",
      push.ok
        ? "Push returned success but independent remote readback failed."
        : "Push failed and independent remote readback could not confirm recovery.",
      checks,
      push.ok ? after.result : push,
    );
  }
  return failedGitRefCreation(
    action,
    push.ok ? "readback_mismatch" : "push_failed",
    push.ok
      ? "Push returned success but independent remote readback did not match newSha."
      : "Push failed and independent remote readback did not confirm newSha.",
    checks,
    push,
    after.sha ?? undefined,
  );
}

function frozenGitRefCreationContract(context: Record<string, unknown>, contractId: string) {
  const contracts = context.gitRefCreationContracts;
  if (!contracts || typeof contracts !== "object" || Array.isArray(contracts)) {
    return null;
  }
  const value = (contracts as Record<string, unknown>)[contractId];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function sameGitRefCreationContract(frozen: Record<string, unknown>, action: ExactGitRefCreationAction) {
  const fields = ["expectedAbsent", "newSha", "ref", "remoteHost", "repoPath", "repository"];
  if (Object.keys(frozen).sort().join("\0") !== fields.join("\0")) {
    return false;
  }
  return frozen.repoPath === action.repoPath &&
    frozen.remoteHost === action.remoteHost &&
    frozen.repository === action.repository &&
    frozen.ref === action.ref &&
    frozen.newSha === action.newSha &&
    frozen.expectedAbsent === true;
}

function readExactRemoteRefAllowAbsent(
  git: GitRunner,
  action: ExactGitRefCreationAction,
): { ok: true; sha: string | null } | { ok: false; result: ReturnType<typeof safeGitStep> } {
  const result = safeBoundedGitRemoteStep(git, action.repoPath, ["ls-remote", "--exit-code", "origin", action.ref]);
  if (!result.ok) {
    if (result.exitCode === 2 && result.stdout.trim() === "" && result.stderr.trim() === "") {
      return { ok: true, sha: null };
    }
    return { ok: false, result };
  }
  const rows = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 2);
  if (rows.length !== 1 || rows[0][1] !== action.ref || !isGitCommitSha(rows[0][0])) {
    return {
      ok: false,
      result: {
        ...result,
        ok: false,
        exitCode: 1,
        stderr: "exact ls-remote readback returned an invalid or ambiguous ref",
      },
    };
  }
  return { ok: true, sha: rows[0][0].toLowerCase() };
}

function verifiedGitRefCreation(
  action: ExactGitRefCreationAction,
  status: Extract<ExactGitRefCreationStatus, "created" | "reused" | "response_loss_recovered">,
  checks: HarnessActionResult["checks"],
) {
  return doneResult(action.type, `Exact Git ref creation verified for ${action.ref}.`, checks, [
    gitRefCreationArtifact(action, "verified", status),
  ]);
}

function failedGitRefCreation(
  action: ExactGitRefCreationAction,
  status: Exclude<ExactGitRefCreationStatus, "created" | "reused" | "response_loss_recovered">,
  summary: string,
  checks: HarnessActionResult["checks"],
  result?: ReturnType<typeof safeGitStep>,
  observedSha?: string,
): HarnessActionResult {
  const error = sanitizeGitRemoteText(result?.stderr.trim() || result?.stdout.trim() || summary);
  return {
    status: "blocked",
    actionType: action.type,
    summary,
    checks: [...checks, { name: "exact Git ref creation", status: "failed", evidence: status }],
    artifacts: [{
      ...gitRefCreationArtifact(action, "failed", status),
      ...(observedSha ? { observedSha } : {}),
      error,
    }],
    problems: [error],
  };
}

function gitRefCreationArtifact(
  action: ExactGitRefCreationAction,
  outcome: "verified" | "failed",
  status: ExactGitRefCreationStatus,
) {
  return {
    kind: "git_ref_creation",
    outcome,
    status,
    runId: action.runId,
    contractId: action.contractId,
    repoPath: action.repoPath,
    remoteHost: action.remoteHost,
    repository: action.repository,
    ref: action.ref,
    newSha: action.newSha,
    expectedAbsent: true,
    verifiedBy: outcome === "verified" ? "independent_readback" : null,
  };
}

function safeBoundedGitRemoteStep(git: GitRunner, cwd: string, args: string[]) {
  return safeGitStep(git, cwd, args, {
    timeoutMs: EXACT_GIT_REMOTE_TIMEOUT_MS,
    maxOutputBytes: EXACT_GIT_REMOTE_MAX_OUTPUT_BYTES,
  });
}

function safeGitStep(
  git: GitRunner,
  cwd: string,
  args: string[],
  limits: { timeoutMs?: number; maxOutputBytes?: number } = {},
) {
  try {
    const result = runGitStep(git, cwd, args, limits);
    const stdout = limitUtf8Output(result.stdout, limits.maxOutputBytes);
    const stderr = limitUtf8Output(result.stderr, limits.maxOutputBytes);
    return {
      ...result,
      stdout: sanitizeGitRemoteText(stdout),
      stderr: sanitizeGitRemoteText(stderr),
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: sanitizeGitRemoteText(errorMessage(error)),
      command: `git ${args.join(" ")}`,
      cwd,
    };
  }
}

function limitUtf8Output(value: string, maxBytes: number | undefined) {
  if (maxBytes === undefined || Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  return `${Buffer.from(value).subarray(0, maxBytes).toString("utf8")}\n[TRUNCATED]`;
}

function sanitizeGitRemoteText(value: string) {
  return value
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[REDACTED]@")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat)[_-][A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(x-access-token:)[^@\s]+/gi, "$1[REDACTED]");
}

function interruptAttemptAndCreateTask(
  harness: Harness,
  action: Extract<HarnessAction, { type: "interruptAttemptAndCreateTask" }>,
): HarnessActionResult {
  const prepared = prepareInterruptAttempt(harness, action.attemptId, action.type);
  if (!prepared.ok) {
    return prepared.result;
  }
  const followUpTaskId = applyInterruptAttempt(harness, prepared, action.reason, action.followUpTask);
  harness.updateRunStatus({ runId: prepared.run.id, status: "todo" });

  return doneResult(
    action.type,
    `Interrupted attempt ${prepared.attempt.id} and created follow-up task ${followUpTaskId}.`,
    [
      { name: "attempt exists", status: "passed", evidence: prepared.attempt.id },
      { name: "attempt status", status: "passed", evidence: "blocked" },
      { name: "task exists", status: "passed", evidence: prepared.task.id },
      { name: "run exists", status: "passed", evidence: prepared.run.id },
      {
        name: "execution thread coverage",
        status: "passed",
        evidence: prepared.matchingThreadIds.length > 0
          ? prepared.matchingThreadIds.join(",")
          : "no matching execution thread",
      },
      { name: "follow-up task created", status: "passed", evidence: followUpTaskId },
    ],
    [
      { kind: "attempt", attemptId: prepared.attempt.id, taskId: prepared.task.id, runId: prepared.run.id, status: "blocked", reason: action.reason },
      ...prepared.matchingThreadIds.map((threadId) => ({
        kind: "execution_thread",
        threadId,
        attemptId: prepared.attempt.id,
        taskId: prepared.task.id,
        runId: prepared.run.id,
        status: "interrupted",
        interruptReason: action.reason,
      })),
      {
        kind: "task",
        taskId: followUpTaskId,
        runId: prepared.run.id,
        parentTaskId: prepared.task.id,
        role: action.followUpTask.role,
        status: "todo",
        reason: action.reason,
      },
    ],
  );
}

function interruptRunningAttemptsAndCreateTask(
  harness: Harness,
  action: Extract<HarnessAction, { type: "interruptRunningAttemptsAndCreateTask" }>,
): HarnessActionResult {
  const uniqueAttemptIds = [...new Set(action.attemptIds)];
  if (uniqueAttemptIds.length === 0) {
    return blockedResult(action.type, "No attempts were provided.", ["attempt ids must not be empty"]);
  }

  const preparedAttempts: PreparedInterruptAttempt[] = [];
  for (const attemptId of uniqueAttemptIds) {
    const prepared = prepareInterruptAttempt(harness, attemptId, action.type);
    if (!prepared.ok) {
      return prepared.result;
    }
    if (preparedAttempts.length > 0 && prepared.run.id !== preparedAttempts[0]!.run.id) {
      return blockedResult(action.type, `Attempt ${attemptId} does not belong to run ${preparedAttempts[0]!.run.id}.`, [
        `attempt ${attemptId} does not belong to run ${preparedAttempts[0]!.run.id}`,
      ]);
    }
    preparedAttempts.push(prepared);
  }

  const primaryAttempt = preparedAttempts[0]!;
  const artifacts: Array<Record<string, unknown>> = [];
  const checks: HarnessActionResult["checks"] = [];
  const interruptedAttemptIds: string[] = [];
  let followUpTaskId: string | undefined;

  for (const [index, prepared] of preparedAttempts.entries()) {
    const createdFollowUpTask = index === 0;
    const taskFollowUpTaskId = applyInterruptAttempt(harness, prepared, action.reason, createdFollowUpTask ? action.followUpTask : undefined);
    interruptedAttemptIds.push(prepared.attempt.id);
    if (createdFollowUpTask) {
      followUpTaskId = taskFollowUpTaskId;
    }
    artifacts.push(
      { kind: "attempt", attemptId: prepared.attempt.id, taskId: prepared.task.id, runId: prepared.run.id, status: "blocked", reason: action.reason },
      ...prepared.matchingThreadIds.map((threadId) => ({
        kind: "execution_thread",
        threadId,
        attemptId: prepared.attempt.id,
        taskId: prepared.task.id,
        runId: prepared.run.id,
        status: "interrupted",
        interruptReason: action.reason,
      })),
    );
    checks.push(
      { name: "attempt exists", status: "passed", evidence: prepared.attempt.id },
      { name: "attempt status", status: "passed", evidence: "blocked" },
      { name: "task exists", status: "passed", evidence: prepared.task.id },
      { name: "run exists", status: "passed", evidence: prepared.run.id },
      {
        name: "execution thread coverage",
        status: "passed",
        evidence: prepared.matchingThreadIds.length > 0
          ? prepared.matchingThreadIds.join(",")
          : "no matching execution thread",
      },
    );
  }

  harness.updateRunStatus({ runId: primaryAttempt.run.id, status: "todo" });
  if (followUpTaskId !== undefined) {
    checks.push({ name: "follow-up task created", status: "passed", evidence: followUpTaskId });
    artifacts.push({
      kind: "task",
      taskId: followUpTaskId,
      runId: primaryAttempt.run.id,
      parentTaskId: primaryAttempt.task.id,
      role: action.followUpTask.role,
      status: "todo",
      reason: action.reason,
    });
  }

  return doneResult(
    action.type,
    `Interrupted ${interruptedAttemptIds.length} running attempt${interruptedAttemptIds.length === 1 ? "" : "s"} and created follow-up task ${followUpTaskId ?? "unknown"}.`,
    checks,
    artifacts,
  );
}

function acceptGuardrailProposalAction(
  harness: Harness,
  action: Extract<HarnessAction, { type: "acceptGuardrailProposal" }>,
): HarnessActionResult {
  const run = harness.getRun(action.runId);
  if (!run) {
    return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
  }
  const accepted = acceptGuardrailProposal({
    context: run.context,
    proposalId: action.proposalId,
    acceptedBy: action.acceptedBy,
  });
  if (!accepted) {
    return blockedResult(action.type, `Guardrail proposal not found: ${action.proposalId}`, [
      `guardrail proposal not found: ${action.proposalId} in run ${action.runId}`,
    ]);
  }

  const previousProposals = Array.isArray(run.context.guardrailProposals) ? run.context.guardrailProposals : [];
  const previousProposal = previousProposals.find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const record = candidate as Record<string, unknown>;
    return record.id === action.proposalId;
  }) as Record<string, unknown> | undefined;
  const previousAcceptedFlag = previousProposal?.accepted === true;

  harness.updateRun({
    runId: action.runId,
    contextPatch: {
      guardrailProposals: accepted.nextProposals,
      guardrails: accepted.nextGuardrails,
    },
  });

  return doneResult(action.type, `Accepted guardrail proposal ${action.proposalId} for run ${action.runId}.`, [
    { name: "run exists", status: "passed", evidence: action.runId },
    { name: "proposal exists", status: "passed", evidence: action.proposalId },
    { name: "proposal previously accepted", status: "passed", evidence: String(previousAcceptedFlag) },
    { name: "accepted by", status: "passed", evidence: action.acceptedBy },
    { name: "guardrail active", status: "passed", evidence: "true" },
  ], [
    {
      kind: "guardrail_acceptance",
      runId: action.runId,
      proposalId: action.proposalId,
      guardrailId: accepted.guardrail.id,
      acceptedBy: action.acceptedBy,
      acceptedAt: accepted.guardrail.acceptedAt,
      previouslyAccepted: previousAcceptedFlag,
      reason: action.reason ?? null,
    },
  ]);
}

function prepareInterruptAttempt(
  harness: Harness,
  attemptId: string,
  actionType: HarnessAction["type"],
):
  | { ok: true; attempt: NonNullable<ReturnType<Harness["getAttempt"]>>; task: NonNullable<ReturnType<Harness["getTask"]>>; run: NonNullable<ReturnType<Harness["getRun"]>>; matchingThreadIds: string[] }
  | { ok: false; result: HarnessActionResult } {
  const attempt = harness.getAttempt(attemptId);
  if (!attempt) {
    return { ok: false, result: blockedResult(actionType, `Attempt not found: ${attemptId}`, [`attempt not found: ${attemptId}`]) };
  }
  if (attempt.status !== "running") {
    return {
      ok: false,
      result: blockedResult(actionType, `Attempt ${attemptId} is not running.`, [`attempt ${attemptId} is not running`]),
    };
  }
  const task = harness.getTask(attempt.taskId);
  if (!task) {
    return {
      ok: false,
      result: blockedResult(actionType, `Task not found for attempt: ${attemptId}`, [`task not found for attempt: ${attemptId}`]),
    };
  }
  const run = harness.getRun(task.runId);
  if (!run) {
    return { ok: false, result: blockedResult(actionType, `Run not found for task: ${task.id}`, [`run not found for task: ${task.id}`]) };
  }

  const matchingThreadIds = harness
    .listExecutionThreads({ runId: run.id })
    .filter((thread) => thread.status === "running" && (thread.attemptId === attempt.id || thread.taskId === task.id))
    .map((thread) => thread.id);

  return { ok: true, attempt, task, run, matchingThreadIds };
}

type PreparedInterruptAttempt = {
  attempt: NonNullable<ReturnType<Harness["getAttempt"]>>;
  task: NonNullable<ReturnType<Harness["getTask"]>>;
  run: NonNullable<ReturnType<Harness["getRun"]>>;
  matchingThreadIds: string[];
};

function applyInterruptAttempt(
  harness: Harness,
  prepared: PreparedInterruptAttempt,
  reason: string,
  followUpTask?: {
    role: string;
    goal: string;
    prompt: string;
    doneWhen?: string[];
  },
) {
  harness.finishAttempt({
    attemptId: prepared.attempt.id,
    output: {
      status: "blocked",
      summary: `Interrupted by overseer: ${reason}`,
      changedFiles: [],
      checks: [
        { name: "overseer interruption", status: "failed", evidence: reason },
        {
          name: "execution thread coverage",
          status: "passed",
          evidence: prepared.matchingThreadIds.length > 0 ? prepared.matchingThreadIds.join(",") : "no matching execution thread",
        },
      ],
      artifacts: [
        {
          kind: "overseer_interruption",
          attemptId: prepared.attempt.id,
          taskId: prepared.task.id,
          runId: prepared.run.id,
          reason,
          interruptedThreadIds: prepared.matchingThreadIds,
        },
      ],
      problems: [reason],
    },
  });

  for (const threadId of prepared.matchingThreadIds) {
    harness.updateExecutionThread({
      id: threadId,
      status: "interrupted",
      interruptReason: reason,
      heartbeat: true,
    });
  }

  if (!followUpTask) {
    return undefined;
  }

  return harness.createTask({
    runId: prepared.run.id,
    parentId: prepared.task.id,
    role: followUpTask.role,
    goal: followUpTask.goal,
    prompt: followUpTask.prompt,
    doneWhen: followUpTask.doneWhen ?? [],
  });
}

function prepareRunDrain(harness: Harness, action: Extract<HarnessAction, { type: "prepareRunDrain" }>): HarnessActionResult {
  const maxTries = action.maxTries ?? 3;
  const run = harness.getRun(action.runId);
  if (!run) {
    return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
  }
  if (run.status === "done") {
    return doneResult(action.type, `Run ${action.runId} is already done.`, [
      { name: "run status", status: "passed", evidence: "done" },
    ], [{ kind: "run", runId: action.runId, status: "done" }]);
  }

  const reclaimed = harness.reclaimRunningTasksWithoutAttempts({ runId: action.runId });
  harness.clearRunPause(action.runId);
  harness.updateRunStatus({ runId: action.runId, status: "todo" });
  const sharedRootBlock = harness.blockTasksWithSharedRootCause({
    runId: action.runId,
    reason: "task dependencies are blocked",
  });
  const blockedDependencies = sharedRootBlock.blocked;
  const sharedRootCauses = sharedRootBlock.sharedRootCauses;
  if (sharedRootCauses.length > 0) {
    const existingSharedRootCauses = Array.isArray(run.context.sharedRootCauses)
      ? (run.context.sharedRootCauses as unknown[])
          .filter((value): value is Record<string, unknown> =>
            value != null && typeof value === "object" && !Array.isArray(value),
          )
          .map((value) => ({
            rootTaskId: typeof value.rootTaskId === "string" ? value.rootTaskId : "",
            rootAttemptId: typeof value.rootAttemptId === "string" ? value.rootAttemptId : undefined,
            reason: typeof value.reason === "string" ? value.reason : "",
            terminalReason: typeof value.terminalReason === "string" ? value.terminalReason : undefined,
            descendantTaskIds: Array.isArray(value.descendantTaskIds)
              ? value.descendantTaskIds.filter((item): item is string => typeof item === "string")
              : [],
            recordedAt: typeof value.recordedAt === "string" ? value.recordedAt : "",
          }))
          .filter((value) => value.rootTaskId.length > 0)
      : [];
    const keyedExisting = new Map(existingSharedRootCauses.map((cause) => [`${cause.rootTaskId}:${cause.recordedAt}`, cause]));
    for (const cause of sharedRootCauses) {
      const normalized: {
        rootTaskId: string;
        rootAttemptId: string | undefined;
        reason: string;
        terminalReason: string | undefined;
        descendantTaskIds: string[];
        recordedAt: string;
      } = {
        rootTaskId: cause.rootTaskId,
        rootAttemptId: cause.rootAttemptId,
        reason: cause.reason,
        terminalReason: cause.terminalReason,
        descendantTaskIds: cause.descendantTaskIds,
        recordedAt: cause.recordedAt,
      };
      keyedExisting.set(`${cause.rootTaskId}:${cause.recordedAt}`, normalized);
    }
    harness.updateRun({
      runId: action.runId,
      contextPatch: { sharedRootCauses: [...keyedExisting.values()] },
    });
  }
  const overview = harness.getRunOverview({ runId: action.runId, eventLimit: 0 });
  const active = overview.tasks.filter((task) => task.status === "todo" || task.status === "running");
  const checks: HarnessActionResult["checks"] = [
    { name: "run exists", status: "passed", evidence: action.runId },
    { name: "orphaned leases reclaimed", status: "passed", evidence: String(reclaimed.length) },
    { name: "run marked todo", status: "passed", evidence: "todo" },
  ];
  const artifacts: HarnessActionResult["artifacts"] = reclaimedArtifacts(reclaimed);
  if (sharedRootCauses.length > 0) {
    checks.push({ name: "shared root causes", status: "passed", evidence: String(sharedRootCauses.length) });
    artifacts.push(
      ...sharedRootCauses.map((cause) => ({
        kind: "shared_root_cause",
        rootTaskId: cause.rootTaskId,
        rootAttemptId: cause.rootAttemptId ?? null,
        terminalReason: cause.terminalReason ?? null,
        descendantTaskIds: cause.descendantTaskIds,
        reason: cause.reason,
        recordedAt: cause.recordedAt,
      })),
    );
  }
  if (blockedDependencies.length > 0) {
    checks.push({ name: "blocked dependency tasks", status: "passed", evidence: String(blockedDependencies.length) });
    artifacts.push(...blockedDependencies.map((task) => ({
      kind: "blocked_dependency_task",
      taskId: task.taskId,
      role: task.role,
      dependencyIds: task.dependencyIds,
      reason: task.reason,
    })));
  }
  artifacts.push({ kind: "run", runId: action.runId, previousStatus: run.status, status: "todo", reason: action.reason ?? null });

  if (active.length > 0) {
    checks.push({ name: "active work", status: "passed", evidence: `${active.length} todo/running task(s)` });
    artifacts.push(...active.map((task) => ({ kind: "active_task", taskId: task.id, role: task.role, status: task.status })));
    return doneResult(action.type, `Run ${action.runId} has ${active.length} active task${active.length === 1 ? "" : "s"} ready for a runner.`, checks, artifacts);
  }

  const proposals = proposeGuardrailsFromLessons({
    lessons: harness.listLessons({ runId: action.runId }),
    existingProposals: overview.run?.context.guardrailProposals,
  });
  harness.updateRun({
    runId: action.runId,
    contextPatch: { guardrailProposals: proposals.nextProposals },
  });
  checks.push({
    name: "guardrail proposals refreshed",
    status: "passed",
    evidence: `${proposals.proposed} proposal(s)`,
  });
  artifacts.push({
    kind: "guardrail_proposals",
    runId: action.runId,
    proposed: proposals.proposed,
    proposalIds: proposals.proposals.map((proposal) => proposal.id),
  });

  const goalReviewInvalidated = overview.run?.context.goalReviewInvalidatedByIntegration === true;
  if (goalReviewInvalidated) {
    checks.push({ name: "goal review invalidated", status: "passed", evidence: "integration" });
  }
  const completedReview = goalReviewInvalidated ? null : selectCompletedGoalReview(overview);
  if (completedReview) {
    const readiness = describeIntegrationReadiness(harness, action.runId);
    if (readiness.unintegrated.length > 0) {
      harness.updateRun({
        runId: action.runId,
        status: "blocked",
        contextPatch: {
          pendingIntegrationWorkerTaskIds: readiness.unintegrated.map((worker) => worker.taskId),
          pendingIntegrationReason: "verified worker changes are not integrated yet",
        },
      });
      checks.push({
        name: "pending integration",
        status: "failed",
        evidence: readiness.unintegrated.map((worker) => worker.taskId).join(","),
      });
      artifacts.push(...readiness.unintegrated.map((worker) => ({
        kind: "pending_integration",
        taskId: worker.taskId,
        role: worker.role,
        verifierTaskId: worker.verifierTaskId,
        changedFiles: worker.changedFiles,
      })));
      return {
        status: "blocked",
        actionType: action.type,
        summary: `Run ${action.runId} has unintegrated verified worker changes.`,
        checks,
        artifacts,
        problems: readiness.unintegrated.map((worker) =>
          `verified worker ${worker.taskId} has unintegrated changes verified by ${worker.verifierTaskId}`,
        ),
      };
    }
    harness.updateRunStatus({ runId: action.runId, status: "done" });
    checks.push({ name: "completed goal review", status: "passed", evidence: completedReview.id });
    artifacts.push({ kind: "run", runId: action.runId, previousStatus: run.status, status: "done", reviewTaskId: completedReview.id });
    return doneResult(action.type, `Run ${action.runId} marked done from existing complete goal-review.`, checks, artifacts);
  }

  const review = ensureGoalReviewTask(harness, action.runId, maxTries, overview, goalReviewInvalidated);
  if (goalReviewInvalidated) {
    const existingInvalidated = invalidatedGoalReviewTaskIds(overview);
    for (const task of overview.tasks) {
      if (task.role === "goal-review") {
        existingInvalidated.add(task.id);
      }
    }
    harness.updateRun({
      runId: action.runId,
      contextPatch: {
        goalReviewInvalidatedByIntegration: false,
        invalidatedGoalReviewTaskIds: [...existingInvalidated],
        goalReviewRefreshedAt: new Date().toISOString(),
      },
    });
    checks.push({ name: "goal review invalidation consumed", status: "passed", evidence: "integration" });
  }
  checks.push(...review.checks);
  artifacts.push(...review.artifacts);
  if (review.status === "blocked") {
    return {
      status: "blocked",
      actionType: action.type,
      summary: review.summary,
      checks,
      artifacts,
      problems: review.problems,
    };
  }
  return doneResult(action.type, review.summary, checks, artifacts);
}

function amendRunContract(
  harness: Harness,
  action: Extract<HarnessAction, { type: "amendRunContract" }>,
): HarnessActionResult {
  const run = harness.getRun(action.runId);
  if (!run) {
    return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
  }

  const existingAmendments = readContractAmendments(run.context);
  const currentVersion = existingAmendments
    .filter((entry) => entry.contractKey === action.contractKey)
    .reduce((max, entry) => (entry.version > max ? entry.version : max), 0);

  if (action.expectedVersion !== undefined && action.expectedVersion !== currentVersion) {
    return blockedResult(
      action.type,
      `Stale contract amendment for ${action.contractKey}: expected version ${action.expectedVersion}, current is ${currentVersion}.`,
      [
        `Stale contract amendment for contractKey ${action.contractKey}: expectedVersion=${action.expectedVersion}, current=${currentVersion}`,
      ],
    );
  }

  if (!Number.isInteger(action.version) || action.version <= currentVersion) {
    return blockedResult(
      action.type,
      `Non-monotonic contract amendment for ${action.contractKey}: version ${action.version} must be greater than current ${currentVersion}.`,
      [
        `Non-monotonic contract amendment for contractKey ${action.contractKey}: version=${action.version}, current=${currentVersion}`,
      ],
    );
  }

  const previousValue = run.context[action.contractKey] ?? null;
  const amendedAt = new Date().toISOString();
  const amendment: ContractAmendmentEntry = {
    contractKey: action.contractKey,
    version: action.version,
    previousValue,
    value: action.value,
    reason: action.reason ?? null,
    amendedAt,
  };
  const updated = harness.updateRun({
    runId: action.runId,
    contextPatch: {
      [action.contractKey]: action.value,
      contractAmendments: [...existingAmendments, amendment],
    },
  });
  if (!updated) {
    return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
  }

  return doneResult(
    action.type,
    `Amended run ${action.runId} contract ${action.contractKey} to version ${action.version}.`,
    [
      { name: "run exists", status: "passed", evidence: action.runId },
      { name: "contract key", status: "passed", evidence: action.contractKey },
      { name: "previous version", status: "passed", evidence: String(currentVersion) },
      { name: "next version", status: "passed", evidence: String(action.version) },
      {
        name: "expected version",
        status: "passed",
        evidence: action.expectedVersion === undefined ? "not provided" : String(action.expectedVersion),
      },
    ],
    [
      {
        kind: "contract_amendment",
        runId: action.runId,
        contractKey: action.contractKey,
        previousVersion: currentVersion,
        version: action.version,
        previousValue,
        value: action.value,
        reason: action.reason ?? null,
        amendedAt,
      },
    ],
  );
}

function readContractAmendments(context: Record<string, unknown>): ContractAmendmentEntry[] {
  const raw = context.contractAmendments;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isContractAmendmentEntry);
}

function isContractAmendmentEntry(value: unknown): value is ContractAmendmentEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.contractKey === "string" &&
    typeof entry.version === "number" &&
    Number.isInteger(entry.version) &&
    typeof entry.amendedAt === "string"
  );
}

function ensureGoalReviewTask(
  harness: Harness,
  runId: string,
  maxTries: number,
  overview: ReturnType<Harness["getRunOverview"]>,
  goalReviewInvalidated = false,
) {
  const invalidatedTaskIds = invalidatedGoalReviewTaskIds(overview);
  const latestProgressIndex = overview.sessions.reduce((latest, session, index) => {
    return session.role !== "goal-review" && session.role !== "verifier" && session.status === "done" ? index : latest;
  }, -1);
  const currentReviewSessions = goalReviewInvalidated
    ? []
    : overview.sessions.filter(
      (session, index) =>
        index > latestProgressIndex &&
        session.role === "goal-review" &&
        session.status === "done" &&
        !invalidatedTaskIds.has(session.taskId),
    );

  const latestReview = currentReviewSessions[currentReviewSessions.length - 1];
  if (latestReview && resolveRunDecision(latestReview.output) === "defer") {
    harness.updateRunStatus({ runId, status: "blocked" });
    return {
      status: "blocked" as const,
      summary: `Run ${runId} blocked by deferred goal-review ${latestReview.taskId}.`,
      checks: [{ name: "goal review defer", status: "passed" as const, evidence: latestReview.taskId }],
      artifacts: [{ kind: "goal_review", taskId: latestReview.taskId, status: "defer" }],
      problems: [],
    };
  }

  const nonTerminalReviews = currentReviewSessions.filter((session) => {
    const decision = resolveRunDecision(session.output);
    return decision === "continue" || decision === "verify";
  });
  if (nonTerminalReviews.length >= maxTries) {
    harness.updateRunStatus({ runId, status: "blocked" });
    return {
      status: "blocked" as const,
      summary: `Run ${runId} reached ${nonTerminalReviews.length}/${maxTries} non-terminal goal-review decisions.`,
      checks: [{ name: "goal review continue limit", status: "failed" as const, evidence: `${nonTerminalReviews.length}/${maxTries}` }],
      artifacts: [{ kind: "goal_review", tries: nonTerminalReviews.length, maxTries, status: "blocked" }],
      problems: [`goal-review continue/verify limit reached for ${runId}`],
    };
  }

  const blockedReview = goalReviewInvalidated
    ? undefined
    : [...overview.tasks].reverse().find(
      (task) => task.role === "goal-review" && task.status === "blocked" && !invalidatedTaskIds.has(task.id),
    );
  if (blockedReview) {
    const lastTask = overview.tasks[overview.tasks.length - 1];
    const blockedTries = overview.sessions.filter((session) => session.taskId === blockedReview.id).length;
    const lastBlockedSession = [...overview.sessions].reverse().find((session) => session.taskId === blockedReview.id);
    const textualCompletion = lastBlockedSession
      ? inferExplicitRunDecision(lastBlockedSession.output) === "complete"
      : false;
    if (textualCompletion) {
      harness.updateRunStatus({ runId, status: "done" });
      return {
        status: "done" as const,
        summary: `Goal-review task ${blockedReview.id} reported textual completion.`,
        checks: [{ name: "goal review textual completion", status: "passed" as const, evidence: blockedReview.id }],
        artifacts: [{ kind: "goal_review", taskId: blockedReview.id, status: "done", recovered: "textual" }],
        problems: [],
      };
    }
    if (lastTask && lastTask.id !== blockedReview.id) {
      const created = createGoalReviewTask(harness, runId, overview);
      return {
        status: "done" as const,
        summary: `Created fresh goal-review task ${created.taskId} after newer work superseded ${blockedReview.id}.`,
        checks: [
          { name: "superseded goal review", status: "passed" as const, evidence: blockedReview.id },
          { name: "goal review created", status: "passed" as const, evidence: created.taskId },
        ],
        artifacts: [
          { kind: "goal_review", taskId: blockedReview.id, status: "blocked", superseded: true },
          goalReviewCreatedArtifact(created),
        ],
        problems: [],
      };
    }
    if (blockedTries >= maxTries) {
      harness.updateRunStatus({ runId, status: "blocked" });
      return {
        status: "blocked" as const,
        summary: `Goal-review task ${blockedReview.id} already reached max tries.`,
        checks: [{ name: "goal review max tries", status: "failed" as const, evidence: `${blockedTries}/${maxTries}` }],
        artifacts: [{ kind: "goal_review", taskId: blockedReview.id, tries: blockedTries, maxTries }],
        problems: [`goal-review max tries reached for ${blockedReview.id}`],
      };
    }
    harness.retryTask({ taskId: blockedReview.id });
    return {
      status: "done" as const,
      summary: `Goal-review task ${blockedReview.id} returned to todo.`,
      checks: [{ name: "goal review retried", status: "passed" as const, evidence: `${blockedTries + 1}/${maxTries}` }],
      artifacts: [{ kind: "goal_review", taskId: blockedReview.id, status: "todo", retried: true, tries: blockedTries + 1, maxTries }],
      problems: [],
    };
  }

  const created = createGoalReviewTask(harness, runId, overview);
  return {
    status: "done" as const,
    summary: `Created goal-review task ${created.taskId}.`,
    checks: [{ name: "goal review created", status: "passed" as const, evidence: created.taskId }],
    artifacts: [goalReviewCreatedArtifact(created)],
    problems: [],
  };
}

function createGoalReviewTask(
  harness: Harness,
  runId: string,
  overview: ReturnType<Harness["getRunOverview"]>,
) {
  const sourceTask = selectGoalReviewSourceTask(harness, runId, overview);
  const taskId = harness.createTask({
    runId,
    role: "goal-review",
    goal: GOAL_REVIEW_TASK_GOAL,
    prompt: GOAL_REVIEW_TASK_PROMPT,
    dependsOn: sourceTask?.status === "done" ? [sourceTask.id] : [],
    worktreePath: sourceTask?.worktreePath ?? null,
    doneWhen: GOAL_REVIEW_TASK_DONE_WHEN,
  });
  return { taskId, sourceTask };
}

function selectGoalReviewSourceTask(
  harness: Harness,
  runId: string,
  overview: ReturnType<Harness["getRunOverview"]>,
) {
  const integratedWorkerTaskIds = collectIntegratedWorkerTaskIds(harness, runId);
  return [...overview.tasks].reverse().find((task) =>
    (task.status === "done" || task.status === "blocked") &&
    task.worktreePath !== null &&
    !["planner", "verifier", "goal-review"].includes(task.role) &&
    (task.status === "blocked" || !integratedWorkerTaskIds.has(task.id))
  ) ?? null;
}

function goalReviewCreatedArtifact(created: ReturnType<typeof createGoalReviewTask>) {
  return {
    kind: "goal_review",
    taskId: created.taskId,
    status: "todo",
    created: true,
    ...(created.sourceTask
      ? {
          sourceTaskId: created.sourceTask.id,
          sourceWorktreePath: created.sourceTask.worktreePath,
        }
      : {}),
  };
}

export function goalReviewOutputHasCompletion(output: AttemptOutput) {
  return resolveRunDecision(output) === "complete";
}

function doneResult(
  actionType: HarnessAction["type"],
  summary: string,
  checks: HarnessActionResult["checks"],
  artifacts: HarnessActionResult["artifacts"],
): HarnessActionResult {
  return { status: "done", actionType, summary, checks, artifacts, problems: [] };
}

function blockedResult(actionType: string, summary: string, problems: string[]): HarnessActionResult {
  return {
    status: "blocked",
    actionType: actionType as HarnessActionResult["actionType"],
    summary,
    checks: [{ name: "action validation", status: "failed", evidence: problems.join("; ") }],
    artifacts: [],
    problems,
  };
}

function reclaimedArtifacts(reclaimed: ReclaimedRunningTask[]) {
  return reclaimed.map((task) => ({
    kind: "reclaimed_task",
    taskId: task.taskId,
    sessionRef: task.sessionRef,
    worktreePath: task.worktreePath,
    reason: task.reason,
  }));
}

function selectIntegrationWorker(overview: RunOverview, workerTaskId: string | undefined): Task | null {
  const isExecutionTask = (task: Task) =>
    task.status === "done" &&
    task.worktreePath !== null &&
    !["planner", "verifier", "goal-review"].includes(task.role);
  if (workerTaskId) {
    const task = overview.tasks.find((candidate) => candidate.id === workerTaskId);
    return task && isExecutionTask(task) ? task : null;
  }
  return [...overview.tasks].reverse().find(isExecutionTask) ?? null;
}

function redirectRepairWorkerToSource(input: {
  overview: RunOverview;
  worker: Task;
  worktreePath: string;
  repoPath: string;
  git: GitRunner;
  changedFiles: string[];
}): { worktreePath: string; sourceWorkerId: string } | null {
  const { overview, worker, worktreePath, repoPath, git, changedFiles } = input;
  if (changedFiles.length === 0) {
    return null;
  }
  const ownStatus = runGitStep(git, worktreePath, ["status", "--short"]);
  if (!ownStatus.ok || ownStatus.stdout.trim().length > 0) {
    return null;
  }
  const sourceWorker = findSourceWorkerForRepair(overview, worker.id);
  if (!sourceWorker || sourceWorker.id === worker.id) {
    return null;
  }
  const sourceWorktreePath = resolveWorktreePath(repoPath, sourceWorker.worktreePath);
  if (!sourceWorktreePath || !existsSync(sourceWorktreePath)) {
    return null;
  }
  const sourceStatus = runGitStep(git, sourceWorktreePath, ["status", "--short"]);
  if (!sourceStatus.ok || sourceStatus.stdout.trim().length === 0) {
    return null;
  }
  return { worktreePath: sourceWorktreePath, sourceWorkerId: sourceWorker.id };
}

function findSourceWorkerForRepair(overview: RunOverview, repairTaskId: string): Task | null {
  const repair = overview.tasks.find((task) => task.id === repairTaskId);
  if (!repair || !repair.parentId) {
    return null;
  }
  const verifier = overview.tasks.find((task) => task.id === repair.parentId);
  if (!verifier || verifier.role !== "verifier") {
    return null;
  }
  for (const dependencyId of verifier.dependsOn) {
    if (dependencyId === repairTaskId) {
      continue;
    }
    const candidate = overview.tasks.find((task) => task.id === dependencyId);
    if (candidate && candidate.role === "worker" && candidate.worktreePath) {
      return candidate;
    }
  }
  return null;
}

export function describeIntegrationReadiness(harness: Harness, runId: string): IntegrationReadiness {
  const overview = harness.getRunOverview({ runId, eventLimit: 0 });
  const integratedWorkerTaskIds = collectIntegratedWorkerTaskIds(harness, runId);
  const unintegrated: UnintegratedVerifiedWorker[] = [];
  for (const task of overview.tasks) {
    if (["planner", "verifier", "goal-review"].includes(task.role)) {
      continue;
    }
    if (task.status !== "done" || !task.worktreePath) {
      continue;
    }
    if (integratedWorkerTaskIds.has(task.id)) {
      continue;
    }
    const session = latestSessionForTask(overview, task.id);
    const changedFiles = filterOuroborosRuntimePaths(
      Array.isArray(session?.output.changedFiles) ? session.output.changedFiles : [],
    );
    if (changedFiles.length === 0) {
      continue;
    }
    const verifier = selectVerifierForWorker(overview, task.id);
    if (!verifier) {
      continue;
    }
    unintegrated.push({
      taskId: task.id,
      role: task.role,
      verifierTaskId: verifier.id,
      changedFiles,
    });
  }
  return { unintegrated, integratedWorkerTaskIds };
}

function collectIntegratedWorkerTaskIds(harness: Harness, runId: string): Set<string> {
  const ids = new Set<string>();
  for (const event of harness.listHarnessActionEvents({ limit: 500 })) {
    if (
      (event.actionType !== "integrateVerifiedRun" && event.actionType !== "commitExactGitIndex") ||
      event.status !== "done"
    ) {
      continue;
    }
    const request = event.request as Record<string, unknown>;
    const requestedWorkerTaskId = event.actionType === "commitExactGitIndex" ? request.taskId : request.workerTaskId;
    if (request.runId !== runId || typeof requestedWorkerTaskId !== "string") {
      continue;
    }
    const result = event.result as Record<string, unknown>;
    const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
    const hasMatchingReceipt = artifacts.some((artifact) => {
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
        return false;
      }
      const record = artifact as Record<string, unknown>;
      const modeMatches = event.actionType === "commitExactGitIndex"
        ? record.mode === "exact_git_index_commit"
        : record.mode === "branch_merge" ||
          record.mode === "contained_worker_commit" ||
          record.mode === "materialized_target_commit";
      return record.kind === "integration" &&
        modeMatches &&
        record.runId === runId &&
        record.workerTaskId === requestedWorkerTaskId;
    });
    if (hasMatchingReceipt) {
      ids.add(requestedWorkerTaskId);
    }
  }
  return ids;
}

function latestSessionForTask(overview: RunOverview, taskId: string) {
  return [...overview.sessions].reverse().find((session) => session.taskId === taskId && session.status === "done") ?? null;
}

function selectVerifierForWorker(overview: RunOverview, workerTaskId: string): Task | null {
  return [...overview.tasks].reverse().find((task) => {
    if (task.role !== "verifier" || task.status !== "done" || !task.dependsOn.includes(workerTaskId)) {
      return false;
    }
    const session = latestSessionForTask(overview, task.id);
    if (!session || session.output.status !== "done") {
      return false;
    }
    const checks = Array.isArray(session.output.checks) ? session.output.checks : [];
    return !checks.some(isFailedCheck);
  }) ?? null;
}

function selectCompletedGoalReview(overview: RunOverview): Task | null {
  const invalidatedTaskIds = invalidatedGoalReviewTaskIds(overview);
  return [...overview.tasks].reverse().find((task) => {
    if (task.role !== "goal-review" || task.status !== "done" || invalidatedTaskIds.has(task.id)) {
      return false;
    }
    const session = latestSessionForTask(overview, task.id);
    if (session?.output.status !== "done") {
      return false;
    }
    const decision = resolveRunDecision(session.output);
    return decision === "complete" && (session.output.nextTasks ?? []).length === 0;
  }) ?? null;
}

function invalidatedGoalReviewTaskIds(overview: RunOverview): Set<string> {
  const raw = overview.run?.context.invalidatedGoalReviewTaskIds;
  return new Set(Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : []);
}

function isFailedCheck(check: unknown) {
  return Boolean(
    check &&
      typeof check === "object" &&
      "status" in check &&
      (check as { status?: unknown }).status === "failed",
  );
}

function resolveWorktreePath(repoPath: string, worktreePath: string | null) {
  if (!worktreePath) {
    return null;
  }
  return isAbsolute(worktreePath) ? worktreePath : join(repoPath, worktreePath);
}

function defaultGitRunner(input: GitCommandInput): GitCommandResult {
  const result = Bun.spawnSync({
    cmd: ["git", ...input.args],
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }),
    ...(input.maxOutputBytes === undefined ? {} : { maxBuffer: input.maxOutputBytes }),
  });
  return {
    exitCode: result.exitCode,
    stdout: decodeCommandOutput(result.stdout),
    stderr: decodeCommandOutput(result.stderr),
  };
}

function runGitStep(
  git: GitRunner,
  cwd: string,
  args: string[],
  limits: { timeoutMs?: number; maxOutputBytes?: number } = {},
) {
  const result = git({ cwd, args, ...limits });
  return {
    ...result,
    ok: result.exitCode === 0,
    command: `git ${args.join(" ")}`,
    cwd,
  };
}

function readTargetDirtyFiles(git: GitRunner, cwd: string): { ok: true; files: string[] } | { ok: false; result: ReturnType<typeof runGitStep> } {
  const commands = [
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"],
  ];
  const files = new Set<string>();
  for (const args of commands) {
    const result = runGitStep(git, cwd, args);
    if (!result.ok) {
      return { ok: false, result };
    }
    for (const file of result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      files.add(file);
    }
  }
  return { ok: true, files: filterOuroborosRuntimePaths([...files]).sort() };
}

function normalizeRelativeFiles(files: string[]) {
  return filterOuroborosRuntimePaths(files).filter((file) =>
    file.length > 0 &&
    !isAbsolute(file) &&
    !file.split(/[\\/]+/).includes("..")
  );
}

function sameMaterializedFile(repoPath: string, worktreePath: string, file: string) {
  const repoFile = join(repoPath, file);
  const worktreeFile = join(worktreePath, file);
  const repoExists = existsSync(repoFile);
  const worktreeExists = existsSync(worktreeFile);
  if (repoExists !== worktreeExists) {
    return false;
  }
  if (!repoExists) {
    return true;
  }
  return readFileSync(repoFile).equals(readFileSync(worktreeFile));
}

function readGitStdout(git: GitRunner, cwd: string, args: string[]) {
  const result = runGitStep(git, cwd, args);
  return result.ok ? result.stdout.trim() : null;
}

function integrationOperationKey(
  harness: Harness,
  action: Extract<HarnessAction, { type: "integrateVerifiedRun" }>,
  git: GitRunner,
) {
  const overview = harness.getRunOverview({ runId: action.runId, eventLimit: 0 });
  if (!overview.run) {
    return null;
  }
  const worker = selectIntegrationWorker(overview, action.workerTaskId);
  const repoPath = action.repoPath ?? overview.run.projectRoot ?? overview.project?.rootPath ?? null;
  const workerPath = worker?.worktreePath && repoPath
    ? resolveWorktreePath(repoPath, worker.worktreePath)
    : worker?.worktreePath ?? null;
  const slot = worker?.id ?? action.workerTaskId ?? "automatic";
  return {
    slot,
    key: stableFingerprint({
      action: {
        integrationContractVersion: INTEGRATION_CONTRACT_VERSION,
        runId: action.runId,
        workerTaskId: action.workerTaskId ?? null,
        repoPath,
        targetBranch: action.targetBranch ?? "main",
        push: action.push ?? false,
      },
      tasks: overview.tasks.map((task) => ({
        id: task.id,
        role: task.role,
        status: task.status,
        dependsOn: [...task.dependsOn].sort(),
        worktreePath: task.worktreePath,
      })),
      attempts: overview.sessions.map((session) => ({
        taskId: session.taskId,
        attemptId: session.attemptId,
        status: session.status,
      })),
      targetRepository: gitRepositoryState(git, repoPath),
      workerRepository: gitRepositoryState(git, workerPath),
    }),
  };
}

function gitRepositoryState(git: GitRunner, cwd: string | null) {
  if (!cwd || !existsSync(cwd)) {
    return { exists: false, cwd };
  }
  const read = (args: string[]) => {
    try {
      const result = runGitStep(git, cwd, args);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return { exitCode: -1, stdout: "", stderr: errorMessage(error) };
    }
  };
  return {
    exists: true,
    branch: read(["branch", "--show-current"]),
    status: read(["status", "--short"]),
    head: read(["rev-parse", "HEAD"]),
    mergeHead: read(["rev-parse", "--verify", "-q", "MERGE_HEAD"]),
  };
}

function stableFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
}

function blockedCommand(
  actionType: Extract<HarnessAction, { type: "integrateVerifiedRun" }>["type"],
  summary: string,
  checks: HarnessActionResult["checks"],
  result: ReturnType<typeof runGitStep>,
): HarnessActionResult {
  return {
    status: "blocked",
    actionType,
    summary,
    checks: [
      ...checks,
      { name: "git command", status: "failed", evidence: `${result.command} in ${result.cwd}` },
    ],
    artifacts: [
      {
        kind: "git_command",
        command: result.command,
        cwd: result.cwd,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    ],
    problems: [result.stderr.trim() || result.stdout.trim() || summary],
  };
}

function blockedIntegration(
  actionType: Extract<HarnessAction, { type: "integrateVerifiedRun" }>["type"],
  summary: string,
  checks: HarnessActionResult["checks"],
  problems: string[],
): HarnessActionResult {
  return {
    status: "blocked",
    actionType,
    summary,
    checks: [...checks, { name: "integration preflight", status: "failed", evidence: problems.join("; ") }],
    artifacts: [],
    problems,
  };
}

function decodeCommandOutput(value: Uint8Array | ArrayBuffer | string | null | undefined) {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return new TextDecoder().decode(value);
}

function objectRecord(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function assertOnlyFields(record: Record<string, unknown>, label: string, allowed: string[]) {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}`);
  }
}

function safeIdentifierField(record: Record<string, unknown>, key: string) {
  const value = stringField(record, key);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) {
    throw new Error(`${key} must be a safe identifier of at most 200 characters`);
  }
  return value;
}

function exactNonEmptyStringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\0")) {
    throw new Error(`${key} must be an exact non-empty string without surrounding whitespace or NUL`);
  }
  return value;
}

function exactSafeIdentifierField(record: Record<string, unknown>, key: string) {
  const value = exactNonEmptyStringField(record, key);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) {
    throw new Error(`${key} must be a safe identifier of at most 200 characters`);
  }
  return value;
}

function exactAbsolutePathField(record: Record<string, unknown>, key: string) {
  const value = exactNonEmptyStringField(record, key);
  if (!isAbsolute(value)) {
    throw new Error(`${key} must be an absolute path`);
  }
  return value;
}

function exactGitBranchField(record: Record<string, unknown>, key: string) {
  const value = exactNonEmptyStringField(record, key);
  if (!isExactGitBranchRef(`refs/heads/${value}`)) {
    throw new Error(`${key} must be one exact branch name without wildcard or ref expressions`);
  }
  return value;
}

function exactGitCommitShaField(record: Record<string, unknown>, key: string) {
  const value = exactNonEmptyStringField(record, key);
  if (!/^[0-9a-f]{40}$/.test(value) || /^0+$/.test(value)) {
    throw new Error(`${key} must be a non-zero lowercase full 40-character commit SHA`);
  }
  return value;
}

function exactCommitMessageField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.trim() !== value ||
    new TextEncoder().encode(value).byteLength > EXACT_GIT_INDEX_MAX_COMMIT_MESSAGE_BYTES
  ) {
    throw new Error(`${key} must be one exact non-empty trimmed line of at most ${EXACT_GIT_INDEX_MAX_COMMIT_MESSAGE_BYTES} UTF-8 bytes without NUL`);
  }
  return value;
}

function exactGitIndexFilesField(record: Record<string, unknown>, key: string): ExactGitIndexFile[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > EXACT_GIT_INDEX_MAX_FILES) {
    throw new Error(`${key} must contain 1-${EXACT_GIT_INDEX_MAX_FILES} exact Git index additions`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const file = objectRecord(item, `${key}[${index}]`);
    assertOnlyFields(file, `${key}[${index}]`, ["status", "path", "mode", "blobOid"]);
    if (file.status !== "A") {
      throw new Error(`${key}[${index}].status must be A`);
    }
    if (file.mode !== "100644") {
      throw new Error(`${key}[${index}].mode must be 100644`);
    }
    const path = exactRelativeGitPathField(file, "path", `${key}[${index}].path`);
    if (seen.has(path)) {
      throw new Error(`${key} must contain unique paths; duplicate: ${path}`);
    }
    seen.add(path);
    return {
      status: "A",
      path,
      mode: "100644",
      blobOid: exactGitBlobOidField(file, "blobOid", `${key}[${index}].blobOid`),
    };
  });
}

function exactRelativeGitPathField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    isAbsolute(value) ||
    value.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(value) ||
    new TextEncoder().encode(value).byteLength > EXACT_GIT_INDEX_MAX_PATH_BYTES ||
    value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be an exact safe relative Git path of at most ${EXACT_GIT_INDEX_MAX_PATH_BYTES} UTF-8 bytes`);
  }
  return value;
}

function exactGitBlobOidField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value) || /^0+$/.test(value)) {
    throw new Error(`${label} must be a non-zero lowercase full 40-character blob OID`);
  }
  return value;
}

function absolutePathField(record: Record<string, unknown>, key: string) {
  const value = stringField(record, key);
  if (!isAbsolute(value)) {
    throw new Error(`${key} must be an absolute path`);
  }
  return value;
}

function gitRemoteHostField(record: Record<string, unknown>, key: string) {
  const value = stringField(record, key).toLowerCase();
  if (!isGitRemoteHost(value)) {
    throw new Error(`${key} must be an exact DNS hostname without a scheme, port, or wildcard`);
  }
  return value;
}

function exactGitRemoteHostField(record: Record<string, unknown>, key: string) {
  const value = exactNonEmptyStringField(record, key);
  if (value !== value.toLowerCase() || !isGitRemoteHost(value)) {
    throw new Error(`${key} must be one exact lowercase DNS hostname without a scheme, port, or wildcard`);
  }
  return value;
}

function isGitRemoteHost(value: string) {
  return value.length <= 253 &&
    value.split(".").length >= 2 &&
    value.split(".").every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)
    );
}

function gitRepositoryField(record: Record<string, unknown>, key: string) {
  const value = stringField(record, key);
  if (!isGitRepository(value)) {
    throw new Error(`${key} must be an exact repository path without scheme, credentials, wildcard, or .git suffix`);
  }
  return value;
}

function exactGitRepositoryField(record: Record<string, unknown>, key: string) {
  const value = exactNonEmptyStringField(record, key);
  if (!isGitRepository(value)) {
    throw new Error(`${key} must be an exact repository path without scheme, credentials, wildcard, or .git suffix`);
  }
  return value;
}

function isGitRepository(value: string) {
  const segments = value.split("/");
  return segments.length >= 2 &&
    !value.endsWith(".git") &&
    !value.includes("..") &&
    segments.every((segment) => /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/.test(segment));
}

function gitBranchRefField(record: Record<string, unknown>, key: string) {
  const value = stringField(record, key);
  if (!isExactGitBranchRef(value)) {
    throw new Error(`${key} must be one exact refs/heads/* branch without wildcard, deletion, or ref expressions`);
  }
  return value;
}

function exactCreatableBranchRefField(record: Record<string, unknown>, key: string) {
  const value = exactNonEmptyStringField(record, key);
  if (!isExactGitBranchRef(value)) {
    throw new Error(`${key} must be one exact refs/heads/* branch without wildcard, deletion, or ref expressions`);
  }
  if (value === "refs/heads/main") {
    throw new Error(`${key} must not create refs/heads/main`);
  }
  return value;
}

function isExactGitBranchRef(value: string) {
  if (!value.startsWith("refs/heads/")) {
    return false;
  }
  const branch = value.slice("refs/heads/".length);
  if (
    branch.length === 0 ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    /[\x00-\x20\x7f~^:?*\[\\]/.test(branch)
  ) {
    return false;
  }
  return branch.split("/").every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".." && !segment.startsWith(".") && !segment.endsWith(".lock")
  );
}

function gitCommitShaField(record: Record<string, unknown>, key: string) {
  const value = stringField(record, key).toLowerCase();
  if (!isGitCommitSha(value) || /^0+$/.test(value)) {
    throw new Error(`${key} must be a non-zero full 40-character commit SHA`);
  }
  return value;
}

function isGitCommitSha(value: string) {
  return /^[0-9a-f]{40}$/i.test(value);
}

function optionalStringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value.trim();
}

function optionalStatusField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value !== "todo" && value !== "running" && value !== "done" && value !== "blocked") {
    throw new Error(`${key} must be todo, running, done, or blocked`);
  }
  return value;
}

function optionalBooleanField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function followUpTaskField(record: Record<string, unknown>, key: string) {
  const value = objectRecord(record[key], key);
  return {
    role: stringField(value, "role"),
    goal: stringField(value, "goal"),
    prompt: stringField(value, "prompt"),
    doneWhen: optionalStringArrayField(value, "doneWhen"),
  };
}

function optionalStringArrayField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`${key}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
}

function optionalThreadStatusFilter(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (
    value !== "running" &&
    value !== "done" &&
    value !== "blocked" &&
    value !== "interrupted" &&
    value !== "orphaned"
  ) {
    throw new Error(`${key} must be running, done, blocked, interrupted, or orphaned`);
  }
  return value as ExecutionThreadStatusFilter;
}

function stringArrayField(record: Record<string, unknown>, key: string) {
  const value = optionalStringArrayField(record, key);
  if (value === undefined) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value;
}

function optionalPositiveInteger(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function positiveIntegerField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function optionalNonNegativeIntegerField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}

function requiredValueField(record: Record<string, unknown>, key: string) {
  if (!(key in record)) {
    throw new Error(`${key} must be provided`);
  }
  return record[key];
}

function safeRequest(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeActionRequestValue(value);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : { value: sanitized };
}

function sanitizeActionRequestValue(
  value: unknown,
  key = "",
  active = new WeakSet<object>(),
): unknown {
  if (isSensitiveActionRequestKey(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return sanitizeGitRemoteText(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (active.has(value)) {
    return "[CIRCULAR]";
  }
  active.add(value);
  const sanitized = Array.isArray(value)
    ? value.map((item) => sanitizeActionRequestValue(item, "", active))
    : Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeActionRequestValue(entryValue, entryKey, active),
      ]),
    );
  active.delete(value);
  return sanitized;
}

function isSensitiveActionRequestKey(key: string) {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((word) => ["authorization", "token", "secret", "password", "credential", "credentials"].includes(word))) {
    return true;
  }
  return words.includes("key") && words.some((word) => ["api", "private", "secret", "access", "signing"].includes(word));
}

function resultToRecord(result: HarnessActionResult): Record<string, unknown> {
  return { ...result };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// After a successful integration, transition the linked design proposal into
// `measuring` and (when due) seed a bounded outcome-review task. The reviewer
// records the formal retain/revise/retire outcome; the delivery task graph is
// not reopened. Idempotent: a second integration for the same run is a no-op.
function finalizeIntegrationOutcomeReview(
  harness: Harness,
  action: Extract<HarnessAction, { type: "integrateVerifiedRun" }>,
  result: HarnessActionResult,
): HarnessActionResult {
  if (result.status !== "done") {
    return result;
  }
  const integrationArtifact = result.artifacts.find(
    (artifact) =>
      typeof artifact === "object" &&
      artifact !== null &&
      (artifact as { kind?: unknown }).kind === "integration",
  );
  if (!integrationArtifact) {
    return result;
  }
  const immediate = action.immediateOutcomeReview === true;
  let linked: ReturnType<Harness["linkProposalOutcomeReview"]> | null = null;
  try {
    linked = harness.linkProposalOutcomeReview({
      runId: action.runId,
      immediateProxyReview: immediate,
    });
  } catch (error) {
    return {
      ...result,
      problems: [...(result.problems ?? []), `outcome review link failed: ${errorMessage(error)}`],
    };
  }
  if (!linked.proposalId) {
    return result;
  }
  if (linked.proposalStatus) {
    result.checks.push({
      name: "design proposal measuring",
      status: "passed",
      evidence: `${linked.proposalId}:${linked.proposalStatus}`,
    });
  }
  if (linked.outcomeReviewTaskId) {
    result.checks.push({
      name: "outcome review task",
      status: "passed",
      evidence: linked.outcomeReviewTaskId,
    });
    result.artifacts = [
      ...result.artifacts,
      {
        kind: "outcome-review",
        runId: action.runId,
        proposalId: linked.proposalId,
        taskId: linked.outcomeReviewTaskId,
        reviewDue: linked.reviewDue,
        reviewAt: linked.reviewAt,
        reason: linked.reason,
      },
    ];
  } else if (linked.reviewAt) {
    result.checks.push({
      name: "outcome review scheduled",
      status: "passed",
      evidence: `${linked.proposalId}:${linked.reviewAt}`,
    });
  }
  return result;
}
