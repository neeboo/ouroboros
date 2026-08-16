import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyHarnessAction, canonicalEvolutionValueSha256, Harness } from "../packages/harness/src";
import { createTasksFromOutputHook, reconcileAdditiveEvidenceContract } from "../packages/runner/src";

describe("additive evidence-contract delivery", () => {
  let dir: string;
  let harness: Harness;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-additive-evidence-"));
    harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("fixed recovery retires bare tasks and materializes one host overlay followed by one read-only verifier", () => {
    const fixture = seedAdditiveDelivery(harness, dir, true);
    const badWorkerId = fixture.badWorkerId!;
    const badVerifierId = fixture.badVerifierId!;

    expect(() => harness.assertTaskExecutionAllowed({ taskId: badWorkerId }))
      .toThrow("additive evidence-contract execution contract is missing");
    expect(() => harness.assertTaskExecutionAllowed({ taskId: badVerifierId }))
      .toThrow("additive evidence-contract execution contract is missing");

    const result = applyHarnessAction(harness, {
      type: "materializeAdditiveEvidenceContractRecovery",
      runId: fixture.deliveryRunId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);
    const replay = applyHarnessAction(harness, {
      type: "materializeAdditiveEvidenceContractRecovery",
      runId: fixture.deliveryRunId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);

    expect(result).toMatchObject({ status: "done", actionType: "materializeAdditiveEvidenceContractRecovery" });
    expect(replay).toMatchObject({ status: "done", eventId: result.eventId });
    expect(harness.getTask(badWorkerId)?.status).toBe("blocked");
    expect(harness.getTask(badVerifierId)?.status).toBe("blocked");

    const overview = harness.getRunOverview({ runId: fixture.deliveryRunId, eventLimit: 0 });
    const systemTask = overview.tasks.find((task) => task.config?.additiveEvidenceContractOverlay);
    const verifierTask = overview.tasks.find((task) => task.config?.additiveEvidenceContractVerifier);
    expect(systemTask).toMatchObject({
      role: "system",
      status: "todo",
      parentId: fixture.plannerTaskId,
      dependsOn: [fixture.plannerTaskId],
      config: {
        systemTask: true,
        executor: "host-fixed-action",
        permissionMode: "host-control-plane",
        repositoryId: "ouroboros-control-plane",
        forbidBrowser: true,
        browserProcessPolicy: "deny",
        forbidNextTasks: true,
        forbidNextRuns: true,
      },
    });
    expect(verifierTask).toMatchObject({
      role: "verifier",
      status: "todo",
      parentId: fixture.plannerTaskId,
      dependsOn: [systemTask!.id],
      config: {
        executor: "codex-resumable",
        permissionMode: "read-only",
        repositoryId: "ouroboros-control-plane",
        readOnly: true,
        forbidImplementation: true,
        forbidBrowser: true,
        browserProcessPolicy: "deny",
        forbidNextTasks: true,
        forbidNextRuns: true,
      },
    });
    const statusById = new Map(overview.tasks.map((task) => [task.id, task.status]));
    const readyIds = overview.tasks.filter((task) => task.status === "todo"
      && task.dependsOn.every((dependencyId) => statusById.get(dependencyId) === "done"))
      .map((task) => task.id);
    expect(readyIds).toEqual([systemTask!.id]);
    expect(overview.tasks.some((task) => task.role === "goal-review")).toBe(false);
    expect(overview.run?.context).toMatchObject({
      repairReplanBudget: { used: 0, limit: 3, entries: [] },
      additiveEvidenceContractTaskGraph: {
        plannerTaskId: fixture.plannerTaskId,
        systemTaskId: systemTask!.id,
        verifierTaskId: verifierTask!.id,
        bundleSha256: fixture.bundleSha256,
      },
    });
    expect(() => harness.assertTaskExecutionAllowed({ taskId: systemTask!.id })).toThrow("host-fixed-action");
    expect(harness.assertTaskExecutionAllowed({ taskId: verifierTask!.id })).toBe(true);
    const drain = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId: fixture.deliveryRunId,
      maxTries: 3,
    });
    expect(drain).toMatchObject({
      status: "done",
      artifacts: [expect.objectContaining({ kind: "additive_evidence_contract_pending" })],
    });
    expect(harness.getRunOverview({ runId: fixture.deliveryRunId, eventLimit: 0 }).tasks
      .some((task) => task.role === "goal-review")).toBe(false);
    expect(applyHarnessAction(harness, {
      type: "updateRunContext",
      runId: fixture.deliveryRunId,
      contextPatch: { additiveEvidenceContractOverlay: { forged: true } },
      reason: "attempt to overwrite the frozen overlay",
    })).toMatchObject({ status: "blocked" });
  });

  test("rejects graph tasks that are outside the frozen additive contract", () => {
    const fixture = seedAdditiveDelivery(harness, dir);
    applyHarnessAction(harness, {
      type: "materializeAdditiveEvidenceContractRecovery",
      runId: fixture.deliveryRunId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);

    expect(() => harness.createTask({
      runId: fixture.deliveryRunId,
      role: "worker",
      goal: "Bypass the host overlay",
      prompt: "Write files.",
      dependsOn: [fixture.plannerTaskId],
      config: { executor: "codex-resumable", permissionMode: "workspace-write" },
    })).toThrow("additive evidence-contract execution contract is missing");
  });

  test("Planner output is deterministically projected to the host graph and the host action unlocks only its verifier", async () => {
    const fixture = seedAdditiveDelivery(harness, dir);
    const result = await createTasksFromOutputHook({ harness })({
      run: harness.getRun(fixture.deliveryRunId)!,
      task: harness.getTask(fixture.plannerTaskId)!,
      sessionName: "additive-planner",
      prompt: "Plan it.",
      output: {
        status: "done",
        summary: "Create one Worker and one Verifier.",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
        nextTasks: [
          { role: "worker", goal: "Write the evidence overlay", prompt: "Write it." },
          { role: "verifier", goal: "Verify the evidence overlay", prompt: "Verify it." },
        ],
      },
    });
    expect(result).toMatchObject({
      decision: "exit",
      problems: [],
      artifacts: [expect.objectContaining({ kind: "additive_evidence_contract_recovery" })],
    });
    let overview = harness.getRunOverview({ runId: fixture.deliveryRunId, eventLimit: 0 });
    expect(overview.tasks.filter((task) => task.role === "worker")).toHaveLength(0);
    expect(overview.tasks.filter((task) => task.role === "verifier")).toHaveLength(1);
    const systemTask = overview.tasks.find((task) => task.role === "system")!;
    const verifierTask = overview.tasks.find((task) => task.role === "verifier")!;
    expect(verifierTask.dependsOn).toEqual([systemTask.id]);

    const reconciled = reconcileAdditiveEvidenceContract({ harness, runId: fixture.deliveryRunId });
    expect(reconciled).toEqual([expect.objectContaining({
      systemTaskId: systemTask.id,
      verifierTaskId: verifierTask.id,
      status: "done",
      actionEventId: expect.stringMatching(/^action_/),
    })]);
    overview = harness.getRunOverview({ runId: fixture.deliveryRunId, eventLimit: 0 });
    expect(harness.getTask(systemTask.id)?.status).toBe("done");
    expect(harness.listLatestAttemptsForTasks([systemTask.id])).toEqual([
      expect.objectContaining({ taskId: systemTask.id, status: "done" }),
    ]);
    const statusById = new Map(overview.tasks.map((task) => [task.id, task.status]));
    expect(overview.tasks.filter((task) => task.status === "todo"
      && task.dependsOn.every((dependencyId) => statusById.get(dependencyId) === "done"))
      .map((task) => task.id)).toEqual([verifierTask.id]);
    expect(overview.run?.context.additiveEvidenceContractOverlayState).toMatchObject({
      status: "recorded",
      recordedBySystemTaskId: systemTask.id,
    });
    expect(reconcileAdditiveEvidenceContract({ harness, runId: fixture.deliveryRunId })).toEqual([]);
  });
});

function seedAdditiveDelivery(harness: Harness, rootPath: string, includeLegacyBareTasks = false) {
  const projectId = harness.createProject({ name: "evidence target", rootPath });
  const designRootId = harness.createRun({
    goal: "Correct an immutable evidence conflict",
    projectId,
    context: { source: "target-system-design" },
  });
  const designerTaskId = harness.createTask({
    runId: designRootId,
    role: "designer",
    goal: "Propose an additive evidence contract",
    prompt: "Propose it.",
  });
  const frozenManifestSha256 = "8".repeat(64);
  const observedManifestSha256 = "6".repeat(64);
  const conflictFingerprint = "c".repeat(64);
  const proposal = harness.createDesignProposal({
    id: "design_additive_evidence_contract",
    projectId,
    runId: designRootId,
    taskId: designerTaskId,
    title: "Bind frozen and observed evidence separately",
    problem: "The immutable hashes are intentionally distinct.",
    recommendation: "Create an additive dual-binding control-plane overlay.",
    status: "accepted",
    proposal: {
      problem: "The immutable hashes are intentionally distinct.",
      recommendation: "Create an additive dual-binding control-plane overlay.",
      evidenceRefs: ["signal_conflict", "signal_research"],
      evaluationContract: {
        baseline: ["equality is unsatisfiable"],
        successMetrics: ["both bindings verify"],
        guardMetrics: ["prior evidence remains immutable"],
        requiredEvidence: ["five runtime receipts"],
      },
      investment: {
        reversibility: "easy",
        portfolio: "core",
        classification: "investment",
        oneTimeCost: 0,
        recurringCost: 0,
        timeBudget: "60 minutes",
      },
    } as never,
  });
  const decision = harness.recordDesignDecision({
    id: "decision_additive_evidence_contract",
    proposalId: proposal.id,
    decision: "approved",
    actorKind: "auto",
    reasons: ["Zero-cost additive evidence correction."],
  });
  const runtimeReceipts = Array.from({ length: 5 }, (_, index) => ({
    stageId: `stage-${index + 1}`,
    taskId: `task_runtime_${index + 1}`,
    attemptId: `attempt_runtime_${index + 1}`,
    outputSha256: String(index + 1).repeat(64),
    profileReceiptSha256: String(index + 2).repeat(64),
  }));
  const sourceRepairBudget = { used: 1, limit: 3, entries: [{ kind: "prior", taskId: "task_prior" }] };
  const sourceRunId = harness.createRun({
    id: "run_source_blocked",
    goal: "Preserve the blocked source delivery",
    projectId,
    context: { source: "design", repairReplanBudget: sourceRepairBudget },
  });
  harness.updateRunStatus({ runId: sourceRunId, status: "blocked" });
  const bundleBody = {
    schemaVersion: 1,
    purpose: "runtime-integration-frozen-evidence-conflict-correction",
    targetProjectId: projectId,
    sourceRun: {
      id: sourceRunId,
      status: "blocked",
      repairBudgetSha256: canonicalEvolutionValueSha256(sourceRepairBudget),
    },
    conflict: {
      signalId: "signal_conflict",
      frozenManifestSha256,
      observedManifestSha256,
      fingerprint: conflictFingerprint,
    },
    research: { signalId: "signal_research" },
    verifiedRuntime: runtimeReceipts,
    immutableContracts: { mayModifyFrozenPackage: false, mayRecoverSourceRun: false },
  };
  const bundleSha256 = canonicalEvolutionValueSha256(bundleBody);
  const deliveryRunId = harness.createRun({
    goal: proposal.recommendation,
    projectId,
    context: {
      source: "design",
      parentRunId: designRootId,
      sourceTaskId: designerTaskId,
      designProposalId: proposal.id,
      designDecisionId: decision.id,
      designProposal: proposal.proposal,
      designEvaluationContract: proposal.proposal.evaluationContract,
      immutableContracts: { mayModifyFrozenPackage: false, mayRecoverSourceRun: false },
    },
  });
  const verifierContract = proposal.proposal.evaluationContract;
  const verifierContractSha256 = canonicalEvolutionValueSha256(verifierContract);
  const frozenDesignPlanner = {
    schemaVersion: 1,
    designProposalId: proposal.id,
    designDecisionId: decision.id,
    canonicalPlannerTaskId: "task_additive_planner",
    verifierContractSha256,
  };
  const plannerTaskId = harness.createTask({
    id: "task_additive_planner",
    runId: deliveryRunId,
    role: "planner",
    goal: "Plan the additive evidence contract",
    prompt: "Plan the host overlay and verifier.",
    config: { frozenDesignPlanner, verifierContract },
  });
  const plannerAttemptId = harness.startAttempt({ taskId: plannerTaskId, input: { executor: "codex-resumable" } });
  harness.finishAttempt({
    attemptId: plannerAttemptId,
    output: { status: "done", summary: "Planned.", changedFiles: [], checks: [], artifacts: [], problems: [] },
  });
  const badWorkerId = includeLegacyBareTasks ? harness.createTask({
    runId: deliveryRunId,
    role: "worker",
    goal: "Implement additive evidence overlay",
    prompt: "Implement it.",
    dependsOn: [plannerTaskId],
    config: { frozenDesignPlanner, verifierContract },
  }) : null;
  const badVerifierId = includeLegacyBareTasks ? harness.createTask({
    runId: deliveryRunId,
    role: "verifier",
    goal: "Verify additive evidence overlay",
    prompt: "Verify it.",
    config: { frozenDesignPlanner, verifierContract },
  }) : null;
  harness.updateRun({
    runId: deliveryRunId,
    contextPatch: { targetSystemEvidenceBundle: { ...bundleBody, bundleSha256 } },
  });
  return {
    deliveryRunId,
    plannerTaskId,
    frozenDesignPlanner,
    verifierContract,
    bundleSha256,
    badWorkerId,
    badVerifierId,
  };
}
