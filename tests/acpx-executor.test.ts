import { describe, expect, test } from "bun:test";
import { createAcpxCodexExecutor, parseAttemptOutput } from "../packages/runner/src";

describe("acpx executor", () => {
  test("parses structured attempt output from agent text", () => {
    const output = parseAttemptOutput(`
      {"status":"done","summary":"Implemented executor","changedFiles":["src/file.ts"],"checks":[{"name":"test","status":"passed"}],"artifacts":[],"problems":[]}
    `);

    expect(output).toEqual({
      status: "done",
      summary: "Implemented executor",
      changedFiles: ["src/file.ts"],
      checks: [{ name: "test", status: "passed" }],
      artifacts: [],
      problems: [],
      nextTasks: [],
    });
  });

  test("runs acpx codex exec through an injectable command runner", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    let showCalls = 0;
    const executor = createAcpxCodexExecutor({
      cwd: "/repo",
      approval: "approve-all",
      runCommand: async ({ cmd, stdin }) => {
        calls.push({ cmd, stdin });
        if (cmd.includes("show")) {
          showCalls += 1;
          if (showCalls > 1) {
            return {
              exitCode: 0,
              stdout: "",
              stderr: "",
            };
          }
          return {
            exitCode: 1,
            stdout: "",
            stderr: "missing session",
          };
        }
        return {
          exitCode: 0,
          stdout: cmd.includes("-s")
            ? '{"status":"blocked","summary":"Need input","changedFiles":[],"checks":[],"artifacts":[],"problems":["missing token"]}'
            : "",
          stderr: "",
        };
      },
    });

    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_1",
      run: {
        id: "run_1",
        goal: "Goal",
        status: "todo",
        context: {},
      },
      task: {
        id: "task_1",
        runId: "run_1",
        parentId: null,
        status: "todo",
        role: "worker",
        goal: "Task",
        prompt: "Do it",
        dependsOn: [],
        doneWhen: [],
        worktreePath: null,
        sessionRef: null,
        contextVersion: 1,
      },
    });

    expect(calls).toEqual([
      {
        cmd: ["acpx", "--cwd", "/repo", "--approve-all", "--format", "text", "codex", "sessions", "show", "task_1"],
        stdin: "",
      },
      {
        cmd: ["acpx", "--cwd", "/repo", "--approve-all", "--format", "text", "codex", "sessions", "new", "--name", "task_1"],
        stdin: "",
      },
      {
        cmd: ["acpx", "--cwd", "/repo", "--approve-all", "--format", "text", "codex", "sessions", "show", "task_1"],
        stdin: "",
      },
      {
        cmd: ["acpx", "--cwd", "/repo", "--approve-all", "--format", "text", "codex", "-s", "task_1"],
        stdin: "Do the task",
      },
    ]);
    expect(output.status).toBe("blocked");
    expect(output.problems).toEqual(["missing token"]);
  });

  test("reuses an existing acpx session when show succeeds", async () => {
    const calls: string[][] = [];
    const executor = createAcpxCodexExecutor({
      cwd: "/repo",
      runCommand: async ({ cmd }) => {
        calls.push(cmd);
        return {
          exitCode: 0,
          stdout: cmd.includes("-s")
            ? '{"status":"done","summary":"ok","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}'
            : "",
          stderr: "",
        };
      },
    });

    await executor({
      prompt: "Do the task",
      sessionName: "existing",
      run: {
        id: "run_1",
        goal: "Goal",
        status: "todo",
        context: {},
      },
      task: {
        id: "task_1",
        runId: "run_1",
        parentId: null,
        status: "todo",
        role: "worker",
        goal: "Task",
        prompt: "Do it",
        dependsOn: [],
        doneWhen: [],
        worktreePath: null,
        sessionRef: null,
        contextVersion: 1,
      },
    });

    expect(calls).toEqual([
      ["acpx", "--cwd", "/repo", "--approve-reads", "--format", "text", "codex", "sessions", "show", "existing"],
      ["acpx", "--cwd", "/repo", "--approve-reads", "--format", "text", "codex", "-s", "existing"],
    ]);
  });

  test("treats acpx stdout errors as command failures", async () => {
    const calls: string[][] = [];
    const executor = createAcpxCodexExecutor({
      cwd: "/repo",
      runCommand: async ({ cmd }) => {
        calls.push(cmd);
        if (cmd.includes("show")) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "missing session",
          };
        }
        return {
          exitCode: 0,
          stdout: "Error: error loading config: /Users/example/.codex/config.toml: missing field `path`",
          stderr: "",
        };
      },
    });

    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_1",
      run: {
        id: "run_1",
        goal: "Goal",
        status: "todo",
        context: {},
      },
      task: {
        id: "task_1",
        runId: "run_1",
        parentId: null,
        status: "todo",
        role: "worker",
        goal: "Task",
        prompt: "Do it",
        dependsOn: [],
        doneWhen: [],
        worktreePath: null,
        sessionRef: null,
        contextVersion: 1,
      },
    });

    expect(output).toEqual({
      status: "blocked",
      summary: "acpx session creation failed",
      changedFiles: [],
      checks: [{ name: "acpx sessions new", status: "failed" }],
      artifacts: [],
      problems: ["Error: error loading config: /Users/example/.codex/config.toml: missing field `path`"],
    });
    expect(calls).toHaveLength(2);
  });

  test("verifies an acpx session exists after creating it", async () => {
    const calls: string[][] = [];
    const executor = createAcpxCodexExecutor({
      cwd: "/repo",
      runCommand: async ({ cmd }) => {
        calls.push(cmd);
        if (cmd.includes("show")) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "No named session task_1",
          };
        }
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    });

    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_1",
      run: {
        id: "run_1",
        goal: "Goal",
        status: "todo",
        context: {},
      },
      task: {
        id: "task_1",
        runId: "run_1",
        parentId: null,
        status: "todo",
        role: "worker",
        goal: "Task",
        prompt: "Do it",
        dependsOn: [],
        doneWhen: [],
        worktreePath: null,
        sessionRef: null,
        contextVersion: 1,
      },
    });

    expect(output).toEqual({
      status: "blocked",
      summary: "acpx session creation failed",
      changedFiles: [],
      checks: [{ name: "acpx sessions new", status: "failed" }],
      artifacts: [],
      problems: ["No named session task_1"],
    });
    expect(calls).toEqual([
      ["acpx", "--cwd", "/repo", "--approve-reads", "--format", "text", "codex", "sessions", "show", "task_1"],
      ["acpx", "--cwd", "/repo", "--approve-reads", "--format", "text", "codex", "sessions", "new", "--name", "task_1"],
      ["acpx", "--cwd", "/repo", "--approve-reads", "--format", "text", "codex", "sessions", "show", "task_1"],
    ]);
  });
});
