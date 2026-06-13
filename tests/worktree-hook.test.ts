import { describe, expect, test } from "bun:test";
import { createGitWorktreeHook } from "../packages/runner/src";

describe("git worktree hook", () => {
  test("creates a git worktree for the task cwd", async () => {
    const calls: string[][] = [];
    const hook = createGitWorktreeHook({
      repoPath: "/repo",
      baseRef: "main",
      runCommand: async ({ cmd }) => {
        calls.push(cmd);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const result = await hook({
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
        status: "running",
        role: "worker",
        goal: "Task",
        prompt: "Do it",
        dependsOn: [],
        doneWhen: [],
        worktreePath: "/tmp/wt/task_1",
        sessionRef: "session-task_1",
        contextVersion: 1,
      },
      sessionName: "session-task_1",
      cwd: "/tmp/wt/task_1",
    });

    expect(calls).toEqual([
      ["git", "-C", "/repo", "worktree", "add", "/tmp/wt/task_1", "-b", "ouroboros/task_1", "main"],
    ]);
    expect(result).toEqual({
      checks: [{ name: "git worktree add", status: "passed" }],
      artifacts: [{ kind: "worktree", path: "/tmp/wt/task_1", branch: "ouroboros/task_1" }],
    });
  });
});
