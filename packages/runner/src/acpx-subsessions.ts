import type {
  ExecutionThreadStatusFilter,
  ResolvedSubsessionBackend,
  SubsessionRunner,
  SubsessionRunnerCancelChild,
  SubsessionRunnerCancelResult,
  SubsessionRunnerCollectChild,
  SubsessionRunnerCollectResult,
  SubsessionRunnerStartInput,
  SubsessionRunnerStartResult,
} from "@ouroboros/harness";
export type {
  ExecutionThreadStatusFilter,
  ResolvedSubsessionBackend,
  SubsessionRunner,
  SubsessionRunnerCancelChild,
  SubsessionRunnerCancelResult,
  SubsessionRunnerCollectChild,
  SubsessionRunnerCollectResult,
  SubsessionRunnerStartInput,
  SubsessionRunnerStartResult,
};

import { runLocalCommand } from "./executors/command";
import type { ApprovalMode, RunCommand } from "./executors/types";

export interface AcpxSubsessionRunnerOptions {
  runCommand?: RunCommand;
  spawn?: (input: AcpxSubsessionSpawnInput) => AcpxSubsessionSpawnResult;
  runSync?: (input: AcpxSubsessionSpawnInput) => CommandResult;
  prepareHermesHome?: (input: { cwd: string; sessionName: string; sourceHome: string }) => Promise<string | null>;
  env?: Record<string, string | undefined>;
}

export interface AcpxSubsessionSpawnInput {
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
}

