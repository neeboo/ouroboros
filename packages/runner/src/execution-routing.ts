import type { Run, Task } from "@ouroboros/harness";
import { resolveAgentBackend, type ResolvedAgentBackend } from "./agent-backends";
import { resolveModelPreference, type ResolvedModelPreference } from "./model-preferences";

export type ExecutionRouteMode = "codex-resumable" | "generic";

export interface ResolvedExecutionRoute {
  role: string;
  backend: ResolvedAgentBackend;
  model: ResolvedModelPreference | null;
  executionMode: ExecutionRouteMode;
}

export function resolveExecutionRoute(input: {
  run: Run;
  task: Task;
  cliAgentBackend?: string | null;
  cliExecutor?: string | null;
  globalModel?: string | null;
}): ResolvedExecutionRoute {
  const backend = resolveAgentBackend({
    run: input.run,
    task: input.task,
    cliAgentBackend: input.cliAgentBackend,
    cliExecutor: input.cliExecutor,
  });
  const model = resolveModelPreference({
    run: input.run,
    task: input.task,
    globalModel: input.globalModel,
  });
  return {
    role: input.task.role,
    backend,
    model: modelForBackend(backend, model),
    executionMode: backend.kind === "codex-resumable" ? "codex-resumable" : "generic",
  };
}

function modelForBackend(backend: ResolvedAgentBackend, model: ResolvedModelPreference | null) {
  if (!model) {
    return null;
  }
  if (backend.kind === "acpx" && backend.agent === "claude" && model.source !== "task") {
    return null;
  }
  return model;
}
