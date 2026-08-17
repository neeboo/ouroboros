import { canonicalEvolutionValueSha256 } from "./target-evolution";
import type { Task, TaskConfig } from "./types";

export const OVERALL_GOAL_INTEGRATION_STAGES = [
  { id: "verify-backend", role: "verifier", executor: "codex-resumable", repositoryId: "target-backend" },
  { id: "verify-frontend", role: "verifier", executor: "codex-resumable", repositoryId: "target-frontend" },
  { id: "commit-push-backend", role: "system", executor: "host-fixed-action", repositoryId: "target-backend" },
  { id: "commit-push-frontend", role: "system", executor: "host-fixed-action", repositoryId: "target-frontend" },
  { id: "runtime-switch-evidence", role: "system", executor: "host-fixed-action", repositoryId: "host-runtime" },
] as const;

export interface OverallGoalIntegrationProjection {
  stageId: string;
  id: string;
  role: string;
  goal: string;
  prompt: string;
  dependsOn: string[];
  doneWhen: string[];
  parentId: string;
  worktreePath: string | null;
  config: TaskConfig;
}

export function projectOverallGoalIntegrationTaskGraph(input: {
  runId: string;
  plannerTaskId: string;
  proposalId: string;
  decisionId: string;
  closeout: unknown;
  evidenceBundle: unknown;
  verifierContract: unknown;
  frozenDesignPlanner: unknown;
  taskIds: string[];
}): { graph: Record<string, unknown>; tasks: OverallGoalIntegrationProjection[] } {
  const closeout = requireObject(input.closeout, "overallGoalIntegrationCloseout");
  const verifierContract = requireObject(input.verifierContract, "verifierContract");
  const frozenDesignPlanner = requireObject(input.frozenDesignPlanner, "frozenDesignPlanner");
  const bundle = requireObject(input.evidenceBundle, "targetSystemEvidenceBundle");
  const bundleSha256 = requireSha(bundle.bundleSha256, "targetSystemEvidenceBundle.bundleSha256");
  const { bundleSha256: _bundleSha256, ...bundleBody } = bundle;
  if (canonicalEvolutionValueSha256(bundleBody) !== bundleSha256) {
    throw new Error("overall-goal integration authoritative bundle hash mismatch");
  }
  if (bundle.purpose !== "overall-goal-integration-closeout"
    || closeout.bundleSha256 !== bundleSha256
    || closeout.schemaVersion !== 1) {
    throw new Error("overall-goal integration closeout binding drifted");
  }
  const frozenStages = stringArray(closeout.stages, "overallGoalIntegrationCloseout.stages");
  const expectedStages = OVERALL_GOAL_INTEGRATION_STAGES.map((stage) => stage.id);
  if (!same(frozenStages, expectedStages) || input.taskIds.length !== expectedStages.length) {
    throw new Error("overall-goal integration closeout must materialize the exact five-stage graph");
  }
  const worktrees = array(bundle.worktrees, "targetSystemEvidenceBundle.worktrees")
    .map((value, index) => parseWorktree(value, `targetSystemEvidenceBundle.worktrees[${index}]`));
  const backend = worktrees.find((worktree) => worktree.repositoryId === "target-backend");
  const frontend = worktrees.find((worktree) => worktree.repositoryId === "target-frontend");
  if (!backend || !frontend || worktrees.length !== 2) {
    throw new Error("overall-goal integration bundle must bind exactly backend and frontend worktrees");
  }
  const exclusions = requireObject(bundle.temporaryAndControlExclusions, "temporaryAndControlExclusions");
  const backendExclusions = stringArray(exclusions.targetBackend, "temporaryAndControlExclusions.targetBackend");
  const frontendExclusions = stringArray(exclusions.targetFrontend, "temporaryAndControlExclusions.targetFrontend");
  const taskIdsByStage = new Map<string, string>(expectedStages.map((stage, index) => [stage, input.taskIds[index]!]));
  const dependencyStages: Record<string, string[]> = {
    "verify-backend": [],
    "verify-frontend": ["verify-backend"],
    "commit-push-backend": ["verify-backend", "verify-frontend"],
    "commit-push-frontend": ["verify-backend", "verify-frontend", "commit-push-backend"],
    "runtime-switch-evidence": ["commit-push-backend", "commit-push-frontend"],
  };
  const graphBody = {
    schemaVersion: 1,
    kind: "overall-goal-integration-closeout",
    runId: input.runId,
    plannerTaskId: input.plannerTaskId,
    proposalId: input.proposalId,
    decisionId: input.decisionId,
    bundleSha256,
    verifierContract,
    frozenDesignPlanner,
    stages: expectedStages.map((stageId, index) => ({ stageId, taskId: input.taskIds[index] })),
  };
  const graph = { ...graphBody, graphSha256: canonicalEvolutionValueSha256(graphBody) };
  const tasks = OVERALL_GOAL_INTEGRATION_STAGES.map((stage, index): OverallGoalIntegrationProjection => {
    const worktree = stage.repositoryId === "target-backend"
      ? backend
      : stage.repositoryId === "target-frontend" ? frontend : null;
    const taskId = input.taskIds[index]!;
    const dependencies = dependencyStages[stage.id]!;
    const dependsOn = dependencies.length === 0
      ? [input.plannerTaskId]
      : dependencies.map((dependency) => taskIdsByStage.get(dependency)!);
    const exclusionsForStage = stage.repositoryId === "target-backend" ? backendExclusions : frontendExclusions;
    const eligibleFiles = worktree?.files.filter((file) => file.commitDisposition === "eligible") ?? [];
    const contractBody = {
      schemaVersion: 1,
      graphSha256: graph.graphSha256,
      runId: input.runId,
      plannerTaskId: input.plannerTaskId,
      taskId,
      stageId: stage.id,
      stageIndex: index,
      role: stage.role,
      executor: stage.executor,
      repositoryId: stage.repositoryId,
      bundleSha256,
      parentId: input.plannerTaskId,
      dependsOn,
      worktreePath: worktree?.worktreePath ?? null,
      expectedHead: worktree?.head ?? null,
      branch: worktree?.branch ?? null,
      worktreeReceiptSha256: worktree?.receiptSha256 ?? null,
      eligibleManifestSha256: worktree ? canonicalEvolutionValueSha256(eligibleFiles) : null,
      exclusionsSha256: worktree ? canonicalEvolutionValueSha256(exclusionsForStage) : null,
      browser: "deny",
      credentials: "deny",
    };
    const executionContract = {
      ...contractBody,
      contractSha256: canonicalEvolutionValueSha256(contractBody),
    };
    const common: TaskConfig = {
      executor: stage.executor,
      permissionMode: stage.role === "verifier" ? "read-only" : "host-control-plane",
      repositoryId: stage.repositoryId,
      ...(worktree ? {
        repositoryRoot: worktree.repositoryRoot,
        expectedHead: worktree.head,
        expectedBranch: worktree.branch,
        frozenWorktreeReceiptSha256: worktree.receiptSha256,
      } : {}),
      targetSystemEvidenceBundleSha256: bundleSha256,
      worktreeStrategy: worktree ? {
        schemaVersion: 1,
        mode: "existing-isolated-worktree",
        repositoryId: worktree.repositoryId,
        repositoryRoot: worktree.repositoryRoot,
        expectedHead: worktree.head,
        branch: worktree.branch,
        path: worktree.worktreePath,
        isolated: true,
        writesUserWorktree: false,
      } : {
        schemaVersion: 1,
        mode: "host-runtime-receipt",
        isolated: true,
        writesUserWorktree: false,
      },
      networkPolicy: { mode: "deny" },
      credentialIsolation: { ambient: "deny", target: "deny", model: "deny" },
      forbidBrowser: true,
      browserProcessPolicy: "deny",
      forbidNextTasks: true,
      forbidNextRuns: true,
      overallGoalIntegrationCloseout: closeout,
      verifierContract,
      frozenDesignPlanner,
      overallGoalIntegrationExecutionContract: executionContract,
    };
    const config: TaskConfig = stage.role === "verifier"
      ? {
          ...common,
          readOnly: true,
          forbidImplementation: true,
          identitySeparated: true,
          frozenRepositoryReceipt: worktree,
          verifierScope: "hash-path-index-readback-only",
        }
      : stage.id === "runtime-switch-evidence"
      ? {
          ...common,
          systemTask: true,
          hostActionType: "collectOverallGoalRuntimeSwitchEvidence",
          hostCapabilities: {
            dockerSocket: "frozen-host-owned",
            postgres: "contract-authorized-local",
            loopback: { host: "127.0.0.1", ports: [10588] },
          },
          modelExecutionAllowed: false,
        }
      : {
          ...common,
          systemTask: true,
          hostActionType: "commitAndPushOverallGoalRepository",
          frozenRepositoryReceipt: worktree,
          eligibleFiles,
          exclusions: exclusionsForStage,
          hostGitActions: ["stageExactWorkerFilesForVerification", "commitExactGitIndex", "pushExactGitRef"],
          networkPolicy: { mode: "host-fixed-actions", capability: "git-push", clearAmbientProxy: true },
          modelExecutionAllowed: false,
        };
    return {
      stageId: stage.id,
      id: taskId,
      role: stage.role,
      goal: stage.id,
      prompt: stagePrompt(stage.id, worktree, bundleSha256),
      dependsOn,
      doneWhen: stageDoneWhen(stage.id),
      parentId: input.plannerTaskId,
      worktreePath: worktree?.worktreePath ?? null,
      config,
    };
  });
  return { graph, tasks };
}

