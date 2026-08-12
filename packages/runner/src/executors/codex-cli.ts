import { commandProblem, runLocalCommand } from "./command";
import { withBrowserProcessPolicy } from "./browser-process-policy";
import { defaultCodexBin } from "./codex-bin";
import { parseAttemptOutputOrBlocked } from "./output";
import type { CodexCliExecutorOptions } from "./types";
import type { TaskExecutor } from "../types";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promptBudgetBlockedOutput, promptBudgetEvidence } from "../prompt-budget";
import { hostSandboxCapabilityOutput } from "./host-sandbox-capability";
import { prepareCodexHostExecution } from "./codex-host-execution";

export function createCodexCliExecutor(options: CodexCliExecutorOptions): TaskExecutor {
  const sandbox = options.sandbox ?? "read-only";
  const rawRunCommand = options.runCommand ?? runLocalCommand;
  const policyRunCommand = withBrowserProcessPolicy(rawRunCommand, options.browserProcessPolicy);
  const codexBin = options.codexBin ?? defaultCodexBin();

  return async ({ prompt, sessionName }) => {
    const unavailableHost = hostSandboxCapabilityOutput(sandbox, "codex cli executor start");
    if (unavailableHost) {
      return unavailableHost;
    }
    const oversizedPrompt = promptBudgetEvidence(prompt, "codex cli executor start");
    if (oversizedPrompt) {
      return promptBudgetBlockedOutput(oversizedPrompt);
    }
    const hostExecution = await prepareCodexHostExecution({
      cwd: options.cwd,
      sandbox,
      browserProcessPolicy: options.browserProcessPolicy,
      injectedRunCommand: options.runCommand,
    });
    const outputPath = await makeOutputPath(hostExecution?.outputDir ?? options.outputDir, sessionName);
    const modelArgs = options.model ? ["-m", options.model] : [];
    const reasoningArgs = options.reasoningEffort ? ["-c", `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`] : [];
    const result = await (hostExecution ? rawRunCommand : policyRunCommand)({
      cmd: [
        codexBin,
        "exec",
        ...modelArgs,
        ...reasoningArgs,
        "--skip-git-repo-check",
        ...(hostExecution ? ["--strict-config"] : []),
        ...(hostExecution ? [] : ["--ignore-user-config"]),
        "-c",
        'approval_policy="never"',
        "--output-last-message",
        outputPath,
        "-C",
        options.cwd,
        ...(hostExecution ? [] : ["--sandbox", sandbox]),
        "-",
      ],
      stdin: prompt,
      env: hostExecution?.env,
      timeoutMs: options.timeoutMs,
      idleTimeoutMs: options.idleTimeoutMs,
    });

    if (result.exitCode !== 0) {
      return {
        status: "blocked",
        summary: "codex cli executor failed",
        changedFiles: [],
        checks: [{ name: "codex exec", status: "failed" }],
        artifacts: [],
        problems: [commandProblem(result)],
      };
    }

    return parseAttemptOutputOrBlocked({
      raw: (await readOutputFile(outputPath)) || result.stdout,
      summary: "codex cli executor produced invalid output",
      checkName: "codex output parse",
    });
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
