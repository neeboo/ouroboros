import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach } from "bun:test";
import { Harness, type AttemptOutput } from "../packages/harness/src";
import {
  createAcpxAgentExecutor,
  createAcpxCodexExecutor,
  createInMemoryAttemptReplayCache,
  runNextReadyTask,
  runReadyTasks,
  type AttemptReplayCache,
} from "../packages/runner/src";

const runFixture = {
  id: "run_1",
  projectId: "project_1",
  projectRoot: "/repo",
  goal: "Goal",
  status: "todo" as const,
  context: {},
};

const routeFixture = {
  role: "worker",
  backend: {
    id: "acpx-codex",
    kind: "acpx",
    source: "cli-executor",
    agent: "codex",
  },
  model: null,
  executionMode: "generic",
} as const;

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

function recordingRunCommand(
  store: Array<{ cmd: string[]; stdin: string }>,
  responses: (cmd: string[]) => { exitCode: number; stdout: string; stderr: string },
) {
  return async ({ cmd, stdin }: { cmd: string[]; stdin: string }) => {
    store.push({ cmd, stdin });
    return responses(cmd);
  };
}

function doneOutput(summary: string): string {
  return `{"status":"done","summary":${JSON.stringify(summary)},"changedFiles":[],"checks":[],"artifacts":[],"problems":[]}`;
}

