import { DEFAULT_REPAIR_TASK_PROMPT_TEMPLATE, makeId, readableValue, type AttemptOutput, type Harness, type Task } from "@ouroboros/harness";
import { boundedDiagnosticText, compactAttemptEvidence, latestRootCause } from "../bounded-diagnostic";
import { fitPromptAroundFrozenSections, HandoffContractTooLargeError } from "../prompt-budget";
import { prettyJson, renderPromptTemplate } from "../template";
import type { StopHook } from "../types";
import {
  chargeRepairBudgetState,
  readRepairBudget,
  reconcileGoalReviewRepairBudget,
  repairBudgetExhausted,
  type RepairBudgetChargeDecision,
} from "./repair-budget";

export const DEFAULT_REPAIR_REPLAN_BUDGET_LIMIT = 3;

export interface TerminalBlockedVerifierRepairReconciliation {
  verifierTaskId: string;
  verifierAttemptId: string;
  decision: "continue" | "retry" | "exit";
  artifacts: unknown[];
  problems: string[];
}

export async function reconcileTerminalBlockedVerifierRepair(options: {
  harness: Harness;
  runId: string;
  budgetLimit?: number;
}): Promise<TerminalBlockedVerifierRepairReconciliation[]> {
  const overview = options.harness.getRunOverview({ runId: options.runId, eventLimit: 0 });
  if (
    !overview.run
    || overview.run.status !== "todo"
    || overview.tasks.some((task) => task.status === "todo" || task.status === "running")
  ) {
    return [];
  }
  const verifier = [...overview.tasks]
    .reverse()
    .find((task) => task.role === "verifier" && task.status === "blocked");
  if (!verifier) {
    return [];
  }
  const session = [...overview.sessions]
    .reverse()
    .find((candidate) => candidate.taskId === verifier.id && candidate.status === "blocked");
  if (!session || session.output.status !== "blocked") {
    return [];
  }
  const attempt = options.harness.getAttempt(session.attemptId);
  if (!attempt) {
    return [];
  }
  const result = await createRepairTaskHook({
    harness: options.harness,
    budgetLimit: options.budgetLimit,
  })({
    run: overview.run,
    task: verifier,
    sessionName: session.sessionName ?? `task-${verifier.id}`,
    prompt: typeof attempt.input.prompt === "string" ? attempt.input.prompt : verifier.prompt,
    output: attempt.output,
  });
  return [{
    verifierTaskId: verifier.id,
    verifierAttemptId: attempt.id,
    decision: result.decision ?? "exit",
    artifacts: result.artifacts ?? [],
    problems: result.problems ?? [],
  }];
}

