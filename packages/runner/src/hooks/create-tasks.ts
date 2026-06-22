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
      const dependsOn = resolved.dependsOnByIndex[index] ?? [task.id];
      const worktreePath = inheritedWorktreePath(options.harness, task, dependsOn);
      const config = {
        ...(plannedTask.modelPreference ? { modelPreference: plannedTask.modelPreference } : {}),
        ...(plannedTask.verifierContract ? { verifierContract: plannedTask.verifierContract } : {}),
      };
      const taskId = options.harness.createTask({
        id,
        runId: run.id,
        role: plannedTask.role,
        goal: plannedTask.goal,
        prompt: plannedTask.prompt,
        dependsOn,
        doneWhen: plannedTask.doneWhen ?? [],
        worktreePath,
        config,
      });
      return {
        kind: "created_task",
        taskId,
        sourceTaskId: task.id,
        ...(worktreePath ? { sourceWorktreePath: worktreePath } : {}),
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
  addLabel(roleGoalLabel(input.sourceTask.role, input.sourceTask.goal), input.sourceTask.id);
  for (const entry of input.plannedEntries) {
    addLabel(entry.id, entry.id);
    addLabel(entry.plannedTask.goal, entry.id);
    addLabel(roleGoalLabel(entry.plannedTask.role, entry.plannedTask.goal), entry.id);
  }

  const problems: string[] = [];
  const dependsOnByIndex = input.plannedEntries.map((entry, index) => {
    const explicitRefs = explicitDependencyRefs(entry.plannedTask);
    const refs =
      explicitRefs && explicitRefs.length === 0 && input.sourceTask.role === "goal-review"
        ? [input.sourceTask.id]
        : explicitRefs ?? defaultDependencyRefs(input, index);
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

function roleGoalLabel(role: string, goal: string) {
  const normalizedRole = role.trim().toLowerCase();
  const normalizedGoal = goal.trim();
  return normalizedRole && normalizedGoal ? `${normalizedRole}:${normalizedGoal}` : "";
}

function explicitDependencyRefs(plannedTask: PlannedTask) {
  if ("dependsOn" in plannedTask && Array.isArray(plannedTask.dependsOn)) {
    return plannedTask.dependsOn;
  }
  return undefined;
}

function defaultDependencyRefs(
  input: {
    sourceTask: Task;
    plannedEntries: Array<{ id: string; plannedTask: PlannedTask }>;
  },
  index: number,
) {
  const plannedTask = input.plannedEntries[index].plannedTask;
  if (plannedTask.role.trim().toLowerCase() !== "verifier") {
    return [input.sourceTask.id];
  }

  const siblingProducerIds = input.plannedEntries
    .filter((entry, entryIndex) => entryIndex !== index && entry.plannedTask.role.trim().toLowerCase() !== "verifier")
    .map((entry) => entry.id);

  return siblingProducerIds.length > 0 ? siblingProducerIds : [input.sourceTask.id];
}

function inheritedWorktreePath(harness: Harness, sourceTask: Task, dependsOn: string[]) {
  if (dependsOn.length !== 1) {
    return null;
  }
  if (dependsOn[0] === sourceTask.id && sourceTask.role === "goal-review") {
    return sourceTask.worktreePath;
  }
  const dependency = harness.getTask(dependsOn[0]);
  if (!dependency || !dependency.worktreePath) {
    return null;
  }
  if (dependency.role === "worker" || sourceTask.role === "goal-review") {
    return dependency.worktreePath;
  }
  return null;
}
