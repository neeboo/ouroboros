import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