export function createRepairTaskHook(options: {
  harness: Harness;
  budgetLimit?: number;
}): StopHook {
  const budgetLimit = options.budgetLimit ?? DEFAULT_REPAIR_REPLAN_BUDGET_LIMIT;
  return ({ run, task, output }) => {
    if (task.role !== "verifier" || output.status !== "blocked") {
      return { decision: "exit" };
    }
    const durableExistingRepair = options.harness.getRunOverview({ runId: run.id, eventLimit: 0 }).tasks.find((candidate) =>
      candidate.role === "worker" && candidate.parentId === task.id
    );
    if (durableExistingRepair) {
      const accounting = options.harness.runInImmediateTransaction((db) => {
        const overview = options.harness.getRunOverviewWithDb(db, { runId: run.id, eventLimit: 0 });
        const existing = overview.tasks.find((candidate) => candidate.id === durableExistingRepair.id);
        const storedBudget = readRepairBudget(overview.run?.context ?? {});
        const reconciled = reconcileGoalReviewRepairBudget(storedBudget, overview);
        const charge = chargeRepairBudgetState(reconciled.nextBudget, {
          limit: budgetLimit,
          taskId: task.id,
          kind: "repair",
          summary: `Repair: ${task.goal}`,
        });
        if (!existing) {
          return { existing: null, charge };
        }
        const active = existing.status === "todo" || existing.status === "running";
        if (charge.charged || reconciled.chargedTaskIds.length > 0 || (active && overview.run?.status !== "todo")) {
          options.harness.updateRunWithDb(db, {
            runId: run.id,
            ...(active ? { status: "todo" as const } : {}),
            contextPatch: { repairReplanBudget: charge.nextBudget },
          });
        }
        return { existing: charge.allowed ? existing : null, charge };
      });
      if (!accounting.charge.allowed || !accounting.existing) {
        return {
          decision: "exit",
          artifacts: [{
            kind: "repair_budget_exhausted",
            verifierTaskId: task.id,
            runId: run.id,
            budgetLimit: accounting.charge.limit,
            budgetUsed: accounting.charge.used,
            remaining: 0,
            exhaustedRootCauses: accounting.charge.exhaustedRootCauses,
            sharedRootCause: accounting.charge.sharedRootCause ?? null,
            reason: accounting.charge.reason,
          }],
        };
      }
      return {
        decision: accounting.existing.status === "todo" || accounting.existing.status === "running"
          ? "continue"
          : "exit",
        artifacts: [{
          kind: "created_repair_task",
          taskId: accounting.existing.id,
          verifierTaskId: task.id,
          reused: true,
        }],
      };
    }
    const recursiveRepair = recursiveRepairBranch(options.harness, task);
    if (recursiveRepair) {
      return {
        decision: "exit",
        artifacts: [
          {
            kind: "repair_skipped_recursive_branch",
            verifierTaskId: task.id,
            repairTaskId: recursiveRepair.repairTaskId,
            originalVerifierTaskId: recursiveRepair.originalVerifierTaskId,
            reason: "repair verifier blocked on an already-repaired verifier branch",
          },
        ],
      };
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

    const sourceTasks = selectRepairSourceTasks(options.harness, task);
    const sourceTask = sourceTasks[0] ?? null;
    const sourceTaskIds = new Set(sourceTasks.map((candidate) => candidate.id));
    const activeSiblingVerifier = sourceTasks.length > 0
      ? options.harness
        .getRunOverview({ runId: run.id, eventLimit: 0 })
        .tasks
        .filter((candidate) =>
          candidate.id !== task.id
          && candidate.role === "verifier"
          && candidate.dependsOn.some((dependencyId) => sourceTaskIds.has(dependencyId))
          && (candidate.status === "todo" || candidate.status === "running")
        )
        .sort((left, right) => Number(right.status === "running") - Number(left.status === "running"))[0]
      : undefined;
    if (sourceTask && activeSiblingVerifier) {
      return {
        decision: activeSiblingVerifier.status === "running" ? "retry" : "exit",
        artifacts: [{
          kind: "repair_deferred_to_active_verifier",
          verifierTaskId: task.id,
          activeVerifierTaskId: activeSiblingVerifier.id,
          sourceTaskId: sourceTask.id,
          recheckRequired: activeSiblingVerifier.status === "running",
        }],
      };
    }

    const sourceSession = sourceTask
      ? [...options.harness.getRunOverview({ runId: run.id, eventLimit: 0 }).sessions]
        .reverse()
        .find((candidate) => candidate.taskId === sourceTask.id)
      : null;
    const sourceWorktreePath = sourceTask?.worktreePath
      ?? sourceSession?.worktreePath
      ?? sourceSession?.cwd
      ?? task.worktreePath
      ?? null;
    const sourceAttempt = sourceSession ? options.harness.getAttempt(sourceSession.attemptId) : null;
    const dshProfileIsolation = sourceAttempt && attemptUsedDsh(sourceAttempt.input)
      ? "base-headless" as const
      : undefined;
    const verifierContract = verifierContractFromTask(task);
    const repairConfig = {
      ...(verifierContract ? { verifierContract } : {}),
      ...(dshProfileIsolation ? { dshProfileIsolation } : {}),
    };
    let prompt: string;
    try {
      prompt = buildRepairPrompt(
        options.harness.getPromptTemplate("repair-task")?.contentMd,
        {
          verifierTaskId: task.id,
          verifierDoneWhen: task.doneWhen,
          verifierContract,
          sourceTaskId: sourceTask?.id ?? null,
          sourceDoneWhen: sourceTask?.doneWhen ?? [],
          sourceWorktreePath,
          output,
        },
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
    const proposedTaskId = makeId("task");
    const atomic = options.harness.runInImmediateTransaction((db) => {
      const overview = options.harness.getRunOverviewWithDb(db, { runId: run.id, eventLimit: 0 });
      const storedBudget = readRepairBudget(overview.run?.context ?? {});
      const reconciled = reconcileGoalReviewRepairBudget(storedBudget, overview);
      const charge = chargeRepairBudgetState(reconciled.nextBudget, {
        limit: budgetLimit,
        taskId: task.id,
        kind: "repair",
        summary: `Repair: ${task.goal}`,
      });
      const existingRepair = overview.tasks.find((candidate) =>
        candidate.role === "worker" && candidate.parentId === task.id
      );
      if (existingRepair) {
        if (charge.charged || reconciled.chargedTaskIds.length > 0) {
          options.harness.updateRunWithDb(db, {
            runId: run.id,
            contextPatch: { repairReplanBudget: charge.nextBudget },
          });
        }
        return { existingRepair: charge.allowed ? existingRepair : null, taskId: null, charge, conflict: null };
      }
      if (!charge.allowed) {
        options.harness.updateRunWithDb(db, {
          runId: run.id,
          contextPatch: { repairReplanBudget: charge.nextBudget },
        });
        return { existingRepair: null, taskId: null, charge, conflict: null };
      }
      if (!charge.charged) {
        return {
          existingRepair: null,
          taskId: null,
          charge,
          conflict: "repair budget was charged but the durable repair task is missing",
        };
      }
      const taskId = options.harness.createTaskWithDb(db, {
        id: proposedTaskId,
        runId: run.id,
        parentId: task.id,
        role: "worker",
        goal: `Repair: ${task.goal}`,
        prompt,
        dependsOn: sourceTask ? [sourceTask.id] : [],
        worktreePath: sourceWorktreePath,
        doneWhen: uniqueStrings([
          ...(sourceTask?.doneWhen ?? []),
          ...task.doneWhen,
          "verifier problems are addressed",
          "relevant checks pass",
          "the repair output describes changed files and validation",
        ]),
        ...(Object.keys(repairConfig).length > 0 ? { config: repairConfig } : {}),
      });
      options.harness.updateRunWithDb(db, {
        runId: run.id,
        contextPatch: { repairReplanBudget: charge.nextBudget },
      });
      return { existingRepair: null, taskId, charge, conflict: null };
    });
    if (atomic.existingRepair) {
      return {
        decision: atomic.existingRepair.status === "todo" || atomic.existingRepair.status === "running"
          ? "continue"
          : "exit",
        artifacts: [{
          kind: "created_repair_task",
          taskId: atomic.existingRepair.id,
          verifierTaskId: task.id,
          reused: true,
          ...(sourceTask ? { sourceTaskId: sourceTask.id, sourceWorktreePath } : {}),
        }],
      };
    }
    if (atomic.conflict) {
      return {
        decision: "exit",
        artifacts: [{ kind: "repair_creation_conflict", verifierTaskId: task.id }],
        problems: [atomic.conflict],
      };
    }
    if (!atomic.charge?.allowed || !atomic.charge.charged || !atomic.taskId) {
      const charge = atomic.charge!;
      return {
        decision: "exit",
        artifacts: [{
          kind: "repair_budget_exhausted",
          verifierTaskId: task.id,
          runId: run.id,
          budgetLimit: charge.limit,
          budgetUsed: charge.used,
          remaining: 0,
          exhaustedRootCauses: charge.exhaustedRootCauses,
          sharedRootCause: charge.sharedRootCause ?? null,
          reason: charge.reason,
        }],
      };
    }

    return {
      decision: "continue",
      artifacts: [
        {
          kind: "created_repair_task",
          taskId: atomic.taskId,
          verifierTaskId: task.id,
          ...(sourceTask ? { sourceTaskId: sourceTask.id, sourceWorktreePath } : {}),
        },
      ],
    };
  };
}

function attemptUsedDsh(input: Record<string, unknown>) {
  const route = input.route;
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    return false;
  }
  const backend = (route as Record<string, unknown>).backend;
  return Boolean(
    backend
    && typeof backend === "object"
    && !Array.isArray(backend)
    && (backend as Record<string, unknown>).kind === "dsh-cli",
  );
}

function recursiveRepairBranch(
  harness: Harness,
  verifierTask: { dependsOn: string[]; parentId: string | null },
): { repairTaskId: string; originalVerifierTaskId: string | null } | null {
  const candidateIds = new Set<string>([
    ...verifierTask.dependsOn,
    ...(verifierTask.parentId ? [verifierTask.parentId] : []),
  ]);
  for (const candidateId of candidateIds) {
    const candidate = harness.getTask(candidateId);
    if (!candidate || candidate.role !== "worker") {
      continue;
    }
    if (!candidate.goal.toLowerCase().startsWith("repair:") && !candidate.parentId) {
      continue;
    }
    const parent = candidate.parentId ? harness.getTask(candidate.parentId) : null;
    if (candidate.goal.toLowerCase().startsWith("repair:") || parent?.role === "verifier") {
      return {
        repairTaskId: candidate.id,
        originalVerifierTaskId: parent?.role === "verifier" ? parent.id : candidate.parentId,
      };
    }
  }
  return null;
}

function selectRepairSourceTasks(
  harness: Harness,
  verifierTask: { dependsOn: string[]; worktreePath: string | null },
) {
  const sources: Task[] = [];
  for (const dependencyId of verifierTask.dependsOn) {
    const dependency = harness.getTask(dependencyId);
    if (dependency && dependency.role === "worker") {
      sources.push(dependency);
    }
  }
  return sources;
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
  if (
    (haystack.includes("api call failed") ||
      haystack.includes("apiconnectionerror") ||
      haystack.includes("connection error") ||
      haystack.includes("provider connectivity")) &&
    (haystack.includes("acpx") || haystack.includes("provider") || haystack.includes("claude") || haystack.includes("codex"))
  ) {
    return "provider connectivity requires external environment change";
  }
  if (
    (haystack.includes("sigkill") || haystack.includes("exit code 137") || haystack.includes("exit 137")) &&
    (haystack.includes("typecheck") || haystack.includes("tsc") || haystack.includes("verification"))
  ) {
    return "local verification resource limit requires external environment change";
  }
  return null;
}

function buildRepairPrompt(
  template: string | undefined,
  input: {
    verifierTaskId: string;
    verifierDoneWhen: string[];
    verifierContract: Record<string, unknown> | undefined;
    sourceTaskId: string | null;
    sourceDoneWhen: string[];
    sourceWorktreePath: string | null;
    output: AttemptOutput;
  },
) {
  const verifierSummary = boundedDiagnosticText(input.output.summary, 1_200).text;
  const rootCause = latestRootCause(input.output);
  const verifierOutput = {
    ...compactAttemptEvidence(input.output),
    latestRootCause: rootCause,
    sourceTaskId: input.sourceTaskId,
    sourceWorktreePath: input.sourceWorktreePath,
  };
  const sourceSection = [
    "## Source Worktree",
    `Source Task ID: ${input.sourceTaskId ?? "not recorded"}`,
    `Source Worktree Path: ${input.sourceWorktreePath ?? "not recorded"}`,
  ].join("\n");
  const rendered = renderPromptTemplate(template ?? DEFAULT_REPAIR_TASK_PROMPT_TEMPLATE, {
    verifierTaskId: input.verifierTaskId,
    verifierSummary,
    verifierOutputJson: prettyJson(verifierOutput),
    verifierProblemsJson: prettyJson(verifierOutput.problems.items),
    sourceTaskId: input.sourceTaskId ?? "not recorded",
    sourceWorktreePath: input.sourceWorktreePath ?? "not recorded",
    sourceWorktreeSection: sourceSection,
  });
  const frozenDoneWhenSection = [
    "## Frozen Completion Criteria",
    "The repair must preserve these criteria exactly; it may not weaken or amend them.",
    "### Verifier doneWhen",
    ...input.verifierDoneWhen.map((item) => `- ${boundedDiagnosticText(item, 1_000).text}`),
    "### Source task doneWhen",
    ...(input.sourceDoneWhen.length > 0
      ? input.sourceDoneWhen.map((item) => `- ${boundedDiagnosticText(item, 1_000).text}`)
      : ["- not recorded"]),
  ].join("\n");
  const verifierContractSection = input.verifierContract
    ? ["## Frozen Verifier Contract", "```json", prettyJson(input.verifierContract), "```"].join("\n")
    : "";
  const boundedEvidenceSection = [
    "## Bounded Verifier Evidence",
    `Verifier Task ID: ${input.verifierTaskId}`,
    sourceSection,
    `Latest Root Cause: ${rootCause}`,
    "```json",
    prettyJson(verifierOutput),
    "```",
  ].join("\n");
  return fitPromptAroundFrozenSections(rendered, [
    boundedEvidenceSection,
    frozenDoneWhenSection,
    verifierContractSection,
  ]);
}

function verifierContractFromTask(task: { config?: { verifierContract?: unknown } }) {
  const value = task.config?.verifierContract;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

export function isRepairBudgetExhausted(artifact: unknown): artifact is {
  kind: "repair_budget_exhausted";
  verifierTaskId: string;
  runId: string;
  budgetLimit: number;
  budgetUsed: number;
  remaining: number;
  exhaustedRootCauses: string[];
  sharedRootCause: string | null;
  reason: string;
} {
  return (
    typeof artifact === "object" &&
    artifact !== null &&
    (artifact as Record<string, unknown>).kind === "repair_budget_exhausted"
  );
}

export { repairBudgetExhausted, type RepairBudgetChargeDecision };
