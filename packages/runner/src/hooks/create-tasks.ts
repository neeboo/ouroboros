import { makeId, type Harness, type PlannedTask, type Task } from "@ouroboros/harness";
import { validatePlannedTasks } from "../executors/output";
import type { StopHook } from "../types";

export function createTasksFromOutputHook(options: { harness: Harness }): StopHook {
  return ({ run, task, output }) => {
    if (output.status !== "done") {
      return { decision: "exit" };
    }

    const plannedTasks = validatePlannedTasks(output.nextTasks);
    const activeDesignChildren = options.harness.listRuns({ limit: 1000 }).filter((candidate) =>
      candidate.context.parentRunId === run.id
      && candidate.context.source === "design"
      && candidate.context.retired !== true
      && (candidate.status === "todo" || candidate.status === "running")
    );
    if (plannedTasks.length > 0 && activeDesignChildren.length > 0) {
      return {
        decision: "exit",
        checks: [{
          name: "canonical design delivery ownership",
          status: "passed",
          evidence: activeDesignChildren.map((child) => child.id).join(","),
        }],
        artifacts: activeDesignChildren.map((child) => ({
          kind: "delegated_to_child_run",
          runId: child.id,
          source: "design",
          status: child.status,
        })),
      };
    }
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

    const prepared = plannedEntries.map(({ id, plannedTask }, index) => {
      const dependsOn = resolved.dependsOnByIndex[index] ?? [task.id];
      const sourceWorktreePath = inheritedWorktreePath(options.harness, task, dependsOn);
      const config = {
        ...(plannedTask.modelPreference ? { modelPreference: plannedTask.modelPreference } : {}),
        ...(plannedTask.verifierContract ? { verifierContract: plannedTask.verifierContract } : {}),
        ...(sourceWorktreePath ? { sourceWorktreePath } : {}),
      };
      return { id, plannedTask, dependsOn, sourceWorktreePath, config };
    });
    const createPrepared = (entry: typeof prepared[number], db?: Parameters<Harness["createTaskWithDb"]>[0]) => {
      const input = {
        id: entry.id,
        runId: run.id,
        role: entry.plannedTask.role,
        goal: entry.plannedTask.goal,
        prompt: entry.plannedTask.prompt,
        dependsOn: entry.dependsOn,
        doneWhen: entry.plannedTask.doneWhen ?? [],
        worktreePath: null,
        config: entry.config,
      };
      const taskId = db ? options.harness.createTaskWithDb(db, input) : options.harness.createTask(input);
      return {
        kind: "created_task",
        taskId,
        sourceTaskId: task.id,
        ...(entry.sourceWorktreePath ? { sourceWorktreePath: entry.sourceWorktreePath } : {}),
      };
    };

    if (plannedTasks.length > 0 && task.role === "goal-review") {
      const atomic = options.harness.runInImmediateTransaction((db) => {
        const activeTasks = options.harness.getRunOverviewWithDb(db, { runId: run.id, eventLimit: 0 }).tasks.filter((candidate) =>
          candidate.id !== task.id && (candidate.status === "todo" || candidate.status === "running")
        );
        if (activeTasks.length > 0) {
          return { activeTasks, created: [] as ReturnType<typeof createPrepared>[] };
        }
        return { activeTasks: [], created: prepared.map((entry) => createPrepared(entry, db)) };
      });
      if (atomic.activeTasks.length > 0) {
        return {
          decision: "exit",
          checks: [{
            name: "goal review completion snapshot",
            status: "passed",
            evidence: atomic.activeTasks.map((candidate) => candidate.id).join(","),
          }],
          artifacts: atomic.activeTasks.map((candidate) => ({
            kind: "delegated_to_active_task",
            taskId: candidate.id,
            role: candidate.role,
            status: candidate.status,
          })),
        };
      }
      return {
        decision: atomic.created.length > 0 ? "continue" : "exit",
        artifacts: atomic.created,
      };
    }

    const created = prepared.map((entry) => createPrepared(entry));

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
