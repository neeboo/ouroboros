import { describe, expect, test } from "bun:test";
import { createRouteExecutor } from "../packages/runner/src";
import type { ResolvedExecutionRoute } from "../packages/runner/src";

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
  config: {},
  worktreePath: null,
  sessionRef: null,
  contextVersion: 1,
};

describe("route executor", () => {
  test("creates acpx executors from resolved routes", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const route: ResolvedExecutionRoute = {
      role: "worker",
      backend: {
        id: "claude-code",
        kind: "acpx",
        source: "role-default",
        agent: "claude",
        approval: "approve-all",
      },
      model: { model: "sonnet", source: "role-default", role: "worker" },
      executionMode: "generic",
    };
    const executor = createRouteExecutor({
      cwd: "/repo",
      route,
      approval: "approve-reads",
      runCommand: async ({ cmd, stdin }) => {
        calls.push({ cmd, stdin });
        return {
          exitCode: 0,
          stdout: '{"status":"done","summary":"claude route ok","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
          stderr: "",
        };
      },
    });

    const output = await executor({
      prompt: "Do the task",
      sessionName: "task_1",
      run: runFixture,
      task: taskFixture,
      route,
    });

    expect(output.summary).toBe("claude route ok");
    expect(calls.map((call) => call.cmd)).toEqual([
      ["acpx", "--cwd", "/repo", "--approve-all", "--format", "text", "--model", "sonnet", "claude", "sessions", "show", "task_1"],
      ["acpx", "--cwd", "/repo", "--approve-all", "--format", "text", "--model", "sonnet", "claude", "prompt", "-s", "task_1", "-f", "-"],
    ]);
  });

  test("forwards the browser process policy to generic Claude routes", async () => {
    const calls: Array<{ cmd: string[]; env?: Record<string, string | undefined> }> = [];
    const route: ResolvedExecutionRoute = {
      role: "worker",
      backend: {
        id: "claude-code",
        kind: "acpx",
        source: "role-default",
        agent: "claude",
        approval: "approve-all",
      },
      model: null,
      executionMode: "generic",
    };
    const executor = createRouteExecutor({
      cwd: "/repo",
      route,
      browserProcessPolicy: "deny",
      runCommand: async ({ cmd, env }) => {
        calls.push({ cmd, env });
        return {
          exitCode: 0,
          stdout: '{"status":"done","summary":"claude route ok","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
          stderr: "",
        };
      },
    });

    await executor({
      prompt: "Use APIs only",
      sessionName: "task_1",
      run: runFixture,
      task: taskFixture,
      route,
    });

    expect(calls[0]?.env?.ORBS_BROWSER_PROCESS_POLICY).toBe("deny");
    if (process.platform === "darwin") {
      expect(calls[0]?.cmd.slice(0, 2)).toEqual(["/usr/bin/sandbox-exec", "-p"]);
    }
  });

  test("creates codex cli executors from resolved routes", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const route: ResolvedExecutionRoute = {
      role: "planner",
      backend: { id: "codex-cli", kind: "codex-cli", source: "cli-executor" },
      model: { model: "gpt-5-codex", source: "global", role: "planner" },
      executionMode: "generic",
    };
    const executor = createRouteExecutor({
      cwd: "/repo",
      route,
      sandbox: "workspace-write",
      codexBin: "/custom/codex",
      runCommand: async ({ cmd, stdin }) => {
        calls.push({ cmd, stdin });
        return {
          exitCode: 0,
          stdout: '{"status":"done","summary":"codex route ok","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
          stderr: "",
        };
      },
    });

    const output = await executor({
      prompt: "Plan the task",
      sessionName: "task_1",
      run: runFixture,
      task: { ...taskFixture, role: "planner" },
      route,
    });

    expect(output.summary).toBe("codex route ok");
    expect(calls[0]).toMatchObject({
      cmd: [
        "/custom/codex",
        "exec",
        "-m",
        "gpt-5-codex",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "-c",
        'approval_policy="never"',
        "--output-last-message",
        expect.any(String),
        "-C",
        "/repo",
        "--sandbox",
        "workspace-write",
        "-",
      ],
      stdin: "Plan the task",
    });
  });

  test("creates DeepSeek Harness executors from explicit DSH routes", async () => {
    const calls: Array<{ cmd: string[]; cwd?: string; env?: Record<string, string | undefined> }> = [];
    const route: ResolvedExecutionRoute = {
      role: "worker",
      backend: {
        id: "deepseek-harness",
        kind: "dsh-cli",
        command: "/custom/dsh",
        profile: "headless",
        env: { DSH_HOME: "/tmp/dsh-home" },
        source: "task",
      },
      model: null,
      executionMode: "generic",
    };
    const executor = createRouteExecutor({
      cwd: "/repo/.ouroboros/worktrees/task_1",
      route,
      sandbox: "workspace-write",
      resolveDshCommand: () => ({
        configuredCommand: "/custom/dsh",
        resolutionMode: "explicit",
        selectedPath: "/custom/dsh",
        canonicalPath: "/custom/dsh",
        installationState: "available",
        callable: true,
        diagnostic: null,
      }),
      runCommand: async ({ cmd, cwd, env }) => {
        calls.push({ cmd, cwd, env });
        return {
          exitCode: 0,
          stdout: '{"status":"done","summary":"dsh route ok","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
          stderr: "",
        };
      },
    });

    const output = await executor({
      prompt: "Implement the task",
      sessionName: "task_1",
      run: runFixture,
      task: taskFixture,
      route,
    });

    expect(output.summary).toBe("dsh route ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      cwd: "/repo/.ouroboros/worktrees/task_1",
      env: { DSH_HOME: "/tmp/dsh-home", DSH_PERMISSION_MODE: "workspace-write" },
    });
    expect(calls[0]?.cmd.slice(0, 3)).toEqual(["/custom/dsh", "--profile", "headless"]);
    expect(calls[0]?.cmd).toContain("--patch");
    expect(calls[0]?.cmd.at(-1)).toBe("Implement the task");
  });

  test("blocks DSH host capabilities before launching the executor", async () => {
    let calls = 0;
    const route: ResolvedExecutionRoute = {
      role: "verifier",
      backend: {
        id: "dsh-cli",
        kind: "dsh-cli",
        command: "dsh",
        profile: "headless",
        source: "task",
      },
      model: null,
      executionMode: "generic",
    };
    const executor = createRouteExecutor({
      cwd: "/repo",
      route,
      hostExecutionCapabilities: { schemaVersion: 1 },
      runCommand: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const output = await executor({
      prompt: "Verify the task",
      sessionName: "task_1",
      run: runFixture,
      task: { ...taskFixture, role: "verifier" },
      route,
    });

    expect(output).toMatchObject({ status: "blocked", summary: expect.stringContaining("host execution capabilities") });
    expect(calls).toBe(0);
  });
});
