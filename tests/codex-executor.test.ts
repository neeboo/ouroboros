import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
          "--ignore-user-config",
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

    expect(calls[0].cmd).toContain("-m");
    expect(calls[0].cmd).toContain("gpt-5-codex");
  });
});
