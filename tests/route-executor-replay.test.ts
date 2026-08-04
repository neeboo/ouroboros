import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Harness, type AttemptOutput } from "../packages/harness/src";
import {
  createDurableAttemptReplayCache,
  createRouteExecutor,
  type AttemptReplayCache,
  type ResolvedExecutionRoute,
  type RunCommand,
} from "../packages/runner/src";

const runFixture = {
  id: "run_1",
  projectId: "project_1",
  projectRoot: "/repo",
  goal: "Goal",
  status: "todo" as const,
  context: {},
};

const taskFixture = {
  id: "task_1",
  runId: "run_1",
  parentId: null,
  cycleId: "task_1",
  status: "todo" as const,
  role: "worker",
  goal: "Task",
  prompt: "Do it",
  dependsOn: [],
  doneWhen: [],
  worktreePath: null,
  sessionRef: null,
  contextVersion: 1,
};

const claudeRoute: ResolvedExecutionRoute = {
  role: "worker",
  backend: {
    id: "claude-code",
    kind: "acpx",
    source: "cli-executor",
    agent: "claude",
    approval: "approve-all",
  },
  model: null,
  executionMode: "generic",
};

const codexRoute: ResolvedExecutionRoute = {
  role: "worker",
  backend: {
    id: "acpx-codex",
    kind: "acpx",
    source: "cli-executor",
    agent: "codex",
  },
  model: null,
  executionMode: "generic",
};

function doneOutput(summary: string): string {
  return `{"status":"done","summary":${JSON.stringify(summary)},"changedFiles":[],"checks":[],"artifacts":[],"problems":[]}`;
}

function recordingRunCommand(
  store: Array<{ cmd: string[]; stdin: string }>,
  responses: (cmd: string[]) => { exitCode: number; stdout: string; stderr: string },
): RunCommand {
  return async ({ cmd, stdin }) => {
    store.push({ cmd, stdin });
    return responses(cmd);
  };
}

function harnessRecorder(harness: Harness, attemptId: string) {
  let sequence = Date.now() * 1000;
  const next = () => {
    sequence += 1;
    return sequence;
  };
  return {
    stdout: (chunk: string) => {
      harness.recordAttemptEvent({ attemptId, stream: "stdout", sequence: next(), text: chunk });
    },
    stderr: (chunk: string) => {
      harness.recordAttemptEvent({ attemptId, stream: "stderr", sequence: next(), text: chunk });
    },
    event: (event: Record<string, unknown>) => {
      harness.recordAttemptEvent({ attemptId, stream: "system", sequence: next(), payload: event });
    },
  };
}

interface ProductionFactoryHandle {
  calls: Array<{ cmd: string[]; stdin: string }>;
  createExecutor: () => ReturnType<typeof createRouteExecutor>;
  replayCache: AttemptReplayCache;
}

function productionFactory(input: {
  harness: Harness;
  route: ResolvedExecutionRoute;
  responses: (cmd: string[]) => { exitCode: number; stdout: string; stderr: string };
}): ProductionFactoryHandle {
  const calls: Array<{ cmd: string[]; stdin: string }> = [];
  const runCommand = recordingRunCommand(calls, input.responses);
  const replayCache = createDurableAttemptReplayCache({ harness: input.harness });
  const createExecutor = () =>
    createRouteExecutor({
      cwd: "/repo",
      route: input.route,
      approval: "approve-all",
      runCommand,
      replayCache,
    });
  return { calls, createExecutor, replayCache };
}

