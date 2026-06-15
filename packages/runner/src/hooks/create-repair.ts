import { DEFAULT_REPAIR_TASK_PROMPT_TEMPLATE, type AttemptOutput, type Harness } from "@ouroboros/harness";
import { prettyJson, renderPromptTemplate } from "../template";
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
      prompt: buildRepairPrompt(options.harness.getPromptTemplate("repair-task")?.contentMd, task.id, output),
      doneWhen: [
        "verifier problems are addressed",
        "relevant checks pass",
        "the repair output describes changed files and validation",
      ],
    });

    return {
      decision: "continue",
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

function buildRepairPrompt(template: string | undefined, verifierTaskId: string, output: AttemptOutput) {
  const verifierOutput = {
      summary: output.summary,
      changedFiles: output.changedFiles ?? [],
      checks: output.checks ?? [],
      artifacts: output.artifacts ?? [],
      problems: output.problems ?? [],
    };
  return renderPromptTemplate(template ?? DEFAULT_REPAIR_TASK_PROMPT_TEMPLATE, {
    verifierTaskId,
    verifierSummary: output.summary,
    verifierOutputJson: prettyJson(verifierOutput),
    verifierProblemsJson: prettyJson(output.problems ?? []),
  });
}
