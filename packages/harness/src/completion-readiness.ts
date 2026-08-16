import { createHash } from "node:crypto";
import type { ObservableSession, RunOverview, Task } from "./types";

const SHA256 = /^[0-9a-f]{64}$/;
const RECEIPT_EVIDENCE = /(?:runtime identity|network-denial|offline verifier execution) receipt/i;

export interface CompletionVerificationContractV1 {
  schemaVersion: 1;
  sourceTaskId: string;
  sourceDoneWhen: string[];
  requiredEvidence: string[];
}

export interface CompletionVerificationBlocker {
  taskId: string;
  verifierTaskId: string | null;
  reason: string;
}

export interface RunCompletionReadiness {
  required: boolean;
  verifiedWorkerTaskIds: string[];
  blockers: CompletionVerificationBlocker[];
}

export function describeRunCompletionReadiness(overview: RunOverview): RunCompletionReadiness {
  const workers = overview.tasks.filter((task) => task.role === "worker");
  const targetDesignBlockers = describeTargetSystemDesignAuthorityBlockers(overview);
  if (targetDesignBlockers.length > 0) {
    return { required: true, verifiedWorkerTaskIds: [], blockers: targetDesignBlockers };
  }
  const requiredEvidence = readRequiredEvidence(overview.run?.context.designEvaluationContract);
  const receiptGatedAssessment = overview.run?.context.source === "design"
    && requiredEvidence.some((item) => RECEIPT_EVIDENCE.test(item));
  const required = overview.run?.context.source === "design" && (workers.length > 0 || receiptGatedAssessment);
  if (!required) {
    return { required: false, verifiedWorkerTaskIds: [], blockers: [] };
  }

  const assessmentBlockers = receiptGatedAssessment
    ? describeAssessmentEvidenceBlockers(overview)
    : [];
  if (workers.length === 0) {
    return { required, verifiedWorkerTaskIds: [], blockers: assessmentBlockers };
  }

  const verifiedPackageWorker = verifiedPackageCloseoutWorker(overview, workers, requiredEvidence);
  if (verifiedPackageWorker) {
    return { required, verifiedWorkerTaskIds: [verifiedPackageWorker.id], blockers: assessmentBlockers };
  }

  const taskById = new Map(overview.tasks.map((task) => [task.id, task]));
  const taskIndexById = new Map(overview.tasks.map((task, index) => [task.id, index]));
  const supersededWorkerIds = new Set<string>();
  for (const worker of workers) {
    if (!worker.parentId) continue;
    const parent = taskById.get(worker.parentId);
    if (parent?.role === "worker") {
      supersededWorkerIds.add(parent.id);
      continue;
    }
    if (parent?.role === "verifier") {
      for (const dependencyId of parent.dependsOn) {
        if (taskById.get(dependencyId)?.role === "worker") {
          supersededWorkerIds.add(dependencyId);
        }
      }
    }
  }
  for (const worker of workers) {
    const reviewDependencies = worker.dependsOn
      .map((dependencyId) => taskById.get(dependencyId))
      .filter((task): task is Task => task?.role === "goal-review");
    for (const review of reviewDependencies) {
      const reviewIndex = taskIndexById.get(review.id) ?? -1;
      for (const priorWorker of workers) {
        const priorIndex = taskIndexById.get(priorWorker.id) ?? Number.MAX_SAFE_INTEGER;
        const priorVerifier = latestVerifierForWorker(overview, priorWorker.id);
        if (
          priorIndex < reviewIndex
          && (priorWorker.status === "blocked" || priorVerifier?.status === "blocked")
        ) {
          supersededWorkerIds.add(priorWorker.id);
        }
      }
    }
  }

  const heads = workers.filter((worker) => !supersededWorkerIds.has(worker.id));
  const verifiedWorkerTaskIds: string[] = [];
  const blockers: CompletionVerificationBlocker[] = [...assessmentBlockers];
  for (const worker of heads) {
    const verifier = latestVerifierForWorker(overview, worker.id);
    if (worker.status !== "done" || !isPassingVerifier(overview, worker, verifier, requiredEvidence)) {
      blockers.push({
        taskId: worker.id,
        verifierTaskId: verifier?.id ?? null,
        reason: `latest repair lineage ${worker.id} has no passing verifier for the frozen completion contract`,
      });
      continue;
    }
    verifiedWorkerTaskIds.push(worker.id);
  }
  return { required, verifiedWorkerTaskIds, blockers };
}

