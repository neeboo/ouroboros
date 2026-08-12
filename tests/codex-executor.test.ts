import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodexCliExecutor, createCodexResumableClient } from "../packages/runner/src";
import { runLocalCommand } from "../packages/runner/src/executors/command";
import {
  prepareCodexHostExecution,
  protectedCodexRuntimeRoot,
} from "../packages/runner/src/executors/codex-host-execution";

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
  test("derives a stable protected runtime identity for a synthetic executor cwd", () => {
    expect(protectedCodexRuntimeRoot("/repo")).toBe(protectedCodexRuntimeRoot("/repo"));
  });

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

  test("direct codex cli executor blocks ASCII prompts above the character budget without invoking runCommand", async () => {
    let commandCalls = 0;
    const executor = createCodexCliExecutor({
      cwd: "/repo",
      runCommand: async () => {
        commandCalls += 1;
        throw new Error("runCommand should not be called");
      },
    });

    const output = await executor({
      prompt: `ASCII_PROMPT_${"x".repeat(900_001)}`,
      sessionName: "oversized-ascii",
      run: runFixture,
      route: routeFixture,
      task: {
        id: "task_ascii",
        runId: "run_1",
        parentId: null,
        cycleId: "task_ascii",
        status: "todo",
        role: "worker",
        goal: "Reject oversized ASCII",
        prompt: "Reject oversized ASCII",
        dependsOn: [],
        doneWhen: [],
        worktreePath: null,
        sessionRef: null,
        contextVersion: 1,
      },
    });

    expect(commandCalls).toBe(0);
    expect(output.status).toBe("blocked");
    expect(output.summary).toContain("input_too_large");
    expect(output.artifacts).toContainEqual(expect.objectContaining({
      kind: "prompt_input_budget_exceeded",
      characterLimit: 900_000,
      utf8ByteLimit: 900_000,
    }));
  });

  test("direct codex cli executor blocks high-byte Unicode prompts above the UTF-8 budget without invoking runCommand", async () => {
    let commandCalls = 0;
    const executor = createCodexCliExecutor({
      cwd: "/repo",
      runCommand: async () => {
        commandCalls += 1;
        throw new Error("runCommand should not be called");
      },
    });

    const output = await executor({
      prompt: `UNICODE_PROMPT_${"界".repeat(400_000)}`,
      sessionName: "oversized-unicode",
      run: runFixture,
      route: routeFixture,
      task: {
        id: "task_unicode",
        runId: "run_1",
        parentId: null,
        cycleId: "task_unicode",
        status: "todo",
        role: "worker",
        goal: "Reject oversized Unicode",
        prompt: "Reject oversized Unicode",
        dependsOn: [],
        doneWhen: [],
        worktreePath: null,
        sessionRef: null,
        contextVersion: 1,
      },
    });

    expect(commandCalls).toBe(0);
    expect(output.status).toBe("blocked");
    expect(output.summary).toContain("input_too_large");
    expect(output.artifacts).toContainEqual(expect.objectContaining({
      kind: "prompt_input_budget_exceeded",
      characters: 400_015,
      utf8Bytes: 1_200_015,
      characterLimit: 900_000,
      utf8ByteLimit: 900_000,
    }));
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
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
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
    expect(calls[0].cmd).toContain("gpt-5.6-luna");
    expect(calls[0].cmd).toContain('model_reasoning_effort="high"');
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

  test("bounds and redacts failed command diagnostics with head tail digest and original size", async () => {
    const middleSentinel = `UNBOUNDED_COMMAND_MIDDLE_${"m".repeat(80_000)}`;
    const executor = createCodexCliExecutor({
      cwd: "/repo",
      runCommand: async () => ({
        exitCode: 1,
        stdout: `STDOUT_HEAD token=ghp_secretvalue\n${"a".repeat(10_000)}${middleSentinel}${"z".repeat(10_000)}\nSTDOUT_TAIL`,
        stderr: `STDERR_HEAD password=super-secret\n${"a".repeat(10_000)}${middleSentinel}${"z".repeat(10_000)}\nSTDERR_TAIL`,
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

    const problem = output.problems?.[0] ?? "";
    expect(problem.length).toBeLessThan(20_000);
    expect(problem).toContain("STDOUT_HEAD");
    expect(problem).toContain("STDOUT_TAIL");
    expect(problem).toContain("STDERR_HEAD");
    expect(problem).toContain("STDERR_TAIL");
    expect(problem).toContain("sha256=");
    expect(problem).toContain("originalChars=");
    expect(problem).toContain("[REDACTED]");
    expect(problem).not.toContain("UNBOUNDED_COMMAND_MIDDLE");
    expect(problem).not.toContain("ghp_secretvalue");
    expect(problem).not.toContain("super-secret");
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
            JSON.stringify({ type: "thread.started", thread_id: "session_123" }),
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
      stdout: expect.stringContaining("thread.started"),
      stderr: "command idle timed out after 300000ms",
      events: [
        { type: "thread.started", thread_id: "session_123" },
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

  test("resumable client extracts nested session ids from codex json events", async () => {
    const client = createCodexResumableClient({
      cwd: "/repo",
      codexBin: "/custom/codex",
      runCommand: async () => ({
        exitCode: 124,
        stdout: [
          JSON.stringify({ type: "session.created", payload: { session: { id: "ignored", sessionId: "nested_session" } } }),
          JSON.stringify({ type: "agent.message.delta", delta: "thinking" }),
        ].join("\n"),
        stderr: "command idle timed out after 300000ms",
      }),
    });

    const result = await client.start({
      prompt: "Plan next task",
      sessionName: "task_1",
    });

    expect(result).toMatchObject({
      status: "running",
      sessionId: "nested_session",
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

  test("resumable client enforces a browser process deny policy", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orbs-codex-browser-policy-"));
    const calls: Array<{ cmd: string[]; env?: Record<string, string | undefined> }> = [];
    const client = createCodexResumableClient({
      cwd,
      codexBin: "/custom/codex",
      browserProcessPolicy: "deny",
      runCommand: async ({ cmd, env }) => {
        calls.push({ cmd, env });
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            type: "agent.message",
            message: '{"status":"done","summary":"reviewed","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
          }),
          stderr: "",
        };
      },
    });

    await client.start({ prompt: "Review without a browser", sessionName: "goal-review" });

    expect(calls[0]?.cmd.slice(0, 2)).toEqual(["/custom/codex", "exec"]);
    expect(calls[0]?.cmd).not.toContain("danger-full-access");
    if (process.platform === "darwin") {
      expect(calls[0]?.cmd).not.toContain("--sandbox");
      expect(calls[0]?.cmd).not.toContain("--ignore-user-config");
      expect(calls[0]?.cmd).toContain("--strict-config");
      expect(calls[0]?.env?.CODEX_HOME).toContain("ouroboros-codex-runtime");
    } else {
      expect(calls[0]?.cmd).toContain("--sandbox");
      expect(calls[0]?.cmd).toContain("read-only");
    }
    expect(calls[0]?.env?.ORBS_BROWSER_PROCESS_POLICY).toBe("deny");
    await rm(cwd, { recursive: true, force: true });
  });

  test.skipIf(process.platform !== "darwin")("protected Codex profile hides runtime credentials and limits writes to the worktree", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".orbs-protected-codex-"));
    const outside = `${dir}-outside.txt`;
    try {
      const execution = await prepareCodexHostExecution({
        cwd: dir,
        sandbox: "workspace-write",
        browserProcessPolicy: "deny",
        injectedRunCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      });
      expect(execution).not.toBeNull();
      const codexHome = execution!.env.CODEX_HOME;
      await writeFile(join(codexHome, "private-proof.txt"), "secret-token", "utf8");
      const codexBin = "/Applications/ChatGPT.app/Contents/Resources/codex";

      const inside = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", dir, "/bin/sh", "-c", "printf ok > inside.txt"],
        stdin: "",
        env: execution!.env,
      });
      expect(inside.exitCode).toBe(0);
      expect(await Bun.file(join(dir, "inside.txt")).text()).toBe("ok");

      const credentials = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", dir, "/bin/cat", join(codexHome, "private-proof.txt")],
        stdin: "",
        env: execution!.env,
      });
      expect(credentials.exitCode).not.toBe(0);
      expect(credentials.stdout).not.toContain("secret-token");

      const credentialsWrite = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", dir, "/bin/sh", "-c", `printf replaced > ${JSON.stringify(join(codexHome, "private-proof.txt"))}`],
        stdin: "",
        env: execution!.env,
      });
      expect(credentialsWrite.exitCode).not.toBe(0);
      expect(await Bun.file(join(codexHome, "private-proof.txt")).text()).toBe("secret-token");

      const sourceCredentials = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", dir, "/bin/sh", "-c", `/bin/cat ${JSON.stringify(join(process.env.HOME ?? "", ".codex", "auth.json"))} >/dev/null`],
        stdin: "",
        env: execution!.env,
      });
      expect(sourceCredentials.exitCode).not.toBe(0);

      const outsideWrite = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", dir, "/bin/sh", "-c", `printf denied > ${JSON.stringify(outside)}`],
        stdin: "",
        env: execution!.env,
      });
      expect(outsideWrite.exitCode).not.toBe(0);
      expect(await Bun.file(outside).exists()).toBe(false);

      const readOnly = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-read-only", "-C", dir, "/bin/sh", "-c", "printf denied > read-only.txt"],
        stdin: "",
        env: execution!.env,
      });
      expect(readOnly.exitCode).not.toBe(0);
      expect(await Bun.file(join(dir, "read-only.txt")).exists()).toBe(false);

      const openBaseline = await runLocalCommand({
        cmd: ["/bin/sh", "-c", 'p=/usr/bin/o; "$p"pen -Ra Safari'],
        stdin: "",
      });
      expect(openBaseline.exitCode).toBe(0);

      const open = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", dir, "/bin/sh", "-c", 'p=/usr/bin/o; "$p"pen -Ra Safari'],
        stdin: "",
        env: execution!.env,
      });
      expect(open.exitCode).not.toBe(0);

      const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      if (await Bun.file(chrome).exists()) {
        const browser = await runLocalCommand({
          cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", dir, "/bin/sh", "-c", `p=${JSON.stringify(chrome)}; "$p" --version`],
          stdin: "",
          env: execution!.env,
        });
        expect(browser.exitCode).not.toBe(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });

  test.skipIf(process.platform !== "darwin")("protected Codex runtime rejects a precreated auth symlink before copying credentials", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".orbs-protected-codex-symlink-"));
    const sourceHome = await mkdtemp(join(tmpdir(), "orbs-source-codex-home-"));
    const runtimeBase = await mkdtemp(join(tmpdir(), "orbs-protected-runtime-"));
    const leakedAuth = join(dir, "leaked-auth.json");
    const previousCodexHome = process.env.CODEX_HOME;
    const previousRuntimeRoot = process.env.ORBS_CODEX_RUNTIME_ROOT;
    try {
      process.env.CODEX_HOME = sourceHome;
      process.env.ORBS_CODEX_RUNTIME_ROOT = runtimeBase;
      await writeFile(join(sourceHome, "auth.json"), "host-secret", "utf8");
      const runtimeRoot = protectedCodexRuntimeRoot(dir);
      await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
      await symlink(leakedAuth, join(runtimeRoot, "auth.json"));

      await expect(prepareCodexHostExecution({
        cwd: dir,
        sandbox: "workspace-write",
        browserProcessPolicy: "deny",
      })).rejects.toThrow("unsafe existing node");
      expect(await Bun.file(leakedAuth).exists()).toBe(false);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousRuntimeRoot === undefined) delete process.env.ORBS_CODEX_RUNTIME_ROOT;
      else process.env.ORBS_CODEX_RUNTIME_ROOT = previousRuntimeRoot;
      await rm(dir, { recursive: true, force: true });
      await rm(sourceHome, { recursive: true, force: true });
      await rm(runtimeBase, { recursive: true, force: true });
    }
  });

  test("resumable client rejects danger-full-access before launching Codex", async () => {
    let calls = 0;
    const client = createCodexResumableClient({
      cwd: "/repo",
      codexBin: "/custom/codex",
      sandbox: "danger-full-access",
      runCommand: async () => {
        calls += 1;
        throw new Error("danger-full-access must not launch");
      },
    });

    const result = await client.start({ prompt: "write without limits", sessionName: "danger" });

    expect(calls).toBe(0);
    expect(result.status).toBe("blocked");
    if (result.status === "running") throw new Error("expected blocked result");
    expect(result.output.summary).toContain("host_sandbox_capability_unavailable");
    expect(result.output.artifacts).toContainEqual(expect.objectContaining({
      kind: "host_sandbox_capability",
      requestedSandbox: "danger-full-access",
      recoverable: false,
    }));
  });

  test.skipIf(process.platform !== "darwin")("resumable client fails before launch when its host is already inside seatbelt", async () => {
    const previousSandbox = process.env.CODEX_SANDBOX;
    let calls = 0;
    try {
      process.env.CODEX_SANDBOX = "seatbelt";
      const client = createCodexResumableClient({
        cwd: "/repo",
        codexBin: "/custom/codex",
        sandbox: "workspace-write",
        runCommand: async () => {
          calls += 1;
          throw new Error("nested codex must not launch");
        },
      });

      const start = await client.start({ prompt: "write safely", sessionName: "nested-start" });
      const resume = await client.resume({
        sessionId: "session_nested",
        prompt: "continue safely",
        sessionName: "nested-resume",
      });

      expect(calls).toBe(0);
      for (const result of [start, resume]) {
        expect(result.status).toBe("blocked");
        if (result.status === "running") throw new Error("expected blocked result");
        expect(result.output.summary).toContain("host_sandbox_capability_unavailable");
        expect(result.output.artifacts).toContainEqual(expect.objectContaining({
          kind: "host_sandbox_capability",
          requestedSandbox: "workspace-write",
          hostSandbox: "seatbelt",
          recoverable: true,
        }));
      }
    } finally {
      if (previousSandbox === undefined) delete process.env.CODEX_SANDBOX;
      else process.env.CODEX_SANDBOX = previousSandbox;
    }
  });

  test("resumable client resumes a session and parses the final attempt output", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const client = createCodexResumableClient({
      cwd: "/repo",
      codexBin: "/custom/codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
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
    expect(calls[0].cmd).toEqual([
      "/custom/codex",
      "exec",
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="high"',
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
      "resume",
      "session_123",
      "-",
    ]);
    expect(calls[0].stdin).toBe("continue");
  });

  test("resumable client returns compact input_too_large results without invoking start or resume commands", async () => {
    let commandCalls = 0;
    const client = createCodexResumableClient({
      cwd: "/repo",
      codexBin: "/custom/codex",
      runCommand: async () => {
        commandCalls += 1;
        throw new Error("runCommand should not be called");
      },
    });
    const oversized = `OVERSIZED_DIRECT_CODEX_INPUT_${"界".repeat(910_000)}`;

    const startResult = await client.start({ prompt: oversized, sessionName: "oversized-start" });
    const resumeResult = await client.resume({
      sessionId: "session_oversized",
      prompt: oversized,
      sessionName: "oversized-resume",
    });

    expect(commandCalls).toBe(0);
    for (const result of [startResult, resumeResult]) {
      expect(result.status).toBe("blocked");
      if (result.status === "running") throw new Error("expected blocked result");
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.events).toEqual([]);
      expect(result.output.summary).toContain("input_too_large");
      expect(result.output.artifacts).toContainEqual(expect.objectContaining({
        kind: "prompt_input_budget_exceeded",
        characterLimit: 900_000,
        utf8ByteLimit: 900_000,
      }));
    }
  });
});
