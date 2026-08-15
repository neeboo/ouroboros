import type { AttemptOutput } from "@ouroboros/harness";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedDiagnosticText, sha256Text } from "../bounded-diagnostic";
import { promptBudgetBlockedOutput, promptBudgetEvidence } from "../prompt-budget";
import { resolveDshCommand } from "../dsh-readiness";
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
  const resolveCommand = options.resolveCommand ?? resolveDshCommand;

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
    const resolution = resolveCommand({ command, cwd: options.cwd, env: options.env });
    if (!resolution.callable || !resolution.selectedPath) {
      return blockedOutput(
        "DeepSeek Harness executable is not callable",
        "dsh command readiness",
        resolution.diagnostic ?? `DSH command is unavailable: ${resolution.configuredCommand}`,
        [{
          kind: "dsh_command_resolution",
          configuredCommand: resolution.configuredCommand,
          resolutionMode: resolution.resolutionMode,
          selectedPath: resolution.selectedPath,
          canonicalPath: resolution.canonicalPath,
          installationState: resolution.installationState,
          callable: resolution.callable,
        }],
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

    let isolatedHome: string | null = null;
    let result;
    try {
      if (options.isolatedProfile === "base-headless") {
        isolatedHome = await createIsolatedHeadlessHome();
      }
      recorder?.event({
        type: "dsh.attempt.started",
        sessionName,
        profile,
        cwd: options.cwd,
        permissionMode: sandbox,
        promptCharacters: prompt.length,
        promptSha256: sha256Text(prompt),
        profileIsolation: options.isolatedProfile ?? null,
      });
      result = await runCommand({
        cmd: [resolution.selectedPath, "--profile", profile, prompt],
        stdin: "",
        cwd: options.cwd,
        env: {
          ...options.env,
          ...(isolatedHome
            ? {
                DSH_HOME: isolatedHome,
                DSH_AGENTS_HOME: join(isolatedHome, "agents"),
                HODOR_APPLICATION_BASE_URL: undefined,
                HODOR_APPLICATION_TOKEN: undefined,
                HODOR_AGENT_GATEWAY_TOKEN: undefined,
              }
            : {}),
          DSH_PERMISSION_MODE: sandbox,
        },
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
    } finally {
      if (isolatedHome) {
        await rm(isolatedHome, { recursive: true, force: true });
      }
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

async function createIsolatedHeadlessHome() {
  const home = await mkdtemp(join(tmpdir(), "ouroboros-dsh-"));
  const profileDir = join(home, "profiles", "headless");
  try {
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await mkdir(join(home, "agents"), { recursive: true, mode: 0o700 });
    await writeFile(join(profileDir, "package.json"), `${JSON.stringify({
      name: "dsh-profile-headless",
      private: true,
      dependencies: {},
      dsh: {
        profile: {
          bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"],
        },
      },
    }, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(profileDir, "cordis.patch.yml"), "[]\n", { mode: 0o600 });
    return home;
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
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

function blockedOutput(summary: string, checkName: string, problem: string, artifacts: unknown[] = []): AttemptOutput {
  return {
    status: "blocked",
    summary,
    changedFiles: [],
    checks: [{ name: checkName, status: "failed" }],
    artifacts,
    problems: [boundedDiagnosticText(problem).text],
  };
}
