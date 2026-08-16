import { join } from "node:path";
import {
  credentialPathPolicyFromFrozenPatterns,
  normalizeDshFilePolicyContract,
  type DshFilePolicyContractV1,
} from "./dsh-file-policy";
import { canonicalEvolutionValueSha256 } from "./target-evolution";
import type { Task, TaskConfig } from "./types";

export const RUNTIME_INTEGRATION_TASK_GRAPH = [
  { id: "backend-runtime", role: "worker", executor: "dsh-cli", repositoryId: "target-backend", dependsOn: [] },
  { id: "ainovel-adapter", role: "worker", executor: "dsh-cli", repositoryId: "target-backend", dependsOn: ["backend-runtime"] },
  { id: "frontend-entry", role: "worker", executor: "dsh-cli", repositoryId: "target-frontend", dependsOn: ["ainovel-adapter"] },
  { id: "dsh-gateway", role: "worker", executor: "dsh-cli", repositoryId: "target-backend", dependsOn: ["frontend-entry"] },
  { id: "non-browser-e2e", role: "verifier", executor: "codex-resumable", repositoryId: "target-backend", dependsOn: ["dsh-gateway"] },
] as const;

export interface RuntimeIntegrationPlannedTask {
  role: string;
  goal: string;
  prompt: string;
  dependsOn?: string[];
  doneWhen?: string[];
}

export interface RuntimeIntegrationTaskProjection {
  stageId: string;
  id: string;
  role: string;
  goal: string;
  prompt: string;
  dependsOn: string[];
  doneWhen: string[];
  parentId: string;
  worktreePath: string;
  config: TaskConfig;
}

export type FrozenRuntimeDshFilePolicy = DshFilePolicyContractV1;

export function validateDshFilePolicyAgainstFrozenRuntime(input: {
  policy: unknown;
  repositoryId: unknown;
  boundary: unknown;
  mutationSurfaces: unknown;
}): FrozenRuntimeDshFilePolicy {
  const policy = normalizeDshFilePolicyContract(input.policy);
  const { allowedPaths, readOnlyPaths, forbiddenPaths } = policy;

  const boundary = requireObject(input.boundary, "runtimeIntegrationBoundary");
  const repositoryId = stringValue(input.repositoryId);
  const repositories = Array.isArray(boundary.repositories) ? boundary.repositories : [];
  const repository = repositories
    .map((value, index) => requireObject(value, `runtimeIntegrationBoundary.repositories[${index}]`))
    .find((candidate) => candidate.id === repositoryId);
  if (!repository) throw new Error(`runtime integration repository is missing: ${repositoryId}`);
  const repositoryAllowed = normalizedPolicyPatterns(repository.allowedPaths, `${repositoryId}.allowedPaths`);
  for (const candidate of allowedPaths) {
    if (!repositoryAllowed.some((frozen) => policyPatternContains(frozen, candidate))) {
      throw new Error(`DSH allowed write path exceeds the frozen repository boundary: ${candidate}`);
    }
  }

  const surfaceValues = Array.isArray(input.mutationSurfaces) ? input.mutationSurfaces : [];
  const surfaces = surfaceValues.map((value, index) => {
    const surface = requireObject(value, `mutationSurfaces[${index}]`);
    return {
      allowedPaths: normalizedPolicyPatterns(surface.allowedPaths, `mutationSurfaces[${index}].allowedPaths`),
      forbiddenPaths: normalizedPolicyPatterns(surface.forbiddenPaths, `mutationSurfaces[${index}].forbiddenPaths`),
    };
  });
  const matchingSurface = surfaces.find((surface) => allowedPaths.every((candidate) =>
    surface.allowedPaths.some((frozen) => policyPatternContains(frozen, candidate))));
  if (!matchingSurface) throw new Error("DSH allowed write path exceeds the frozen design mutation surfaces");

  const requiredForbidden = normalizedPolicyPatterns(repository.forbiddenPaths, `${repositoryId}.forbiddenPaths`);
  for (const required of requiredForbidden) {
    if (!forbiddenPaths.includes(required)) {
      throw new Error(`DSH file policy is missing frozen forbidden path: ${required}`);
    }
  }
  const expectedCredentialPathPolicy = credentialPathPolicyFromFrozenPatterns(
    objectOrNull(boundary.credentialIsolation)?.forbiddenPaths ?? [],
  );
  if (JSON.stringify(policy.credentialPathPolicy) !== JSON.stringify(expectedCredentialPathPolicy)) {
    throw new Error("DSH credential path policy drifted from frozen credential isolation");
  }
  const deniedWritePaths = new Set([...readOnlyPaths, ...forbiddenPaths]);
  const requiredReadOnly = normalizedPolicyPatterns(repository.readOnlyPaths ?? [], `${repositoryId}.readOnlyPaths`);
  for (const required of [...matchingSurface.forbiddenPaths, ...requiredReadOnly]) {
    if (!deniedWritePaths.has(required)) {
      throw new Error(`DSH file policy is missing frozen read-only path: ${required}`);
    }
  }
  return {
    schemaVersion: 1,
    source: "frozen-design-mutation-surfaces",
    allowedPaths,
    readOnlyPaths,
    forbiddenPaths,
    credentialPathPolicy: expectedCredentialPathPolicy,
  };
}

