import type { StartHook } from "../types";
import { runLocalCommand } from "../executors/command";
import type { RunCommand } from "../executors/types";

export function createGitWorktreeHook(options: {
  repoPath: string;
  baseRef?: string;
  runCommand?: RunCommand;
}): StartHook {
  const runCommand = options.runCommand ?? runLocalCommand;
  const baseRef = options.baseRef ?? "main";

  return async ({ task, cwd }) => {
    const branch = `ouroboros/${task.id}`;
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

    return {
      checks: [{ name: "git worktree add", status: "passed" }],
      artifacts: [{ kind: "worktree", path: cwd, branch }],
    };
  };
}
