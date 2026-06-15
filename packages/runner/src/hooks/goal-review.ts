import type { Harness } from "@ouroboros/harness";
import type { StopHook } from "../types";

const MAX_GOAL_REVIEW_NEXT_TASKS = 5;

export function createGoalReviewDecisionHook(options: { harness: Harness }): StopHook {
  return ({ run, task, output }) => {
    if (task.role !== "goal-review") {
      return { decision: "exit" };
    }

    const artifacts = [
      {
        kind: "goal_review",
        runDecision: output.runDecision ?? null,
        taskId: task.id,
      },
    ];

    if (!output.runDecision) {
      return {
        decision: "exit",
        artifacts,
        problems: ["goal-review output must include runDecision"],
      };
    }

    if (output.runDecision === "complete") {
      if ((output.nextTasks ?? []).length > 0) {
        return {
          decision: "exit",
          artifacts,
          problems: ["complete goal-review must not include nextTasks"],
        };
      }
      options.harness.updateRunStatus({ runId: run.id, status: "done" });
      return { decision: "exit", artifacts };
    }

    const nextTasks = output.nextTasks ?? [];
    if (nextTasks.length < 1 || nextTasks.length > MAX_GOAL_REVIEW_NEXT_TASKS) {
      return {
        decision: "exit",
        artifacts,
        problems: [
          `${output.runDecision} goal-review must include one to ${MAX_GOAL_REVIEW_NEXT_TASKS} nextTasks items`,
        ],
      };
    }

    if (output.runDecision === "verify" && nextTasks.some((plannedTask) => plannedTask.role !== "verifier")) {
      return {
        decision: "exit",
        artifacts,
        problems: ["verify goal-review nextTasks must all use role verifier"],
      };
    }

    return { decision: "exit", artifacts };
  };
}
