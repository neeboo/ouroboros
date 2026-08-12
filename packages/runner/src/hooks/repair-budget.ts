import type { Harness, RunOverview } from "@ouroboros/harness";

export interface RepairBudgetEntry {
  taskId: string;
  attemptId?: string;
  kind: "repair" | "replan" | "shared-root";
  summary: string;
  chargedAt: string;
  rootTaskId?: string;
  rootCause?: string;
}

export interface RepairBudgetState {
  limit: number;
  used: number;
  entries: RepairBudgetEntry[];
  exhaustedRootCauses?: string[];
  sharedRootCause?: string | null;
}

export interface RepairBudgetChargeInput {
  limit: number;
  taskId: string;
  attemptId?: string;
  kind: "repair" | "replan" | "shared-root";
  summary: string;
  rootTaskId?: string;
  rootCause?: string;
}

export interface RepairBudgetChargeDecision {
  allowed: boolean;
  charged: boolean;
  reason: string;
  limit: number;
  used: number;
  nextBudget: RepairBudgetState;
  exhaustedRootCauses: string[];
  sharedRootCause: string | null;
}

const DEFAULT_BUDGET_LIMIT = 3;

export function readRepairBudget(runContext: Record<string, unknown>): RepairBudgetState {
  const raw = runContext.repairReplanBudget;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { limit: DEFAULT_BUDGET_LIMIT, used: 0, entries: [] };
  }
  const record = raw as Record<string, unknown>;
  const limit = typeof record.limit === "number" && record.limit > 0 ? record.limit : DEFAULT_BUDGET_LIMIT;
  const used = typeof record.used === "number" ? record.used : 0;
  const entries = Array.isArray(record.entries)
    ? record.entries.filter(isRepairBudgetEntry)
    : [];
  const exhaustedRootCauses = Array.isArray(record.exhaustedRootCauses)
    ? record.exhaustedRootCauses.filter((value): value is string => typeof value === "string")
    : [];
  const sharedRootCause =
    typeof record.sharedRootCause === "string" || record.sharedRootCause === null
      ? (record.sharedRootCause as string | null)
      : null;
  return { limit, used, entries, exhaustedRootCauses, sharedRootCause };
}

function isRepairBudgetEntry(value: unknown): RepairBudgetEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false as never;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.taskId !== "string" || typeof record.summary !== "string") {
    return false as never;
  }
  if (record.kind !== "repair" && record.kind !== "replan" && record.kind !== "shared-root") {
    return false as never;
  }
  return {
    taskId: record.taskId,
    attemptId: typeof record.attemptId === "string" ? record.attemptId : undefined,
    kind: record.kind,
    summary: record.summary,
    chargedAt: typeof record.chargedAt === "string" ? record.chargedAt : new Date(0).toISOString(),
    rootTaskId: typeof record.rootTaskId === "string" ? record.rootTaskId : undefined,
    rootCause: typeof record.rootCause === "string" ? record.rootCause : undefined,
  } as RepairBudgetEntry;
}

export function chargeRepairBudget(
  harness: Harness,
  runId: string,
  input: RepairBudgetChargeInput,
): RepairBudgetChargeDecision {
  const run = harness.getRun(runId);
  if (!run) {
    return {
      allowed: false,
      charged: false,
      reason: `run not found: ${runId}`,
      limit: input.limit,
      used: 0,
      nextBudget: { limit: input.limit, used: 0, entries: [] },
      exhaustedRootCauses: [],
      sharedRootCause: null,
    };
  }
  const state = readRepairBudget(run.context);
  const overview = harness.getRunOverview({ runId, eventLimit: 0 });
  const reconciliation = reconcileGoalReviewRepairBudget(state, overview);
  return chargeRepairBudgetState(reconciliation.nextBudget, input);
}

export interface GoalReviewRepairTrigger {
  taskId: string;
  attemptId?: string;
  role: string;
  rootCause: string;
}

export function chargeRepairBudgetState(
  state: RepairBudgetState,
  input: RepairBudgetChargeInput,
): RepairBudgetChargeDecision {
  const limit = state.limit > 0 ? state.limit : input.limit;
  const effectiveLimit = Math.min(limit, input.limit);
  const idempotencyKey = `${input.taskId}:${input.kind}`;
  const alreadyCharged = state.entries.find((entry) => `${entry.taskId}:${entry.kind}` === idempotencyKey);
  if (alreadyCharged) {
    return {
      allowed: true,
      charged: false,
      reason: "charge already recorded for this task and attempt",
      limit: effectiveLimit,
      used: state.used,
      nextBudget: state,
      exhaustedRootCauses: state.exhaustedRootCauses ?? [],
      sharedRootCause: state.sharedRootCause ?? null,
    };
  }
  if (state.used >= effectiveLimit) {
    const exhaustedRootCauses = unique([state.sharedRootCause, ...(state.exhaustedRootCauses ?? [])].filter((value): value is string => Boolean(value)));
    const next: RepairBudgetState = {
      ...state,
      limit: effectiveLimit,
      exhaustedRootCauses,
    };
    return {
      allowed: false,
      charged: false,
      reason: `repair/replan budget exhausted at ${state.used}/${effectiveLimit}`,
      limit: effectiveLimit,
      used: state.used,
      nextBudget: next,
      exhaustedRootCauses,
      sharedRootCause: state.sharedRootCause ?? null,
    };
  }
  const entry: RepairBudgetEntry = {
    taskId: input.taskId,
    attemptId: input.attemptId,
    kind: input.kind,
    summary: input.summary,
    chargedAt: new Date().toISOString(),
    rootTaskId: input.rootTaskId,
    rootCause: input.rootCause,
  };
  const next: RepairBudgetState = {
    ...state,
    limit: effectiveLimit,
    used: state.used + 1,
    entries: [...state.entries, entry],
  };
  return {
    allowed: true,
    charged: true,
    reason: `charged repair/replan budget ${state.used + 1}/${effectiveLimit}`,
    limit: effectiveLimit,
    used: state.used,
    nextBudget: next,
    exhaustedRootCauses: state.exhaustedRootCauses ?? [],
    sharedRootCause: state.sharedRootCause ?? null,
  };
}

