import type { RunOverview, Task } from "./types";

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
  const required = overview.run?.context.source === "design" && workers.length > 0;
  if (!required) {
    return { required: false, verifiedWorkerTaskIds: [], blockers: [] };
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

  const requiredEvidence = readRequiredEvidence(overview.run?.context.designEvaluationContract);
  const heads = workers.filter((worker) => !supersededWorkerIds.has(worker.id));
  const verifiedWorkerTaskIds: string[] = [];
  const blockers: CompletionVerificationBlocker[] = [];
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
