import { canonicalEvolutionValueSha256, DEFAULT_TASK_PROMPT_TEMPLATE } from "@ouroboros/harness";
import type { Lesson } from "@ouroboros/harness";
import { createHash } from "node:crypto";
import type { PromptInput } from "./types";
import { prettyJson, renderPromptTemplate } from "./template";

const MAX_PROMPT_LESSONS = 12;
const MAX_LESSON_SUMMARY_CHARS = 320;
const MAX_ACTIVE_GUARDRAILS = 8;
const FROZEN_LINEAR_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RFC3339_WITH_TIMEZONE = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function targetEvolutionPackExample(projectId: string, charterId: string) {
  return {
  schemaVersion: 1,
  id: "target-evolution-pack",
  targetSystemId: "target-system",
  version: 4,
  knowledgeScope: `project:${projectId}`,
  objective: {
    charterId,
    domainOutcomes: ["measurable domain outcome"],
    nonGoals: ["production side effect outside the experiment"],
  },
  observation: {
    signalSources: [{ id: "run-evidence", kind: "run-evidence" }],
  },
  mutationSurfaces: [
    {
      id: "bounded-policy-artifact",
      evolutionTarget: "artifact",
      layer: "policy",
      projectId,
      allowedPaths: ["config/evolution/**"],
      forbiddenPaths: ["db/**"],
      owner: "target",
    },
  ],
  experimentPolicy: {
    controlRequired: true,
    holdoutRequired: true,
    unrelatedRegressionRequired: true,
    equalBudgetRequired: true,
    maxCandidates: 2,
  },
  promotionPolicy: {
    guardMetrics: ["zero unintended writes"],
    observationWindow: "three matched runs",
    rollback: "restore the frozen control artifact",
  },
  handoff: {
    maturity: "designed",
    targetOwner: "target-system",
    requiredCapabilities: ["frozen evidence replay"],
  },
  portability: {
    projectLocalRules: ["keep domain semantics project-local"],
    genericizationEvidence: [],
  },
  } as const;
}

function targetEvolutionProposalExtension(projectId: string, charterId: string) {
  const evolutionPack = targetEvolutionPackExample(projectId, charterId);
  return {
  evolutionPack,
  causalHypothesis: {
    failureClass: "domain-hypothesis",
    mechanism: "one bounded policy causes the measured gap",
    predictedEffects: ["candidate improves the primary metric under the same budget"],
    disconfirmingEvidence: ["holdout metric does not improve"],
  },
  evaluationContract: {
    comparison: {
      controlRef: "control_example",
      developmentEvidenceRefs: ["development_evidence_example"],
      holdoutEvidenceRefs: ["holdout_evidence_example"],
      unrelatedEvidenceRefs: ["unrelated_evidence_example"],
      corpusSnapshotSha256: "0".repeat(64),
      equalBudget: {
        model: "<model>",
        reasoningEffort: "high",
        wallClockMs: 300_000,
        maxAttempts: 2,
        maxTokens: 20_000,
        toolPolicySha256: "1".repeat(64),
        concurrency: 1,
      },
      primaryMetric: "primary outcome metric",
      minimumUplift: 0,
      maximumGuardRegression: 0,
    },
  },
  episodeCollectionContract: {
    schemaVersion: 1,
    id: "episode-collection-contract-v1",
    projectId,
    mode: "commitment-only",
    allowedSources: ["host-owned-fixture-replay"],
    requiredEpisodeFields: [
      "profileId",
      "sourceRef",
      "leakageGroupId",
      "observedAt",
      "inputSnapshotSha256",
      "outcomeSnapshotSha256",
      "policyRef",
      "metrics",
      "sideEffectCounters",
      "evidenceRefs",
      "privacyReview",
    ],
    privacyReceiptContractRef: "production-episode-privacy-contract-v1",
    appendOnly: true,
    rawPayloadPolicy: "reject",
    sideEffectBudget: {
      paidUsd: 0,
      realProviderCalls: 0,
      pancatWrites: 0,
      productionPublishes: 0,
      realAssetDeletes: 0,
      crossProjectMemoryReads: 0,
      crossProjectMemoryWrites: 0,
    },
  },
  maturityGateContract: {
    schemaVersion: 1,
    id: "maturity-gate-contract-v1",
    projectId,
    packRef: {
      id: evolutionPack.id,
      version: evolutionPack.version,
      contentSha256: canonicalEvolutionValueSha256(evolutionPack),
    },
    currentMaturity: "designed",
    allowedTransitions: ["designed->instrumented", "instrumented->shadowing"],
    forbiddenTransitions: [
      "designed->shadowing",
      "designed->autonomous",
      "instrumented->autonomous",
      "shadowing->autonomous",
    ],
    requireIndependentReceiptForEveryTransition: true,
    stages: [
      {
        id: "designed",
        requiredEvidenceRefs: ["evidence:accepted-design"],
        guardMetrics: ["frozen contracts are complete"],
        allowedOperations: ["freeze delivery contracts"],
        failureMaturity: "designed",
      },
      {
        id: "instrumented",
        requiredEvidenceRefs: ["evidence:host-privacy-receipt"],
        guardMetrics: ["episodes are commitment-only"],
        allowedOperations: ["collect episode commitments"],
        failureMaturity: "designed",
      },
      {
        id: "shadowing",
        requiredEvidenceRefs: ["evidence:matched-shadow-readback"],
        guardMetrics: ["side effect counters remain zero"],
        allowedOperations: ["compare frozen variants"],
        failureMaturity: "instrumented",
      },
    ],
  },
  productionEpisodePrivacyReceiptContract: {
    schemaVersion: 1,
    id: "production-episode-privacy-contract-v1",
    projectId,
    mode: "requirements-only",
    privacyReview: {
      requiredStatus: "approved",
      policySha256: "2".repeat(64),
      reviewerRef: "reviewer:host-privacy-verifier",
      dataClassification: "confidential",
      retentionPolicyRef: "policy:episode-retention-v1",
      evidenceRefs: ["evidence:privacy-review"],
    },
    snapshotBinding: {
      inputSnapshotSha256Required: true,
      outcomeSnapshotSha256Required: true,
      mustMatchEpisode: true,
    },
    rawPayloadPolicy: "reject",
    appendOnly: true,
    rejectionConditions: ["privacy receipt is absent or mismatched"],
  },
  promotionReceiptContract: {
    schemaVersion: 1,
    id: "promotion-receipt-contract-v1",
    mode: "draft-only",
    projectId,
    authorizedDecisionRef: "decision:accepted-evolution-design",
    fromVariantId: `variant_${"3".repeat(64)}`,
    toVariantId: `variant_${"4".repeat(64)}`,
    exactTargetRef: "artifact:target-policy-v4",
    readbackEvidenceRefs: ["evidence:promotion-readback"],
    canaryEvidenceRefs: ["evidence:promotion-canary"],
    observationWindow: { matchedRuns: 3, startsAfterMaturity: "instrumented" },
    rollbackPlanRef: "plan:exact-target-rollback-v4",
    rollbackReceiptId: null,
    issuerRef: "issuer:design-authority",
    issuedAtRequired: true,
  },
  rollbackContract: {
    schemaVersion: 1,
    id: "rollback-contract-v1",
    projectId,
    exactTargetRef: "artifact:target-policy-v4",
    lastKnownGoodRef: "artifact:target-policy-v3",
    idempotencyKey: "rollback:target-policy-v4",
    rollbackPlanRef: "plan:exact-target-rollback-v4",
    rollbackReceiptId: null,
    triggers: [{ id: "guard-regression", condition: "any frozen guard metric regresses" }],
    readbackEvidenceRefs: ["evidence:rollback-readback"],
    canaryEvidenceRefs: ["evidence:rollback-canary"],
    appendOnly: true,
    deleteOrRewriteHistory: false,
    forbiddenScopes: ["HEAD", "latest", "wildcard target"],
  },
  } as const;
}

