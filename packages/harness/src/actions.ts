import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Harness } from "./harness";
import type { ReclaimedRunningTask, RunOverview, Task } from "./types";

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
    };

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
  throw new Error(
    "harness action type must be reclaimRunningTasks, retryTask, markRunTodo, updateRunContext, retireRun, prepareRunDrain, completeSystemTask, integrateVerifiedRun, interruptAttemptAndCreateTask, or interruptRunningAttemptsAndCreateTask",
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
    harness.updateRunStatus({ runId: action.runId, status: "blocked" });
    return doneResult(action.type, `Run ${action.runId} retired from the active queue.`, [
      { name: "run exists", status: "passed", evidence: action.runId },
      { name: "previous run status", status: "passed", evidence: run.status },
      { name: "retired run status", status: "passed", evidence: "blocked" },
      { name: "unfinished tasks blocked", status: "passed", evidence: String(blockedTasks.length) },
    ], [
      {
        kind: "run",
        runId: action.runId,
        previousStatus: run.status,
        status: "blocked",
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
  if (run.status !== "done") {
    return blockedIntegration(action.type, "Run is not complete.", checks, [`run status is ${run.status}`]);
  }
  checks.push({ name: "run status", status: "passed", evidence: "done" });

  const worker = selectIntegrationWorker(overview, action.workerTaskId);
  if (!worker) {
    return blockedIntegration(action.type, "No completed execution task with a worktree was found.", checks, [
      action.workerTaskId ? `worker task not integration-ready: ${action.workerTaskId}` : "no integration-ready worker task",
    ]);
  }
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

  const goalReview = selectCompletedGoalReview(overview);
  if (!goalReview) {
    return blockedIntegration(action.type, "Run has no completed goal-review decision.", checks, [
      "missing goal-review runDecision complete",
    ]);
  }
  checks.push({ name: "goal review", status: "passed", evidence: goalReview.id });

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
  const worktreePath = resolveWorktreePath(repoPath, worker.worktreePath);
  if (!worktreePath || !existsSync(worktreePath)) {
    return blockedIntegration(action.type, `Worker worktree does not exist: ${worker.worktreePath ?? "missing"}`, checks, [
      `worker worktree does not exist: ${worker.worktreePath ?? "missing"}`,
    ]);
  }
  checks.push({ name: "repository path", status: "passed", evidence: repoPath });
  checks.push({ name: "worktree path", status: "passed", evidence: worktreePath });

  const git = options.runGit ?? defaultGitRunner;
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
  if (targetStatus.stdout.trim().length > 0) {
    return blockedIntegration(action.type, "Target repository has uncommitted changes.", checks, [
      "target repository must be clean before integration",
    ]);
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
      goalReviewTaskId: goalReview.id,
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
  harness.updateRunStatus({ runId: action.runId, status: "todo" });
  const overview = harness.getRunOverview({ runId: action.runId, eventLimit: 0 });
  const active = overview.tasks.filter((task) => task.status === "todo" || task.status === "running");
  const checks: HarnessActionResult["checks"] = [
    { name: "run exists", status: "passed", evidence: action.runId },
    { name: "orphaned leases reclaimed", status: "passed", evidence: String(reclaimed.length) },
    { name: "run marked todo", status: "passed", evidence: "todo" },
  ];
  const artifacts: HarnessActionResult["artifacts"] = reclaimedArtifacts(reclaimed);
  artifacts.push({ kind: "run", runId: action.runId, previousStatus: run.status, status: "todo", reason: action.reason ?? null });

  if (active.length > 0) {
    checks.push({ name: "active work", status: "passed", evidence: `${active.length} todo/running task(s)` });
    artifacts.push(...active.map((task) => ({ kind: "active_task", taskId: task.id, role: task.role, status: task.status })));
    return doneResult(action.type, `Run ${action.runId} has ${active.length} active task${active.length === 1 ? "" : "s"} ready for a runner.`, checks, artifacts);
  }

  const review = ensureGoalReviewTask(harness, action.runId, maxTries, overview);
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

function ensureGoalReviewTask(
  harness: Harness,
  runId: string,
  maxTries: number,
  overview: ReturnType<Harness["getRunOverview"]>,
) {
  const blockedReview = [...overview.tasks].reverse().find(
    (task) => task.role === "goal-review" && task.status === "blocked",
  );
  if (blockedReview) {
    const tries = overview.sessions.filter((session) => session.taskId === blockedReview.id).length;
    if (tries >= maxTries) {
      return {
        status: "blocked" as const,
        summary: `Goal-review task ${blockedReview.id} already reached max tries.`,
        checks: [{ name: "goal review max tries", status: "failed" as const, evidence: `${tries}/${maxTries}` }],
        artifacts: [{ kind: "goal_review", taskId: blockedReview.id, tries, maxTries }],
        problems: [`goal-review max tries reached for ${blockedReview.id}`],
      };
    }
    harness.retryTask({ taskId: blockedReview.id });
    return {
      status: "done" as const,
      summary: `Goal-review task ${blockedReview.id} returned to todo.`,
      checks: [{ name: "goal review retried", status: "passed" as const, evidence: `${tries + 1}/${maxTries}` }],
      artifacts: [{ kind: "goal_review", taskId: blockedReview.id, status: "todo", retried: true, tries: tries + 1, maxTries }],
      problems: [],
    };
  }

  const taskId = harness.createTask({
    runId,
    role: "goal-review",
    goal: "Review whether the run goal is complete",
    prompt: [
      "Answer this before creating more work: are we sure the original run goal has been reached?",
      "",
      "Inspect the repository, tests, dashboard state, recent attempts, run lessons, and harness action events.",
      "Return structured JSON with runDecision complete, continue, verify, or defer.",
      "Do not declare complete unless concrete evidence proves the original goal is satisfied.",
    ].join("\n"),
    doneWhen: [
      "runDecision is complete, continue, verify, or defer",
      "decision cites repository, test, dashboard, and harness action evidence",
      "complete creates no nextTasks",
      "defer cites the external dependency or missing action and creates no nextTasks",
      "continue or verify includes one to five follow-up tasks",
    ],
  });
  return {
    status: "done" as const,
    summary: `Created goal-review task ${taskId}.`,
    checks: [{ name: "goal review created", status: "passed" as const, evidence: taskId }],
    artifacts: [{ kind: "goal_review", taskId, status: "todo", created: true }],
    problems: [],
  };
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
    return session?.output.status === "done" && session.output.runDecision === "complete";
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

function safeRequest(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
}

function resultToRecord(result: HarnessActionResult): Record<string, unknown> {
  return { ...result };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
