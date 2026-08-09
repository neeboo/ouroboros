import {
  applyHarnessAction,
  describeIntegrationReadiness,
  type Harness,
  type RunOverview,
} from "@ouroboros/harness";
import { DEFAULT_REPAIR_REPLAN_BUDGET_LIMIT } from "./hooks/create-repair";
import { chargeRepairBudget, readRepairBudget } from "./hooks/repair-budget";

type ScopedRun = ReturnType<Harness["listRuns"]>[number];
type HarnessActionEvent = ReturnType<Harness["getHarnessActionEvent"]>;

export type TerminalDesignReconciliationResult = {
  blocksAssessment: boolean;
  state: "clear" | "integrated" | "repairing" | "exhausted";
  proposalId?: string;
  deliveryRunId?: string;
  reconciliationTaskId?: string;
  repairTaskId?: string;
  actionEventId?: string;
  attemptId?: string;
  reason: string;
};

export function reconcileTerminalDesignDeliveries(input: {
  harness: Harness;
  rootRunId: string;
  runs: ScopedRun[];
}): TerminalDesignReconciliationResult {
  for (const run of input.runs) {
    if (run.id === input.rootRunId) {
      continue;
    }
    const proposalId = typeof run.context.designProposalId === "string" ? run.context.designProposalId : null;
    if (!proposalId) {
      continue;
    }
    const proposal = input.harness.getDesignProposal({ id: proposalId });
    if (!proposal || proposal.status !== "accepted") {
      continue;
    }

    const currentMarker = reconciliationMarker(run.context, run.id, proposalId);
    const currentRepair = currentMarker?.repairTaskId ? input.harness.getTask(currentMarker.repairTaskId) : null;
    if (currentRepair?.status === "todo" || currentRepair?.status === "running") {
      return {
        blocksAssessment: true,
        state: "repairing",
        proposalId,
        deliveryRunId: run.id,
        reconciliationTaskId: currentMarker?.reconciliationTaskId,
        repairTaskId: currentRepair.id,
        reason: "bounded reconciliation repair already active",
      };
    }
    if (!isTerminal(run.status)) {
      continue;
    }

    const receipt = successfulIntegrationReceipt(input.harness, run.id);
    if (receipt) {
      const workerTaskId = workerTaskIdForReceipt(receipt);
      const reconciliationTask = findOrCreateReconciliationTask({
        harness: input.harness,
        run,
        proposalId,
        workerTaskId,
      });
      const completion = completeReconciliationTask(input.harness, reconciliationTask.id, receipt.id);
      input.harness.linkProposalOutcomeReview({ runId: run.id, immediateProxyReview: true });
      persistIntegratedState({
        harness: input.harness,
        run,
        proposalId,
        reconciliationTaskId: reconciliationTask.id,
        actionEventId: receipt.id,
        completionAttemptId: completion.attemptId,
        integrationArtifact: matchingIntegrationArtifact(receipt, run.id, workerTaskId),
      });
      return {
        blocksAssessment: true,
        state: "integrated",
        proposalId,
        deliveryRunId: run.id,
        reconciliationTaskId: reconciliationTask.id,
        actionEventId: receipt.id,
        ...(completion.attemptId ? { attemptId: completion.attemptId } : {}),
        reason: "historical audited integration receipt reconciled",
      };
    }

    const overview = input.harness.getRunOverview({ runId: run.id, eventLimit: 0 });
    const readiness = describeIntegrationReadiness(input.harness, run.id);
    if (readiness.unintegrated.length > 0) {
      const candidate = readiness.unintegrated[0]!;
      const reconciliationTask = findOrCreateReconciliationTask({
        harness: input.harness,
        run,
        proposalId,
        workerTaskId: candidate.taskId,
      });
      const action = applyHarnessAction(input.harness, {
        type: "integrateVerifiedRun",
        runId: run.id,
        workerTaskId: candidate.taskId,
        ...(run.projectRoot ? { repoPath: run.projectRoot } : {}),
        targetBranch: integrationTargetBranch(run.context),
        push: false,
        immediateOutcomeReview: true,
        reason: `terminal design reconciliation for accepted proposal ${proposalId}`,
      });
      const event = input.harness.getHarnessActionEvent({ id: action.eventId });
      const artifact = matchingIntegrationArtifact(event, run.id, candidate.taskId);
      if (action.status === "done" && event?.status === "done" && artifact) {
        const completion = completeReconciliationTask(input.harness, reconciliationTask.id, action.eventId);
        persistIntegratedState({
          harness: input.harness,
          run,
          proposalId,
          reconciliationTaskId: reconciliationTask.id,
          actionEventId: action.eventId,
          completionAttemptId: completion.attemptId,
          integrationArtifact: artifact,
        });
        return {
          blocksAssessment: true,
          state: "integrated",
          proposalId,
          deliveryRunId: run.id,
          reconciliationTaskId: reconciliationTask.id,
          actionEventId: action.eventId,
          ...(completion.attemptId ? { attemptId: completion.attemptId } : {}),
          reason: "verified terminal delivery integrated through an audited action",
        };
      }
      if (event) {
        completeReconciliationTask(input.harness, reconciliationTask.id, action.eventId);
      }
      return createRepairOrTerminalDisposition({
        harness: input.harness,
        run,
        proposalId,
        reconciliationTaskId: reconciliationTask.id,
        failure: reconciliationFailureEvidence(overview, action, action.eventId),
      });
    }

    const existing = reconciliationMarker(run.context, run.id, proposalId);
    const existingRepair = existing?.repairTaskId ? input.harness.getTask(existing.repairTaskId) : null;
    if (existingRepair) {
      const budget = readRepairBudget(run.context);
      if (budget.used >= budget.limit) {
        return persistExhaustedDisposition({
          harness: input.harness,
          run,
          proposalId,
          reconciliationTaskId: existing?.reconciliationTaskId,
          failure: reconciliationFailureEvidence(overview, null, null),
        }, budget.used, budget.limit);
      }
      return {
        blocksAssessment: true,
        state: "repairing",
        proposalId,
        deliveryRunId: run.id,
        reconciliationTaskId: existing?.reconciliationTaskId,
        repairTaskId: existingRepair.id,
        reason: existingRepair.status === "todo" || existingRepair.status === "running"
          ? "bounded reconciliation repair already active"
          : "terminal reconciliation repair awaits the bounded recovery controller",
      };
    }

    return createRepairOrTerminalDisposition({
      harness: input.harness,
      run,
      proposalId,
      reconciliationTaskId: existing?.reconciliationTaskId,
      failure: reconciliationFailureEvidence(overview, null, null),
    });
  }

  return {
    blocksAssessment: false,
    state: "clear",
    reason: "no unresolved accepted terminal design delivery",
  };
}

