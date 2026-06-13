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
    });
  });

  test("runs acpx codex exec through an injectable command runner", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const executor = createAcpxCodexExecutor({
      cwd: "/repo",
      approval: "approve-all",
      runCommand: async ({ cmd, stdin }) => {
        calls.push({ cmd, stdin });
        return {
          exitCode: 0,
          stdout: '{"status":"blocked","summary":"Need input","changedFiles":[],"checks":[],"artifacts":[],"problems":["missing token"]}',
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
        cmd: ["acpx", "--cwd", "/repo", "--approve-all", "--format", "text", "codex", "sessions", "ensure", "--name", "task_1"],
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
});
