import { runLocalCommand } from "./command";
import { parseAttemptOutput } from "./output";
import type { CodexCliExecutorOptions } from "./types";
import type { TaskExecutor } from "../types";

export function createCodexCliExecutor(options: CodexCliExecutorOptions): TaskExecutor {
  const sandbox = options.sandbox ?? "read-only";
  const runCommand = options.runCommand ?? runLocalCommand;
  const codexBin = options.codexBin ?? "codex";

  return async ({ prompt }) => {
    const result = await runCommand({
      cmd: [
        codexBin,
        "exec",
        "--skip-git-repo-check",
        "-C",
        options.cwd,
        "--sandbox",
        sandbox,
        "--ask-for-approval",
        "never",
        "-",
      ],
      stdin: prompt,
      timeoutMs: options.timeoutMs,
    });

    if (result.exitCode !== 0) {
      return {
        status: "blocked",
        summary: "codex cli executor failed",
        changedFiles: [],
        checks: [{ name: "codex exec", status: "failed" }],
        artifacts: [],
        problems: [result.stderr || result.stdout || `exit code ${result.exitCode}`],
      };
    }

    return parseAttemptOutput(result.stdout);
  };
}
