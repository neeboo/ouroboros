import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  applyHarnessAction,
  canonicalEvolutionValueSha256,
  credentialPathPolicyFromFrozenPatterns,
  Harness,
  validateDshFilePolicyAgainstFrozenRuntime,
} from "../packages/harness/src";
import type { DshCredentialPathPolicyV1 } from "../packages/harness/src";
import {
  buildTaskPrompt,
  createTasksFromOutputHook,
  createRepairTaskHook,
  createVerifierTaskHook,
  reconcileTerminalBlockedVerifierRepair,
  resolveExecutionRoute,
  startCodexResumableAttempt,
} from "../packages/runner/src";
import { normalizeDshFilePolicy } from "../packages/runner/src/executors/dsh-process-policy";

const STAGES = [
  { id: "backend-runtime", role: "worker", executor: "dsh-cli", repositoryId: "target-backend", dependsOn: [] },
  { id: "ainovel-adapter", role: "worker", executor: "dsh-cli", repositoryId: "target-backend", dependsOn: ["backend-runtime"] },
  { id: "frontend-entry", role: "worker", executor: "dsh-cli", repositoryId: "target-frontend", dependsOn: ["ainovel-adapter"] },
  { id: "dsh-gateway", role: "worker", executor: "dsh-cli", repositoryId: "target-backend", dependsOn: ["frontend-entry"] },
  { id: "non-browser-e2e", role: "verifier", executor: "codex-resumable", repositoryId: "target-backend", dependsOn: ["dsh-gateway"] },
] as const;

