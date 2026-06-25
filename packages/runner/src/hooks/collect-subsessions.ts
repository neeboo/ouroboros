import type { ExecutionThread, ExecutionThreadStatusFilter, Harness, SubsessionRunner } from "@ouroboros/harness";
import type { StopHook, StopHookResult } from "../types";

export interface CollectSubsessionsHookOptions {
  harness: Harness;
  subsessionRunner?: SubsessionRunner;
  maxChildren?: number;
}

export function createCollectSubsessionsHook(options: CollectSubsessionsHookOptions): StopHook {
  const maxChildren = options.maxChildren ?? 8;
  return async (input) => collectSubsessionsAtStop(input, options.harness, options.subsessionRunner, maxChildren);
}

async function collectSubsessionsAtStop(
  input: Parameters<StopHook>[0],
  harness: Harness,
  runner: SubsessionRunner | undefined,
  maxChildren: number,
): Promise<StopHookResult> {
  const threads = harness.listExecutionThreads({ runId: input.run.id });
  const children = threads
    .filter((thread) => thread.ownerType === "subsession" && thread.taskId === input.task.id)
    .slice(0, maxChildren);
  if (children.length === 0) {
    return { decision: "exit", checks: [], artifacts: [] };
  }

  const orphaned = children.filter((child) => child.status === "running");
  const checks: StopHookResult["checks"] = [
    { name: "subsession children", status: "passed", evidence: String(children.length) },
  ];
  const artifacts: StopHookResult["artifacts"] = [];
  const problems: StopHookResult["problems"] = [];

  if (runner) {
    try {
      const results = runner.collect(
        children.map((child) => ({
          threadId: child.id,
          sessionName: child.sessionName,
          agentSessionId: child.agentSessionId,
          backend: {
            id: child.role || "subsession",
            kind: "noop",
          },
          worktreePath: child.worktreePath ?? input.run.projectRoot ?? "",
        })),
      );
      for (const result of results) {
        harness.updateExecutionThread({
          id: result.threadId,
          status: result.status as ExecutionThreadStatusFilter,
          agentSessionId: result.agentSessionId ?? null,
          heartbeat: true,
        });
        artifacts.push({
          kind: "subsession_summary",
          threadId: result.threadId,
          status: result.status,
          summary: result.summary,
          collectedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      problems.push(`subsession collect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    for (const child of children) {
      artifacts.push({
        kind: "subsession_summary",
        threadId: child.id,
        status: child.status,
        summary: child.interruptReason ?? `thread ${child.status}`,
        collectedAt: new Date().toISOString(),
      });
    }
  }

  for (const child of orphaned) {
    if (!runner) {
      harness.updateExecutionThread({
        id: child.id,
        status: "orphaned",
        interruptReason: `parent task ${input.task.id} attempt ended`,
        heartbeat: true,
      });
    }
    problems.push(`subsession ${child.id} was still running when the parent attempt ended`);
  }

  return {
    decision: "exit",
    checks,
    artifacts,
    problems,
  };
}

export type { ExecutionThread };
