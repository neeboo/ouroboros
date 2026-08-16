import { createHash } from "node:crypto";
import {
  applyHarnessAction,
  canonicalEvolutionValueSha256,
  type Harness,
  type HarnessActionResult,
  type Run,
  type Task,
} from "@ouroboros/harness";

interface HostEvidenceMaintenanceMarker {
  kind: "versioned-corpus-manifest";
  sourceSignalId: string;
  sourceRunId: string;
  sourceProposalId: string;
  sourceDecisionId: string;
  targetVersion: number;
}

export interface HostEvidenceMaintenanceReconciliation {
  taskId: string;
  status: "done" | "blocked";
  actionEventId: string | null;
  verifierTaskId: string | null;
  designerRunId: string | null;
  designerTaskId: string | null;
}

export function reconcileHostEvidenceMaintenance(input: {
  harness: Harness;
  runId: string;
}): HostEvidenceMaintenanceReconciliation[] {
  const overview = input.harness.getRunOverview({ runId: input.runId, eventLimit: 0 });
  const run = overview.run;
  if (!run) return [];
  const hostTask = overview.tasks.find((task) => readMarker(task) !== null);
  if (!hostTask) return [];
  const marker = readMarker(hostTask)!;

  if (hostTask.status === "todo") {
    const action = applyHarnessAction(input.harness, {
      type: "buildVersionedCorpusManifest",
      projectId: run.projectId!,
      sourceRunId: marker.sourceRunId,
      proposalId: marker.sourceProposalId,
      decisionId: marker.sourceDecisionId,
      targetVersion: marker.targetVersion,
    });
    applyHarnessAction(input.harness, {
      type: "completeSystemTask",
      taskId: hostTask.id,
      actionEventId: action.eventId,
      reason: "bind host evidence maintenance to its audited fixed action",
    });
    if (action.status === "blocked") {
      blockHostEvidenceRun(input.harness, run, hostTask, marker, action);
      return [{
        taskId: hostTask.id,
        status: "blocked",
        actionEventId: action.eventId,
        verifierTaskId: null,
        designerRunId: null,
        designerTaskId: null,
      }];
    }
    const actionEvent = input.harness.getHarnessActionEvent({ id: action.eventId });
    if (!actionEvent) throw new Error(`host evidence action event was not persisted: ${action.eventId}`);
    const persistedAction = {
      eventId: actionEvent.id,
      result: actionEvent.result,
    };
    const evidenceBundle = buildEvidenceBundle(input.harness, run, marker, persistedAction);
    const binding = applyHarnessAction(input.harness, {
      type: "bindHostEvidenceMaintenanceReceipt",
      runId: run.id,
      taskId: hostTask.id,
      actionEventId: action.eventId,
      evidenceBundle,
    });
    if (binding.status !== "done") {
      throw new Error(`host evidence receipt binding failed: ${binding.summary}`);
    }
    const verifierTask = ensureVerifier(input.harness, run, hostTask, marker, persistedAction);
    return [{
      taskId: hostTask.id,
      status: "done",
      actionEventId: action.eventId,
      verifierTaskId: verifierTask.id,
      designerRunId: null,
      designerTaskId: null,
    }];
  }

  if (hostTask.status === "blocked") {
    if (run.status !== "blocked") {
      applyHarnessAction(input.harness, {
        type: "updateRunContext",
        runId: run.id,
        status: "blocked",
        contextPatch: { hostEvidenceMaintenance: { state: "blocked", taskId: hostTask.id } },
        reason: "host evidence maintenance failed closed",
      });
    }
    return [{
      taskId: hostTask.id,
      status: "blocked",
      actionEventId: typeof run.context.hostEvidenceMaintenance === "object"
        && run.context.hostEvidenceMaintenance !== null
        && typeof (run.context.hostEvidenceMaintenance as Record<string, unknown>).actionEventId === "string"
        ? (run.context.hostEvidenceMaintenance as Record<string, unknown>).actionEventId as string
        : null,
      verifierTaskId: null,
      designerRunId: null,
      designerTaskId: null,
    }];
  }

  const action = matchingSuccessfulAction(input.harness, marker);
  if (!action) {
    blockHostEvidenceRun(input.harness, run, hostTask, marker, null);
    return [{
      taskId: hostTask.id,
      status: "blocked",
      actionEventId: null,
      verifierTaskId: null,
      designerRunId: null,
      designerTaskId: null,
    }];
  }
  const verifierTask = ensureVerifier(input.harness, run, hostTask, marker, action);
  if (verifierTask.status === "todo" || verifierTask.status === "running") return [];
  if (verifierTask.status === "blocked" || !verifierPassed(input.harness, verifierTask)) {
    if (run.status !== "blocked") {
      applyHarnessAction(input.harness, {
        type: "updateRunContext",
        runId: run.id,
        status: "blocked",
        contextPatch: {
          hostEvidenceMaintenance: {
            state: "verification-blocked",
            taskId: hostTask.id,
            verifierTaskId: verifierTask.id,
            actionEventId: action.eventId,
          },
        },
        reason: "independent host receipt verification did not pass",
      });
    }
    return [{
      taskId: hostTask.id,
      status: "blocked",
      actionEventId: action.eventId,
      verifierTaskId: verifierTask.id,
      designerRunId: null,
      designerTaskId: null,
    }];
  }

  const designer = ensureVersionedDesigner(input.harness, run, marker, action, verifierTask);
  if (run.status !== "done") {
    applyHarnessAction(input.harness, {
      type: "updateRunContext",
      runId: run.id,
      status: "done",
      contextPatch: {
        hostEvidenceMaintenance: {
          state: "verified",
          taskId: hostTask.id,
          verifierTaskId: verifierTask.id,
          actionEventId: action.eventId,
          successorDesignerRunId: designer.runId,
          successorDesignerTaskId: designer.taskId,
        },
      },
      reason: "verified host receipt created an independent versioned Designer trigger",
    });
  }
  return [{
    taskId: hostTask.id,
    status: "done",
    actionEventId: action.eventId,
    verifierTaskId: verifierTask.id,
    designerRunId: designer.runId,
    designerTaskId: designer.taskId,
  }];
}

