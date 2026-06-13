import { DEFAULT_VERIFIER_TASK_PROMPT_TEMPLATE, type AttemptOutput, type Harness } from "@ouroboros/harness";
import { prettyJson, renderPromptTemplate } from "../template";
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
      prompt: buildVerifierPrompt(options.harness.getPromptTemplate("verifier-task")?.contentMd, task.id, output),
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

function buildVerifierPrompt(template: string | undefined, sourceTaskId: string, output: AttemptOutput) {
  const sourceOutput = {
      summary: output.summary,
      changedFiles: output.changedFiles ?? [],
      checks: output.checks ?? [],
      artifacts: output.artifacts ?? [],
      problems: output.problems ?? [],
    };
  return renderPromptTemplate(template ?? DEFAULT_VERIFIER_TASK_PROMPT_TEMPLATE, {
    sourceTaskId,
    sourceSummary: output.summary,
    sourceOutputJson: prettyJson(sourceOutput),
    sourceProblemsJson: prettyJson(output.problems ?? []),
  });
}