export interface AcpxSubsessionSpawnResult {
  pid: number | null;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const SUBSESSION_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const SUBSESSION_DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export function createAcpxSubsessionRunner(options: AcpxSubsessionRunnerOptions = {}): SubsessionRunner {
  const runCommand = options.runCommand ?? runLocalCommand;
  const spawner = options.spawn ?? defaultAcpxSpawn;
  const runSync = options.runSync ?? defaultRunSync;

  return {
    start(input) {
      return startAcpxSubsession(input, runCommand, spawner, options);
    },
    collect(children) {
      return collectAcpxSubsessions(children, runSync, options);
    },
    cancel(children, reason) {
      return cancelAcpxSubsessions(children, reason, runSync, options);
    },
  };
}

function startAcpxSubsession(
  input: SubsessionRunnerStartInput,
  runCommand: RunCommand,
  spawn: (input: AcpxSubsessionSpawnInput) => AcpxSubsessionSpawnResult,
  options: AcpxSubsessionRunnerOptions,
): SubsessionRunnerStartResult {
  const base = acpxSubsessionBaseCommand(input.backend, input.worktreePath);
  if (input.backend.kind !== "acpx") {
    return {
      threadId: input.threadId,
      sessionName: input.sessionName,
      agentSessionId: input.sessionName,
      status: "blocked",
      message: `acpx subsession runner cannot start backend kind ${input.backend.kind}`,
    };
  }
  void ensureAcpxSession({
    base,
    runCommand,
    env: buildEnv(options.env),
    sessionName: input.sessionName,
    timeoutMs: input.timeoutMs,
    idleTimeoutMs: input.idleTimeoutMs,
  }).then((ensureResult) => {
    if (ensureResult !== null) {
      return;
    }
    const promptCmd = buildAcpxPromptCommand(base, input.sessionName);
    spawn({
      cmd: promptCmd,
      cwd: input.worktreePath,
      env: buildEnv(options.env),
      stdin: input.prompt,
      timeoutMs: input.timeoutMs,
      idleTimeoutMs: input.idleTimeoutMs,
    });
  });

  return {
    threadId: input.threadId,
    sessionName: input.sessionName,
    agentSessionId: input.sessionName,
    status: "running",
    pid: null,
    message: `acpx subsession ${input.sessionName} queued`,
  };
}

function collectAcpxSubsessions(
  children: SubsessionRunnerCollectChild[],
  runCommand: (input: AcpxSubsessionSpawnInput) => CommandResult,
  options: AcpxSubsessionRunnerOptions,
): SubsessionRunnerCollectResult[] {
  const results: SubsessionRunnerCollectResult[] = [];
  for (const child of children) {
    if (child.backend.kind !== "acpx") {
      results.push({
        threadId: child.threadId,
        status: "done",
        summary: `backend ${child.backend.id} is not an acpx backend; no acpx summary available`,
        agentSessionId: child.agentSessionId,
      });
      continue;
    }
    const base = acpxSubsessionBaseCommand(child.backend, child.worktreePath);
    const sessionName = child.sessionName ?? child.agentSessionId;
    if (!sessionName) {
      results.push({
        threadId: child.threadId,
        status: "blocked",
        summary: "subsession has no resolvable session name",
      });
      continue;
    }
    const result = runLocalCommandSync(
      runCommand,
      [...base, "sessions", "show", sessionName],
      buildEnv(options.env),
      child.worktreePath,
    );
    if (result.exitCode === 0) {
      results.push({
        threadId: child.threadId,
        status: classifyAcpxShowStatus(result.stdout),
        summary: truncateOutput(result.stdout) || `acpx session ${sessionName} still active`,
        agentSessionId: sessionName,
      });
    } else {
      results.push({
        threadId: child.threadId,
        status: "blocked",
        summary: truncateOutput(result.stderr || result.stdout) || `acpx sessions show failed for ${sessionName}`,
        agentSessionId: sessionName,
      });
    }
  }
  return results;
}

function cancelAcpxSubsessions(
  children: SubsessionRunnerCancelChild[],
  reason: string,
  runCommand: (input: AcpxSubsessionSpawnInput) => CommandResult,
  options: AcpxSubsessionRunnerOptions,
): SubsessionRunnerCancelResult[] {
  const results: SubsessionRunnerCancelResult[] = [];
  for (const child of children) {
    if (child.backend.kind !== "acpx") {
      results.push({
        threadId: child.threadId,
        canceled: false,
        message: `backend ${child.backend.id} has no acpx cancel path`,
      });
      continue;
    }
    const base = acpxSubsessionBaseCommand(child.backend, child.worktreePath);
    const sessionName = child.sessionName ?? child.agentSessionId;
    if (!sessionName) {
      results.push({
        threadId: child.threadId,
        canceled: false,
        message: "subsession has no resolvable session name",
      });
      continue;
    }
    const result = runLocalCommandSync(
      runCommand,
      [...base, "sessions", "close", sessionName],
      buildEnv(options.env),
      child.worktreePath,
    );
    results.push({
      threadId: child.threadId,
      canceled: result.exitCode === 0,
      message:
        result.exitCode === 0
          ? `closed session ${sessionName}: ${reason}`
          : truncateOutput(result.stderr || result.stdout) || `acpx sessions close failed for ${sessionName}`,
    });
  }
  return results;
}

export function acpxSubsessionBaseCommand(backend: ResolvedSubsessionBackend, cwd: string): string[] {
  if (backend.kind !== "acpx") {
    return ["acpx", "--cwd", cwd];
  }
  const approval = approvalFromBackend(backend);
  const agentArgs = backend.agentCommand
    ? ["--agent", backend.agentCommand]
    : backend.agent
      ? [backend.agent]
      : ["codex"];
  const format = backend.format ?? "text";
  return ["acpx", "--cwd", cwd, `--${approval}`, "--format", format, ...agentArgs];
}

export function buildAcpxPromptCommand(base: string[], sessionName: string): string[] {
  return [...base, "-s", sessionName];
}

function approvalFromBackend(backend: ResolvedSubsessionBackend): ApprovalMode {
  const value = backend.approval;
  if (value === "approve-all" || value === "approve-reads" || value === "deny-all") {
    return value;
  }
  return "approve-reads";
}

function buildEnv(env: Record<string, string | undefined> | undefined): Record<string, string | undefined> {
  return { ...(env ?? {}) };
}

async function ensureAcpxSession(input: {
  base: string[];
  runCommand: RunCommand;
  env: Record<string, string | undefined>;
  sessionName: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
}): Promise<null | { summary: string }> {
  const show = await input.runCommand({
    cmd: [...input.base, "sessions", "show", input.sessionName],
    stdin: "",
    env: input.env,
    timeoutMs: input.timeoutMs,
    idleTimeoutMs: input.idleTimeoutMs,
  });
  if (show.exitCode !== 0) {
    const created = await input.runCommand({
      cmd: [...input.base, "sessions", "new", "--name", input.sessionName],
      stdin: "",
      env: input.env,
      timeoutMs: input.timeoutMs,
      idleTimeoutMs: input.idleTimeoutMs,
    });
    if (created.exitCode !== 0) {
      return { summary: `failed to create session ${input.sessionName}: ${truncateOutput(created.stderr || created.stdout)}` };
    }
  }
  return null;
}

function runLocalCommandSync(
  runCommand: (input: AcpxSubsessionSpawnInput) => CommandResult,
  cmd: string[],
  env: Record<string, string | undefined>,
  cwd: string,
): { exitCode: number; stdout: string; stderr: string } {
  return runCommand({ cmd, cwd, env, stdin: "", timeoutMs: 5_000, idleTimeoutMs: 5_000 });
}

function defaultRunSync(input: AcpxSubsessionSpawnInput): CommandResult {
  const result = Bun.spawnSync(input.cmd, {
    cwd: input.cwd,
    env: input.env as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: input.timeoutMs ?? 5_000,
  });
  return {
    exitCode: result.exitCode ?? 0,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
  };
}

function decode(value: Uint8Array | ArrayBuffer | string | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return new TextDecoder().decode(value);
}

function defaultAcpxSpawn(input: AcpxSubsessionSpawnInput): AcpxSubsessionSpawnResult {
  try {
    const proc = Bun.spawn({
      cmd: input.cmd,
      cwd: input.cwd,
      env: input.env as Record<string, string>,
      stdin: "pipe",
      stdout: "inherit",
      stderr: "inherit",
      detached: true,
    });
    void proc.exited.then(() => undefined, () => undefined);
    if (proc.stdin) {
      try {
        proc.stdin.write(input.stdin);
        proc.stdin.end();
      } catch {
        // ignore - process may have exited before stdin was writable
      }
    }
    return { pid: proc.pid ?? null };
  } catch (error) {
    return { pid: null };
  }
}

function classifyAcpxShowStatus(stdout: string): ExecutionThreadStatusFilter {
  const text = stdout.toLowerCase();
  if (text.includes("status: done") || text.includes('"status":"done"')) {
    return "done";
  }
  if (text.includes("status: blocked") || text.includes('"status":"blocked"')) {
    return "blocked";
  }
  if (text.includes("status: interrupted") || text.includes('"status":"interrupted"')) {
    return "interrupted";
  }
  if (text.includes("status: orphaned") || text.includes('"status":"orphaned"')) {
    return "orphaned";
  }
  return "running";
}

function truncateOutput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 240) {
    return trimmed;
  }
  return `${trimmed.slice(0, 239)}…`;
}
