import { applyHarnessAction, type Harness, type Task } from "@ouroboros/harness";

export interface AdditiveEvidenceContractReconciliation {
  systemTaskId: string;
  verifierTaskId: string | null;
  actionEventId: string;
  status: "done" | "blocked";
}

export function reconcileAdditiveEvidenceContract(input: {
  harness: Harness;
  runId: string;
}): AdditiveEvidenceContractReconciliation[] {
  const overview = input.harness.getRunOverview({ runId: input.runId, eventLimit: 0 });
  const systemTask = overview.tasks.find(isAdditiveEvidenceSystemTask);
  if (!systemTask || systemTask.status !== "todo") return [];
  const graph = overview.run?.context.additiveEvidenceContractTaskGraph;
  const verifierTaskId = graph && typeof graph === "object" && !Array.isArray(graph)
    && typeof (graph as Record<string, unknown>).verifierTaskId === "string"
    ? (graph as Record<string, unknown>).verifierTaskId as string
    : null;
  const overlay = applyHarnessAction(input.harness, {
    type: "recordAdditiveEvidenceContractOverlay",
    runId: input.runId,
    systemTaskId: systemTask.id,
  });
  const completion = applyHarnessAction(input.harness, {
    type: "completeSystemTask",
    taskId: systemTask.id,
    actionEventId: overlay.eventId,
    reason: "bind the additive evidence-contract overlay to its audited host system task",
  });
  if (completion.status !== "done") {
    throw new Error(`additive evidence-contract system completion failed: ${completion.summary}`);
  }
  if (overlay.status === "blocked" && overview.run?.status !== "blocked") {
    input.harness.updateRun({
      runId: input.runId,
      status: "blocked",
      contextPatch: {
        additiveEvidenceContractOverlayState: {
          status: "blocked",
          systemTaskId: systemTask.id,
          actionEventId: overlay.eventId,
        },
      },
    });
  }
  return [{
    systemTaskId: systemTask.id,
    verifierTaskId,
    actionEventId: overlay.eventId,
    status: overlay.status,
  }];
}

function isAdditiveEvidenceSystemTask(task: Task) {
  return task.role === "system"
    && task.config?.systemTask === true
    && task.config?.executor === "host-fixed-action"
    && task.config?.additiveEvidenceContractOverlay !== undefined;
}