export function buildTaskPrompt(input: PromptInput) {
  const compactRecentLessons = compactLessons(input.lessons ?? []);
  const template = input.template ?? DEFAULT_TASK_PROMPT_TEMPLATE;
  const sealedHoldoutRefs = frozenHoldoutEvidenceRefs(input.run.context);
  const sealText = (value: string) => redactSealedPromptText(value, sealedHoldoutRefs);
  const frozenLinearImplementationGate = sealText(
    renderFrozenLinearImplementationGate(
      input.run.context,
      input.task.config,
      input.task.role,
    ),
  );
  const frozenTargetEvolutionContract = renderFrozenTargetEvolutionContract(
    input.run.context,
    input.task.role,
  );
  const protectedSections = [
    frozenLinearImplementationGate,
    frozenTargetEvolutionContract,
  ].filter(Boolean);
  const prompt = renderPromptTemplate(template, {
    runGoal: sealText(input.run.goal),
    runContextJson: prettyJson(promptSafeRunContext(input.run.context, sealedHoldoutRefs)),
    taskId: input.task.id,
    taskRole: input.task.role,
    taskGoal: sealText(input.task.goal),
    taskConfigJson: prettyJson(redactSealedPromptValues(input.task.config ?? {}, sealedHoldoutRefs)),
    taskPrompt: sealText(input.task.prompt),
    doneWhenMarkdown: input.task.doneWhen.map((item) => `- ${sealText(item)}`).join("\n"),
    dependencyAttemptsJson: prettyJson(
      redactSealedPromptValues(input.dependencyAttempts, sealedHoldoutRefs),
    ),
    activeGuardrailsMarkdown: [
      ...protectedSections,
      renderTargetEvolutionProposalContract(input.task.role, input.run),
      sealText(renderActiveGuardrails(input.run.context, input.task.role)),
    ].filter(Boolean).join("\n"),
    candidateGuardrailsMarkdown: sealText(renderCandidateGuardrails(compactRecentLessons)),
    reusableExperienceEvidenceMarkdown: sealText(
      renderReusableExperienceEvidence(compactRecentLessons),
    ),
    runLessonsJson: prettyJson(redactSealedPromptValues(compactRecentLessons, sealedHoldoutRefs)),
    requiredOutputJson: prettyJson(
      redactSealedPromptValues(
        requiredOutputForRole(input.task.role, input.task.config),
        sealedHoldoutRefs,
      ),
    ),
  });
  const omittedProtectedSections = protectedSections.filter((section) => !prompt.includes(section));
  if (omittedProtectedSections.length > 0) {
    return `${prompt}\n\n${omittedProtectedSections.join("\n")}`;
  }
  return prompt;
}

