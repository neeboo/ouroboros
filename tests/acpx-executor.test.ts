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
        cycleId: "task_1",
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
        cycleId: "task_1",
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

  test("uses command hard and idle timeouts without passing an acpx wall timeout", async () => {
    const calls: Array<{ cmd: string[]; timeoutMs?: number; idleTimeoutMs?: number }> = [];
    const executor = createAcpxCodexExecutor({
      cwd: "/repo",
      timeoutMs: 900000,
      idleTimeoutMs: 300000,
      runCommand: async ({ cmd, timeoutMs, idleTimeoutMs }) => {
        calls.push({ cmd, timeoutMs, idleTimeoutMs });
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
        cycleId: "task_1",
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

    expect(calls[0].cmd).toEqual([
      "acpx",
      "--cwd",
      "/repo",
      "--approve-reads",
      "--format",
      "text",
      "codex",
      "sessions",
      "show",
      "task_1",
    ]);
    expect(calls.every((call) => call.timeoutMs === 900000)).toBe(true);
    expect(calls.every((call) => call.idleTimeoutMs === 300000)).toBe(true);
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
        cycleId: "task_1",
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
      problems: [
        "exit code: 0\n\nstdout:\nError: error loading config: /Users/example/.codex/config.toml: missing field `path`",
      ],
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
        return cmd.includes("--verbose")
          ? {
              exitCode: 0,
              stdout: "Error: verbose diagnostic",
              stderr: "",
            }
          : {
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
        cycleId: "task_1",
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
      problems: ["sessions show stderr:\nNo named session task_1\n\nverbose sessions new stdout:\nError: verbose diagnostic"],
    });
    expect(calls).toEqual([
      ["acpx", "--cwd", "/repo", "--approve-reads", "--format", "text", "codex", "sessions", "show", "task_1"],
      ["acpx", "--cwd", "/repo", "--approve-reads", "--format", "text", "codex", "sessions", "new", "--name", "task_1"],
      ["acpx", "--cwd", "/repo", "--approve-reads", "--format", "text", "codex", "sessions", "show", "task_1"],
      ["acpx", "--verbose", "--cwd", "/repo", "--approve-reads", "--format", "text", "codex", "sessions", "new", "--name", "task_1"],
    ]);
  });

  test("reports both acpx creation and verification output when session creation cannot be verified", async () => {
    const executor = createAcpxCodexExecutor({
      cwd: "/repo",
      runCommand: async ({ cmd }) => {
        if (cmd.includes("show")) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "No named session task_1",
          };
        }
        return cmd.includes("--verbose")
          ? {
              exitCode: 0,
              stdout: "",
              stderr: "",
            }
          : {
          exitCode: 0,
          stdout: "created stdout was empty in normal mode",
          stderr: "created stderr was empty",
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
        cycleId: "task_1",
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

    expect(output.problems).toEqual([
      "sessions new stdout:\ncreated stdout was empty in normal mode\n\nsessions new stderr:\ncreated stderr was empty\n\nsessions show stderr:\nNo named session task_1",
    ]);
  });

  test("runs verbose acpx diagnostics when session creation is silent but verification fails", async () => {
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
        if (cmd.includes("--verbose")) {
          return {
            exitCode: 0,
            stdout: "[acpx] spawning agent\nError: error loading config: missing field `path`",
            stderr: "",
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
        cycleId: "task_1",
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

    const problem = output.problems?.[0] ?? "";
    expect(problem).toContain("sessions show stderr");
    expect(problem).toContain("verbose sessions new stdout");
    expect(problem).toContain("missing field `path`");
    expect(calls).toContainEqual([
      "acpx",
      "--verbose",
      "--cwd",
      "/repo",
      "--approve-reads",
      "--format",
      "text",
      "codex",
      "sessions",
      "new",
      "--name",
      "task_1",
    ]);
  });

  test("recreates an acpx session once when the agent needs reconnect", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    let promptCalls = 0;
    const executor = createAcpxCodexExecutor({
      cwd: "/repo",
      runCommand: async ({ cmd, stdin }) => {
        calls.push({ cmd, stdin });
        if (cmd.includes("-s")) {
          promptCalls += 1;
          if (promptCalls === 1) {
            return {
              exitCode: 1,
              stdout: "session task_1 · agent needs reconnect",
              stderr: "",
            };
          }
          return {
            exitCode: 0,
            stdout: '{"status":"done","summary":"recovered","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
            stderr: "",
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
        cycleId: "task_1",
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

    expect(output.status).toBe("done");
    expect(output.summary).toBe("recovered");
    expect(calls.map((call) => call.cmd)).toEqual([
      ["acpx", "--cwd", "/repo", "--approve-reads", "--format", "text", "codex", "sessions", "show", "task_1"],
      ["acpx", "--cwd", "/repo", "--approve-reads", "--format", "text", "codex", "-s", "task_1"],
      ["acpx", "--cwd", "/repo", "--approve-reads", "--format", "text", "codex", "sessions", "close", "task_1"],
      ["acpx", "--cwd", "/repo", "--approve-reads", "--format", "text", "codex", "sessions", "new", "--name", "task_1"],
      ["acpx", "--cwd", "/repo", "--approve-reads", "--format", "text", "codex", "sessions", "show", "task_1"],
      ["acpx", "--cwd", "/repo", "--approve-reads", "--format", "text", "codex", "-s", "task_1"],
    ]);
  });

  test("returns a blocked output when acpx succeeds without structured JSON", async () => {
    const executor = createAcpxCodexExecutor({
      cwd: "/repo",
      runCommand: async ({ cmd }) => ({
        exitCode: 0,
        stdout: cmd.includes("-s") ? "[client] initialize (running)" : "",
        stderr: "",
      }),
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
        cycleId: "task_1",
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
      summary: "acpx codex executor produced invalid output",
      changedFiles: [],
      checks: [{ name: "acpx output parse", status: "failed" }],
      artifacts: [],
      problems: ["agent output did not contain a JSON object\n\nOutput:\n[client] initialize (running)"],
    });
  });

  test("includes exit code stdout and stderr when acpx prompt fails", async () => {
    const executor = createAcpxCodexExecutor({
      cwd: "/repo",
      runCommand: async ({ cmd }) => ({
        exitCode: cmd.includes("-s") ? 1 : 0,
        stdout: cmd.includes("-s") ? "agent connected" : "",
        stderr: cmd.includes("-s") ? "runtime internal error" : "",
      }),
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
        cycleId: "task_1",
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

    expect(output.problems).toEqual([
      "exit code: 1\n\nstdout:\nagent connected\n\nstderr:\nruntime internal error",
    ]);
  });
});
