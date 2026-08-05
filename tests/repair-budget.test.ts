import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach } from "bun:test";
import { Harness, applyHarnessAction } from "../packages/harness/src";
import {
  chargeRepairBudget,
  readRepairBudget,
  type RepairBudgetState,
} from "../packages/runner/src/hooks/repair-budget";

describe("repair/replan budget accounting", () => {
  test("readRepairBudget returns defaults for missing state", () => {
    const state = readRepairBudget({});
    expect(state.limit).toBe(3);
    expect(state.used).toBe(0);
    expect(state.entries).toEqual([]);
  });

  test("readRepairBudget honors configured limit", () => {
    const state = readRepairBudget({
      repairReplanBudget: { limit: 5, used: 2, entries: [] },
    });
    expect(state.limit).toBe(5);
    expect(state.used).toBe(2);
  });

  test("chargeRepairBudget charges idempotently and rejects after exhaustion", () => {
    const dir = mkdtempSync();
    const harness = new Harness(join(dir, "test.db"));
    harness.init();
    try {
      const runId = harness.createRun({ goal: "Bound repair growth" });
      const decision1 = chargeRepairBudget(harness, runId, {
        limit: 3,
        taskId: "task_a",
        attemptId: "attempt_a",
        kind: "repair",
        summary: "first repair",
      });
      expect(decision1.allowed).toBe(true);
      expect(decision1.charged).toBe(true);
      harness.updateRun({
        runId,
        contextPatch: { repairReplanBudget: decision1.nextBudget },
      });

      const decision1Repeat = chargeRepairBudget(harness, runId, {
        limit: 3,
        taskId: "task_a",
        attemptId: "attempt_a",
        kind: "repair",
        summary: "first repair",
      });
      expect(decision1Repeat.allowed).toBe(true);
      expect(decision1Repeat.charged).toBe(false);

      const decision2 = chargeRepairBudget(harness, runId, {
        limit: 3,
        taskId: "task_b",
        attemptId: "attempt_b",
        kind: "repair",
        summary: "second repair",
      });
      expect(decision2.allowed).toBe(true);
      harness.updateRun({
        runId,
        contextPatch: { repairReplanBudget: decision2.nextBudget },
      });

      const decision3 = chargeRepairBudget(harness, runId, {
        limit: 3,
        taskId: "task_c",
        attemptId: "attempt_c",
        kind: "repair",
        summary: "third repair",
      });
      expect(decision3.allowed).toBe(true);
      harness.updateRun({
        runId,
        contextPatch: { repairReplanBudget: decision3.nextBudget },
      });

      const decision4 = chargeRepairBudget(harness, runId, {
        limit: 3,
        taskId: "task_d",
        attemptId: "attempt_d",
        kind: "repair",
        summary: "fourth repair",
      });
      expect(decision4.allowed).toBe(false);
      expect(decision4.charged).toBe(false);
      expect(decision4.reason).toContain("exhausted");
    } finally {
      rmSync(dir);
    }
  });
});