describe("runtime integration task execution contracts", () => {
  let dir: string;
  let harness: Harness;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "orbs-runtime-task-contract-"));
    harness = new Harness(join(dir, "orbs.db"));
    harness.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a frozen runtime Planner projects all five host execution contracts", async () => {
    const fixture = governedRuntimeFixture(harness, dir);
    const hook = createTasksFromOutputHook({ harness });
    const result = await hook({
      run: harness.getRun(fixture.runId)!,
      task: harness.getTask(fixture.plannerTaskId)!,
      sessionName: "runtime-planner",
      prompt: "freeze graph",
      output: plannerOutput(),
    });

    expect(result.decision).toBe("continue");
    const tasks = harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 }).tasks
      .filter((task) => task.id !== fixture.plannerTaskId);
    expect(tasks).toHaveLength(5);
    for (const [index, task] of tasks.entries()) {
      const stage = STAGES[index]!;
      const repository = fixture.boundary.repositories.find((candidate) => candidate.id === stage.repositoryId)!;
      expect(task.parentId).toBe(fixture.plannerTaskId);
      expect(task.worktreePath).toContain(`${fixture.runId}-${stage.repositoryId}`);
      expect(task.config).toMatchObject({
        executor: stage.executor,
        agentBackend: stage.executor,
        permissionMode: stage.role === "worker" ? "workspace-write" : "read-only",
        repositoryId: stage.repositoryId,
        repositoryRoot: repository.repoPath,
        expectedHead: repository.expectedHead,
        runtimeIntegrationBoundarySha256: fixture.boundary.boundarySha256,
        targetSystemEvidenceBundleSha256: fixture.bundle.bundleSha256,
        forbidBrowser: true,
        browserProcessPolicy: "deny",
        worktreeStrategy: expect.objectContaining({
          repositoryId: stage.repositoryId,
          expectedHead: repository.expectedHead,
          isolated: true,
        }),
        runtimeIntegrationExecutionContract: expect.objectContaining({
          schemaVersion: 1,
          stageId: stage.id,
          stageIndex: index,
          boundarySha256: fixture.boundary.boundarySha256,
          bundleSha256: fixture.bundle.bundleSha256,
          contractSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      });
      if (stage.role === "worker") {
        const dshFilePolicyJson = JSON.stringify(task.config?.dshFilePolicy);
        expect(dshFilePolicyJson.includes("**/.env*")).toBe(false);
        expect(dshFilePolicyJson.includes("**/*api_key*")).toBe(false);
        expect(normalizeDshFilePolicy(task.config?.dshFilePolicy)).toMatchObject({
          source: "frozen-design-mutation-surfaces",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(task.config).toMatchObject({
          dshProfileIsolation: "base-headless",
          dshModelTransport: "host-brokered-deepseek",
          dshToolNetwork: "deny",
          ambientCredentialsInherited: false,
          targetCredentialsInherited: false,
          dshFilePolicy: {
            schemaVersion: 1,
            allowedPaths: repository.allowedPaths,
            readOnlyPaths: repository.readOnlyPaths,
            forbiddenPaths: expect.arrayContaining(repository.forbiddenPaths),
            credentialPathPolicy: {
              schemaVersion: 1,
              source: "frozen-runtime-credential-isolation",
              deniedSubtrees: ["story-mesh/.ainovel/**"],
              deniedBasenamePrefixes: [".env"],
              deniedFilenameTokens: ["api_key", "credential", "secret", "token"],
            },
          },
        });
        expect(resolveExecutionRoute({
          run: harness.getRun(fixture.runId)!,
          task,
          cliExecutor: "codex-resumable",
        })).toMatchObject({
          executionMode: "generic",
          backend: { id: "dsh-cli", kind: "dsh-cli", source: "task" },
        });
      } else {
        expect(task.config).toMatchObject({
          readOnly: true,
          forbidImplementation: true,
          identitySeparated: true,
        });
      }
    }
  });

  test("runtime stage completion delegates verification to the frozen graph", async () => {
    const fixture = governedRuntimeFixture(harness, dir, { legacyTasks: true });
    const graph = applyHarnessAction(harness, {
      type: "materializeRuntimeIntegrationTaskGraphRecovery",
      runId: fixture.runId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);
    const taskIds = graph.artifacts.find((artifact) => artifact.kind === "runtime_integration_task_graph_recovery")!
      .taskIds as string[];
    const [backendId, ainovelId, frontendId, gatewayId, finalVerifierId] = taskIds;
    const backend = harness.getTask(backendId!)!;
    const backendOutput = completedStageOutput("backend-runtime");
    harness.recordAttempt({ taskId: backend.id, input: {}, output: backendOutput });

    const backendResult = await createVerifierTaskHook({ harness })({
      run: harness.getRun(fixture.runId)!,
      task: harness.getTask(backend.id)!,
      sessionName: "backend-runtime",
      prompt: backend.prompt,
      output: backendOutput,
    });

    expect(backendResult).toMatchObject({
      decision: "continue",
      artifacts: [expect.objectContaining({
        kind: "frozen_runtime_graph_verification",
        sourceTaskId: backend.id,
        nextTaskId: ainovelId,
        finalVerifierTaskId: finalVerifierId,
      })],
    });
    expect(harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 }).tasks
      .filter((task) => task.role === "verifier" && task.config?.runtimeIntegrationExecutionContract)).toHaveLength(1);
    expect(harness.nextReadyTask(fixture.runId)?.id).toBe(ainovelId);

    for (const stageId of [ainovelId, frontendId, gatewayId]) {
      harness.recordAttempt({ taskId: stageId!, input: {}, output: completedStageOutput(harness.getTask(stageId!)!.goal) });
    }
    const gateway = harness.getTask(gatewayId!)!;
    const gatewayOutput = completedStageOutput(gateway.goal);
    const gatewayResult = await createVerifierTaskHook({ harness })({
      run: harness.getRun(fixture.runId)!,
      task: gateway,
      sessionName: "dsh-gateway",
      prompt: gateway.prompt,
      output: gatewayOutput,
    });
    expect(gatewayResult).toMatchObject({
      decision: "continue",
      artifacts: [expect.objectContaining({
        kind: "frozen_runtime_graph_verification",
        sourceTaskId: gateway.id,
        nextTaskId: finalVerifierId,
        finalVerifierTaskId: finalVerifierId,
      })],
    });
    expect(harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 }).tasks
      .filter((task) => task.role === "verifier" && task.config?.runtimeIntegrationExecutionContract)).toHaveLength(1);
    expect(harness.nextReadyTask(fixture.runId)?.id).toBe(finalVerifierId);
  });

  test("a final capability-only Verifier failure materializes one host evidence node and one frozen replacement Verifier", async () => {
    const fixture = governedRuntimeFixture(harness, dir, { legacyTasks: true });
    const graph = applyHarnessAction(harness, {
      type: "materializeRuntimeIntegrationTaskGraphRecovery",
      runId: fixture.runId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);
    const taskIds = graph.artifacts.find((artifact) => artifact.kind === "runtime_integration_task_graph_recovery")!
      .taskIds as string[];
    for (const taskId of taskIds.slice(0, 4)) {
      harness.recordAttempt({ taskId, input: {}, output: completedStageOutput(harness.getTask(taskId)!.goal) });
    }
    const verifierTaskId = taskIds[4]!;
    const verifierAttemptId = harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "codex-resumable", sandbox: "read-only" },
      output: capabilityOnlyVerifierFailure(),
    });
    const stopHook = await createRepairTaskHook({ harness })({
      run: harness.getRun(fixture.runId)!,
      task: harness.getTask(verifierTaskId)!,
      sessionName: "final-runtime-verifier",
      prompt: "verify",
      output: capabilityOnlyVerifierFailure(),
    });
    expect(stopHook).toMatchObject({
      decision: "exit",
      artifacts: [expect.objectContaining({
        kind: "runtime_integration_host_evidence_recovery_required",
        verifierTaskId,
      })],
    });
    expect(harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 }).tasks
      .filter((task) => task.parentId === verifierTaskId)).toHaveLength(0);
    const commands: string[] = [];
    const result = applyHarnessAction(harness, {
      type: "recoverRuntimeIntegrationHostEvidenceFailure",
      runId: fixture.runId,
      verifierTaskId,
      verifierAttemptId,
      reason: "collect the three frozen host capability receipts",
    } as never, {
      runCommand: (input) => {
        commands.push(input.command);
        return successfulHostCommand(input.command, { directLoopbackAvailable: false });
      },
    });
    const replay = applyHarnessAction(harness, {
      type: "recoverRuntimeIntegrationHostEvidenceFailure",
      runId: fixture.runId,
      verifierTaskId,
      verifierAttemptId,
      reason: "collect the three frozen host capability receipts",
    } as never, {
      runCommand: () => { throw new Error("replay must not execute host commands"); },
    });
    const overview = harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 });
    const hostTask = overview.tasks.find((task) => task.role === "system" && task.config?.runtimeIntegrationHostEvidenceRecovery)!;
    const replacement = overview.tasks.find((task) => task.role === "verifier"
      && task.id !== verifierTaskId
      && task.config?.runtimeIntegrationHostEvidenceRecovery)!;

    expect(result).toMatchObject({
      status: "done",
      actionType: "recoverRuntimeIntegrationHostEvidenceFailure",
      artifacts: [expect.objectContaining({
        kind: "runtime_integration_host_evidence_recovery",
        sourceVerifierTaskId: verifierTaskId,
        sourceVerifierAttemptId: verifierAttemptId,
        hostTaskId: hostTask.id,
        verifierTaskId: replacement.id,
        reused: false,
      })],
    });
    expect(commands).toHaveLength(7);
    expect(hostTask).toMatchObject({
      status: "done",
      dependsOn: [taskIds[3]],
      parentId: fixture.plannerTaskId,
      worktreePath: harness.getTask(verifierTaskId)?.worktreePath,
      config: {
        systemTask: true,
        runtimeIntegrationHostEvidenceRecovery: expect.objectContaining({
          boundarySha256: fixture.boundary.boundarySha256,
          bundleSha256: fixture.bundle.bundleSha256,
          sourceVerifierTaskId: verifierTaskId,
          sourceVerifierAttemptId: verifierAttemptId,
        }),
      },
    });
    expect(overview.sessions.find((session) => session.taskId === hostTask.id)?.output.checks).toContainEqual(
      expect.objectContaining({ name: "runtime integration tests", status: "passed", evidence: "53/54" }),
    );
    expect(replacement).toMatchObject({
      status: "todo",
      role: "verifier",
      goal: "non-browser-e2e",
      dependsOn: [hostTask.id],
      parentId: fixture.plannerTaskId,
      config: {
        executor: "codex-resumable",
        permissionMode: "read-only",
        readOnly: true,
        forbidImplementation: true,
        forbidBrowser: true,
        runtimeIntegrationExecutionContract: expect.objectContaining({
          stageId: "non-browser-e2e",
          taskId: replacement.id,
          contractSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        runtimeIntegrationHostEvidenceRecovery: expect.objectContaining({ hostTaskId: hostTask.id }),
      },
    });
    expect(harness.getRun(fixture.runId)?.context.repairReplanBudget).toEqual({ limit: 3, used: 1, entries: [] });
    expect(overview.tasks.filter((task) => task.role === "goal-review")).toHaveLength(0);
    expect(replay).toMatchObject({
      status: "done",
      artifacts: [expect.objectContaining({ hostTaskId: hostTask.id, verifierTaskId: replacement.id, reused: true })],
    });
  });

  test("a post-host semantic failure creates exactly one frozen DSH Repair and dependent Verifier", async () => {
    const fixture = governedRuntimeFixture(harness, dir, { legacyTasks: true });
    const graph = applyHarnessAction(harness, {
      type: "materializeRuntimeIntegrationTaskGraphRecovery",
      runId: fixture.runId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);
    const taskIds = graph.artifacts.find((artifact) => artifact.kind === "runtime_integration_task_graph_recovery")!
      .taskIds as string[];
    for (const taskId of taskIds.slice(0, 4)) {
      harness.recordAttempt({ taskId, input: {}, output: completedStageOutput(harness.getTask(taskId)!.goal) });
    }
    const firstVerifierId = taskIds[4]!;
    const firstVerifierAttemptId = harness.recordAttempt({
      taskId: firstVerifierId,
      input: { executor: "codex-resumable", sandbox: "read-only" },
      output: capabilityOnlyVerifierFailure(),
    });
    const hostRecovery = applyHarnessAction(harness, {
      type: "recoverRuntimeIntegrationHostEvidenceFailure",
      runId: fixture.runId,
      verifierTaskId: firstVerifierId,
      verifierAttemptId: firstVerifierAttemptId,
    } as never, { runCommand: (input) => successfulHostCommand(input.command) });
    const hostArtifact = hostRecovery.artifacts.find((artifact) => artifact.kind === "runtime_integration_host_evidence_recovery")!;
    const semanticVerifierId = hostArtifact.verifierTaskId as string;
    const semanticAttemptId = harness.recordAttempt({
      taskId: semanticVerifierId,
      input: { executor: "codex-resumable", sandbox: "read-only" },
      output: frozenRuntimeIdentityFailure(),
    });
    const stopHook = await createRepairTaskHook({ harness })({
      run: harness.getRun(fixture.runId)!,
      task: harness.getTask(semanticVerifierId)!,
      sessionName: "semantic-verifier",
      prompt: "verify the frozen runtime identity",
      output: frozenRuntimeIdentityFailure(),
    });
    expect(stopHook).toMatchObject({
      decision: "exit",
      artifacts: [expect.objectContaining({
        kind: "runtime_integration_semantic_repair_recovery_required",
        verifierTaskId: semanticVerifierId,
      })],
    });

    const reconciliation = await reconcileTerminalBlockedVerifierRepair({ harness, runId: fixture.runId });
    const recovered = applyHarnessAction(harness, {
      type: "materializeVerifierRepairRecovery",
      runId: fixture.runId,
      verifierTaskId: semanticVerifierId,
      reason: "repair the one frozen v6 runtime identity mismatch",
    } as never);
    const replay = applyHarnessAction(harness, {
      type: "materializeVerifierRepairRecovery",
      runId: fixture.runId,
      verifierTaskId: semanticVerifierId,
    } as never);
    const overview = harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 });
    expect(reconciliation).toEqual([expect.objectContaining({
      verifierTaskId: semanticVerifierId,
      verifierAttemptId: semanticAttemptId,
      decision: "continue",
      artifacts: [expect.objectContaining({ reused: false })],
    })]);
    expect(recovered).toMatchObject({ status: "done", problems: [], artifacts: [expect.objectContaining({ reused: true })] });
    const repair = overview.tasks.find((task) => task.role === "worker"
      && task.config?.runtimeIntegrationSemanticRepairRecovery)!;
    const verifier = overview.tasks.find((task) => task.role === "verifier"
      && task.id !== semanticVerifierId
      && task.config?.runtimeIntegrationSemanticRepairRecovery)!;

    expect(reconciliation[0]).toMatchObject({
      artifacts: [expect.objectContaining({
        verifierTaskId: semanticVerifierId,
        verifierAttemptId: semanticAttemptId,
        repairTaskId: repair.id,
        nextVerifierTaskId: verifier.id,
        reused: false,
      })],
    });
    expect(repair).toMatchObject({
      status: "todo",
      parentId: fixture.plannerTaskId,
      dependsOn: [semanticVerifierId],
      worktreePath: expect.stringContaining(`${fixture.runId}-target-backend`),
      config: {
        executor: "dsh-cli",
        permissionMode: "workspace-write",
        dshModelTransport: "host-brokered-deepseek",
        dshToolNetwork: "deny",
        runtimeIntegrationExecutionContract: expect.objectContaining({
          stageId: "runtime-semantic-repair",
          taskId: repair.id,
          contractSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      },
    });
    expect(repair.prompt).toContain("version 6");
    expect(repair.prompt).toContain("Do not modify config/evolution/** or tests/evolution/**");
    expect(verifier).toMatchObject({
      status: "todo",
      parentId: fixture.plannerTaskId,
      dependsOn: [repair.id],
      config: {
        executor: "codex-resumable",
        permissionMode: "read-only",
        runtimeIntegrationExecutionContract: expect.objectContaining({
          stageId: "non-browser-e2e",
          taskId: verifier.id,
          contractSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      },
    });
    expect(overview.run?.context.repairReplanBudget).toMatchObject({ limit: 3, used: 2 });
    expect(overview.tasks.filter((task) => task.role === "goal-review")).toHaveLength(0);
    expect(replay).toMatchObject({ status: "done", artifacts: [expect.objectContaining({ reused: true })] });
  });

  test("a no-write semantic DSH timeout continues the same charged recovery and replaces its pending Verifier", async () => {
    const fixture = governedRuntimeFixture(harness, dir, { legacyTasks: true });
    harness.updateRun({
      runId: fixture.runId,
      contextPatch: {
        evolutionInstance: { pack: { version: 6, contentSha256: "d4b9cd4cbc567a72f691741cf636dea4b6912ea341ff467b6ff93fd2c53cdb4c" } },
        designProposal: {
          episodeCollectionContract: { id: "host-receipt-episodes-v6-runtime" },
          maturityGateContract: { id: "host-receipt-maturity-v6-runtime", packRef: { version: 6, contentSha256: "d4b9cd4cbc567a72f691741cf636dea4b6912ea341ff467b6ff93fd2c53cdb4c" } },
          productionEpisodePrivacyReceiptContract: { id: "host-receipt-privacy-v6-runtime" },
          promotionReceiptContract: { id: "host-receipt-promotion-v6-runtime" },
          rollbackContract: { id: "host-receipt-rollback-v6-runtime" },
        },
        irrelevantHistoricalContext: "OLD-HISTORY-MARKER-".repeat(4_000),
      },
    });
    const graph = applyHarnessAction(harness, {
      type: "materializeRuntimeIntegrationTaskGraphRecovery",
      runId: fixture.runId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);
    const taskIds = graph.artifacts.find((artifact) => artifact.kind === "runtime_integration_task_graph_recovery")!
      .taskIds as string[];
    for (const taskId of taskIds.slice(0, 4)) {
      harness.recordAttempt({ taskId, input: {}, output: completedStageOutput(harness.getTask(taskId)!.goal) });
    }
    const firstVerifierId = taskIds[4]!;
    const firstVerifierAttemptId = harness.recordAttempt({
      taskId: firstVerifierId,
      input: { executor: "codex-resumable", sandbox: "read-only" },
      output: capabilityOnlyVerifierFailure(),
    });
    const hostRecovery = applyHarnessAction(harness, {
      type: "recoverRuntimeIntegrationHostEvidenceFailure",
      runId: fixture.runId,
      verifierTaskId: firstVerifierId,
      verifierAttemptId: firstVerifierAttemptId,
    } as never, { runCommand: (input) => successfulHostCommand(input.command) });
    const semanticVerifierId = hostRecovery.artifacts.find((artifact) =>
      artifact.kind === "runtime_integration_host_evidence_recovery")!.verifierTaskId as string;
    harness.recordAttempt({
      taskId: semanticVerifierId,
      input: { executor: "codex-resumable", sandbox: "read-only" },
      output: frozenRuntimeIdentityFailure(),
    });
    applyHarnessAction(harness, {
      type: "materializeVerifierRepairRecovery",
      runId: fixture.runId,
      verifierTaskId: semanticVerifierId,
    } as never);
    const before = harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 });
    const repair = before.tasks.find((task) => task.role === "worker"
      && task.config?.runtimeIntegrationSemanticRepairRecovery)!;
    const pendingVerifier = before.tasks.find((task) => task.role === "verifier"
      && task.id !== semanticVerifierId
      && task.config?.runtimeIntegrationSemanticRepairRecovery)!;
    const budgetBefore = before.run!.context.repairReplanBudget;
    const timedOutAttemptId = harness.recordAttempt({
      taskId: repair.id,
      input: { executor: "dsh-cli", cwd: repair.worktreePath },
      output: {
        status: "blocked",
        summary: "DeepSeek Harness CLI failed",
        changedFiles: [],
        checks: [{ name: "dsh headless execution", status: "failed" }],
        artifacts: [{
          kind: "dsh_execution_profile_receipt",
          modelTransport: { requestCount: 62 },
          noTargetNetworkBypass: true,
        }],
        problems: ["exit code: 124 stderr: command timed out after 1800000ms"],
      },
    });

    const reconciliation = await reconcileTerminalBlockedVerifierRepair({ harness, runId: fixture.runId });
    const after = harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 });
    const continuation = after.tasks.find((task) => {
      const marker = task.config?.runtimeIntegrationSemanticRepairContinuation as Record<string, unknown> | undefined;
      return marker?.sourceAttemptId === timedOutAttemptId;
    })!;
    expect(reconciliation).toEqual([expect.objectContaining({ decision: "continue" })]);
    expect(continuation).toBeDefined();
    const replacementVerifier = after.tasks.find((task) => task.role === "verifier"
      && task.dependsOn.length === 1
      && task.dependsOn[0] === continuation.id)!;

    expect(reconciliation).toEqual([expect.objectContaining({
      decision: "continue",
      artifacts: [expect.objectContaining({
        kind: "runtime_semantic_repair_continuation",
        sourceRepairTaskId: repair.id,
        sourceRepairAttemptId: timedOutAttemptId,
        continuationTaskId: continuation.id,
        verifierTaskId: replacementVerifier.id,
        budgetCharged: false,
      })],
    })]);
    expect(harness.getTask(pendingVerifier.id)?.status).toBe("blocked");
    expect(continuation).toMatchObject({
      status: "todo",
      parentId: fixture.plannerTaskId,
      dependsOn: [semanticVerifierId],
      worktreePath: repair.worktreePath,
      config: {
        executor: "dsh-cli",
        permissionMode: "workspace-write",
        dshNoWriteProgressPolicy: {
          maxStallMs: 600_000,
          minModelRequests: 12,
          probeIntervalMs: 30_000,
        },
      },
    });
    expect(continuation.prompt).toContain("host-receipt-episodes-v6-runtime");
    expect(continuation.prompt).not.toContain("## Frozen Task Configuration");
    const boundedPrompt = buildTaskPrompt({
      run: after.run!,
      task: continuation,
      dependencyAttempts: [],
      lessons: [],
    });
    expect(boundedPrompt.length).toBeLessThan(30_000);
    expect(boundedPrompt).not.toContain("OLD-HISTORY-MARKER");
    expect(replacementVerifier).toMatchObject({
      status: "todo",
      dependsOn: [continuation.id],
      config: { executor: "codex-resumable", permissionMode: "read-only" },
    });
    expect(after.run!.context.repairReplanBudget).toEqual(budgetBefore);
    expect(after.tasks.filter((task) => task.role === "goal-review")).toHaveLength(0);
    const leased = harness.leaseReadyTasks({
      runId: fixture.runId,
      limit: 1,
      sessionForTask: (task) => `session-${task.id}`,
    });
    expect(leased.map((task) => task.id)).toEqual([continuation.id]);

    harness.runInImmediateTransaction((db) => {
      db.query(
        "update tasks set status = 'blocked', depends_on_json = $dependsOn where id = $taskId",
      ).run({ $taskId: continuation.id, $dependsOn: JSON.stringify([repair.id]) });
      db.query("update tasks set status = 'blocked' where id = $taskId")
        .run({ $taskId: replacementVerifier.id });
    });
    const migrated = applyHarnessAction(harness, {
      type: "materializeVerifierRepairRecovery",
      runId: fixture.runId,
      verifierTaskId: semanticVerifierId,
      reason: "replace the unschedulable legacy same-budget continuation",
    } as never);
    const migratedOverview = harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 });
    const migratedArtifact = migrated.artifacts.find((artifact) =>
      artifact.kind === "runtime_semantic_repair_continuation"
    )!;
    const migratedContinuationId = migratedArtifact.continuationTaskId as string;
    const migratedVerifierId = migratedArtifact.verifierTaskId as string;
    const migratedContinuation = migratedOverview.tasks.find((task) => task.id === migratedContinuationId)!;
    expect(migratedContinuationId).not.toBe(continuation.id);
    expect(migratedContinuation).toMatchObject({
      status: "todo",
      role: "worker",
      dependsOn: [semanticVerifierId],
    });
    expect(migratedOverview.tasks.find((task) => task.id === migratedVerifierId)).toMatchObject({
      status: "todo",
      role: "verifier",
      dependsOn: [migratedContinuationId],
    });
    expect(harness.leaseReadyTasks({
      runId: fixture.runId,
      limit: 1,
      sessionForTask: (task) => `migrated-session-${task.id}`,
    }).map((task) => task.id)).toEqual([migratedContinuationId]);
    expect(migratedOverview.run!.context.repairReplanBudget).toEqual(budgetBefore);
  });

  test("failed host evidence remains terminal and prepareRunDrain never creates Goal Review", () => {
    const fixture = governedRuntimeFixture(harness, dir, { legacyTasks: true });
    const graph = applyHarnessAction(harness, {
      type: "materializeRuntimeIntegrationTaskGraphRecovery",
      runId: fixture.runId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);
    const taskIds = graph.artifacts.find((artifact) => artifact.kind === "runtime_integration_task_graph_recovery")!
      .taskIds as string[];
    for (const taskId of taskIds.slice(0, 4)) {
      harness.recordAttempt({ taskId, input: {}, output: completedStageOutput(harness.getTask(taskId)!.goal) });
    }
    const verifierTaskId = taskIds[4]!;
    const verifierAttemptId = harness.recordAttempt({
      taskId: verifierTaskId,
      input: { executor: "codex-resumable", sandbox: "read-only" },
      output: capabilityOnlyVerifierFailure(),
    });
    let commandCount = 0;
    const result = applyHarnessAction(harness, {
      type: "recoverRuntimeIntegrationHostEvidenceFailure",
      runId: fixture.runId,
      verifierTaskId,
      verifierAttemptId,
      reason: "collect the frozen host capability receipts",
    } as never, {
      runCommand: (input) => {
        commandCount += 1;
        if (input.command.endsWith(" --version")) return { exitCode: 0, stdout: "v25.8.1\n", stderr: "" };
        if (input.command.includes("docker info")) return { exitCode: 1, stdout: "", stderr: "docker unavailable" };
        if (input.command.includes(" --test")) {
          return { exitCode: 0, stdout: "1..54\n# tests 54\n# pass 54\n# fail 0\n# skipped 0\n", stderr: "" };
        }
        return { exitCode: 0, stdout: `${JSON.stringify({ schemaVersion: 1, evidenceId: "evidence:host:failed" })}\n`, stderr: "" };
      },
    });
    const replay = applyHarnessAction(harness, {
      type: "recoverRuntimeIntegrationHostEvidenceFailure",
      runId: fixture.runId,
      verifierTaskId,
      verifierAttemptId,
      reason: "collect the frozen host capability receipts",
    } as never, {
      runCommand: () => { throw new Error("failed recovery replay must not execute host commands"); },
    });
    const drain = applyHarnessAction(harness, {
      type: "prepareRunDrain",
      runId: fixture.runId,
      maxTries: 2,
      reason: "no ready work after failed host evidence",
    });
    const overview = harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 });

    expect(result.status).toBe("blocked");
    expect(replay.status).toBe("blocked");
    expect(commandCount).toBe(7);
    expect(overview.run?.status).toBe("blocked");
    expect(overview.tasks.filter((task) => task.role === "system")).toHaveLength(1);
    expect(overview.tasks.filter((task) => task.role === "verifier"
      && task.config?.runtimeIntegrationHostEvidenceRecovery)).toHaveLength(0);
    expect(overview.tasks.filter((task) => task.role === "goal-review")).toHaveLength(0);
    expect(drain).toMatchObject({
      status: "blocked",
      problems: [expect.stringContaining("Goal Review is not permitted")],
    });
  });

  test("runtime task creation rejects workers and verifiers outside the frozen graph", () => {
    const fixture = governedRuntimeFixture(harness, dir, { legacyTasks: true });
    const graph = applyHarnessAction(harness, {
      type: "materializeRuntimeIntegrationTaskGraphRecovery",
      runId: fixture.runId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);
    const taskIds = graph.artifacts.find((artifact) => artifact.kind === "runtime_integration_task_graph_recovery")!
      .taskIds as string[];

    expect(() => harness.createTask({
      runId: fixture.runId,
      role: "verifier",
      goal: "Verify: backend-runtime",
      prompt: "This verifier was not frozen by the Planner.",
      dependsOn: [taskIds[0]!],
    })).toThrow("runtime integration execution contract is missing");
  });

  test("leasing blocks a legacy out-of-graph verifier and selects the frozen next stage", () => {
    const fixture = governedRuntimeFixture(harness, dir, { legacyTasks: true });
    const graph = applyHarnessAction(harness, {
      type: "materializeRuntimeIntegrationTaskGraphRecovery",
      runId: fixture.runId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);
    const taskIds = graph.artifacts.find((artifact) => artifact.kind === "runtime_integration_task_graph_recovery")!
      .taskIds as string[];
    const [backendId, ainovelId] = taskIds;
    harness.recordAttempt({ taskId: backendId!, input: {}, output: completedStageOutput("backend-runtime") });
    const rogueVerifierId = "task_rogue_runtime_stage_verifier";
    harness.runInImmediateTransaction((db) => {
      db.query(
        `insert into tasks (
           id, run_id, parent_id, cycle_id, status, role, goal, prompt,
           depends_on_json, done_when_json, worktree_path, config_json, created_at, updated_at
         ) values (
           $id, $runId, null, $cycleId, 'todo', 'verifier', $goal, $prompt,
           $dependsOn, '[]', null, '{}', '2000-01-01 00:00:00', '2000-01-01 00:00:00'
         )`,
      ).run({
        $id: rogueVerifierId,
        $runId: fixture.runId,
        $cycleId: harness.getTask(backendId!)!.cycleId,
        $goal: "Verify: backend-runtime",
        $prompt: "Legacy verifier without a frozen execution contract.",
        $dependsOn: JSON.stringify([backendId]),
      });
    });

    const leased = harness.leaseReadyTasks({
      runId: fixture.runId,
      limit: 1,
      sessionForTask: (task) => `session-${task.id}`,
    });

    expect(leased.map((task) => task.id)).toEqual([ainovelId]);
    expect(harness.getTask(rogueVerifierId)?.status).toBe("blocked");
    const rogueAttempt = harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 }).sessions
      .find((session) => session.taskId === rogueVerifierId);
    expect(rogueAttempt).toMatchObject({
      status: "blocked",
      output: {
        problems: [expect.stringContaining("runtime integration execution contract is missing")],
      },
    });
  });

  test("a runtime Worker file policy may tighten reads and denials but never widen writes", () => {
    const fixture = governedRuntimeFixture(harness, dir);
    const backend = fixture.boundary.repositories.find((candidate) => candidate.id === "target-backend")!;
    const policy = {
      schemaVersion: 1 as const,
      source: "frozen-runtime-integration-boundary",
      allowedPaths: [...backend.allowedPaths],
      readOnlyPaths: [...backend.readOnlyPaths],
      forbiddenPaths: [...backend.forbiddenPaths],
      credentialPathPolicy: {
        schemaVersion: 1 as const,
        source: "frozen-runtime-credential-isolation" as const,
        deniedSubtrees: ["story-mesh/.ainovel/**"],
        deniedBasenamePrefixes: [".env"],
        deniedFilenameTokens: ["api_key", "credential", "secret", "token"],
      } satisfies DshCredentialPathPolicyV1,
    };
    const mutationSurfaces = [
      {
        id: "target-backend",
        allowedPaths: [...backend.allowedPaths],
        forbiddenPaths: [...backend.readOnlyPaths, ...backend.forbiddenPaths],
      },
      {
        id: "target-frontend",
        allowedPaths: ["src-react/features/studio-os/**"],
        forbiddenPaths: [".git/orbs/**", ".orbs/**", ".ouroboros/**", "db/**"],
      },
    ];

    expect(validateDshFilePolicyAgainstFrozenRuntime({
      policy,
      repositoryId: "target-backend",
      boundary: fixture.boundary,
      mutationSurfaces,
    })).toEqual({
      schemaVersion: 1,
      source: "frozen-design-mutation-surfaces",
      allowedPaths: [...backend.allowedPaths].sort(),
      readOnlyPaths: [...backend.readOnlyPaths].sort(),
      forbiddenPaths: [...backend.forbiddenPaths].sort(),
      credentialPathPolicy: policy.credentialPathPolicy,
    });

    expect(() => validateDshFilePolicyAgainstFrozenRuntime({
      policy: {
        ...policy,
        forbiddenPaths: policy.forbiddenPaths.filter((entry) => entry !== ".git/orbs/**"),
      },
      repositoryId: "target-backend",
      boundary: fixture.boundary,
      mutationSurfaces,
    })).toThrow("missing frozen forbidden path");

    expect(() => validateDshFilePolicyAgainstFrozenRuntime({
      policy: { ...policy, allowedPaths: [...policy.allowedPaths, "src/unauthorized/**"] },
      repositoryId: "target-backend",
      boundary: fixture.boundary,
      mutationSurfaces,
    })).toThrow("allowed write path exceeds");

    expect(() => validateDshFilePolicyAgainstFrozenRuntime({
      policy: {
        ...policy,
        credentialPathPolicy: {
          ...policy.credentialPathPolicy,
          deniedFilenameTokens: ["api_key", "credential", "secret"],
        },
      },
      repositoryId: "target-backend",
      boundary: fixture.boundary,
      mutationSurfaces,
    })).toThrow("credential path policy");

    expect(() => validateDshFilePolicyAgainstFrozenRuntime({
      policy: { ...policy, forbiddenPaths: [...policy.forbiddenPaths, "**/*api_key*"] },
      repositoryId: "target-backend",
      boundary: fixture.boundary,
      mutationSurfaces,
    })).toThrow("unsafe path");
  });

  test("an incomplete stored runtime Worker is blocked before hooks or a Codex client", async () => {
    const fixture = governedRuntimeFixture(harness, dir, { legacyTasks: true });
    let startHookCalls = 0;
    let clientCalls = 0;
    const result = await startCodexResumableAttempt({
      harness,
      taskId: fixture.legacyTaskIds[0]!,
      cwd: dir,
      startHooks: [() => {
        startHookCalls += 1;
        return {};
      }],
      clientFactory: () => {
        clientCalls += 1;
        throw new Error("client must not start");
      },
    });

    expect(result.status).toBe("blocked");
    expect(startHookCalls).toBe(0);
    expect(clientCalls).toBe(0);
    expect(harness.getAttempt(result.attemptId)?.output.problems).toContainEqual(
      expect.stringContaining("runtime integration execution contract"),
    );
  });

  test("the fixed recovery retires the legacy five and materializes one replay-safe graph", () => {
    const fixture = governedRuntimeFixture(harness, dir, { legacyTasks: true });
    const beforeBudget = harness.getRun(fixture.runId)!.context.repairReplanBudget;
    const result = applyHarnessAction(harness, {
      type: "materializeRuntimeIntegrationTaskGraphRecovery",
      runId: fixture.runId,
      plannerTaskId: fixture.plannerTaskId,
      reason: "replace incomplete runtime task contracts",
    } as never);

    expect(result.status).toBe("done");
    const artifact = result.artifacts.find((candidate) => candidate.kind === "runtime_integration_task_graph_recovery")!;
    const createdTaskIds = artifact.taskIds as string[];
    expect(createdTaskIds).toHaveLength(5);
    expect(fixture.legacyTaskIds.map((id) => harness.getTask(id)?.status)).toEqual(Array(5).fill("blocked"));
    const created = createdTaskIds.map((id) => harness.getTask(id)!);
    expect(created.map((task) => task.status)).toEqual(Array(5).fill("todo"));
    expect(created.map((task) => task.parentId)).toEqual(Array(5).fill(fixture.plannerTaskId));
    expect(created[0]!.dependsOn).toEqual([fixture.plannerTaskId]);
    expect(created.slice(1).map((task, index) => task.dependsOn)).toEqual(
      created.slice(0, -1).map((task) => [task.id]),
    );
    expect(harness.getRun(fixture.runId)!.context.repairReplanBudget).toEqual(beforeBudget);
    expect(harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 }).sessions
      .filter((session) => createdTaskIds.includes(session.taskId))).toHaveLength(0);

    const replay = applyHarnessAction(harness, {
      type: "materializeRuntimeIntegrationTaskGraphRecovery",
      runId: fixture.runId,
      plannerTaskId: fixture.plannerTaskId,
      reason: "replace incomplete runtime task contracts",
    } as never);
    expect(replay).toMatchObject({
      status: "done",
      artifacts: [expect.objectContaining({ taskIds: createdTaskIds, reused: true })],
    });
    expect(harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 }).tasks
      .filter((task) => task.config?.runtimeIntegrationExecutionContract)).toHaveLength(5);
    expect(harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 }).tasks
      .filter((task) => task.role === "goal-review")).toHaveLength(0);
  });

  test("a fixed recovery closes a dead preparation attempt and replaces its frozen task graph once", () => {
    const fixture = governedRuntimeFixture(harness, dir, { legacyTasks: true });
    const first = applyHarnessAction(harness, {
      type: "materializeRuntimeIntegrationTaskGraphRecovery",
      runId: fixture.runId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);
    const firstTaskIds = first.artifacts.find((artifact) => artifact.kind === "runtime_integration_task_graph_recovery")!
      .taskIds as string[];
    const backendTaskId = firstTaskIds[0]!;
    const attemptId = harness.startAttempt({ taskId: backendTaskId, input: { preparation: "dsh-file-policy" } });
    harness.upsertExecutionThread({
      id: `thread_${attemptId}`,
      runId: fixture.runId,
      taskId: backendTaskId,
      attemptId,
      ownerType: "runner",
      ownerId: "dead-owner",
      role: "worker",
      status: "running",
      pid: 999_999,
    });
    const beforeBudget = harness.getRun(fixture.runId)!.context.repairReplanBudget;

    const recovered = applyHarnessAction(harness, {
      type: "recoverRuntimeIntegrationTaskGraphPreparationFailure",
      runId: fixture.runId,
      taskId: backendTaskId,
      attemptId,
      reason: "DSH file policy semantic validation failed before model startup",
    } as never);

    expect(recovered.status).toBe("done");
    const artifact = recovered.artifacts.find((candidate) =>
      candidate.kind === "runtime_integration_task_graph_preparation_recovery")!;
    const replacementTaskIds = artifact.taskIds as string[];
    expect(replacementTaskIds).toHaveLength(5);
    expect(replacementTaskIds).not.toEqual(firstTaskIds);
    expect(firstTaskIds.map((id) => harness.getTask(id)?.status)).toEqual(Array(5).fill("blocked"));
    expect(replacementTaskIds.map((id) => harness.getTask(id)?.status)).toEqual(Array(5).fill("todo"));
    expect(harness.getAttempt(attemptId)).toMatchObject({ status: "blocked", error: expect.stringContaining("DSH file policy") });
    expect(harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 }).sessions
      .find((session) => session.attemptId === attemptId)?.finishedAt).toEqual(expect.any(String));
    expect(harness.listExecutionThreads({ runId: fixture.runId }).find((thread) => thread.attemptId === attemptId)).toMatchObject({
      status: "interrupted",
      interruptReason: expect.stringContaining("DSH file policy"),
      interruptedAt: expect.any(String),
    });
    expect(harness.listExecutionThreads({ runId: fixture.runId }).filter((thread) => thread.status === "running")).toHaveLength(0);
    expect(harness.getRun(fixture.runId)!.context.repairReplanBudget).toEqual(beforeBudget);
    expect(harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 }).tasks.filter((task) => task.role === "goal-review")).toHaveLength(0);

    const replay = applyHarnessAction(harness, {
      type: "recoverRuntimeIntegrationTaskGraphPreparationFailure",
      runId: fixture.runId,
      taskId: backendTaskId,
      attemptId,
      reason: "DSH file policy semantic validation failed before model startup",
    } as never);
    expect(replay).toMatchObject({
      status: "done",
      artifacts: [expect.objectContaining({ taskIds: replacementTaskIds, reused: true })],
    });

    const secondBackendTaskId = replacementTaskIds[0]!;
    const secondAttemptId = harness.startAttempt({ taskId: secondBackendTaskId, input: { preparation: "credential-path-policy" } });
    harness.finishAttempt({
      attemptId: secondAttemptId,
      output: {
        status: "blocked",
        summary: "DSH policy preflight failed before model startup",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: ["DSH file policy forbiddenPaths contains an unsafe path: **/*api_key*"],
      },
    });
    const second = applyHarnessAction(harness, {
      type: "recoverRuntimeIntegrationTaskGraphPreparationFailure",
      runId: fixture.runId,
      taskId: secondBackendTaskId,
      attemptId: secondAttemptId,
      reason: "legacy credential globs failed before model startup",
    } as never);
    expect(second.status).toBe("done");
    const secondReplacementTaskIds = second.artifacts.find((candidate) =>
      candidate.kind === "runtime_integration_task_graph_preparation_recovery")!.taskIds as string[];
    expect(secondReplacementTaskIds).toHaveLength(5);
    expect(secondReplacementTaskIds).not.toEqual(replacementTaskIds);
    expect(replacementTaskIds.map((id) => harness.getTask(id)?.status)).toEqual(Array(5).fill("blocked"));
    expect(secondReplacementTaskIds.map((id) => harness.getTask(id)?.status)).toEqual(Array(5).fill("todo"));
    expect(harness.getRun(fixture.runId)!.context.runtimeIntegrationTaskGraphPreparationRecoveries).toHaveLength(2);
    expect(harness.getRun(fixture.runId)!.context.repairReplanBudget).toEqual(beforeBudget);
    expect(harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 }).tasks.filter((task) => task.role === "goal-review")).toHaveLength(0);

    const exhaustedBackendId = secondReplacementTaskIds[0]!;
    const exhaustedAttemptId = harness.startAttempt({ taskId: exhaustedBackendId, input: { preparation: "third-policy-failure" } });
    harness.finishAttempt({
      attemptId: exhaustedAttemptId,
      output: {
        status: "blocked",
        summary: "third preparation failure",
        changedFiles: [], checks: [], artifacts: [],
        problems: ["DSH file policy failed again"],
      },
    });
    const exhausted = applyHarnessAction(harness, {
      type: "recoverRuntimeIntegrationTaskGraphPreparationFailure",
      runId: fixture.runId,
      taskId: exhaustedBackendId,
      attemptId: exhaustedAttemptId,
      reason: "third DSH policy preparation failure",
    } as never);
    expect(exhausted).toMatchObject({
      status: "blocked",
      problems: [expect.stringContaining("exhausted (2/2)")],
    });
    expect(harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 }).tasks
      .filter((task) => task.config?.runtimeIntegrationExecutionContract)).toHaveLength(15);
  });

  test("an installed DSH receipt unlocks one separate recovery after executable readiness failure", () => {
    const sourceRepoPath = join(dir, "dsh");
    const artifactPath = join(sourceRepoPath, "apps", "cli", "lib", "bin.js");
    const executablePath = join(dir, "bin", "dsh");
    mkdirSync(join(sourceRepoPath, "apps", "cli", "src"), { recursive: true });
    writeFileSync(join(sourceRepoPath, "package.json"), JSON.stringify({
      name: "@deepseek-ai/dsh-root", scripts: { "build:lib:host": "fixture" }, packageManager: "pnpm@11.7.0",
    }));
    writeFileSync(join(sourceRepoPath, "apps", "cli", "package.json"), JSON.stringify({
      name: "@deepseek-ai/dsh", version: "0.1.0-rc.5", bin: { dsh: "lib/bin.js" },
    }));
    writeFileSync(join(sourceRepoPath, "apps", "cli", "src", "bin.ts"), "console.log('source')\n");
    gitFixture(sourceRepoPath, ["init"]);
    gitFixture(sourceRepoPath, ["config", "user.email", "fixture@example.test"]);
    gitFixture(sourceRepoPath, ["config", "user.name", "Fixture"]);
    gitFixture(sourceRepoPath, ["add", "."]);
    gitFixture(sourceRepoPath, ["commit", "-m", "fixture"]);
    const expectedHead = gitFixture(sourceRepoPath, ["rev-parse", "HEAD"]);
    mkdirSync(join(sourceRepoPath, "node_modules", "typescript", "bin"), { recursive: true });
    mkdirSync(join(sourceRepoPath, "node_modules", "tsdown", "dist"), { recursive: true });
    writeFileSync(join(sourceRepoPath, "node_modules", "typescript", "bin", "tsc"), "// fixture\n");
    writeFileSync(join(sourceRepoPath, "node_modules", "tsdown", "dist", "run.mjs"), "// fixture\n");
    const backendHead = initializeRepository(join(dir, "backend"));
    const frontendHead = initializeRepository(join(dir, "frontend"));
    const fixture = governedRuntimeFixture(harness, dir, {
      legacyTasks: true,
      dshExpectedHead: expectedHead,
      backendExpectedHead: backendHead,
      frontendExpectedHead: frontendHead,
    });
    const graph = applyHarnessAction(harness, {
      type: "materializeRuntimeIntegrationTaskGraphRecovery",
      runId: fixture.runId,
      plannerTaskId: fixture.plannerTaskId,
    } as never);
    const taskIds = graph.artifacts.find((artifact) => artifact.kind === "runtime_integration_task_graph_recovery")!.taskIds as string[];
    const sourceTaskId = taskIds[0]!;
    const attemptId = harness.startAttempt({ taskId: sourceTaskId, input: { readiness: "dsh" } });
    harness.finishAttempt({
      attemptId,
      output: {
        status: "blocked",
        summary: "DSH executable could not start",
        changedFiles: [], checks: [], artifacts: [],
        problems: ["ENOENT: no such file or directory, posix_spawn '/fixture/bin/dsh'"],
      },
    });
    const installation = applyHarnessAction(harness, {
      type: "installLocalDshCli",
      runId: fixture.runId,
      sourceRepoPath,
      expectedHead,
      executablePath,
    } as never, {
      runCommand: (input) => {
        if (input.command.includes("typescript/bin/tsc") && input.command.includes("tsdown") && input.command.includes("DSH_BUILD_FACE")) {
          mkdirSync(join(sourceRepoPath, "apps", "cli", "lib"), { recursive: true });
          writeFileSync(artifactPath, "#!/usr/bin/env node\nconsole.log('0.1.0-rc.5')\n");
          chmodSync(artifactPath, 0o755);
          return { exitCode: 0, stdout: "built", stderr: "" };
        }
        if (input.command.endsWith(" --version") && input.command.includes("node")) return { exitCode: 0, stdout: "v25.5.0\n", stderr: "" };
        if (input.command.endsWith(" --version")) return { exitCode: 0, stdout: "0.1.0-rc.5\n", stderr: "" };
        if (input.command.endsWith(" --help")) return { exitCode: 0, stdout: "Usage: dsh\n", stderr: "" };
        throw new Error(`unexpected command: ${input.command}`);
      },
    });
    expect(installation.status).toBe("done");
    const beforeBudget = harness.getRun(fixture.runId)!.context.repairReplanBudget;

    const recovered = applyHarnessAction(harness, {
      type: "recoverRuntimeIntegrationDshInstallationFailure",
      runId: fixture.runId,
      taskId: sourceTaskId,
      attemptId,
      reason: "install the pinned DSH host CLI after a dangling launcher",
    } as never);

    expect(recovered.status).toBe("done");
    const artifact = recovered.artifacts.find((candidate) => candidate.kind === "runtime_integration_dsh_installation_recovery")!;
    const replacementIds = artifact.taskIds as string[];
    expect(replacementIds).toHaveLength(5);
    expect(taskIds.map((id) => harness.getTask(id)?.status)).toEqual(Array(5).fill("blocked"));
    expect(replacementIds.map((id) => harness.getTask(id)?.status)).toEqual(Array(5).fill("todo"));
    expect(harness.getTask(replacementIds[0]!)?.config).toMatchObject({
      executor: "dsh-cli",
      dshInstallationReceipt: expect.objectContaining({ sourceHead: expectedHead }),
      dshInstallationReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(harness.getRun(fixture.runId)!.context.repairReplanBudget).toEqual(beforeBudget);
    expect(harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 }).sessions
      .filter((session) => replacementIds.includes(session.taskId))).toHaveLength(0);
    expect(harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 }).tasks
      .filter((task) => task.role === "goal-review")).toHaveLength(0);

    const replacementBackendId = replacementIds[0]!;
    const bindingAttemptId = harness.startAttempt({ taskId: replacementBackendId, input: { readiness: "runtime-binding" } });
    harness.finishAttempt({
      attemptId: bindingAttemptId,
      output: {
        status: "blocked",
        summary: "DeepSeek Harness runtime binding is unavailable",
        changedFiles: [], checks: [],
        artifacts: [{ kind: "dsh_runtime_binding_receipt", status: "blocked", diagnosticCode: "runtime-binding-denied" }],
        problems: [`frozen task worktree does not exist: ${harness.getTask(replacementBackendId)!.worktreePath}`],
      },
    });

    const rebound = applyHarnessAction(harness, {
      type: "recoverRuntimeIntegrationDshRuntimeBindingFailure",
      runId: fixture.runId,
      taskId: replacementBackendId,
      attemptId: bindingAttemptId,
      reason: "materialize the frozen repository worktrees before the exact DSH runtime binding",
    } as never);

    expect(rebound.problems).toEqual([]);
    expect(rebound.status).toBe("done");
    const reboundArtifact = rebound.artifacts.find((candidate) => candidate.kind === "runtime_integration_dsh_runtime_binding_recovery")!;
    const reboundIds = reboundArtifact.taskIds as string[];
    expect(reboundIds).toHaveLength(5);
    expect(reboundArtifact.worktrees).toEqual(expect.arrayContaining([
      expect.objectContaining({ repositoryId: "target-backend", expectedHead: backendHead, status: "passed" }),
      expect.objectContaining({ repositoryId: "target-frontend", expectedHead: frontendHead, status: "passed" }),
    ]));
    expect(replacementIds.map((id) => harness.getTask(id)?.status)).toEqual(Array(5).fill("blocked"));
    expect(reboundIds.map((id) => harness.getTask(id)?.status)).toEqual(Array(5).fill("todo"));
    for (const taskId of reboundIds) {
      const task = harness.getTask(taskId)!;
      expect(task.worktreePath).toBeTruthy();
      expect(gitFixture(task.worktreePath!, ["rev-parse", "HEAD"])).toBe(String(task.config?.expectedHead));
    }
    expect(harness.getRun(fixture.runId)!.context.repairReplanBudget).toEqual(beforeBudget);
    expect(harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 }).sessions
      .filter((session) => reboundIds.includes(session.taskId))).toHaveLength(0);
    expect(harness.getRunOverview({ runId: fixture.runId, eventLimit: 0 }).tasks
      .filter((task) => task.role === "goal-review")).toHaveLength(0);
    const replay = applyHarnessAction(harness, {
      type: "recoverRuntimeIntegrationDshRuntimeBindingFailure",
      runId: fixture.runId,
      taskId: replacementBackendId,
      attemptId: bindingAttemptId,
      reason: "materialize the frozen repository worktrees before the exact DSH runtime binding",
    } as never);
    expect(replay.status).toBe("done");
    expect(replay.artifacts[0]).toMatchObject({ reused: true, taskIds: reboundIds });
  });

  test("maps only the frozen credential classifier vocabulary", () => {
    expect(credentialPathPolicyFromFrozenPatterns([
      "story-mesh/.ainovel/**",
      "**/.env*",
      "**/*api_key*",
      "**/*token*",
      "**/*credential*",
      "**/*secret*",
    ])).toEqual({
      schemaVersion: 1,
      source: "frozen-runtime-credential-isolation",
      deniedSubtrees: ["story-mesh/.ainovel/**"],
      deniedBasenamePrefixes: [".env"],
      deniedFilenameTokens: ["api_key", "credential", "secret", "token"],
    });
    expect(() => credentialPathPolicyFromFrozenPatterns(["**/*payment*"])).toThrow("unsafe path");
  });
});

