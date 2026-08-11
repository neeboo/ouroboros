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
    const template = options.harness.getPromptTemplate("verifier-task")?.contentMd;
    try {
      return options.harness.runInImmediateTransaction((db) => {
        const overview = options.harness.getRunOverviewWithDb(db, { runId: run.id, eventLimit: 0 });
        const existingVerifiers = overview.tasks
          .filter((candidate) => candidate.role === "verifier" && candidate.dependsOn.includes(task.id));
        if (existingVerifiers.length > 1) {
          return {
            decision: "exit" as const,
            problems: [`multiple verifier tasks already bind source worker ${task.id}`],
            artifacts: existingVerifiers.map((candidate) => ({
              kind: "conflicting_verifier_task",
              taskId: candidate.id,
              sourceTaskId: task.id,
              status: candidate.status,
            })),
          };
        }
        const existingVerifier = existingVerifiers[0];
        if (existingVerifier) {
          const existingContract = existingVerifier.config?.verifierContract;
          if (stableJson(existingContract) !== stableJson(verifierContract)) {
            return {
              decision: "exit" as const,
              problems: [`existing verifier ${existingVerifier.id} has a different frozen verifier contract`],
              artifacts: [{
                kind: "conflicting_verifier_contract",
                taskId: existingVerifier.id,
                sourceTaskId: task.id,
              }],
            };
          }
          let sourceWorktreePath = existingVerifier.worktreePath;
          if (task.worktreePath && !sourceWorktreePath) {
            const hasAttempt = overview.sessions.some((session) => session.taskId === existingVerifier.id);
            if (existingVerifier.status !== "todo" || hasAttempt) {
              return {
                decision: "exit" as const,
                problems: [`existing verifier ${existingVerifier.id} cannot be rebound to the source worktree`],
                artifacts: [{ kind: "conflicting_verifier_worktree", taskId: existingVerifier.id, sourceTaskId: task.id }],
              };
            }
            const update = db.query(
              "update tasks set worktree_path = $worktreePath, updated_at = current_timestamp where id = $taskId and status = 'todo' and worktree_path is null",
            ).run({ $worktreePath: task.worktreePath, $taskId: existingVerifier.id });
            if (update.changes !== 1) {
              throw new Error(`failed to bind verifier ${existingVerifier.id} to source worktree`);
            }
            sourceWorktreePath = task.worktreePath;
          } else if (task.worktreePath && sourceWorktreePath !== task.worktreePath) {
            return {
              decision: "exit" as const,
              problems: [`existing verifier ${existingVerifier.id} is bound to a different source worktree`],
              artifacts: [{ kind: "conflicting_verifier_worktree", taskId: existingVerifier.id, sourceTaskId: task.id }],
            };
          }
          return {
            decision: existingVerifier.status === "todo" || existingVerifier.status === "running"
              ? "continue" as const
              : "exit" as const,
            artifacts: [{
              kind: "reused_verifier_task",
              taskId: existingVerifier.id,
              sourceTaskId: task.id,
              sourceWorktreePath,
            }],
          };
        }

        const prompt = buildVerifierPrompt(template, task.id, task.worktreePath, output, verifierContract);
        const taskId = options.harness.createTaskWithDb(db, {
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
          decision: "continue" as const,
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
      });
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
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
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