export function overallGoalIntegrationTaskExecutionProblem(input: {
  runId: string;
  closeout: unknown;
  evidenceBundle: unknown;
  graph: unknown;
  task: Task;
}): string | null {
  if (input.task.role === "planner") return null;
  try {
    const graph = requireObject(input.graph, "overallGoalIntegrationCloseoutTaskGraph");
    const stages = array(graph.stages, "overallGoalIntegrationCloseoutTaskGraph.stages");
    if (!stages.some((value) => requireObject(value, "stage").taskId === input.task.id)) {
      throw new Error(`task ${input.task.id} is outside the frozen overall-goal integration task graph`);
    }
    const projected = projectOverallGoalIntegrationTaskGraph({
      runId: input.runId,
      plannerTaskId: stringValue(graph.plannerTaskId),
      proposalId: stringValue(graph.proposalId),
      decisionId: stringValue(graph.decisionId),
      closeout: input.closeout,
      evidenceBundle: input.evidenceBundle,
      verifierContract: graph.verifierContract,
      frozenDesignPlanner: graph.frozenDesignPlanner,
      taskIds: stages.map((value) => stringValue(requireObject(value, "stage").taskId)),
    }).tasks.find((task) => task.id === input.task.id);
    if (!projected) throw new Error(`task ${input.task.id} has no frozen overall-goal projection`);
    if (!same(input.task.role, projected.role)
      || !same(input.task.goal, projected.goal)
      || !same(input.task.parentId, projected.parentId)
      || !same(input.task.worktreePath, projected.worktreePath)
      || !same(input.task.dependsOn, projected.dependsOn)
      || !same(input.task.config, projected.config)) {
      throw new Error(`task ${input.task.id} overall-goal integration execution contract drifted`);
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function parseWorktree(value: unknown, label: string) {
  const record = requireObject(value, label);
  const files = array(record.files, `${label}.files`).map((file, index) => {
    const item = requireObject(file, `${label}.files[${index}]`);
    return {
      path: stringValue(item.path), status: stringValue(item.status),
      sha256: requireSha(item.sha256, `${label}.files[${index}].sha256`),
      sizeBytes: numberValue(item.sizeBytes), commitDisposition: stringValue(item.commitDisposition),
    };
  });
  return {
    schemaVersion: 1, repositoryId: stringValue(record.repositoryId), repositoryRoot: stringValue(record.repositoryRoot),
    worktreePath: stringValue(record.worktreePath), branch: stringValue(record.branch), head: stringValue(record.head),
    commonGitDir: stringValue(record.commonGitDir), allowedPaths: stringArray(record.allowedPaths, `${label}.allowedPaths`),
    readOnlyPaths: stringArray(record.readOnlyPaths, `${label}.readOnlyPaths`),
    forbiddenPaths: stringArray(record.forbiddenPaths, `${label}.forbiddenPaths`), files,
    receiptSha256: requireSha(record.receiptSha256, `${label}.receiptSha256`),
  };
}

function stagePrompt(stageId: string, worktree: ReturnType<typeof parseWorktree> | null, bundleSha256: string) {
  if (stageId.startsWith("verify-")) return `Read-only verify ${worktree!.repositoryId} at ${worktree!.worktreePath} against frozen receipt ${worktree!.receiptSha256} and bundle ${bundleSha256}. Read only path, SHA-256, branch, HEAD, and index state. Do not modify files, Git metadata, refs, control data, credentials, network state, or browser state.`;
  if (stageId.startsWith("commit-push-")) return `Execute only the host-owned exact staging, commit, push, and remote-ref readback for ${worktree!.repositoryId} from bundle ${bundleSha256}. Never start a model or stage an unlisted, temporary, control, frozen, or user-worktree path.`;
  return `Execute only the host-owned Docker, PostgreSQL restart-persistence, 127.0.0.1:10588 HTTP identity, and local process commit-binding receipts for bundle ${bundleSha256}. Never start a model, browser, or unrestricted network process.`;
}

function stageDoneWhen(stageId: string) {
  if (stageId.startsWith("verify-")) return ["branch, HEAD, path set, sizes, SHA-256 values, exclusions, and index state exactly match the frozen receipt", "the verifier is read-only and reports no implementation or side effects"];
  if (stageId.startsWith("commit-push-")) return ["the staged manifest exactly equals the frozen eligible path and SHA-256 manifest", "commit, tree, parent, branch, push, remote ref, and matching remote SHA receipts exist", "temporary, control, frozen, user-worktree, and unlisted paths remain excluded"];
  return ["Docker image, container, and health receipts bind to both remote commit SHAs", "PostgreSQL persistence survives restart and binds to the backend commit", "127.0.0.1:10588 HTTP identity and the local process bind to both commits"];
}

function requireObject(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; }
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new Error(`${label} must be an array`); return value; }
function stringArray(value: unknown, label: string): string[] { const values = array(value, label); if (!values.every((item) => typeof item === "string" && item.length > 0)) throw new Error(`${label} must contain strings`); return values as string[]; }
function stringValue(value: unknown): string { if (typeof value !== "string" || value.length === 0) throw new Error("expected a non-empty string"); return value; }
function numberValue(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("expected a non-negative integer"); return value; }
function requireSha(value: unknown, label: string): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be SHA-256`); return value; }
function same(left: unknown, right: unknown) { return JSON.stringify(left) === JSON.stringify(right); }