function readMarker(task: Task): HostEvidenceMaintenanceMarker | null {
  const raw = task.config?.hostEvidenceMaintenance;
  if (task.role !== "system" || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const marker = raw as Record<string, unknown>;
  if (marker.kind !== "versioned-corpus-manifest"
    || typeof marker.sourceSignalId !== "string"
    || typeof marker.sourceRunId !== "string"
    || typeof marker.sourceProposalId !== "string"
    || typeof marker.sourceDecisionId !== "string"
    || !Number.isInteger(marker.targetVersion)) return null;
  return marker as unknown as HostEvidenceMaintenanceMarker;
}

function matchingSuccessfulAction(harness: Harness, marker: HostEvidenceMaintenanceMarker) {
  const event = harness.listHarnessActionEvents({ limit: 1_000 }).find((candidate) =>
    candidate.status === "done"
    && candidate.actionType === "buildVersionedCorpusManifest"
    && candidate.request.sourceRunId === marker.sourceRunId
    && candidate.request.proposalId === marker.sourceProposalId
    && candidate.request.decisionId === marker.sourceDecisionId
    && candidate.request.targetVersion === marker.targetVersion) ?? null;
  return event ? { eventId: event.id, result: event.result } : null;
}

function receiptArtifact(action: { result: Record<string, unknown> }) {
  const artifacts = Array.isArray(action.result.artifacts) ? action.result.artifacts : [];
  const artifact = artifacts.find((candidate) => candidate && typeof candidate === "object"
    && !Array.isArray(candidate)
    && (candidate as Record<string, unknown>).kind === "versioned_corpus_manifest_receipt");
  if (!artifact) throw new Error("host evidence maintenance action has no receipt artifact");
  return artifact as Record<string, unknown>;
}

function ensureVerifier(
  harness: Harness,
  run: Run,
  hostTask: Task,
  marker: HostEvidenceMaintenanceMarker,
  action: { eventId: string; result: Record<string, unknown> },
) {
  const taskId = stableId("task", `host-evidence-verifier|${action.eventId}`);
  const existing = harness.getTask(taskId);
  if (existing) return existing;
  const receipt = receiptArtifact(action);
  const receiptSha256 = canonicalEvolutionValueSha256(receipt);
  harness.createTask({
    id: taskId,
    runId: run.id,
    role: "verifier",
    goal: `Independently verify host corpus receipt ${action.eventId}`,
    prompt: [
      "Independently verify the sanitized host-owned corpus receipt.",
      `Action event: ${action.eventId}`,
      `Receipt SHA-256: ${receiptSha256}`,
      "Verify public fixture hashes against the target project binding and confirm the source proposal remains immutable.",
      "The holdout is count-and-commitment only. Do not request, infer, or disclose its reference, path, or bytes.",
      "Do not implement, modify files, start a browser, or create follow-up work.",
    ].join("\n"),
    doneWhen: [
      "the action event and sanitized receipt hash match",
      "public development and unrelated fixture hashes match the target project binding",
      "the holdout exposes only count and commitment",
      "the immutable source proposal and blocked source delivery are unchanged",
    ],
    dependsOn: [hostTask.id],
    config: {
      readOnly: true,
      forbidImplementation: true,
      forbidBrowser: true,
      browserProcessPolicy: "deny",
      hostEvidenceMaintenanceVerifier: {
        actionEventId: action.eventId,
        receiptSha256,
        sourceSignalId: marker.sourceSignalId,
        sourceRunId: marker.sourceRunId,
        sourceProposalId: marker.sourceProposalId,
        targetVersion: marker.targetVersion,
      },
    },
  });
  return harness.getTask(taskId)!;
}

function verifierPassed(harness: Harness, task: Task) {
  if (task.status !== "done") return false;
  const latest = harness.listLatestAttemptsForTasks([task.id])[0];
  return latest?.status === "done" && latest.problems.length === 0;
}

function buildEvidenceBundle(
  harness: Harness,
  run: Run,
  marker: HostEvidenceMaintenanceMarker,
  action: { eventId: string; result: Record<string, unknown> },
) {
  const signal = harness.getStrategySignal({ id: marker.sourceSignalId });
  const proposal = harness.getDesignProposal({ id: marker.sourceProposalId });
  const receipt = receiptArtifact(action);
  if (!signal || !proposal) throw new Error("host evidence successor lost its source signal or proposal");
  const acceptedProposal = {
    id: proposal.id,
    projectId: proposal.projectId,
    status: proposal.status,
    approvedDecisionIds: [marker.sourceDecisionId],
    comparisonSha256: receipt.sourceComparisonSha256,
  };
  const hostReceipt = {
    actionId: action.eventId,
    projectId: receipt.projectId,
    sourceRunId: receipt.sourceRunId,
    proposalId: receipt.proposalId,
    sourceVersion: receipt.sourceVersion,
    targetVersion: receipt.targetVersion,
    sourceComparisonSha256: receipt.sourceComparisonSha256,
    manifestSha256: receipt.manifestSha256,
    comparison: receipt.comparison,
    comparisonSha256: receipt.comparisonSha256,
    noHoldoutDisclosure: true,
  };
  const body = {
    schemaVersion: 1,
    targetProjectId: run.projectId,
    authoritativeDatabase: {
      path: harness.dbPath,
      bindingSha256: canonicalEvolutionValueSha256({ path: harness.dbPath, targetProjectId: run.projectId }),
    },
    referencedSignals: [{
      id: signal.id,
      projectId: signal.projectId,
      status: signal.status,
      source: signal.source,
      summary: signal.summary,
      evidence: signal.evidence,
      payloadSha256: canonicalEvolutionValueSha256(signal.payload),
    }],
    blockedSignals: [{
      id: signal.id,
      projectId: signal.projectId,
      status: signal.status,
      source: signal.source,
      summary: signal.summary,
      evidence: signal.evidence,
      payload: signal.payload,
      payloadSha256: canonicalEvolutionValueSha256(signal.payload),
    }],
    acceptedProposals: [acceptedProposal],
    hostCorpusReceipts: [hostReceipt],
  };
  return { ...body, bundleSha256: canonicalEvolutionValueSha256(body) };
}

export function buildHostReceiptProposalProjection(input: {
  projectId: string;
  actionEvidenceRef: string;
  correctionSignalRef: string;
  sourceDecisionId: string;
  targetVersion: number;
}) {
  const version = input.targetVersion;
  const exactTargetRef = `artifact:target-policy-v${version}`;
  const lastKnownGoodRef = `artifact:target-policy-v${version - 1}`;
  const rollbackPlanRef = `plan:target-policy-rollback-v${version}`;
  const privacyContractId = `host-receipt-privacy-v${version}`;
  const policySha256 = canonicalEvolutionValueSha256({
    schemaVersion: 1,
    kind: "host-receipt-privacy-requirements",
    projectId: input.projectId,
    actionEvidenceRef: input.actionEvidenceRef,
    rawPayloadPolicy: "reject",
    noHoldoutDisclosure: true,
  });
  const fromVariantId = `variant_${canonicalEvolutionValueSha256({
    kind: "host-receipt-control-variant",
    projectId: input.projectId,
    version: version - 1,
  })}`;
  const toVariantId = `variant_${canonicalEvolutionValueSha256({
    kind: "host-receipt-candidate-variant",
    projectId: input.projectId,
    version,
    actionEvidenceRef: input.actionEvidenceRef,
  })}`;
  const sideEffectBudget = {
    paidUsd: 0,
    realProviderCalls: 0,
    pancatWrites: 0,
    productionPublishes: 0,
    realAssetDeletes: 0,
    crossProjectMemoryReads: 0,
    crossProjectMemoryWrites: 0,
  };
  return {
    schemaVersion: 1 as const,
    causalFailureClass: "evaluation-defect" as const,
    signalSources: [
      { id: input.correctionSignalRef, kind: "external-ref" as const },
      { id: input.actionEvidenceRef, kind: "external-ref" as const },
    ],
    deliveryContracts: {
      episodeCollectionContract: {
        schemaVersion: 1 as const,
        id: `host-receipt-episodes-v${version}`,
        projectId: input.projectId,
        mode: "commitment-only" as const,
        allowedSources: ["host-owned-fixture-replay" as const],
        requiredEpisodeFields: [
          "profileId", "sourceRef", "leakageGroupId", "observedAt",
          "inputSnapshotSha256", "outcomeSnapshotSha256", "policyRef",
          "metrics", "sideEffectCounters", "evidenceRefs", "privacyReview",
        ],
        privacyReceiptContractRef: privacyContractId,
        appendOnly: true as const,
        rawPayloadPolicy: "reject" as const,
        sideEffectBudget,
      },
      maturityGateContract: {
        schemaVersion: 1 as const,
        id: `host-receipt-maturity-v${version}`,
        projectId: input.projectId,
        currentMaturity: "designed" as const,
        allowedTransitions: ["designed->instrumented" as const, "instrumented->shadowing" as const],
        forbiddenTransitions: [
          "designed->shadowing" as const,
          "designed->autonomous" as const,
          "instrumented->autonomous" as const,
          "shadowing->autonomous" as const,
        ],
        requireIndependentReceiptForEveryTransition: true as const,
        stages: [
          {
            id: "designed" as const,
            requiredEvidenceRefs: [input.actionEvidenceRef],
            guardMetrics: ["frozen contracts are complete"],
            allowedOperations: ["freeze delivery contracts"],
            failureMaturity: "designed" as const,
          },
          {
            id: "instrumented" as const,
            requiredEvidenceRefs: [input.actionEvidenceRef],
            guardMetrics: ["episodes are commitment-only"],
            allowedOperations: ["collect episode commitments"],
            failureMaturity: "designed" as const,
          },
          {
            id: "shadowing" as const,
            requiredEvidenceRefs: [input.actionEvidenceRef],
            guardMetrics: ["side effect counters remain zero"],
            allowedOperations: ["compare frozen variants"],
            failureMaturity: "instrumented" as const,
          },
        ],
      },
      productionEpisodePrivacyReceiptContract: {
        schemaVersion: 1 as const,
        id: privacyContractId,
        projectId: input.projectId,
        mode: "requirements-only" as const,
        privacyReview: {
          requiredStatus: "approved" as const,
          policySha256,
          reviewerRef: "reviewer:independent-host-verifier",
          dataClassification: "confidential" as const,
          retentionPolicyRef: `policy:host-receipt-retention-v${version}`,
          evidenceRefs: [input.actionEvidenceRef],
        },
        snapshotBinding: {
          inputSnapshotSha256Required: true as const,
          outcomeSnapshotSha256Required: true as const,
          mustMatchEpisode: true as const,
        },
        rawPayloadPolicy: "reject" as const,
        appendOnly: true as const,
        rejectionConditions: ["privacy receipt is absent or mismatched"],
      },
      promotionReceiptContract: {
        schemaVersion: 1 as const,
        id: `host-receipt-promotion-v${version}`,
        mode: "draft-only" as const,
        projectId: input.projectId,
        authorizedDecisionRef: `decision:${input.sourceDecisionId}`,
        fromVariantId,
        toVariantId,
        exactTargetRef,
        readbackEvidenceRefs: [input.actionEvidenceRef],
        canaryEvidenceRefs: [input.actionEvidenceRef],
        observationWindow: { matchedRuns: 3, startsAfterMaturity: "instrumented" as const },
        rollbackPlanRef,
        rollbackReceiptId: null,
        issuerRef: "issuer:ouroboros-authority",
        issuedAtRequired: true as const,
      },
      rollbackContract: {
        schemaVersion: 1 as const,
        id: `host-receipt-rollback-v${version}`,
        projectId: input.projectId,
        exactTargetRef,
        lastKnownGoodRef,
        idempotencyKey: `rollback:target-policy-v${version}`,
        rollbackPlanRef,
        rollbackReceiptId: null,
        triggers: [{ id: "guard-regression", condition: "any frozen guard metric regresses" }],
        readbackEvidenceRefs: [input.actionEvidenceRef],
        canaryEvidenceRefs: [input.actionEvidenceRef],
        appendOnly: true as const,
        deleteOrRewriteHistory: false as const,
        forbiddenScopes: ["HEAD", "latest", "wildcard target"],
      },
    },
  };
}

function ensureVersionedDesigner(
  harness: Harness,
  deliveryRun: Run,
  marker: HostEvidenceMaintenanceMarker,
  action: { eventId: string; result: Record<string, unknown> },
  verifierTask: Task,
) {
  const parentRunId = typeof deliveryRun.context.parentRunId === "string" ? deliveryRun.context.parentRunId : null;
  const parent = parentRunId ? harness.getRun(parentRunId) : null;
  if (!parent || parent.context.source !== "target-system-design" || parent.projectId !== deliveryRun.projectId) {
    throw new Error("host evidence maintenance delivery is not bound to a target-system-design root");
  }
  const evidenceBundle = buildEvidenceBundle(harness, deliveryRun, marker, action);
  const receipt = evidenceBundle.hostCorpusReceipts[0]!;
  const actionEvidenceRef = `action:${action.eventId}`;
  const proposalProjection = buildHostReceiptProposalProjection({
    projectId: deliveryRun.projectId!,
    actionEvidenceRef,
    correctionSignalRef: marker.sourceSignalId,
    sourceDecisionId: marker.sourceDecisionId,
    targetVersion: marker.targetVersion,
  });
  const requiredBusinessTerms = [
    "短剧",
    "互动游戏剧",
    "电视剧",
    "电影",
    "ainovel",
    "专业编剧",
    "审核",
    "评分",
    "互动第四墙",
    "共生",
  ];
  const retiredPredecessors = harness.listRuns({ limit: 1_000 }).filter((candidate) =>
    candidate.context.parentRunId === deliveryRun.id
    && candidate.context.source === "target-system-design"
    && candidate.context.sourceTaskId === verifierTask.id
    && candidate.context.retired === true,
  );
  const generation = retiredPredecessors.length;
  const runId = stableId("run", `host-evidence-successor|${action.eventId}|generation:${generation}`);
  const taskId = stableId("task", `host-evidence-successor-designer|${action.eventId}|generation:${generation}`);
  const hostReceiptDesignAdapter = {
    schemaVersion: 1 as const,
    actionId: action.eventId,
    actionEvidenceRef,
    correctionSignalRef: marker.sourceSignalId,
    targetVersion: marker.targetVersion,
    manifestSha256: receipt.manifestSha256,
    comparisonSha256: receipt.comparisonSha256,
    proposalProjection,
    proposalProjectionSha256: canonicalEvolutionValueSha256(proposalProjection),
    requiredBusinessTerms,
  };
  if (!harness.getRun(runId)) {
    harness.createRun({
      id: runId,
      goal: `Design version ${marker.targetVersion} from verified host receipt ${action.eventId}`,
      projectId: deliveryRun.projectId,
      context: {
        ...parent.context,
        source: "target-system-design",
        parentRunId: deliveryRun.id,
        sourceTaskId: verifierTask.id,
        targetSystemEvidenceBundle: evidenceBundle,
        hostReceiptDesignAdapter,
      },
    });
  }
  if (!harness.getTask(taskId)) {
    harness.createTask({
      id: taskId,
      runId,
      role: "designer",
      goal: `Propose the version ${marker.targetVersion} comparison or stay quiescent`,
      prompt: [
        `Use the verified host receipt ${action.eventId} to decide version ${marker.targetVersion}.`,
        `The fixed adapter supplies actionEvidenceRef=${actionEvidenceRef}; proposal.evidenceRefs must retain this exact reference.`,
        `The fixed adapter also supplies correctionSignalRef=${marker.sourceSignalId}; proposal.evidenceRefs and observation sources are normalized to this exact reference.`,
        `Cite signal ${marker.sourceSignalId}. Receipt-owned fields are injected by the control plane: evolutionPack.version=${marker.targetVersion}, evaluationContract.comparison, holdout commitment, manifest hash, comparison hash, and maturityGateContract.packRef.`,
        "Do not rewrite, downgrade, or replace those receipt-owned fields. Design only the target business problem, mechanism, professional creative approach, and delivery path.",
        "The business design must cover 短剧、互动游戏剧、电视剧和电影, ainovel 原创能力, 专业编剧审核与评分, and 互动第四墙和共生.",
        "Keep the immutable prior proposal unchanged. The holdout remains count-and-commitment only.",
        "Return one fixed proposeDesign action or a mutation-free quiescent result. Do not implement or create tasks directly.",
        JSON.stringify(evidenceBundle, null, 2),
      ].join("\n"),
      doneWhen: [
        "the immutable prior comparison remains unchanged",
        `a valid version ${marker.targetVersion} proposal cites the host receipt or the Designer stays quiescent`,
        "no Worker, Planner, Verifier, or delivery run is created directly",
      ],
      config: {
        readOnly: true,
        forbidImplementation: true,
        forbidBrowser: true,
        browserProcessPolicy: "deny",
        targetSystemEvidenceBundle: evidenceBundle,
        hostReceiptDesignAdapter,
      },
    });
  }
  return { runId, taskId };
}

function blockHostEvidenceRun(
  harness: Harness,
  run: Run,
  task: Task,
  marker: HostEvidenceMaintenanceMarker,
  action: (HarnessActionResult & { eventId?: string }) | null,
) {
  applyHarnessAction(harness, {
    type: "updateRunContext",
    runId: run.id,
    status: "blocked",
    contextPatch: {
      hostEvidenceMaintenance: {
        state: "blocked",
        taskId: task.id,
        actionEventId: action?.eventId ?? null,
        rootCause: "missing-authoritative-boundary",
      },
    },
    reason: "host evidence maintenance failed closed without Goal Review recursion",
  });
  applyHarnessAction(harness, {
    type: "recordSignal",
    projectId: run.projectId!,
    sourceRunId: run.id,
    signalClass: "system",
    source: `blocked-run-outcome:${run.id}`,
    title: "Host evidence maintenance lacks an authoritative fixture boundary",
    summary: "The host fixed action failed closed before a receipt or verifier could be created.",
    observationTime: new Date().toISOString(),
    confidence: 1,
    evidence: [
      `run:${run.id}`,
      `task:${task.id}`,
      ...(action?.eventId ? [`action:${action.eventId}`] : []),
    ],
    payload: {
      outcome: "evidence-defect",
      defectKind: "missing-authoritative-boundary",
      sourceSignalId: marker.sourceSignalId,
      sourceRunId: marker.sourceRunId,
      sourceProposalId: marker.sourceProposalId,
      targetVersion: marker.targetVersion,
      terminal: true,
    },
  });
}

function stableId(prefix: "run" | "task", value: string) {
  return `${prefix}_${createHash("sha1").update(value).digest("hex")}`;
}
