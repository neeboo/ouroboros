import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Harness, withDatabase } from "../packages/harness/src";

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

  test("configures sqlite connections to wait briefly on busy databases", () => {
    const value = withDatabase(harness.dbPath, (db) => db.query("pragma busy_timeout").get() as { timeout: number });

    expect(value.timeout).toBeGreaterThanOrEqual(5000);
  });

  test("seeds and updates prompt templates", () => {
    const seeded = harness.getPromptTemplate("task");
    const verifierSeeded = harness.getPromptTemplate("verifier-task");
    const repairSeeded = harness.getPromptTemplate("repair-task");
    const contextSeeded = harness.getPromptTemplate("context-summary");

    expect(seeded?.contentMd).toContain("# Ouroboros Task");
    expect(seeded?.contentMd).toContain("{{runLessonsJson}}");
    expect(verifierSeeded?.contentMd).toContain("{{sourceTaskId}}");
    expect(repairSeeded?.contentMd).toContain("{{verifierTaskId}}");
    expect(contextSeeded?.contentMd).toContain("{{attemptOutputJson}}");

    harness.setPromptTemplate({
      key: "task",
      contentMd: "# Custom Task\n{{taskGoal}}\n{{runLessonsJson}}",
    });

    expect(harness.getPromptTemplate("task")).toMatchObject({
      key: "task",
      contentMd: "# Custom Task\n{{taskGoal}}\n{{runLessonsJson}}",
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

  test("starts and finishes a resumable running attempt", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan",
      prompt: "Plan.",
    });

    const attemptId = harness.startAttempt({
      taskId,
      input: { sessionName: "planner-session" },
    });
    const reopened = new Harness(harness.dbPath);

    expect(reopened.getAttempt(attemptId)).toMatchObject({
      id: attemptId,
      taskId,
      status: "running",
      input: { sessionName: "planner-session" },
    });
    expect(reopened.getTask(taskId)?.status).toBe("running");
    expect(reopened.listRunningAttempts({ runId })).toEqual([
      expect.objectContaining({ id: attemptId, taskId, status: "running" }),
    ]);

    reopened.finishAttempt({
      attemptId,
      output: {
        status: "done",
        summary: "Planned next task",
        changedFiles: [],
        checks: [{ name: "planner", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });

    expect(reopened.getAttempt(attemptId)).toMatchObject({
      id: attemptId,
      status: "done",
      output: expect.objectContaining({ summary: "Planned next task" }),
    });
    expect(reopened.getTask(taskId)?.status).toBe("done");
    expect(reopened.listLessons({ runId })).toEqual([
      expect.objectContaining({
        attemptId,
        kind: "experience",
        summary: "Planned next task",
      }),
    ]);
  });

  test("updates running attempt input for resumable session ids", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan",
      prompt: "Plan.",
    });
    const attemptId = harness.startAttempt({
      taskId,
      input: {
        sessionName: "planner-session",
      },
    });

    harness.updateAttemptInput({
      attemptId,
      input: {
        sessionName: "planner-session",
        codexSessionId: "codex-session-1",
      },
    });

    expect(harness.getAttempt(attemptId)?.input).toMatchObject({
      sessionName: "planner-session",
      codexSessionId: "codex-session-1",
    });
  });

  test("records attempt events and builds an observable run overview", () => {
    const runId = harness.createRun({ goal: "Build observable loop" });
    const planner = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan graph",
      prompt: "Plan.",
    });
    const worker = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement graph",
      prompt: "Implement.",
      dependsOn: [planner],
    });
    const plannerAttempt = harness.startAttempt({
      taskId: planner,
      input: {
        sessionName: "planner-session",
        codexSessionId: "codex-planner",
      },
    });
    const workerAttempt = harness.startAttempt({
      taskId: worker,
      input: {
        sessionName: "worker-session",
        codexSessionId: "codex-worker",
      },
    });

    harness.recordAttemptEvent({
      attemptId: plannerAttempt,
      stream: "codex-json",
      sequence: 1,
      payload: {
        type: "agent.message.delta",
        delta: "planning",
      },
    });
    harness.recordAttemptEvent({
      attemptId: workerAttempt,
      stream: "stdout",
      sequence: 1,
      text: "implementing\n",
    });

    const overview = harness.getRunOverview({ runId, eventLimit: 5 });

    expect(overview.run?.id).toBe(runId);
    expect(overview.tasks.map((task) => task.id)).toEqual([planner, worker]);
    expect(overview.lessons).toEqual([]);
    expect(overview.sessions).toEqual([
      expect.objectContaining({
        role: "planner",
        taskId: planner,
        attemptId: plannerAttempt,
        sessionName: "planner-session",
        codexSessionId: "codex-planner",
        status: "running",
        latestText: "planning",
        events: [
          expect.objectContaining({
            stream: "codex-json",
            payload: expect.objectContaining({ delta: "planning" }),
          }),
        ],
      }),
      expect.objectContaining({
        role: "worker",
        taskId: worker,
        attemptId: workerAttempt,
        sessionName: "worker-session",
        codexSessionId: "codex-worker",
        status: "running",
        latestText: "implementing",
      }),
    ]);
  });

  test("records experiences and lessons from attempts", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const successTask = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement A",
      prompt: "Implement A.",
    });
    const failedTask = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify A",
      prompt: "Verify A.",
    });
    const successAttempt = harness.recordAttempt({
      taskId: successTask,
      input: {},
      output: {
        status: "done",
        summary: "Using output-last-message avoids noisy stdout parsing.",
        changedFiles: ["packages/runner/src/executors/codex-cli.ts"],
        checks: [{ name: "bun test", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    const failedAttempt = harness.recordAttempt({
      taskId: failedTask,
      input: {},
      output: {
        status: "blocked",
        summary: "Verifier failed",
        checks: [{ name: "bun test", status: "failed" }],
        artifacts: [],
        problems: ["workspace package resolution failed inside worktree"],
      },
    });

    const lessons = harness.listLessons({ runId });
    const overview = harness.getRunOverview({ runId });

    expect(lessons).toEqual([
      expect.objectContaining({
        runId,
        taskId: successTask,
        attemptId: successAttempt,
        kind: "experience",
        summary: "Using output-last-message avoids noisy stdout parsing.",
      }),
      expect.objectContaining({
        runId,
        taskId: failedTask,
        attemptId: failedAttempt,
        kind: "lesson",
        summary: "workspace package resolution failed inside worktree",
      }),
    ]);
    expect(overview.lessons).toEqual(lessons);
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

  test("leases ready tasks with worktree paths", () => {
    const runId = harness.createRun({ goal: "Build loop" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement A",
      prompt: "Implement A.",
    });

    const leased = harness.leaseReadyTasks({
      runId,
      limit: 1,
      sessionForTask: (task) => `session-${task.id}`,
      worktreeForTask: (task) => `/tmp/worktrees/${task.id}`,
    });

    expect(leased[0].id).toBe(taskId);
    expect(leased[0].worktreePath).toBe(`/tmp/worktrees/${taskId}`);
    expect(harness.getTask(taskId)?.worktreePath).toBe(`/tmp/worktrees/${taskId}`);
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
