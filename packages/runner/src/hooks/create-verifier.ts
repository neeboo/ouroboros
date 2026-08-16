import {
  DEFAULT_VERIFIER_TASK_PROMPT_TEMPLATE,
  completionVerificationContract,
  type AttemptOutput,
  type CompletionVerificationContractV1,
  type Harness,
} from "@ouroboros/harness";
import { boundedDiagnosticText, compactAttemptEvidence } from "../bounded-diagnostic";
import { fitPromptAroundFrozenSections, HandoffContractTooLargeError } from "../prompt-budget";
import { prettyJson, renderPromptTemplate } from "../template";
import type { StopHook } from "../types";

const DEFAULT_SOURCE_ROLES = new Set(["worker"]);

export interface TerminalDoneWorkerVerifierReconciliation {
  workerTaskId: string;
  workerAttemptId: string;
  verifierTaskId: string;
  decision: "continue" | "retry" | "exit";
  artifacts: unknown[];
  problems: string[];
}

export async function reconcileTerminalDoneWorkerVerifiers(options: {
  harness: Harness;
  runId: string;
}): Promise<TerminalDoneWorkerVerifierReconciliation[]> {
  const overview = options.harness.getRunOverview({ runId: options.runId, eventLimit: 0 });
  if (!overview.run || overview.run.status !== "todo") {
    return [];
  }
  const results: TerminalDoneWorkerVerifierReconciliation[] = [];
  for (const worker of overview.tasks.filter((task) =>
    task.role === "worker"
    && task.status === "done"
    && !overview.tasks.some((candidate) => candidate.role === "verifier" && candidate.dependsOn.includes(task.id))
  )) {
    const session = [...overview.sessions]
      .reverse()
      .find((candidate) => candidate.taskId === worker.id && candidate.status === "done");
    if (!session) {
      continue;
    }
    const attempt = options.harness.getAttempt(session.attemptId);
    if (!attempt || attempt.output.status !== "done") {
      continue;
    }
    const hookResult = await createVerifierTaskHook({ harness: options.harness })({
      run: overview.run,
      task: worker,
      sessionName: session.sessionName ?? `task-${worker.id}`,
      prompt: typeof attempt.input.prompt === "string" ? attempt.input.prompt : worker.prompt,
      output: attempt.output,
    });
    const verifier = options.harness
      .getRunOverview({ runId: options.runId, eventLimit: 0 })
      .tasks
      .find((candidate) => candidate.role === "verifier" && candidate.dependsOn.includes(worker.id));
    if (!verifier) {
      continue;
    }
    results.push({
      workerTaskId: worker.id,
      workerAttemptId: attempt.id,
      verifierTaskId: verifier.id,
      decision: hookResult.decision ?? "exit",
      artifacts: hookResult.artifacts ?? [],
      problems: hookResult.problems ?? [],
    });
  }
  return results;
}

