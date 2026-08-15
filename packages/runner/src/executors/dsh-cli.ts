import type { AttemptOutput } from "@ouroboros/harness";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedDiagnosticText, sha256Text } from "../bounded-diagnostic";
import { promptBudgetBlockedOutput, promptBudgetEvidence } from "../prompt-budget";
import { resolveDshCommand } from "../dsh-readiness";
import type { TaskExecutor } from "../types";
import { commandProblem, runLocalCommand } from "./command";
import { prepareDshProcessPolicy } from "./dsh-process-policy";
import { parseAttemptOutput } from "./output";
import type { DshCliExecutorOptions } from "./types";

export const DSH_PROMPT_ARGUMENT_MAX_CHARACTERS = 100_000;
export const DSH_PROMPT_ARGUMENT_MAX_UTF8_BYTES = 100_000;
const BASE_HEADLESS_PLUGINS = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] as const;
const BASE_HEADLESS_PATCH = "[]\n";

interface DshExecutionProfileReceipt {
  kind: "dsh_execution_profile_receipt";
  schemaVersion: 1;
  attemptId: string | null;
  profile: "headless";
  mode: "base-headless";
  enabledPlugins: string[];
  profileSha256: string;
  profilePatchSha256: string;
  processPolicyPatchSha256: string;
  network: { mode: "deny"; enforcement: "dsh-sandbox-local" };
  preflight: {
    passed: true;
    projectPluginsLoaded: false;
    ambientCredentialsInherited: false;
    targetCredentialsInherited: false;
    modelCredentialNames: string[];
  };
}

