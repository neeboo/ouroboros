import { applyHarnessAction, type Harness } from "@ouroboros/harness";

export interface RuntimeIntegrationHostEvidenceReconciliation {
  sourceVerifierTaskId: string;
  sourceVerifierAttemptId: string;
  status: "done" | "blocked";
  actionEventId: string;
  hostTaskId: string | null;
  verifierTaskId: string | null;
}

export function reconcileRuntimeIntegrationHostEvidence(input: {
  harness: Harness;
  runId: string;
}): RuntimeIntegrationHostEvidenceReconciliation[] {
  const overview = input.harness.getRunOverview({ runId: input.runId, eventLimit: 0 });
  const run = overview.run;
  if (!run || run.context.retired === true
    || overview.tasks.some((task) => task.status === "todo" || task.status === "running")) return [];
  const existing = asRecord(run.context.runtimeIntegrationHostEvidenceRecovery);
  if (existing?.status === "blocked" || existing?.status === "awaiting-verification") return [];
  const verifier = [...overview.tasks].reverse().find((task) => {
    const contract = asRecord(task.config?.runtimeIntegrationExecutionContract);
    return task.role === "verifier"
      && contract?.stageId === "non-browser-e2e"
      && (task.status === "done" || task.status === "blocked");
  });
  if (!verifier) return [];
  const session = [...overview.sessions].reverse().find((candidate) => candidate.taskId === verifier.id);
  if (!session || !isHostCapabilityOnlyFailure(session.output)) return [];
  const result = applyHarnessAction(input.harness, {
    type: "recoverRuntimeIntegrationHostEvidenceFailure",
    runId: input.runId,
    verifierTaskId: verifier.id,
    verifierAttemptId: session.attemptId,
    reason: "reconcile the frozen final Verifier host capability evidence without model Repair",
  });
  const artifact = result.artifacts.find((candidate) => candidate.kind === "runtime_integration_host_evidence_recovery");
  return [{
    sourceVerifierTaskId: verifier.id,
    sourceVerifierAttemptId: session.attemptId,
    status: result.status,
    actionEventId: result.eventId,
    hostTaskId: typeof artifact?.hostTaskId === "string" ? artifact.hostTaskId : null,
    verifierTaskId: typeof artifact?.verifierTaskId === "string" ? artifact.verifierTaskId : null,
  }];
}

function isHostCapabilityOnlyFailure(output: { verdict?: string; summary: string; changedFiles?: string[]; problems?: string[] }) {
  const text = [output.summary, ...(output.problems ?? [])].join("\n");
  return output.verdict === "fail"
    && (output.changedFiles ?? []).length === 0
    && [
      "REAL_POSTGRES_EVIDENCE_UNAVAILABLE",
      "REAL_LOOPBACK_HTTP_EVIDENCE_UNAVAILABLE",
      "END_TO_END_BINDING_INCOMPLETE",
    ].every((code) => text.includes(code));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
