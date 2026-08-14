import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { boundedDiagnosticText } from "./bounded-diagnostic";
import { runLocalCommand } from "./executors/command";
import { childEnvForProcess } from "./executors/proxy-env";
import type { CommandResult, RunCommand } from "./executors/types";

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const MAX_PROBE_OUTPUT_CHARS = 4_000;
const MAX_READINESS_DIAGNOSTIC_CHARS = 1_200;
const VERSION_TOKEN = /\b[vV]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/;
const HELP_HEADER = /^\s*(?:usage|options?|commands?|arguments?|flags?)\s*:/im;

export type DshResolutionMode = "path" | "explicit";
export type DshInstallationState = "available" | "missing" | "non-callable";

export interface DshCommandResolution {
  configuredCommand: string;
  resolutionMode: DshResolutionMode;
  selectedPath: string | null;
  canonicalPath: string | null;
  installationState: DshInstallationState;
  callable: boolean;
  diagnostic: string | null;
}

export interface ResolveDshCommandInput {
  command?: string;
  cwd: string;
  env?: Record<string, string | undefined>;
}

export type DshCommandResolver = (input: ResolveDshCommandInput) => DshCommandResolution;

export interface DshProbeReceipt {
  command: string[];
  status: "passed" | "failed";
  exitCode: number | null;
  output: string;
  stdout: string;
  diagnostic: string | null;
}

export interface DshReadinessReceipt {
  backendId: string;
  configuredCommand: string;
  resolutionMode: DshResolutionMode;
  installationState: DshInstallationState;
  selectedPath: string | null;
  canonicalPath: string | null;
  observedVersion: string | null;
  versionProbeStatus: "passed" | "failed" | "not-run";
  helpProbeStatus: "passed" | "failed" | "not-run";
  callable: boolean;
  readiness: boolean;
  lifecycle: "one-shot";
  status: "passed" | "blocked";
  probes: DshProbeReceipt[];
  diagnostics: string[];
  evidence: {
    providerCalls: 0;
    modelInferenceCalls: 0;
    paidSpendUsd: 0;
    promptSent: false;
    taskExecutionStarted: false;
  };
}

export interface InspectDshReadinessInput extends ResolveDshCommandInput {
  backendId: string;
  profile?: string;
  timeoutMs?: number;
  runCommand?: RunCommand;
  resolveCommand?: DshCommandResolver;
}

export const resolveDshCommand: DshCommandResolver = (input) => {
  const configuredCommand = input.command?.trim() || "dsh";
  const resolutionMode = isExplicitCommand(configuredCommand) ? "explicit" : "path";
  if (resolutionMode === "explicit") {
    return resolutionForPath(configuredCommand, resolutionMode, configuredCommand, input.cwd);
  }

  const env = effectiveEnvironment(input.env);
  const pathEntries = (env.PATH ?? "").split(delimiter);
  let firstExisting: string | null = null;
  for (const entry of pathEntries) {
    const directory = entry.length > 0 ? (isAbsolute(entry) ? entry : resolve(input.cwd, entry)) : input.cwd;
    const candidate = join(directory, configuredCommand);
    if (existsSync(candidate) && firstExisting === null) {
      firstExisting = candidate;
    }
    if (isCallable(candidate)) {
      return resolutionForPath(candidate, resolutionMode, configuredCommand, input.cwd);
    }
  }

  if (firstExisting) {
    return {
      ...resolutionForPath(firstExisting, resolutionMode, configuredCommand, input.cwd),
      installationState: "non-callable",
      callable: false,
      diagnostic: boundedDiagnosticText(`DSH command is not executable: ${firstExisting}`, MAX_READINESS_DIAGNOSTIC_CHARS).text,
    };
  }
  return {
    configuredCommand,
    resolutionMode,
    selectedPath: null,
    canonicalPath: null,
    installationState: "missing",
    callable: false,
    diagnostic: boundedDiagnosticText(`DSH command was not found in PATH: ${configuredCommand}`, MAX_READINESS_DIAGNOSTIC_CHARS).text,
  };
};