function renderFrozenTargetEvolutionContract(
  runContext: Record<string, unknown>,
  role: string,
): string {
  if (!new Set(["planner", "worker", "verifier", "outcome-review"]).has(role)) {
    return "";
  }
  const evolutionInstance = asRecord(runContext.evolutionInstance);
  const evolutionPack = asRecord(runContext.evolutionPack);
  const causalHypothesis = asRecord(runContext.causalHypothesis);
  const comparison = asRecord(runContext.evolutionComparison) ?? asRecord(runContext.comparison);
  const evaluationContract = asRecord(runContext.designEvaluationContract);
  const designProposal = asRecord(runContext.designProposal);
  if (!evolutionInstance || !evolutionPack || !causalHypothesis || !comparison || !evaluationContract) {
    return "";
  }
  const sealedHoldoutRefs = frozenHoldoutEvidenceRefs(runContext);
  const safeComparison = frozenComparisonView(comparison);
  const deliveryContracts = designProposal
    ? pickDefined({
        episodeCollectionContract: designProposal.episodeCollectionContract,
        maturityGateContract: designProposal.maturityGateContract,
        productionEpisodePrivacyReceiptContract: designProposal.productionEpisodePrivacyReceiptContract,
        promotionReceiptContract: designProposal.promotionReceiptContract,
        rollbackContract: designProposal.rollbackContract,
      })
    : {};
  const safeDeliveryContracts = redactSealedPromptValues(
    redactSensitivePromptMaterial(deliveryContracts),
    sealedHoldoutRefs,
  );
  return [
    "## Frozen Target Evolution Contract",
    "This task may implement or evaluate the accepted design, but it must not weaken, replace, or amend these frozen values.",
    "The holdout split is sealed. Ordinary roles receive only its commitment and count; do not request, infer, reproduce, expose, or query its references, contents, or results.",
    "### Optimization target pack",
    "```json",
    prettyJson(redactSealedPromptValues(frozenEvolutionPackView(evolutionPack), sealedHoldoutRefs)),
    "```",
    "### Causal hypothesis",
    "```json",
    prettyJson(
      redactSealedPromptValues(frozenCausalHypothesisView(causalHypothesis), sealedHoldoutRefs),
    ),
    "```",
    "### Matched comparison protocol",
    "```json",
    prettyJson(safeComparison),
    "```",
    "### Frozen evaluation contract",
    "```json",
    prettyJson(
      frozenEvaluationContractView(evaluationContract, safeComparison, sealedHoldoutRefs),
    ),
    "```",
    ...(Object.keys(deliveryContracts).length === 0
      ? []
      : [
          "### Frozen delivery contracts",
          "```json",
          prettyJson(safeDeliveryContracts),
          "```",
        ]),
    "### Evolution instance identity",
    "```json",
    prettyJson(
      redactSealedPromptValues(frozenEvolutionInstanceView(evolutionInstance), sealedHoldoutRefs),
    ),
    "```",
    "",
  ].join("\n");
}

function promptSafeRunContext(
  context: Record<string, unknown>,
  sealedHoldoutRefs: string[] = frozenHoldoutEvidenceRefs(context),
): Record<string, unknown> {
  const evolutionInstance = asRecord(context.evolutionInstance);
  const isDesignChild = context.source === "design"
    || context.designProposalId !== undefined
    || asRecord(context.designProposal) !== null;
  if (!isDesignChild && !evolutionInstance && sealedHoldoutRefs.length === 0) {
    return context;
  }
  const safeContext = redactSealedPromptValues(
    redactSensitivePromptMaterial(context),
    sealedHoldoutRefs,
  ) as Record<string, unknown>;
  if (!evolutionInstance) {
    return safeContext;
  }
  const {
    evolutionPack: _evolutionPack,
    causalHypothesis: _causalHypothesis,
    comparison: _comparison,
    evolutionComparison: _evolutionComparison,
    designEvaluationContract: _designEvaluationContract,
    designProposal: _designProposal,
    evolutionInstance: _evolutionInstance,
    ...rest
  } = safeContext;
  return {
    ...rest,
    targetEvolutionSummary: redactSealedPromptValues(
      frozenEvolutionInstanceView(evolutionInstance),
      sealedHoldoutRefs,
    ),
  };
}

function frozenHoldoutEvidenceRefs(context: Record<string, unknown>): string[] {
  const designEvaluationContract = asRecord(context.designEvaluationContract);
  const designProposal = asRecord(context.designProposal);
  const proposalEvaluationContract = asRecord(designProposal?.evaluationContract);
  const comparisons = [
    asRecord(context.evolutionComparison),
    asRecord(context.comparison),
    asRecord(designEvaluationContract?.comparison),
    asRecord(proposalEvaluationContract?.comparison),
  ];
  const refs: string[] = [];
  for (const comparison of comparisons) {
    const candidateRefs = comparison?.holdoutEvidenceRefs;
    if (
      Array.isArray(candidateRefs)
      && candidateRefs.every((entry) => typeof entry === "string" && entry.length > 0)
    ) {
      refs.push(...candidateRefs);
    }
  }
  return [...new Set(refs)];
}

function redactSealedPromptText(value: string, sealedValues: string[]): string {
  let redacted = value;
  for (const sealedValue of [...sealedValues].sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(sealedValue).join("[SEALED_HOLDOUT_REFERENCE]");
  }
  return redacted;
}

function redactSealedPromptValues(value: unknown, sealedValues: string[]): unknown {
  if (typeof value === "string") {
    return redactSealedPromptText(value, sealedValues);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSealedPromptValues(entry, sealedValues));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      redactSealedPromptValues(entry, sealedValues),
    ]),
  );
}

