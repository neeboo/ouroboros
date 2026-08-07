import { describe, expect, test } from "bun:test";
import { createAcpxAgentExecutor, createAcpxCodexExecutor } from "../packages/runner/src";
import type { RunCommand } from "../packages/runner/src/executors/types";

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

function recorderProbe() {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    recorder: {
      stdout: () => undefined,
      stderr: () => undefined,
      event: (event: Record<string, unknown>) => {
        events.push(event);
      },
    },
  };
}

describe("acpx deadline classification", () => {
  test.each([
    ["idle", "command idle timed out after 30000ms"],
    ["hard", "command timed out after 90000ms"],
  ] as const)("cooperatively cancels the named session after a %s timeout", async (_kind, timeoutError) => {
    const calls: Array<Parameters<RunCommand>[0]> = [];
    const runCommand: RunCommand = async (input) => {
      calls.push(input);
      if (input.cmd.includes("prompt")) {
        return { exitCode: 124, stdout: "", stderr: timeoutError };
      }
      if (input.cmd.includes("cancel")) {
        return { exitCode: 0, stdout: "cancel requested\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const { events, recorder } = recorderProbe();
    const executor = createAcpxAgentExecutor({
      agent: "claude",
      cwd: "/repo",
      timeoutMs: 90000,
      idleTimeoutMs: 30000,
      runCommand,
    });

    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_timeout",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: `attempt_${_kind}`,
      recorder,
    });

    const cancelCall = calls.find((call) => call.cmd.includes("cancel"));
    expect(cancelCall).toMatchObject({
      cmd: [
        "acpx",
        "--cwd",
        "/repo",
        "--approve-reads",
        "--format",
        "text",
        "claude",
        "cancel",
        "-s",
        "task_timeout",
      ],
      stdin: "",
      timeoutMs: 10000,
      idleTimeoutMs: 10000,
    });
    expect(events.some((event) => event.type === "acpx.attempt.cancel.started")).toBe(true);
    expect(events.some((event) => event.type === "acpx.attempt.cancel.terminal" && event.succeeded === true)).toBe(true);
    const resetCall = calls.find((call) => call.cmd.includes("close"));
    expect(resetCall?.cmd).toEqual([
      "acpx",
      "--cwd",
      "/repo",
      "--approve-reads",
      "--format",
      "text",
      "claude",
      "sessions",
      "close",
      "task_timeout",
    ]);
    expect(events.some((event) => event.type === "acpx.attempt.reset.terminal" && event.succeeded === true)).toBe(true);
    const terminal = output.artifacts?.find(
      (artifact) => (artifact as Record<string, unknown>).kind === "acpx_terminal_evidence",
    ) as Record<string, unknown> | undefined;
    expect(terminal?.sessionCancelAttempted).toBe(true);
    expect(terminal?.sessionCancelSucceeded).toBe(true);
    expect(terminal?.sessionResetAttempted).toBe(true);
    expect(terminal?.sessionResetSucceeded).toBe(true);
  });

  test("does not reconnect or replay when a timed-out prompt also reports needs reconnect", async () => {
    const calls: Array<Parameters<RunCommand>[0]> = [];
    const runCommand: RunCommand = async (input) => {
      calls.push(input);
      if (input.cmd.includes("prompt")) {
        return {
          exitCode: 124,
          stdout: "session task_timeout_reconnect · agent needs reconnect",
          stderr: "command idle timed out after 30000ms",
        };
      }
      if (input.cmd.includes("cancel")) {
        return { exitCode: 0, stdout: "cancel requested\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const executor = createAcpxAgentExecutor({
      agent: "claude",
      cwd: "/repo",
      timeoutMs: 90000,
      idleTimeoutMs: 30000,
      runCommand,
    });

    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_timeout_reconnect",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_timeout_reconnect",
    });

    expect(output.status).toBe("blocked");
    expect(
      calls.filter((call) => call.cmd.includes("prompt")),
    ).toHaveLength(1);
    expect(calls.filter((call) => call.cmd.includes("close"))).toHaveLength(1);
    expect(calls.some((call) => call.cmd.includes("new"))).toBe(false);
    expect(calls.some((call) => call.cmd.includes("cancel"))).toBe(true);
    const terminal = output.artifacts?.find(
      (artifact) => (artifact as Record<string, unknown>).kind === "acpx_terminal_evidence",
    ) as Record<string, unknown> | undefined;
    expect(terminal?.terminalReason).toBe("idle_timeout");
  });

  test("records a failed cooperative cancellation without hiding the timeout", async () => {
    const runCommand: RunCommand = async ({ cmd }) => {
      if (cmd.includes("prompt")) {
        return { exitCode: 124, stdout: "", stderr: "command timed out after 90000ms" };
      }
      if (cmd.includes("cancel")) {
        return { exitCode: 2, stdout: "", stderr: "unknown option" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const { events, recorder } = recorderProbe();
    const executor = createAcpxAgentExecutor({
      agent: "claude",
      cwd: "/repo",
      timeoutMs: 90000,
      idleTimeoutMs: 30000,
      runCommand,
    });

    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_cancel_failed",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_cancel_failed",
      recorder,
    });

    expect(output.status).toBe("blocked");
    expect(output.summary).toContain("hard ceiling");
    expect(output.problems?.join("\n")).toContain("session cancel failed with exit code 2");
    expect(
      events.some((event) => event.type === "acpx.attempt.cancel.terminal" && event.succeeded === false),
    ).toBe(true);
    const terminal = output.artifacts?.find(
      (artifact) => (artifact as Record<string, unknown>).kind === "acpx_terminal_evidence",
    ) as Record<string, unknown> | undefined;
    expect(terminal?.sessionCancelAttempted).toBe(true);
    expect(terminal?.sessionCancelSucceeded).toBe(false);
    expect(terminal?.sessionCancelExitCode).toBe(2);
    expect(terminal?.sessionCancelFailureReason).toBe("command_exit_2");
    expect(terminal?.sessionResetSucceeded).toBe(true);
  });

  test("cancels a timed-out raw agentCommand session through the same backend", async () => {
    const calls: Array<Parameters<RunCommand>[0]> = [];
    const runCommand: RunCommand = async (input) => {
      calls.push(input);
      if (input.cmd.includes("prompt")) {
        return { exitCode: 124, stdout: "", stderr: "command idle timed out after 30000ms" };
      }
      if (input.cmd.includes("cancel")) {
        return { exitCode: 0, stdout: "cancel requested\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const executor = createAcpxAgentExecutor({
      agentCommand: "/opt/claude-agent-acp",
      cwd: "/repo",
      timeoutMs: 90000,
      idleTimeoutMs: 30000,
      runCommand,
    });

    await executor({
      prompt: "Do the task",
      sessionName: "task_raw_timeout",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_raw_timeout",
    });

    expect(calls.find((call) => call.cmd.includes("cancel"))?.cmd).toEqual([
      "acpx",
      "--cwd",
      "/repo",
      "--approve-reads",
      "--format",
      "text",
      "--agent",
      "/opt/claude-agent-acp",
      "cancel",
      "-s",
      "task_raw_timeout",
    ]);
    expect(calls.find((call) => call.cmd.includes("close"))?.cmd).toEqual([
      "acpx",
      "--cwd",
      "/repo",
      "--approve-reads",
      "--format",
      "text",
      "--agent",
      "/opt/claude-agent-acp",
      "sessions",
      "close",
      "task_raw_timeout",
    ]);
  });

  test("resets the contaminated session when no active prompt remains to cancel", async () => {
    const runCommand: RunCommand = async ({ cmd }) => {
      if (cmd.includes("prompt")) {
        return { exitCode: 124, stdout: "", stderr: "command idle timed out after 30000ms" };
      }
      if (cmd.includes("cancel")) {
        return { exitCode: 0, stdout: "nothing to cancel\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "session closed\n", stderr: "" };
    };
    const executor = createAcpxAgentExecutor({
      agent: "claude",
      cwd: "/repo",
      timeoutMs: 90000,
      idleTimeoutMs: 30000,
      runCommand,
    });

    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_queued_timeout",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_queued_timeout",
    });

    const terminal = output.artifacts?.find(
      (artifact) => (artifact as Record<string, unknown>).kind === "acpx_terminal_evidence",
    ) as Record<string, unknown> | undefined;
    expect(terminal?.sessionCancelSucceeded).toBe(false);
    expect(terminal?.sessionCancelFailureReason).toBeNull();
    expect(terminal?.sessionResetSucceeded).toBe(true);
    expect(output.problems?.join("\n")).not.toContain("session cancel failed");
  });

  test("classifies exit 124 with idle-timeout stderr as idle_timeout", async () => {
    const runCommand: RunCommand = async ({ cmd }) => ({
      exitCode: cmd.includes("-s") ? 124 : 0,
      stdout: "",
      stderr: cmd.includes("-s") ? "command idle timed out after 30000ms" : "",
    });
    const executor = createAcpxCodexExecutor({
      cwd: "/repo",
      idleTimeoutMs: 30000,
      runCommand,
    });
    const { events, recorder } = recorderProbe();
    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_idle",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_idle",
      recorder,
    });
    expect(output.status).toBe("blocked");
    expect(output.summary).toContain("silent for 30000ms");
    expect(events.some((event) => event.type === "acpx.attempt.idle_timeout")).toBe(true);
    expect(events.some((event) => event.type === "acpx.attempt.hard_timeout")).toBe(false);
    const terminal = output.artifacts?.find(
      (artifact) => (artifact as Record<string, unknown>).kind === "acpx_terminal_evidence",
    ) as Record<string, unknown> | undefined;
    expect(terminal?.terminalReason).toBe("idle_timeout");
    expect(terminal?.timeoutReason).toBe("idle_timeout");
  });

  test("classifies exit 124 with hard-timeout stderr as hard_timeout", async () => {
    const runCommand: RunCommand = async ({ cmd }) => ({
      exitCode: cmd.includes("-s") ? 124 : 0,
      stdout: "",
      stderr: cmd.includes("-s") ? "command timed out after 90000ms" : "",
    });
    const executor = createAcpxCodexExecutor({
      cwd: "/repo",
      timeoutMs: 90000,
      idleTimeoutMs: 30000,
      runCommand,
    });
    const { events, recorder } = recorderProbe();
    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_hard",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_hard",
      recorder,
    });
    expect(output.status).toBe("blocked");
    expect(output.summary).toContain("hard ceiling");
    expect(events.some((event) => event.type === "acpx.attempt.hard_timeout")).toBe(true);
    expect(events.some((event) => event.type === "acpx.attempt.idle_timeout")).toBe(false);
    const terminal = output.artifacts?.find(
      (artifact) => (artifact as Record<string, unknown>).kind === "acpx_terminal_evidence",
    ) as Record<string, unknown> | undefined;
    expect(terminal?.terminalReason).toBe("hard_timeout");
    expect(terminal?.timeoutReason).toBe("hard_timeout");
  });

  test("preserves worktree evidence when a hard timeout fires", async () => {
    const runCommand: RunCommand = async ({ cmd }) => ({
      exitCode: cmd.includes("-s") ? 124 : 0,
      stdout: "agent connected",
      stderr: cmd.includes("-s") ? "command timed out after 60000ms" : "",
    });
    const executor = createAcpxCodexExecutor({
      cwd: "/repo",
      timeoutMs: 60000,
      runCommand,
      worktreeEvidence: async () => ({
        changedFiles: ["src/late.ts"],
        summary: "1 file in worktree",
      }),
    });
    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_late",
      run: runFixture,
      route: routeFixture,
      task: { ...taskFixture, worktreePath: "/repo/work" },
      attemptId: "attempt_late",
    });
    expect(output.status).toBe("blocked");
    expect(output.changedFiles).toContain("src/late.ts");
    const terminal = output.artifacts?.find(
      (artifact) => (artifact as Record<string, unknown>).kind === "acpx_terminal_evidence",
    ) as Record<string, unknown> | undefined;
    expect(terminal?.terminalReason).toBe("hard_timeout");
    expect(terminal?.worktreeSnapshot).toBe("1 file in worktree");
  });

  test("claude persistent recovery prompt is the structured envelope prompt", async () => {
    let recoveryStdin = "";
    let calls = 0;
    const runCommand: RunCommand = async ({ cmd, stdin }) => {
      if (cmd.includes("prompt")) {
        calls += 1;
        if (calls === 1) {
          return { exitCode: 0, stdout: "[client] no envelope", stderr: "" };
        }
        recoveryStdin = stdin;
        return {
          exitCode: 0,
          stdout: '{"status":"done","summary":"recovered","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const executor = createAcpxAgentExecutor({
      agent: "claude",
      cwd: "/repo",
      approval: "approve-all",
      runCommand,
    });
    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_claude_recovery",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_claude_recovery",
    });
    expect(output.status).toBe("done");
    expect(output.summary).toBe("recovered");
    expect(recoveryStdin).toContain("Output only the existing attempt-result JSON envelope");
  });
});