export async function inspectDshReadiness(input: InspectDshReadinessInput): Promise<DshReadinessReceipt> {
  const configuredCommand = input.command?.trim() || "dsh";
  const resolution = (input.resolveCommand ?? resolveDshCommand)({
    command: configuredCommand,
    cwd: input.cwd,
    env: input.env,
  });
  const base = {
    backendId: input.backendId,
    configuredCommand,
    resolutionMode: resolution.resolutionMode,
    installationState: resolution.installationState,
    selectedPath: resolution.selectedPath,
    canonicalPath: resolution.canonicalPath,
    observedVersion: null,
    versionProbeStatus: "not-run" as const,
    helpProbeStatus: "not-run" as const,
    callable: resolution.callable,
    readiness: false,
    lifecycle: "one-shot" as const,
    status: "blocked" as const,
    probes: [] as DshProbeReceipt[],
    diagnostics: resolution.diagnostic ? [resolution.diagnostic] : [],
    evidence: {
      providerCalls: 0 as const,
      modelInferenceCalls: 0 as const,
      paidSpendUsd: 0 as const,
      promptSent: false as const,
      taskExecutionStarted: false as const,
    },
  };

  if (input.profile !== undefined && input.profile !== "headless") {
    return { ...base, diagnostics: [...base.diagnostics, "DSH readiness inspection only supports the headless profile."] };
  }
  if (!resolution.callable || !resolution.selectedPath) {
    return base;
  }

  const runCommand = input.runCommand ?? runLocalCommand;
  const timeoutMs = input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probes: DshProbeReceipt[] = [];
  const versionProbe = await runDshProbe({
    command: resolution.selectedPath,
    flag: "--version",
    cwd: input.cwd,
    env: input.env,
    timeoutMs,
    runCommand,
  });
  probes.push(versionProbe.receipt);
  const helpProbe = await runDshProbe({
    command: resolution.selectedPath,
    flag: "--help",
    cwd: input.cwd,
    env: input.env,
    timeoutMs,
    runCommand,
  });
  probes.push(helpProbe.receipt);

  const versionPassed = versionProbe.receipt.status === "passed" && versionProbe.version !== null;
  const helpPassed = helpProbe.receipt.status === "passed" && helpProbe.receipt.stdout.trim().length > 0;
  return {
    ...base,
    observedVersion: versionProbe.version,
    versionProbeStatus: versionPassed ? "passed" : "failed",
    helpProbeStatus: helpPassed ? "passed" : "failed",
    readiness: versionPassed && helpPassed,
    status: versionPassed && helpPassed ? "passed" : "blocked",
    probes,
    diagnostics: [
      ...base.diagnostics,
      ...probes.flatMap((probe) => probe.diagnostic ? [probe.diagnostic] : []),
    ],
  };
}

function effectiveEnvironment(overrides: Record<string, string | undefined> | undefined) {
  const env = { ...childEnvForProcess() };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function resolutionForPath(path: string, resolutionMode: DshResolutionMode, configuredCommand: string, cwd: string): DshCommandResolution {
  const inspectionPath = isAbsolute(path) ? path : resolve(cwd, path);
  const callable = isCallable(inspectionPath);
  return {
    configuredCommand,
    resolutionMode,
    selectedPath: path,
    canonicalPath: canonicalPath(inspectionPath),
    installationState: callable ? "available" : existsSync(inspectionPath) ? "non-callable" : "missing",
    callable,
    diagnostic: callable ? null : boundedDiagnosticText(`DSH command is not callable: ${path}`, MAX_READINESS_DIAGNOSTIC_CHARS).text,
  };
}

function isExplicitCommand(command: string) {
  return isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function isCallable(path: string) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function canonicalPath(path: string) {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

async function runDshProbe(input: {
  command: string;
  flag: "--version" | "--help";
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  runCommand: RunCommand;
}) {
  const command = [input.command, input.flag];
  let result: CommandResult;
  try {
    result = await input.runCommand({
      cmd: command,
      stdin: "",
      cwd: input.cwd,
      env: input.env,
      timeoutMs: input.timeoutMs,
      idleTimeoutMs: input.timeoutMs,
    });
  } catch (error) {
    return {
      version: null,
      receipt: {
        command,
        status: "failed" as const,
        exitCode: null,
        output: "",
        stdout: "",
        diagnostic: boundedDiagnosticText(error instanceof Error ? error.message : String(error), MAX_READINESS_DIAGNOSTIC_CHARS).text,
      },
    };
  }

  const output = boundedDiagnosticText(`${result.stdout}${result.stderr}`, MAX_PROBE_OUTPUT_CHARS).text;
  const stdout = boundedDiagnosticText(result.stdout, MAX_PROBE_OUTPUT_CHARS).text;
  const passed = result.exitCode === 0 && (input.flag === "--help" ? HELP_HEADER.test(stdout) : VERSION_TOKEN.test(stdout));
  const diagnostic = passed
    ? null
    : boundedDiagnosticText(
      result.exitCode === 124
        ? `${input.flag} probe timed out`
        : input.flag === "--help" && result.exitCode === 0
          ? `${input.flag} probe returned malformed help output`
          : `${input.flag} probe failed with exit code ${result.exitCode}`,
      MAX_READINESS_DIAGNOSTIC_CHARS,
    ).text;
  return {
    version: input.flag === "--version" && passed ? extractVersion(stdout) : null,
    receipt: {
      command,
      status: passed ? "passed" as const : "failed" as const,
      exitCode: result.exitCode,
      output,
      stdout,
      diagnostic,
    },
  };
}

function extractVersion(output: string) {
  return VERSION_TOKEN.exec(output)?.[1] ?? null;
}
