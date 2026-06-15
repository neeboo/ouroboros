import { type Harness } from "@ouroboros/harness";
import { validatePlannedRuns } from "../executors/output";
import type { StopHook } from "../types";

export function createRunsFromOutputHook(options: { harness: Harness }): StopHook {
  return ({ run, task, output }) => {
    if (output.status !== "done") {
      return { decision: "exit" };
    }

    const plannedRuns = validatePlannedRuns(output.nextRuns);
    const created = plannedRuns.map((plannedRun) => {
      const childRunId = options.harness.createRun({
        goal: plannedRun.goal,
        context: {
          ...(plannedRun.context ?? {}),
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
