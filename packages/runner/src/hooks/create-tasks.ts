import { makeId, type Harness, type PlannedTask, type Task } from "@ouroboros/harness";
import { validatePlannedTasks } from "../executors/output";
import type { StopHook } from "../types";

export function createTasksFromOutputHook(options: { harness: Harness }): StopHook {
  return ({ run, task, output }) => {
    if (output.status !== "done") {
      return { decision: "exit" };
    }

    const plannedTasks = validatePlannedTasks(output.nextTasks);
    const plannedEntries = plannedTasks.map((plannedTask) => ({
      id: makeId("task"),
      plannedTask,
    }));
    const resolved = resolvePlannedDependencies({
      harness: options.harness,
      runId: run.id,
      sourceTask: task,
      plannedEntries,
    });

    if (resolved.problems.length > 0) {
      return {
        decision: "exit",
        problems: resolved.problems,
      };
    }

    const created = plannedEntries.map(({ id, plannedTask }, index) => {
      const taskId = options.harness.createTask({
        id,
        runId: run.id,
        role: plannedTask.role,
        goal: plannedTask.goal,
        prompt: plannedTask.prompt,
        dependsOn: resolved.dependsOnByIndex[index] ?? [task.id],
        doneWhen: plannedTask.doneWhen ?? [],
        config: plannedTask.modelPreference ? { modelPreference: plannedTask.modelPreference } : {},
      });
      return {
        kind: "created_task",
        taskId,
        sourceTaskId: task.id,
      };
    });

    return {
      decision: created.length > 0 ? "continue" : "exit",
      artifacts: created,
    };
  };
}

function resolvePlannedDependencies(input: {
  harness: Harness;
  runId: string;
  sourceTask: Task;
  plannedEntries: Array<{ id: string; plannedTask: PlannedTask }>;
}) {
  const labels = new Map<string, string>();
  const ambiguous = new Set<string>();
  const addLabel = (label: string | undefined, id: string) => {
    const normalized = label?.trim();
    if (!normalized) {
      return;
    }
    const existing = labels.get(normalized);
    if (existing && existing !== id) {
      ambiguous.add(normalized);
      labels.delete(normalized);
      return;
    }
    if (!ambiguous.has(normalized)) {
      labels.set(normalized, id);
    }
  };

  addLabel(input.sourceTask.id, input.sourceTask.id);
  addLabel(input.sourceTask.goal, input.sourceTask.id);
  for (const entry of input.plannedEntries) {
    addLabel(entry.id, entry.id);
    addLabel(entry.plannedTask.goal, entry.id);
  }

  const problems: string[] = [];
  const dependsOnByIndex = input.plannedEntries.map((entry, index) => {
    const refs = entry.plannedTask.dependsOn && entry.plannedTask.dependsOn.length > 0
      ? entry.plannedTask.dependsOn
      : [input.sourceTask.id];
    return refs.flatMap((ref) => {
      const normalized = ref.trim();
      if (ambiguous.has(normalized)) {
        problems.push(`planned task ${index} dependsOn "${ref}" is ambiguous; use a task id instead`);
        return [];
      }
      const labeledId = labels.get(normalized);
      if (labeledId) {
        return [labeledId];
      }
      const existingTask = input.harness.getTask(normalized);
      if (existingTask?.runId === input.runId) {
        return [existingTask.id];
      }
      problems.push(`planned task ${index} dependsOn "${ref}" does not match a task id or planned task goal`);
      return [];
    });
  });

  return { dependsOnByIndex, problems };
}