describe("prepareRunDrain shared root cause", () => {
  let dir: string;
  let harness: Harness;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-budget-"));
    harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("synthetic 70-node fan-out produces one shared root cause and zero per-descendant attempts", () => {
    const runId = harness.createRun({
      goal: "Bound graph growth",
      context: { repairReplanBudget: { limit: 3, used: 0, entries: [] } } as Record<string, unknown>,
    });
    const rootTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Root worker",
      prompt: "Fail once.",
    });
    harness.recordAttempt({
      taskId: rootTaskId,
      input: { executor: "test" },
      output: {
        status: "blocked",
        summary: "Root failed permanently",
        changedFiles: [],
        checks: [{ name: "root", status: "failed" }],
        artifacts: [
          {
            kind: "acpx_terminal_evidence",
            terminalReason: "terminal_no_envelope",
          },
        ],
        problems: ["root unrecoverable"],
      },
    });
    const descendants: string[] = [];
    for (let index = 0; index < 69; index += 1) {
      const taskId = harness.createTask({
        runId,
        role: index % 7 === 0 ? "verifier" : "worker",
        goal: `Descendant ${index}`,
        prompt: `Depends on root.`,
        dependsOn: [rootTaskId],
      });
      descendants.push(taskId);
    }

    const result = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId,
      maxTries: 1,
    });

    const overview = harness.getRunOverview({ runId });
    const sessionsForDescendants = overview.sessions.filter((session) =>
      descendants.includes(session.taskId),
    );

    expect(result.status).toBe("done");
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "shared_root_cause",
        rootTaskId,
        descendantTaskIds: expect.arrayContaining(descendants),
      }),
    );
    expect(sessionsForDescendants).toHaveLength(0);
    const updatedRun = harness.getRun(runId);
    const sharedRoots = (updatedRun?.context.sharedRootCauses ?? []) as Array<Record<string, unknown>>;
    expect(sharedRoots).toHaveLength(1);
    expect(sharedRoots[0]?.rootTaskId).toBe(rootTaskId);
    expect(sharedRoots[0]?.terminalReason).toBe("terminal_no_envelope");
  });

  test("multi-level blocked dependencies retain the original root attempt without foreign-key failures", () => {
    const runId = harness.createRun({ goal: "Drain a multi-level dependency chain" });
    const rootTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Root worker",
      prompt: "Fail once.",
    });
    harness.recordAttempt({
      taskId: rootTaskId,
      input: { executor: "test" },
      output: {
        status: "blocked",
        summary: "Root failed permanently",
        changedFiles: [],
        checks: [{ name: "root", status: "failed" }],
        artifacts: [{ kind: "acpx_terminal_evidence", terminalReason: "hard_timeout" }],
        problems: ["root unrecoverable"],
      },
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify root",
      prompt: "Verify the root worker.",
      dependsOn: [rootTaskId],
    });
    const downstreamTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Use verified output",
      prompt: "Continue after verification.",
      dependsOn: [verifierTaskId],
    });

    const firstDrain = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId,
      maxTries: 3,
    });
    expect(firstDrain.status).toBe("done");
    expect(harness.getTask(verifierTaskId)?.status).toBe("blocked");

    const secondDrain = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId,
      maxTries: 3,
    });

    expect(secondDrain.status).toBe("done");
    expect(secondDrain.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "shared_root_cause",
        rootTaskId,
        terminalReason: "hard_timeout",
        descendantTaskIds: [downstreamTaskId],
      }),
    );
    expect(harness.getTask(downstreamTaskId)?.status).toBe("blocked");
    expect(harness.listLatestAttemptsForTasks([verifierTaskId, downstreamTaskId])).toHaveLength(0);
  });

  test("budget exhaustion produces one blocked decision with exhausted root causes", () => {
    const runId = harness.createRun({
      goal: "Bound repair growth",
      context: {
        repairReplanBudget: {
          limit: 3,
          used: 3,
          entries: [
            { taskId: "task_a", kind: "repair", summary: "first", chargedAt: "2026-01-01T00:00:00Z" },
            { taskId: "task_b", kind: "repair", summary: "second", chargedAt: "2026-01-01T00:00:00Z" },
            { taskId: "task_c", kind: "repair", summary: "third", chargedAt: "2026-01-01T00:00:00Z" },
          ],
          sharedRootCause: "task_a:terminal_no_envelope",
        },
      } as Record<string, unknown>,
    });
    const verifierTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify exhaust",
      prompt: "Verify.",
    });
    harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "test" },
      output: {
        status: "blocked",
        summary: "verifier blocked",
        changedFiles: [],
        checks: [{ name: "verifier", status: "failed" }],
        artifacts: [],
        problems: ["needs repair"],
      },
    });

    const decision = chargeRepairBudget(harness, runId, {
      limit: 3,
      taskId: verifierTaskId,
      attemptId: "attempt_exhaust",
      kind: "repair",
      summary: "attempt to repair after exhaustion",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.charged).toBe(false);
    expect(decision.exhaustedRootCauses).toContain("task_a:terminal_no_envelope");
    expect(decision.nextBudget.limit).toBe(3);
    expect(decision.nextBudget.used).toBe(3);
  });
});

function mkdtempSync() {
  const dir = `${tmpdir()}/ouroboros-budget-${Math.random().toString(36).slice(2)}`;
  Bun.spawnSync({ cmd: ["mkdir", "-p", dir], stdout: "ignore", stderr: "ignore" });
  return dir;
}

function rmSync(dir: string) {
  try {
    Bun.spawnSync({ cmd: ["rm", "-rf", dir], stdout: "ignore", stderr: "ignore" });
  } catch {
    // ignore
  }
}

void (undefined as unknown as RepairBudgetState);