export function createDshCliExecutor(options: DshCliExecutorOptions): TaskExecutor {
  const command = options.command ?? "dsh";
  const profile = options.profile ?? "headless";
  const sandbox = options.sandbox ?? "read-only";
  const runCommand = options.runCommand ?? runLocalCommand;
  const resolveCommand = options.resolveCommand ?? resolveDshCommand;

  return async ({ prompt, sessionName, attemptId, recorder }) => {
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
    if ((options.requiredPlugins?.length ?? 0) > 0) {
      const requiredPlugins = [...new Set(options.requiredPlugins)].sort();
      return blockedOutput(
        "DeepSeek Harness project plugins require an explicit host configuration",
        "dsh project plugin boundary",
        `DSH project plugins are not available in the base-only execution profile: ${requiredPlugins.join(", ")}.`,
        [{ kind: "dsh_project_plugins_unconfigured", requiredPlugins }],
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

    let isolatedProfile: Awaited<ReturnType<typeof createIsolatedHeadlessHome>> | null = null;
    let processPolicy: Awaited<ReturnType<typeof prepareDshProcessPolicy>> = null;
    let profileReceipt: DshExecutionProfileReceipt | null = null;
    let result;
    try {
      isolatedProfile = await createIsolatedHeadlessHome();
      processPolicy = await prepareDshProcessPolicy();
      if (!processPolicy) {
        throw new Error("DSH offline network denial is unsupported on this host and must fail closed before model execution.");
      }
      const processEnvironment = dshProcessEnvironment(options.env, isolatedProfile.home, sandbox);
      const modelCredentialNames = processEnvironment.DEEPSEEK_API_KEY ? ["DEEPSEEK_API_KEY"] : [];
      profileReceipt = {
        kind: "dsh_execution_profile_receipt",
        schemaVersion: 1,
        attemptId: attemptId ?? null,
        profile: "headless",
        mode: "base-headless",
        enabledPlugins: [...BASE_HEADLESS_PLUGINS],
        profileSha256: isolatedProfile.profileSha256,
        profilePatchSha256: isolatedProfile.profilePatchSha256,
        processPolicyPatchSha256: processPolicy.patchSha256,
        network: { mode: "deny", enforcement: "dsh-sandbox-local" },
        preflight: {
          passed: true,
          projectPluginsLoaded: false,
          ambientCredentialsInherited: false,
          targetCredentialsInherited: false,
          modelCredentialNames,
        },
      };
      recorder?.event({
        type: "dsh.attempt.started",
        sessionName,
        profile,
        cwd: options.cwd,
        permissionMode: sandbox,
        promptCharacters: prompt.length,
        promptSha256: sha256Text(prompt),
        profileIsolation: "base-headless",
      });
      recorder?.event({
        type: "dsh.profile.preflight",
        attemptId: attemptId ?? null,
        profile,
        mode: "base-headless",
        enabledPlugins: [...BASE_HEADLESS_PLUGINS],
        profileSha256: profileReceipt.profileSha256,
        profilePatchSha256: profileReceipt.profilePatchSha256,
        processPolicyPatchSha256: profileReceipt.processPolicyPatchSha256,
        networkMode: "deny",
        projectPluginsLoaded: false,
        ambientCredentialsInherited: false,
        targetCredentialsInherited: false,
        modelCredentialNames,
      });
      result = await runCommand({
        cmd: [
          resolution.selectedPath,
          "--profile",
          profile,
          ...(processPolicy ? ["--patch", processPolicy.patchPath] : []),
          prompt,
        ],
        stdin: "",
        cwd: options.cwd,
        env: processEnvironment,
        inheritEnv: false,
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
        profileReceipt ? [profileReceipt] : [],
      );
    } finally {
      if (isolatedProfile) {
        await rm(isolatedProfile.home, { recursive: true, force: true });
      }
      await processPolicy?.cleanup();
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
        profileReceipt ? [profileReceipt] : [],
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
    return profileReceipt
      ? { ...output, artifacts: [...(output.artifacts ?? []), profileReceipt] }
      : output;
  };
}

function dshProcessEnvironment(
  configured: Record<string, string | undefined> | undefined,
  isolatedHome: string,
  sandbox: string,
) {
  const source = { ...process.env, ...(configured ?? {}) };
  const environment: Record<string, string | undefined> = {
    PATH: source.PATH,
    HOME: isolatedHome,
    TMPDIR: source.TMPDIR,
    LANG: source.LANG,
    LC_ALL: source.LC_ALL,
    LC_CTYPE: source.LC_CTYPE,
    SHELL: source.SHELL,
    USER: source.USER,
    LOGNAME: source.LOGNAME,
    TERM: source.TERM,
    CI: source.CI,
    NO_COLOR: source.NO_COLOR,
    PROTO_HOME: source.PROTO_HOME,
    BUN_INSTALL: source.BUN_INSTALL,
    NVM_BIN: source.NVM_BIN,
    NVM_DIR: source.NVM_DIR,
    PNPM_HOME: source.PNPM_HOME,
    DEEPSEEK_API_KEY: source.DEEPSEEK_API_KEY,
    DEEPSEEK_BASE_URL: source.DEEPSEEK_BASE_URL,
    DSH_HOME: isolatedHome,
    DSH_AGENTS_HOME: join(isolatedHome, "agents"),
    DSH_PERMISSION_MODE: sandbox,
  };
  for (const [key, value] of Object.entries(configured ?? {})) {
    if (isExplicitDshEnvironmentNameAllowed(key)) environment[key] = value;
  }
  return environment;
}

function isExplicitDshEnvironmentNameAllowed(key: string) {
  if (key === "DEEPSEEK_API_KEY" || key === "DEEPSEEK_BASE_URL") return true;
  if (key.startsWith("DSH_") || key.startsWith("HODOR_")) return false;
  if (/proxy/i.test(key)) return false;
  return !/(?:key|token|secret|credential|password|authorization|cookie|session)/i.test(key);
}

async function createIsolatedHeadlessHome() {
  const home = await mkdtemp(join(tmpdir(), "ouroboros-dsh-"));
  const profileDir = join(home, "profiles", "headless");
  const profileContent = `${JSON.stringify({
    name: "dsh-profile-headless",
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        bundles: BASE_HEADLESS_PLUGINS,
      },
    },
  }, null, 2)}\n`;
  try {
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await mkdir(join(home, "agents"), { recursive: true, mode: 0o700 });
    await writeFile(join(profileDir, "package.json"), profileContent, { mode: 0o600 });
    await writeFile(join(profileDir, "cordis.patch.yml"), BASE_HEADLESS_PATCH, { mode: 0o600 });
    return {
      home,
      profileSha256: sha256Text(profileContent),
      profilePatchSha256: sha256Text(BASE_HEADLESS_PATCH),
    };
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
