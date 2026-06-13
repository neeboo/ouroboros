import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Harness } from "../packages/harness/src";

describe("Harness", () => {
  let dir: string;
  let harness: Harness;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-"));
    harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("creates a run and task", () => {
    const runId = harness.createRun({
      goal: "Bootstrap this repository",
      context: { repo: "ouroboros" },
    });
    const taskId = harness.createTask({
      runId,
      role: "planner",
      goal: "Create the first task graph",
      prompt: "Plan the smallest useful harness loop.",
      doneWhen: ["task graph exists"],
    });

    const run = harness.getRun(runId);
    const task = harness.getTask(taskId);

    expect(run).toMatchObject({
      id: runId,
      goal: "Bootstrap this repository",
      status: "todo",
      context: { repo: "ouroboros" },
    });
    expect(task).toMatchObject({
      id: taskId,
      runId,
      status: "todo",
      role: "planner",
    });
  });

  test("waits for dependencies before returning the next ready task", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const first = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan",
      prompt: "Plan.",
    });
    const second = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement",
      prompt: "Implement.",
      dependsOn: [first],
    });

    const ready = harness.nextReadyTask(runId);

    expect(ready?.id).toBe(first);
    expect(ready?.id).not.toBe(second);
  });

  test("records a done attempt and unlocks dependent work", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const first = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan",
      prompt: "Plan.",
    });
    const second = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement",
      prompt: "Implement.",
      dependsOn: [first],
    });

    const attemptId = harness.recordAttempt({
      taskId: first,
      input: { prompt: "Plan." },
      output: {
        status: "done",
        summary: "Created task graph",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });

    expect(harness.getAttempt(attemptId)).toMatchObject({
      id: attemptId,
      taskId: first,
      status: "done",
    });
    expect(harness.getTask(first)?.status).toBe("done");
    expect(harness.nextReadyTask(runId)?.id).toBe(second);
  });

  test("links a local entity to an external project", () => {
    const runId = harness.createRun({ goal: "Build loop" });

    const refId = harness.createExternalRef({
      localType: "run",
      localId: runId,
      provider: "linear",
      externalType: "project",
      externalId: "ouroboros-acd5df2ef1da",
      externalUrl: "https://linear.app/pancat/project/ouroboros-acd5df2ef1da/overview",
    });

    expect(harness.listExternalRefs({ localType: "run", localId: runId })).toEqual([
      {
        id: refId,
        localType: "run",
        localId: runId,
        provider: "linear",
        externalType: "project",
        externalId: "ouroboros-acd5df2ef1da",
        externalUrl: "https://linear.app/pancat/project/ouroboros-acd5df2ef1da/overview",
      },
    ]);
  });

  test("leases ready tasks with session refs", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const first = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement A",
      prompt: "Implement A.",
    });
    const second = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement B",
      prompt: "Implement B.",
      dependsOn: [first],
    });

    const leased = harness.leaseReadyTasks({
      runId,
      limit: 2,
      sessionForTask: (task) => `session-${task.id}`,
    });

    expect(leased.map((task) => task.id)).toEqual([first]);
    expect(harness.getTask(first)?.status).toBe("running");
    expect(harness.getTask(first)?.sessionRef).toBe(`session-${first}`);
    expect(harness.getTask(second)?.status).toBe("todo");
  });

  test("retries a blocked task", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement A",
      prompt: "Implement A.",
    });
    harness.recordAttempt({
      taskId,
      input: {},
      output: {
        status: "blocked",
        summary: "Network failed",
        problems: ["timeout"],
      },
    });

    harness.retryTask({ taskId });

    expect(harness.getTask(taskId)?.status).toBe("todo");
    expect(harness.nextReadyTask(runId)?.id).toBe(taskId);
  });
});
