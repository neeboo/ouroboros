import type { AttemptOutput, Harness } from "@ouroboros/harness";
import type { StopHook } from "../types";

const DEFAULT_SOURCE_ROLES = new Set(["worker"]);

export function createVerifierTaskHook(options: { harness: Harness; sourceRoles?: string[] }): StopHook {
  const sourceRoles = new Set(options.sourceRoles ?? DEFAULT_SOURCE_ROLES);
  return ({ run, task, output }) => {
    if (output.status !== "done" || !sourceRoles.has(task.role)) {
      return { decision: "exit" };
    }

    const taskId = options.harness.createTask({
      runId: run.id,
      role: "verifier",
      goal: `Verify: ${task.goal}`,
      prompt: buildVerifierPrompt(task.id, output),
      dependsOn: [task.id],
      doneWhen: [
        "source task output is checked against real changed files and artifacts",
        "relevant checks are rerun or explained",
        "verification result is returned as structured JSON",
      ],
    });

    return {
      decision: "exit",
      artifacts: [
        {
          kind: "created_verifier_task",
          taskId,
          sourceTaskId: task.id,
        },
      ],
    };
  };
}

function buildVerifierPrompt(sourceTaskId: string, output: AttemptOutput) {
  return [
    "Verify the completed source task using repository state and recorded output.",
    "",
    `Source Task ID: ${sourceTaskId}`,
    "",
    "## Source Output",
    fencedJson({
      summary: output.summary,
      changedFiles: output.changedFiles ?? [],
      checks: output.checks ?? [],
      artifacts: output.artifacts ?? [],
      problems: output.problems ?? [],
    }),
    "",
    "Return structured JSON. Use status blocked with concrete problems when verification cannot pass.",
  ].join("\n");
}

function fencedJson(value: unknown) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
