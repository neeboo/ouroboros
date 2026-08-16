import type { AttemptOutput } from "@ouroboros/harness";
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { boundedDiagnosticText, sha256Text } from "../bounded-diagnostic";
import { promptBudgetBlockedOutput, promptBudgetEvidence } from "../prompt-budget";
import { inspectDshReadiness, resolveDshCommand } from "../dsh-readiness";
import type { TaskExecutor } from "../types";
import { commandProblem, runLocalCommand } from "./command";
import {
  prepareDshModelTransportBroker,
  type DshModelTransportBroker,
  type DshModelTransportReceipt,
} from "./dsh-model-transport";
import {
  normalizeDshFilePolicy,
  prepareDshProcessPolicy,
  type NormalizedDshFilePolicy,
} from "./dsh-process-policy";
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
  permissionMode: "read-only" | "workspace-write";
  filePolicy: NormalizedDshFilePolicy | null;
  profileSha256: string;
  profilePatchSha256: string;
  processPolicyPatchSha256: string;
  controlPathReadPolicy: "deny";
  deniedControlPathRootsSha256: string;
  modelTransport: DshModelTransportReceipt;
  toolSandbox: {
    network: "deny";
    enforcement: "darwin-host-seatbelt";
    credentialsInherited: false;
    filePolicySha256: string | null;
    sandboxProfileSha256: string;
    disabledInProcessRows: string[];
    disabledInProcessRowsSha256: string;
  };
  noTargetNetworkBypass: true;
  preflight: {
    passed: true;
    projectPluginsLoaded: false;
    ambientCredentialsInherited: false;
    targetCredentialsInherited: false;
    modelCredentialNames: string[];
  };
}

interface DshRuntimeBindingReceipt {
  kind: "dsh_runtime_binding_receipt";
  schemaVersion: 1;
  status: "passed" | "blocked";
  diagnosticCode?: "runtime-binding-denied";
  executablePath: string;
  executableRealpath: string;
  executableSha256: string;
  interpreterPath: string;
  interpreterSha256: string;
  runtimeRoots: string[];
  worktreePath: string;
  readExecBindingSha256: string;
  finalSpawnSandboxSha256: string;
}

interface DshProgressWatchdogReceipt {
  kind: "dsh_progress_watchdog_receipt";
  schemaVersion: 1;
  status: "progressing" | "stalled" | "completed";
  baselineFingerprint: string;
  finalFingerprint: string;
  progressSatisfied: boolean;
  lastProgressAt: string;
  requestCount: number;
  maxStallMs: number;
  minModelRequests: number;
  probeIntervalMs: number;
}