function createRepairOrTerminalDisposition(input: {
  harness: Harness;
  run: ScopedRun;
  proposalId: string;
  reconciliationTaskId?: string;
  failure: ReturnType<typeof reconciliationFailureEvidence>;
}): TerminalDesignReconciliationResult {
  const budget = readRepairBudget(input.run.context);
  if (budget.used >= budget.limit) {
    return persistExhaustedDisposition(input, budget.used, budget.limit);
  }

  const charge = chargeRepairBudget(input.harness, input.run.id, {
    limit: DEFAULT_REPAIR_REPLAN_BUDGET_LIMIT,
    taskId: input.failure.sourceTaskId ?? input.reconciliationTaskId ?? input.run.id,
    ...(input.failure.sourceAttemptId ? { attemptId: input.failure.sourceAttemptId } : {}),
    kind: "repair",
    summary: `Terminal design reconciliation repair for proposal ${input.proposalId}`,
    rootTaskId: input.failure.sourceWorkerTaskId ?? input.failure.sourceTaskId ?? input.reconciliationTaskId ?? input.run.id,
    rootCause: "terminal-design-reconciliation",
  });
  if (!charge.allowed) {
    return persistExhaustedDisposition(input, charge.nextBudget.used, charge.nextBudget.limit);
  }

  const repairTaskId = input.harness.createTask({
    runId: input.run.id,
    ...(input.reconciliationTaskId ? { parentId: input.reconciliationTaskId } : {}),
    role: "worker",
    goal: `Repair terminal design delivery for proposal ${input.proposalId}`,
    prompt: [
      "Repair the unresolved terminal accepted design delivery in its recorded source worktree.",
      `Proposal: ${input.proposalId}`,
      `Delivery run: ${input.run.id}`,
      `Failure evidence: ${JSON.stringify(input.failure)}`,
      "Preserve the original goal, evaluation, verifier, retry, worktree, permissions, completion, and integration contracts.",
      "Do not claim integration until the frozen verifier passes and integrateVerifiedRun records its audited receipt.",
    ].join("\n"),
    worktreePath: input.failure.sourceWorktreePath,
    doneWhen: [
      "the recorded terminal failure is addressed",
      "the frozen deterministic checks pass",
      "changed files and verification evidence are returned",
    ],
    config: {
      terminalDesignReconciliation: {
        kind: "terminal-design-reconciliation",
        proposalId: input.proposalId,
        deliveryRunId: input.run.id,
        reconciliationTaskId: input.reconciliationTaskId ?? null,
        failureEvidence: input.failure,
      },
      ...(input.failure.sourceWorktreePath ? { sourceWorktreePath: input.failure.sourceWorktreePath } : {}),
      ...reconciliationContracts(input.run.context),
    },
  });
  input.harness.updateRun({
    runId: input.run.id,
    status: "todo",
    contextPatch: {
      repairReplanBudget: charge.nextBudget,
      terminalDesignReconciliation: {
        kind: "terminal-design-reconciliation",
        proposalId: input.proposalId,
        deliveryRunId: input.run.id,
        state: "repairing",
        reconciliationTaskId: input.reconciliationTaskId ?? null,
        repairTaskId,
        failureEvidence: input.failure,
        contracts: reconciliationContracts(input.run.context),
      },
    },
  });
  return {
    blocksAssessment: true,
    state: "repairing",
    proposalId: input.proposalId,
    deliveryRunId: input.run.id,
    ...(input.reconciliationTaskId ? { reconciliationTaskId: input.reconciliationTaskId } : {}),
    repairTaskId,
    reason: charge.reason,
  };
}

