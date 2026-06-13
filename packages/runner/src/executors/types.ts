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
}

export type RunCommand = (input: RunCommandInput) => Promise<CommandResult>;

export interface AcpxCodexExecutorOptions {
  cwd: string;
  approval?: ApprovalMode;
  runCommand?: RunCommand;
}

export interface AcpxCodexExecutorFactory {
  (options: AcpxCodexExecutorOptions): TaskExecutor;
}
