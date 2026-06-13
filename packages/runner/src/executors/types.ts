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
}

export type RunCommand = (input: RunCommandInput) => Promise<CommandResult>;

export interface AcpxCodexExecutorOptions {
  cwd: string;
  approval?: ApprovalMode;
  timeoutMs?: number;
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
  timeoutMs?: number;
  runCommand?: RunCommand;
}
