import { runLocalCommand } from "./command";
import { parseAttemptOutput } from "./output";
import type { CodexCliExecutorOptions } from "./types";
import type { TaskExecutor } from "../types";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function createCodexCliExecutor(options: CodexCliExecutorOptions): TaskExecutor {
  const sandbox = options.sandbox ?? "read-only";
  const runCommand = options.runCommand ?? runLocalCommand;
  const codexBin = options.codexBin ?? "codex";

  return async ({ prompt, sessionName }) => {
    const outputPath = await makeOutputPath(options.outputDir, sessionName);
    const modelArgs = options.model ? ["-m", options.model] : [];
    const result = await runCommand({
      cmd: [
        codexBin,
        "exec",
        ...modelArgs,
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--output-last-message",
        outputPath,
        "-C",
        options.cwd,
        "--sandbox",
        sandbox,
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

    return parseAttemptOutput((await readOutputFile(outputPath)) || result.stdout);
  };
}

async function makeOutputPath(outputDir: string | undefined, sessionName: string) {
  const dir = outputDir ?? tmpdir();
  await mkdir(dir, { recursive: true });
  const safeSession = sessionName.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return join(dir, `ouroboros-${safeSession}-${Date.now()}.json`);
}

async function readOutputFile(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
