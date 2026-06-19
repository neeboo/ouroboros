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
      ["acpx", "--cwd", "/repo", "--approve-all", "--format", "text", "--model", "sonnet", "claude", "exec", "-f", "-"],
    ]);
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
});
