import { makeId, type Harness, type PlannedTask, type Task } from "@ouroboros/harness";
import { validatePlannedTasks } from "../executors/output";
import type { StopHook } from "../types";
import {
  chargeRepairBudgetState,
  goalReviewRepairTrigger,
  readRepairBudget,
  reconcileGoalReviewRepairBudget,
} from "./repair-budget";

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
        ...(task.role === "goal-review" ? {
          goalReviewContinuation: { sourceTaskId: task.id, ordinal: index },
        } : {}),
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
        const overview = options.harness.getRunOverviewWithDb(db, { runId: run.id, eventLimit: 0 });
        const storedRepairBudget = overview.run ? readRepairBudget(overview.run.context) : null;
        const reconciliation = storedRepairBudget
          ? reconcileGoalReviewRepairBudget(storedRepairBudget, overview)
          : null;
        const currentRepairBudget = reconciliation?.nextBudget ?? storedRepairBudget;
        if (reconciliation && reconciliation.chargedTaskIds.length > 0) {
          options.harness.updateRunWithDb(db, {
            runId: run.id,
            contextPatch: { repairReplanBudget: reconciliation.nextBudget },
          });
        }
        const base = {
          created: [] as ReturnType<typeof createPrepared>[],
          replayedTaskIds: [] as string[],
          repairBudget: null as ReturnType<typeof chargeRepairBudgetState> | null,
          reconciledTaskIds: reconciliation?.chargedTaskIds ?? [],
          conflict: null as string | null,
        };
        const activeTasks = overview.tasks.filter((candidate) =>
          candidate.id !== task.id && (candidate.status === "todo" || candidate.status === "running")
        );
        if (activeTasks.length > 0) {
          return { ...base, activeTasks };
        }

        const durableContinuations = overview.tasks.filter((candidate) => {
          const provenance = candidate.config?.goalReviewContinuation;
          return provenance != null
            && typeof provenance === "object"
            && !Array.isArray(provenance)
            && (provenance as Record<string, unknown>).sourceTaskId === task.id;
        });
        if (durableContinuations.length > 0) {
          const byOrdinal = new Map(durableContinuations.map((candidate) => {
            const provenance = candidate.config!.goalReviewContinuation as Record<string, unknown>;
            return [provenance.ordinal, candidate] as const;
          }));
          const exact = durableContinuations.length === prepared.length && prepared.every((entry, index) => {
            const existing = byOrdinal.get(index);
            const expectedDependsOn = entry.dependsOn.map((dependencyId) => {
              const plannedOrdinal = prepared.findIndex((candidate) => candidate.id === dependencyId);
              return plannedOrdinal >= 0 ? byOrdinal.get(plannedOrdinal)?.id ?? dependencyId : dependencyId;
            });
            return existing?.role === entry.plannedTask.role
              && existing.goal === entry.plannedTask.goal
              && existing.prompt === entry.plannedTask.prompt
              && JSON.stringify(existing.dependsOn) === JSON.stringify(expectedDependsOn)
              && JSON.stringify(existing.doneWhen) === JSON.stringify(entry.plannedTask.doneWhen ?? [])
              && JSON.stringify(existing.config ?? {}) === JSON.stringify(entry.config);
          });
          return {
            ...base,
            activeTasks: [],
            replayedTaskIds: exact ? durableContinuations.map((candidate) => candidate.id) : [],
            conflict: exact ? null : "goal-review continuation replay conflicts with the durable task set",
          };
        }

        const legacyReplayedTaskIds = [...new Set(overview.sessions
          .filter((candidate) => candidate.taskId === task.id && candidate.status !== "running")
          .flatMap((candidate) => candidate.output.artifacts ?? [])
          .flatMap((artifact) => {
            if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return [];
            const record = artifact as Record<string, unknown>;
            return record.kind === "created_task"
              && record.sourceTaskId === task.id
              && typeof record.taskId === "string"
              && overview.tasks.some((candidate) => candidate.id === record.taskId)
              ? [record.taskId]
              : [];
          }))];
        if (legacyReplayedTaskIds.length > 0) {
          return { ...base, activeTasks: [], replayedTaskIds: legacyReplayedTaskIds };
        }

        if (
          reconciliation
          && reconciliation.chargedTaskIds.length > 0
          && currentRepairBudget
          && currentRepairBudget.used >= currentRepairBudget.limit
        ) {
          const exhausted = chargeRepairBudgetState(currentRepairBudget, {
            limit: currentRepairBudget.limit,
            taskId: task.id,
            kind: "replan",
            summary: "goal-review continuation blocked after historical repair reconciliation exhausted the budget",
          });
          return { ...base, activeTasks: [], repairBudget: exhausted };
        }

        const repairTrigger = goalReviewRepairTrigger(overview, task.id);
        const existingCharge = currentRepairBudget?.entries.some((entry) =>
          entry.taskId === task.id && entry.kind === "replan"
        );
        if (repairTrigger && existingCharge) {
          return {
            ...base,
            activeTasks: [],
            conflict: "repair budget was charged for this goal-review but its durable continuation task is missing",
          };
        }
        const repairBudget = repairTrigger && currentRepairBudget
          ? chargeRepairBudgetState(currentRepairBudget, {
              limit: currentRepairBudget.limit,
              taskId: task.id,
              kind: "replan",
              summary: `goal-review follow-up after blocked ${repairTrigger.role} ${repairTrigger.taskId}`,
              rootTaskId: repairTrigger.taskId,
              rootCause: repairTrigger.rootCause,
            })
          : null;
        if (repairBudget && !repairBudget.allowed) {
          return { ...base, activeTasks: [], repairBudget };
        }
        if (repairBudget?.charged) {
          options.harness.updateRunWithDb(db, {
            runId: run.id,
            contextPatch: { repairReplanBudget: repairBudget.nextBudget },
          });
        }
        return {
          ...base,
          activeTasks: [],
          created: prepared.map((entry) => createPrepared(entry, db)),
          repairBudget,
        };
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
      if (atomic.repairBudget && !atomic.repairBudget.allowed) {
        return {
          decision: "exit",
          artifacts: [{
            kind: "repair_budget_exhausted",
            taskId: task.id,
            used: atomic.repairBudget.used,
            limit: atomic.repairBudget.limit,
            requestedRunDecision: output.runDecision ?? null,
          }],
          problems: [
            `goal-review cannot create repair/replan work after repair budget exhausted at ${atomic.repairBudget.used}/${atomic.repairBudget.limit}`,
          ],
        };
      }
      if (atomic.conflict) {
        return {
          decision: "exit",
          artifacts: [{ kind: "goal_review_continuation_conflict", taskId: task.id }],
          problems: [atomic.conflict],
        };
      }
      if (atomic.replayedTaskIds.length > 0) {
        return {
          decision: "exit",
          artifacts: atomic.replayedTaskIds.map((taskId) => ({
            kind: "reused_created_task",
            taskId,
            sourceTaskId: task.id,
          })),
        };
      }
      return {
        decision: atomic.created.length > 0 ? "continue" : "exit",
        checks: atomic.repairBudget?.charged ? [{
          name: "shared repair budget",
          status: "passed",
          evidence: `charged ${atomic.repairBudget.nextBudget.used}/${atomic.repairBudget.limit} for ${task.id}`,
        }] : undefined,
        artifacts: [
          ...(atomic.repairBudget?.charged ? [{
            kind: "repair_budget_charged",
            taskId: task.id,
            rootTaskId: atomic.repairBudget.nextBudget.entries.at(-1)?.rootTaskId ?? null,
            used: atomic.repairBudget.nextBudget.used,
            limit: atomic.repairBudget.limit,
          }] : []),
          ...(atomic.reconciledTaskIds.length > 0 ? [{
            kind: "repair_budget_reconciled",
            taskIds: atomic.reconciledTaskIds,
            used: atomic.repairBudget?.nextBudget.used ?? null,
            limit: atomic.repairBudget?.limit ?? null,
          }] : []),
          ...atomic.created,
        ],
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
