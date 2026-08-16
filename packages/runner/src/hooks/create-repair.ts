import { applyHarnessAction, DEFAULT_REPAIR_TASK_PROMPT_TEMPLATE, makeId, readableValue, type AttemptOutput, type Harness, type Task } from "@ouroboros/harness";
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
  const timedOutSemanticRepair = [...overview.tasks].reverse().find((task) => {
    if (task.role !== "worker" || task.status !== "blocked"
      || !task.config?.runtimeIntegrationSemanticRepairRecovery) return false;
    const session = [...overview.sessions].reverse().find((candidate) => candidate.taskId === task.id);
    return Boolean(session?.status === "blocked" && isBoundedRepairTimeout(session.output)
      && (session.output.changedFiles ?? []).length === 0);
  });
  if (overview.run && timedOutSemanticRepair) {
    const marker = timedOutSemanticRepair.config!.runtimeIntegrationSemanticRepairRecovery as Record<string, unknown>;
    const sourceVerifierTaskId = typeof marker.sourceVerifierTaskId === "string" ? marker.sourceVerifierTaskId : null;
    const session = [...overview.sessions].reverse().find((candidate) => candidate.taskId === timedOutSemanticRepair.id);
    if (sourceVerifierTaskId && session) {
      const result = applyHarnessAction(options.harness, {
        type: "materializeVerifierRepairRecovery",
        runId: overview.run.id,
        verifierTaskId: sourceVerifierTaskId,
        reason: "continue the same charged runtime semantic Repair after a no-write DSH timeout",
      });
      const artifact = result.artifacts.find((candidate) =>
        candidate.kind === "runtime_semantic_repair_continuation");
      if (result.status === "done" && artifact) {
        return [{
          verifierTaskId: sourceVerifierTaskId,
          verifierAttemptId: session.attemptId,
          decision: "continue",
          artifacts: [artifact],
          problems: [],
        }];
      }
      return [{
        verifierTaskId: sourceVerifierTaskId,
        verifierAttemptId: session.attemptId,
        decision: "exit",
        artifacts: result.artifacts,
        problems: result.problems,
      }];
    }
  }
  if (
    !overview.run
    || !["todo", "done", "blocked"].includes(overview.run.status)
    || overview.tasks.some((task) => task.status === "todo" || task.status === "running")
  ) {
    return [];
  }
  const timedOutRepair = [...overview.tasks].reverse().find((task) => {
    if (task.role !== "worker" || task.status !== "blocked" || !task.parentId) return false;
    const parent = overview.tasks.find((candidate) => candidate.id === task.parentId);
    if (parent?.role !== "verifier") return false;
    const session = [...overview.sessions].reverse().find((candidate) => candidate.taskId === task.id);
    return Boolean(session?.status === "blocked" && isBoundedRepairTimeout(session.output));
  });
  if (timedOutRepair) {
    return [reconcileTimedOutRepair(options.harness, overview, timedOutRepair, options.budgetLimit)];
  }
  if (overview.run.status !== "todo") {
    return [];
  }
  const verifier = [...overview.tasks]
    .reverse()
    .find((task) => {
      if (task.role !== "verifier" || (task.status !== "blocked" && task.status !== "done")) return false;
      const candidate = [...overview.sessions].reverse().find((session) => session.taskId === task.id);
      return Boolean(candidate && verifierOutputRequiresRepair(candidate.output));
    });
  if (!verifier) {
    return [];
  }
  const session = [...overview.sessions]
    .reverse()
    .find((candidate) => candidate.taskId === verifier.id && (candidate.status === "blocked" || candidate.status === "done"));
  if (!session || !verifierOutputRequiresRepair(session.output)) {
    return [];
  }
  const attempt = options.harness.getAttempt(session.attemptId);
  if (!attempt) {
    return [];
  }
  if (runtimeIntegrationSemanticRepairFailure(verifier, attempt.output)) {
    const action = applyHarnessAction(options.harness, {
      type: "materializeVerifierRepairRecovery",
      runId: options.runId,
      verifierTaskId: verifier.id,
      reason: "materialize the bounded runtime identity Repair after host evidence passed",
    });
    const conflict = action.artifacts.find((artifact) =>
      artifact.kind === "runtime_integration_frozen_evidence_conflict"
    );
    let artifacts = action.artifacts;
    if (conflict && overview.run.projectId) {
      const observedManifestSha256 = String(conflict.observedManifestSha256);
      const frozenManifestSha256 = String(conflict.frozenManifestSha256);
      const fingerprint = String(conflict.fingerprint);
      const signal = applyHarnessAction(options.harness, {
        type: "recordSignal",
        projectId: overview.run.projectId,
        sourceRunId: overview.run.id,
        signalClass: "system",
        source: `blocked-run-outcome:${overview.run.id}`,
        title: "Runtime integration frozen evidence is internally inconsistent",
        summary: "The identity-separated Verifier proved that the read-only frozen offline evidence cannot reproduce its own manifest. The delivery stopped without another model Repair or Goal Review.",
        observationTime: normalizedAttemptTimestamp(session.finishedAt),
        confidence: 1,
        evidence: [
          `run:${overview.run.id}`,
          `task:${verifier.id}`,
          `attempt:${attempt.id}`,
          `sha256:${observedManifestSha256}`,
          `sha256:${frozenManifestSha256}`,
          `sha256:${fingerprint}`,
        ],
        payload: {
          outcome: "evidence-defect",
          defectKind: "runtime-integration-frozen-evidence-conflict",
          verifierTaskId: verifier.id,
          verifierAttemptId: attempt.id,
          observedManifestSha256,
          frozenManifestSha256,
          repairBudgetUnchanged: true,
          nextStep: "new-independent-evidence-contract-designer-or-quiescence",
        },
      });
      artifacts = [...artifacts, ...signal.artifacts];
    }
    return [{
      verifierTaskId: verifier.id,
      verifierAttemptId: attempt.id,
      decision: conflict ? "exit" : action.status === "done" ? "continue" : "exit",
      artifacts,
      problems: action.problems,
    }];
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

function reconcileTimedOutRepair(
  harness: Harness,
  snapshot: ReturnType<Harness["getRunOverview"]>,
  timedOutRepair: Task,
  budgetLimit = DEFAULT_REPAIR_REPLAN_BUDGET_LIMIT,
): TerminalBlockedVerifierRepairReconciliation {
  const proposedTaskId = makeId("task");
  const snapshotSession = [...snapshot.sessions].reverse().find((candidate) => candidate.taskId === timedOutRepair.id);
  const snapshotAttempt = snapshotSession ? harness.getAttempt(snapshotSession.attemptId) : null;
  const atomic = harness.runInImmediateTransaction((db) => {
    const overview = harness.getRunOverviewWithDb(db, { runId: timedOutRepair.runId, eventLimit: 0 });
    const repair = overview.tasks.find((task) => task.id === timedOutRepair.id);
    const session = [...overview.sessions].reverse().find((candidate) => candidate.taskId === timedOutRepair.id);
    const attempt = session ? harness.getAttemptWithDb(db, session.attemptId) : null;
    const existing = overview.tasks.find((task) => task.role === "worker" && task.parentId === timedOutRepair.id);
    const storedBudget = readRepairBudget(overview.run?.context ?? {});
    const reconciled = reconcileGoalReviewRepairBudget(storedBudget, overview);
    const charge = chargeRepairBudgetState(reconciled.nextBudget, {
      limit: budgetLimit,
      taskId: timedOutRepair.id,
      attemptId: attempt?.id,
      kind: "repair",
      summary: `Recover timed out repair: ${timedOutRepair.goal}`,
      rootTaskId: timedOutRepair.parentId ?? undefined,
      rootCause: attempt ? latestRootCause(attempt.output) : "repair timeout",
    });
    if (!repair || repair.status !== "blocked" || !attempt || !isBoundedRepairTimeout(attempt.output)) {
      return { taskId: null, existing: null, charge, conflict: "timed out repair evidence changed" };
    }
    if (existing) {
      if (charge.charged || reconciled.chargedTaskIds.length > 0) {
        harness.updateRunWithDb(db, {
          runId: timedOutRepair.runId,
          contextPatch: { repairReplanBudget: charge.nextBudget },
        });
      }
      return { taskId: null, existing: charge.allowed ? existing : null, charge, conflict: null };
    }
    if (!charge.allowed || !charge.charged) {
      harness.updateRunWithDb(db, {
        runId: timedOutRepair.runId,
        contextPatch: { repairReplanBudget: charge.nextBudget },
      });
      return { taskId: null, existing: null, charge, conflict: null };
    }

    const inheritedExecutionContract = Object.fromEntries(
      ["sandbox", "permissionMode", "browserProcessPolicy", "forbidBrowser", "forbidImplementation", "hostExecutionCapabilities"]
        .flatMap((key) => attempt.input[key] === undefined ? [] : [[key, attempt.input[key]]]),
    );
    const taskId = harness.createTaskWithDb(db, {
      id: proposedTaskId,
      runId: timedOutRepair.runId,
      parentId: timedOutRepair.id,
      cycleId: timedOutRepair.cycleId,
      role: "worker",
      goal: `Recover timed out repair: ${timedOutRepair.goal}`,
      prompt: buildRepairTimeoutRecoveryPrompt(timedOutRepair, attempt.id, attempt.output),
      dependsOn: timedOutRepair.dependsOn,
      doneWhen: timedOutRepair.doneWhen,
      worktreePath: timedOutRepair.worktreePath,
      config: {
        ...inheritedExecutionContract,
        ...(timedOutRepair.config ?? {}),
        repairTimeoutRecovery: {
          sourceTaskId: timedOutRepair.id,
          sourceAttemptId: attempt.id,
          budgetUsed: charge.nextBudget.used,
          budgetLimit: charge.nextBudget.limit,
        },
      },
    });
    harness.updateRunWithDb(db, {
      runId: timedOutRepair.runId,
      status: "todo",
      contextPatch: {
        repairReplanBudget: charge.nextBudget,
        pendingVerificationTaskIds: [taskId],
        pendingVerificationReason: `bounded recovery created for timed out repair ${timedOutRepair.id}`,
      },
    });
    return { taskId, existing: null, charge, conflict: null };
  });

  const recoveryTask = atomic.existing ?? (atomic.taskId ? harness.getTask(atomic.taskId) : null);
  const originalVerifierId = timedOutRepair.parentId ?? "unknown";
  if (recoveryTask) {
    return {
      verifierTaskId: originalVerifierId,
      verifierAttemptId: snapshotAttempt?.id ?? "unknown",
      decision: recoveryTask.status === "todo" || recoveryTask.status === "running" ? "continue" : "exit",
      artifacts: [{
        kind: "created_repair_timeout_recovery",
        taskId: recoveryTask.id,
        sourceRepairTaskId: timedOutRepair.id,
        sourceRepairAttemptId: snapshotAttempt?.id ?? null,
        sourceWorktreePath: timedOutRepair.worktreePath,
        reused: Boolean(atomic.existing),
        budgetUsed: atomic.charge.nextBudget.used,
        budgetLimit: atomic.charge.nextBudget.limit,
      }],
      problems: [],
    };
  }
  return {
    verifierTaskId: originalVerifierId,
    verifierAttemptId: snapshotAttempt?.id ?? "unknown",
    decision: "exit",
    artifacts: [{
      kind: atomic.conflict ? "repair_timeout_recovery_conflict" : "repair_budget_exhausted",
      sourceRepairTaskId: timedOutRepair.id,
      reason: atomic.conflict ?? atomic.charge.reason,
      budgetUsed: atomic.charge.nextBudget.used,
      budgetLimit: atomic.charge.nextBudget.limit,
    }],
    problems: atomic.conflict ? [atomic.conflict] : [],
  };
}

function buildRepairTimeoutRecoveryPrompt(task: Task, attemptId: string, output: AttemptOutput) {
  const rootCause = boundedDiagnosticText(latestRootCause(output), 2_000).text;
  const frozenContract = [
    "## Frozen Timed Repair Recovery",
    `Source repair task: ${task.id}`,
    `Source repair attempt: ${attemptId}`,
    `Source worktree: ${task.worktreePath ?? "not recorded"}`,
    "Continue only the existing repair. Do not replan, weaken verification, or broaden permissions.",
    "## Frozen Completion Criteria",
    ...task.doneWhen.map((item) => `- ${item}`),
    "## Frozen Task Configuration",
    "```json",
    prettyJson(task.config ?? {}),
    "```",
  ].join("\n");
  const prompt = [
    `Recover the timed out repair ${task.id} in its existing worktree.`,
    `Latest bounded failure: ${rootCause}`,
    "Return structured changedFiles, checks, artifacts, and problems. A new independent verifier will run after this task succeeds.",
  ].join("\n");
  return fitPromptAroundFrozenSections(prompt, [frozenContract]);
}

function isBoundedRepairTimeout(output: AttemptOutput) {
  const text = [output.summary, ...(output.problems ?? [])].join("\n").toLowerCase();
  return text.includes("timed out") || text.includes("timeout") || text.includes("exit code 124") || text.includes("exit 124");
}

export function createRepairTaskHook(options: {
  harness: Harness;
  budgetLimit?: number;
}): StopHook {
  const budgetLimit = options.budgetLimit ?? DEFAULT_REPAIR_REPLAN_BUDGET_LIMIT;
  return ({ run, task, output }) => {
    if (task.role !== "verifier" || !verifierOutputRequiresRepair(output)) {
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
    if (runtimeIntegrationHostEvidenceFailure(task, output)) {
      return {
        decision: "exit",
        artifacts: [{
          kind: "runtime_integration_host_evidence_recovery_required",
          verifierTaskId: task.id,
          reason: "Docker, PostgreSQL, and loopback HTTP evidence must be collected by the bounded host action",
        }],
      };
    }
    if (runtimeIntegrationSemanticRepairFailure(task, output)) {
      return {
        decision: "exit",
        artifacts: [{
          kind: "runtime_integration_semantic_repair_recovery_required",
          verifierTaskId: task.id,
          reason: "host evidence passed and one frozen runtime identity Repair must be materialized after this attempt is durable",
        }],
      };
    }
    const hostMaterialization = hostArtifactMaterializationReason(options.harness, task);
    if (hostMaterialization) {
      return {
        decision: "exit",
        artifacts: [{
          kind: "repair_skipped_host_artifact_materialization",
          verifierTaskId: task.id,
          reason: hostMaterialization,
        }],
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
    const inheritedDshConfig = sourceTask ? inheritedDshRepairConfig(sourceTask.config ?? {}) : {};
    const repairConfig = {
      ...inheritedDshConfig,
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

function runtimeIntegrationHostEvidenceFailure(task: Task, output: AttemptOutput) {
  const contract = task.config?.runtimeIntegrationExecutionContract;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)
    || (contract as Record<string, unknown>).stageId !== "non-browser-e2e") return false;
  const text = [output.summary, ...(output.problems ?? [])].join("\n");
  return output.verdict === "fail"
    && (output.changedFiles ?? []).length === 0
    && [
      "REAL_POSTGRES_EVIDENCE_UNAVAILABLE",
      "REAL_LOOPBACK_HTTP_EVIDENCE_UNAVAILABLE",
      "END_TO_END_BINDING_INCOMPLETE",
    ].every((code) => text.includes(code));
}

function runtimeIntegrationSemanticRepairFailure(task: Task, output: AttemptOutput) {
  const hostRecovery = task.config?.runtimeIntegrationHostEvidenceRecovery;
  if (!hostRecovery || typeof hostRecovery !== "object" || Array.isArray(hostRecovery)) return false;
  const text = [output.summary, ...(output.problems ?? []), ...(output.checks ?? [])]
    .map((value) => readableValue(value))
    .join("\n");
  return output.verdict === "fail"
    && (output.changedFiles ?? []).length === 0
    && (text.includes("FROZEN_DELIVERY_CONTRACT_MISMATCH")
      || text.includes("FROZEN_OFFLINE_CONTRACT_CHECKS_FAILED"));
}

function normalizedAttemptTimestamp(value: string | null | undefined) {
  if (!value) return new Date().toISOString();
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const timestamp = new Date(normalized);
  return Number.isNaN(timestamp.valueOf()) ? new Date().toISOString() : timestamp.toISOString();
}

function inheritedDshRepairConfig(config: Record<string, unknown>) {
  if (config.agentBackend !== "deepseek-harness") return {};
  return Object.fromEntries([
    "agentBackend",
    "permissionMode",
    "dshProfileIsolation",
    "dshRequiredPlugins",
    "dshModelTransport",
    "dshToolNetwork",
    "dshFilePolicy",
    "offlineTestPolicy",
    "forbidBrowser",
    "browserProcessPolicy",
    "sourceWorktreePath",
    "designDeliveryRecovery",
    "designWorkerRuntimeRecovery",
    "designWorkerTransportRecovery",
  ].flatMap((key) => config[key] === undefined ? [] : [[key, config[key]]]));
}

export function verifierOutputRequiresRepair(output: AttemptOutput): boolean {
  if (output.status === "blocked" || output.verdict === "fail") return true;
  const failedCheck = (output.checks ?? []).some((check) => {
    if (!check || typeof check !== "object" || Array.isArray(check)) return false;
    return (check as Record<string, unknown>).status === "failed";
  });
  const priorityProblem = (output.problems ?? []).some((problem) => /^P[0-3]\s*:/i.test(problem.trim()));
  if (failedCheck || priorityProblem || /fail-closed/i.test(output.summary)) return true;
  return output.verdict !== "pass";
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

function hostArtifactMaterializationReason(
  harness: Harness,
  verifierTask: { dependsOn: string[] },
) {
  for (const dependencyId of verifierTask.dependsOn) {
    const sourceTask = harness.getTask(dependencyId);
    if (!sourceTask || sourceTask.role !== "worker") continue;
    const sourceSession = [...harness.getRunOverview({ runId: sourceTask.runId, eventLimit: 0 }).sessions]
      .reverse()
      .find((candidate) => candidate.taskId === sourceTask.id && candidate.status === "done");
    const sourceAttempt = sourceSession ? harness.getAttempt(sourceSession.attemptId) : null;
    if (!sourceAttempt) continue;
    const retrieval = (sourceAttempt.output.artifacts ?? []).find((artifact) => {
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return false;
      return (artifact as Record<string, unknown>).kind === "retrievalEvidence";
    }) as Record<string, unknown> | undefined;
    if (
      retrieval
      && typeof retrieval.sourceWorkerAttemptId === "string"
      && typeof retrieval.targetWorktreeControlDatabaseRead === "string"
      && retrieval.targetWorktreeControlDatabaseRead.length > 0
    ) {
      return "host-owned attempt artifact materialization is required; model repair cannot authorize control-database evidence";
    }
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
