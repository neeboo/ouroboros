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
  return {
    role: input.task.role,
    backend,
    model: resolveModelPreference({
      run: input.run,
      task: input.task,
      globalModel: input.globalModel,
    }),
    executionMode: backend.kind === "codex-resumable" ? "codex-resumable" : "generic",
  };
}