export function createVerifierTaskHook(options: { harness: Harness; sourceRoles?: string[] }): StopHook {
  const sourceRoles = new Set(options.sourceRoles ?? DEFAULT_SOURCE_ROLES);
  return ({ run, task, output }) => {
    if (output.status !== "done" || !sourceRoles.has(task.role)) {
      return { decision: "exit" };
    }

    const verifierContract = verifierContractFromTask(task);
    const sourceEvidence = sourceEvidenceAssessment(output);
    const template = options.harness.getPromptTemplate("verifier-task")?.contentMd;
    try {
      return options.harness.runInImmediateTransaction((db) => {
        const overview = options.harness.getRunOverviewWithDb(db, { runId: run.id, eventLimit: 0 });
        const completionContract = completionVerificationContract(overview, task);
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
          const existingCompletionContract = existingVerifier.config?.completionContract;
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
          const hasAttempt = overview.sessions.some((session) => session.taskId === existingVerifier.id);
          const mayBindCompletionContract = existingCompletionContract === undefined
            || mayRebindFixedRepairCompletionContract({
              sourceTask: task,
              existingVerifier,
              existingCompletionContract,
              completionContract,
              hasAttempt,
            });
          if (
            mayBindCompletionContract
            && existingVerifier.status === "todo"
            && !hasAttempt
          ) {
            db.query(
              `update tasks
               set config_json = $configJson, done_when_json = $doneWhenJson, updated_at = current_timestamp
               where id = $taskId and status = 'todo'`,
            ).run({
              $taskId: existingVerifier.id,
              $configJson: JSON.stringify({ ...(existingVerifier.config ?? {}), completionContract }),
              $doneWhenJson: JSON.stringify(uniqueStrings([
                ...existingVerifier.doneWhen,
                ...task.doneWhen,
                ...completionContract.requiredEvidence,
              ])),
            });
          } else if (stableJson(existingCompletionContract) !== stableJson(completionContract)) {
            return {
              decision: "exit" as const,
              problems: [`existing verifier ${existingVerifier.id} has a different frozen completion contract`],
              artifacts: [{
                kind: "conflicting_completion_contract",
                taskId: existingVerifier.id,
                sourceTaskId: task.id,
              }],
            };
          }
          let sourceWorktreePath = existingVerifier.worktreePath;
          if (task.worktreePath && !sourceWorktreePath) {
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

        const prompt = buildVerifierPrompt(
          template,
          task.id,
          task.worktreePath,
          output,
          verifierContract,
          completionContract,
          sourceEvidence,
        );
        const config = {
          ...(verifierContract ? { verifierContract } : {}),
          completionContract,
          ...(sourceEvidence ? { sourceEvidence } : {}),
        };
        const taskId = options.harness.createTaskWithDb(db, {
          runId: run.id,
          role: "verifier",
          goal: `Verify: ${task.goal}`,
          prompt,
          dependsOn: [task.id],
          worktreePath: task.worktreePath,
          doneWhen: uniqueStrings([
            ...task.doneWhen,
            ...completionContract.requiredEvidence,
            "source task output is checked against real changed files and artifacts",
            "relevant checks are rerun or explained",
            "verification result is returned as structured JSON",
          ]),
          ...(Object.keys(config).length > 0 ? { config } : {}),
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
            ...(sourceEvidence ? [{ kind: "source_evidence_incomplete", ...sourceEvidence }] : []),
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
  completionContract: CompletionVerificationContractV1,
  sourceEvidence: ReturnType<typeof sourceEvidenceAssessment>,
) {
  const sourceOutput = {
    ...compactAttemptEvidence(output),
    worktreePath: sourceTaskWorktreePath,
  };
  const contractSection = verifierContract
    ? ["## Frozen Verifier Contract", "```json", prettyJson(verifierContract), "```"].join("\n")
    : "";
  const completionContractSection = [
    "## Frozen Completion Contract",
    "The verifier must evaluate this exact source lineage and every required evidence item.",
    "```json",
    prettyJson(completionContract),
    "```",
  ].join("\n");
  const sourceEvidenceSection = sourceEvidence
    ? [
        "## Required Independent Source Readback",
        "The structured worker evidence is incomplete. Treat summary claims as untrusted until independently reproduced from the frozen worktree.",
        "```json",
        prettyJson(sourceEvidence),
        "```",
      ].join("\n")
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
  return fitPromptAroundFrozenSections(rendered, [
    boundedEvidenceSection,
    contractSection,
    completionContractSection,
    sourceEvidenceSection,
  ]);
}

function mayRebindFixedRepairCompletionContract(input: {
  sourceTask: {
    id: string;
    config?: Record<string, unknown>;
  };
  existingVerifier: {
    status: string;
    dependsOn: string[];
    config?: Record<string, unknown>;
  };
  existingCompletionContract: unknown;
  completionContract: CompletionVerificationContractV1;
  hasAttempt: boolean;
}) {
  if (input.existingVerifier.status !== "todo" || input.hasAttempt) return false;
  if (stableJson(input.existingVerifier.dependsOn) !== stableJson([input.sourceTask.id])) return false;
  const sourceRecovery = objectRecord(input.sourceTask.config?.verifierRepairRecovery);
  const verifierRecovery = objectRecord(input.existingVerifier.config?.verifierRepairRecovery);
  const existingContract = objectRecord(input.existingCompletionContract);
  if (!sourceRecovery || stableJson(sourceRecovery) !== stableJson(verifierRecovery) || !existingContract) return false;
  if (typeof sourceRecovery.recoveryKey !== "string" || sourceRecovery.recoveryKey.length === 0) return false;
  if (input.existingVerifier.config?.sourceTaskId !== input.sourceTask.id) return false;
  return existingContract.schemaVersion === 1
    && existingContract.sourceTaskId === sourceRecovery.sourceWorkerTaskId
    && stableJson(existingContract.requiredEvidence) === stableJson(input.completionContract.requiredEvidence);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function sourceEvidenceAssessment(output: AttemptOutput) {
  const sourceArtifacts = (output.artifacts ?? []).filter((artifact) => {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return true;
    return (artifact as Record<string, unknown>).kind !== "dsh_execution_profile_receipt";
  });
  const missing = [
    ...((output.changedFiles?.length ?? 0) === 0 ? ["changedFiles"] : []),
    ...((output.checks?.length ?? 0) === 0 ? ["checks"] : []),
    ...(sourceArtifacts.length === 0 ? ["artifacts"] : []),
  ];
  return missing.length > 0
    ? {
        status: "incomplete" as const,
        missing,
        requiresIndependentReadback: true as const,
      }
    : undefined;
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
