import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Harness } from "../packages/harness/src";
import { buildTaskPrompt, runNextReadyTask } from "../packages/runner/src";

describe("runner", () => {
  let dir: string;
  let harness: Harness;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-runner-"));
    harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("builds an execution prompt from run and task state", () => {
    const runId = harness.createRun({
      goal: "Use Ouroboros to iterate on Ouroboros",
      context: { repo: "/Users/ghostcorn/dev/ouroboros" },
    });
    const taskId = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan the next task",
      prompt: "Read current state and propose one small task.",
      doneWhen: ["a next task exists", "the task is small"],
    });

    const prompt = buildTaskPrompt({
      run: harness.getRun(runId)!,
      task: harness.getTask(taskId)!,
      dependencyAttempts: [],
    });

    expect(prompt).toContain("Use Ouroboros to iterate on Ouroboros");
    expect(prompt).toContain("Role: planner");
    expect(prompt).toContain("Plan the next task");
    expect(prompt).toContain("Read current state and propose one small task.");
    expect(prompt).toContain('"status": "done"');
    expect(prompt).toContain("a next task exists");
  });

  test("runs the next ready task with an executor and records the attempt", async () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement runner",
      prompt: "Implement the smallest runner.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async ({ prompt, task }) => ({
        status: "done",
        summary: `Executed ${task.id}`,
        artifacts: [{ kind: "prompt", chars: prompt.length }],
        checks: [{ name: "fake executor", status: "passed" }],
        problems: [],
      }),
    });

    expect(result?.taskId).toBe(taskId);
    expect(result?.attemptId).toBeString();
    expect(harness.getTask(taskId)?.status).toBe("done");
    expect(harness.getAttempt(result!.attemptId)?.output.summary).toBe(`Executed ${taskId}`);
  });
});
