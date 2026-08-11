import { describe, expect, test } from "bun:test";
import {
  effectiveResourceHardTimeoutMs,
  effectiveResourceTaskLimit,
  freezeResourceAllocationV0,
  parseDesignResourceRequestV0,
  selectResourceAwareRuns,
} from "../packages/harness/src/index";

const request = {
  schemaVersion: 1,
  value: 5,
  informationGain: 4,
  maxDurationMinutes: 30,
  maxParallelTasks: 2,
  humanReviewMinutes: 10,
  paidUsd: 0,
} as const;

describe("ResourceAllocatorV0", () => {
  test("accepts one compact zero-spend request and freezes its proposal identity", () => {
    const parsed = parseDesignResourceRequestV0(request, "resourceRequest");
    expect(freezeResourceAllocationV0("design_high", parsed)).toEqual({
      ...request,
      proposalId: "design_high",
      priorityScore: 14,
    });
  });

  test("rejects spending, unknown fields, invalid scores, and unbounded resources", () => {
    for (const invalid of [
      { ...request, paidUsd: 1 },
      { ...request, surprise: true },
      { ...request, value: 0 },
      { ...request, informationGain: 6 },
      { ...request, maxDurationMinutes: 0 },
      { ...request, maxParallelTasks: 9 },
      { ...request, humanReviewMinutes: -1 },
    ]) {
      expect(() => parseDesignResourceRequestV0(invalid, "resourceRequest")).toThrow();
    }
  });

  test("selects one highest-value learning investment per project and preserves legacy work", () => {
    const high = freezeResourceAllocationV0("design_high", parseDesignResourceRequestV0(request));
    const low = freezeResourceAllocationV0(
      "design_low",
      parseDesignResourceRequestV0({ ...request, value: 2, informationGain: 2 }),
    );
    const runs = [
      { id: "legacy", projectId: "project_a", context: {} },
      { id: "low", projectId: "project_a", context: { resourceAllocation: low } },
      { id: "high", projectId: "project_a", context: { resourceAllocation: high } },
      { id: "other", projectId: "project_b", context: { resourceAllocation: low } },
    ];

    expect(selectResourceAwareRuns(runs, 10).map((run) => run.id)).toEqual([
      "legacy",
      "high",
      "other",
    ]);
  });

  test("enforces task parallelism and attempt duration without widening operator limits", () => {
    const allocation = freezeResourceAllocationV0(
      "design_high",
      parseDesignResourceRequestV0(request),
    );
    expect(effectiveResourceTaskLimit(6, allocation)).toBe(2);
    expect(effectiveResourceTaskLimit(1, allocation)).toBe(1);
    expect(effectiveResourceHardTimeoutMs(undefined, allocation)).toBe(30 * 60_000);
    expect(effectiveResourceHardTimeoutMs(10 * 60_000, allocation)).toBe(10 * 60_000);
  });
});
