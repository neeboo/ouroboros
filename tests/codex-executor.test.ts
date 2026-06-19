import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodexCliExecutor, createCodexResumableClient } from "../packages/runner/src";

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
    id: "codex-cli",
    kind: "codex-cli",
    source: "cli-executor",
  },
  model: null,
  executionMode: "generic",
} as const;

describe("codex cli executor", () => {
  test("runs codex exec through an injectable command runner", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const executor = createCodexCliExecutor({
      cwd: "/repo",
      sandbox: "read-only",
      codexBin: "/custom/codex",
      runCommand: async ({ cmd, stdin }) => {
        calls.push({ cmd, stdin });
        const outputPath = cmd[cmd.indexOf("--output-last-message") + 1];
        await writeFile(
          outputPath,
          '{"status":"done","summary":"planned","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
        );
        return {
          exitCode: 0,
          stdout: "OpenAI Codex logs before final response",
          stderr: "",
        };
      },
    });

    const output = await executor({
      prompt: "Plan next task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: {
        id: "task_1",
        runId: "run_1",
        parentId: null,
        cycleId: "task_1",
        status: "todo",
        role: "planner",
        goal: "Task",
        prompt: "Plan",
        dependsOn: [],
        doneWhen: [],
        worktreePath: null,
        sessionRef: null,
        contextVersion: 1,
      },
    });

    expect(calls).toEqual([
      {
        cmd: [
          "/custom/codex",
          "exec",
          "--skip-git-repo-check",
          "--ignore-user-config",
          "-c",
          'approval_policy="never"',
          "--output-last-message",
          expect.any(String),
          "-C",
          "/repo",
          "--sandbox",
          "read-only",
          "-",
        ],
        stdin: "Plan next task",
      },
    ]);
    expect(output.status).toBe("done");
    expect(output.summary).toBe("planned");
  });

  test("falls back to stdout when no output file is present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-codex-"));
    try {
      const executor = createCodexCliExecutor({
        cwd: "/repo",
        outputDir: dir,
        runCommand: async () => ({
          exitCode: 0,
          stdout: '{"status":"done","summary":"stdout","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
          stderr: "",
        }),
      });

      const output = await executor({
        prompt: "Plan next task",
        sessionName: "task_1",
        run: runFixture,
      route: routeFixture,
        task: {
          id: "task_1",
          runId: "run_1",
          parentId: null,
        cycleId: "task_1",
        status: "todo",
          role: "planner",
          goal: "Task",
          prompt: "Plan",
          dependsOn: [],
          doneWhen: [],
          worktreePath: null,
          sessionRef: null,
          contextVersion: 1,
        },
      });

      expect(output.summary).toBe("stdout");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("passes an explicit model to codex exec", async () => {
    const calls: Array<{ cmd: string[] }> = [];
    const executor = createCodexCliExecutor({
      cwd: "/repo",
      model: "gpt-5-codex",
      runCommand: async ({ cmd }) => {
        calls.push({ cmd });
        return {
          exitCode: 0,
          stdout: '{"status":"done","summary":"ok","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
          stderr: "",
        };
      },
    });

    await executor({
      prompt: "Plan next task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: {
        id: "task_1",
        runId: "run_1",
        parentId: null,
        cycleId: "task_1",
        status: "todo",
        role: "planner",
        goal: "Task",
        prompt: "Plan",
        dependsOn: [],
        doneWhen: [],
        worktreePath: null,
        sessionRef: null,
        contextVersion: 1,
      },
    });

    expect(calls[0].cmd).toContain("-m");
    expect(calls[0].cmd).toContain("gpt-5-codex");
  });

  test("passes hard and idle timeouts to the command runner", async () => {
    const calls: Array<{ timeoutMs?: number; idleTimeoutMs?: number }> = [];
    const executor = createCodexCliExecutor({
      cwd: "/repo",
      timeoutMs: 900000,
      idleTimeoutMs: 300000,
      runCommand: async ({ timeoutMs, idleTimeoutMs }) => {
        calls.push({ timeoutMs, idleTimeoutMs });
        return {
          exitCode: 0,
          stdout: '{"status":"done","summary":"ok","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
          stderr: "",
        };
      },
    });

    await executor({
      prompt: "Plan next task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: {
        id: "task_1",
        runId: "run_1",
        parentId: null,
        cycleId: "task_1",
        status: "todo",
        role: "planner",
        goal: "Task",
        prompt: "Plan",
        dependsOn: [],
        doneWhen: [],
        worktreePath: null,
        sessionRef: null,
        contextVersion: 1,
      },
    });

    expect(calls).toEqual([{ timeoutMs: 900000, idleTimeoutMs: 300000 }]);
  });

  test("returns a blocked output when codex succeeds without structured JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-codex-"));
    try {
      const executor = createCodexCliExecutor({
        cwd: "/repo",
        outputDir: dir,
        runCommand: async () => ({
          exitCode: 0,
          stdout: "Codex completed without final JSON",
          stderr: "",
        }),
      });

      const output = await executor({
        prompt: "Plan next task",
        sessionName: "task_1",
        run: runFixture,
      route: routeFixture,
        task: {
          id: "task_1",
          runId: "run_1",
          parentId: null,
        cycleId: "task_1",
        status: "todo",
          role: "planner",
          goal: "Task",
          prompt: "Plan",
          dependsOn: [],
          doneWhen: [],
          worktreePath: null,
          sessionRef: null,
          contextVersion: 1,
        },
      });

      expect(output).toEqual({
        status: "blocked",
        summary: "codex cli executor produced invalid output",
        changedFiles: [],
        checks: [{ name: "codex output parse", status: "failed" }],
        artifacts: [],
        problems: ["agent output did not contain a JSON object\n\nOutput:\nCodex completed without final JSON"],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("includes exit code stdout and stderr when codex exec fails", async () => {
    const executor = createCodexCliExecutor({
      cwd: "/repo",
      runCommand: async () => ({
        exitCode: 1,
        stdout: "codex stdout",
        stderr: "codex stderr",
      }),
    });

    const output = await executor({
      prompt: "Plan next task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: {
        id: "task_1",
        runId: "run_1",
        parentId: null,
        cycleId: "task_1",
        status: "todo",
        role: "planner",
        goal: "Task",
        prompt: "Plan",
        dependsOn: [],
        doneWhen: [],
        worktreePath: null,
        sessionRef: null,
        contextVersion: 1,
      },
    });

    expect(output.problems).toEqual(["exit code: 1\n\nstdout:\ncodex stdout\n\nstderr:\ncodex stderr"]);
  });

  test("resumable client returns running when a json event stream times out after session creation", async () => {
    const calls: Array<{ cmd: string[]; stdin: string; timeoutMs?: number; idleTimeoutMs?: number }> = [];
    const client = createCodexResumableClient({
      cwd: "/repo",
      codexBin: "/custom/codex",
      model: "gpt-5-mini",
      timeoutMs: 900000,
      idleTimeoutMs: 300000,
      runCommand: async ({ cmd, stdin, timeoutMs, idleTimeoutMs }) => {
        calls.push({ cmd, stdin, timeoutMs, idleTimeoutMs });
        return {
          exitCode: 124,
          stdout: [
            JSON.stringify({ type: "session.started", session_id: "session_123" }),
            JSON.stringify({ type: "agent.message.delta", delta: "thinking" }),
          ].join("\n"),
          stderr: "command idle timed out after 300000ms",
        };
      },
    });

    const result = await client.start({
      prompt: "Plan next task",
      sessionName: "task_1",
    });

    expect(result).toEqual({
      status: "running",
      sessionId: "session_123",
      outputPath: expect.any(String),
      stdout: expect.stringContaining("session.started"),
      stderr: "command idle timed out after 300000ms",
      events: [
        { type: "session.started", session_id: "session_123" },
        { type: "agent.message.delta", delta: "thinking" },
      ],
    });
    expect(calls[0]).toMatchObject({
      cmd: [
        "/custom/codex",
        "exec",
        "-m",
        "gpt-5-mini",
        "--json",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "-c",
        'approval_policy="never"',
        "--output-last-message",
        expect.any(String),
        "-C",
        "/repo",
        "--sandbox",
        "read-only",
        "-",
      ],
      stdin: "Plan next task",
      timeoutMs: 900000,
      idleTimeoutMs: 300000,
    });
  });

  test("resumable client streams stdout and parsed json events", async () => {
    const observedChunks: string[] = [];
    const observedEvents: Array<Record<string, unknown>> = [];
    const client = createCodexResumableClient({
      cwd: "/repo",
      codexBin: "/custom/codex",
      runCommand: async ({ onStdout }) => {
        onStdout?.(`${JSON.stringify({ type: "session.started", session_id: "session_123" })}\n`);
        onStdout?.(`${JSON.stringify({ type: "agent.message.delta", delta: "thinking" })}\n`);
        return {
          exitCode: 124,
          stdout: [
            JSON.stringify({ type: "session.started", session_id: "session_123" }),
            JSON.stringify({ type: "agent.message.delta", delta: "thinking" }),
          ].join("\n"),
          stderr: "command idle timed out after 300000ms",
        };
      },
    });

    await client.start({
      prompt: "Plan next task",
      sessionName: "task_1",
      onStdout: (chunk) => observedChunks.push(chunk),
      onEvent: (event) => observedEvents.push(event),
    });

    expect(observedChunks.join("")).toContain("session.started");
    expect(observedEvents).toEqual([
      { type: "session.started", session_id: "session_123" },
      { type: "agent.message.delta", delta: "thinking" },
    ]);
  });

  test("resumable client resumes a session and parses the final attempt output", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const client = createCodexResumableClient({
      cwd: "/repo",
      codexBin: "/custom/codex",
      model: "gpt-5-codex",
      runCommand: async ({ cmd, stdin }) => {
        calls.push({ cmd, stdin });
        return {
          exitCode: 0,
          stdout: [
            JSON.stringify({ type: "session.started", session_id: "session_123" }),
            JSON.stringify({
              type: "agent.message",
              message:
                '{"status":"done","summary":"planned","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
            }),
          ].join("\n"),
          stderr: "",
        };
      },
    });

    const result = await client.resume({
      sessionId: "session_123",
      prompt: "continue",
      sessionName: "task_1",
    });

    expect(result.status).toBe("done");
    if (result.status === "running") {
      throw new Error("expected finished result");
    }
    expect(result.output).toMatchObject({
      status: "done",
      summary: "planned",
    });
    expect(calls[0].cmd.slice(0, 8)).toEqual([
      "/custom/codex",
      "exec",
      "resume",
      "session_123",
      "-m",
      "gpt-5-codex",
      "--json",
      "--skip-git-repo-check",
    ]);
    expect(calls[0].stdin).toBe("continue");
  });
});