function persistExhaustedDisposition(
  input: {
    harness: Harness;
    run: ScopedRun;
    proposalId: string;
    reconciliationTaskId?: string;
    failure: ReturnType<typeof reconciliationFailureEvidence>;
  },
  used: number,
  limit: number,
): TerminalDesignReconciliationResult {
  const marker = {
    kind: "terminal-design-reconciliation",
    proposalId: input.proposalId,
    deliveryRunId: input.run.id,
    state: "exhausted",
    reconciliationTaskId: input.reconciliationTaskId ?? null,
    terminalDisposition: "repair-budget-exhausted",
    repairBudget: { used, limit },
    failureEvidence: input.failure,
    contracts: reconciliationContracts(input.run.context),
  };
  const action = applyHarnessAction(input.harness, {
    type: "updateRunContext",
    runId: input.run.id,
    contextPatch: { terminalDesignReconciliation: marker },
    reason: `record bounded terminal design disposition for proposal ${input.proposalId}`,
  });
  const markerWithAction = { ...marker, actionEventId: action.eventId };
  input.harness.updateRun({
    runId: input.run.id,
    contextPatch: { terminalDesignReconciliation: markerWithAction },
  });
  input.harness.updateDesignProposalStatus({ proposalId: input.proposalId, status: "revise" });
  const completion = input.reconciliationTaskId
    ? completeReconciliationTask(input.harness, input.reconciliationTaskId, action.eventId)
    : { attemptId: null };
  return {
    blocksAssessment: true,
    state: "exhausted",
    proposalId: input.proposalId,
    deliveryRunId: input.run.id,
    ...(input.reconciliationTaskId ? { reconciliationTaskId: input.reconciliationTaskId } : {}),
    actionEventId: action.eventId,
    ...(completion.attemptId ? { attemptId: completion.attemptId } : {}),
    reason: `repair budget exhausted at ${used}/${limit}`,
  };
}

