import { createAcpxAgentExecutor } from "./executors/acpx";
import { createCodexCliExecutor } from "./executors/codex-cli";
import type { ApprovalMode, CodexSandbox, RunCommand } from "./executors/types";
import type { ResolvedAgentBackend } from "./agent-backends";
import type { ResolvedExecutionRoute } from "./execution-routing";
import type { TaskExecutor } from "./types";

export interface RouteExecutorOptions {
  cwd: string;
  route: ResolvedExecutionRoute;
  approval?: ApprovalMode;
  sandbox?: CodexSandbox;
  codexBin?: string;
  outputDir?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  runCommand?: RunCommand;
}

export function createRouteExecutor(options: RouteExecutorOptions): TaskExecutor {
  const backend = options.route.backend;
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
    return createAcpxAgentExecutor({
      cwd: options.cwd,
      ...acpxAgentConfig(backend),
      approval: backend.approval ?? options.approval ?? "approve-reads",
      model: options.route.model?.model,
      env: backend.env,
      timeoutMs: options.timeoutMs,
      idleTimeoutMs: options.idleTimeoutMs,
      runCommand: options.runCommand,
    });
  }
  if (backend.kind === "codex-resumable") {
    throw new Error("codex-resumable routes must use the resumable client path");
  }
  return createCodexCliExecutor({
    cwd: options.cwd,
    sandbox: options.sandbox ?? "read-only",
    codexBin: options.codexBin,
    model: options.route.model?.model,
    outputDir: options.outputDir,
    timeoutMs: options.timeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
    runCommand: options.runCommand,
  });
}

function acpxAgentConfig(backend: ResolvedAgentBackend) {
  if (backend.agentCommand) {
    return { agentCommand: backend.agentCommand };
  }
  return { agent: backend.agent ?? "codex" };
}
