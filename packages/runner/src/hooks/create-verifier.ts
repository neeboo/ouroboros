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

    const verifierContract = verifierContractFromTask(task);
    const taskId = options.harness.createTask({
      runId: run.id,
      role: "verifier",
      goal: `Verify: ${task.goal}`,
      prompt: buildVerifierPrompt(
        options.harness.getPromptTemplate("verifier-task")?.contentMd,
        task.id,
        task.worktreePath,
        output,
        verifierContract,
      ),
      dependsOn: [task.id],
      worktreePath: task.worktreePath,
      doneWhen: [
        "source task output is checked against real changed files and artifacts",
        "relevant checks are rerun or explained",
        "verification result is returned as structured JSON",
      ],
    });

    return {
      decision: "continue",
      artifacts: [
        {
          kind: "created_verifier_task",
          taskId,
          sourceTaskId: task.id,
          sourceWorktreePath: task.worktreePath,
          ...artifactVerifierContract(verifierContract),
        },
      ],
    };
  };
}

function buildVerifierPrompt(
  template: string | undefined,
  sourceTaskId: string,
  sourceTaskWorktreePath: string | null,
  output: AttemptOutput,
  verifierContract: Record<string, unknown> | undefined,
) {
  const sourceOutput = {
    summary: output.summary,
    changedFiles: output.changedFiles ?? [],
    checks: output.checks ?? [],
    artifacts: output.artifacts ?? [],
    problems: output.problems ?? [],
    worktreePath: sourceTaskWorktreePath,
  };
  const contractSection = verifierContract
    ? ["## Frozen Verifier Contract", "```json", prettyJson(verifierContract), "```"].join("\n")
    : "";
  const rendered = renderPromptTemplate(template ?? DEFAULT_VERIFIER_TASK_PROMPT_TEMPLATE, {
    sourceTaskId,
    sourceTaskWorktreePath: sourceTaskWorktreePath ?? "not recorded",
    sourceSummary: output.summary,
    sourceOutputJson: prettyJson(sourceOutput),
    sourceProblemsJson: prettyJson(output.problems ?? []),
    sourceVerifierContractJson: verifierContract ? prettyJson(verifierContract) : "null",
    sourceVerifierContractSection: contractSection,
  });
  if (!verifierContract || rendered.includes(contractSection)) {
    return rendered;
  }
  return `${rendered}\n\n${contractSection}`;
}

function verifierContractFromTask(task: { config?: { verifierContract?: unknown } }) {
  const value = task.config?.verifierContract;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function artifactVerifierContract(verifierContract: Record<string, unknown> | undefined) {
  return verifierContract ? { verifierContract } : {};
}