function frozenEvaluationContractView(
  contract: Record<string, unknown>,
  comparison: Record<string, unknown>,
  sealedHoldoutRefs: string[] = [],
): Record<string, unknown> {
  const visibleContract = redactSealedPromptValues(pickDefined({
    baseline: contract.baseline,
    successMetrics: contract.successMetrics,
    guardMetrics: contract.guardMetrics,
    requiredEvidence: contract.requiredEvidence,
    reviewAt: contract.reviewAt,
  }), sealedHoldoutRefs) as Record<string, unknown>;
  return {
    ...visibleContract,
    comparison,
  };
}

function frozenComparisonView(comparison: Record<string, unknown>): Record<string, unknown> {
  const equalBudget = asRecord(comparison.equalBudget);
  const sealedHoldoutRefs = Array.isArray(comparison.holdoutEvidenceRefs)
    && comparison.holdoutEvidenceRefs.every((entry) => typeof entry === "string")
    ? comparison.holdoutEvidenceRefs
    : [];
  const visible = redactSealedPromptValues(pickDefined({
    controlRef: comparison.controlRef,
    developmentEvidenceRefs: comparison.developmentEvidenceRefs,
    unrelatedEvidenceRefs: comparison.unrelatedEvidenceRefs,
    corpusSnapshotSha256: comparison.corpusSnapshotSha256,
    equalBudget: equalBudget
      ? pickDefined({
          model: equalBudget.model,
          reasoningEffort: equalBudget.reasoningEffort,
          wallClockMs: equalBudget.wallClockMs,
          maxAttempts: equalBudget.maxAttempts,
          maxTokens: equalBudget.maxTokens,
          toolPolicySha256: equalBudget.toolPolicySha256,
          concurrency: equalBudget.concurrency,
        })
      : undefined,
    primaryMetric: comparison.primaryMetric,
    minimumUplift: comparison.minimumUplift,
    maximumGuardRegression: comparison.maximumGuardRegression,
  }), sealedHoldoutRefs) as Record<string, unknown>;
  const commitment = sealedHoldoutEvidenceCommitment(comparison.holdoutEvidenceRefs);
  return {
    ...visible,
    ...(commitment ? { holdoutEvidenceCommitment: commitment } : {}),
  };
}

function sealedHoldoutEvidenceCommitment(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return {
    algorithm: "sha256",
    count: value.length,
    refsSha256: createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"),
  };
}

function frozenCausalHypothesisView(hypothesis: Record<string, unknown>): Record<string, unknown> {
  return pickDefined({
    failureClass: hypothesis.failureClass,
    mechanism: hypothesis.mechanism,
    predictedEffects: hypothesis.predictedEffects,
    disconfirmingEvidence: hypothesis.disconfirmingEvidence,
  });
}

function frozenEvolutionInstanceView(instance: Record<string, unknown>): Record<string, unknown> {
  const cycle = asRecord(instance.cycle);
  const pack = asRecord(instance.pack);
  return pickDefined({
    schemaVersion: instance.schemaVersion,
    mode: instance.mode,
    kernelProjectId: instance.kernelProjectId,
    targetProjectId: instance.targetProjectId,
    cycle: cycle ? pickDefined({ kind: cycle.kind, index: cycle.index }) : undefined,
    pack: pack
      ? pickDefined({ id: pack.id, version: pack.version, contentSha256: pack.contentSha256 })
      : undefined,
  });
}

function frozenEvolutionPackView(pack: Record<string, unknown>): Record<string, unknown> {
  const objective = asRecord(pack.objective);
  const observation = asRecord(pack.observation);
  const experimentPolicy = asRecord(pack.experimentPolicy);
  const promotionPolicy = asRecord(pack.promotionPolicy);
  const handoff = asRecord(pack.handoff);
  const portability = asRecord(pack.portability);
  const signalSources = Array.isArray(observation?.signalSources)
    ? observation.signalSources.map((value) => {
        const source = asRecord(value);
        return source ? pickDefined({ id: source.id, kind: source.kind, freshnessMs: source.freshnessMs }) : {};
      })
    : undefined;
  const mutationSurfaces = Array.isArray(pack.mutationSurfaces)
    ? pack.mutationSurfaces.map((value) => {
        const surface = asRecord(value);
        return surface
          ? pickDefined({
              id: surface.id,
              evolutionTarget: surface.evolutionTarget,
              layer: surface.layer,
              projectId: surface.projectId,
              allowedPaths: surface.allowedPaths,
              forbiddenPaths: surface.forbiddenPaths,
              owner: surface.owner,
            })
          : {};
      })
    : undefined;
  return pickDefined({
    schemaVersion: pack.schemaVersion,
    id: pack.id,
    targetSystemId: pack.targetSystemId,
    version: pack.version,
    knowledgeScope: pack.knowledgeScope,
    objective: objective
      ? pickDefined({
          charterId: objective.charterId,
          domainOutcomes: objective.domainOutcomes,
          nonGoals: objective.nonGoals,
        })
      : undefined,
    observation: observation ? pickDefined({ signalSources }) : undefined,
    mutationSurfaces,
    experimentPolicy: experimentPolicy
      ? pickDefined({
          controlRequired: experimentPolicy.controlRequired,
          holdoutRequired: experimentPolicy.holdoutRequired,
          unrelatedRegressionRequired: experimentPolicy.unrelatedRegressionRequired,
          equalBudgetRequired: experimentPolicy.equalBudgetRequired,
          maxCandidates: experimentPolicy.maxCandidates,
        })
      : undefined,
    promotionPolicy: promotionPolicy
      ? pickDefined({
          guardMetrics: promotionPolicy.guardMetrics,
          observationWindow: promotionPolicy.observationWindow,
          rollback: promotionPolicy.rollback,
        })
      : undefined,
    handoff: handoff
      ? pickDefined({
          maturity: handoff.maturity,
          targetOwner: handoff.targetOwner,
          requiredCapabilities: handoff.requiredCapabilities,
        })
      : undefined,
    portability: portability
      ? pickDefined({
          projectLocalRules: portability.projectLocalRules,
          genericizationEvidence: portability.genericizationEvidence,
        })
      : undefined,
  });
}

function pickDefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function redactSensitivePromptMaterial(value: unknown): unknown {
  if (typeof value === "string") {
    return redactPromptCredentialText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactSensitivePromptMaterial);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isSensitivePromptMaterialKey(key))
      .map(([key, entry]) => [key, redactSensitivePromptMaterial(entry)]),
  );
}

function redactPromptCredentialText(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[REDACTED]@")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|lin_api|lin_oauth)[_-][A-Za-z0-9._-]+\b/gi, "[REDACTED]")
    .replace(
      /(\bauthorization\b\s*[:=]\s*)(?:(?:Bearer|Basic)\s+)?[^\s,;}\])]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(x-access-token\s*:\s*)[^@\s]+/gi, "$1[REDACTED]")
    .replace(
      /(\b(?:api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|token|secret|password|credential)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\])]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b(?:access[\s_-]*token|refresh[\s_-]*token|token|secret|password|credential)\b\s+)(?=[^\s,;}\])]*[._~+\/-])[^\s,;}\])]+/gi,
      "$1[REDACTED]",
    );
}

function isSensitivePromptMaterialKey(key: string): boolean {
  if (isHeldoutMaterialKey(key)) {
    return true;
  }
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  if (
    normalized.includes("secret")
    || normalized.includes("credential")
    || normalized.includes("authorization")
    || (normalized.includes("token") && normalized !== "maxtokens")
  ) {
    return true;
  }
  return false;
}

function isHeldoutMaterialKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  return normalized.includes("holdout") || normalized.includes("heldout");
}

function renderTargetEvolutionProposalContract(role: string, run: PromptInput["run"]): string {
  if (role !== "designer") {
    return "";
  }
  const projectId = run.projectId
    ?? (typeof run.context.projectId === "string" ? run.context.projectId : "<project_id>");
  const charterId = typeof run.context.designCharterId === "string"
    ? run.context.designCharterId
    : typeof run.context.founderCharterId === "string"
      ? run.context.founderCharterId
      : "<charter_id>";
  return [
    "## Target System Evolution Proposal Contract",
    "A normal proposeDesign may omit target-evolution data. The core evolution group must include all three blocks together: proposal.evolutionPack, proposal.causalHypothesis, and proposal.evaluationContract.comparison.",
    "For evolutionPack version 4 or later, the proposal must also include all five strict delivery contracts together: episodeCollectionContract, maturityGateContract, productionEpisodePrivacyReceiptContract, promotionReceiptContract, and rollbackContract. Do not use aliases such as projectIdentityContract, privacyReceiptContract, or equalBudgetComparisonContract.",
    "- evolutionPack schemaVersion is 1. It names the project-local objective, observation sources, mutation surfaces, experiment and promotion policy, designed handoff, and portability boundary.",
    "- Artifacts, Harness, and Model are optimization targets; the meta-kernel, project pack, and delivery path are responsibility layers. Milestone-one model mutation is prohibited.",
    "- causalHypothesis must state a supported failureClass, mechanism, predictedEffects, and disconfirmingEvidence.",
    "- comparison must freeze non-empty development, holdout, and unrelated evidence refs plus a corpus hash, controlRef, primary metric, thresholds, and the same equal budget for control and candidate.",
    "- The five delivery contracts freeze commitment-only episode collection, designed-to-instrumented-to-shadowing gates, privacy-review requirements (not an approval receipt), a draft-only promotion receipt shape, and exact idempotent rollback/readback. Their nested fields are strict; unknown or missing fields are rejected.",
    "- Candidate generation receives only a sealed holdout commitment, hash, and count. It must not receive, cite, query, or reproduce holdout refs, contents, or results. Tests alone do not replace the matched baseline or unrelated-regression evidence.",
    "Merge this exact optional extension fragment into the single proposeDesign proposal shown below. Do not emit another proposeDesign action:",
    "```json",
    prettyJson(targetEvolutionProposalExtension(projectId, charterId)),
    "```",
    "",
  ].join("\n");
}

interface LinearDeliveryScope {
  issueId: string;
  identifier: string;
  teamKey: string;
  state: string;
  stateId: string;
}