interface FrozenDshRuntimeBinding {
  commandPrefix: string[];
  receipt: DshRuntimeBindingReceipt;
  verify(): void;
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
    let filePolicy: NormalizedDshFilePolicy | null = null;
    try {
      filePolicy = sandbox === "workspace-write" ? normalizeDshFilePolicy(options.filePolicy) : null;
    } catch (error) {
      return blockedOutput(
        "DeepSeek Harness workspace-write policy is missing or invalid",
        "dsh file policy",
        error instanceof Error ? error.message : String(error),
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
    let runtimeBinding: FrozenDshRuntimeBinding | null = null;
    if (options.installationReceipt) {
      try {
        runtimeBinding = freezeDshRuntimeBinding(options.installationReceipt, options.cwd);
      } catch (error) {
        const problem = error instanceof Error ? error.message : String(error);
        return blockedOutput(
          "DeepSeek Harness runtime binding is unavailable",
          "dsh runtime binding",
          problem,
          [blockedDshRuntimeBindingReceipt(options.installationReceipt, options.cwd)],
        );
      }
    }
    const injectedResolution = options.resolveCommand && options.launchabilityPreflight !== true && !runtimeBinding
      ? resolveCommand({ command, cwd: options.cwd, env: options.env })
      : null;
    let readiness = injectedResolution || runtimeBinding ? null : await inspectDshReadiness({
      backendId: "dsh-cli",
      command,
      cwd: options.cwd,
      env: options.env,
      profile,
      runCommand,
      resolveCommand,
    });
    if (readiness && (!readiness.readiness || !readiness.selectedPath)) {
      return blockedOutput(
        readiness.callable
          ? "DeepSeek Harness executable failed launchability preflight"
          : "DeepSeek Harness executable is not callable",
        "dsh command readiness",
        readiness.diagnostics.join("\n") || `DSH command is unavailable: ${readiness.configuredCommand}`,
        [readiness],
      );
    }
    if (injectedResolution && (!injectedResolution.callable || !injectedResolution.selectedPath)) {
      return blockedOutput(
        "DeepSeek Harness executable is not callable",
        "dsh command readiness",
        injectedResolution.diagnostic ?? `DSH command is unavailable: ${injectedResolution.configuredCommand}`,
      );
    }
    const selectedCommand = runtimeBinding?.receipt.executablePath ?? readiness?.selectedPath ?? injectedResolution?.selectedPath;
    if (!selectedCommand) return blockedOutput("DeepSeek Harness executable is not callable", "dsh command readiness", "DSH command resolution returned no path");
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
    let modelTransport: DshModelTransportBroker | null = null;
    let profileReceipt: DshExecutionProfileReceipt | null = null;
    let progressWatchdog: ReturnType<typeof createDshNoWriteProgressWatchdog> | null = null;
    let result;
    try {
      isolatedProfile = await createIsolatedHeadlessHome();
      processPolicy = await prepareDshProcessPolicy({
        workspaceRoot: options.cwd,
        permissionMode: sandbox,
        filePolicy,
      });
      if (!processPolicy) {
        throw new Error("DSH offline network denial is unsupported on this host and must fail closed before model execution.");
      }
      const sourceEnvironment = { ...process.env, ...(options.env ?? {}) };
      modelTransport = await prepareDshModelTransportBroker({
        apiKey: sourceEnvironment.DEEPSEEK_API_KEY,
        endpoint: sourceEnvironment.DEEPSEEK_BASE_URL,
      });
      const processEnvironment = dshProcessEnvironment(
        options.env,
        isolatedProfile.home,
        sandbox,
        modelTransport,
      );
      if (runtimeBinding) {
        readiness = await inspectDshReadiness({
          backendId: "dsh-cli",
          command: runtimeBinding.receipt.executablePath,
          commandPrefix: runtimeBinding.commandPrefix,
          cwd: options.cwd,
          env: processEnvironment,
          inheritEnv: false,
          profile,
          runCommand,
          resolveCommand: () => ({
            configuredCommand: runtimeBinding!.receipt.executablePath,
            resolutionMode: "explicit",
            selectedPath: runtimeBinding!.receipt.executablePath,
            canonicalPath: runtimeBinding!.receipt.executableRealpath,
            installationState: "available",
            callable: true,
            diagnostic: null,
          }),
        });
        if (!readiness.readiness) {
          runtimeBinding.receipt.status = "blocked";
          runtimeBinding.receipt.diagnosticCode = "runtime-binding-denied";
          return blockedOutput(
            "DeepSeek Harness runtime binding failed launchability preflight",
            "dsh runtime binding",
            readiness.diagnostics.join("\n") || "The frozen DSH launch command failed in the final execution context.",
            [readiness, runtimeBinding.receipt],
          );
        }
        runtimeBinding.verify();
        runtimeBinding.receipt.finalSpawnSandboxSha256 = sha256Text(JSON.stringify({
          readExecBindingSha256: runtimeBinding.receipt.readExecBindingSha256,
          cwd: options.cwd,
          profileSha256: isolatedProfile.profileSha256,
          processPolicyPatchSha256: processPolicy.patchSha256,
          sandboxProfileSha256: processPolicy.sandboxProfileSha256,
          environmentKeys: Object.keys(processEnvironment).filter((key) => processEnvironment[key] !== undefined).sort(),
        }));
      }
      const modelCredentialNames: string[] = [];
      profileReceipt = {
        kind: "dsh_execution_profile_receipt",
        schemaVersion: 1,
        attemptId: attemptId ?? null,
        profile: "headless",
        mode: "base-headless",
        enabledPlugins: [...BASE_HEADLESS_PLUGINS],
        permissionMode: sandbox,
        filePolicy,
        profileSha256: isolatedProfile.profileSha256,
        profilePatchSha256: isolatedProfile.profilePatchSha256,
        processPolicyPatchSha256: processPolicy.patchSha256,
        controlPathReadPolicy: "deny",
        deniedControlPathRootsSha256: processPolicy.deniedControlPathRootsSha256,
        modelTransport: modelTransport.receipt(),
        toolSandbox: {
          network: "deny",
          enforcement: "darwin-host-seatbelt",
          credentialsInherited: false,
          filePolicySha256: processPolicy.filePolicySha256,
          sandboxProfileSha256: processPolicy.sandboxProfileSha256,
          disabledInProcessRows: processPolicy.disabledInProcessRows,
          disabledInProcessRowsSha256: processPolicy.disabledInProcessRowsSha256,
        },
        noTargetNetworkBypass: true,
        preflight: {
          passed: true,
          projectPluginsLoaded: false,
          ambientCredentialsInherited: false,
          targetCredentialsInherited: false,
          modelCredentialNames,
        },
      };
      progressWatchdog = options.noWriteProgressPolicy && filePolicy
        ? createDshNoWriteProgressWatchdog({
          cwd: options.cwd,
          filePolicy,
          policy: options.noWriteProgressPolicy,
          requestCount: () => modelTransport?.receipt().requestCount ?? 0,
          recorder,
        })
        : null;
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
        controlPathReadPolicy: profileReceipt.controlPathReadPolicy,
        deniedControlPathRootsSha256: profileReceipt.deniedControlPathRootsSha256,
        modelTransportProvider: profileReceipt.modelTransport.provider,
        modelTransportEndpointHostSha256: profileReceipt.modelTransport.endpointHostSha256,
        modelTransportEndpointPolicySha256: profileReceipt.modelTransport.endpointPolicySha256,
        modelTransportEnforcement: profileReceipt.modelTransport.enforcement,
        modelTransportCredentialIsolation: profileReceipt.modelTransport.credentialIsolation,
        toolNetworkMode: profileReceipt.toolSandbox.network,
        toolSandboxEnforcement: profileReceipt.toolSandbox.enforcement,
        toolSandboxFilePolicySha256: profileReceipt.toolSandbox.filePolicySha256,
        toolSandboxProfileSha256: profileReceipt.toolSandbox.sandboxProfileSha256,
        disabledInProcessRowsSha256: profileReceipt.toolSandbox.disabledInProcessRowsSha256,
        noTargetNetworkBypass: profileReceipt.noTargetNetworkBypass,
        projectPluginsLoaded: false,
        ambientCredentialsInherited: false,
        targetCredentialsInherited: false,
        modelCredentialNames,
      });
      result = await runCommand({
        cmd: [
          ...(runtimeBinding?.commandPrefix ?? [selectedCommand]),
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
        ...(progressWatchdog ? { progressMonitor: progressWatchdog.monitor } : {}),
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
        [...(profileReceipt ? [profileReceipt] : []), ...(runtimeBinding ? [runtimeBinding.receipt] : [])],
      );
    } finally {
      if (profileReceipt && modelTransport) profileReceipt.modelTransport = modelTransport.receipt();
      await modelTransport?.cleanup();
      if (isolatedProfile) {
        await rm(isolatedProfile.home, { recursive: true, force: true });
      }
      await processPolicy?.cleanup();
    }

    if (result.exitCode !== 0) {
      const progressReceipt = progressWatchdog?.receipt(result.terminationReason === "progress-stall" ? "stalled" : "completed");
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
        [
          ...(profileReceipt ? [profileReceipt] : []),
          ...(runtimeBinding ? [runtimeBinding.receipt] : []),
          ...(progressReceipt ? [progressReceipt] : []),
        ],
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
    const progressReceipt = progressWatchdog?.receipt("completed");
    return profileReceipt
      ? {
        ...output,
        artifacts: [
          ...(output.artifacts ?? []),
          profileReceipt,
          ...(runtimeBinding ? [runtimeBinding.receipt] : []),
          ...(progressReceipt ? [progressReceipt] : []),
        ],
      }
      : output;
  };
}

function createDshNoWriteProgressWatchdog(input: {
  cwd: string;
  filePolicy: NormalizedDshFilePolicy;
  policy: NonNullable<DshCliExecutorOptions["noWriteProgressPolicy"]>;
  requestCount(): number;
  recorder?: { event(payload: Record<string, unknown>): void };
}) {
  const { maxStallMs, minModelRequests, probeIntervalMs } = input.policy;
  const configuredBaselineFingerprint = input.policy.baselineFingerprint;
  const completionGraceMs = input.policy.completionGraceMs;
  if (!Number.isInteger(maxStallMs) || maxStallMs < 1
    || !Number.isInteger(minModelRequests) || minModelRequests < 0
    || !Number.isInteger(probeIntervalMs) || probeIntervalMs < 1
    || probeIntervalMs > maxStallMs
    || (configuredBaselineFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(configuredBaselineFingerprint))
    || (completionGraceMs !== undefined && (!Number.isInteger(completionGraceMs) || completionGraceMs < 1))) {
    throw new Error("DSH no-write progress policy is invalid");
  }
  let fingerprint = dshAllowedSurfaceFingerprint(input.cwd, input.filePolicy.allowedPaths);
  const baselineFingerprint = configuredBaselineFingerprint ?? fingerprint;
  let progressSatisfied = fingerprint !== baselineFingerprint;
  let firstProgressAtMs = progressSatisfied ? Date.now() : null;
  let lastProgressAtMs = Date.now();
  let lastProgressAt = new Date(lastProgressAtMs).toISOString();
  let lastEvaluation: Record<string, unknown> = {};
  const evaluate = () => {
    const nextFingerprint = dshAllowedSurfaceFingerprint(input.cwd, input.filePolicy.allowedPaths);
    const changed = nextFingerprint !== fingerprint;
    if (changed) {
      fingerprint = nextFingerprint;
      if (!progressSatisfied) firstProgressAtMs = Date.now();
      progressSatisfied = true;
      lastProgressAtMs = Date.now();
      lastProgressAt = new Date(lastProgressAtMs).toISOString();
    }
    const requestCount = input.requestCount();
    const stalledForMs = Math.max(0, Date.now() - lastProgressAtMs);
    const convergenceElapsedMs = firstProgressAtMs === null ? 0 : Math.max(0, Date.now() - firstProgressAtMs);
    const noWriteStalled = !progressSatisfied && requestCount >= minModelRequests && stalledForMs >= maxStallMs;
    const convergenceStalled = progressSatisfied
      && completionGraceMs !== undefined
      && convergenceElapsedMs >= completionGraceMs;
    const stalled = noWriteStalled || convergenceStalled;
    const code = convergenceStalled ? "dsh-convergence-timeout" : stalled ? "dsh-no-write-progress" : "dsh-progress-observed";
    lastEvaluation = {
      stalled,
      code,
      message: stalled
        ? convergenceStalled
          ? `dsh-convergence-timeout: candidate progress was observed but no terminal output arrived within ${convergenceElapsedMs}ms`
          : `dsh-no-write-progress: ${requestCount} model requests with no allowed-surface change for ${stalledForMs}ms`
        : undefined,
      requestCount,
      changed,
      progressSatisfied,
      currentFingerprint: fingerprint,
      baselineFingerprint,
      stalledForMs,
      convergenceElapsedMs,
    };
    input.recorder?.event({ type: "dsh.progress", ...lastEvaluation });
    return lastEvaluation as {
      stalled: boolean;
      code: string;
      message?: string;
      requestCount: number;
      changed: boolean;
    };
  };
  return {
    monitor: { intervalMs: probeIntervalMs, evaluate },
    receipt(status: DshProgressWatchdogReceipt["status"]): DshProgressWatchdogReceipt {
      const finalFingerprint = dshAllowedSurfaceFingerprint(input.cwd, input.filePolicy.allowedPaths);
      return {
        kind: "dsh_progress_watchdog_receipt",
        schemaVersion: 1,
        status,
        baselineFingerprint,
        finalFingerprint,
        progressSatisfied,
        lastProgressAt,
        requestCount: input.requestCount(),
        maxStallMs,
        minModelRequests,
        probeIntervalMs,
      };
    },
  };
}

function dshAllowedSurfaceFingerprint(cwd: string, allowedPaths: string[]) {
  const entries: string[] = [];
  const roots = [...new Set(allowedPaths.map((pattern) => {
    const segments = pattern.split("/");
    const wildcard = segments.findIndex((segment) => segment.includes("*"));
    const prefix = (wildcard === -1 ? segments : segments.slice(0, wildcard)).join("/");
    if (!prefix || prefix === ".") throw new Error(`DSH progress policy cannot fingerprint broad allowed path: ${pattern}`);
    const root = resolve(cwd, prefix);
    const rel = relative(cwd, root);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error(`DSH progress policy allowed path escapes the worktree: ${pattern}`);
    }
    return root;
  }))].sort();
  for (const root of roots) fingerprintDshPath(cwd, root, entries);
  return createHash("sha256").update(entries.sort().join("\n")).digest("hex");
}

function fingerprintDshPath(cwd: string, path: string, entries: string[]) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    entries.push(`${relative(cwd, path)}\0missing`);
    return;
  }
  const rel = relative(cwd, path);
  if (stat.isSymbolicLink()) {
    entries.push(`${rel}\0symlink\0${readlinkSync(path)}`);
    return;
  }
  if (stat.isDirectory()) {
    entries.push(`${rel}\0directory`);
    for (const name of readdirSync(path).sort()) fingerprintDshPath(cwd, join(path, name), entries);
    return;
  }
  if (stat.isFile()) {
    entries.push(`${rel}\0file\0${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
    return;
  }
  entries.push(`${rel}\0other`);
}

function freezeDshRuntimeBinding(receipt: Record<string, unknown>, worktreePath: string): FrozenDshRuntimeBinding {
  if (receipt.kind !== "local_dsh_installation_receipt" || receipt.schemaVersion !== 1) {
    throw new Error("DSH installation receipt schema is invalid");
  }
  let worktreeRealpath: string;
  try {
    if (!lstatSync(worktreePath).isDirectory()) throw new Error("not a directory");
    worktreeRealpath = realpathSync(worktreePath);
  } catch {
    throw new Error(`frozen task worktree does not exist or is not a real directory: ${worktreePath}`);
  }
  if (worktreeRealpath !== worktreePath) {
    throw new Error(`frozen task worktree realpath drifted: ${worktreePath}`);
  }
  const executablePath = stringReceiptField(receipt, "executablePath");
  const executableRealpath = stringReceiptField(receipt, "executableRealpath");
  const executableSha256 = stringReceiptField(receipt, "artifactSha256");
  const sourceRepoPath = stringReceiptField(receipt, "sourceRepoPath");
  const runtime = recordReceiptField(receipt, "runtime");
  const interpreterPath = stringReceiptField(runtime, "nodePath");
  const interpreterSha256 = stringReceiptField(runtime, "nodeSha256");
  const runtimeRoots = [realpathSync(sourceRepoPath)];
  const verify = () => {
    if (realpathSync(executablePath) !== executableRealpath || !statSync(executableRealpath).isFile()) {
      throw new Error("DSH executable realpath drifted from the frozen runtime binding");
    }
    accessSync(executablePath, constants.X_OK);
    accessSync(interpreterPath, constants.X_OK);
    if (!statSync(interpreterPath).isFile()) throw new Error("DSH interpreter is not a regular file");
    if (fileSha256(executableRealpath) !== executableSha256) throw new Error("DSH executable hash drifted from the frozen runtime binding");
    if (fileSha256(interpreterPath) !== interpreterSha256) throw new Error("DSH interpreter hash drifted from the frozen runtime binding");
  };
  verify();
  const body = {
    executablePath,
    executableRealpath,
    executableSha256,
    interpreterPath,
    interpreterSha256,
    runtimeRoots,
    worktreePath: worktreeRealpath,
  };
  return {
    commandPrefix: [interpreterPath, executableRealpath],
    verify,
    receipt: {
      kind: "dsh_runtime_binding_receipt",
      schemaVersion: 1,
      status: "passed",
      ...body,
      readExecBindingSha256: sha256Text(JSON.stringify(body)),
      finalSpawnSandboxSha256: "0".repeat(64),
    },
  };
}

function blockedDshRuntimeBindingReceipt(receipt: Record<string, unknown>, worktreePath: string): DshRuntimeBindingReceipt {
  const runtime = receipt.runtime && typeof receipt.runtime === "object" && !Array.isArray(receipt.runtime)
    ? receipt.runtime as Record<string, unknown>
    : {};
  const executablePath = typeof receipt.executablePath === "string" ? receipt.executablePath : "unavailable";
  const executableRealpath = typeof receipt.executableRealpath === "string" ? receipt.executableRealpath : "unavailable";
  const executableSha256 = typeof receipt.artifactSha256 === "string" ? receipt.artifactSha256 : "0".repeat(64);
  const interpreterPath = typeof runtime.nodePath === "string" ? runtime.nodePath : "unavailable";
  const interpreterSha256 = typeof runtime.nodeSha256 === "string" ? runtime.nodeSha256 : "0".repeat(64);
  return {
    kind: "dsh_runtime_binding_receipt",
    schemaVersion: 1,
    status: "blocked",
    diagnosticCode: "runtime-binding-denied",
    executablePath,
    executableRealpath,
    executableSha256,
    interpreterPath,
    interpreterSha256,
    runtimeRoots: typeof receipt.sourceRepoPath === "string" ? [receipt.sourceRepoPath] : [],
    worktreePath,
    readExecBindingSha256: "0".repeat(64),
    finalSpawnSandboxSha256: "0".repeat(64),
  };
}

function recordReceiptField(value: Record<string, unknown>, field: string) {
  const candidate = value[field];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`DSH installation receipt ${field} is invalid`);
  return candidate as Record<string, unknown>;
}

function stringReceiptField(value: Record<string, unknown>, field: string) {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) throw new Error(`DSH installation receipt ${field} is invalid`);
  return candidate;
}

function fileSha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function dshProcessEnvironment(
  configured: Record<string, string | undefined> | undefined,
  isolatedHome: string,
  sandbox: string,
  modelTransport: DshModelTransportBroker,
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
    DEEPSEEK_API_KEY: modelTransport.clientApiKey,
    DEEPSEEK_BASE_URL: modelTransport.baseUrl,
    DSH_TELEMETRY_DISABLED: "1",
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
  if (key === "DEEPSEEK_API_KEY" || key === "DEEPSEEK_BASE_URL") return false;
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