function governedRuntimeFixture(harness: Harness, root: string, options: {
  legacyTasks?: boolean;
  dshExpectedHead?: string;
  backendExpectedHead?: string;
  frontendExpectedHead?: string;
} = {}) {
  const projectId = harness.createProject({ name: "runtime target", rootPath: join(root, "backend") });
  const parentRunId = harness.createRun({
    projectId,
    goal: "Design runtime integration",
    context: { source: "target-system-design" },
  });
  const proposal = harness.createDesignProposal({
    projectId,
    runId: parentRunId,
    title: "Runtime integration",
    problem: "The verified package is not in the runtime.",
    recommendation: "Deliver the frozen five-stage graph.",
    status: "accepted",
    proposal: {
      problem: "The verified package is not in the runtime.",
      recommendation: "Deliver the frozen five-stage graph.",
      evaluationContract: {
        baseline: ["package only"],
        successMetrics: ["runtime evidence"],
        guardMetrics: ["zero credential exposure"],
        requiredEvidence: ["identity-separated verifier"],
      },
      investment: { reversibility: "easy", portfolio: "core", oneTimeCost: 0, recurringCost: 0 },
    },
  });
  const decision = harness.recordDesignDecision({
    proposalId: proposal.id,
    decision: "approved",
    actorKind: "auto",
    actorRef: "authority-evaluator",
  });
  const repositories = [
    {
      id: "target-backend", role: "backend", projectId, repoPath: join(root, "backend"),
      expectedHead: options.backendExpectedHead ?? "4".repeat(40), access: "isolated-write",
      allowedPaths: ["src/application/**", "tests/runtime-integration/**"],
      readOnlyPaths: ["config/evolution/**", "tests/evolution/**"],
      forbiddenPaths: [".git/orbs/**", ".orbs/**", ".ouroboros/**", "db/**"],
    },
    {
      id: "target-frontend", role: "frontend", projectId: "project_frontend", repoPath: join(root, "frontend"),
      expectedHead: options.frontendExpectedHead ?? "d".repeat(40), access: "new-isolated-worktree",
      allowedPaths: ["src-react/features/studio-os/**"], readOnlyPaths: [],
      forbiddenPaths: [".git/orbs/**", ".orbs/**", ".ouroboros/**", "db/**"],
    },
    {
      id: "ainovel-source", role: "ainovel", projectId: null, repoPath: join(root, "story-mesh"),
      expectedHead: "8".repeat(40), access: "read-only",
      allowedPaths: ["apps/text-worker/src/**"], readOnlyPaths: ["apps/text-worker/src/**"],
      forbiddenPaths: [".ainovel/**", ".env*", "**/*token*", "**/*credential*", "**/*secret*"],
    },
    {
      id: "dsh-source", role: "dsh", projectId: null, repoPath: join(root, "dsh"),
      expectedHead: options.dshExpectedHead ?? "7".repeat(40), access: "read-only",
      allowedPaths: ["apps/cli/src/**"], readOnlyPaths: ["apps/cli/src/**"],
      forbiddenPaths: [".git/orbs/**", ".orbs/**", ".ouroboros/**", "db/**"],
    },
  ];
  const boundaryBody = {
    schemaVersion: 1,
    repositories,
    gateway: { host: "127.0.0.1", port: 10588, browserAllowed: false },
  };
  const boundary = {
    ...boundaryBody,
    boundarySha256: canonicalEvolutionValueSha256(boundaryBody),
    taskGraph: STAGES.map((stage) => ({ ...stage, dependsOn: [...stage.dependsOn] })),
    credentialIsolation: {
      forbiddenPaths: ["story-mesh/.ainovel/**", "**/.env*", "**/*api_key*", "**/*token*", "**/*credential*", "**/*secret*"],
      modelReceivesCredentials: false,
      hostInjectionOnly: true,
    },
  };
  const bundleBody = {
    schemaVersion: 1,
    purpose: "runtime-integration-after-verified-package",
    targetProjectId: projectId,
    runtimeIntegrationBoundary: boundary,
    boundarySha256: boundary.boundarySha256,
    repositoryHeads: repositories.map(({ id, expectedHead }) => ({ id, expectedHead })),
    credentialIsolation: boundary.credentialIsolation,
  };
  const bundle = { ...bundleBody, bundleSha256: canonicalEvolutionValueSha256(bundleBody) };
  harness.updateRun({ runId: parentRunId, contextPatch: { targetSystemEvidenceBundle: bundle, runtimeIntegrationBoundary: boundary } });
  const runId = harness.createRun({
    projectId,
    goal: "Deliver runtime integration",
    context: options.legacyTasks ? { source: "legacy" } : {
      source: "design",
      parentRunId,
      designProposalId: proposal.id,
      designDecisionId: decision.id,
      runtimeIntegrationBoundary: boundary,
      targetSystemEvidenceBundle: bundle,
      repairReplanBudget: { limit: 3, used: 1, entries: [] },
    },
  });
  const plannerGoal = "Plan runtime integration";
  const plannerPrompt = "Return the exact five-stage graph.";
  if (!options.legacyTasks) {
    harness.updateRun({
      runId,
      contextPatch: {
        designDeliveryPlan: { schemaVersion: 1, runGoal: "Deliver runtime integration", planner: { goal: plannerGoal, prompt: plannerPrompt, doneWhen: [], config: {} } },
      },
    });
  }
  const verifierContract = {
    schemaVersion: 1,
    source: "frozen-design-evaluation-contract",
    designProposalId: proposal.id,
    designDecisionId: decision.id,
    evaluationContract: proposal.proposal.evaluationContract,
    evaluationContractSha256: canonicalEvolutionValueSha256(proposal.proposal.evaluationContract),
  };
  const plannerTaskId = harness.createTask({
    runId,
    role: "planner",
    goal: plannerGoal,
    prompt: plannerPrompt,
    config: {
      runtimeIntegrationBoundary: boundary,
      runtimeIntegrationTaskGraph: STAGES,
      targetSystemEvidenceBundle: bundle,
      verifierContract,
      frozenDesignPlanner: {
        schemaVersion: 1,
        canonicalPlannerTaskId: "pending",
        designProposalId: proposal.id,
        designDecisionId: decision.id,
        verifierContractSha256: canonicalEvolutionValueSha256(verifierContract),
      },
    },
  });
  const plannerConfig = harness.getTask(plannerTaskId)!.config!;
  plannerConfig.frozenDesignPlanner = {
    ...(plannerConfig.frozenDesignPlanner as Record<string, unknown>),
    canonicalPlannerTaskId: plannerTaskId,
  };
  harness.runInImmediateTransaction((db) => {
    db.query("update tasks set config_json = $config where id = $id").run({ $id: plannerTaskId, $config: JSON.stringify(plannerConfig) });
  });
  harness.recordAttempt({ taskId: plannerTaskId, input: {}, output: plannerOutput() });

  const legacyTaskIds: string[] = [];
  if (options.legacyTasks) {
    for (const [index, stage] of STAGES.entries()) {
      legacyTaskIds.push(harness.createTask({
        runId,
        role: stage.role,
        goal: stage.id,
        prompt: `Execute ${stage.id}.`,
        dependsOn: index === 0 ? [plannerTaskId] : [legacyTaskIds[index - 1]!, plannerTaskId].filter(Boolean),
        doneWhen: [`${stage.id} done`],
        config: { verifierContract, frozenDesignPlanner: plannerConfig.frozenDesignPlanner },
      }));
    }
    harness.updateRun({
      runId,
      status: "todo",
      contextPatch: {
        source: "design",
        parentRunId,
        designProposalId: proposal.id,
        designDecisionId: decision.id,
        designDeliveryPlan: { schemaVersion: 1, runGoal: "Deliver runtime integration", planner: { goal: plannerGoal, prompt: plannerPrompt, doneWhen: [], config: {} } },
        runtimeIntegrationBoundary: boundary,
        repairReplanBudget: { limit: 3, used: 1, entries: [] },
      },
    });
  }
  return { runId, plannerTaskId, legacyTaskIds, boundary, bundle };
}

