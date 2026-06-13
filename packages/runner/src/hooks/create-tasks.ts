import type { Harness, PlannedTask } from "@ouroboros/harness";
import type { StopHook } from "../types";

export function createTasksFromOutputHook(options: { harness: Harness }): StopHook {
  return ({ run, task, output }) => {
    const created = (output.nextTasks ?? []).map((plannedTask) => {
      const taskId = options.harness.createTask({
        runId: run.id,
        role: requiredString(plannedTask, "role"),
        goal: requiredString(plannedTask, "goal"),
        prompt: requiredString(plannedTask, "prompt"),
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

function requiredString(task: PlannedTask, key: "role" | "goal" | "prompt") {
  const value = task[key];
  if (!value || typeof value !== "string") {
    throw new Error(`planned task is missing ${key}`);
  }
  return value;
}
