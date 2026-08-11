import type {
  DesignResourceRequestV0,
  FrozenResourceAllocationV0,
} from "./types";

const REQUEST_KEYS = new Set([
  "schemaVersion",
  "value",
  "informationGain",
  "maxDurationMinutes",
  "maxParallelTasks",
  "humanReviewMinutes",
  "paidUsd",
]);

const ALLOCATION_KEYS = new Set([...REQUEST_KEYS, "proposalId", "priorityScore"]);

export const RESOURCE_ALLOCATION_LIMITS = {
  maxDurationMinutes: 24 * 60,
  maxParallelTasks: 8,
  maxHumanReviewMinutes: 8 * 60,
} as const;

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: Set<string>, label: string) {
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} has unsupported fields: ${unexpected.sort().join(", ")}`);
  }
}

function integerInRange(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

export function parseDesignResourceRequestV0(
  value: unknown,
  label = "resourceRequest",
): DesignResourceRequestV0 {
  const record = objectRecord(value, label);
  exactKeys(record, REQUEST_KEYS, label);
  if (record.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion must be 1`);
  }
  if (record.paidUsd !== 0 || !Object.is(record.paidUsd, 0)) {
    throw new Error(`${label}.paidUsd must be literal 0; paid work requires human authority`);
  }
  return {
    schemaVersion: 1,
    value: integerInRange(record.value, 1, 5, `${label}.value`),
    informationGain: integerInRange(record.informationGain, 1, 5, `${label}.informationGain`),
    maxDurationMinutes: integerInRange(
      record.maxDurationMinutes,
      1,
      RESOURCE_ALLOCATION_LIMITS.maxDurationMinutes,
      `${label}.maxDurationMinutes`,
    ),
    maxParallelTasks: integerInRange(
      record.maxParallelTasks,
      1,
      RESOURCE_ALLOCATION_LIMITS.maxParallelTasks,
      `${label}.maxParallelTasks`,
    ),
    humanReviewMinutes: integerInRange(
      record.humanReviewMinutes,
      0,
      RESOURCE_ALLOCATION_LIMITS.maxHumanReviewMinutes,
      `${label}.humanReviewMinutes`,
    ),
    paidUsd: 0,
  };
}

export function freezeResourceAllocationV0(
  proposalId: string,
  request: DesignResourceRequestV0,
): FrozenResourceAllocationV0 {
  if (typeof proposalId !== "string" || proposalId.trim() !== proposalId || proposalId.length === 0) {
    throw new Error("resource allocation proposalId must be a non-empty exact string");
  }
  const normalized = parseDesignResourceRequestV0(request);
  return {
    ...normalized,
    proposalId,
    priorityScore: normalized.value * 2 + normalized.informationGain,
  };
}

export function parseFrozenResourceAllocationV0(
  value: unknown,
  label = "resourceAllocation",
): FrozenResourceAllocationV0 {
  const record = objectRecord(value, label);
  exactKeys(record, ALLOCATION_KEYS, label);
  const proposalId = record.proposalId;
  if (typeof proposalId !== "string" || proposalId.trim() !== proposalId || proposalId.length === 0) {
    throw new Error(`${label}.proposalId must be a non-empty exact string`);
  }
  const request = parseDesignResourceRequestV0(
    Object.fromEntries([...REQUEST_KEYS].map((key) => [key, record[key]])),
    label,
  );
  const expected = freezeResourceAllocationV0(proposalId, request);
  if (record.priorityScore !== expected.priorityScore) {
    throw new Error(`${label}.priorityScore does not match value and informationGain`);
  }
  return expected;
}

type ResourceAwareRun = {
  id: string;
  projectId: string | null;
  context: Record<string, unknown>;
};

function allocationFromRun(run: ResourceAwareRun): FrozenResourceAllocationV0 | null {
  if (run.context.resourceAllocation === undefined) {
    return null;
  }
  return parseFrozenResourceAllocationV0(
    run.context.resourceAllocation,
    `run ${run.id} resourceAllocation`,
  );
}

export function selectResourceAwareRuns<T extends ResourceAwareRun>(runs: T[], limit: number): T[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  const winnerByProject = new Map<string, { run: T; allocation: FrozenResourceAllocationV0 }>();
  for (const run of runs) {
    const allocation = allocationFromRun(run);
    if (!allocation) continue;
    const projectKey = run.projectId ?? `unbound:${run.id}`;
    const current = winnerByProject.get(projectKey);
    if (
      !current
      || allocation.priorityScore > current.allocation.priorityScore
      || (
        allocation.priorityScore === current.allocation.priorityScore
        && allocation.maxDurationMinutes < current.allocation.maxDurationMinutes
      )
      || (
        allocation.priorityScore === current.allocation.priorityScore
        && allocation.maxDurationMinutes === current.allocation.maxDurationMinutes
        && allocation.proposalId.localeCompare(current.allocation.proposalId) < 0
      )
    ) {
      winnerByProject.set(projectKey, { run, allocation });
    }
  }
  const selectedIds = new Set([...winnerByProject.values()].map(({ run }) => run.id));
  return runs
    .filter((run) => run.context.resourceAllocation === undefined || selectedIds.has(run.id))
    .slice(0, boundedLimit);
}

export function effectiveResourceTaskLimit(
  configuredLimit: number,
  allocation: FrozenResourceAllocationV0 | null,
): number {
  const normalized = Math.max(1, Math.floor(configuredLimit));
  return allocation ? Math.min(normalized, allocation.maxParallelTasks) : normalized;
}

export function effectiveResourceHardTimeoutMs(
  configuredTimeoutMs: number | undefined,
  allocation: FrozenResourceAllocationV0 | null,
): number | undefined {
  if (!allocation) return configuredTimeoutMs;
  const resourceLimit = allocation.maxDurationMinutes * 60_000;
  return configuredTimeoutMs === undefined
    ? resourceLimit
    : Math.min(configuredTimeoutMs, resourceLimit);
}
