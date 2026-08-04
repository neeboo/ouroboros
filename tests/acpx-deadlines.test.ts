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

  test("claude one-shot recovery prompt is the structured envelope prompt", async () => {
    let recoveryStdin = "";
    let calls = 0;
    const runCommand: RunCommand = async ({ cmd, stdin }) => {
      if (cmd.includes("exec")) {
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