function verifiedPackageCloseoutWorker(overview: RunOverview, workers: Task[], requiredEvidence: string[]) {
  const closeout = objectOrNull(overview.run?.context.verifiedPackageCloseout);
  if (!closeout || closeout.schemaVersion !== 1 || closeout.packageOnly !== true || closeout.overallGoalComplete !== false
    || typeof closeout.verifierTaskId !== "string" || typeof closeout.commitSha !== "string"
    || !/^[0-9a-f]{40}$/.test(closeout.commitSha)) {
    return null;
  }
  const verifier = overview.tasks.find((task) => task.id === closeout.verifierTaskId && task.role === "verifier") ?? null;
  if (!verifier) return null;
  const sourceWorkers = workers.filter((worker) => verifier.dependsOn.includes(worker.id));
  if (sourceWorkers.length !== 1) return null;
  const worker = sourceWorkers[0]!;
  const session = [...overview.sessions].reverse().find((candidate) => candidate.taskId === verifier.id);
  if (!session || session.output.verdict !== "pass") return null;
  return worker.status === "done" && isPassingVerifier(overview, worker, verifier, requiredEvidence) ? worker : null;
}

function describeTargetSystemDesignAuthorityBlockers(overview: RunOverview): CompletionVerificationBlocker[] {
  if (overview.run?.context.source !== "target-system-design") return [];
  const designerSessions = overview.sessions.filter((session) => session.role === "designer");
  const proposalIds = new Set<string>();
  const acceptedProposalIds = new Set<string>();
  for (const session of designerSessions) {
    for (const artifact of session.output.artifacts ?? []) {
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) continue;
      const record = artifact as Record<string, unknown>;
      if (record.kind === "design_proposal" && typeof record.proposalId === "string") {
        proposalIds.add(record.proposalId);
      }
      if (record.kind === "design_decision"
        && typeof record.proposalId === "string"
        && record.disposition === "automatic") {
        acceptedProposalIds.add(record.proposalId);
      }
      if (record.kind === "design_continuation" && typeof record.proposalId === "string") {
        acceptedProposalIds.add(record.proposalId);
      }
    }
  }
  if (proposalIds.size === 0 || [...proposalIds].some((id) => acceptedProposalIds.has(id))) return [];
  const taskId = [...overview.tasks].reverse().find((task) => task.role === "goal-review")?.id
    ?? [...overview.tasks].reverse().find((task) => task.role === "designer")?.id
    ?? overview.run.id;
  return [{
    taskId,
    verifierTaskId: null,
    reason: `target-system design has only rejected or deferred proposals (${[...proposalIds].sort().join(", ")}); authority has not accepted the run goal`,
  }];
}

function describeAssessmentEvidenceBlockers(overview: RunOverview): CompletionVerificationBlocker[] {
  const taskId = [...overview.tasks].reverse().find((task) => task.role === "goal-review")?.id
    ?? [...overview.tasks].reverse().find((task) => task.role === "planner")?.id
    ?? overview.run?.id
    ?? "assessment";
  const blockers: CompletionVerificationBlocker[] = [];
  const validated = overview.sessions.flatMap((session) => {
    const receipt = validateEnvironmentReceipt(session);
    return receipt ? [{ session, receipt }] : [];
  });
  if (validated.length === 0) {
    blockers.push({
      taskId,
      verifierTaskId: null,
      reason: "structured machine receipt readback is missing for the frozen runtime, network-denial, and offline verifier evidence",
    });
  }

  const identities = new Set(validated.map(({ receipt }) => canonicalJson(receiptIdentity(receipt))));
  if (identities.size > 1 || hasLegacyRuntimeContradiction(overview.sessions)) {
    blockers.push({
      taskId,
      verifierTaskId: null,
      reason: "evidence conflict: assessment sessions report mutually exclusive runtime identity or capability results",
    });
  }
  return blockers;
}

function validateEnvironmentReceipt(session: ObservableSession): Record<string, unknown> | null {
  const receipt = session.verifierExecutionEnvironmentReceipt;
  if (!receipt || receipt.kind !== "verifier_execution_environment_receipt" || receipt.schemaVersion !== 1) return null;
  const receiptSha256 = receipt.receiptSha256;
  const contractSha256 = receipt.contractSha256;
  if (typeof receiptSha256 !== "string" || !SHA256.test(receiptSha256)) return null;
  if (typeof contractSha256 !== "string" || !SHA256.test(contractSha256)) return null;
  const { receiptSha256: _receiptSha256, ...body } = receipt;
  if (sha256(canonicalJson(body)) !== receiptSha256) return null;

  const runtime = objectOrNull(receipt.runtime);
  const network = objectOrNull(receipt.network);
  const boundary = objectOrNull(receipt.boundary);
  if (runtime?.kind !== "bun"
    || typeof runtime.path !== "string" || runtime.path.length === 0
    || typeof runtime.version !== "string" || runtime.version.length === 0
    || typeof runtime.sha256 !== "string" || !SHA256.test(runtime.sha256)
    || runtime.exitCode !== 0
    || network?.mode !== "deny"
    || typeof network.implementation !== "string" || network.implementation.length === 0
    || typeof network.profileSha256 !== "string" || !SHA256.test(network.profileSha256)
    || typeof network.policyExecutableSha256 !== "string" || !SHA256.test(network.policyExecutableSha256)
    || typeof boundary?.worktreePath !== "string" || boundary.worktreePath.length === 0
    || typeof boundary.databasePath !== "string" || boundary.databasePath.length === 0) {
    return null;
  }
  const probes = Array.isArray(network.probes) ? network.probes : [];
  const deniedKinds = new Set(probes.flatMap((probe) => {
    const record = objectOrNull(probe);
    return record
      && (record.kind === "dns" || record.kind === "tcp" || record.kind === "http")
      && record.denied === true
      && typeof record.exitCode === "number"
      && record.exitCode !== 0
      ? [record.kind]
      : [];
  }));
  if (!["dns", "tcp", "http"].every((kind) => deniedKinds.has(kind))) return null;

  const ref = (session.output.artifacts ?? []).find((artifact) => {
    const record = objectOrNull(artifact);
    return record?.kind === "verifier_execution_environment_receipt_ref"
      && record.receiptSha256 === receiptSha256
      && record.contractSha256 === contractSha256;
  });
  return ref ? receipt : null;
}

