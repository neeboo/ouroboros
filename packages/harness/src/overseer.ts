import type { ExecutionThread, ObservableSession, RunOverview, Status, Task } from "./types";

export type RunSupervisorState = "draining" | "waiting" | "orphaned" | "paused" | "blocked" | "complete";

export interface OverseerActiveWork {
  readyTaskIds: string[];
  runningTaskIds: string[];
}

export interface OverseerDuplicateTaskGoal {
  goal: string;
  taskIds: string[];
  roles: string[];
  statuses: Status[];
}

export interface OverseerRepeatedBlockedFailure {
  taskId: string;
  taskGoal: string;
  attemptIds: string[];
  summaries: string[];
}

export interface OverseerOrphanedLease {
  taskId: string;
  sessionRef: string | null;
  worktreePath: string | null;
  reason: string;
}

export interface OverseerAttemptEvent {
  attemptId: string;
  taskId: string;
  role: string;
  sequence: number;
  stream: string;
  text: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface OverseerDiagnosis {
  state: RunSupervisorState;
  activeWork: OverseerActiveWork;
  runningAttempts: ObservableSession[];
  executionThreads: ExecutionThread[];
  recentAttemptEvents: OverseerAttemptEvent[];
  duplicateTaskGoals: OverseerDuplicateTaskGoal[];
  emptyRunGoalReviewRaceRisk: boolean;
  repeatedBlockedFailures: OverseerRepeatedBlockedFailure[];
  orphanedLeases: OverseerOrphanedLease[];
  queueStarvation: boolean;
}

export function diagnoseRunOverview(overview: RunOverview): OverseerDiagnosis {
  const tasks = overview.tasks;
  const readyTaskIds = tasks.filter((task) => task.status === "todo" && isTaskReady(task, tasks)).map((task) => task.id);
  const runningTasks = tasks.filter((task) => task.status === "running");
  const runningTaskIds = runningTasks.map((task) => task.id);
  const runningAttempts = overview.sessions.filter((session) => session.status === "running");
  const runningAttemptTaskIds = new Set(runningAttempts.map((attempt) => attempt.taskId));
  const liveRunnerPresent = runningAttempts.length > 0 || overview.threads.some((thread) => thread.status === "running");
  const recentAttemptEvents = overview.sessions.flatMap((session) =>
    session.events.map((event) => ({
      attemptId: session.attemptId,
      taskId: session.taskId,
      role: session.role,
      sequence: event.sequence,
      stream: event.stream,
      text: event.text,
      payload: event.payload,
      createdAt: event.createdAt,
    })),
  );
  const duplicateTaskGoals = collectDuplicateTaskGoals(tasks);
  const repeatedBlockedFailures = collectRepeatedBlockedFailures(overview.sessions, tasks);
  const paused = runIsPaused(overview);
  const orphanedLeases = runningTasks
    .filter((task) => !runningAttemptTaskIds.has(task.id))
    .map((task) => ({
      taskId: task.id,
      sessionRef: task.sessionRef,
      worktreePath: task.worktreePath,
      reason: "running task has no running attempt",
    }));
  const emptyRunGoalReviewRaceRisk =
    overview.run?.status !== "done" &&
    !tasks.some((task) => task.role === "goal-review") &&
    readyTaskIds.length === 0 &&
    runningTaskIds.length === 0 &&
    runningAttempts.length === 0 &&
    overview.threads.every((thread) => thread.status !== "running") &&
    !tasks.some((task) => task.status === "blocked");
  const queueStarvation = !paused && readyTaskIds.length > 0 && !liveRunnerPresent;
  const blockedOnlyRemaining =
    tasks.some((task) => task.status === "blocked") &&
    tasks.every((task) => task.status === "blocked" || task.status === "done");

  return {
    state: deriveState({
      runStatus: overview.run?.status ?? "todo",
      readyTaskIds,
      runningTaskIds,
      runningAttempts,
      threads: overview.threads,
      orphanedLeases,
      blockedOnlyRemaining,
      paused,
    }),
    activeWork: {
      readyTaskIds,
      runningTaskIds,
    },
    runningAttempts,
    executionThreads: overview.threads,
    recentAttemptEvents,
    duplicateTaskGoals,
    emptyRunGoalReviewRaceRisk,
    repeatedBlockedFailures,
    orphanedLeases,
    queueStarvation,
  };
}

function deriveState(input: {
  runStatus: Status;
  readyTaskIds: string[];
  runningTaskIds: string[];
  runningAttempts: ObservableSession[];
  threads: ExecutionThread[];
  orphanedLeases: OverseerOrphanedLease[];
  blockedOnlyRemaining: boolean;
  paused: boolean;
}): RunSupervisorState {
  if (input.runStatus === "done") {
    return "complete";
  }
  if (input.paused) {
    return "paused";
  }
  if (input.blockedOnlyRemaining) {
    return "blocked";
  }
  if (
    input.orphanedLeases.length > 0 ||
    (input.readyTaskIds.length > 0 && input.runningAttempts.length === 0 && input.threads.every((thread) => thread.status !== "running"))
  ) {
    return "orphaned";
  }
  if (input.runningAttempts.length > 0 || input.threads.some((thread) => thread.status === "running")) {
    return "draining";
  }
  if (input.readyTaskIds.length > 0 || input.runningTaskIds.length > 0) {
    return "waiting";
  }
  return "waiting";
}

function runIsPaused(overview: RunOverview) {
  const context = overview.run?.context ?? {};
  if (isActiveRunPause(context.runPause)) {
    return true;
  }
  const pauseClearedAt = parseTimestampMs(context.runPauseClearedAt);
  return overview.threads.some((thread) => {
    if (thread.status !== "interrupted" || !isHumanStopReason(thread.interruptReason)) {
      return false;
    }
    const interruptedAt = parseTimestampMs(thread.interruptedAt) ?? parseTimestampMs(thread.updatedAt);
    return pauseClearedAt === null || interruptedAt === null || interruptedAt > pauseClearedAt;
  });
}

function isActiveRunPause(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHumanStopReason(reason: string | null) {
  if (!reason) {
    return false;
  }
  const normalized = reason.toLowerCase();
  return normalized.includes("human") || normalized.includes("user") || normalized.includes("dashboard") || normalized.includes("manual");
}

function parseTimestampMs(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function collectDuplicateTaskGoals(tasks: Task[]): OverseerDuplicateTaskGoal[] {
  const byGoal = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.status !== "todo" && task.status !== "running") {
      continue;
    }
    const goal = task.goal.trim();
    if (!goal) {
      continue;
    }
    const current = byGoal.get(goal) ?? [];
    current.push(task);
    byGoal.set(goal, current);
  }

  return [...byGoal.entries()]
    .filter(([, groupedTasks]) => groupedTasks.length > 1)
    .map(([goal, groupedTasks]) => ({
      goal,
      taskIds: groupedTasks.map((task) => task.id),
      roles: groupedTasks.map((task) => task.role),
      statuses: groupedTasks.map((task) => task.status),
    }));
}

function collectRepeatedBlockedFailures(
  sessions: ObservableSession[],
  tasks: Task[],
): OverseerRepeatedBlockedFailure[] {
  const taskGoals = new Map(tasks.map((task) => [task.id, task.goal]));
  const blockedByTask = new Map<
    string,
    Array<Pick<ObservableSession, "attemptId" | "taskId"> & { summary: string }>
  >();

  for (const session of sessions) {
    if (session.status !== "blocked") {
      continue;
    }
    const summary = extractSummary(session.output);
    const current = blockedByTask.get(session.taskId) ?? [];
    current.push({
      attemptId: session.attemptId,
      taskId: session.taskId,
      summary,
    });
    blockedByTask.set(session.taskId, current);
  }

  return [...blockedByTask.entries()]
    .filter(([, attempts]) => attempts.length > 1)
    .map(([taskId, attempts]) => ({
      taskId,
      taskGoal: taskGoals.get(taskId) ?? "",
      attemptIds: attempts.map((attempt) => attempt.attemptId),
      summaries: attempts.map((attempt) => attempt.summary),
    }));
}

function isTaskReady(task: Task, tasks: Task[]) {
  const statusById = new Map(tasks.map((candidate) => [candidate.id, candidate.status]));
  const repairTasksByParent = new Map<string, Task[]>();
  const verifiedRepairIds = new Set<string>();

  for (const candidate of tasks) {
    if (candidate.role === "worker" && candidate.status === "done" && candidate.parentId) {
      const repairTasks = repairTasksByParent.get(candidate.parentId) ?? [];
      repairTasks.push(candidate);
      repairTasksByParent.set(candidate.parentId, repairTasks);
    }
    if (candidate.role === "verifier" && candidate.status === "done") {
      for (const dependencyId of candidate.dependsOn) {
        verifiedRepairIds.add(dependencyId);
      }
    }
  }

  const checkTask = (taskId: string) => {
    const status = statusById.get(taskId);
    if (status === "done") {
      return true;
    }
    if (status !== "blocked") {
      return false;
    }
    return (repairTasksByParent.get(taskId) ?? []).some((repairTask) => verifiedRepairIds.has(repairTask.id));
  };

  return task.dependsOn.every(checkTask);
}

function extractSummary(output: ObservableSession["output"]) {
  return typeof output.summary === "string" ? output.summary.trim() : "";
}
