import type { Harness } from "@ouroboros/harness";

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
  const limit = state.limit > 0 ? state.limit : input.limit;
  const effectiveLimit = Math.min(limit, input.limit);
  const idempotencyKey = `${input.taskId}:${input.attemptId ?? ""}:${input.kind}`;
  const alreadyCharged = state.entries.find((entry) => `${entry.taskId}:${entry.attemptId ?? ""}:${entry.kind}` === idempotencyKey);
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

export function repairBudgetExhausted(state: RepairBudgetState): boolean {
  return state.used >= state.limit;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