function receiptIdentity(receipt: Record<string, unknown>) {
  const runtime = objectOrNull(receipt.runtime)!;
  const network = objectOrNull(receipt.network)!;
  const boundary = objectOrNull(receipt.boundary)!;
  return {
    contractSha256: receipt.contractSha256,
    runtime: { path: runtime.path, version: runtime.version, sha256: runtime.sha256 },
    network: {
      implementation: network.implementation,
      profileSha256: network.profileSha256,
      policyExecutableSha256: network.policyExecutableSha256,
    },
    boundary: { worktreePath: boundary.worktreePath, databasePath: boundary.databasePath },
  };
}

function hasLegacyRuntimeContradiction(sessions: ObservableSession[]) {
  const text = sessions.map((session) => canonicalJson({
    summary: session.output.summary,
    checks: session.output.checks,
    problems: session.output.problems,
  })).join("\n");
  const present = /\b(?:host\s+)?bun\s+(?:is\s+)?v?\d+\.\d+\.\d+\b/i.test(text);
  const absent = /(?:bun[^\n]{0,80}(?:exit(?:ed)?\s*127|unavailable|not found)|(?:lacks|without)\s+bun)/i.test(text);
  return present && absent;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function assertRunCompletionReady(overview: RunOverview) {
  const readiness = describeRunCompletionReadiness(overview);
  if (readiness.blockers.length > 0) {
    throw new Error(`cannot mark design run done: ${readiness.blockers.map((blocker) => blocker.reason).join("; ")}`);
  }
}

export function completionVerificationContract(
  overview: RunOverview,
  sourceTask: Task,
): CompletionVerificationContractV1 {
  return {
    schemaVersion: 1,
    sourceTaskId: sourceTask.id,
    sourceDoneWhen: [...sourceTask.doneWhen],
    requiredEvidence: readRequiredEvidence(overview.run?.context.designEvaluationContract),
  };
}

function latestVerifierForWorker(overview: RunOverview, workerTaskId: string) {
  return [...overview.tasks].reverse().find(
    (task) => task.role === "verifier" && task.dependsOn.includes(workerTaskId),
  ) ?? null;
}

function isPassingVerifier(
  overview: RunOverview,
  worker: Task,
  verifier: Task | null,
  requiredEvidence: string[],
) {
  if (!verifier || verifier.status !== "done") return false;
  const session = [...overview.sessions].reverse().find((candidate) => candidate.taskId === verifier.id);
  if (!session || session.status !== "done" || session.output.status !== "done") return false;
  if ((session.output.problems ?? []).length > 0) return false;
  const checks = Array.isArray(session.output.checks) ? session.output.checks : [];
  if (checks.some((check) => isFailedCheck(check))) return false;
  if (requiredEvidence.length === 0) return true;

  const contract = verifier.config?.completionContract;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return false;
  const record = contract as Record<string, unknown>;
  return record.schemaVersion === 1
    && record.sourceTaskId === worker.id
    && equalStringArrays(record.sourceDoneWhen, worker.doneWhen)
    && equalStringArrays(record.requiredEvidence, requiredEvidence)
    && requiredEvidence.every((item) => verifier.doneWhen.includes(item));
}

function readRequiredEvidence(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const requiredEvidence = (value as Record<string, unknown>).requiredEvidence;
  return Array.isArray(requiredEvidence)
    ? requiredEvidence.filter((item): item is string => typeof item === "string")
    : [];
}

function equalStringArrays(value: unknown, expected: string[]) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function isFailedCheck(check: unknown) {
  return Boolean(
    check
      && typeof check === "object"
      && !Array.isArray(check)
      && (check as Record<string, unknown>).status === "failed",
  );
}
