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

describe("acpx worktree evidence preservation", () => {
  test("collects changed files via worktree probe when an envelope is missing", async () => {
    let probeCalls = 0;
    const runCommand: RunCommand = async ({ cmd }) => ({
      exitCode: cmd.includes("-s") ? 0 : 0,
      stdout: cmd.includes("-s") ? "[client] partial work" : "",
      stderr: "",
    });
    const executor = createAcpxCodexExecutor({
      cwd: "/repo",
      runCommand,
      worktreeEvidence: async () => {
        probeCalls += 1;
        return {
          changedFiles: ["src/partial.ts", "tests/partial.test.ts"],
          summary: "2 files in worktree",
        };
      },
    });
    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_partial",
      run: runFixture,
      route: routeFixture,
      task: { ...taskFixture, worktreePath: "/repo/worktrees/task_partial" },
      attemptId: "attempt_partial",
    });
    expect(output.status).toBe("blocked");
    expect(probeCalls).toBeGreaterThan(0);
    expect(output.changedFiles).toEqual(expect.arrayContaining(["src/partial.ts", "tests/partial.test.ts"]));
    const terminal = output.artifacts?.find(
      (artifact) => (artifact as Record<string, unknown>).kind === "acpx_terminal_evidence",
    ) as Record<string, unknown> | undefined;
    expect(terminal?.worktreeSnapshot).toBe("2 files in worktree");
    expect(terminal?.sessionName).toBe("task_partial");
    expect(terminal?.cwd).toBe("/repo");
  });

  test("merges worktree changed files with envelope changed files on recovery failure", async () => {
    const runCommand: RunCommand = async ({ cmd, stdin }) => {
      if (cmd.includes("sessions show")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (cmd.includes("-s")) {
        if (stdin.startsWith("Output only the existing")) {
          return {
            exitCode: 0,
            stdout: "[client] still no envelope",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "[client] partial", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const executor = createAcpxAgentExecutor({
      agent: "codex",
      cwd: "/repo",
      runCommand,
      worktreeEvidence: async () => ({
        changedFiles: ["src/worktree.ts"],
        summary: "1 worktree file",
      }),
    });
    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_merge",
      run: runFixture,
      route: routeFixture,
      task: { ...taskFixture, worktreePath: "/repo/worktrees/task_merge" },
      attemptId: "attempt_merge",
    });
    expect(output.status).toBe("blocked");
    expect(output.changedFiles).toEqual(expect.arrayContaining(["src/worktree.ts"]));
    const terminal = output.artifacts?.find(
      (artifact) => (artifact as Record<string, unknown>).kind === "acpx_terminal_evidence",
    ) as Record<string, unknown> | undefined;
    expect(terminal?.terminalReason).toBe("recovery_failed");
    expect(terminal?.recoveryAttempted).toBe(true);
    expect(terminal?.worktreeSnapshot).toBe("1 worktree file");
  });

  test("falls back to cwd snapshot when no worktree probe is provided", async () => {
    const runCommand: RunCommand = async ({ cmd }) => ({
      exitCode: cmd.includes("-s") ? 1 : 0,
      stdout: cmd.includes("-s") ? "agent failed" : "",
      stderr: cmd.includes("-s") ? "runtime error" : "",
    });
    const executor = createAcpxCodexExecutor({
      cwd: "/repo",
      runCommand,
    });
    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_no_probe",
      run: runFixture,
      route: routeFixture,
      task: taskFixture,
      attemptId: "attempt_no_probe",
    });
    expect(output.status).toBe("blocked");
    const terminal = output.artifacts?.find(
      (artifact) => (artifact as Record<string, unknown>).kind === "acpx_terminal_evidence",
    ) as Record<string, unknown> | undefined;
    expect(terminal?.worktreeSnapshot).toBe("cwd:/repo");
    expect(terminal?.lastStdout).toBe("agent failed");
    expect(terminal?.lastStderr).toBe("runtime error");
  });
});
