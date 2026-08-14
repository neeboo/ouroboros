import type { AttemptOutput } from "@ouroboros/harness";
import { boundedDiagnosticText, sha256Text } from "../bounded-diagnostic";
import { promptBudgetBlockedOutput, promptBudgetEvidence } from "../prompt-budget";
import type { TaskExecutor } from "../types";
import { commandProblem, runLocalCommand } from "./command";
import { parseAttemptOutput } from "./output";
import type { DshCliExecutorOptions } from "./types";

export const DSH_PROMPT_ARGUMENT_MAX_CHARACTERS = 100_000;
export const DSH_PROMPT_ARGUMENT_MAX_UTF8_BYTES = 100_000;

export function createDshCliExecutor(options: DshCliExecutorOptions): TaskExecutor {
  const command = options.command ?? "dsh";
  const profile = options.profile ?? "headless";
  const sandbox = options.sandbox ?? "read-only";
  const runCommand = options.runCommand ?? runLocalCommand;

  return async ({ prompt, sessionName, recorder }) => {
    if (profile !== "headless") {
      return blockedOutput(
        "DeepSeek Harness profile is unsupported",
        "dsh profile",
        `DSH CLI executor only supports the headless profile; received ${profile}.`,
      );
    }
    if (sandbox === "danger-full-access") {
      return blockedOutput(
        "DeepSeek Harness danger-full-access is disabled",
        "dsh permission boundary",
        "DSH CLI executor refuses danger-full-access before launching the model.",
      );
    }
    if (options.hostExecutionCapabilities !== undefined && options.hostExecutionCapabilities !== null) {
      return blockedOutput(
        "DeepSeek Harness host execution capabilities are unsupported",
        "dsh host capability boundary",
        "DSH CLI executor cannot yet enforce Ouroboros host execution capabilities.",
      );
    }
    const oversizedPrompt = promptBudgetEvidence(prompt, "DeepSeek Harness CLI start");
    if (oversizedPrompt) {
      return promptBudgetBlockedOutput(oversizedPrompt);
    }
    const argumentBudget = dshPromptArgumentEvidence(prompt);
    if (argumentBudget) {
      return {
        status: "blocked",
        summary: "DeepSeek Harness positional prompt is too large",
        changedFiles: [],
        checks: [{ name: "dsh prompt argument budget", status: "failed", evidence: argumentBudget }],
        artifacts: [argumentBudget],
        problems: [
          `DSH prompt exceeds the positional argument limit: ${argumentBudget.characters}/${argumentBudget.characterLimit} characters, `
          + `${argumentBudget.utf8Bytes}/${argumentBudget.utf8ByteLimit} UTF-8 bytes; sha256=${argumentBudget.sha256}.`,
        ],
      };
    }

    recorder?.event({
      type: "dsh.attempt.started",
      sessionName,
      profile,
      cwd: options.cwd,
      permissionMode: sandbox,
      promptCharacters: prompt.length,
      promptSha256: sha256Text(prompt),
    });

    let result;
    try {
      result = await runCommand({
        cmd: [command, "--profile", profile, prompt],
        stdin: "",
        cwd: options.cwd,
        env: { ...options.env, DSH_PERMISSION_MODE: sandbox },
        timeoutMs: options.timeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
      });
    } catch (error) {
      const diagnostic = boundedDiagnosticText(error instanceof Error ? error.message : String(error));
      recorder?.event({
        type: "dsh.attempt.terminal",
        sessionName,
        status: "blocked",
        phase: "spawn",
        errorSha256: diagnostic.sha256,
      });
      return blockedOutput(
        "DeepSeek Harness CLI could not start",
        "dsh cli start",
        diagnostic.text,
      );
    }

    if (result.exitCode !== 0) {
      recorder?.event({
        type: "dsh.attempt.terminal",
        sessionName,
        status: "blocked",
        exitCode: result.exitCode,
      });
      return blockedOutput(
        "DeepSeek Harness CLI failed",
        "dsh headless execution",
        commandProblem(result),
      );
    }

    let output: AttemptOutput;
    try {
      output = parseAttemptOutput(result.stdout);
    } catch (error) {
      const raw = boundedDiagnosticText(result.stdout);
      const reason = boundedDiagnosticText(error instanceof Error ? error.message : String(error), 1_200);
      output = blockedOutput(
        "DeepSeek Harness produced invalid output",
        "dsh output parse",
        `${reason.text}\n\nOutput:\n${raw.text}`,
      );
    }
    recorder?.event({
      type: "dsh.attempt.terminal",
      sessionName,
      status: output.status,
      exitCode: result.exitCode,
    });
    return output;
  };
}

function dshPromptArgumentEvidence(prompt: string) {
  const characters = prompt.length;
  const utf8Bytes = Buffer.byteLength(prompt, "utf8");
  if (characters <= DSH_PROMPT_ARGUMENT_MAX_CHARACTERS && utf8Bytes <= DSH_PROMPT_ARGUMENT_MAX_UTF8_BYTES) {
    return null;
  }
  return {
    kind: "dsh_prompt_argument_too_large" as const,
    characters,
    utf8Bytes,
    characterLimit: DSH_PROMPT_ARGUMENT_MAX_CHARACTERS,
    utf8ByteLimit: DSH_PROMPT_ARGUMENT_MAX_UTF8_BYTES,
    sha256: sha256Text(prompt),
  };
}

function blockedOutput(summary: string, checkName: string, problem: string): AttemptOutput {
  return {
    status: "blocked",
    summary,
    changedFiles: [],
    checks: [{ name: checkName, status: "failed" }],
    artifacts: [],
    problems: [boundedDiagnosticText(problem).text],
  };
}