function plannerOutput() {
  return {
    status: "done" as const,
    summary: "The exact runtime graph is frozen.",
    changedFiles: [],
    checks: [],
    artifacts: [],
    problems: [],
    nextTasks: STAGES.map((stage) => ({
      role: stage.role,
      goal: stage.id,
      prompt: `Execute ${stage.id}.`,
      dependsOn: [...stage.dependsOn],
      doneWhen: [`${stage.id} done`],
    })),
  };
}

function completedStageOutput(stageId: string) {
  return {
    status: "done" as const,
    summary: `${stageId} completed within its frozen contract.`,
    changedFiles: [],
    checks: [{ name: `${stageId} deterministic checks`, status: "passed" as const }],
    artifacts: [
      { kind: "runtime_stage_receipt", stageId },
      {
        kind: "dsh_execution_profile_receipt",
        modelTransport: { enforcement: "loopback-http-broker", credentialIsolation: true },
        toolSandbox: { network: "deny", credentialsInherited: false },
        noTargetNetworkBypass: true,
      },
    ],
    problems: [],
  };
}

function frozenRuntimeIdentityFailure() {
  return {
    status: "done" as const,
    verdict: "fail" as const,
    summary: "Host evidence passed, but runtime identifiers remain on v5 instead of the frozen v6 contract.",
    changedFiles: [],
    checks: [
      { name: "host capability receipt", status: "passed" as const },
      { name: "frozen v6 delivery-contract identity", status: "failed" as const },
    ],
    artifacts: [{ kind: "consumed-host-evidence-receipt" }],
    problems: [
      'message: Runtime uses v5 identifiers; frozen delivery requires version 6 and v6 runtime receipt identifiers.; extra: {"code":"FROZEN_DELIVERY_CONTRACT_MISMATCH"}',
    ],
  };
}