function renderFrozenLinearImplementationGate(
  runContext: Record<string, unknown>,
  taskConfig: Record<string, unknown> | undefined,
  role: string,
) {
  if (role !== "planner" && role !== "worker") {
    return "";
  }

  const taskContract = asRecord(taskConfig?.linearDelivery);
  const linearDelivery = asRecord(runContext.linearDelivery);
  if (!taskContract && !linearDelivery) {
    return "";
  }

  const supervisorEvidence = asRecord(runContext.externalSupervisorEvidence);
  const supervisorLinear = asRecord(supervisorEvidence?.linear);
  const usesSupervisorEvidence = supervisorLinear !== null;
  const contractRecord = taskContract ?? (usesSupervisorEvidence ? linearDelivery : null);
  const evidenceRecord = usesSupervisorEvidence ? supervisorLinear : taskContract ? linearDelivery : null;
  const contract = linearScope(contractRecord);
  const parsedEvidence = linearEvidenceScope(evidenceRecord);
  const evidence = parsedEvidence.scope;
  const problems: string[] = [];
  problems.push(...parsedEvidence.problems);

  if (!contract) {
    problems.push("current task contract is missing an exact issueId, identifier, teamKey, state, or stateId");
  }
  if (!evidence) {
    problems.push("frozen evidence is missing an exact issueId, identifier, teamKey, state, or stateId");
  }
  const verifiedBy = readString(evidenceRecord, usesSupervisorEvidence ? "verifiedBy" : "statusVerifiedBy");
  const outcome = readString(evidenceRecord, usesSupervisorEvidence ? "outcome" : "statusOutcome");
  if (evidenceRecord && verifiedBy !== "independent_readback") {
    problems.push("frozen evidence verifiedBy is not independent_readback");
  }
  if (evidenceRecord && outcome !== "verified") {
    problems.push("frozen evidence outcome is not verified");
  }
  if (parsedEvidence.nested && readString(evidenceRecord, "status") !== "verified") {
    problems.push("frozen evidence status is not verified");
  }
  if (usesSupervisorEvidence && supervisorEvidence?.version !== 1) {
    problems.push("frozen evidence version is not v1");
  }
  if (usesSupervisorEvidence && contractRecord === linearDelivery && linearDelivery) {
    if (readString(linearDelivery, "statusVerifiedBy") !== "independent_readback") {
      problems.push("linearDelivery statusVerifiedBy is not independent_readback");
    }
    if (readString(linearDelivery, "statusOutcome") !== "verified") {
      problems.push("linearDelivery statusOutcome is not verified");
    }
  }
  const observedAt = readString(usesSupervisorEvidence ? supervisorEvidence : evidenceRecord, "observedAt");
  const freshness = frozenEvidenceFreshness(observedAt);
  if (freshness === "missing") {
    problems.push("frozen evidence has no observation time");
  } else if (freshness === "invalid") {
    problems.push("frozen evidence observation time is invalid");
  } else if (freshness === "expired") {
    problems.push("frozen evidence is expired");
  }
  if (contract && evidence) {
    for (const field of ["issueId", "identifier", "teamKey", "state", "stateId"] as const) {
      if (contract[field] !== evidence[field]) {
        problems.push(`${field} does not match the current task contract`);
      }
    }
  }

  const finalGate =
    "This start gate does not satisfy final delivery gates. After implementation, independently read back the final Linear evidence comment, the Linear Done state, and every Git remote SHA; fail closed if any final readback is missing or mismatched.";
  if (problems.length > 0) {
    return [
      "## Frozen Linear Implementation Gate",
      "Status: NOT SATISFIED.",
      ...problems.map((problem) => `- ${problem}`),
      "Fail closed: do not treat this frozen evidence as permission to start local implementation. Complete the task contract's required preflight, and block if fresh independent readback is unavailable.",
      finalGate,
      "",
    ].join("\n");
  }

  return [
    "## Frozen Linear Implementation Gate",
    "Status: SATISFIED by fresh independent readback matching the current task contract.",
    `- issueId: ${contract!.issueId}`,
    `- identifier: ${contract!.identifier}`,
    `- teamKey: ${contract!.teamKey}`,
    `- state: ${contract!.state}`,
    `- stateId: ${contract!.stateId}`,
    "This is sufficient for this planner or worker to start local implementation. Do not repeat Linear or GitHub OAuth/network preflight before starting local implementation, and do not block local work merely because those repeated network calls are unavailable.",
    finalGate,
    "",
  ].join("\n");
}

function linearScope(record: Record<string, unknown> | null): LinearDeliveryScope | null {
  if (!record) {
    return null;
  }
  const scope = {
    issueId: readString(record, "issueId"),
    identifier: readString(record, "identifier"),
    teamKey: readString(record, "teamKey"),
    state: readString(record, "state"),
    stateId: readString(record, "stateId"),
  };
  return Object.values(scope).every(Boolean) ? scope as LinearDeliveryScope : null;
}

interface NestedLinearState {
  id: string;
  name: string;
  type: string | null;
}

interface NestedLinearIssue {
  id: string;
  identifier: string;
  team: { id: string; key: string };
  state: NestedLinearState;
}

function linearEvidenceScope(record: Record<string, unknown> | null): {
  scope: LinearDeliveryScope | null;
  problems: string[];
  nested: boolean;
} {
  const nested = Boolean(
    record && (asRecord(record.issue) || asRecord(record.state) || asRecord(record.readback)),
  );
  if (!record || !nested) {
    return { scope: linearScope(record), problems: [], nested: false };
  }

  const problems: string[] = [];
  const issue = nestedLinearIssue(asRecord(record.issue));
  const state = nestedLinearState(asRecord(record.state));
  const readback = asRecord(record.readback);
  const readbackIssue = nestedLinearIssue(asRecord(readback?.issue));
  if (!issue) {
    problems.push("nested issue is missing required id, identifier, team, or state fields");
  }
  if (!state) {
    problems.push("nested state is missing required id or name fields, or has an invalid type");
  }
  if (!readbackIssue) {
    problems.push("nested readback issue is missing required id, identifier, team, or state fields");
  }
  if (issue && readbackIssue) {
    if (
      issue.id !== readbackIssue.id ||
      issue.identifier !== readbackIssue.identifier ||
      issue.team.id !== readbackIssue.team.id ||
      issue.team.key !== readbackIssue.team.key
    ) {
      problems.push("nested issue identity does not match readback issue");
    }
    if (!sameNestedLinearState(issue.state, readbackIssue.state)) {
      problems.push("issue state does not match readback state");
    }
  }
  if (issue && state && !sameNestedLinearState(issue.state, state)) {
    problems.push("nested issue state does not match top-level state");
  }
  if (readbackIssue && state && !sameNestedLinearState(readbackIssue.state, state)) {
    problems.push("nested readback state does not match top-level state");
  }

  return {
    scope: readbackIssue
      ? {
          issueId: readbackIssue.id,
          identifier: readbackIssue.identifier,
          teamKey: readbackIssue.team.key,
          state: readbackIssue.state.name,
          stateId: readbackIssue.state.id,
        }
      : null,
    problems,
    nested: true,
  };
}

