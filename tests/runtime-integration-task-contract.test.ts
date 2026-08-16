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
  createTasksFromOutputHook,
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
    const fixture = governedRuntimeFixture(harness, dir, { legacyTasks: true, dshExpectedHead: expectedHead });
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
        if (input.command === "npm run build:lib:host") {
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

function governedRuntimeFixture(harness: Harness, root: string, options: { legacyTasks?: boolean; dshExpectedHead?: string } = {}) {
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
      expectedHead: "4".repeat(40), access: "isolated-write",
      allowedPaths: ["src/application/**", "tests/runtime-integration/**"],
      readOnlyPaths: ["config/evolution/**", "tests/evolution/**"],
      forbiddenPaths: [".git/orbs/**", ".orbs/**", ".ouroboros/**", "db/**"],
    },
    {
      id: "target-frontend", role: "frontend", projectId: "project_frontend", repoPath: join(root, "frontend"),
      expectedHead: "d".repeat(40), access: "new-isolated-worktree",
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

function gitFixture(cwd: string, args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
