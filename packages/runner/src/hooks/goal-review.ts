import type { Harness } from "@ouroboros/harness";
import type { StopHook } from "../types";

const MAX_GOAL_REVIEW_NEXT_TASKS = 5;

export function createGoalReviewDecisionHook(_options: { harness: Harness }): StopHook {
  return ({ run, task, output }) => {
    if (task.role !== "goal-review") {
      return { decision: "exit" };
    }

    const inferredRunDecision = output.runDecision ?? inferExplicitRunDecision(output);
    const outputPatch = inferredRunDecision && !output.runDecision ? { runDecision: inferredRunDecision } : undefined;
    const artifacts = [
      {
        kind: "goal_review",
        runDecision: inferredRunDecision ?? null,
        taskId: task.id,
      },
    ];

    if (!inferredRunDecision) {
      return {
        decision: "exit",
        artifacts,
        problems: ["goal-review output must include runDecision"],
      };
    }

    if (inferredRunDecision === "complete") {
      if ((output.nextTasks ?? []).length > 0) {
        return {
          decision: "exit",
          artifacts,
          outputPatch,
          problems: ["complete goal-review must not include nextTasks"],
        };
      }
      return { decision: "exit", artifacts, outputPatch };
    }

    if (inferredRunDecision === "defer") {
      if ((output.nextTasks ?? []).length > 0) {
        return {
          decision: "exit",
          artifacts,
          outputPatch,
          problems: ["defer goal-review must not include nextTasks"],
        };
      }
      return { decision: "exit", artifacts, outputPatch };
    }

    const nextTasks = output.nextTasks ?? [];
    if (nextTasks.length < 1 || nextTasks.length > MAX_GOAL_REVIEW_NEXT_TASKS) {
      return {
        decision: "exit",
        artifacts,
        outputPatch,
        problems: [
          `${inferredRunDecision} goal-review must include one to ${MAX_GOAL_REVIEW_NEXT_TASKS} nextTasks items`,
        ],
      };
    }

    if (inferredRunDecision === "verify" && nextTasks.some((plannedTask) => plannedTask.role !== "verifier")) {
      return {
        decision: "exit",
        artifacts,
        outputPatch,
        problems: ["verify goal-review nextTasks must all use role verifier"],
      };
    }

    return { decision: "continue", artifacts, outputPatch };
  };
}

export function inferExplicitRunDecision(output: {
  summary?: unknown;
  checks?: unknown[];
  artifacts?: unknown[];
  problems?: unknown[];
}) {
  const haystack = [output.summary, ...(output.checks ?? []), ...(output.artifacts ?? []), ...(output.problems ?? [])]
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join("\n");
  const match = haystack.match(/\b(?:runDecision\s*[:=]?|decision\s*[:=])\s*(complete|continue|verify|defer)\b/i);
  if (!match) {
    return undefined;
  }
  return match[1].toLowerCase() as "complete" | "continue" | "verify" | "defer";
}