function nestedLinearIssue(record: Record<string, unknown> | null): NestedLinearIssue | null {
  const team = asRecord(record?.team);
  const state = nestedLinearState(asRecord(record?.state));
  const id = readString(record, "id");
  const identifier = readString(record, "identifier");
  const teamId = readString(team, "id");
  const teamKey = readString(team, "key");
  return id && identifier && teamId && teamKey && state
    ? { id, identifier, team: { id: teamId, key: teamKey }, state }
    : null;
}

function nestedLinearState(record: Record<string, unknown> | null): NestedLinearState | null {
  const id = readString(record, "id");
  const name = readString(record, "name");
  const rawType = record?.type;
  const type = rawType === null || rawType === undefined
    ? null
    : typeof rawType === "string" && rawType.trim()
      ? rawType.trim()
      : undefined;
  return id && name && type !== undefined ? { id, name, type } : null;
}

function sameNestedLinearState(left: NestedLinearState, right: NestedLinearState) {
  return left.id === right.id &&
    left.name === right.name &&
    (left.type === null || right.type === null || left.type === right.type);
}

function frozenEvidenceFreshness(observedAt: string | null): "fresh" | "expired" | "invalid" | "missing" {
  if (!observedAt) {
    return "missing";
  }
  const observed = parseRfc3339Timestamp(observedAt);
  const now = Date.now();
  if (observed === null || observed > now) {
    return "invalid";
  }
  return now - observed <= FROZEN_LINEAR_EVIDENCE_MAX_AGE_MS ? "fresh" : "expired";
}

function parseRfc3339Timestamp(value: string): number | null {
  const match = RFC3339_WITH_TIMEZONE.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const timestamp = Date.parse(value);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]! && Number.isFinite(timestamp)
    ? timestamp
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

type RequiredOutputExample = {
  status: string;
  summary: string;
  changedFiles: unknown[];
  checks: unknown[];
  artifacts: unknown[];
  problems: unknown[];
  actions: Array<Record<string, unknown>>;
};

const DEFAULT_REQUIRED_OUTPUT: RequiredOutputExample = {
  status: "done",
  summary: "Short completion summary",
  changedFiles: [],
  checks: [],
  artifacts: [],
  problems: [],
  actions: [
    {
      type: "createTasks",
      payload: {
        tasks: [
          {
            role: "worker",
            goal: "Optional next task goal",
            prompt: "Optional next task instructions",
            dependsOn: [],
            doneWhen: [],
          },
        ],
      },
    },
  ],
};

function requiredOutputForRole(role: string, taskConfig?: Record<string, unknown>): RequiredOutputExample {
  if (role !== "designer") {
    return DEFAULT_REQUIRED_OUTPUT;
  }
  const continuation = afterRecordSignalContinuation(taskConfig);
  const proposeDesign = proposeDesignActionExample(continuation?.signalId);
  if (continuation) {
    return {
      status: "done",
      summary: "Proposed one bounded design anchored to the recorded signal",
      changedFiles: [],
      checks: [],
      artifacts: [],
      problems: [],
      actions: [proposeDesign],
    };
  }
  return {
    status: "done",
    summary: "Short completion summary",
    changedFiles: [],
    checks: [],
    artifacts: [],
    problems: [],
    actions: [
      {
        type: "recordSignal",
        payload: {
          projectId: "<project_id>",
          signalClass: "delivery",
          source: "evidence source",
          title: "short signal title",
          summary: "what the evidence shows",
          observationTime: "2026-08-02T00:00:00Z",
          confidence: 0.5,
          evidence: [{ ref: "evidence reference", kind: "evidence-ref" }],
        },
      },
      proposeDesign,
      {
        type: "decideDesign",
        payload: {
          proposalId: "<proposal id>",
          decision: "rejected",
          reasons: ["why the proposal was rejected, deferred, retired, or revised"],
        },
      },
      {
        type: "recordDesignOutcome",
        payload: {
          proposalId: "<proposal id>",
          stage: "review",
          recommendation: "retain",
          baseline: { metric: 0 },
          observed: { metric: 1 },
          evidence: [{ runId: "<run id>" }],
        },
      },
      {
        type: "createRunsFromDesign",
        payload: {
          proposalId: "<accepted proposal id>",
          runs: [
            {
              goal: "delivery run goal",
              prompt: "initial planner prompt",
              doneWhen: ["verification checks"],
            },
          ],
        },
      },
    ],
  };
}

