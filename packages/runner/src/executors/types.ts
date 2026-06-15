import type { TaskExecutor } from "../types";

export type ApprovalMode = "approve-all" | "approve-reads" | "deny-all";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandInput {
  cmd: string[];
  stdin: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export type RunCommand = (input: RunCommandInput) => Promise<CommandResult>;

export interface AcpxCodexExecutorOptions {
  cwd: string;
  approval?: ApprovalMode;
  model?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  runCommand?: RunCommand;
}

export interface AcpxCodexExecutorFactory {
  (options: AcpxCodexExecutorOptions): TaskExecutor;
}

export type AcpxBuiltInAgent = "codex" | "claude" | "opencode" | "openclaw";

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
  codexBin?: string;
  model?: string;
  outputDir?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  runCommand?: RunCommand;
}