function persistIntegratedState(input: {
  harness: Harness;
  run: ScopedRun;
  proposalId: string;
  reconciliationTaskId: string;
  actionEventId: string;
  completionAttemptId: string | null;
  integrationArtifact: Record<string, unknown> | null;
}) {
  input.harness.updateRun({
    runId: input.run.id,
    contextPatch: {
      terminalDesignReconciliation: {
        kind: "terminal-design-reconciliation",
        proposalId: input.proposalId,
        deliveryRunId: input.run.id,
        state: "integrated",
        reconciliationTaskId: input.reconciliationTaskId,
        actionEventId: input.actionEventId,
        completionAttemptId: input.completionAttemptId,
        integrationArtifact: input.integrationArtifact,
        contracts: reconciliationContracts(input.run.context),
      },
    },
  });
}

function findOrCreateReconciliationTask(input: {
  harness: Harness;
  run: ScopedRun;
  proposalId: string;
  workerTaskId: string | null;
}) {
  const overview = input.harness.getRunOverview({ runId: input.run.id, eventLimit: 0 });
  const existing = overview.tasks.find((task) => {
    const marker = recordValue(task.config?.terminalDesignReconciliation);
    return task.role === "system" &&
      marker.proposalId === input.proposalId &&
      marker.deliveryRunId === input.run.id;
  });
  if (existing) {
    return existing;
  }
  const sourceTask = input.workerTaskId ? input.harness.getTask(input.workerTaskId) : null;
  const taskId = input.harness.createTask({
    runId: input.run.id,
    role: "system",
    goal: `Reconcile terminal design delivery for proposal ${input.proposalId}`,
    prompt: [
      "Reconcile this terminal accepted design delivery through audited harness actions.",
      `Proposal: ${input.proposalId}`,
      `Delivery run: ${input.run.id}`,
      `Worker candidate: ${input.workerTaskId ?? "none"}`,
      "Do not weaken frozen contracts or treat run status and goal-review prose as integration proof.",
    ].join("\n"),
    doneWhen: [
      "one matching audited integration receipt exists or a bounded terminal disposition is recorded",
      "the proposal is measuring after integration or revise after delivery exhaustion",
      "no duplicate reconciliation repair or outcome review exists",
    ],
    worktreePath: sourceTask?.worktreePath ?? null,
    config: {
      terminalDesignReconciliation: {
        kind: "terminal-design-reconciliation",
        proposalId: input.proposalId,
        deliveryRunId: input.run.id,
        workerTaskId: input.workerTaskId,
      },
      ...reconciliationContracts(input.run.context),
    },
  });
  input.harness.updateRun({
    runId: input.run.id,
    contextPatch: {
      terminalDesignReconciliation: {
        kind: "terminal-design-reconciliation",
        proposalId: input.proposalId,
        deliveryRunId: input.run.id,
        state: "reconciling",
        reconciliationTaskId: taskId,
        contracts: reconciliationContracts(input.run.context),
      },
    },
  });
  return input.harness.getTask(taskId)!;
}

function completeReconciliationTask(harness: Harness, taskId: string, actionEventId: string) {
  const task = harness.getTask(taskId);
  if (task?.status === "done") {
    const latest = harness.listLatestAttemptsForTasks([taskId])[0];
    return { attemptId: latest?.attemptId ?? null };
  }
  const completion = applyHarnessAction(harness, {
    type: "completeSystemTask",
    taskId,
    actionEventId,
    reason: "bind terminal design reconciliation to its audited action",
  });
  const attempt = completion.artifacts.find((artifact) => artifact.kind === "attempt");
  return { attemptId: typeof attempt?.attemptId === "string" ? attempt.attemptId : null };
}