function proposeDesignActionExample(signalId = "signal_<id>"): Record<string, unknown> {
  return {
    type: "proposeDesign",
    payload: {
      projectId: "<project_id>",
      title: "short proposal title",
      charterId: "<optional charter id>",
      proposal: {
        problem: "demonstrated gap",
        recommendation: "recommended option",
        evidenceRefs: [signalId],
        options: [
          {
            name: "bounded alternative",
            benefits: ["expected benefit"],
            costs: ["maintenance cost"],
            risks: ["failure risk"],
            lockIn: ["migration or lock-in cost"],
          },
        ],
        additions: ["capability to add"],
        removals: ["complexity to remove"],
        targetOutcome: "measurable target outcome",
        assumptions: ["assumption to verify"],
        uncertainty: ["remaining uncertainty"],
        evaluationContract: {
          baseline: ["current behavior"],
          successMetrics: ["measurable outcome"],
          guardMetrics: ["guard metric"],
          requiredEvidence: ["verification evidence"],
          reviewAt: "2026-09-01T00:00:00Z",
        },
        investment: {
          reversibility: "easy",
          portfolio: "core",
          oneTimeCost: 0,
          recurringCost: 0,
          timeBudget: "bounded time budget",
        },
        experiment: {
          hypothesis: "testable hypothesis",
          smallestTest: "smallest bounded test",
          stopConditions: ["stop condition"],
          rollback: "remove experiment artifacts and restore the baseline",
        },
      },
      status: "proposed",
    },
  };
}

function afterRecordSignalContinuation(
  taskConfig: Record<string, unknown> | undefined,
): { signalId: string } | null {
  const continuation = taskConfig?.designContinuation;
  if (!continuation || typeof continuation !== "object" || Array.isArray(continuation)) {
    return null;
  }
  const record = continuation as Record<string, unknown>;
  if (record.kind !== "after-recordSignal") {
    return null;
  }
  return {
    signalId:
      typeof record.signalId === "string" && record.signalId.trim().length > 0
        ? record.signalId
        : "signal_<id>",
  };
}

type CompactLesson = ReturnType<typeof compactLessons>[number];

interface ActiveGuardrail {
  id: string;
  summary: string;
  source?: string;
}

function compactLessons(lessons: Lesson[]) {
  return lessons.slice(-MAX_PROMPT_LESSONS).map((lesson) => ({
    kind: lesson.kind,
    summary: compactText(lesson.summary, MAX_LESSON_SUMMARY_CHARS),
    taskId: lesson.taskId,
    attemptId: lesson.attemptId,
  }));
}

function renderCandidateGuardrails(lessons: CompactLesson[]) {
  const repeatedFailureGroups = repeatedLessonGroups(lessons);
  if (repeatedFailureGroups.length === 0) {
    return "";
  }

  return [
    "## Candidate Guardrails",
    "Candidate guardrail guidance derived from repeated failure lessons. Treat these as prompt-only candidates unless a later task explicitly accepts them as active guardrails.",
    "",
    ...repeatedFailureGroups.map(
      (group) =>
        `- Seen ${group.count} times: ${group.summary}\n  Use as a guardrail before execution and verification for this task.`,
    ),
    "",
  ].join("\n");
}

function renderActiveGuardrails(context: Record<string, unknown>, role: string) {
  const guardrails = activeGuardrailsForRole(context.guardrails, role);
  if (guardrails.length === 0) {
    return "";
  }

  return [
    "## Active Guardrails",
    "These guardrails are accepted for this run and role. Apply them before candidate lessons.",
    "",
    ...guardrails.map((guardrail) => {
      const source = guardrail.source ? ` (source: ${guardrail.source})` : "";
      return `- ${guardrail.id}: ${guardrail.summary}${source}`;
    }),
    "",
  ].join("\n");
}

function activeGuardrailsForRole(value: unknown, role: string): ActiveGuardrail[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => activeGuardrailFromValue(item, role))
    .filter((item): item is ActiveGuardrail => item !== null)
    .slice(-MAX_ACTIVE_GUARDRAILS);
}

function activeGuardrailFromValue(value: unknown, role: string): ActiveGuardrail | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.active === false) {
    return null;
  }
  if (!guardrailAppliesToRole(record, role)) {
    return null;
  }
  const summary = typeof record.summary === "string" ? compactText(record.summary, MAX_LESSON_SUMMARY_CHARS) : "";
  if (!summary) {
    return null;
  }
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "guardrail";
  const source = typeof record.source === "string" && record.source.trim() ? record.source.trim() : undefined;
  return { id, summary, source };
}

function guardrailAppliesToRole(record: Record<string, unknown>, role: string) {
  const roles = Array.isArray(record.roles)
    ? record.roles.filter((item): item is string => typeof item === "string")
    : typeof record.role === "string"
      ? [record.role]
      : [];
  return roles.length === 0 || roles.includes(role) || roles.includes("*");
}

function renderReusableExperienceEvidence(lessons: CompactLesson[]) {
  const experiences = lessons.filter((lesson) => lesson.kind === "experience");
  if (experiences.length === 0) {
    return "";
  }

  return [
    "## Reusable Experience Evidence",
    ...experiences.map((experience) => `- ${experience.summary} (source: ${experience.taskId} / ${experience.attemptId})`),
    "",
  ].join("\n");
}

function repeatedLessonGroups(lessons: CompactLesson[]) {
  const groups = new Map<string, { count: number; summary: string }>();
  for (const lesson of lessons) {
    if (lesson.kind !== "lesson") {
      continue;
    }

    const key = normalizedLessonSummary(lesson.summary);
    if (!key) {
      continue;
    }

    const group = groups.get(key);
    if (group) {
      group.count += 1;
    } else {
      groups.set(key, { count: 1, summary: lesson.summary });
    }
  }

  return Array.from(groups.values())
    .filter((group) => group.count >= 2)
    .sort((left, right) => right.count - left.count || left.summary.localeCompare(right.summary));
}

export function normalizedLessonSummary(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.;:!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(value: string, maxChars: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}
