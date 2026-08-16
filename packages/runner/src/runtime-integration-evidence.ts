import {
  applyHarnessAction,
  canonicalEvolutionValueSha256,
  type AttemptOutput,
  type Harness,
  type Run,
  type Task,
} from "@ouroboros/harness";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function sameValue(left: unknown, right: unknown) {
  return canonicalEvolutionValueSha256(left) === canonicalEvolutionValueSha256(right);
}

export function runtimeIntegrationEvidenceProblem(run: Run, task: Task): string | null {
  if (!task.config?.runtimeIntegrationDesignAdapter) return null;
  try {
    const boundary = record(run.context.runtimeIntegrationBoundary, "runtimeIntegrationBoundary");
    const taskBoundary = record(task.config.runtimeIntegrationBoundary, "task runtimeIntegrationBoundary");
    if (!sameValue(boundary, taskBoundary)) {
      throw new Error("runtime integration task boundary drifted from the run boundary");
    }
    const bundle = record(run.context.targetSystemEvidenceBundle, "targetSystemEvidenceBundle");
    const taskBundle = record(task.config.targetSystemEvidenceBundle, "task targetSystemEvidenceBundle");
    if (!sameValue(bundle, taskBundle)) {
      throw new Error("runtime integration task evidence bundle drifted from the run bundle");
    }
    const bundleSha256 = exactSha(bundle.bundleSha256, "targetSystemEvidenceBundle.bundleSha256");
    const { bundleSha256: _bundleSha256, ...bundleBody } = bundle;
    if (canonicalEvolutionValueSha256(bundleBody) !== bundleSha256) {
      throw new Error("targetSystemEvidenceBundle.bundleSha256 does not match its canonical body");
    }
    if (bundle.purpose !== "runtime-integration-after-verified-package"
      || bundle.targetProjectId !== run.projectId) {
      throw new Error("runtime integration evidence bundle purpose or target project is invalid");
    }
    const boundarySha256 = exactSha(bundle.boundarySha256, "targetSystemEvidenceBundle.boundarySha256");
    const boundaryBase = {
      schemaVersion: boundary.schemaVersion,
      repositories: boundary.repositories,
      gateway: boundary.gateway,
    };
    if (canonicalEvolutionValueSha256(boundaryBase) !== boundarySha256
      || boundary.boundarySha256 !== boundarySha256
      || !sameValue(bundle.runtimeIntegrationBoundary, boundary)) {
      throw new Error("runtime integration evidence bundle boundary hash or payload drifted");
    }
    const repositories = Array.isArray(boundary.repositories) ? boundary.repositories.map((entry) => record(entry, "repository")) : [];
    const repositoryHeads = Array.isArray(bundle.repositoryHeads) ? bundle.repositoryHeads.map((entry) => record(entry, "repository head")) : [];
    if (repositories.length !== 4 || repositoryHeads.length !== repositories.length
      || repositories.some((repository, index) => repository.id !== repositoryHeads[index]?.id
        || repository.expectedHead !== repositoryHeads[index]?.expectedHead)) {
      throw new Error("runtime integration evidence bundle repository HEADs drifted from the frozen boundary");
    }
    if (!sameValue(bundle.credentialIsolation, boundary.credentialIsolation)) {
      throw new Error("runtime integration evidence bundle credential isolation drifted");
    }
    const verifiedPackage = record(bundle.verifiedPackage, "verifiedPackage");
    const runPackage = record(run.context.verifiedPackageEvidence, "run verifiedPackageEvidence");
    for (const key of ["signalId", "commitSha", "tree", "remoteRef", "commitActionEventId", "pushActionEventId", "verifierTaskId"] as const) {
      if (verifiedPackage[key] !== runPackage[key]) {
        throw new Error(`runtime integration verified package ${key} drifted`);
      }
    }
    const verifierReceipt = record(verifiedPackage.verifierReceipt, "verifiedPackage.verifierReceipt");
    if (verifierReceipt.taskId !== runPackage.verifierTaskId
      || typeof verifierReceipt.attemptId !== "string"
      || verifierReceipt.status !== "done") {
      throw new Error("runtime integration verifier receipt is incomplete");
    }
    exactSha(verifierReceipt.outputSha256, "verifiedPackage.verifierReceipt.outputSha256");
    const sourceFailure = record(bundle.sourceFailure, "sourceFailure");
    if (typeof sourceFailure.sourceRunId !== "string"
      || typeof sourceFailure.sourceTaskId !== "string"
      || typeof sourceFailure.sourceAttemptId !== "string") {
      throw new Error("runtime integration source failure receipt is incomplete");
    }
    exactSha(sourceFailure.problemSha256, "sourceFailure.problemSha256");
    const adapter = record(task.config.runtimeIntegrationDesignAdapter, "runtimeIntegrationDesignAdapter");
    if (adapter.evidenceBundleSha256 !== bundleSha256
      || !sameValue(adapter.runtimeIntegrationBoundary, boundary)) {
      throw new Error("runtime integration adapter is detached from the authoritative evidence bundle");
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function runtimeIntegrationEvidenceBlockedOutput(problem: string): AttemptOutput {
  return {
    status: "blocked",
    summary: "Runtime integration evidence validation failed before model startup.",
    changedFiles: [],
    checks: [{ name: "authoritative runtime integration evidence", status: "failed", evidence: problem }],
    artifacts: [],
    problems: [problem],
  };
}

export function closeRuntimeIntegrationEvidenceFailure(input: {
  harness: Harness;
  run: Run;
  task: Task;
  problem: string;
  attemptId?: string;
}) {
  if (!input.task.config?.runtimeIntegrationDesignAdapter || !input.run.projectId) return;
  const fingerprint = canonicalEvolutionValueSha256({
    runId: input.run.id,
    taskId: input.task.id,
    problem: input.problem,
    bundle: input.run.context.targetSystemEvidenceBundle ?? null,
  });
  const existing = input.run.context.runtimeIntegrationDesignFailure;
  if (existing && typeof existing === "object" && !Array.isArray(existing)
    && (existing as Record<string, unknown>).fingerprint === fingerprint) {
    return;
  }
  const recordedAt = new Date().toISOString();
  applyHarnessAction(input.harness, {
    type: "updateRunContext",
    runId: input.run.id,
    status: "blocked",
    contextPatch: {
      runtimeIntegrationDesignFailure: {
        schemaVersion: 1,
        fingerprint,
        sourceTaskId: input.task.id,
        sourceAttemptId: input.attemptId ?? null,
        problem: input.problem.slice(0, 1_024),
        recordedAt,
      },
    },
    reason: "runtime integration Designer failed authoritative evidence validation",
  });
  applyHarnessAction(input.harness, {
    type: "recordSignal",
    projectId: input.run.projectId,
    sourceRunId: input.run.id,
    signalClass: "system",
    source: `blocked-run-outcome:${input.run.id}`,
    title: "Runtime integration Designer evidence validation failed",
    summary: "The host-bound runtime integration Designer stopped at its first authoritative evidence validation failure without a continuation or Goal Review.",
    observationTime: recordedAt,
    confidence: 1,
    evidence: [
      `run:${input.run.id}`,
      `task:${input.task.id}`,
      ...(input.attemptId ? [`attempt:${input.attemptId}`] : []),
      `sha256:${fingerprint}`,
    ],
    payload: {
      outcome: "evidence-defect",
      defectKind: "runtime-integration-authoritative-evidence-invalid",
      validationFingerprint: fingerprint,
      nextStep: "new-independent-runtime-integration-designer-trigger",
    },
  });
}
