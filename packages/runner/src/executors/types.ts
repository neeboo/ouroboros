import type { AttemptOutput } from "@ouroboros/harness";
import type { TaskExecutor } from "../types";

export type ApprovalMode = "approve-all" | "approve-reads" | "deny-all";
export type BrowserProcessPolicy = "allow" | "deny";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandInput {
  cmd: string[];
  stdin: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  cleanupOnFailure?: boolean;
  cleanupProcessTree?: (pid: number) => void | Promise<void>;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export type RunCommand = (input: RunCommandInput) => Promise<CommandResult>;

export interface AttemptReplayCache {
  reserveInitialRequest(attemptId: string): boolean;
  reserveRecoveryRequest(attemptId: string): boolean;
  getTerminalResult(attemptId: string): AttemptOutput | undefined;
  recordTerminalResult(attemptId: string, output: AttemptOutput): void;
}

export interface WorktreeEvidenceProbe {
  (input: { cwd: string; worktreePath?: string | null }): Promise<{
    changedFiles: string[];
    summary: string;
  }>;
}

export interface AcpxCodexExecutorOptions {
  cwd: string;
  approval?: ApprovalMode;
  browserProcessPolicy?: BrowserProcessPolicy;
  model?: string;
  format?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  runCommand?: RunCommand;
  replayCache?: AttemptReplayCache;
  worktreeEvidence?: WorktreeEvidenceProbe;
}

export interface AcpxCodexExecutorFactory {
  (options: AcpxCodexExecutorOptions): TaskExecutor;
}

export type AcpxBuiltInAgent = "codex" | "claude";

export type AcpxAgentExecutorOptions = AcpxCodexExecutorOptions &
  (
    | {
        agent: AcpxBuiltInAgent;
        agentCommand?: never;
      }
    | {
        agent?: never;
        agentCommand: string;
      }
  );

export interface AcpxAgentExecutorFactory {
  (options: AcpxAgentExecutorOptions): TaskExecutor;
}

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexCliExecutorOptions {
  cwd: string;
  sandbox?: CodexSandbox;
  browserProcessPolicy?: BrowserProcessPolicy;
  codexBin?: string;
  model?: string;
  reasoningEffort?: string;
  outputDir?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  runCommand?: RunCommand;
}
