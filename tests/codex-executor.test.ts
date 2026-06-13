import { describe, expect, test } from "bun:test";
import { createCodexCliExecutor } from "../packages/runner/src";

describe("codex cli executor", () => {
  test("runs codex exec through an injectable command runner", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const executor = createCodexCliExecutor({
      cwd: "/repo",
      sandbox: "read-only",
      codexBin: "/custom/codex",
      runCommand: async ({ cmd, stdin }) => {
        calls.push({ cmd, stdin });
        return {
          exitCode: 0,
          stdout: '{"status":"done","summary":"planned","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
          stderr: "",
        };
      },
    });

    const output = await executor({
      prompt: "Plan next task",
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
          "-C",
          "/repo",
          "--sandbox",
          "read-only",
          "--ask-for-approval",
          "never",
          "-",
        ],
        stdin: "Plan next task",
      },
    ]);
    expect(output.status).toBe("done");
    expect(output.summary).toBe("planned");
  });
});