export function reconcileGoalReviewRepairBudget(
  state: RepairBudgetState,
  overview: Pick<RunOverview, "tasks" | "sessions">,
): { nextBudget: RepairBudgetState; chargedTaskIds: string[] } {
  const taskById = new Map(overview.tasks.map((task) => [task.id, task]));
  let nextBudget = state;
  const chargedTaskIds: string[] = [];

  for (const session of overview.sessions) {
    const task = taskById.get(session.taskId);
    if (!task || task.role !== "goal-review" || session.status === "running") {
      continue;
    }
    if (session.output.runDecision !== "continue" && session.output.runDecision !== "verify") {
      continue;
    }
    const createdTaskIds = (session.output.artifacts ?? []).flatMap((artifact) => {
        if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
          return [];
        }
        const record = artifact as Record<string, unknown>;
        if (
          record.kind !== "created_task"
          || record.sourceTaskId !== task.id
          || typeof record.taskId !== "string"
        ) {
          return [];
        }
        return [record.taskId];
      });
    const createdFollowupWork = createdTaskIds.some((taskId) => taskById.has(taskId));
    if (!createdFollowupWork) {
      continue;
    }
    const trigger = goalReviewRepairTrigger(overview, task.id, session.attemptId);
    if (!trigger) {
      continue;
    }
    if (nextBudget.entries.some((entry) => entry.taskId === task.id && entry.kind === "replan")) {
      continue;
    }
    const decision = chargeRepairBudgetState(nextBudget, {
      limit: nextBudget.limit,
      taskId: task.id,
      kind: "replan",
      summary: `reconciled goal-review follow-up after blocked ${trigger.role} ${trigger.taskId}`,
      rootTaskId: trigger.taskId,
      rootCause: trigger.rootCause,
    });
    nextBudget = decision.nextBudget;
    if (decision.charged) {
      chargedTaskIds.push(task.id);
    }
  }

  return { nextBudget, chargedTaskIds };
}

export function goalReviewRepairTrigger(
  overview: Pick<RunOverview, "tasks" | "sessions">,
  goalReviewTaskId: string,
  goalReviewAttemptId?: string,
): GoalReviewRepairTrigger | null {
  const sessions = overview.sessions;
  const reviewTaskIndex = overview.tasks.findIndex((task) => task.id === goalReviewTaskId);
  const taskIndexById = new Map(overview.tasks.map((task, index) => [task.id, index]));
  let reviewSessionIndex = goalReviewAttemptId
    ? sessions.findIndex((session) => session.attemptId === goalReviewAttemptId && session.taskId === goalReviewTaskId)
    : -1;
  if (reviewSessionIndex < 0) {
    for (let index = sessions.length - 1; index >= 0; index -= 1) {
      if (sessions[index]?.taskId === goalReviewTaskId) {
        reviewSessionIndex = index;
        break;
      }
    }
  }
  if (reviewSessionIndex >= 0) {
    for (let index = reviewSessionIndex - 1; index >= 0; index -= 1) {
      const session = sessions[index]!;
      if (session.status === "running" || session.role === "goal-review" || session.role === "system") {
        continue;
      }
      if (reviewTaskIndex >= 0 && (taskIndexById.get(session.taskId) ?? Number.MAX_SAFE_INTEGER) >= reviewTaskIndex) {
        continue;
      }
      if (session.status !== "blocked") {
        return null;
      }
      return {
        taskId: session.taskId,
        attemptId: session.attemptId,
        role: session.role,
        rootCause: `blocked ${session.role} ${session.taskId} attempt ${session.attemptId}`,
      };
    }
    return null;
  }

  if (reviewTaskIndex < 0) {
    return null;
  }
  for (let index = reviewTaskIndex - 1; index >= 0; index -= 1) {
    const task = overview.tasks[index]!;
    if (task.role === "goal-review" || task.role === "system") {
      continue;
    }
    return task.status === "blocked"
      ? { taskId: task.id, role: task.role, rootCause: `blocked ${task.role} ${task.id}` }
      : null;
  }
  return null;
}

export function repairBudgetExhausted(state: RepairBudgetState): boolean {
  return state.used >= state.limit;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