export function projectRuntimeIntegrationTaskGraph(input: {
  runId: string;
  plannerTaskId: string;
  boundary: unknown;
  evidenceBundle: unknown;
  plannedTasks: RuntimeIntegrationPlannedTask[];
  taskIds: string[];
  verifierContract: Record<string, unknown>;
  frozenDesignPlanner: Record<string, unknown>;
}): RuntimeIntegrationTaskProjection[] {
  const frozen = parseFrozenRuntimeIntegration(input.boundary, input.evidenceBundle);
  if (input.taskIds.length !== RUNTIME_INTEGRATION_TASK_GRAPH.length) {
    throw new Error("runtime integration task graph must allocate exactly five task ids");
  }
  if (input.frozenDesignPlanner.canonicalPlannerTaskId !== input.plannerTaskId) {
    throw new Error("runtime integration frozen Planner identity does not match the source Planner");
  }
  if (input.plannedTasks.length !== RUNTIME_INTEGRATION_TASK_GRAPH.length) {
    throw new Error("runtime integration Planner must return exactly five frozen tasks");
  }
  const idsByStage = new Map(RUNTIME_INTEGRATION_TASK_GRAPH.map((stage, index) => [stage.id, input.taskIds[index]!]));
  return RUNTIME_INTEGRATION_TASK_GRAPH.map((stage, index) => {
    const planned = input.plannedTasks[index]!;
    if (planned.role !== stage.role || planned.goal !== stage.id) {
      throw new Error(`runtime integration task ${index} must be ${stage.role}:${stage.id}`);
    }
    if (!sameValue(planned.dependsOn ?? [], stage.dependsOn)) {
      throw new Error(`runtime integration task ${stage.id} dependencies drifted from the frozen graph`);
    }
    const repository = frozen.repositories.get(stage.repositoryId);
    if (!repository) throw new Error(`runtime integration repository is missing: ${stage.repositoryId}`);
    const taskId = input.taskIds[index]!;
    const worktreePath = join(repository.repoPath, ".ouroboros", "worktrees", `${input.runId}-${repository.id}`);
    const dependencyIds = stage.dependsOn.length === 0
      ? [input.plannerTaskId]
      : stage.dependsOn.map((dependency) => idsByStage.get(dependency)!);
    const stageBody = {
      schemaVersion: 1,
      runId: input.runId,
      plannerTaskId: input.plannerTaskId,
      taskId,
      stageId: stage.id,
      stageIndex: index,
      role: stage.role,
      executor: stage.executor,
      repositoryId: repository.id,
      repositoryRoot: repository.repoPath,
      expectedHead: repository.expectedHead,
      worktreePath,
      boundarySha256: frozen.boundarySha256,
      bundleSha256: frozen.bundleSha256,
      permissionMode: stage.role === "worker" ? "workspace-write" : "read-only",
      network: stage.role === "worker"
        ? { modelTransport: "host-brokered-deepseek", toolNetwork: "deny" }
        : { mode: "frozen-verifier-contract" },
      credentialIsolation: {
        ambientCredentialsInherited: false,
        targetCredentialsInherited: false,
        modelReceivesCredentials: false,
      },
      readBindings: readBindingsForStage(stage.id),
      browser: "deny",
      identitySeparated: stage.role === "verifier",
    };
    const runtimeIntegrationExecutionContract = {
      ...stageBody,
      contractSha256: canonicalEvolutionValueSha256(stageBody),
    };
    const worktreeStrategy = {
      schemaVersion: 1,
      mode: repository.access === "new-isolated-worktree"
        ? "new-isolated-worktree"
        : "isolated-repository-chain",
      repositoryId: repository.id,
      repositoryRoot: repository.repoPath,
      expectedHead: repository.expectedHead,
      path: worktreePath,
      isolated: true,
      writesUserWorktree: false,
    };
    const shared = {
      executor: stage.executor,
      agentBackend: stage.executor,
      permissionMode: stage.role === "worker" ? "workspace-write" : "read-only",
      repositoryId: repository.id,
      repositoryRoot: repository.repoPath,
      expectedHead: repository.expectedHead,
      worktreeStrategy,
      runtimeIntegrationBoundarySha256: frozen.boundarySha256,
      targetSystemEvidenceBundleSha256: frozen.bundleSha256,
      runtimeIntegrationExecutionContract,
      verifierContract: input.verifierContract,
      frozenDesignPlanner: input.frozenDesignPlanner,
      forbidBrowser: true,
      browserProcessPolicy: "deny",
      ambientCredentialsInherited: false,
      targetCredentialsInherited: false,
    };
    const config: TaskConfig = stage.role === "worker"
      ? {
          ...shared,
          dshProfileIsolation: "base-headless",
          dshRequiredPlugins: [],
          dshModelTransport: "host-brokered-deepseek",
          dshToolNetwork: "deny",
          dshFilePolicy: normalizeDshFilePolicyContract({
            schemaVersion: 1,
            source: "frozen-runtime-integration-boundary",
            allowedPaths: repository.allowedPaths,
            readOnlyPaths: repository.readOnlyPaths,
            forbiddenPaths: repository.forbiddenPaths,
            credentialPathPolicy: credentialPathPolicyFromFrozenPatterns(frozen.credentialForbiddenPaths),
          }),
        }
      : {
          ...shared,
          readOnly: true,
          forbidImplementation: true,
          identitySeparated: true,
        };
    return {
      stageId: stage.id,
      id: taskId,
      role: stage.role,
      goal: planned.goal,
      prompt: planned.prompt,
      dependsOn: dependencyIds,
      doneWhen: planned.doneWhen ?? [],
      parentId: input.plannerTaskId,
      worktreePath,
      config,
    };
  });
}