function successfulIntegrationReceipt(harness: Harness, runId: string) {
  return harness.listHarnessActionEvents({ limit: 1000 }).find((event) => {
    if (event.status !== "done" || (event.actionType !== "integrateVerifiedRun" && event.actionType !== "commitExactGitIndex")) {
      return false;
    }
    if (event.request.runId !== runId) {
      return false;
    }
    return matchingIntegrationArtifact(event, runId, workerTaskIdForReceipt(event)) !== null;
  }) ?? null;
}

function workerTaskIdForReceipt(event: NonNullable<HarnessActionEvent>) {
  const value = event.actionType === "commitExactGitIndex" ? event.request.taskId : event.request.workerTaskId;
  return typeof value === "string" ? value : null;
}

function matchingIntegrationArtifact(
  event: HarnessActionEvent,
  runId: string,
  workerTaskId: string | null,
): Record<string, unknown> | null {
  if (!event || !workerTaskId) {
    return null;
  }
  const allowedModes = event.actionType === "commitExactGitIndex"
    ? new Set(["exact_git_index_commit"])
    : new Set(["branch_merge", "contained_worker_commit", "materialized_target_commit"]);
  const artifacts = Array.isArray(event.result.artifacts) ? event.result.artifacts : [];
  for (const artifact of artifacts) {
    const record = recordValue(artifact);
    if (record.kind === "integration" &&
      record.runId === runId &&
      record.workerTaskId === workerTaskId &&
      typeof record.mode === "string" &&
      allowedModes.has(record.mode)) {
      return record;
    }
  }
  return null;
}

function reconciliationFailureEvidence(
  overview: RunOverview,
  action: { summary?: string; checks?: unknown[]; artifacts?: unknown[]; problems?: string[] } | null,
  actionEventId: string | null,
) {
  const terminalSession = [...overview.sessions].reverse().find((session) => session.status === "blocked") ?? null;
  const sourceTask = terminalSession
    ? overview.tasks.find((task) => task.id === terminalSession.taskId) ?? null
    : [...overview.tasks].reverse().find((task) => task.status === "blocked") ?? null;
  const sourceWorker = sourceTask?.role === "verifier"
    ? [...sourceTask.dependsOn]
      .map((taskId) => overview.tasks.find((task) => task.id === taskId))
      .find((task) => task?.role === "worker") ?? sourceTask
    : sourceTask;
  return {
    sourceTaskId: sourceTask?.id ?? null,
    sourceWorkerTaskId: sourceWorker?.id ?? null,
    sourceAttemptId: terminalSession?.attemptId ?? null,
    sourceWorktreePath: sourceWorker?.worktreePath ?? sourceTask?.worktreePath ?? terminalSession?.worktreePath ?? null,
    summary: terminalSession?.output.summary ?? action?.summary ?? "Terminal delivery has no audited integration-ready evidence.",
    changedFiles: terminalSession?.output.changedFiles ?? [],
    checks: terminalSession?.output.checks ?? action?.checks ?? [],
    artifacts: terminalSession?.output.artifacts ?? action?.artifacts ?? [],
    problems: terminalSession?.output.problems ?? action?.problems ?? ["integration evidence is missing or failed"],
    actionEventId,
  };
}

function reconciliationMarker(context: Record<string, unknown>, deliveryRunId: string, proposalId: string) {
  const marker = recordValue(context.terminalDesignReconciliation);
  if (marker.deliveryRunId !== deliveryRunId || marker.proposalId !== proposalId) {
    return null;
  }
  return marker as { reconciliationTaskId?: string; repairTaskId?: string; state?: string };
}

function reconciliationContracts(context: Record<string, unknown>) {
  return Object.fromEntries(
    [
      "goalContract",
      "designEvaluationContract",
      "verifierContract",
      "integrationBoundary",
      "permissions",
      "completionCriteria",
      "retryBudget",
      "repairReplanBudget",
      "permissionProfile",
      "sandbox",
    ]
      .filter((key) => context[key] !== undefined)
      .map((key) => [key, context[key]]),
  );
}

function integrationTargetBranch(context: Record<string, unknown>) {
  return "main";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isTerminal(status: string) {
  return status === "done" || status === "blocked";
}