function successfulHostCommand(command: string, options: { directLoopbackAvailable?: boolean } = {}) {
  const directLoopbackAvailable = options.directLoopbackAvailable ?? true;
  if (command.endsWith(" --version")) return { exitCode: 0, stdout: "v25.8.1\n", stderr: "" };
  if (command.includes("docker info")) return { exitCode: 0, stdout: "29.1.3\n", stderr: "" };
  if (command.includes(" --test")) {
    return directLoopbackAvailable
      ? { exitCode: 0, stdout: "1..54\n# tests 54\n# pass 54\n# fail 0\n# skipped 0\n", stderr: "" }
      : { exitCode: 0, stdout: "1..54\n# tests 54\n# pass 53\n# fail 0\n# skipped 1\n", stderr: "" };
  }
  if (command.includes("docker run")) {
    return {
      exitCode: 0,
      stdout: `IMAGE_ID=sha256:${"a".repeat(64)}\n${JSON.stringify({
        schemaVersion: 1,
        kind: "ainovel-adapter-worker-receipt",
        http: { realServer: { available: true, host: "127.0.0.1", port: 10588, boundToGateway: true, browserExecuted: false } },
      })}\n`,
      stderr: "",
    };
  }
  const payload = command.includes("readback-backend-runtime")
    ? {
        schemaVersion: 1,
        kind: "backend-runtime-worker-receipt",
        postgres: {
          available: true,
          schemaCreated: true,
          evidenceReadbackMatches: true,
          rollbackPersisted: true,
          restartPersistence: { runSurvivesRestart: true, evidenceSurvivesRestart: true, rollbackReceiptsAfterRestart: 1 },
        },
      }
    : command.includes("readback-ainovel-adapter")
      ? {
          schemaVersion: 1,
          kind: "ainovel-adapter-worker-receipt",
          postgres: { available: true, schemaCreated: true, readbackMatches: true, restartPersistence: { evidenceSurvivesRestart: true } },
          http: { realServer: directLoopbackAvailable
            ? { available: true, host: "127.0.0.1", port: 10588, boundToGateway: true, browserExecuted: false }
            : { available: false, reason: "listen EADDRINUSE: address already in use 127.0.0.1:10588", browserExecuted: false } },
        }
      : {
          schemaVersion: 1,
          kind: "dsh-gateway-worker-receipt",
          gatewayBinding: { host: "127.0.0.1", port: 10588 },
          forwarding: { ok: true, allBound: true, requestToResponseBound: true, responseToDatabaseBound: true, responseToHttpPathBound: true },
          addressEnforcement: { validBindingAccepted: true, nonLoopbackRejected: true, alternatePortRejected: true },
        };
  return { exitCode: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
}

function capabilityOnlyVerifierFailure() {
  return {
    status: "done" as const,
    verdict: "fail" as const,
    summary: "All frozen business evidence passed; only host PostgreSQL, loopback HTTP, and Docker receipts are unavailable in the read-only model sandbox.",
    changedFiles: [],
    checks: [
      { name: "repository-heads", status: "passed" as const },
      { name: "frozen-package", status: "passed" as const },
      { name: "authorized-changed-paths", status: "passed" as const },
      { name: "ten-capability-in-process-receipts", status: "passed" as const, count: 10 },
      { name: "rollback", status: "passed" as const },
      { name: "matched-comparison-assertions", status: "passed" as const },
      { name: "browser-and-side-effects", status: "passed" as const },
      { name: "postgresql-real-readback", status: "failed" as const },
      { name: "loopback-http-real-readback", status: "failed" as const },
      { name: "docker-capability", status: "failed" as const },
    ],
    artifacts: [
      { kind: "identity-separated-verifier-report", readOnly: true, browserDenied: true },
      { kind: "docker-capability-route-evidence", hostServerVersion: "29.1.3", sandboxSocketAccess: "denied" },
    ],
    problems: [
      'message: PostgreSQL evidence unavailable.; extra: {"code":"REAL_POSTGRES_EVIDENCE_UNAVAILABLE"}',
      'message: Loopback HTTP evidence unavailable.; extra: {"code":"REAL_LOOPBACK_HTTP_EVIDENCE_UNAVAILABLE"}',
      'message: End-to-end binding incomplete.; extra: {"code":"END_TO_END_BINDING_INCOMPLETE"}',
    ],
  };
}

function gitFixture(cwd: string, args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function initializeRepository(path: string) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, ".gitignore"), ".ouroboros/\n");
  writeFileSync(join(path, "README.md"), "fixture\n");
  gitFixture(path, ["init"]);
  gitFixture(path, ["config", "user.email", "fixture@example.test"]);
  gitFixture(path, ["config", "user.name", "Fixture"]);
  gitFixture(path, ["add", "."]);
  gitFixture(path, ["commit", "-m", "fixture"]);
  return gitFixture(path, ["rev-parse", "HEAD"]);
}