export function runtimeIntegrationTaskExecutionProblem(input: {
  runId: string;
  boundary: unknown;
  evidenceBundle: unknown;
  task: Task;
  tasks: Task[];
}): string | null {
  const graph = runtimeTaskGraphOrNull(input.boundary);
  const contract = objectOrNull(input.task.config?.runtimeIntegrationExecutionContract);
  const stage = graph?.find((candidate) => candidate.id === input.task.goal)
    ?? (typeof contract?.stageId === "string" ? graph?.find((candidate) => candidate.id === contract.stageId) : undefined);
  if (!stage && !contract) return null;
  try {
    if (!stage) throw new Error("runtime integration execution contract has no frozen stage");
    const frozen = parseFrozenRuntimeIntegration(input.boundary, input.evidenceBundle);
    if (!contract) throw new Error(`runtime integration execution contract is missing for ${input.task.id}`);
    const { contractSha256, ...contractBody } = contract;
    if (typeof contractSha256 !== "string" || canonicalEvolutionValueSha256(contractBody) !== contractSha256) {
      throw new Error(`runtime integration execution contract hash is invalid for ${input.task.id}`);
    }
    const repository = frozen.repositories.get(stage.repositoryId);
    if (!repository) throw new Error(`runtime integration repository is missing: ${stage.repositoryId}`);
    const plannerTaskId = stringValue(contract.plannerTaskId);
    const expectedWorktree = join(repository.repoPath, ".ouroboros", "worktrees", `${input.runId}-${repository.id}`);
    const exactFields: Array<[unknown, unknown, string]> = [
      [contract.runId, input.runId, "runId"],
      [contract.taskId, input.task.id, "taskId"],
      [contract.stageId, stage.id, "stageId"],
      [contract.role, stage.role, "role"],
      [contract.executor, stage.executor, "executor"],
      [contract.repositoryId, repository.id, "repositoryId"],
      [contract.repositoryRoot, repository.repoPath, "repositoryRoot"],
      [contract.expectedHead, repository.expectedHead, "expectedHead"],
      [contract.worktreePath, expectedWorktree, "worktreePath"],
      [contract.boundarySha256, frozen.boundarySha256, "boundarySha256"],
      [contract.bundleSha256, frozen.bundleSha256, "bundleSha256"],
      [input.task.parentId, plannerTaskId, "parentId"],
      [input.task.worktreePath, expectedWorktree, "task worktreePath"],
      [input.task.config?.executor, stage.executor, "task executor"],
      [input.task.config?.agentBackend, stage.executor, "task agentBackend"],
      [input.task.config?.repositoryId, repository.id, "task repositoryId"],
      [input.task.config?.repositoryRoot, repository.repoPath, "task repositoryRoot"],
      [input.task.config?.expectedHead, repository.expectedHead, "task expectedHead"],
      [input.task.config?.runtimeIntegrationBoundarySha256, frozen.boundarySha256, "task boundarySha256"],
      [input.task.config?.targetSystemEvidenceBundleSha256, frozen.bundleSha256, "task bundleSha256"],
    ];
    const mismatch = exactFields.find(([actual, expected]) => actual !== expected);
    if (mismatch) throw new Error(`runtime integration execution contract ${mismatch[2]} drifted for ${input.task.id}`);
    if (input.task.role !== stage.role) throw new Error(`runtime integration task role drifted for ${input.task.id}`);
    const tasksByStage = new Map(input.tasks.flatMap((task) => {
      const taskContract = objectOrNull(task.config?.runtimeIntegrationExecutionContract);
      return typeof taskContract?.stageId === "string" ? [[taskContract.stageId, task] as const] : [];
    }));
    const expectedDependencies = stage.dependsOn.length === 0
      ? [plannerTaskId]
      : stage.dependsOn.map((dependency) => tasksByStage.get(dependency)?.id ?? "<missing>");
    if (!sameValue(input.task.dependsOn, expectedDependencies)) {
      throw new Error(`runtime integration execution contract dependencies drifted for ${input.task.id}`);
    }
    const permissionMode = stage.role === "worker" ? "workspace-write" : "read-only";
    if (input.task.config?.permissionMode !== permissionMode
      || input.task.config?.forbidBrowser !== true
      || input.task.config?.browserProcessPolicy !== "deny") {
      throw new Error(`runtime integration execution contract permission or browser policy drifted for ${input.task.id}`);
    }
    if (stage.role === "worker" && (input.task.config?.dshProfileIsolation !== "base-headless"
      || input.task.config?.dshModelTransport !== "host-brokered-deepseek"
      || input.task.config?.dshToolNetwork !== "deny"
      || input.task.config?.ambientCredentialsInherited !== false
      || input.task.config?.targetCredentialsInherited !== false)) {
      throw new Error(`runtime integration execution contract DSH isolation drifted for ${input.task.id}`);
    }
    if (stage.role === "verifier" && (input.task.config?.readOnly !== true
      || input.task.config?.forbidImplementation !== true
      || input.task.config?.identitySeparated !== true)) {
      throw new Error(`runtime integration execution contract Verifier isolation drifted for ${input.task.id}`);
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function parseFrozenRuntimeIntegration(boundaryValue: unknown, bundleValue: unknown) {
  const boundary = requireObject(boundaryValue, "runtimeIntegrationBoundary");
  const bundle = requireObject(bundleValue, "targetSystemEvidenceBundle");
  const boundarySha256 = exactSha(boundary.boundarySha256, "runtimeIntegrationBoundary.boundarySha256");
  const boundaryBody = { schemaVersion: boundary.schemaVersion, repositories: boundary.repositories, gateway: boundary.gateway };
  if (canonicalEvolutionValueSha256(boundaryBody) !== boundarySha256) {
    throw new Error("runtimeIntegrationBoundary.boundarySha256 does not match the canonical boundary");
  }
  const bundleSha256 = exactSha(bundle.bundleSha256, "targetSystemEvidenceBundle.bundleSha256");
  const { bundleSha256: _bundleSha256, ...bundleBody } = bundle;
  if (canonicalEvolutionValueSha256(bundleBody) !== bundleSha256) {
    throw new Error("targetSystemEvidenceBundle.bundleSha256 does not match the canonical bundle");
  }
  if (bundle.boundarySha256 !== boundarySha256 || !sameValue(bundle.runtimeIntegrationBoundary, boundary)) {
    throw new Error("targetSystemEvidenceBundle is detached from the runtime integration boundary");
  }
  const graph = runtimeTaskGraphOrNull(boundary);
  if (!graph || !sameValue(graph, RUNTIME_INTEGRATION_TASK_GRAPH)) {
    throw new Error("runtimeIntegrationBoundary.taskGraph must be the canonical five-stage graph");
  }
  const repositoryValues = Array.isArray(boundary.repositories) ? boundary.repositories : [];
  const repositories = new Map(repositoryValues.map((value, index) => {
    const repository = requireObject(value, `runtimeIntegrationBoundary.repositories[${index}]`);
    const id = stringValue(repository.id);
    return [id, {
      id,
      repoPath: stringValue(repository.repoPath),
      expectedHead: exactCommit(repository.expectedHead, `${id}.expectedHead`),
      access: stringValue(repository.access),
      allowedPaths: stringArray(repository.allowedPaths, `${id}.allowedPaths`),
      readOnlyPaths: stringArray(repository.readOnlyPaths, `${id}.readOnlyPaths`),
      forbiddenPaths: stringArray(repository.forbiddenPaths, `${id}.forbiddenPaths`),
    }] as const;
  }));
  if (repositories.size !== 4) throw new Error("runtime integration boundary must contain four repositories");
  const heads = Array.isArray(bundle.repositoryHeads) ? bundle.repositoryHeads : [];
  if (heads.length !== repositories.size || heads.some((value) => {
    const head = objectOrNull(value);
    const repository = head && typeof head.id === "string" ? repositories.get(head.id) : null;
    return !repository || head?.expectedHead !== repository.expectedHead;
  })) {
    throw new Error("targetSystemEvidenceBundle repository HEADs drifted");
  }
  const credentialIsolation = requireObject(boundary.credentialIsolation, "runtimeIntegrationBoundary.credentialIsolation");
  if (!sameValue(bundle.credentialIsolation, credentialIsolation)
    || credentialIsolation.modelReceivesCredentials !== false
    || credentialIsolation.hostInjectionOnly !== true) {
    throw new Error("runtime integration credential isolation drifted");
  }
  return {
    boundary,
    bundle,
    boundarySha256,
    bundleSha256,
    repositories,
    credentialForbiddenPaths: stringArray(credentialIsolation.forbiddenPaths, "credentialIsolation.forbiddenPaths"),
  };
}

function runtimeTaskGraphOrNull(boundaryValue: unknown) {
  const boundary = objectOrNull(boundaryValue);
  if (!Array.isArray(boundary?.taskGraph)) return null;
  return boundary.taskGraph.map((value) => {
    const stage = requireObject(value, "runtime integration task stage");
    return {
      id: stringValue(stage.id),
      role: stringValue(stage.role),
      executor: stringValue(stage.executor),
      repositoryId: stringValue(stage.repositoryId),
      dependsOn: stringArray(stage.dependsOn, "runtime integration stage dependsOn"),
    };
  });
}

function readBindingsForStage(stageId: string) {
  if (stageId === "ainovel-adapter") return ["ainovel-source"];
  if (stageId === "dsh-gateway") return ["dsh-source"];
  if (stageId === "non-browser-e2e") return ["target-frontend"];
  return [];
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  const record = objectOrNull(value);
  if (!record) throw new Error(`${label} must be an object`);
  return record;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("runtime integration string field is missing");
  return value;
}

function stringArray(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`${label} must be a string array`);
  return value as string[];
}

function normalizedPolicyPatterns(value: unknown, label: string) {
  return [...new Set(stringArray(value, label).map((entry) => entry.trim()))].sort();
}

function policyPatternContains(frozen: string, candidate: string) {
  if (frozen === candidate) return true;
  if (!frozen.endsWith("/**")) return false;
  const prefix = frozen.slice(0, -3);
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function exactSha(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value) || /^0+$/.test(value)) throw new Error(`${label} must be an exact SHA-256`);
  return value;
}

function exactCommit(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value) || /^0+$/.test(value)) throw new Error(`${label} must be an exact Git commit`);
  return value;
}

function sameValue(left: unknown, right: unknown) {
  return canonicalEvolutionValueSha256(left) === canonicalEvolutionValueSha256(right);
}
