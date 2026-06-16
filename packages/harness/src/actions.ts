import { Harness } from "./harness";
import type { ReclaimedRunningTask } from "./types";

export type HarnessAction =
  | { type: "reclaimRunningTasks"; runId: string; reason?: string }
  | { type: "retryTask"; taskId: string; reason?: string }
  | { type: "markRunTodo"; runId: string; reason?: string }
  | { type: "retireRun"; runId: string; reason: string }
  | { type: "prepareRunDrain"; runId: string; maxTries?: number; reason?: string }
  | { type: "completeSystemTask"; taskId: string; actionEventId: string; reason?: string }
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
    "harness action type must be reclaimRunningTasks, retryTask, markRunTodo, retireRun, prepareRunDrain, completeSystemTask, interruptAttemptAndCreateTask, or interruptRunningAttemptsAndCreateTask",
  );
}

export function applyHarnessAction(harness: Harness, rawAction: unknown): HarnessActionResult & { eventId: string } {
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

  const result = applyParsedHarnessAction(harness, action);
  const eventId = harness.recordHarnessActionEvent({
    actionType: action.type,
    status: result.status,
    request: action,
    result: resultToRecord(result),
  });
  return { ...result, eventId };
}

function applyParsedHarnessAction(harness: Harness, action: HarnessAction): HarnessActionResult {
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
      "Return structured JSON with runDecision complete, continue, or verify.",
      "Do not declare complete unless concrete evidence proves the original goal is satisfied.",
    ].join("\n"),
    doneWhen: [
      "runDecision is complete, continue, or verify",
      "decision cites repository, test, dashboard, and harness action evidence",
      "complete creates no nextTasks",
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