describe("acpx recovery replay idempotency", () => {
  test("terminal replay returns the cached output without re-issuing the initial command for codex", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const replay: AttemptReplayCache = createInMemoryAttemptReplayCache();
    const executor = createAcpxCodexExecutor({
      cwd: "/repo",
      replayCache: replay,
      runCommand: recordingRunCommand(calls, (cmd) =>
        cmd.includes("-s")
          ? { exitCode: 0, stdout: doneOutput("codex ok"), stderr: "" }
          : { exitCode: 0, stdout: "", stderr: "" },
      ),
    });

    const first = await executor({
      prompt: "Do the task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_alpha",
    });

    const firstCallCount = calls.length;
    expect(first.status).toBe("done");
    expect(first.summary).toBe("codex ok");

    const second = await executor({
      prompt: "Do the task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_alpha",
    });

    expect(second).toEqual(first);
    expect(calls.length).toBe(firstCallCount);
    expect(replay.getTerminalResult("attempt_alpha")).toEqual(first);
  });

  test("terminal replay returns the cached output for claude one-shot exec", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const replay: AttemptReplayCache = createInMemoryAttemptReplayCache();
    const executor = createAcpxAgentExecutor({
      agent: "claude",
      cwd: "/repo",
      approval: "approve-all",
      replayCache: replay,
      runCommand: recordingRunCommand(calls, () => ({
        exitCode: 0,
        stdout: doneOutput("claude ok"),
        stderr: "",
      })),
    });

    const first = await executor({
      prompt: "Do the task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_claude",
    });
    const firstCallCount = calls.length;
    expect(first.summary).toBe("claude ok");

    const second = await executor({
      prompt: "Do the task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_claude",
    });

    expect(second).toEqual(first);
    expect(calls.length).toBe(firstCallCount);
  });

  test("initial request reservation skips the initial command on duplicate calls", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const replay: AttemptReplayCache = createInMemoryAttemptReplayCache();
    expect(replay.reserveInitialRequest("attempt_beta")).toBe(true);

    const executor = createAcpxCodexExecutor({
      cwd: "/repo",
      replayCache: replay,
      runCommand: recordingRunCommand(calls, () => ({
        exitCode: 0,
        stdout: doneOutput("should not run"),
        stderr: "",
      })),
    });

    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_beta",
    });

    expect(output.status).toBe("blocked");
    expect(output.summary).toContain("skipped duplicate initial request");
    expect(output.problems?.[0]).toContain("attempt attempt_beta");
    expect(calls.length).toBe(0);
    expect(replay.getTerminalResult("attempt_beta")).toBeUndefined();
  });

  test("recovery request reservation skips the reconnect path on duplicate recovery", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const replay: AttemptReplayCache = createInMemoryAttemptReplayCache();
    expect(replay.reserveRecoveryRequest("attempt_gamma")).toBe(true);

    let promptCalls = 0;
    const executor = createAcpxCodexExecutor({
      cwd: "/repo",
      replayCache: replay,
      runCommand: recordingRunCommand(calls, (cmd) => {
        if (cmd.includes("-s")) {
          promptCalls += 1;
          return {
            exitCode: 1,
            stdout: "session task_1 · agent needs reconnect",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    });

    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_gamma",
    });

    expect(output.status).toBe("blocked");
    expect(output.summary).toContain("skipped duplicate recovery request");
    const terminalArtifacts = (output.artifacts ?? []).filter(
      (artifact) => (artifact as { kind?: string }).kind === "acpx_terminal_evidence",
    );
    expect(terminalArtifacts.length).toBeGreaterThan(0);
    expect(
      (terminalArtifacts[0] as { terminalReason?: string }).terminalReason,
    ).toBe("recovery_already_attempted");
    expect(calls.some((entry) => entry.cmd.includes("close"))).toBe(false);
    expect(calls.some((entry) => entry.cmd.includes("new"))).toBe(false);
    expect(promptCalls).toBe(1);
    expect(replay.getTerminalResult("attempt_gamma")).toEqual(output);
  });

  test("different attempt ids run independently under the same cache", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const replay: AttemptReplayCache = createInMemoryAttemptReplayCache();
    const executor = createAcpxAgentExecutor({
      agent: "claude",
      cwd: "/repo",
      approval: "approve-all",
      replayCache: replay,
      runCommand: recordingRunCommand(calls, (cmd) => ({
        exitCode: 0,
        stdout: cmd.includes("exec") ? doneOutput("claude ok") : "",
        stderr: "",
      })),
    });

    await executor({
      prompt: "Do the task",
      sessionName: "task_a",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_delta",
    });
    const firstCallCount = calls.length;
    await executor({
      prompt: "Do the task",
      sessionName: "task_b",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_epsilon",
    });

    expect(calls.length).toBe(firstCallCount * 2);
    expect(replay.getTerminalResult("attempt_delta")).toBeDefined();
    expect(replay.getTerminalResult("attempt_epsilon")).toBeDefined();
  });

  test("absent attempt id always runs the underlying command", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const replay: AttemptReplayCache = createInMemoryAttemptReplayCache();
    const executor = createAcpxAgentExecutor({
      agent: "claude",
      cwd: "/repo",
      approval: "approve-all",
      replayCache: replay,
      runCommand: recordingRunCommand(calls, () => ({
        exitCode: 0,
        stdout: doneOutput("claude ok"),
        stderr: "",
      })),
    });

    const first = await executor({
      prompt: "Do the task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
    });
    const second = await executor({
      prompt: "Do the task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
    });

    expect(first.summary).toBe("claude ok");
    expect(second).toEqual(first);
    expect(calls.length).toBe(2);
  });

  test("shared replay cache enforces idempotency across separate executor instances", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const replay: AttemptReplayCache = createInMemoryAttemptReplayCache();
    const runCommand = recordingRunCommand(calls, (cmd) => ({
      exitCode: 0,
      stdout: cmd.includes("-s") ? doneOutput("codex ok") : "",
      stderr: "",
    }));

    const firstExecutor = createAcpxCodexExecutor({ cwd: "/repo", replayCache: replay, runCommand });
    const secondExecutor = createAcpxCodexExecutor({ cwd: "/repo", replayCache: replay, runCommand });

    const first = await firstExecutor({
      prompt: "Do the task",
      sessionName: "task_shared",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_shared",
    });
    const callsAfterFirst = calls.length;
    expect(first.status).toBe("done");

    const second = await secondExecutor({
      prompt: "Do the task",
      sessionName: "task_shared",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_shared",
    });

    expect(second).toEqual(first);
    expect(calls.length).toBe(callsAfterFirst);
  });

  test("same-session recovery runs at most once per attempt id", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const replay: AttemptReplayCache = createInMemoryAttemptReplayCache();
    let promptCalls = 0;
    let recoveryCalls = 0;
    const executor = createAcpxAgentExecutor({
      agent: "claude",
      cwd: "/repo",
      approval: "approve-all",
      replayCache: replay,
      runCommand: recordingRunCommand(calls, () => {
        promptCalls += 1;
        if (promptCalls === 1) {
          return {
            exitCode: 0,
            stdout: "[client] thinking...",
            stderr: "",
          };
        }
        recoveryCalls += 1;
        return {
          exitCode: 0,
          stdout: doneOutput("recovered envelope"),
          stderr: "",
        };
      }),
    });

    const first = await executor({
      prompt: "Do the task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_recovery",
    });

    expect(first.status).toBe("done");
    expect(first.summary).toBe("recovered envelope");
    expect(recoveryCalls).toBe(1);
    expect(replay.getTerminalResult("attempt_recovery")).toEqual(first);

    const recoveryCallsAfterFirst = recoveryCalls;
    const second = await executor({
      prompt: "Do the task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_recovery",
    });

    expect(second).toEqual(first);
    expect(recoveryCalls).toBe(recoveryCallsAfterFirst);
  });

  test("recovery reservation blocks the same-session recovery path on duplicate call", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const replay: AttemptReplayCache = createInMemoryAttemptReplayCache();
    expect(replay.reserveRecoveryRequest("attempt_recovery_blocked")).toBe(true);

    let promptCalls = 0;
    const executor = createAcpxAgentExecutor({
      agent: "claude",
      cwd: "/repo",
      approval: "approve-all",
      replayCache: replay,
      runCommand: recordingRunCommand(calls, () => {
        promptCalls += 1;
        return {
          exitCode: 0,
          stdout: "[client] no envelope first time",
          stderr: "",
        };
      }),
    });

    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_recovery_blocked",
    });

    expect(output.status).toBe("blocked");
    expect(promptCalls).toBe(1);
    expect(replay.getTerminalResult("attempt_recovery_blocked")).toEqual(output);
  });
});

