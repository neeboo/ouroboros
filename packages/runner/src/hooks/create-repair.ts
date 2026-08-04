import { DEFAULT_REPAIR_TASK_PROMPT_TEMPLATE, readableValue, type AttemptOutput, type Harness } from "@ouroboros/harness";
import { prettyJson, renderPromptTemplate } from "../template";
import type { StopHook } from "../types";
import { chargeRepairBudget, repairBudgetExhausted, type RepairBudgetChargeDecision } from "./repair-budget";

export const DEFAULT_REPAIR_REPLAN_BUDGET_LIMIT = 3;

export function createRepairTaskHook(options: {
  harness: Harness;
  budgetLimit?: number;
}): StopHook {
  const budgetLimit = options.budgetLimit ?? DEFAULT_REPAIR_REPLAN_BUDGET_LIMIT;
  return ({ run, task, output }) => {
    if (task.role !== "verifier" || output.status !== "blocked") {
      return { decision: "exit" };
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

    const charge = chargeRepairBudget(options.harness, run.id, {
      limit: budgetLimit,
      taskId: task.id,
      attemptId: (output.artifacts?.find((artifact) => (artifact as Record<string, unknown>).attemptId) as
        | Record<string, unknown>
        | undefined)?.attemptId as string | undefined,
      kind: "repair",
      summary: `Repair: ${task.goal}`,
    });
    if (!charge.allowed) {
      return {
        decision: "exit",
        artifacts: [
          {
            kind: "repair_budget_exhausted",
            verifierTaskId: task.id,
            runId: run.id,
            budgetLimit: charge.limit,
            budgetUsed: charge.used,
            remaining: 0,
            exhaustedRootCauses: charge.exhaustedRootCauses,
            sharedRootCause: charge.sharedRootCause ?? null,
            reason: charge.reason,
          },
        ],
        problems: [
          `Repair budget exhausted (${charge.used}/${charge.limit}): ${charge.reason}`,
          ...(charge.exhaustedRootCauses.length > 0
            ? [`exhausted root causes: ${charge.exhaustedRootCauses.join(", ")}`]
            : []),
        ],
      };
    }

    const sourceTask = selectRepairSourceTask(options.harness, task);
    const sourceWorktreePath = sourceTask?.worktreePath ?? task.worktreePath ?? null;
    const taskId = options.harness.createTask({
      runId: run.id,
      parentId: task.id,
      role: "worker",
      goal: `Repair: ${task.goal}`,
      prompt: buildRepairPrompt(
        options.harness.getPromptTemplate("repair-task")?.contentMd,
        task.id,
        sourceTask?.id ?? null,
        sourceWorktreePath,
        output,
      ),
      dependsOn: sourceTask ? [sourceTask.id] : [],
      worktreePath: sourceWorktreePath,
      doneWhen: [
        "verifier problems are addressed",
        "relevant checks pass",
        "the repair output describes changed files and validation",
      ],
    });
    if (charge.charged) {
      options.harness.updateRun({
        runId: run.id,
        contextPatch: {
          repairReplanBudget: charge.nextBudget,
        },
      });
    }

    return {
      decision: "continue",
      artifacts: [
        {
          kind: "created_repair_task",
          taskId,
          verifierTaskId: task.id,
          ...(sourceTask ? { sourceTaskId: sourceTask.id, sourceWorktreePath } : {}),
        },
      ],
    };
  };
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

function selectRepairSourceTask(
  harness: Harness,
  verifierTask: { dependsOn: string[]; worktreePath: string | null },
) {
  for (const dependencyId of verifierTask.dependsOn) {
    const dependency = harness.getTask(dependencyId);
    if (dependency && dependency.role === "worker" && dependency.worktreePath) {
      return dependency;
    }
  }
  return null;
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
  verifierTaskId: string,
  sourceTaskId: string | null,
  sourceWorktreePath: string | null,
  output: AttemptOutput,
) {
  const verifierSummary = readableValue(output.summary);
  const verifierOutput = {
    summary: verifierSummary,
    changedFiles: output.changedFiles ?? [],
    checks: output.checks ?? [],
    artifacts: output.artifacts ?? [],
    problems: output.problems ?? [],
    sourceTaskId,
    sourceWorktreePath,
  };
  const sourceSection = [
    "## Source Worktree",
    `Source Task ID: ${sourceTaskId ?? "not recorded"}`,
    `Source Worktree Path: ${sourceWorktreePath ?? "not recorded"}`,
  ].join("\n");
  const rendered = renderPromptTemplate(template ?? DEFAULT_REPAIR_TASK_PROMPT_TEMPLATE, {
    verifierTaskId,
    verifierSummary,
    verifierOutputJson: prettyJson(verifierOutput),
    verifierProblemsJson: prettyJson(output.problems ?? []),
    sourceTaskId: sourceTaskId ?? "not recorded",
    sourceWorktreePath: sourceWorktreePath ?? "not recorded",
    sourceWorktreeSection: sourceSection,
  });
  if (rendered.includes(sourceSection)) {
    return rendered;
  }
  return `${rendered}\n\n${sourceSection}`;
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
