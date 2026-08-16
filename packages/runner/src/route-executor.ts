import { createAcpxAgentExecutor } from "./executors/acpx";
import { createCodexCliExecutor } from "./executors/codex-cli";
import { createDshCliExecutor } from "./executors/dsh-cli";
import type { ApprovalMode, AttemptReplayCache, BrowserProcessPolicy, CodexSandbox, DshFilePolicy, RunCommand, WorktreeEvidenceProbe } from "./executors/types";
import type { DshCommandResolver } from "./dsh-readiness";
import type { ResolvedAgentBackend } from "./agent-backends";
import type { ResolvedExecutionRoute } from "./execution-routing";
import type { TaskExecutor } from "./types";
import { parseVerifierExecutionEnvironment } from "./verifier-execution-environment";

export interface RouteExecutorOptions {
  cwd: string;
  route: ResolvedExecutionRoute;
  approval?: ApprovalMode;
  browserProcessPolicy?: BrowserProcessPolicy;
  sandbox?: CodexSandbox;
  codexBin?: string;
  outputDir?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  runCommand?: RunCommand;
  resolveDshCommand?: DshCommandResolver;
  replayCache?: AttemptReplayCache;
  worktreeEvidence?: WorktreeEvidenceProbe;
  hostExecutionCapabilities?: unknown;
  taskRole?: string;
  verifierContract?: unknown;
  dshProfileIsolation?: "base-headless";
  dshRequiredPlugins?: string[];
  dshFilePolicy?: DshFilePolicy;
}

export function createRouteExecutor(options: RouteExecutorOptions): TaskExecutor {
  const backend = options.route.backend;
  let verifierExecutionEnvironment;
  try {
    verifierExecutionEnvironment = parseVerifierExecutionEnvironment(options.verifierContract, options.taskRole ?? options.route.role);
  } catch (error) {
    return unsupportedVerifierEnvironmentOutput(error instanceof Error ? error.message : String(error), backend.kind);
  }
  if (verifierExecutionEnvironment && backend.kind !== "codex-cli" && backend.kind !== "codex-resumable") {
    return unsupportedVerifierEnvironmentOutput(
      `backend ${backend.kind} cannot enforce the frozen verifier execution environment`,
      backend.kind,
    );
  }
  if (backend.kind === "noop") {
    return async ({ task }) => ({
      status: "done" as const,
      summary: `Noop executor completed ${task.id}`,
      changedFiles: [],
      checks: [{ name: "noop executor", status: "passed" as const }],
      artifacts: [],
      problems: [],
    });
  }
  if (backend.kind === "acpx") {
    if (options.hostExecutionCapabilities !== undefined) {
      return async () => ({
        status: "blocked" as const,
        summary: "host execution capabilities require the direct Codex executor",
        changedFiles: [],
        checks: [{ name: "host execution capability route", status: "failed" as const }],
        artifacts: [{ kind: "host_execution_capability_route", backend: "acpx", supported: false }],
        problems: ["ACPX cannot carry the frozen host execution capability contract"],
      });
    }
    return createAcpxAgentExecutor({
      cwd: options.cwd,
      ...acpxAgentConfig(backend),
      approval: backend.approval ?? options.approval ?? "approve-reads",
      browserProcessPolicy: options.browserProcessPolicy,
      format: backend.format,
      model: options.route.model?.model,
      env: backend.env,
      timeoutMs: options.timeoutMs,
      idleTimeoutMs: options.idleTimeoutMs,
      runCommand: options.runCommand,
      replayCache: options.replayCache,
      worktreeEvidence: options.worktreeEvidence,
    });
  }
  if (backend.kind === "codex-resumable") {
    throw new Error("codex-resumable routes must use the resumable client path");
  }
  if (backend.kind === "dsh-cli") {
    return createDshCliExecutor({
      cwd: options.cwd,
      command: backend.command,
      profile: backend.profile,
      sandbox: options.sandbox ?? "read-only",
      env: backend.env,
      timeoutMs: options.timeoutMs,
      idleTimeoutMs: options.idleTimeoutMs,
      runCommand: options.runCommand,
      resolveCommand: options.resolveDshCommand,
      hostExecutionCapabilities: options.hostExecutionCapabilities,
      isolatedProfile: options.dshProfileIsolation ?? "base-headless",
      requiredPlugins: options.dshRequiredPlugins,
      filePolicy: options.dshFilePolicy,
    });
  }
  return createCodexCliExecutor({
    cwd: options.cwd,
    sandbox: options.sandbox ?? "read-only",
    browserProcessPolicy: options.browserProcessPolicy,
    codexBin: options.codexBin,
    model: options.route.model?.model,
    reasoningEffort: options.route.model?.reasoning_effort,
    outputDir: options.outputDir,
    timeoutMs: options.timeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
    runCommand: options.runCommand,
    hostExecutionCapabilities: options.hostExecutionCapabilities,
    taskRole: options.taskRole ?? options.route.role,
    verifierContract: options.verifierContract,
  });
}

function unsupportedVerifierEnvironmentOutput(problem: string, backend: string): TaskExecutor {
  return async () => ({
    status: "blocked" as const,
    summary: "Verifier execution environment is unsupported by the selected backend",
    changedFiles: [],
    checks: [{ name: "verifier execution environment route", status: "failed" as const, evidence: problem }],
    artifacts: [{ kind: "verifier_execution_environment_route", backend, supported: false }],
    problems: [problem],
  });
}

function acpxAgentConfig(backend: ResolvedAgentBackend) {
  if (backend.agentCommand) {
    return { agentCommand: backend.agentCommand };
  }
  return { agent: backend.agent ?? "codex" };
}
