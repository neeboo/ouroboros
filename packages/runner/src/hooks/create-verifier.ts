import { DEFAULT_VERIFIER_TASK_PROMPT_TEMPLATE, type AttemptOutput, type Harness } from "@ouroboros/harness";
import { boundedDiagnosticText, compactAttemptEvidence } from "../bounded-diagnostic";
import { fitPromptAroundFrozenSections, HandoffContractTooLargeError } from "../prompt-budget";
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
    let prompt: string;
    try {
      prompt = buildVerifierPrompt(
        options.harness.getPromptTemplate("verifier-task")?.contentMd,
        task.id,
        task.worktreePath,
        output,
        verifierContract,
      );
    } catch (error) {
      if (error instanceof HandoffContractTooLargeError) {
        return {
          decision: "exit",
          checks: [{ name: "handoff contract budget", status: "failed", evidence: error.artifact }],
          artifacts: [error.artifact],
          problems: [
            `handoff_contract_too_large: ${error.artifact.chars}/${error.artifact.limit} characters; `
            + `${error.artifact.bytes} UTF-8 bytes; sha256=${error.artifact.sha}.`,
          ],
        };
      }
      throw error;
    }
    const taskId = options.harness.createTask({
      runId: run.id,
      role: "verifier",
      goal: `Verify: ${task.goal}`,
      prompt,
      dependsOn: [task.id],
      worktreePath: task.worktreePath,
      doneWhen: [
        "source task output is checked against real changed files and artifacts",
        "relevant checks are rerun or explained",
        "verification result is returned as structured JSON",
      ],
      ...(verifierContract ? { config: { verifierContract } } : {}),
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
    ...compactAttemptEvidence(output),
    worktreePath: sourceTaskWorktreePath,
  };
  const contractSection = verifierContract
    ? ["## Frozen Verifier Contract", "```json", prettyJson(verifierContract), "```"].join("\n")
    : "";
  const rendered = renderPromptTemplate(template ?? DEFAULT_VERIFIER_TASK_PROMPT_TEMPLATE, {
    sourceTaskId,
    sourceTaskWorktreePath: sourceTaskWorktreePath ?? "not recorded",
    sourceSummary: boundedDiagnosticText(output.summary, 1_200).text,
    sourceOutputJson: prettyJson(sourceOutput),
    sourceProblemsJson: prettyJson(sourceOutput.problems.items),
    sourceVerifierContractJson: verifierContract ? prettyJson(verifierContract) : "null",
    sourceVerifierContractSection: contractSection,
  });
  const boundedEvidenceSection = [
    "## Bounded Source Evidence",
    `Source Task ID: ${sourceTaskId}`,
    `Source Worktree Path: ${sourceTaskWorktreePath ?? "not recorded"}`,
    "```json",
    prettyJson(sourceOutput),
    "```",
  ].join("\n");
  return fitPromptAroundFrozenSections(rendered, [boundedEvidenceSection, contractSection]);
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
