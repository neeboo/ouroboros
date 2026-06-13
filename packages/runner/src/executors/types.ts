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
  timeoutMs?: number;
  idleTimeoutMs?: number;
  runCommand?: RunCommand;
}

export interface AcpxCodexExecutorFactory {
  (options: AcpxCodexExecutorOptions): TaskExecutor;
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
