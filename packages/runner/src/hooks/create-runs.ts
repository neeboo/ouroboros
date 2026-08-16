import { type Harness } from "@ouroboros/harness";
import { validatePlannedRuns } from "../executors/output";
import type { StopHook } from "../types";

export function createRunsFromOutputHook(options: { harness: Harness }): StopHook {
  return ({ run, task, output }) => {
    if (output.status !== "done") {
      return { decision: "exit" };
    }

    const plannedRuns = validatePlannedRuns(output.nextRuns);
    if (task.config?.forbidNextRuns === true && plannedRuns.length > 0) {
      return {
        decision: "exit",
        checks: [{
          name: "frozen Designer run boundary",
          status: "failed",
          evidence: `task ${task.id} forbids nextRuns`,
        }],
        artifacts: [{
          kind: "forbidden_next_runs",
          runId: run.id,
          taskId: task.id,
          requestedCount: plannedRuns.length,
        }],
        problems: [`task ${task.id} forbids nextRuns; use the governed design action path or return quiescent`],
      };
    }
    const created = plannedRuns.map((plannedRun) => {
      const childRunId = options.harness.createRun({
        goal: plannedRun.goal,
        context: {
          ...(plannedRun.context ?? {}),
          ...inheritedControlContext(run.context),
          parentRunId: run.id,
          sourceTaskId: task.id,
          source: "nextRuns",
        },
      });
      const plannerTaskId = options.harness.createTask({
        runId: childRunId,
        role: "planner",
        goal: `Plan run: ${plannedRun.goal}`,
        prompt: plannedRun.prompt,
        doneWhen: plannedRun.doneWhen ?? [
          "Planner returns a small nextTasks graph for this run",
          "Every generated task has clear evidence and verification criteria",
          "The run can be drained by the supervisor without manual task injection",
        ],
        config: plannedRun.modelPreference ? { modelPreference: plannedRun.modelPreference } : {},
      });
      return {
        kind: "created_run",
        runId: childRunId,
        plannerTaskId,
        sourceRunId: run.id,
        sourceTaskId: task.id,
      };
    });

    return {
      decision: created.length > 0 ? "continue" : "exit",
      artifacts: created,
    };
  };
}

function inheritedControlContext(context: Record<string, unknown>) {
  return Object.fromEntries(
    ["modelDefaults", "agentDefaults", "agentBackends", "guardrails", "controlPlaneRuntime"]
      .filter((key) => context[key] !== undefined)
      .map((key) => [key, context[key]]),
  );
}
