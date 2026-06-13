import type { AttemptOutput, Harness } from "@ouroboros/harness";
import type { StopHook } from "../types";

export function createRepairTaskHook(options: { harness: Harness }): StopHook {
  return ({ run, task, output }) => {
    if (task.role !== "verifier" || output.status !== "blocked") {
      return { decision: "exit" };
    }

    const taskId = options.harness.createTask({
      runId: run.id,
      parentId: task.id,
      role: "worker",
      goal: `Repair: ${task.goal}`,
      prompt: buildRepairPrompt(task.id, output),
      doneWhen: [
        "verifier problems are addressed",
        "relevant checks pass",
        "the repair output describes changed files and validation",
      ],
    });

    return {
      decision: "exit",
      artifacts: [
        {
          kind: "created_repair_task",
          taskId,
          verifierTaskId: task.id,
        },
      ],
    };
  };
}

function buildRepairPrompt(verifierTaskId: string, output: AttemptOutput) {
  return [
    "Repair the failed verifier result.",
    "",
    `Verifier Task ID: ${verifierTaskId}`,
    "",
    "## Verifier Output",
    fencedJson({
      summary: output.summary,
      changedFiles: output.changedFiles ?? [],
      checks: output.checks ?? [],
      artifacts: output.artifacts ?? [],
      problems: output.problems ?? [],
    }),
    "",
    "Return structured JSON. Include changedFiles, checks, artifacts, and problems.",
  ].join("\n");
}

function fencedJson(value: unknown) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
