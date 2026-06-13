import type { Harness } from "@ouroboros/harness";
import { validatePlannedTasks } from "../executors/output";
import type { StopHook } from "../types";

export function createTasksFromOutputHook(options: { harness: Harness }): StopHook {
  return ({ run, task, output }) => {
    const created = validatePlannedTasks(output.nextTasks).map((plannedTask) => {
      const taskId = options.harness.createTask({
        runId: run.id,
        role: plannedTask.role,
        goal: plannedTask.goal,
        prompt: plannedTask.prompt,
        dependsOn: plannedTask.dependsOn ?? [task.id],
        doneWhen: plannedTask.doneWhen ?? [],
      });
      return {
        kind: "created_task",
        taskId,
        sourceTaskId: task.id,
      };
    });

    return {
      decision: "exit",
      artifacts: created,
    };
  };
}
