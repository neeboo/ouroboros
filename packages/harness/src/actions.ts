import { existsSync, readFileSync } from "node:fs";
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
import type { AttemptOutput, ReclaimedRunningTask, RunOverview, Task } from "./types";

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
    };

export interface ContractAmendmentEntry {
  contractKey: string;
  version: number;
  previousValue: unknown;
  value: unknown;
  reason: string | null;
  amendedAt: string;
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
}

interface GitCommandInput {
  cwd: string;
  args: string[];
}

interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type GitRunner = (input: GitCommandInput) => GitCommandResult;

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
    return {
      type,
      runId: stringField(record, "runId"),
      workerTaskId: optionalStringField(record, "workerTaskId"),
      repoPath: optionalStringField(record, "repoPath"),
      targetBranch: optionalStringField(record, "targetBranch"),
      commitMessage: optionalStringField(record, "commitMessage"),
      push: optionalBooleanField(record, "push"),
      reason: optionalStringField(record, "reason"),
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
  throw new Error(
    "harness action type must be reclaimRunningTasks, retryTask, markRunTodo, updateRunContext, amendRunContract, retireRun, prepareRunDrain, completeSystemTask, integrateVerifiedRun, interruptAttemptAndCreateTask, interruptRunningAttemptsAndCreateTask, or acceptGuardrailProposal",
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

  const result = applyParsedHarnessAction(harness, action, options);
  const eventId = harness.recordHarnessActionEvent({
    actionType: action.type,
    status: result.status,
    request: action,
    result: resultToRecord(result),
  });
  return { ...result, eventId };
}

function applyParsedHarnessAction(harness: Harness, action: HarnessAction, options: HarnessActionOptions): HarnessActionResult {
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
    return integrateVerifiedRun(harness, action, options);
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
  const changedFiles = Array.isArray(workerSession?.output.changedFiles) ? workerSession.output.changedFiles : [];
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
    worker = { ...worker, id: redirectedFromRepair.sourceWorkerId, worktreePath };
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

  if (targetStatus.stdout.trim().length > 0) {
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

  const sourceBranchResult = runGitStep(git, worktreePath, ["branch", "--show-current"]);
  if (!sourceBranchResult.ok) {
    return blockedCommand(action.type, "Could not read worker worktree branch.", checks, sourceBranchResult);
  }
  const sourceBranch = sourceBranchResult.stdout.trim();
  if (!sourceBranch || sourceBranch === targetBranch) {
    return blockedIntegration(action.type, "Worker worktree is not on an integration branch.", checks, [
      `source branch is ${sourceBranch || "detached HEAD"}`,
    ]);
  }
  checks.push({ name: "source branch", status: "passed", evidence: sourceBranch });

  const workerStatus = runGitStep(git, worktreePath, ["status", "--short"]);
  if (!workerStatus.ok) {
    return blockedCommand(action.type, "Could not inspect worker worktree status.", checks, workerStatus);
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
  const blockedDependencies = harness.blockTasksWithBlockedDependencies({
    runId: action.runId,
    reason: "task dependencies are blocked",
  });
  const overview = harness.getRunOverview({ runId: action.runId, eventLimit: 0 });
  const active = overview.tasks.filter((task) => task.status === "todo" || task.status === "running");
  const checks: HarnessActionResult["checks"] = [
    { name: "run exists", status: "passed", evidence: action.runId },
    { name: "orphaned leases reclaimed", status: "passed", evidence: String(reclaimed.length) },
    { name: "run marked todo", status: "passed", evidence: "todo" },
  ];
  const artifacts: HarnessActionResult["artifacts"] = reclaimedArtifacts(reclaimed);
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
  const latestProgressIndex = overview.sessions.reduce((latest, session, index) => {
    return session.role !== "goal-review" && session.status === "done" ? index : latest;
  }, -1);
  const currentReviewSessions = goalReviewInvalidated
    ? []
    : overview.sessions.filter(
      (session, index) => index > latestProgressIndex && session.role === "goal-review" && session.status === "done",
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
      (task) => task.role === "goal-review" && task.status === "blocked",
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
      const taskId = createGoalReviewTask(harness, runId);
      return {
        status: "done" as const,
        summary: `Created fresh goal-review task ${taskId} after newer work superseded ${blockedReview.id}.`,
        checks: [
          { name: "superseded goal review", status: "passed" as const, evidence: blockedReview.id },
          { name: "goal review created", status: "passed" as const, evidence: taskId },
        ],
        artifacts: [
          { kind: "goal_review", taskId: blockedReview.id, status: "blocked", superseded: true },
          { kind: "goal_review", taskId, status: "todo", created: true },
        ],
        problems: [],
      };
    }
    if (blockedTries >= maxTries) {
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

  const taskId = createGoalReviewTask(harness, runId);
  return {
    status: "done" as const,
    summary: `Created goal-review task ${taskId}.`,
    checks: [{ name: "goal review created", status: "passed" as const, evidence: taskId }],
    artifacts: [{ kind: "goal_review", taskId, status: "todo", created: true }],
    problems: [],
  };
}

function createGoalReviewTask(harness: Harness, runId: string) {
  return harness.createTask({
    runId,
    role: "goal-review",
    goal: GOAL_REVIEW_TASK_GOAL,
    prompt: GOAL_REVIEW_TASK_PROMPT,
    doneWhen: GOAL_REVIEW_TASK_DONE_WHEN,
  });
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
    const changedFiles = Array.isArray(session?.output.changedFiles) ? session.output.changedFiles : [];
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
    if (event.actionType !== "integrateVerifiedRun" || event.status !== "done") {
      continue;
    }
    const request = event.request as Record<string, unknown>;
    if (request.runId !== runId || typeof request.workerTaskId !== "string") {
      continue;
    }
    const result = event.result as Record<string, unknown>;
    const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
    const integratedIds = artifacts.flatMap((artifact) => {
      if (!artifact || typeof artifact !== "object") {
        return [];
      }
      const record = artifact as Record<string, unknown>;
      if (record.kind !== "integration" || typeof record.workerTaskId !== "string") {
        return [];
      }
      return [record.workerTaskId];
    });
    if (integratedIds.length > 0) {
      ids.add(request.workerTaskId);
    }
    for (const id of integratedIds) {
      ids.add(id);
    }
    if (integratedIds.length === 0) {
      ids.add(request.workerTaskId);
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
  return [...overview.tasks].reverse().find((task) => {
    if (task.role !== "goal-review" || task.status !== "done") {
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
  });
  return {
    exitCode: result.exitCode,
    stdout: decodeCommandOutput(result.stdout),
    stderr: decodeCommandOutput(result.stderr),
  };
}

function runGitStep(git: GitRunner, cwd: string, args: string[]) {
  const result = git({ cwd, args });
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
  return { ok: true, files: [...files].sort() };
}

function normalizeRelativeFiles(files: string[]) {
  return files.filter((file) =>
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
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
}

function resultToRecord(result: HarnessActionResult): Record<string, unknown> {
  return { ...result };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