describe("acpx recovery runner-level replay idempotency", () => {
  let dir: string;
  let harness: Harness;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-acpx-recovery-"));
    harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("runNextReadyTask creates exactly one attempt per call so replay cannot duplicate tasks or budget charges", async () => {
    const runId = harness.createRun({ goal: "Replay contract" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Replay once",
      prompt: "Run once.",
    });

    const firstResult = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done" as const,
        summary: "First terminal",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      }),
    });

    expect(firstResult?.attemptId).toBeString();
    const firstAttemptId = firstResult!.attemptId;

    const dbAfterFirst = new Database(harness.dbPath);
    const attemptsAfterFirst = dbAfterFirst
      .query("select id, status from attempts where task_id = $taskId order by rowid")
      .all({ $taskId: taskId }) as Array<{ id: string; status: string }>;
    const tasksAfterFirst = dbAfterFirst
      .query("select count(*) as n from tasks where id = $taskId")
      .get({ $taskId: taskId }) as { n: number };
    dbAfterFirst.close();

    expect(attemptsAfterFirst).toEqual([{ id: firstAttemptId, status: "done" }]);
    expect(tasksAfterFirst.n).toBe(1);
    expect(harness.getTask(taskId)?.status).toBe("done");

    const secondResult = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done" as const,
        summary: "Second terminal",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      }),
    });

    expect(secondResult).toBeNull();
  });

  test("stop hook exceptions are converted to a single blocked attempt with no running survivor", async () => {
    const runId = harness.createRun({ goal: "Stop hook cleanup" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Survive a stop hook exception",
      prompt: "Run, then throw in the stop hook.",
    });

    const result = await runNextReadyTask({
      harness,
      runId,
      executor: async () => ({
        status: "done" as const,
        summary: "Executor completed",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      }),
      stopHooks: [
        async () => {
          throw new Error("synthetic stop hook failure");
        },
      ],
    });

    expect(result?.attemptId).toBeString();
    const attemptId = result!.attemptId;

    const db = new Database(harness.dbPath);
    const rows = db
      .query("select id, status, output_json from attempts where task_id = $taskId")
      .all({ $taskId: taskId }) as Array<{ id: string; status: string; output_json: string }>;
    const runningRows = db
      .query("select id from attempts where task_id = $taskId and status = 'running'")
      .all({ $taskId: taskId }) as Array<{ id: string }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(attemptId);
    expect(rows[0].status).toBe("blocked");
    expect(runningRows).toHaveLength(0);

    const stored = JSON.parse(rows[0].output_json) as AttemptOutput;
    expect(stored.status).toBe("blocked");
    expect(stored.summary).toContain("stop hook failed");
    expect(stored.problems?.some((problem) => problem.includes("synthetic stop hook failure"))).toBe(true);
    expect(harness.getTask(taskId)?.status).toBe("blocked");
  });

  test("runReadyTasks converts stop hook exceptions into a single blocked attempt with no running survivor", async () => {
    const runId = harness.createRun({ goal: "Stop hook cleanup for leased path" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Survive a stop hook exception in the leased path",
      prompt: "Run, then throw in the stop hook.",
    });

    const result = await runReadyTasks({
      harness,
      runId,
      limit: 1,
      executorFactory: () => async () => ({
        status: "done" as const,
        summary: "Factory executor completed",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      }),
      stopHooks: [
        async () => {
          throw new Error("synthetic leased stop hook failure");
        },
      ],
    });

    expect(result).toHaveLength(1);
    const attemptId = result[0].attemptId;

    const db = new Database(harness.dbPath);
    const rows = db
      .query("select id, status, output_json from attempts where task_id = $taskId")
      .all({ $taskId: taskId }) as Array<{ id: string; status: string; output_json: string }>;
    const runningRows = db
      .query("select id from attempts where task_id = $taskId and status = 'running'")
      .all({ $taskId: taskId }) as Array<{ id: string }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(attemptId);
    expect(rows[0].status).toBe("blocked");
    expect(runningRows).toHaveLength(0);

    const stored = JSON.parse(rows[0].output_json) as AttemptOutput;
    expect(stored.status).toBe("blocked");
    expect(stored.summary).toContain("stop hook failed");
    expect(stored.problems?.some((problem) => problem.includes("synthetic leased stop hook failure"))).toBe(true);
    expect(harness.getTask(taskId)?.status).toBe("blocked");
  });
});
