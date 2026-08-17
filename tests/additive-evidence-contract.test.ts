import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  type AttemptOutput,
  applyHarnessAction,
  canonicalEvolutionValueSha256,
  Harness,
} from "../packages/harness/src";
import {
  createApplyDesignActionsHook,
  createTasksFromOutputHook,
  projectOverallGoalIntegrationDesignActions,
  reconcileAdditiveEvidenceContract,
  runCodexResumableLoop,
} from "../packages/runner/src";

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

  test("overall-goal action projection keeps one concrete proposal, preserves quiescence, and rejects signal-only output", () => {
    const signal = {
      type: "recordSignal" as const,
      payload: {
        projectId: "project_target",
        signalClass: "system" as const,
        source: "designer",
        title: "Verified worktrees await integration",
        summary: "The runtime worktrees still require governed integration.",
        observationTime: "2026-08-17T00:00:00.000Z",
        confidence: 1,
        evidence: ["run:source"],
      },
    };
    const proposal = {
      type: "proposeDesign" as const,
      payload: {
        projectId: "project_target",
        title: "Governed integration closeout",
        proposal: {
          problem: "Two verified isolated worktrees remain uncommitted.",
          recommendation: "Verify, commit, push, and bind the local runtime.",
        },
      },
    };

    expect(projectOverallGoalIntegrationDesignActions([])).toEqual([]);
    expect(projectOverallGoalIntegrationDesignActions([proposal as never])).toEqual([proposal]);
    expect(projectOverallGoalIntegrationDesignActions([signal as never, proposal as never])).toEqual([proposal]);
    expect(() => projectOverallGoalIntegrationDesignActions([signal as never]))
      .toThrow("overall-goal integration Designer must emit one proposeDesign action or quiesce");
    expect(() => projectOverallGoalIntegrationDesignActions([proposal as never, signal as never, signal as never]))
      .toThrow("overall-goal integration Designer must emit one proposeDesign action or quiesce");
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

  test("audited retired bare tasks do not displace the verified additive system lineage at closeout", () => {
    const fixture = seedAdditiveDelivery(harness, dir, true);
    applyHarnessAction(harness, {
      type: "materializeAdditiveEvidenceContractRecovery",
      runId: fixture.deliveryRunId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);

    const graph = harness.getRun(fixture.deliveryRunId)!.context.additiveEvidenceContractTaskGraph as Record<string, string>;
    expect(reconcileAdditiveEvidenceContract({ harness, runId: fixture.deliveryRunId })).toEqual([
      expect.objectContaining({ status: "done", systemTaskId: graph.systemTaskId }),
    ]);
    harness.recordAttempt({
      taskId: graph.verifierTaskId,
      input: { executor: "codex-resumable", permissionMode: "read-only" },
      output: {
        status: "done",
        verdict: "pass",
        summary: "The additive overlay and all immutable bindings passed independent verification.",
        changedFiles: [],
        checks: Array.from({ length: 16 }, (_, index) => ({
          name: `frozen additive check ${index + 1}`,
          status: "passed",
          evidence: graph.graphSha256,
        })),
        artifacts: [{ kind: "additive_evidence_contract_verifier_receipt", graphSha256: graph.graphSha256 }],
        problems: [],
      },
    });

    const closed = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId: fixture.deliveryRunId,
      maxTries: 3,
    });
    const replay = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId: fixture.deliveryRunId,
      maxTries: 3,
    });

    expect(closed).toMatchObject({
      status: "done",
      artifacts: [expect.objectContaining({
        kind: "additive_evidence_contract_verified",
        systemTaskId: graph.systemTaskId,
        verifierTaskId: graph.verifierTaskId,
        packageOnly: true,
        evidenceContractOnly: true,
        targetFilesChanged: 0,
      })],
    });
    expect(replay).toMatchObject({ status: "done" });
    expect(harness.getRun(fixture.deliveryRunId)).toMatchObject({
      status: "done",
      context: {
        additiveEvidenceContractCloseout: {
          status: "verified",
          packageOnly: true,
          evidenceContractOnly: true,
          targetFilesChanged: 0,
          graphSha256: graph.graphSha256,
        },
      },
    });
    expect(harness.getTask(fixture.badWorkerId!)?.config).toMatchObject({
      retired: true,
      retiredByAction: "materializeAdditiveEvidenceContractRecovery",
    });
    expect(harness.getTask(fixture.badVerifierId!)?.config).toMatchObject({
      retired: true,
      retiredByAction: "materializeAdditiveEvidenceContractRecovery",
    });
    expect(harness.getRun("run_source_blocked")).toMatchObject({
      status: "blocked",
      context: { repairReplanBudget: { used: 1, limit: 3 } },
    });
    const finalOverview = harness.getRunOverview({ runId: fixture.deliveryRunId, eventLimit: 0 });
    expect(finalOverview.tasks.some((task) => task.role === "goal-review")).toBe(false);
    expect(finalOverview.tasks.some((task) => task.status === "todo" || task.status === "running")).toBe(false);
    expect(finalOverview.threads.some((thread) => thread.status === "running")).toBe(false);
  });

  test("a real unverified worker still blocks additive closeout", () => {
    const fixture = seedAdditiveDelivery(harness, dir, true);
    harness.recordAttempt({
      taskId: fixture.badWorkerId!,
      input: { executor: "codex-resumable" },
      output: {
        status: "done",
        summary: "A real worker changed the delivery.",
        changedFiles: ["src/unverified.ts"],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    applyHarnessAction(harness, {
      type: "materializeAdditiveEvidenceContractRecovery",
      runId: fixture.deliveryRunId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);
    const graph = harness.getRun(fixture.deliveryRunId)!.context.additiveEvidenceContractTaskGraph as Record<string, string>;
    reconcileAdditiveEvidenceContract({ harness, runId: fixture.deliveryRunId });
    harness.recordAttempt({
      taskId: graph.verifierTaskId,
      input: { executor: "codex-resumable", permissionMode: "read-only" },
      output: {
        status: "done",
        verdict: "pass",
        summary: "The overlay itself passed.",
        changedFiles: [],
        checks: [{ name: "overlay", status: "passed", evidence: graph.graphSha256 }],
        artifacts: [],
        problems: [],
      },
    });

    expect(() => applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId: fixture.deliveryRunId,
      maxTries: 3,
    })).toThrow(/latest repair lineage.*has no passing verifier/i);
    expect(harness.getRun(fixture.deliveryRunId)?.status).toBe("todo");
  });

  test("verified evidence-only closeout freezes both isolated worktrees into one unstarted integration Designer", async () => {
    const fixture = seedAdditiveDelivery(harness, dir, true);
    const worktrees = await seedIntegrationWorktrees(harness, dir);
    applyHarnessAction(harness, {
      type: "materializeAdditiveEvidenceContractRecovery",
      runId: fixture.deliveryRunId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);
    const graph = harness.getRun(fixture.deliveryRunId)!.context.additiveEvidenceContractTaskGraph as Record<string, string>;
    reconcileAdditiveEvidenceContract({ harness, runId: fixture.deliveryRunId });
    harness.recordAttempt({
      taskId: graph.verifierTaskId,
      input: { executor: "codex-resumable", permissionMode: "read-only" },
      output: {
        status: "done",
        verdict: "pass",
        summary: "The evidence-only overlay passed.",
        changedFiles: [],
        checks: Array.from({ length: 16 }, (_, index) => ({ name: `check-${index}`, status: "passed" })),
        artifacts: [],
        problems: [],
      },
    });
    expect(applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId: fixture.deliveryRunId,
      maxTries: 3,
    })).toMatchObject({ status: "done" });

    const result = applyHarnessAction(harness, {
      type: "materializeOverallGoalIntegrationDesigner",
      runId: fixture.deliveryRunId,
    } as never);
    const replay = applyHarnessAction(harness, {
      type: "materializeOverallGoalIntegrationDesigner",
      runId: fixture.deliveryRunId,
    } as never);
    const receipt = result.artifacts.find((artifact) => artifact.kind === "overall_goal_integration_designer_trigger")!;

    expect(result).toMatchObject({
      status: "done",
      actionType: "materializeOverallGoalIntegrationDesigner",
      artifacts: [expect.objectContaining({
        kind: "overall_goal_integration_designer_trigger",
        sourceRunId: fixture.deliveryRunId,
        blockedRuntimeRunId: "run_source_blocked",
        backendFileCount: 2,
        frontendFileCount: 2,
        reused: false,
      })],
    });
    expect(replay).toMatchObject({ status: "done", eventId: result.eventId });
    const nextRunId = String(receipt.runId);
    const nextTaskId = String(receipt.taskId);
    const nextOverview = harness.getRunOverview({ runId: nextRunId, eventLimit: 0 });
    expect(nextOverview.run).toMatchObject({
      status: "todo",
      context: {
        source: "target-system-design",
        parentRunId: fixture.deliveryRunId,
        overallGoalComplete: false,
        overallGoalIntegrationEvidence: {
          sourceRunId: fixture.deliveryRunId,
          blockedRuntimeRunId: "run_source_blocked",
          worktrees: [
            expect.objectContaining({
              repositoryId: "target-backend",
              head: worktrees.backendHead,
              branch: worktrees.backendBranch,
              files: [
                expect.objectContaining({ path: "src/domain/runtime.ts", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
                expect.objectContaining({
                  path: "tests/runtime-integration/.tmp/host-evidence.json",
                  commitDisposition: "must-exclude-unless-frozen-contract-explicitly-allows",
                }),
              ],
            }),
            expect.objectContaining({
              repositoryId: "target-frontend",
              head: worktrees.frontendHead,
              branch: worktrees.frontendBranch,
              files: [
                expect.objectContaining({ path: "src-react/app/navigation.ts" }),
                expect.objectContaining({ path: "src-react/features/studio-os/page.tsx" }),
              ],
            }),
          ],
          runtimeSwitchEvidence: { status: "unverified" },
        },
      },
    });
    const authoritativeBundle = nextOverview.run!.context.targetSystemEvidenceBundle as Record<string, unknown>;
    const { bundleSha256, ...bundleBody } = authoritativeBundle;
    expect(bundleSha256).toBe(canonicalEvolutionValueSha256(bundleBody));
    expect(authoritativeBundle).toMatchObject({
      purpose: "overall-goal-integration-closeout",
      overallGoalComplete: false,
      evidenceOnlyCloseout: { verifierAttemptId: expect.any(String) },
      verifiedRuntime: expect.arrayContaining([
        expect.objectContaining({ taskId: expect.any(String), attemptId: expect.any(String) }),
      ]),
      worktrees: [
        expect.objectContaining({ repositoryId: "target-backend", receiptSha256: expect.any(String) }),
        expect.objectContaining({ repositoryId: "target-frontend", receiptSha256: expect.any(String) }),
      ],
      temporaryAndControlExclusions: expect.objectContaining({
        targetBackend: expect.arrayContaining(["tests/runtime-integration/.tmp/host-evidence.json"]),
      }),
      runtimeSwitchEvidence: { status: "unverified", requiredReceipts: expect.any(Array) },
    });
    expect(nextOverview.tasks).toEqual([
      expect.objectContaining({
        id: nextTaskId,
        role: "designer",
        status: "todo",
        config: expect.objectContaining({
          readOnly: true,
          forbidImplementation: true,
          forbidBrowser: true,
          browserProcessPolicy: "deny",
          forbidNextTasks: true,
          forbidNextRuns: true,
          targetSystemEvidenceBundle: authoritativeBundle,
          overallGoalIntegrationDesignAdapter: expect.objectContaining({
            schemaVersion: 1,
            signalId: expect.any(String),
            evidenceBundleSha256: bundleSha256,
            adapterSha256: expect.any(String),
          }),
        }),
      }),
    ]);
    expect(nextOverview.sessions).toHaveLength(0);
    expect(nextOverview.threads).toHaveLength(0);
    expect(harness.getRun("run_source_blocked")).toMatchObject({
      status: "blocked",
      context: { repairReplanBudget: { used: 1, limit: 3 } },
    });
    expect(harness.getRun(fixture.deliveryRunId)?.status).toBe("done");
  });

  test("a governed closeout action-shape failure is retired once and replaced with the same frozen bundle", async () => {
    const fixture = seedAdditiveDelivery(harness, dir, true);
    await seedIntegrationWorktrees(harness, dir);
    const charter = harness.createFounderCharter({
      projectId: harness.getRun(fixture.deliveryRunId)!.projectId!,
      mission: "Finish verified target integration safely.",
      charter: {
        mission: "Finish verified target integration safely.",
        capitalPolicy: {
          currency: "USD",
          experimentBudget: 1_000,
          recurringSpendApprovalAbove: 0,
          portfolio: { core: 5, growth: 3, exploration: 2 },
        },
        authority: {
          autoResearch: true,
          autoReversibleExperiments: true,
          humanApprovalPolicy: "cost-only",
          requireHumanFor: ["cost"],
        },
      },
      activate: true,
    });
    harness.updateRun({ runId: fixture.deliveryRunId, contextPatch: { founderCharterId: charter.id } });
    applyHarnessAction(harness, {
      type: "materializeAdditiveEvidenceContractRecovery",
      runId: fixture.deliveryRunId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);
    const graph = harness.getRun(fixture.deliveryRunId)!.context.additiveEvidenceContractTaskGraph as Record<string, string>;
    reconcileAdditiveEvidenceContract({ harness, runId: fixture.deliveryRunId });
    harness.recordAttempt({
      taskId: graph.verifierTaskId,
      input: { executor: "codex-resumable" },
      output: { status: "done", verdict: "pass", summary: "pass", changedFiles: [], checks: [], artifacts: [], problems: [] },
    });
    applyHarnessAction(harness, { type: "prepareRunDrain", runId: fixture.deliveryRunId, maxTries: 3 });
    const first = applyHarnessAction(harness, {
      type: "materializeOverallGoalIntegrationDesigner",
      runId: fixture.deliveryRunId,
    } as never);
    const firstReceipt = first.artifacts.find((artifact) => artifact.kind === "overall_goal_integration_designer_trigger")!;
    const failedRunId = String(firstReceipt.runId);
    const failedTaskId = String(firstReceipt.taskId);
    harness.recordAttempt({
      taskId: failedTaskId,
      input: { executor: "codex-resumable", permissionMode: "read-only" },
      output: {
        status: "blocked",
        summary: "The integration scheme is valid but included one redundant recordSignal action.",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: ["overall-goal integration Designer must emit one proposeDesign action or quiesce"],
        nextTasks: [],
        nextRuns: [],
      },
    });
    const validationFingerprint = "7".repeat(64);
    harness.updateRun({
      runId: failedRunId,
      contextPatch: {
        overallGoalIntegrationDesignFailure: {
          schemaVersion: 1,
          fingerprint: validationFingerprint,
          sourceTaskId: failedTaskId,
          sourceAttemptId: null,
          problem: "overall-goal integration Designer must emit one proposeDesign action or quiesce",
        },
      },
    });
    const originalReceipt = harness.getRun(fixture.deliveryRunId)!.context
      .overallGoalIntegrationContinuation as Record<string, unknown>;
    harness.updateRun({
      runId: fixture.deliveryRunId,
      contextPatch: {
        overallGoalIntegrationRecovery: {
          ...originalReceipt,
          failedDesignerRunId: "run_prior_failed",
          validationFingerprint: "8".repeat(64),
        },
      },
    });

    const recovered = applyHarnessAction(harness, {
      type: "materializeOverallGoalIntegrationDesigner",
      runId: fixture.deliveryRunId,
      failedDesignerRunId: failedRunId,
    } as never);
    const replay = applyHarnessAction(harness, {
      type: "materializeOverallGoalIntegrationDesigner",
      runId: fixture.deliveryRunId,
      failedDesignerRunId: failedRunId,
    } as never);
    const recoveredReceipt = recovered.artifacts.find((artifact) => artifact.kind === "overall_goal_integration_designer_trigger")!;
    const nextRunId = String(recoveredReceipt.runId);
    const nextTaskId = String(recoveredReceipt.taskId);
    expect(recovered).toMatchObject({ status: "done" });
    expect(replay).toMatchObject({ status: "done", eventId: recovered.eventId });
    expect(nextRunId).not.toBe(failedRunId);
    expect(recoveredReceipt.validationFingerprint).toBe(validationFingerprint);
    expect(harness.getRun(failedRunId)).toMatchObject({
      status: "blocked",
      context: {
        retired: true,
        overallGoalIntegrationDesignFailure: expect.objectContaining({
          fingerprint: expect.any(String),
          sourceTaskId: failedTaskId,
        }),
      },
    });
    expect(harness.getRunOverview({ runId: failedRunId, eventLimit: 0 }).tasks
      .filter((task) => task.role === "goal-review")).toHaveLength(0);

    const nextOverview = harness.getRunOverview({ runId: nextRunId, eventLimit: 0 });
    expect(nextOverview.run).toMatchObject({ status: "todo", context: { supersedesRunId: failedRunId } });
    expect(nextOverview.sessions).toHaveLength(0);
    expect(nextOverview.threads).toHaveLength(0);
    expect(nextOverview.tasks).toEqual([expect.objectContaining({ id: nextTaskId, role: "designer", status: "todo" })]);
    const task = nextOverview.tasks[0]!;
    const adapter = task.config!.overallGoalIntegrationDesignAdapter as Record<string, unknown>;
    const bundle = nextOverview.run!.context.targetSystemEvidenceBundle as Record<string, unknown>;
    const failedBundle = harness.getRun(failedRunId)!.context.targetSystemEvidenceBundle as Record<string, unknown>;
    const { adapterSha256, ...adapterBody } = adapter;
    expect(adapterSha256).toBe(canonicalEvolutionValueSha256(adapterBody));
    expect(adapter.evidenceBundleSha256).toBe(bundle.bundleSha256);
    expect(bundle.bundleSha256).toBe(failedBundle.bundleSha256);

    const hook = createApplyDesignActionsHook({ harness });
    const hookResult = await hook({
      run: nextOverview.run!,
      task,
      sessionName: "overall-goal-designer",
      prompt: task.prompt,
      output: {
        status: "done",
        summary: "Propose the bounded integration closeout.",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
        designActions: [{
          type: "recordSignal",
          payload: {
            projectId: nextOverview.run!.projectId!,
            signalClass: "system",
            source: "designer",
            title: "Verified runtime worktrees await governed integration",
            summary: "The concrete closeout proposal below supersedes this redundant model signal.",
            observationTime: "2026-08-17T00:00:00.000Z",
            confidence: 1,
            evidence: ["model-invented-ref"],
          },
        }, {
          type: "proposeDesign",
          payload: {
            projectId: nextOverview.run!.projectId!,
            title: "Governed integration closeout",
            status: "proposed",
            charterId: charter.id,
            proposal: {
              problem: "Two verified isolated worktrees remain uncommitted and are not bound to the active local runtime.",
              recommendation: "Verify each repository independently, commit and push exact hashes, then prove the local runtime switch.",
              evidenceRefs: ["model-invented-ref"],
              options: [{
                name: "Bounded exact integration",
                benefits: ["preserves verified work"],
                costs: ["bounded local engineering time"],
                risks: ["receipt drift blocks completion"],
                lockIn: [],
              }],
              additions: ["repository commit receipts", "runtime switch receipt"],
              removals: [],
              targetOutcome: "Both repositories are pushed and the local runtime identifies those commits.",
              assumptions: [],
              uncertainty: [],
              evaluationContract: {
                baseline: ["model supplied baseline must be replaced"],
                successMetrics: ["model supplied metric must be replaced"],
                guardMetrics: [],
                requiredEvidence: ["model supplied evidence must be replaced"],
              },
              investment: { reversibility: "hard", portfolio: "exploration", oneTimeCost: 99 },
            },
          },
        }],
      } as AttemptOutput,
    });
    expect(hookResult.problems).toBeUndefined();
    const proposal = harness.listDesignProposals({ projectId: nextOverview.run!.projectId! })
      .find((candidate) => candidate.runId === nextRunId)!;
    expect(proposal.proposal).toMatchObject({
      evidenceRefs: [adapter.signalId],
      evaluationContract: adapter.evaluationContract,
      investment: adapter.investment,
      resourceRequest: adapter.resourceRequest,
    });
    expect(proposal.proposal.problem).toContain("isolated worktrees");
    expect(proposal.proposal.recommendation).toContain("runtime switch");
    expect(harness.listStrategySignals({ projectId: nextOverview.run!.projectId! }))
      .toHaveLength(1);
    expect(harness.getRun("run_source_blocked")).toMatchObject({
      status: "blocked",
      context: { repairReplanBudget: { used: 1, limit: 3 } },
    });

    const continuation = harness.getRunOverview({ runId: nextRunId, eventLimit: 0 }).tasks
      .find((candidate) => candidate.config?.designContinuation);
    expect(continuation).toMatchObject({ role: "designer" });
    const deliveryOutput = {
      status: "done",
      summary: "Create the single governed integration closeout delivery.",
      changedFiles: [],
      checks: [],
      artifacts: [],
      problems: [],
      designActions: [{
        type: "createRunsFromDesign",
        payload: {
          proposalId: proposal.id,
          runs: [{
            goal: "Integrate the two frozen isolated worktrees with exact receipts.",
            prompt: "Verify each repository, commit and push exact paths, then collect frozen runtime-switch receipts.",
            doneWhen: ["all host-frozen closeout receipts pass"],
          }],
        },
      }],
    } as AttemptOutput;
    const deliveryResult = await hook({
      run: harness.getRun(nextRunId)!,
      task: continuation!,
      sessionName: "overall-goal-create-delivery",
      prompt: continuation!.prompt,
      output: deliveryOutput,
    });
    expect(deliveryResult.problems).toBeUndefined();
    const created = (deliveryResult.artifacts as Array<Record<string, unknown>> | undefined)
      ?.find((artifact) => artifact.kind === "created_run") as
      | { runId: string; plannerTaskId: string }
      | undefined;
    expect(created).toBeDefined();
    const delivery = harness.getRunOverview({ runId: created!.runId, eventLimit: 0 });
    expect(delivery.run).toMatchObject({
      status: "todo",
      context: {
        designProposalId: proposal.id,
        designDecisionId: expect.any(String),
        targetSystemEvidenceBundle: expect.objectContaining({
          purpose: "overall-goal-integration-closeout",
          bundleSha256: bundle.bundleSha256,
        }),
        overallGoalIntegrationCloseout: expect.objectContaining({
          schemaVersion: 1,
          bundleSha256: bundle.bundleSha256,
          signalId: adapter.signalId,
          browserAllowed: false,
          paidUsd: 0,
        }),
      },
    });
    expect(delivery.tasks).toEqual([expect.objectContaining({
      id: created!.plannerTaskId,
      role: "planner",
      status: "todo",
      config: expect.objectContaining({
        permissionMode: "read-only",
        forbidImplementation: true,
        forbidBrowser: true,
        browserProcessPolicy: "deny",
        overallGoalIntegrationCloseout: expect.objectContaining({
          bundleSha256: bundle.bundleSha256,
          stages: [
            "verify-backend",
            "verify-frontend",
            "commit-push-backend",
            "commit-push-frontend",
            "runtime-switch-evidence",
          ],
        }),
      }),
    })]);
    const replayResult = await hook({
      run: harness.getRun(nextRunId)!,
      task: continuation!,
      sessionName: "overall-goal-create-delivery-replay",
      prompt: continuation!.prompt,
      output: deliveryOutput,
    });
    expect(replayResult.problems).toBeUndefined();
    expect(harness.listRuns({ limit: 100 }).filter((run) => run.context.designProposalId === proposal.id))
      .toHaveLength(1);
  });

  test("overall-goal integration trigger fails closed when a worktree writes outside its frozen repository boundary", async () => {
    const fixture = seedAdditiveDelivery(harness, dir, true);
    const worktrees = await seedIntegrationWorktrees(harness, dir);
    await writeFile(join(worktrees.backendPath, "README.md"), "unauthorized\n");
    applyHarnessAction(harness, {
      type: "materializeAdditiveEvidenceContractRecovery",
      runId: fixture.deliveryRunId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);
    const graph = harness.getRun(fixture.deliveryRunId)!.context.additiveEvidenceContractTaskGraph as Record<string, string>;
    reconcileAdditiveEvidenceContract({ harness, runId: fixture.deliveryRunId });
    harness.recordAttempt({
      taskId: graph.verifierTaskId,
      input: { executor: "codex-resumable" },
      output: { status: "done", verdict: "pass", summary: "pass", changedFiles: [], checks: [], artifacts: [], problems: [] },
    });
    applyHarnessAction(harness, { type: "prepareRunDrain", runId: fixture.deliveryRunId, maxTries: 3 });

    const result = applyHarnessAction(harness, {
      type: "materializeOverallGoalIntegrationDesigner",
      runId: fixture.deliveryRunId,
    } as never);
    expect(result).toMatchObject({ status: "blocked" });
    expect(result.problems.join("\n")).toMatch(/outside the frozen allowed paths/i);
    expect(harness.listRuns({ limit: 100 }).filter((run) => run.context.overallGoalIntegrationEvidence)).toHaveLength(0);
  });

  test("overall-goal closeout recovery replaces five bare tasks with the frozen verifier and host-action graph", () => {
    const fixture = seedOverallGoalIntegrationDelivery(harness, dir, true);
    for (const taskId of fixture.legacyTaskIds) {
      expect(() => harness.assertTaskExecutionAllowed({ taskId }))
        .toThrow(/overallGoalIntegrationCloseoutTaskGraph|overall-goal integration task graph|outside the frozen overall-goal/i);
    }

    const result = applyHarnessAction(harness, {
      type: "materializeOverallGoalIntegrationTaskGraph",
      runId: fixture.deliveryRunId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);
    const replay = applyHarnessAction(harness, {
      type: "materializeOverallGoalIntegrationTaskGraph",
      runId: fixture.deliveryRunId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);

    expect(result).toMatchObject({ status: "done", actionType: "materializeOverallGoalIntegrationTaskGraph" });
    expect(replay).toMatchObject({ status: "done", eventId: result.eventId });
    expect(fixture.legacyTaskIds.map((id) => harness.getTask(id)?.status)).toEqual(Array(5).fill("blocked"));
    const overview = harness.getRunOverview({ runId: fixture.deliveryRunId, eventLimit: 0 });
    const graph = overview.run!.context.overallGoalIntegrationCloseoutTaskGraph as {
      stages: Array<{ stageId: string; taskId: string }>;
    };
    const tasks = graph.stages.map((stage) => harness.getTask(stage.taskId)!);
    expect(tasks.map((task) => [task.goal, task.role])).toEqual([
      ["verify-backend", "verifier"],
      ["verify-frontend", "verifier"],
      ["commit-push-backend", "system"],
      ["commit-push-frontend", "system"],
      ["runtime-switch-evidence", "system"],
    ]);
    expect(tasks[0]).toMatchObject({
      parentId: fixture.plannerTaskId,
      dependsOn: [fixture.plannerTaskId],
      worktreePath: fixture.backendWorktree,
      config: {
        executor: "codex-resumable", permissionMode: "read-only", repositoryId: "target-backend",
        readOnly: true, identitySeparated: true, forbidBrowser: true, browserProcessPolicy: "deny",
      },
    });
    expect(tasks[1]).toMatchObject({ dependsOn: [tasks[0]!.id], worktreePath: fixture.frontendWorktree });
    expect(tasks[2]).toMatchObject({
      role: "system",
      dependsOn: [tasks[0]!.id, tasks[1]!.id],
      config: { executor: "host-fixed-action", systemTask: true, modelExecutionAllowed: false },
    });
    expect(tasks[3]!.dependsOn).toEqual([tasks[0]!.id, tasks[1]!.id, tasks[2]!.id]);
    expect(tasks[4]).toMatchObject({
      role: "system",
      dependsOn: [tasks[2]!.id, tasks[3]!.id],
      config: {
        executor: "host-fixed-action",
        hostCapabilities: { loopback: { host: "127.0.0.1", ports: [10588] } },
      },
    });
    const statusById = new Map(overview.tasks.map((task) => [task.id, task.status]));
    expect(overview.tasks.filter((task) => task.status === "todo"
      && task.dependsOn.every((dependency) => statusById.get(dependency) === "done"))
      .map((task) => task.id)).toEqual([tasks[0]!.id]);
    expect(harness.assertTaskExecutionAllowed({ taskId: tasks[0]!.id })).toBe(true);
    expect(() => harness.assertTaskExecutionAllowed({ taskId: tasks[2]!.id })).toThrow("host-fixed-action");
    expect(overview.tasks.some((task) => task.role === "goal-review")).toBe(false);
    expect(overview.run?.context.repairReplanBudget).toEqual({ used: 0, limit: 3, entries: [] });
  });

  test("overall-goal verifier recovery reuses the frozen task and terminalizes the dead lease atomically", async () => {
    const fixture = seedOverallGoalIntegrationDelivery(harness, dir, false);
    applyHarnessAction(harness, {
      type: "materializeOverallGoalIntegrationTaskGraph",
      runId: fixture.deliveryRunId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);
    const initial = harness.getRunOverview({ runId: fixture.deliveryRunId, eventLimit: 0 });
    const graph = initial.run!.context.overallGoalIntegrationCloseoutTaskGraph as {
      stages: Array<{ stageId: string; taskId: string }>;
    };
    const verifierTaskId = graph.stages.find((stage) => stage.stageId === "verify-backend")!.taskId;
    const taskCount = initial.tasks.length;
    const attemptId = harness.startAttempt({
      taskId: verifierTaskId,
      input: { executor: "codex-resumable", sandbox: "read-only", codexSessionId: "missing-rollout" },
    });
    const eventId = harness.recordAttemptEvent({
      attemptId,
      sequence: 1,
      stream: "system",
      text: "read-only heredoc was rejected before a terminal verdict",
    });
    harness.upsertExecutionThread({
      id: `thread_${attemptId}`,
      runId: fixture.deliveryRunId,
      taskId: verifierTaskId,
      attemptId,
      ownerType: "runner",
      ownerId: "dead-overall-goal-verifier",
      role: "verifier",
      status: "running",
      pid: 99_999_999,
      sessionName: "overall-goal-verifier",
      worktreePath: fixture.backendWorktree,
    });

    const recovered = harness.recoverRunningAttempt({
      attemptId,
      reason: "local resumable child exited without terminal output",
      maxRecoveries: 3,
    });

    expect(recovered).toMatchObject({
      taskId: verifierTaskId,
      sourceAttemptId: attemptId,
      recoveryTaskId: null,
      status: "todo",
      recoveryCount: 1,
      recoveryLimit: 1,
    });
    expect(harness.getAttempt(attemptId)).toMatchObject({
      status: "blocked",
      output: {
        artifacts: [expect.objectContaining({
          kind: "dead_execution_lease",
          recoveryMode: "same-task",
          durableEventRefs: [eventId],
        })],
      },
    });
    expect(harness.getTask(verifierTaskId)?.status).toBe("todo");
    expect(harness.getRunOverview({ runId: fixture.deliveryRunId, eventLimit: 0 }).threads)
      .toContainEqual(expect.objectContaining({ attemptId, status: "orphaned" }));
    expect(harness.getRunOverview({ runId: fixture.deliveryRunId, eventLimit: 0 }).tasks).toHaveLength(taskCount);
    expect(harness.getRun(fixture.deliveryRunId)?.context.repairReplanBudget)
      .toEqual({ used: 0, limit: 3, entries: [] });

    let retryPrompt = "";
    await runCodexResumableLoop({
      harness,
      runId: fixture.deliveryRunId,
      limit: 1,
      maxRounds: 1,
      maxTries: 1,
      cwd: dir,
      clientFactory: () => ({
        start: async ({ prompt }) => {
          retryPrompt = prompt;
          return {
            status: "done" as const,
            sessionId: "same-task-retry-session",
            outputPath: join(dir, "same-task-retry.json"),
            stdout: "",
            stderr: "",
            events: [],
            output: { status: "done" as const, verdict: "pass" as const, summary: "verified from the frozen receipt" },
          };
        },
        resume: async () => { throw new Error("unused"); },
      }),
    });
    expect(retryPrompt).toContain("## Bounded Same-Task Recovery");
    expect(retryPrompt).toContain(eventId);
    expect(harness.getTask(verifierTaskId)?.status).toBe("done");
    expect(harness.getRunOverview({ runId: fixture.deliveryRunId, eventLimit: 0 }).tasks).toHaveLength(taskCount);
  });

  test("overall-goal verifier same-task recovery is bounded and never adds a sixth graph node", () => {
    const fixture = seedOverallGoalIntegrationDelivery(harness, dir, false);
    applyHarnessAction(harness, {
      type: "materializeOverallGoalIntegrationTaskGraph",
      runId: fixture.deliveryRunId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);
    const overview = harness.getRunOverview({ runId: fixture.deliveryRunId, eventLimit: 0 });
    const graph = overview.run!.context.overallGoalIntegrationCloseoutTaskGraph as {
      stages: Array<{ stageId: string; taskId: string }>;
    };
    const taskId = graph.stages.find((stage) => stage.stageId === "verify-backend")!.taskId;
    const taskCount = overview.tasks.length;
    const fail = (suffix: string) => {
      const attemptId = harness.startAttempt({ taskId, input: { executor: "codex-resumable", codexSessionId: suffix } });
      harness.upsertExecutionThread({
        id: `thread_${attemptId}`, runId: fixture.deliveryRunId, taskId, attemptId,
        ownerType: "runner", ownerId: suffix, role: "verifier", status: "running",
        pid: 99_999_999, sessionName: suffix, worktreePath: fixture.backendWorktree,
      });
      return harness.recoverRunningAttempt({ attemptId, reason: `dead owner ${suffix}`, maxRecoveries: 1 });
    };

    expect(fail("first")).toMatchObject({ status: "todo", recoveryCount: 1, recoveryTaskId: null });
    expect(fail("second")).toMatchObject({ status: "blocked", recoveryCount: 1, recoveryTaskId: null });
    expect(harness.getTask(taskId)?.status).toBe("blocked");
    expect(harness.getRunOverview({ runId: fixture.deliveryRunId, eventLimit: 0 }).tasks).toHaveLength(taskCount);
  });

  test("a rejected recovery child cannot roll a terminalized source attempt back to running", () => {
    const fixture = seedAdditiveDelivery(harness, dir, false);
    applyHarnessAction(harness, {
      type: "materializeAdditiveEvidenceContractRecovery",
      runId: fixture.deliveryRunId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);
    const overview = harness.getRunOverview({ runId: fixture.deliveryRunId, eventLimit: 0 });
    const systemTask = overview.tasks.find((task) => task.config?.additiveEvidenceContractOverlay)!;
    const verifierTask = overview.tasks.find((task) => task.config?.additiveEvidenceContractVerifier)!;
    harness.recordAttempt({
      taskId: systemTask.id,
      input: { executor: "harness-action" },
      output: { status: "done", summary: "overlay done", changedFiles: [], checks: [], artifacts: [], problems: [] },
    });
    const runId = fixture.deliveryRunId;
    const taskId = verifierTask.id;
    const attemptId = harness.startAttempt({ taskId, input: { executor: "codex-resumable" } });
    harness.upsertExecutionThread({
      id: `thread_${attemptId}`, runId, taskId, attemptId, ownerType: "runner", ownerId: "dead-designer",
      role: "designer", status: "running", pid: 99_999_999, sessionName: "dead-designer",
    });

    const recovered = harness.recoverRunningAttempt({ attemptId, reason: "dead governed designer", maxRecoveries: 1 });

    expect(recovered).toMatchObject({ taskId, status: "blocked", recoveryTaskId: null });
    expect(harness.getAttempt(attemptId)).toMatchObject({ status: "blocked" });
    expect(harness.runInTransaction((db) => db.query("select finished_at from attempts where id = $id")
      .get({ $id: attemptId }) as { finished_at: string | null })).toEqual({ finished_at: expect.any(String) });
    expect(harness.getTask(taskId)?.status).toBe("blocked");
    expect(harness.getRunOverview({ runId, eventLimit: 0 }).threads)
      .toContainEqual(expect.objectContaining({ attemptId, status: "interrupted" }));
  });

  test("overall-goal Planner output is projected before generic tasks can fall back to a model executor", async () => {
    const fixture = seedOverallGoalIntegrationDelivery(harness, dir, false);
    const result = await createTasksFromOutputHook({ harness })({
      run: harness.getRun(fixture.deliveryRunId)!,
      task: harness.getTask(fixture.plannerTaskId)!,
      sessionName: "overall-goal-planner",
      prompt: "Plan it.",
      output: {
        status: "done", summary: "five stages", changedFiles: [], checks: [], artifacts: [], problems: [],
        nextTasks: [
          { role: "verifier", goal: "verify-backend", prompt: "verify" },
          { role: "verifier", goal: "verify-frontend", prompt: "verify", dependsOn: ["verify-backend"] },
          { role: "worker", goal: "commit-push-backend", prompt: "commit", dependsOn: ["verify-backend", "verify-frontend"] },
          { role: "worker", goal: "commit-push-frontend", prompt: "commit", dependsOn: ["verify-backend", "verify-frontend", "commit-push-backend"] },
          { role: "worker", goal: "runtime-switch-evidence", prompt: "switch", dependsOn: ["commit-push-backend", "commit-push-frontend"] },
        ],
      },
    });
    expect(result).toMatchObject({ decision: "exit", problems: [] });
    const overview = harness.getRunOverview({ runId: fixture.deliveryRunId, eventLimit: 0 });
    expect(overview.tasks.filter((task) => task.role === "worker")).toHaveLength(0);
    expect(overview.tasks.filter((task) => task.config?.executor === "host-fixed-action")).toHaveLength(3);
  });
});

async function seedIntegrationWorktrees(harness: Harness, rootPath: string) {
  const backendRoot = join(rootPath, "backend-root");
  const frontendRoot = join(rootPath, "frontend-root");
  const backendPath = join(backendRoot, ".ouroboros/worktrees/run_source_blocked-target-backend");
  const frontendPath = join(frontendRoot, ".ouroboros/worktrees/run_source_blocked-target-frontend");
  const initialize = async (repositoryRoot: string, worktreePath: string, branch: string, frontend = false) => {
    await mkdir(repositoryRoot, { recursive: true });
    runGit(repositoryRoot, ["init"]);
    runGit(repositoryRoot, ["config", "user.email", "orbs@example.test"]);
    runGit(repositoryRoot, ["config", "user.name", "Ouroboros"]);
    await writeFile(join(repositoryRoot, "baseline.txt"), "baseline\n");
    if (frontend) {
      await mkdir(join(repositoryRoot, "src-react/app"), { recursive: true });
      await writeFile(join(repositoryRoot, "src-react/app/navigation.ts"), "export const navigation = [];\n");
    }
    runGit(repositoryRoot, ["add", "."]);
    runGit(repositoryRoot, ["commit", "-m", "baseline"]);
    const head = runGit(repositoryRoot, ["rev-parse", "HEAD"]);
    await mkdir(join(repositoryRoot, ".ouroboros/worktrees"), { recursive: true });
    runGit(repositoryRoot, ["worktree", "add", "-b", branch, worktreePath, head]);
    return head;
  };
  const backendBranch = "codex/orbs-source_block-target-backend";
  const frontendBranch = "codex/orbs-source_block-target-frontend";
  const backendHead = await initialize(backendRoot, backendPath, backendBranch);
  const frontendHead = await initialize(frontendRoot, frontendPath, frontendBranch, true);
  await mkdir(join(backendPath, "src/domain"), { recursive: true });
  await mkdir(join(backendPath, "tests/runtime-integration/.tmp"), { recursive: true });
  await writeFile(join(backendPath, "src/domain/runtime.ts"), "export const runtime = true;\n");
  await writeFile(join(backendPath, "tests/runtime-integration/.tmp/host-evidence.json"), "{}\n");
  await mkdir(join(frontendPath, "src-react/features/studio-os"), { recursive: true });
  await writeFile(join(frontendPath, "src-react/app/navigation.ts"), "export const navigation = ['studio'];\n");
  await writeFile(join(frontendPath, "src-react/features/studio-os/page.tsx"), "export const Page = () => null;\n");

  const sourceRun = harness.getRun("run_source_blocked")!;
  const boundaryBody = {
    schemaVersion: 1,
    repositories: [
      {
        id: "target-backend",
        role: "backend",
        projectId: sourceRun.projectId,
        repoPath: backendRoot,
        expectedHead: backendHead,
        access: "isolated-write",
        allowedPaths: ["src/domain/**", "tests/runtime-integration/**"],
        readOnlyPaths: ["config/evolution/**", "tests/evolution/**"],
        forbiddenPaths: [".git/orbs/**", ".orbs/**", ".ouroboros/**", "db/**"],
      },
      {
        id: "target-frontend",
        role: "frontend",
        projectId: "project_frontend",
        repoPath: frontendRoot,
        expectedHead: frontendHead,
        access: "new-isolated-worktree",
        allowedPaths: ["src-react/features/studio-os/**", "src-react/app/navigation.ts"],
        readOnlyPaths: [],
        forbiddenPaths: [".git/orbs/**", ".orbs/**", ".ouroboros/**", "db/**"],
      },
      {
        id: "ainovel-source",
        role: "ainovel",
        projectId: null,
        repoPath: rootPath,
        expectedHead: "a".repeat(40),
        access: "read-only",
        allowedPaths: ["src/**"],
        readOnlyPaths: ["src/**"],
        forbiddenPaths: [".ainovel/**"],
      },
      {
        id: "dsh-source",
        role: "dsh",
        projectId: null,
        repoPath: rootPath,
        expectedHead: "b".repeat(40),
        access: "read-only",
        allowedPaths: ["apps/cli/src/**"],
        readOnlyPaths: ["apps/cli/src/**"],
        forbiddenPaths: [".orbs/**"],
      },
    ],
    gateway: { host: "127.0.0.1", port: 10588, browserAllowed: false },
  };
  const runtimeIntegrationBoundary = {
    ...boundaryBody,
    boundarySha256: canonicalEvolutionValueSha256(boundaryBody),
  };
  const sourceBundleBody = {
    schemaVersion: 1,
    purpose: "runtime-integration-after-verified-package",
    targetProjectId: sourceRun.projectId,
    runtimeIntegrationBoundary,
    boundarySha256: runtimeIntegrationBoundary.boundarySha256,
  };
  harness.updateRun({
    runId: sourceRun.id,
    status: "blocked",
    contextPatch: {
      targetSystemEvidenceBundle: {
        ...sourceBundleBody,
        bundleSha256: canonicalEvolutionValueSha256(sourceBundleBody),
      },
    },
  });
  for (const [repositoryId, worktreePath, expectedHead] of [
    ["target-backend", backendPath, backendHead],
    ["target-frontend", frontendPath, frontendHead],
  ] as const) {
    const taskId = harness.createTask({
      runId: sourceRun.id,
      role: "system",
      goal: `Bind ${repositoryId}`,
      prompt: "Host-owned binding.",
      worktreePath,
      config: {
        repositoryId,
        repositoryRoot: repositoryId === "target-backend" ? backendRoot : frontendRoot,
        expectedHead,
        worktreeStrategy: {
          schemaVersion: 1,
          mode: "isolated-repository-chain",
          repositoryId,
          repositoryRoot: repositoryId === "target-backend" ? backendRoot : frontendRoot,
          expectedHead,
          path: worktreePath,
          isolated: true,
          writesUserWorktree: false,
        },
      },
    });
    harness.recordAttempt({
      taskId,
      input: { executor: "harness-action" },
      output: { status: "done", summary: "bound", changedFiles: [], checks: [], artifacts: [], problems: [] },
    });
  }
  harness.updateRunStatus({ runId: sourceRun.id, status: "blocked" });
  return { backendPath, frontendPath, backendHead, frontendHead, backendBranch, frontendBranch };
}

function runGit(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

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

function seedOverallGoalIntegrationDelivery(harness: Harness, rootPath: string, includeLegacyBareTasks: boolean) {
  const projectId = harness.createProject({ name: "overall closeout target", rootPath });
  const designRunId = harness.createRun({ goal: "Govern integration", projectId, context: { source: "target-system-design" } });
  const designerTaskId = harness.createTask({ runId: designRunId, role: "designer", goal: "Design closeout", prompt: "Design it." });
  const proposal = harness.createDesignProposal({
    id: `design_overall_${includeLegacyBareTasks ? "legacy" : "hook"}`,
    projectId,
    runId: designRunId,
    taskId: designerTaskId,
    title: "Close out isolated worktrees",
    problem: "Verified worktrees remain unintegrated.",
    recommendation: "Verify, commit, push, and bind runtime evidence.",
    status: "accepted",
    proposal: {
      problem: "Verified worktrees remain unintegrated.",
      recommendation: "Verify, commit, push, and bind runtime evidence.",
      evidenceRefs: ["signal_overall_goal_test"],
      evaluationContract: { baseline: ["unintegrated"], successMetrics: ["integrated"], guardMetrics: ["bounded"], requiredEvidence: ["receipts"] },
      investment: { reversibility: "easy", portfolio: "core", classification: "evidence-maintenance", oneTimeCost: 0, recurringCost: 0, timeBudget: "60 minutes" },
    } as never,
  });
  const decision = harness.recordDesignDecision({
    id: `decision_overall_${includeLegacyBareTasks ? "legacy" : "hook"}`,
    proposalId: proposal.id,
    decision: "approved",
    actorKind: "auto",
    reasons: ["zero cost"],
  });
  const deliveryRunId = harness.createRun({ goal: "Integrate", projectId, context: {} });
  const plannerTaskId = `task_overall_planner_${includeLegacyBareTasks ? "legacy" : "hook"}`;
  const verifierContract = proposal.proposal.evaluationContract;
  const frozenDesignPlanner = {
    schemaVersion: 1, canonicalPlannerTaskId: plannerTaskId, designProposalId: proposal.id,
    designDecisionId: decision.id, verifierContractSha256: canonicalEvolutionValueSha256(verifierContract),
  };
  harness.createTask({ id: plannerTaskId, runId: deliveryRunId, role: "planner", goal: "Plan closeout", prompt: "Plan it.", config: { frozenDesignPlanner, verifierContract } });
  const attemptId = harness.startAttempt({ taskId: plannerTaskId, input: { executor: "codex-resumable" } });
  harness.finishAttempt({ attemptId, output: { status: "done", summary: "planned", changedFiles: [], checks: [], artifacts: [], problems: [] } });
  const legacyTaskIds = includeLegacyBareTasks ? [
    ["verifier", "verify-backend"], ["verifier", "verify-frontend"], ["worker", "commit-push-backend"],
    ["worker", "commit-push-frontend"], ["worker", "runtime-switch-evidence"],
  ].map(([role, goal], index) => harness.createTask({
    runId: deliveryRunId, role: role!, goal: goal!, prompt: "legacy", dependsOn: index === 0 ? [] : [plannerTaskId], config: { verifierContract },
  })) : [];
  const backendWorktree = join(rootPath, "backend-isolated");
  const frontendWorktree = join(rootPath, "frontend-isolated");
  const worktree = (repositoryId: string, repositoryRoot: string, worktreePath: string, branch: string, marker: string) => ({
    schemaVersion: 1, repositoryId, repositoryRoot, worktreePath, branch, head: marker.repeat(40), commonGitDir: join(repositoryRoot, ".git"),
    allowedPaths: repositoryId === "target-backend" ? ["src/**", "tests/runtime-integration/**"] : ["src-react/**"],
    readOnlyPaths: [], forbiddenPaths: [".ouroboros/**", ".orbs/**", ".git/orbs/**", "db/**"],
    files: [
      { path: repositoryId === "target-backend" ? "src/runtime.ts" : "src-react/runtime.tsx", status: "untracked", sha256: marker.repeat(64), sizeBytes: 12, commitDisposition: "eligible" },
      ...(repositoryId === "target-backend" ? [{ path: "tests/runtime-integration/.tmp/host-evidence.json", status: "untracked", sha256: "f".repeat(64), sizeBytes: 2, commitDisposition: "must-exclude-unless-frozen-contract-explicitly-allows" }] : []),
    ],
    receiptSha256: marker.repeat(64),
  });
  const bundleBody = {
    schemaVersion: 1, purpose: "overall-goal-integration-closeout", projectId, sourceRunId: "run_evidence", blockedRuntimeRunId: "run_blocked",
    overallGoalComplete: false,
    worktrees: [worktree("target-backend", join(rootPath, "backend"), backendWorktree, "codex/backend", "a"), worktree("target-frontend", join(rootPath, "frontend"), frontendWorktree, "codex/frontend", "b")],
    temporaryAndControlExclusions: { targetBackend: ["tests/runtime-integration/.tmp/host-evidence.json", ".ouroboros/**", ".orbs/**", ".git/orbs/**", "db/**"], targetFrontend: [".ouroboros/**", ".orbs/**", ".git/orbs/**", "db/**"] },
  };
  const bundle = { ...bundleBody, bundleSha256: canonicalEvolutionValueSha256(bundleBody) };
  const closeout = { schemaVersion: 1, bundleSha256: bundle.bundleSha256, stages: ["verify-backend", "verify-frontend", "commit-push-backend", "commit-push-frontend", "runtime-switch-evidence"], browserAllowed: false, paidUsd: 0 };
  harness.updateRun({
    runId: deliveryRunId,
    contextPatch: { source: "design", parentRunId: designRunId, designProposalId: proposal.id, designDecisionId: decision.id, targetSystemEvidenceBundle: bundle, overallGoalIntegrationCloseout: closeout, repairReplanBudget: { used: 0, limit: 3, entries: [] } },
  });
  return { deliveryRunId, plannerTaskId, legacyTaskIds, backendWorktree, frontendWorktree };
}
