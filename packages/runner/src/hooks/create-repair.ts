import { DEFAULT_REPAIR_TASK_PROMPT_TEMPLATE, readableValue, type AttemptOutput, type Harness } from "@ouroboros/harness";
import { prettyJson, renderPromptTemplate } from "../template";
import type { StopHook } from "../types";

export function createRepairTaskHook(options: { harness: Harness }): StopHook {
  return ({ run, task, output }) => {
    if (task.role !== "verifier" || output.status !== "blocked") {
      return { decision: "exit" };
    }
    const externalBlocker = externalSetupBlockerReason(output);
    if (externalBlocker) {
      return {
        decision: "exit",
        artifacts: [
          {
            kind: "repair_skipped_external_setup_blocker",
            verifierTaskId: task.id,
            reason: externalBlocker,
          },
        ],
      };
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

function externalSetupBlockerReason(output: AttemptOutput) {
  const haystack = [
    output.summary,
    ...(output.problems ?? []),
    ...(output.checks ?? []),
    ...(output.artifacts ?? []),
  ]
    .map((value) => readableValue(value))
    .join("\n")
    .toLowerCase();

  if (haystack.includes("external_setup_blocker") || haystack.includes("external setup blocker")) {
    return "external setup blocker";
  }
  if (
    haystack.includes("setup blocker") &&
    (haystack.includes("install") ||
      haystack.includes("expose") ||
      haystack.includes("path") ||
      haystack.includes("auth") ||
      haystack.includes("credential") ||
      haystack.includes("acpx"))
  ) {
    return "setup blocker requires external environment change";
  }
  if (
    (haystack.includes("missing command") || haystack.includes("missing from the normalized child path")) &&
    (haystack.includes("install") || haystack.includes("expose") || haystack.includes("path"))
  ) {
    return "missing external command";
  }
  return null;
}

function buildRepairPrompt(template: string | undefined, verifierTaskId: string, output: AttemptOutput) {
  const verifierSummary = readableValue(output.summary);
  const verifierOutput = {
    summary: verifierSummary,
    changedFiles: output.changedFiles ?? [],
    checks: output.checks ?? [],
    artifacts: output.artifacts ?? [],
    problems: output.problems ?? [],
  };
  return renderPromptTemplate(template ?? DEFAULT_REPAIR_TASK_PROMPT_TEMPLATE, {
    verifierTaskId,
    verifierSummary,
    verifierOutputJson: prettyJson(verifierOutput),
    verifierProblemsJson: prettyJson(output.problems ?? []),
  });
}
