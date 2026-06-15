import type { StartHook } from "../types";
import { runLocalCommand } from "../executors/command";
import type { RunCommand } from "../executors/types";
import { existsSync } from "node:fs";

export function createGitWorktreeHook(options: {
  repoPath: string;
  baseRef?: string;
  runCommand?: RunCommand;
}): StartHook {
  const runCommand = options.runCommand ?? runLocalCommand;
  const baseRef = options.baseRef ?? "main";

  return async ({ task, cwd }) => {
    const branch = `ouroboros/${task.id}`;
    const checks: Array<{ name: string; status: "passed" | "failed"; summary?: string }> = [];

    if (existsSync(cwd)) {
      const existingResult = await runCommand({
        cmd: ["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"],
        stdin: "",
      });
      if (existingResult.exitCode !== 0) {
        return {
          checks: [{ name: "git worktree reuse", status: "failed" }],
          problems: [existingResult.stderr || existingResult.stdout || `exit code ${existingResult.exitCode}`],
        };
      }
      checks.push({ name: "git worktree reuse", status: "passed", summary: "existing task worktree reused" });
    } else {
      const result = await runCommand({
        cmd: ["git", "-C", options.repoPath, "worktree", "add", cwd, "-b", branch, baseRef],
        stdin: "",
      });

      if (result.exitCode !== 0) {
        return {
          checks: [{ name: "git worktree add", status: "failed" }],
          problems: [result.stderr || result.stdout || `exit code ${result.exitCode}`],
        };
      }
      checks.push({ name: "git worktree add", status: "passed" });
    }

    const installResult = await runCommand({
      cmd: ["bun", "install", "--cwd", cwd, "--frozen-lockfile"],
      stdin: "",
    });

    if (installResult.exitCode !== 0) {
      return {
        checks: [
          ...checks,
          { name: "bun install", status: "failed" },
        ],
        problems: [installResult.stderr || installResult.stdout || `exit code ${installResult.exitCode}`],
      };
    }

    return {
      checks: [
        ...checks,
        { name: "bun install", status: "passed" },
      ],
      artifacts: [{ kind: "worktree", path: cwd, branch }],
    };
  };
}