describe("production route executor durable replay", () => {
  let dir: string;
  let harness: Harness;
  let runId: string;
  let taskId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-route-replay-"));
    harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    runId = harness.createRun({ goal: "Durable replay" });
    taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Replay the executor",
      prompt: "Run the durable replay test.",
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("two executor instances from the same production factory replay the terminal result without re-issuing commands", async () => {
    const factory = productionFactory({
      harness,
      route: claudeRoute,
      responses: () => ({
        exitCode: 0,
        stdout: doneOutput("claude ok"),
        stderr: "",
      }),
    });

    const attemptId = harness.startAttempt({
      taskId,
      input: { sessionName: "task_replay_1", route: claudeRoute },
    });
    const recorder = harnessRecorder(harness, attemptId);

    const firstExecutor = factory.createExecutor();
    const first = await firstExecutor({
      prompt: "Do the task",
      sessionName: "task_replay_1",
      run: runFixture,
      task: taskFixture,
      route: claudeRoute,
      attemptId,
      recorder,
    });
    expect(first.status).toBe("done");
    expect(first.summary).toBe("claude ok");
    harness.finishAttempt({ attemptId, output: first });
    const callsAfterFirst = factory.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const secondExecutor = factory.createExecutor();
    const second = await secondExecutor({
      prompt: "Do the task",
      sessionName: "task_replay_1",
      run: runFixture,
      task: taskFixture,
      route: claudeRoute,
      attemptId,
      recorder: harnessRecorder(harness, attemptId),
    });

    expect(second).toEqual(first);
    expect(factory.calls.length).toBe(callsAfterFirst);
  });

  test("fresh durable cache rebuilt from the same harness after process restart still treats the attempt as terminal", async () => {
    const factory = productionFactory({
      harness,
      route: claudeRoute,
      responses: () => ({
        exitCode: 0,
        stdout: doneOutput("restart ok"),
        stderr: "",
      }),
    });

    const attemptId = harness.startAttempt({
      taskId,
      input: { sessionName: "task_replay_2", route: claudeRoute },
    });
    const recorder = harnessRecorder(harness, attemptId);

    const firstExecutor = factory.createExecutor();
    const first = await firstExecutor({
      prompt: "Do the task",
      sessionName: "task_replay_2",
      run: runFixture,
      task: taskFixture,
      route: claudeRoute,
      attemptId,
      recorder,
    });
    harness.finishAttempt({ attemptId, output: first });
    const callsBeforeRestart = factory.calls.length;
    expect(callsBeforeRestart).toBeGreaterThan(0);

    const rebuiltFactory = productionFactory({
      harness,
      route: claudeRoute,
      responses: () => ({
        exitCode: 0,
        stdout: doneOutput("should not run"),
        stderr: "",
      }),
    });
    const rebuiltExecutor = rebuiltFactory.createExecutor();
    const rebuilt = await rebuiltExecutor({
      prompt: "Do the task",
      sessionName: "task_replay_2",
      run: runFixture,
      task: taskFixture,
      route: claudeRoute,
      attemptId,
      recorder: harnessRecorder(harness, attemptId),
    });

    expect(rebuilt).toEqual(first);
    expect(rebuiltFactory.calls.length).toBe(0);
  });

  test("durable cache sees the persisted started event even before the attempt finishes and skips duplicate initial requests", async () => {
    const factory = productionFactory({
      harness,
      route: codexRoute,
      responses: (cmd) => {
        if (cmd.includes("sessions")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: doneOutput("codex ok"), stderr: "" };
      },
    });

    const attemptId = harness.startAttempt({
      taskId,
      input: { sessionName: "task_replay_3", route: codexRoute },
    });
    const recorder = harnessRecorder(harness, attemptId);

    harness.recordAttemptEvent({
      attemptId,
      stream: "system",
      sequence: 1,
      payload: {
        type: "acpx.attempt.started",
        agent: "codex",
        sessionName: "task_replay_3",
        approval: "approve-all",
        format: "text",
        cwd: "/repo",
        attemptId,
        oneShot: false,
      },
    });

    const executor = factory.createExecutor();
    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_replay_3",
      run: runFixture,
      task: taskFixture,
      route: codexRoute,
      attemptId,
      recorder,
    });

    expect(output.status).toBe("blocked");
    expect(output.summary).toContain("skipped duplicate initial request");
    expect(factory.calls.length).toBe(0);
  });

  test("recovery request remains durable across executor rebuild even when recovery event was persisted", async () => {
    const factory = productionFactory({
      harness,
      route: codexRoute,
      responses: (cmd) => {
        if (cmd.includes("sessions")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return {
          exitCode: 1,
          stdout: "session task_replay_4 · agent needs reconnect",
          stderr: "",
        };
      },
    });

    const attemptId = harness.startAttempt({
      taskId,
      input: { sessionName: "task_replay_4", route: codexRoute },
    });
    const recorder = harnessRecorder(harness, attemptId);

    harness.recordAttemptEvent({
      attemptId,
      stream: "system",
      sequence: 1,
      payload: {
        type: "acpx.attempt.started",
        agent: "codex",
        sessionName: "task_replay_4",
        approval: "approve-all",
        format: "text",
        cwd: "/repo",
        attemptId,
        oneShot: false,
      },
    });
    harness.recordAttemptEvent({
      attemptId,
      stream: "system",
      sequence: 2,
      payload: {
        type: "acpx.attempt.recovery.start",
        agent: "codex",
        sessionName: "task_replay_4",
        attemptId,
      },
    });

    const executor = factory.createExecutor();
    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_replay_4",
      run: runFixture,
      task: taskFixture,
      route: codexRoute,
      attemptId,
      recorder,
    });

    expect(output.status).toBe("blocked");
    const summaries = [output.summary, ...(output.problems ?? [])].join("\n");
    expect(
      summaries.includes("skipped duplicate initial request") ||
        summaries.includes("skipped duplicate recovery request"),
    ).toBe(true);
    expect(factory.calls.length).toBe(0);
    expect(factory.calls.some((entry) => entry.cmd.includes("close"))).toBe(false);
    expect(factory.calls.some((entry) => entry.cmd.includes("exec") || entry.cmd.includes("-s"))).toBe(false);
  });

  test("legitimate retry with a new attempt id is not blocked by the durable cache", async () => {
    const factory = productionFactory({
      harness,
      route: claudeRoute,
      responses: () => ({
        exitCode: 0,
        stdout: doneOutput("legitimate retry ok"),
        stderr: "",
      }),
    });

    const firstAttemptId = harness.startAttempt({
      taskId,
      input: { sessionName: "task_replay_5", route: claudeRoute },
    });
    const firstExecutor = factory.createExecutor();
    const first = await firstExecutor({
      prompt: "Do the task",
      sessionName: "task_replay_5",
      run: runFixture,
      task: taskFixture,
      route: claudeRoute,
      attemptId: firstAttemptId,
      recorder: harnessRecorder(harness, firstAttemptId),
    });
    harness.finishAttempt({ attemptId: firstAttemptId, output: first });
    const callsAfterFirst = factory.calls.length;

    const secondAttemptId = harness.startAttempt({
      taskId,
      input: { sessionName: "task_replay_5", route: claudeRoute },
    });
    const secondExecutor = factory.createExecutor();
    const second = await secondExecutor({
      prompt: "Do the task again",
      sessionName: "task_replay_5",
      run: runFixture,
      task: taskFixture,
      route: claudeRoute,
      attemptId: secondAttemptId,
      recorder: harnessRecorder(harness, secondAttemptId),
    });
    harness.finishAttempt({ attemptId: secondAttemptId, output: second });

    expect(second.status).toBe("done");
    expect(second.summary).toBe("legitimate retry ok");
    expect(factory.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(secondAttemptId).not.toBe(firstAttemptId);

    const db = new Database(harness.dbPath);
    const attempts = db
      .query("select id, status from attempts where task_id = $taskId order by rowid")
      .all({ $taskId: taskId }) as Array<{ id: string; status: string }>;
    db.close();
    expect(attempts).toEqual([
      { id: firstAttemptId, status: "done" },
      { id: secondAttemptId, status: "done" },
    ]);
  });

  test("runReadyTasks does not duplicate attempts or budget charges across executor rebuilds", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const runCommand = recordingRunCommand(calls, (cmd) => {
      if (cmd.includes("sessions")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: doneOutput("runner ok"), stderr: "" };
    });
    const replayCache = createDurableAttemptReplayCache({ harness });

    const localRunId = harness.createRun({ goal: "Durable run-loop" });
    const localTaskId = harness.createTask({
      runId: localRunId,
      role: "worker",
      goal: "Survive executor recreation",
      prompt: "Run once across executor recreation.",
    });

    const run = harness.getRun(localRunId)!;
    const task = harness.getTask(localTaskId)!;
    const route = codexRoute;

    const executorFactory = () =>
      createRouteExecutor({
        cwd: "/repo",
        route,
        approval: "approve-all",
        runCommand,
        replayCache,
      });

    const recorderFor = (attemptId: string) => harnessRecorder(harness, attemptId);
    const { runReadyTasks } = await import("../packages/runner/src/runner");
    const result = await runReadyTasks({
      harness,
      runId: localRunId,
      limit: 1,
      executorFactory: () => {
        const inner = executorFactory();
        return async ({ prompt, sessionName, route: routeArg, attemptId }) => {
          if (!attemptId) {
            throw new Error("attemptId must be provided by runReadyTasks");
          }
          return inner({
            prompt,
            sessionName,
            run,
            task,
            route: routeArg,
            attemptId,
            recorder: recorderFor(attemptId),
          });
        };
      },
    });

    expect(result).toHaveLength(1);
    const attemptId = result[0].attemptId;

    const db = new Database(harness.dbPath);
    const attempts = db
      .query("select id, status from attempts where task_id = $taskId")
      .all({ $taskId: localTaskId }) as Array<{ id: string; status: string }>;
    const finishedAttempt = harness.getAttempt(attemptId);
    db.close();

    expect(attempts).toEqual([{ id: attemptId, status: "done" }]);
    expect(finishedAttempt?.status).toBe("done");
    expect(finishedAttempt?.output).toBeDefined();
    const finishedOutput = finishedAttempt!.output;
    const callsAfterRunReady = calls.length;

    const replay = await executorFactory()({
      prompt: "Do the task",
      sessionName: "task_should_be_noop",
      run,
      task,
      route,
      attemptId,
      recorder: recorderFor(attemptId),
    });
    expect(replay).toEqual(finishedOutput);
    expect(calls.length).toBe(callsAfterRunReady);
  });

  test("terminal replay returns the cached output when the same production factory is rebuilt", async () => {
    const factory = productionFactory({
      harness,
      route: codexRoute,
      responses: (cmd) => {
        if (cmd.includes("sessions")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: doneOutput("terminal cached"), stderr: "" };
      },
    });

    const attemptId = harness.startAttempt({
      taskId,
      input: { sessionName: "task_replay_6", route: codexRoute },
    });

    const firstExecutor = factory.createExecutor();
    const first = await firstExecutor({
      prompt: "Do the task",
      sessionName: "task_replay_6",
      run: runFixture,
      task: taskFixture,
      route: codexRoute,
      attemptId,
      recorder: harnessRecorder(harness, attemptId),
    });
    harness.finishAttempt({ attemptId, output: first });
    const callsAfterFirst = factory.calls.length;

    const rebuiltExecutor = factory.createExecutor();
    const rebuilt = await rebuiltExecutor({
      prompt: "Do the task",
      sessionName: "task_replay_6",
      run: runFixture,
      task: taskFixture,
      route: codexRoute,
      attemptId,
      recorder: harnessRecorder(harness, attemptId),
    });

    expect(rebuilt).toEqual(first);
    expect(factory.calls.length).toBe(callsAfterFirst);

    const stored = factory.replayCache.getTerminalResult(attemptId) as AttemptOutput | undefined;
    expect(stored).toEqual(first);
  });
});
