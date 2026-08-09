import { createHash } from "node:crypto";
import { requireStrictIsoTimestamp } from "./iso-timestamp";
import type {
  DraftPromotionReceipt,
  EvolutionCausalHypothesis,
  EvolutionComparison,
  EvolutionDeliveryContracts,
  EpisodeCollectionContract,
  EvolutionCycleKind,
  EvolutionFirstCandidate,
  EvolutionInstance,
  EvolutionMode,
  EvolutionMutationLayer,
  EvolutionPackMaturity,
  EvolutionPackV1,
  EvolutionProfile,
  EvolutionRecordKind,
  EvolutionRuntimeMaturity,
  EvolutionSideEffectCounters,
  EvolutionTarget,
  HarnessVariant,
  MatchedExperiment,
  MaturityGateContract,
  ProductionEpisode,
  ProductionEpisodePrivacyReceiptContract,
  PromotionReceiptContract,
  RollbackContract,
} from "./types";

export const TARGET_EVOLUTION_LIMITS = Object.freeze({
  maxIdentifierLength: 256,
  maxTextLength: 4_000,
  maxArrayItems: 100,
  maxEvidenceRefsPerSplit: 200,
  maxSignalSources: 100,
  maxMutationSurfaces: 100,
  maxPathsPerSurface: 200,
  maxPathLength: 512,
  maxWallClockMs: 86_400_000,
  maxAttempts: 20,
  maxTokens: 2_000_000,
  maxConcurrency: 32,
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_SHORT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TYPED_OPAQUE_REF_PATTERN = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const SENSITIVE_REF_TEXT_PATTERN = /credential|authorization|bearer|token|secret|password|api[-_.]?key/i;
const GLOB_META_PATTERN = /[*?\[\]{}!]/;
const EVOLUTION_MODES = new Set<EvolutionMode>(["self", "design-target", "target-cycle"]);
const CYCLE_KINDS = new Set<EvolutionCycleKind>(["design", "bootstrap", "operate", "assess-handoff"]);
const SIGNAL_SOURCE_KINDS = new Set(["run-evidence", "repository", "external-ref", "domain-metric"] as const);
const EVOLUTION_TARGETS = new Set<EvolutionTarget>(["artifact", "harness", "model"]);
const MUTATION_LAYERS = new Set<EvolutionMutationLayer>(["artifact", "workflow", "prompt", "tool", "policy", "code"]);
const MUTATION_OWNERS = new Set(["ouroboros", "target"] as const);
const PACK_MATURITIES = new Set<EvolutionPackMaturity>(["designed", "instrumented", "shadowing", "autonomous", "retired"]);
const FAILURE_CLASSES = new Set<EvolutionCausalHypothesis["failureClass"]>([
  "environment",
  "control-lifecycle",
  "contract-mismatch",
  "agent-capability",
  "evaluation-defect",
  "domain-hypothesis",
]);
const REASONING_EFFORTS = new Set<EvolutionComparison["equalBudget"]["reasoningEffort"]>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const ARTIFACT_LAYERS = new Set<EvolutionMutationLayer>(["artifact", "code", "policy"]);
const HARNESS_LAYERS = new Set<EvolutionMutationLayer>(["workflow", "prompt", "tool", "policy", "code"]);
const FIRST_CANDIDATE_MODES = new Set<EvolutionFirstCandidate["mode"]>(["shadow"]);
const FIRST_CANDIDATE_TARGETS = new Set<EvolutionFirstCandidate["allowedEvolutionTargets"][number]>([
  "artifact",
  "harness",
]);
const HARNESS_VARIANT_ROLES = new Set<HarnessVariant["role"]>(["control", "candidate"]);
const HARNESS_VARIANT_TARGETS = new Set<HarnessVariant["evolutionTargets"][number]>([
  "artifact",
  "harness",
]);
const MATCHED_EXPERIMENT_OUTCOMES = new Set<MatchedExperiment["outcome"]>([
  "pending",
  "candidate_wins",
  "control_wins",
  "inconclusive",
  "invalid",
]);
const DATA_CLASSIFICATIONS = new Set<ProductionEpisode["privacyReview"]["dataClassification"]>([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
const EVOLUTION_RUNTIME_MATURITIES = new Set<EvolutionRuntimeMaturity>(["declared"]);
const PROMOTION_RECEIPT_ACTIONS = new Set<DraftPromotionReceipt["action"]>(["promote", "rollback"]);
const EVOLUTION_RECORD_KINDS = new Set<EvolutionRecordKind>([
  "profile",
  "episode",
  "variant",
  "experiment",
  "receipt",
]);
const SIDE_EFFECT_BUDGET_KEYS = [
  "paidUsd",
  "realProviderCalls",
  "pancatWrites",
  "productionPublishes",
  "realAssetDeletes",
  "crossProjectMemoryReads",
  "crossProjectMemoryWrites",
] as const satisfies ReadonlyArray<keyof EvolutionSideEffectCounters>;
const EPISODE_COLLECTION_SOURCES = new Set<EpisodeCollectionContract["allowedSources"][number]>([
  "host-owned-production-observation",
  "host-owned-fixture-replay",
]);
const REQUIRED_EPISODE_FIELDS = [
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
] as const satisfies EpisodeCollectionContract["requiredEpisodeFields"];
const MATURITY_STAGE_IDS = ["designed", "instrumented", "shadowing"] as const;
const MATURITY_STAGE_ID_SET = new Set<MaturityGateContract["stages"][number]["id"]>(MATURITY_STAGE_IDS);
const MATURITY_FAILURES = new Set<MaturityGateContract["stages"][number]["failureMaturity"]>([
  "designed",
  "instrumented",
]);
const REQUIRED_MATURITY_TRANSITIONS = [
  "designed->instrumented",
  "instrumented->shadowing",
] as const satisfies MaturityGateContract["allowedTransitions"];
const REQUIRED_FORBIDDEN_MATURITY_TRANSITIONS = [
  "designed->shadowing",
  "designed->autonomous",
  "instrumented->autonomous",
  "shadowing->autonomous",
] as const satisfies MaturityGateContract["forbiddenTransitions"];

export function parseEvolutionInstance(
  value: unknown,
  label = "evolutionInstance",
): EvolutionInstance {
  const record = strictObject(
    value,
    ["schemaVersion", "mode", "kernelProjectId", "targetProjectId", "cycle", "pack"],
    label,
  );
  requireSchemaVersion(record.schemaVersion, `${label}.schemaVersion`);
  const cycle = strictObject(record.cycle, ["kind", "index"], `${label}.cycle`);
  const pack = record.pack === undefined
    ? undefined
    : parseEvolutionInstancePack(record.pack, `${label}.pack`);

  return {
    schemaVersion: 1,
    mode: requireEnum(record.mode, EVOLUTION_MODES, `${label}.mode`),
    kernelProjectId: requireString(
      record.kernelProjectId,
      `${label}.kernelProjectId`,
      TARGET_EVOLUTION_LIMITS.maxIdentifierLength,
    ),
    targetProjectId: requireString(
      record.targetProjectId,
      `${label}.targetProjectId`,
      TARGET_EVOLUTION_LIMITS.maxIdentifierLength,
    ),
    cycle: {
      kind: requireEnum(cycle.kind, CYCLE_KINDS, `${label}.cycle.kind`),
      index: requireNonNegativeInteger(cycle.index, `${label}.cycle.index`),
    },
    ...(pack ? { pack } : {}),
  };
}

export function parseEvolutionPackV1(
  value: unknown,
  expectedProjectId: string,
  label = "evolutionPack",
): EvolutionPackV1 {
  requireString(
    expectedProjectId,
    `${label} expected projectId`,
    TARGET_EVOLUTION_LIMITS.maxIdentifierLength,
  );
  const record = strictObject(
    value,
    [
      "schemaVersion",
      "id",
      "targetSystemId",
      "version",
      "knowledgeScope",
      "objective",
      "observation",
      "mutationSurfaces",
      "experimentPolicy",
      "promotionPolicy",
      "handoff",
      "portability",
      "firstCandidate",
    ],
    label,
  );
  requireSchemaVersion(record.schemaVersion, `${label}.schemaVersion`);

  const knowledgeScope = requireString(
    record.knowledgeScope,
    `${label}.knowledgeScope`,
    TARGET_EVOLUTION_LIMITS.maxTextLength,
  );
  const expectedKnowledgeScope = `project:${expectedProjectId}` as const;
  if (knowledgeScope !== expectedKnowledgeScope) {
    throw new Error(`${label}.knowledgeScope must equal ${expectedKnowledgeScope}`);
  }

  const objective = strictObject(
    record.objective,
    ["charterId", "domainOutcomes", "nonGoals"],
    `${label}.objective`,
  );
  const observation = strictObject(record.observation, ["signalSources"], `${label}.observation`);
  const signalSources = requireArray(
    observation.signalSources,
    `${label}.observation.signalSources`,
    TARGET_EVOLUTION_LIMITS.maxSignalSources,
  ).map((source, index) =>
    parseSignalSource(source, `${label}.observation.signalSources[${index}]`),
  );
  requireNonEmpty(signalSources, `${label}.observation.signalSources`);
  requireUniqueIds(signalSources, `${label}.observation.signalSources`);

  const mutationSurfaces = requireArray(
    record.mutationSurfaces,
    `${label}.mutationSurfaces`,
    TARGET_EVOLUTION_LIMITS.maxMutationSurfaces,
  ).map((surface, index) =>
    parseMutationSurface(surface, expectedProjectId, `${label}.mutationSurfaces[${index}]`),
  );
  requireNonEmpty(mutationSurfaces, `${label}.mutationSurfaces`);
  requireUniqueIds(mutationSurfaces, `${label}.mutationSurfaces`);

  const experimentPolicy = strictObject(
    record.experimentPolicy,
    ["controlRequired", "holdoutRequired", "unrelatedRegressionRequired", "equalBudgetRequired", "maxCandidates"],
    `${label}.experimentPolicy`,
  );
  requireTrue(experimentPolicy.controlRequired, `${label}.experimentPolicy.controlRequired`);
  requireTrue(experimentPolicy.holdoutRequired, `${label}.experimentPolicy.holdoutRequired`);
  requireTrue(
    experimentPolicy.unrelatedRegressionRequired,
    `${label}.experimentPolicy.unrelatedRegressionRequired`,
  );
  requireTrue(experimentPolicy.equalBudgetRequired, `${label}.experimentPolicy.equalBudgetRequired`);
  const maxCandidates = requirePositiveInteger(
    experimentPolicy.maxCandidates,
    `${label}.experimentPolicy.maxCandidates`,
  );
  if (maxCandidates > 20) {
    throw new Error(`${label}.experimentPolicy.maxCandidates must be at most 20`);
  }

  const promotionPolicy = strictObject(
    record.promotionPolicy,
    ["guardMetrics", "observationWindow", "rollback"],
    `${label}.promotionPolicy`,
  );
  const handoff = strictObject(
    record.handoff,
    ["maturity", "targetOwner", "requiredCapabilities"],
    `${label}.handoff`,
  );
  const maturity = requireEnum(handoff.maturity, PACK_MATURITIES, `${label}.handoff.maturity`);
  if (maturity !== "designed") {
    throw new Error(`${label}.handoff.maturity must remain designed in milestone one`);
  }
  const portability = strictObject(
    record.portability,
    ["projectLocalRules", "genericizationEvidence"],
    `${label}.portability`,
  );
  const firstCandidate = record.firstCandidate === undefined
    ? undefined
    : parseFirstCandidate(record.firstCandidate, `${label}.firstCandidate`);

  return {
    schemaVersion: 1,
    id: requireString(record.id, `${label}.id`, TARGET_EVOLUTION_LIMITS.maxIdentifierLength),
    targetSystemId: requireString(
      record.targetSystemId,
      `${label}.targetSystemId`,
      TARGET_EVOLUTION_LIMITS.maxIdentifierLength,
    ),
    version: requirePositiveInteger(record.version, `${label}.version`),
    knowledgeScope: expectedKnowledgeScope,
    objective: {
      charterId: requireString(
        objective.charterId,
        `${label}.objective.charterId`,
        TARGET_EVOLUTION_LIMITS.maxIdentifierLength,
      ),
      domainOutcomes: requireNonEmptyStringArray(
        objective.domainOutcomes,
        `${label}.objective.domainOutcomes`,
        TARGET_EVOLUTION_LIMITS.maxArrayItems,
      ),
      nonGoals: requireNonEmptyStringArray(
        objective.nonGoals,
        `${label}.objective.nonGoals`,
        TARGET_EVOLUTION_LIMITS.maxArrayItems,
      ),
    },
    observation: { signalSources },
    mutationSurfaces,
    experimentPolicy: {
      controlRequired: true,
      holdoutRequired: true,
      unrelatedRegressionRequired: true,
      equalBudgetRequired: true,
      maxCandidates,
    },
    promotionPolicy: {
      guardMetrics: requireNonEmptyStringArray(
        promotionPolicy.guardMetrics,
        `${label}.promotionPolicy.guardMetrics`,
        TARGET_EVOLUTION_LIMITS.maxArrayItems,
      ),
      observationWindow: requireString(
        promotionPolicy.observationWindow,
        `${label}.promotionPolicy.observationWindow`,
        TARGET_EVOLUTION_LIMITS.maxTextLength,
      ),
      rollback: requireString(
        promotionPolicy.rollback,
        `${label}.promotionPolicy.rollback`,
        TARGET_EVOLUTION_LIMITS.maxTextLength,
      ),
    },
    handoff: {
      maturity,
      targetOwner: requireString(
        handoff.targetOwner,
        `${label}.handoff.targetOwner`,
        TARGET_EVOLUTION_LIMITS.maxIdentifierLength,
      ),
      requiredCapabilities: requireNonEmptyStringArray(
        handoff.requiredCapabilities,
        `${label}.handoff.requiredCapabilities`,
        TARGET_EVOLUTION_LIMITS.maxArrayItems,
      ),
    },
    portability: {
      projectLocalRules: requireNonEmptyStringArray(
        portability.projectLocalRules,
        `${label}.portability.projectLocalRules`,
        TARGET_EVOLUTION_LIMITS.maxArrayItems,
      ),
      genericizationEvidence: requireOpaqueRefArray(
        portability.genericizationEvidence,
        `${label}.portability.genericizationEvidence`,
        TARGET_EVOLUTION_LIMITS.maxArrayItems,
      ),
    },
    ...(firstCandidate === undefined ? {} : { firstCandidate }),
  };
}

export function parseEvolutionCausalHypothesis(
  value: unknown,
  label = "causalHypothesis",
): EvolutionCausalHypothesis {
  const record = strictObject(
    value,
    ["failureClass", "mechanism", "predictedEffects", "disconfirmingEvidence"],
    label,
  );
  return {
    failureClass: requireEnum(record.failureClass, FAILURE_CLASSES, `${label}.failureClass`),
    mechanism: requireString(
      record.mechanism,
      `${label}.mechanism`,
      TARGET_EVOLUTION_LIMITS.maxTextLength,
    ),
    predictedEffects: requireNonEmptyStringArray(
      record.predictedEffects,
      `${label}.predictedEffects`,
      TARGET_EVOLUTION_LIMITS.maxArrayItems,
    ),
    disconfirmingEvidence: requireNonEmptyStringArray(
      record.disconfirmingEvidence,
      `${label}.disconfirmingEvidence`,
      TARGET_EVOLUTION_LIMITS.maxArrayItems,
    ),
  };
}

export function parseEvolutionComparison(
  value: unknown,
  label = "comparison",
): EvolutionComparison {
  const record = strictObject(
    value,
    [
      "controlRef",
      "developmentEvidenceRefs",
      "holdoutEvidenceRefs",
      "unrelatedEvidenceRefs",
      "corpusSnapshotSha256",
      "equalBudget",
      "primaryMetric",
      "minimumUplift",
      "maximumGuardRegression",
    ],
    label,
  );
  const developmentEvidenceRefs = requireNonEmptyOpaqueRefArray(
    record.developmentEvidenceRefs,
    `${label}.developmentEvidenceRefs`,
    TARGET_EVOLUTION_LIMITS.maxEvidenceRefsPerSplit,
  );
  const holdoutEvidenceRefs = requireNonEmptyOpaqueRefArray(
    record.holdoutEvidenceRefs,
    `${label}.holdoutEvidenceRefs`,
    TARGET_EVOLUTION_LIMITS.maxEvidenceRefsPerSplit,
  );
  const unrelatedEvidenceRefs = requireNonEmptyOpaqueRefArray(
    record.unrelatedEvidenceRefs,
    `${label}.unrelatedEvidenceRefs`,
    TARGET_EVOLUTION_LIMITS.maxEvidenceRefsPerSplit,
  );
  requireGloballyUniqueEvidence(
    [developmentEvidenceRefs, holdoutEvidenceRefs, unrelatedEvidenceRefs],
    label,
  );

  const equalBudget = parseEvolutionEqualBudget(record.equalBudget, `${label}.equalBudget`);

  return {
    controlRef: requireOpaqueRef(
      record.controlRef,
      `${label}.controlRef`,
    ),
    developmentEvidenceRefs,
    holdoutEvidenceRefs,
    unrelatedEvidenceRefs,
    corpusSnapshotSha256: requireSha256(
      record.corpusSnapshotSha256,
      `${label}.corpusSnapshotSha256`,
    ),
    equalBudget,
    primaryMetric: requireString(
      record.primaryMetric,
      `${label}.primaryMetric`,
      TARGET_EVOLUTION_LIMITS.maxTextLength,
    ),
    minimumUplift: requireNonNegativeFinite(record.minimumUplift, `${label}.minimumUplift`),
    maximumGuardRegression: requireNonNegativeFinite(
      record.maximumGuardRegression,
      `${label}.maximumGuardRegression`,
    ),
  };
}

export function parseEpisodeCollectionContract(
  value: unknown,
  expectedProjectId: string,
  label = "episodeCollectionContract",
): EpisodeCollectionContract {
  const record = strictObject(value, [
    "schemaVersion",
    "id",
    "projectId",
    "mode",
    "allowedSources",
    "requiredEpisodeFields",
    "privacyReceiptContractRef",
    "appendOnly",
    "rawPayloadPolicy",
    "sideEffectBudget",
  ], label);
  requireSchemaVersion(record.schemaVersion, `${label}.schemaVersion`);
  const allowedSources = requireArray(
    record.allowedSources,
    `${label}.allowedSources`,
    EPISODE_COLLECTION_SOURCES.size,
  ).map((entry, index) => requireEnum(
    entry,
    EPISODE_COLLECTION_SOURCES,
    `${label}.allowedSources[${index}]`,
  ));
  requireNonEmpty(allowedSources, `${label}.allowedSources`);
  requireUniqueStrings(allowedSources, `${label}.allowedSources`);
  const requiredEpisodeFields = requireExactStringSet(
    record.requiredEpisodeFields,
    REQUIRED_EPISODE_FIELDS,
    `${label}.requiredEpisodeFields`,
  ) as EpisodeCollectionContract["requiredEpisodeFields"];
  requireTrue(record.appendOnly, `${label}.appendOnly`);
  if (record.mode !== "commitment-only") {
    throw new Error(`${label}.mode must be commitment-only`);
  }
  if (record.rawPayloadPolicy !== "reject") {
    throw new Error(`${label}.rawPayloadPolicy must be reject`);
  }
  return {
    schemaVersion: 1,
    id: requireSafeShortIdentifier(record.id, `${label}.id`),
    projectId: requireExpectedProjectId(record.projectId, expectedProjectId, label),
    mode: "commitment-only",
    allowedSources,
    requiredEpisodeFields,
    privacyReceiptContractRef: requireSafeShortIdentifier(
      record.privacyReceiptContractRef,
      `${label}.privacyReceiptContractRef`,
    ),
    appendOnly: true,
    rawPayloadPolicy: "reject",
    sideEffectBudget: parseEvolutionSideEffectCounters(
      record.sideEffectBudget,
      true,
      `${label}.sideEffectBudget`,
    ),
  };
}

export function parseMaturityGateContract(
  value: unknown,
  expectedProjectId: string,
  expectedPack: EvolutionPackV1,
  label = "maturityGateContract",
): MaturityGateContract {
  const record = strictObject(value, [
    "schemaVersion",
    "id",
    "projectId",
    "packRef",
    "currentMaturity",
    "allowedTransitions",
    "forbiddenTransitions",
    "requireIndependentReceiptForEveryTransition",
    "stages",
  ], label);
  requireSchemaVersion(record.schemaVersion, `${label}.schemaVersion`);
  const packRef = strictObject(record.packRef, ["id", "version", "contentSha256"], `${label}.packRef`);
  const normalizedPackRef = {
    id: requireSafeShortIdentifier(packRef.id, `${label}.packRef.id`),
    version: requirePositiveInteger(packRef.version, `${label}.packRef.version`),
    contentSha256: requireSha256(packRef.contentSha256, `${label}.packRef.contentSha256`),
  };
  const expectedPackSha256 = canonicalEvolutionValueSha256(expectedPack);
  if (
    normalizedPackRef.id !== expectedPack.id
    || normalizedPackRef.version !== expectedPack.version
    || normalizedPackRef.contentSha256 !== expectedPackSha256
  ) {
    throw new Error(`${label}.packRef must exactly bind the normalized evolutionPack`);
  }
  if (record.currentMaturity !== "designed") {
    throw new Error(`${label}.currentMaturity must remain designed`);
  }
  const allowedTransitions = requireExactOrderedStrings(
    record.allowedTransitions,
    REQUIRED_MATURITY_TRANSITIONS,
    `${label}.allowedTransitions`,
  ) as MaturityGateContract["allowedTransitions"];
  const forbiddenTransitions = requireExactStringSet(
    record.forbiddenTransitions,
    REQUIRED_FORBIDDEN_MATURITY_TRANSITIONS,
    `${label}.forbiddenTransitions`,
  ) as MaturityGateContract["forbiddenTransitions"];
  requireTrue(
    record.requireIndependentReceiptForEveryTransition,
    `${label}.requireIndependentReceiptForEveryTransition`,
  );
  const stages = requireArray(record.stages, `${label}.stages`, MATURITY_STAGE_IDS.length).map(
    (entry, index) => {
      const stageLabel = `${label}.stages[${index}]`;
      const stage = strictObject(entry, [
        "id",
        "requiredEvidenceRefs",
        "guardMetrics",
        "allowedOperations",
        "failureMaturity",
      ], stageLabel);
      return {
        id: requireEnum(stage.id, MATURITY_STAGE_ID_SET, `${stageLabel}.id`),
        requiredEvidenceRefs: requireEvidenceRefs(stage.requiredEvidenceRefs, `${stageLabel}.requiredEvidenceRefs`),
        guardMetrics: requireUniqueNonEmptyStringArray(
          stage.guardMetrics,
          `${stageLabel}.guardMetrics`,
          TARGET_EVOLUTION_LIMITS.maxArrayItems,
        ).map((item, itemIndex) => requireNonSensitiveText(
          item,
          `${stageLabel}.guardMetrics[${itemIndex}]`,
        )),
        allowedOperations: requireUniqueNonEmptyStringArray(
          stage.allowedOperations,
          `${stageLabel}.allowedOperations`,
          TARGET_EVOLUTION_LIMITS.maxArrayItems,
        ).map((item, itemIndex) => requireNonSensitiveText(
          item,
          `${stageLabel}.allowedOperations[${itemIndex}]`,
        )),
        failureMaturity: requireEnum(stage.failureMaturity, MATURITY_FAILURES, `${stageLabel}.failureMaturity`),
      };
    },
  );
  if (
    stages.length !== MATURITY_STAGE_IDS.length
    || stages.some((stage, index) => stage.id !== MATURITY_STAGE_IDS[index])
  ) {
    throw new Error(`${label}.stages must contain designed, instrumented, and shadowing in order`);
  }
  const expectedFailureMaturities = ["designed", "designed", "instrumented"] as const;
  if (stages.some((stage, index) => stage.failureMaturity !== expectedFailureMaturities[index])) {
    throw new Error(`${label}.stages failureMaturity must fail closed to the preceding verified maturity`);
  }
  return {
    schemaVersion: 1,
    id: requireSafeShortIdentifier(record.id, `${label}.id`),
    projectId: requireExpectedProjectId(record.projectId, expectedProjectId, label),
    packRef: normalizedPackRef,
    currentMaturity: "designed",
    allowedTransitions,
    forbiddenTransitions,
    requireIndependentReceiptForEveryTransition: true,
    stages,
  };
}

export function parseProductionEpisodePrivacyReceiptContract(
  value: unknown,
  expectedProjectId: string,
  label = "productionEpisodePrivacyReceiptContract",
): ProductionEpisodePrivacyReceiptContract {
  const record = strictObject(value, [
    "schemaVersion",
    "id",
    "projectId",
    "mode",
    "privacyReview",
    "snapshotBinding",
    "rawPayloadPolicy",
    "appendOnly",
    "rejectionConditions",
  ], label);
  requireSchemaVersion(record.schemaVersion, `${label}.schemaVersion`);
  const privacyReview = strictObject(record.privacyReview, [
    "requiredStatus",
    "policySha256",
    "reviewerRef",
    "dataClassification",
    "retentionPolicyRef",
    "evidenceRefs",
  ], `${label}.privacyReview`);
  if (record.mode !== "requirements-only") {
    throw new Error(`${label}.mode must be requirements-only`);
  }
  if (privacyReview.requiredStatus !== "approved") {
    throw new Error(`${label}.privacyReview.requiredStatus must be approved`);
  }
  const snapshotBinding = strictObject(record.snapshotBinding, [
    "inputSnapshotSha256Required",
    "outcomeSnapshotSha256Required",
    "mustMatchEpisode",
  ], `${label}.snapshotBinding`);
  requireTrue(snapshotBinding.inputSnapshotSha256Required, `${label}.snapshotBinding.inputSnapshotSha256Required`);
  requireTrue(snapshotBinding.outcomeSnapshotSha256Required, `${label}.snapshotBinding.outcomeSnapshotSha256Required`);
  requireTrue(snapshotBinding.mustMatchEpisode, `${label}.snapshotBinding.mustMatchEpisode`);
  if (record.rawPayloadPolicy !== "reject") {
    throw new Error(`${label}.rawPayloadPolicy must be reject`);
  }
  requireTrue(record.appendOnly, `${label}.appendOnly`);
  return {
    schemaVersion: 1,
    id: requireSafeShortIdentifier(record.id, `${label}.id`),
    projectId: requireExpectedProjectId(record.projectId, expectedProjectId, label),
    mode: "requirements-only",
    privacyReview: {
      requiredStatus: "approved",
      policySha256: requireSha256(privacyReview.policySha256, `${label}.privacyReview.policySha256`),
      reviewerRef: requireOpaqueRef(privacyReview.reviewerRef, `${label}.privacyReview.reviewerRef`),
      dataClassification: requireEnum(
        privacyReview.dataClassification,
        DATA_CLASSIFICATIONS,
        `${label}.privacyReview.dataClassification`,
      ),
      retentionPolicyRef: requireOpaqueRef(
        privacyReview.retentionPolicyRef,
        `${label}.privacyReview.retentionPolicyRef`,
      ),
      evidenceRefs: requireEvidenceRefs(privacyReview.evidenceRefs, `${label}.privacyReview.evidenceRefs`),
    },
    snapshotBinding: {
      inputSnapshotSha256Required: true,
      outcomeSnapshotSha256Required: true,
      mustMatchEpisode: true,
    },
    rawPayloadPolicy: "reject",
    appendOnly: true,
    rejectionConditions: requireUniqueNonEmptyStringArray(
      record.rejectionConditions,
      `${label}.rejectionConditions`,
      TARGET_EVOLUTION_LIMITS.maxArrayItems,
    ).map((item, index) => requireNonSensitiveText(
      item,
      `${label}.rejectionConditions[${index}]`,
    )),
  };
}

export function parsePromotionReceiptContract(
  value: unknown,
  expectedProjectId: string,
  label = "promotionReceiptContract",
): PromotionReceiptContract {
  const record = strictObject(value, [
    "schemaVersion",
    "id",
    "mode",
    "projectId",
    "authorizedDecisionRef",
    "fromVariantId",
    "toVariantId",
    "exactTargetRef",
    "readbackEvidenceRefs",
    "canaryEvidenceRefs",
    "observationWindow",
    "rollbackPlanRef",
    "rollbackReceiptId",
    "issuerRef",
    "issuedAtRequired",
  ], label);
  requireSchemaVersion(record.schemaVersion, `${label}.schemaVersion`);
  if (record.mode !== "draft-only") {
    throw new Error(`${label}.mode must be draft-only`);
  }
  const fromVariantId = requireEvolutionRecordRef(record.fromVariantId, "variant", `${label}.fromVariantId`);
  const toVariantId = requireEvolutionRecordRef(record.toVariantId, "variant", `${label}.toVariantId`);
  if (fromVariantId === toVariantId) {
    throw new Error(`${label}.fromVariantId and ${label}.toVariantId must be different`);
  }
  const observationWindow = strictObject(
    record.observationWindow,
    ["matchedRuns", "startsAfterMaturity"],
    `${label}.observationWindow`,
  );
  if (observationWindow.startsAfterMaturity !== "instrumented") {
    throw new Error(`${label}.observationWindow.startsAfterMaturity must be instrumented`);
  }
  requireTrue(record.issuedAtRequired, `${label}.issuedAtRequired`);
  return {
    schemaVersion: 1,
    id: requireSafeShortIdentifier(record.id, `${label}.id`),
    mode: "draft-only",
    projectId: requireExpectedProjectId(record.projectId, expectedProjectId, label),
    authorizedDecisionRef: requireOpaqueRef(record.authorizedDecisionRef, `${label}.authorizedDecisionRef`),
    fromVariantId,
    toVariantId,
    exactTargetRef: requireExactEvolutionRef(record.exactTargetRef, `${label}.exactTargetRef`),
    readbackEvidenceRefs: requireEvidenceRefs(record.readbackEvidenceRefs, `${label}.readbackEvidenceRefs`),
    canaryEvidenceRefs: requireEvidenceRefs(record.canaryEvidenceRefs, `${label}.canaryEvidenceRefs`),
    observationWindow: {
      matchedRuns: requirePositiveInteger(observationWindow.matchedRuns, `${label}.observationWindow.matchedRuns`),
      startsAfterMaturity: "instrumented",
    },
    rollbackPlanRef: requireExactEvolutionRef(record.rollbackPlanRef, `${label}.rollbackPlanRef`),
    rollbackReceiptId: requireNullableEvolutionRecordRef(
      record.rollbackReceiptId,
      "receipt",
      `${label}.rollbackReceiptId`,
    ),
    issuerRef: requireOpaqueRef(record.issuerRef, `${label}.issuerRef`),
    issuedAtRequired: true,
  };
}

export function parseRollbackContract(
  value: unknown,
  expectedProjectId: string,
  label = "rollbackContract",
): RollbackContract {
  const record = strictObject(value, [
    "schemaVersion",
    "id",
    "projectId",
    "exactTargetRef",
    "lastKnownGoodRef",
    "idempotencyKey",
    "rollbackPlanRef",
    "rollbackReceiptId",
    "triggers",
    "readbackEvidenceRefs",
    "canaryEvidenceRefs",
    "appendOnly",
    "deleteOrRewriteHistory",
    "forbiddenScopes",
  ], label);
  requireSchemaVersion(record.schemaVersion, `${label}.schemaVersion`);
  requireTrue(record.appendOnly, `${label}.appendOnly`);
  if (record.deleteOrRewriteHistory !== false) {
    throw new Error(`${label}.deleteOrRewriteHistory must be false`);
  }
  const triggers = requireArray(record.triggers, `${label}.triggers`, TARGET_EVOLUTION_LIMITS.maxArrayItems).map(
    (entry, index) => {
      const triggerLabel = `${label}.triggers[${index}]`;
      const trigger = strictObject(entry, ["id", "condition"], triggerLabel);
      return {
        id: requireSafeShortIdentifier(trigger.id, `${triggerLabel}.id`),
        condition: requireNonSensitiveText(trigger.condition, `${triggerLabel}.condition`),
      };
    },
  );
  requireNonEmpty(triggers, `${label}.triggers`);
  requireUniqueIds(triggers, `${label}.triggers`);
  return {
    schemaVersion: 1,
    id: requireSafeShortIdentifier(record.id, `${label}.id`),
    projectId: requireExpectedProjectId(record.projectId, expectedProjectId, label),
    exactTargetRef: requireExactEvolutionRef(record.exactTargetRef, `${label}.exactTargetRef`),
    lastKnownGoodRef: requireExactEvolutionRef(record.lastKnownGoodRef, `${label}.lastKnownGoodRef`),
    idempotencyKey: requireExactEvolutionRef(record.idempotencyKey, `${label}.idempotencyKey`),
    rollbackPlanRef: requireExactEvolutionRef(record.rollbackPlanRef, `${label}.rollbackPlanRef`),
    rollbackReceiptId: requireNullableEvolutionRecordRef(
      record.rollbackReceiptId,
      "receipt",
      `${label}.rollbackReceiptId`,
    ),
    triggers,
    readbackEvidenceRefs: requireEvidenceRefs(record.readbackEvidenceRefs, `${label}.readbackEvidenceRefs`),
    canaryEvidenceRefs: requireEvidenceRefs(record.canaryEvidenceRefs, `${label}.canaryEvidenceRefs`),
    appendOnly: true,
    deleteOrRewriteHistory: false,
    forbiddenScopes: requireUniqueNonEmptyStringArray(
      record.forbiddenScopes,
      `${label}.forbiddenScopes`,
      TARGET_EVOLUTION_LIMITS.maxArrayItems,
    ).map((item, index) => requireNonSensitiveText(
      item,
      `${label}.forbiddenScopes[${index}]`,
    )),
  };
}

export function parseEvolutionDeliveryContracts(
  value: unknown,
  expectedProjectId: string,
  expectedPack: EvolutionPackV1,
  label = "target evolution proposal",
): EvolutionDeliveryContracts | null {
  const record = requirePlainJsonObject(value, label);
  const keys = [
    "episodeCollectionContract",
    "maturityGateContract",
    "productionEpisodePrivacyReceiptContract",
    "promotionReceiptContract",
    "rollbackContract",
  ] as const;
  const present = keys.filter((key) => record[key] !== undefined);
  if (
    (present.length > 0 && present.length < keys.length)
    || (expectedPack.version >= 4 && present.length !== keys.length)
  ) {
    throw new Error(
      `${label} delivery contracts must include episodeCollectionContract, maturityGateContract, productionEpisodePrivacyReceiptContract, promotionReceiptContract, and rollbackContract as one complete group`,
    );
  }
  if (present.length === 0) {
    return null;
  }
  const contracts: EvolutionDeliveryContracts = {
    episodeCollectionContract: parseEpisodeCollectionContract(
      record.episodeCollectionContract,
      expectedProjectId,
      `${label}.episodeCollectionContract`,
    ),
    maturityGateContract: parseMaturityGateContract(
      record.maturityGateContract,
      expectedProjectId,
      expectedPack,
      `${label}.maturityGateContract`,
    ),
    productionEpisodePrivacyReceiptContract: parseProductionEpisodePrivacyReceiptContract(
      record.productionEpisodePrivacyReceiptContract,
      expectedProjectId,
      `${label}.productionEpisodePrivacyReceiptContract`,
    ),
    promotionReceiptContract: parsePromotionReceiptContract(
      record.promotionReceiptContract,
      expectedProjectId,
      `${label}.promotionReceiptContract`,
    ),
    rollbackContract: parseRollbackContract(
      record.rollbackContract,
      expectedProjectId,
      `${label}.rollbackContract`,
    ),
  };
  if (
    contracts.episodeCollectionContract.privacyReceiptContractRef
    !== contracts.productionEpisodePrivacyReceiptContract.id
  ) {
    throw new Error(`${label}.episodeCollectionContract.privacyReceiptContractRef must equal productionEpisodePrivacyReceiptContract.id`);
  }
  if (contracts.promotionReceiptContract.exactTargetRef !== contracts.rollbackContract.exactTargetRef) {
    throw new Error(`${label} promotionReceiptContract and rollbackContract must bind the same exactTargetRef`);
  }
  if (contracts.promotionReceiptContract.rollbackPlanRef !== contracts.rollbackContract.rollbackPlanRef) {
    throw new Error(`${label} promotionReceiptContract and rollbackContract must bind the same rollbackPlanRef`);
  }
  if (contracts.promotionReceiptContract.rollbackReceiptId !== contracts.rollbackContract.rollbackReceiptId) {
    throw new Error(`${label} promotionReceiptContract and rollbackContract must bind the same rollbackReceiptId`);
  }
  if (contracts.rollbackContract.lastKnownGoodRef === contracts.rollbackContract.exactTargetRef) {
    throw new Error(`${label}.rollbackContract.lastKnownGoodRef must differ from exactTargetRef`);
  }
  return contracts;
}

export function canonicalEvolutionValueSha256(value: unknown): string {
  const canonical = canonicalEvolutionValue(value, "evolution value", new Set<object>());
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function canonicalEvolutionRecordSha256(value: unknown): string {
  const record = requirePlainJsonObject(value, "evolution record");
  const { id: _ignored, ...recordWithoutId } = record;
  return canonicalEvolutionValueSha256(recordWithoutId);
}

export function expectedEvolutionRecordId(
  kind: EvolutionRecordKind,
  value: unknown,
): string {
  const parsedKind = requireEnum(kind, EVOLUTION_RECORD_KINDS, "evolution record kind");
  return `${parsedKind}_${canonicalEvolutionRecordSha256(value)}`;
}

export function parseEvolutionProfile(
  value: unknown,
  expectedProjectId: string,
  label = "evolutionProfile",
): EvolutionProfile {
  const record = strictObject(
    value,
    [
      "schemaVersion",
      "id",
      "projectId",
      "pack",
      "charter",
      "runtimeMaturity",
      "allowedSurfaceIds",
      "registeredAt",
    ],
    label,
  );
  requireSchemaVersion(record.schemaVersion, `${label}.schemaVersion`);
  const normalized: EvolutionProfile = {
    schemaVersion: 1,
    id: requireString(record.id, `${label}.id`, TARGET_EVOLUTION_LIMITS.maxIdentifierLength),
    projectId: requireExpectedProjectId(record.projectId, expectedProjectId, label),
    pack: parseVersionedContentRef(record.pack, `${label}.pack`),
    charter: parseVersionedContentRef(record.charter, `${label}.charter`),
    runtimeMaturity: requireEnum(
      record.runtimeMaturity,
      EVOLUTION_RUNTIME_MATURITIES,
      `${label}.runtimeMaturity`,
    ),
    allowedSurfaceIds: requireUniqueNonEmptyStringArray(
      record.allowedSurfaceIds,
      `${label}.allowedSurfaceIds`,
      TARGET_EVOLUTION_LIMITS.maxMutationSurfaces,
      TARGET_EVOLUTION_LIMITS.maxIdentifierLength,
    ),
    registeredAt: requireEvolutionTimestamp(record.registeredAt, `${label}.registeredAt`),
  };
  requireMatchingEvolutionRecordId("profile", normalized, label);
  return normalized;
}

export function parseProductionEpisode(
  value: unknown,
  expectedProjectId: string,
  label = "productionEpisode",
): ProductionEpisode {
  const record = strictObject(
    value,
    [
      "schemaVersion",
      "id",
      "projectId",
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
    label,
  );
  requireSchemaVersion(record.schemaVersion, `${label}.schemaVersion`);
  const inputSnapshotSha256 = requireSha256(
    record.inputSnapshotSha256,
    `${label}.inputSnapshotSha256`,
  );
  const outcomeSnapshotSha256 = requireSha256(
    record.outcomeSnapshotSha256,
    `${label}.outcomeSnapshotSha256`,
  );
  const privacyReview = parseProductionEpisodePrivacyReview(
    record.privacyReview,
    inputSnapshotSha256,
    outcomeSnapshotSha256,
    `${label}.privacyReview`,
  );
  const normalized: ProductionEpisode = {
    schemaVersion: 1,
    id: requireString(record.id, `${label}.id`, TARGET_EVOLUTION_LIMITS.maxIdentifierLength),
    projectId: requireExpectedProjectId(record.projectId, expectedProjectId, label),
    profileId: requireEvolutionRecordRef(record.profileId, "profile", `${label}.profileId`),
    sourceRef: requireOpaqueRef(record.sourceRef, `${label}.sourceRef`),
    leakageGroupId: requireOpaqueRef(
      record.leakageGroupId,
      `${label}.leakageGroupId`,
    ),
    observedAt: requireEvolutionTimestamp(record.observedAt, `${label}.observedAt`),
    inputSnapshotSha256,
    outcomeSnapshotSha256,
    policyRef: requireOpaqueRef(record.policyRef, `${label}.policyRef`),
    metrics: parseFiniteMetrics(record.metrics, `${label}.metrics`),
    sideEffectCounters: parseEvolutionSideEffectCounters(
      record.sideEffectCounters,
      false,
      `${label}.sideEffectCounters`,
    ),
    evidenceRefs: requireEvidenceRefs(record.evidenceRefs, `${label}.evidenceRefs`),
    privacyReview,
  };
  requireMatchingEvolutionRecordId("episode", normalized, label);
  return normalized;
}

export function parseHarnessVariant(
  value: unknown,
  expectedProjectId: string,
  label = "harnessVariant",
): HarnessVariant {
  const record = strictObject(
    value,
    [
      "schemaVersion",
      "id",
      "projectId",
      "profileId",
      "role",
      "evolutionTargets",
      "contentSha256",
      "mutationSurfaceIds",
      "changedPaths",
      "toolPolicySha256",
      "createdFromEvidenceRefs",
    ],
    label,
  );
  requireSchemaVersion(record.schemaVersion, `${label}.schemaVersion`);
  const evolutionTargets = requireArray(
    record.evolutionTargets,
    `${label}.evolutionTargets`,
    TARGET_EVOLUTION_LIMITS.maxArrayItems,
  ).map((target, index) =>
    requireEnum(target, HARNESS_VARIANT_TARGETS, `${label}.evolutionTargets[${index}]`),
  );
  requireNonEmpty(evolutionTargets, `${label}.evolutionTargets`);
  requireUniqueStrings(evolutionTargets, `${label}.evolutionTargets`);
  const normalized: HarnessVariant = {
    schemaVersion: 1,
    id: requireString(record.id, `${label}.id`, TARGET_EVOLUTION_LIMITS.maxIdentifierLength),
    projectId: requireExpectedProjectId(record.projectId, expectedProjectId, label),
    profileId: requireEvolutionRecordRef(record.profileId, "profile", `${label}.profileId`),
    role: requireEnum(record.role, HARNESS_VARIANT_ROLES, `${label}.role`),
    evolutionTargets,
    contentSha256: requireSha256(record.contentSha256, `${label}.contentSha256`),
    mutationSurfaceIds: requireUniqueNonEmptyStringArray(
      record.mutationSurfaceIds,
      `${label}.mutationSurfaceIds`,
      TARGET_EVOLUTION_LIMITS.maxMutationSurfaces,
      TARGET_EVOLUTION_LIMITS.maxIdentifierLength,
    ),
    changedPaths: requireUniqueExactProjectRelativePaths(record.changedPaths, `${label}.changedPaths`),
    toolPolicySha256: requireSha256(record.toolPolicySha256, `${label}.toolPolicySha256`),
    createdFromEvidenceRefs: requireEvidenceRefs(
      record.createdFromEvidenceRefs,
      `${label}.createdFromEvidenceRefs`,
    ),
  };
  requireMatchingEvolutionRecordId("variant", normalized, label);
  return normalized;
}

export function parseMatchedExperiment(
  value: unknown,
  expectedProjectId: string,
  label = "matchedExperiment",
): MatchedExperiment {
  const record = strictObject(
    value,
    [
      "schemaVersion",
      "id",
      "projectId",
      "profileId",
      "controlVariantId",
      "candidateVariantId",
      "developmentEpisodeRefs",
      "heldoutEpisodeRefs",
      "unrelatedEpisodeRefs",
      "corpusSnapshotSha256",
      "equalBudget",
      "primaryMetric",
      "guardMetrics",
      "sideEffectCounters",
      "outcome",
      "evidenceRefs",
    ],
    label,
  );
  requireSchemaVersion(record.schemaVersion, `${label}.schemaVersion`);
  const controlVariantId = requireEvolutionRecordRef(
    record.controlVariantId,
    "variant",
    `${label}.controlVariantId`,
  );
  const candidateVariantId = requireEvolutionRecordRef(
    record.candidateVariantId,
    "variant",
    `${label}.candidateVariantId`,
  );
  if (controlVariantId === candidateVariantId) {
    throw new Error(`${label}.controlVariantId and ${label}.candidateVariantId must be different`);
  }
  const developmentEpisodeRefs = requireEvolutionRecordRefs(
    record.developmentEpisodeRefs,
    "episode",
    `${label}.developmentEpisodeRefs`,
  );
  const heldoutEpisodeRefs = requireEvolutionRecordRefs(
    record.heldoutEpisodeRefs,
    "episode",
    `${label}.heldoutEpisodeRefs`,
  );
  const unrelatedEpisodeRefs = requireEvolutionRecordRefs(
    record.unrelatedEpisodeRefs,
    "episode",
    `${label}.unrelatedEpisodeRefs`,
  );
  requireGloballyUniqueEvidence(
    [developmentEpisodeRefs, heldoutEpisodeRefs, unrelatedEpisodeRefs],
    label,
  );
  const normalized: MatchedExperiment = {
    schemaVersion: 1,
    id: requireString(record.id, `${label}.id`, TARGET_EVOLUTION_LIMITS.maxIdentifierLength),
    projectId: requireExpectedProjectId(record.projectId, expectedProjectId, label),
    profileId: requireEvolutionRecordRef(record.profileId, "profile", `${label}.profileId`),
    controlVariantId,
    candidateVariantId,
    developmentEpisodeRefs,
    heldoutEpisodeRefs,
    unrelatedEpisodeRefs,
    corpusSnapshotSha256: requireSha256(
      record.corpusSnapshotSha256,
      `${label}.corpusSnapshotSha256`,
    ),
    equalBudget: parseEvolutionEqualBudget(record.equalBudget, `${label}.equalBudget`),
    primaryMetric: requireString(
      record.primaryMetric,
      `${label}.primaryMetric`,
      TARGET_EVOLUTION_LIMITS.maxTextLength,
    ),
    guardMetrics: requireUniqueNonEmptyStringArray(
      record.guardMetrics,
      `${label}.guardMetrics`,
      TARGET_EVOLUTION_LIMITS.maxArrayItems,
    ),
    sideEffectCounters: parseEvolutionSideEffectCounters(
      record.sideEffectCounters,
      true,
      `${label}.sideEffectCounters`,
    ),
    outcome: requireEnum(record.outcome, MATCHED_EXPERIMENT_OUTCOMES, `${label}.outcome`),
    evidenceRefs: requireEvidenceRefs(record.evidenceRefs, `${label}.evidenceRefs`),
  };
  requireMatchingEvolutionRecordId("experiment", normalized, label);
  return normalized;
}

/** @internal Draft evidence parser only. No promotion execution chain exists. */
export function parseDraftPromotionReceipt(
  value: unknown,
  expectedProjectId: string,
  label = "draftPromotionReceipt",
): DraftPromotionReceipt {
  const record = strictObject(
    value,
    [
      "schemaVersion",
      "id",
      "projectId",
      "profileId",
      "experimentId",
      "action",
      "fromVariantId",
      "toVariantId",
      "authorizedDecisionRef",
      "appliedAt",
      "exactTargetRef",
      "readbackEvidenceRefs",
      "canaryEvidenceRefs",
      "rollbackPlanRef",
      "rollbackReceiptId",
    ],
    label,
  );
  requireSchemaVersion(record.schemaVersion, `${label}.schemaVersion`);
  const fromVariantId = requireEvolutionRecordRef(
    record.fromVariantId,
    "variant",
    `${label}.fromVariantId`,
  );
  const toVariantId = requireEvolutionRecordRef(
    record.toVariantId,
    "variant",
    `${label}.toVariantId`,
  );
  if (fromVariantId === toVariantId) {
    throw new Error(`${label}.fromVariantId and ${label}.toVariantId must be different`);
  }
  const rollbackReceiptId = record.rollbackReceiptId === undefined
    ? undefined
    : requireEvolutionRecordRef(record.rollbackReceiptId, "receipt", `${label}.rollbackReceiptId`);
  const normalized: DraftPromotionReceipt = {
    schemaVersion: 1,
    id: requireString(record.id, `${label}.id`, TARGET_EVOLUTION_LIMITS.maxIdentifierLength),
    projectId: requireExpectedProjectId(record.projectId, expectedProjectId, label),
    profileId: requireEvolutionRecordRef(record.profileId, "profile", `${label}.profileId`),
    experimentId: requireEvolutionRecordRef(
      record.experimentId,
      "experiment",
      `${label}.experimentId`,
    ),
    action: requireEnum(record.action, PROMOTION_RECEIPT_ACTIONS, `${label}.action`),
    fromVariantId,
    toVariantId,
    authorizedDecisionRef: requireOpaqueRef(
      record.authorizedDecisionRef,
      `${label}.authorizedDecisionRef`,
    ),
    appliedAt: requireEvolutionTimestamp(record.appliedAt, `${label}.appliedAt`),
    exactTargetRef: requireOpaqueRef(record.exactTargetRef, `${label}.exactTargetRef`),
    readbackEvidenceRefs: requireEvidenceRefs(
      record.readbackEvidenceRefs,
      `${label}.readbackEvidenceRefs`,
    ),
    canaryEvidenceRefs: requireEvidenceRefs(
      record.canaryEvidenceRefs,
      `${label}.canaryEvidenceRefs`,
    ),
    rollbackPlanRef: requireOpaqueRef(record.rollbackPlanRef, `${label}.rollbackPlanRef`),
    ...(rollbackReceiptId === undefined ? {} : { rollbackReceiptId }),
  };
  requireMatchingEvolutionRecordId("receipt", normalized, label);
  return normalized;
}

function parseEvolutionInstancePack(value: unknown, label: string): NonNullable<EvolutionInstance["pack"]> {
  const record = strictObject(value, ["id", "version", "contentSha256"], label);
  return {
    id: requireString(record.id, `${label}.id`, TARGET_EVOLUTION_LIMITS.maxIdentifierLength),
    version: requirePositiveInteger(record.version, `${label}.version`),
    contentSha256: requireSha256(record.contentSha256, `${label}.contentSha256`),
  };
}

function parseSignalSource(value: unknown, label: string): EvolutionPackV1["observation"]["signalSources"][number] {
  const record = strictObject(value, ["id", "kind", "freshnessMs"], label);
  const freshnessMs = record.freshnessMs === undefined
    ? undefined
    : requirePositiveInteger(record.freshnessMs, `${label}.freshnessMs`);
  return {
    id: requireOpaqueRef(record.id, `${label}.id`),
    kind: requireEnum(record.kind, SIGNAL_SOURCE_KINDS, `${label}.kind`),
    ...(freshnessMs === undefined ? {} : { freshnessMs }),
  };
}

function parseMutationSurface(
  value: unknown,
  expectedProjectId: string,
  label: string,
): EvolutionPackV1["mutationSurfaces"][number] {
  const record = strictObject(
    value,
    ["id", "evolutionTarget", "layer", "projectId", "allowedPaths", "forbiddenPaths", "owner"],
    label,
  );
  const evolutionTarget = requireEnum(record.evolutionTarget, EVOLUTION_TARGETS, `${label}.evolutionTarget`);
  if (evolutionTarget === "model") {
    throw new Error(`${label}.evolutionTarget model is prohibited in milestone one`);
  }
  const layer = requireEnum(record.layer, MUTATION_LAYERS, `${label}.layer`);
  const allowedLayers = evolutionTarget === "artifact" ? ARTIFACT_LAYERS : HARNESS_LAYERS;
  if (!allowedLayers.has(layer)) {
    throw new Error(`${label}.layer ${layer} is not allowed for evolutionTarget ${evolutionTarget}`);
  }
  const projectId = requireString(
    record.projectId,
    `${label}.projectId`,
    TARGET_EVOLUTION_LIMITS.maxIdentifierLength,
  );
  if (projectId !== expectedProjectId) {
    throw new Error(`${label}.projectId must equal proposal projectId ${expectedProjectId}`);
  }
  return {
    id: requireString(record.id, `${label}.id`, TARGET_EVOLUTION_LIMITS.maxIdentifierLength),
    evolutionTarget,
    layer,
    projectId,
    allowedPaths: requireProjectRelativePaths(record.allowedPaths, `${label}.allowedPaths`),
    forbiddenPaths: requireProjectRelativePaths(record.forbiddenPaths, `${label}.forbiddenPaths`),
    owner: requireEnum(record.owner, MUTATION_OWNERS, `${label}.owner`),
  };
}

function parseFirstCandidate(value: unknown, label: string): EvolutionFirstCandidate {
  const record = strictObject(
    value,
    [
      "id",
      "mode",
      "allowedEvolutionTargets",
      "prohibitedEvolutionTargets",
      "sideEffectBudget",
    ],
    label,
  );
  const allowedEvolutionTargets = requireArray(
    record.allowedEvolutionTargets,
    `${label}.allowedEvolutionTargets`,
    TARGET_EVOLUTION_LIMITS.maxArrayItems,
  ).map((target, index) => {
    requireString(
      target,
      `${label}.allowedEvolutionTargets[${index}]`,
      TARGET_EVOLUTION_LIMITS.maxIdentifierLength,
    );
    return requireEnum(
      target,
      FIRST_CANDIDATE_TARGETS,
      `${label}.allowedEvolutionTargets[${index}]`,
    );
  });
  requireNonEmpty(allowedEvolutionTargets, `${label}.allowedEvolutionTargets`);
  requireUniqueStrings(allowedEvolutionTargets, `${label}.allowedEvolutionTargets`);

  const prohibitedEvolutionTargets = requireArray(
    record.prohibitedEvolutionTargets,
    `${label}.prohibitedEvolutionTargets`,
    TARGET_EVOLUTION_LIMITS.maxArrayItems,
  );
  if (prohibitedEvolutionTargets.length !== 1) {
    throw new Error(`${label}.prohibitedEvolutionTargets must equal [model]`);
  }
  const prohibitedTarget = requireString(
    prohibitedEvolutionTargets[0],
    `${label}.prohibitedEvolutionTargets[0]`,
    TARGET_EVOLUTION_LIMITS.maxIdentifierLength,
  );
  if (prohibitedTarget !== "model") {
    throw new Error(`${label}.prohibitedEvolutionTargets must equal [model]`);
  }

  const sideEffectBudget = strictObject(
    record.sideEffectBudget,
    SIDE_EFFECT_BUDGET_KEYS,
    `${label}.sideEffectBudget`,
  );
  const normalizedSideEffectBudget = Object.fromEntries(
    SIDE_EFFECT_BUDGET_KEYS.map((key) => [
      key,
      requireLiteralZero(sideEffectBudget[key], `${label}.sideEffectBudget.${key}`),
    ]),
  ) as EvolutionFirstCandidate["sideEffectBudget"];

  return {
    id: requireString(record.id, `${label}.id`, TARGET_EVOLUTION_LIMITS.maxIdentifierLength),
    mode: requireEnum(record.mode, FIRST_CANDIDATE_MODES, `${label}.mode`),
    allowedEvolutionTargets,
    prohibitedEvolutionTargets: ["model"],
    sideEffectBudget: normalizedSideEffectBudget,
  };
}

function parseEvolutionEqualBudget(
  value: unknown,
  label: string,
): EvolutionComparison["equalBudget"] {
  const equalBudget = strictObject(
    value,
    ["model", "reasoningEffort", "wallClockMs", "maxAttempts", "maxTokens", "toolPolicySha256", "concurrency"],
    label,
  );
  const maxTokens = equalBudget.maxTokens === undefined
    ? undefined
    : requirePositiveIntegerAtMost(
        equalBudget.maxTokens,
        TARGET_EVOLUTION_LIMITS.maxTokens,
        `${label}.maxTokens`,
      );
  return {
    model: requireString(
      equalBudget.model,
      `${label}.model`,
      TARGET_EVOLUTION_LIMITS.maxIdentifierLength,
    ),
    reasoningEffort: requireEnum(
      equalBudget.reasoningEffort,
      REASONING_EFFORTS,
      `${label}.reasoningEffort`,
    ),
    wallClockMs: requirePositiveIntegerAtMost(
      equalBudget.wallClockMs,
      TARGET_EVOLUTION_LIMITS.maxWallClockMs,
      `${label}.wallClockMs`,
    ),
    maxAttempts: requirePositiveIntegerAtMost(
      equalBudget.maxAttempts,
      TARGET_EVOLUTION_LIMITS.maxAttempts,
      `${label}.maxAttempts`,
    ),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    toolPolicySha256: requireSha256(equalBudget.toolPolicySha256, `${label}.toolPolicySha256`),
    concurrency: requirePositiveIntegerAtMost(
      equalBudget.concurrency,
      TARGET_EVOLUTION_LIMITS.maxConcurrency,
      `${label}.concurrency`,
    ),
  };
}

function parseVersionedContentRef(
  value: unknown,
  label: string,
): EvolutionProfile["pack"] {
  const record = strictObject(value, ["id", "version", "contentSha256"], label);
  return {
    id: requireString(record.id, `${label}.id`, TARGET_EVOLUTION_LIMITS.maxIdentifierLength),
    version: requirePositiveInteger(record.version, `${label}.version`),
    contentSha256: requireSha256(record.contentSha256, `${label}.contentSha256`),
  };
}

function parseProductionEpisodePrivacyReview(
  value: unknown,
  expectedInputSnapshotSha256: string,
  expectedOutcomeSnapshotSha256: string,
  label: string,
): ProductionEpisode["privacyReview"] {
  const record = strictObject(
    value,
    [
      "status",
      "policySha256",
      "reviewerRef",
      "dataClassification",
      "retentionPolicyRef",
      "inputSnapshotSha256",
      "outcomeSnapshotSha256",
      "evidenceRefs",
    ],
    label,
  );
  if (record.status !== "approved") {
    throw new Error(`${label}.status must be approved`);
  }
  const inputSnapshotSha256 = requireSha256(
    record.inputSnapshotSha256,
    `${label}.inputSnapshotSha256`,
  );
  const outcomeSnapshotSha256 = requireSha256(
    record.outcomeSnapshotSha256,
    `${label}.outcomeSnapshotSha256`,
  );
  if (inputSnapshotSha256 !== expectedInputSnapshotSha256) {
    throw new Error(`${label}.inputSnapshotSha256 must match the episode inputSnapshotSha256`);
  }
  if (outcomeSnapshotSha256 !== expectedOutcomeSnapshotSha256) {
    throw new Error(`${label}.outcomeSnapshotSha256 must match the episode outcomeSnapshotSha256`);
  }
  return {
    status: "approved",
    policySha256: requireSha256(record.policySha256, `${label}.policySha256`),
    reviewerRef: requireOpaqueRef(record.reviewerRef, `${label}.reviewerRef`),
    dataClassification: requireEnum(
      record.dataClassification,
      DATA_CLASSIFICATIONS,
      `${label}.dataClassification`,
    ),
    retentionPolicyRef: requireOpaqueRef(record.retentionPolicyRef, `${label}.retentionPolicyRef`),
    inputSnapshotSha256,
    outcomeSnapshotSha256,
    evidenceRefs: requireEvidenceRefs(record.evidenceRefs, `${label}.evidenceRefs`),
  };
}

function parseEvolutionSideEffectCounters(
  value: unknown,
  requireZero: true,
  label: string,
): MatchedExperiment["sideEffectCounters"];
function parseEvolutionSideEffectCounters(
  value: unknown,
  requireZero: false,
  label: string,
): EvolutionSideEffectCounters;
function parseEvolutionSideEffectCounters(
  value: unknown,
  requireZero: boolean,
  label: string,
): EvolutionSideEffectCounters | MatchedExperiment["sideEffectCounters"] {
  const record = strictObject(value, SIDE_EFFECT_BUDGET_KEYS, label);
  return Object.fromEntries(
    SIDE_EFFECT_BUDGET_KEYS.map((key) => [
      key,
      requireZero
        ? requireLiteralZero(record[key], `${label}.${key}`)
        : key === "paidUsd"
          ? requireNonNegativeFinite(record[key], `${label}.${key}`)
          : requireNonNegativeInteger(record[key], `${label}.${key}`),
    ]),
  ) as EvolutionSideEffectCounters | MatchedExperiment["sideEffectCounters"];
}

function parseFiniteMetrics(value: unknown, label: string): Record<string, number> {
  const record = requirePlainJsonObject(value, label);
  const entries = Object.entries(record);
  if (entries.length > TARGET_EVOLUTION_LIMITS.maxArrayItems) {
    throw new Error(`${label} must contain at most ${TARGET_EVOLUTION_LIMITS.maxArrayItems} metrics`);
  }
  return Object.fromEntries(entries.map(([key, metric]) => [
    requireSafeShortIdentifier(key, `${label} metric name`),
    requireFiniteNumber(metric, `${label}.${key}`),
  ]));
}

function requireEvolutionTimestamp(value: unknown, label: string): string {
  const timestamp = requireStrictIsoTimestamp(value, label);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(timestamp);
  if (!parts) {
    throw new Error(`${label} must be a strict ISO 8601 UTC timestamp`);
  }
  const instant = new Date(timestamp);
  const expectedParts = parts.slice(1, 7).map(Number);
  const actualParts = [
    instant.getUTCFullYear(),
    instant.getUTCMonth() + 1,
    instant.getUTCDate(),
    instant.getUTCHours(),
    instant.getUTCMinutes(),
    instant.getUTCSeconds(),
  ];
  if (expectedParts.some((part, index) => part !== actualParts[index])) {
    throw new Error(`${label} must be a valid ISO 8601 UTC timestamp`);
  }
  return timestamp;
}

function requireExpectedProjectId(
  value: unknown,
  expectedProjectId: string,
  label: string,
): string {
  const expected = requireString(
    expectedProjectId,
    `${label} expected projectId`,
    TARGET_EVOLUTION_LIMITS.maxIdentifierLength,
  );
  const projectId = requireString(
    value,
    `${label}.projectId`,
    TARGET_EVOLUTION_LIMITS.maxIdentifierLength,
  );
  if (projectId !== expected) {
    throw new Error(`${label}.projectId must equal expected projectId ${expected}`);
  }
  return projectId;
}

function requireMatchingEvolutionRecordId(
  kind: EvolutionRecordKind,
  value: { id: string },
  label: string,
): void {
  const expectedId = expectedEvolutionRecordId(kind, value);
  if (value.id !== expectedId) {
    throw new Error(`${label}.id must equal content-addressed ID ${expectedId}`);
  }
}

function requireEvolutionRecordRef(
  value: unknown,
  kind: EvolutionRecordKind,
  label: string,
): string {
  const reference = requireString(value, label, TARGET_EVOLUTION_LIMITS.maxIdentifierLength);
  const pattern = new RegExp(`^${kind}_[0-9a-f]{64}$`);
  if (!pattern.test(reference)) {
    throw new Error(`${label} must be a content-addressed ${kind} ID`);
  }
  return reference;
}

function requireEvolutionRecordRefs(
  value: unknown,
  kind: EvolutionRecordKind,
  label: string,
): string[] {
  const refs = requireArray(
    value,
    label,
    TARGET_EVOLUTION_LIMITS.maxEvidenceRefsPerSplit,
  ).map((item, index) => requireEvolutionRecordRef(item, kind, `${label}[${index}]`));
  requireNonEmpty(refs, label);
  requireUniqueStrings(refs, label);
  return refs;
}

function requireEvidenceRefs(value: unknown, label: string): string[] {
  return requireNonEmptyOpaqueRefArray(
    value,
    label,
    TARGET_EVOLUTION_LIMITS.maxEvidenceRefsPerSplit,
  );
}

function requireOpaqueRefArray(value: unknown, label: string, maxItems: number): string[] {
  const refs = requireArray(value, label, maxItems).map((item, index) =>
    requireOpaqueRef(item, `${label}[${index}]`),
  );
  requireUniqueStrings(refs, label);
  return refs;
}

function requireNonEmptyOpaqueRefArray(value: unknown, label: string, maxItems: number): string[] {
  const refs = requireOpaqueRefArray(value, label, maxItems);
  requireNonEmpty(refs, label);
  return refs;
}

function requireOpaqueRef(value: unknown, label: string): string {
  const ref = requireString(value, label, TARGET_EVOLUTION_LIMITS.maxIdentifierLength);
  if (!SAFE_SHORT_REF_PATTERN.test(ref) && !TYPED_OPAQUE_REF_PATTERN.test(ref)) {
    throw new Error(`${label} must be an opaque ref or a safe short ID`);
  }
  requireNoSensitiveRefText(ref, label);
  return ref;
}

function requireExactEvolutionRef(value: unknown, label: string): string {
  const ref = requireOpaqueRef(value, label);
  const normalized = ref.toLowerCase();
  const [kind, ...payloadParts] = normalized.split(":");
  const payload = payloadParts.join(":");
  const payloadSegments = payload.split(/[\/:_-]+/).filter(Boolean);
  const mutableKinds = new Set(["branch", "ref", "head", "tag"]);
  const versionedKinds = new Set(["artifact", "plan", "rollback", "snapshot", "content"]);
  const mutableNames = new Set(["main", "master", "trunk", "head", "latest"]);
  const contentAddressed = /(?:^|[\/:_-])[0-9a-f]{40,64}$/.test(normalized);
  const explicitlyVersioned = /(?:^|[\/_-])v[1-9]\d*(?:$|[\/_-])/.test(payload);
  const exactGitCommit = /^git:commit:[0-9a-f]{40,64}$/.test(normalized);
  const supportedExactKind = exactGitCommit
    || (versionedKinds.has(kind ?? "") && (contentAddressed || explicitlyVersioned));
  if (
    !TYPED_OPAQUE_REF_PATTERN.test(ref)
    || mutableKinds.has(kind ?? "")
    || normalized.includes("refs/heads/")
    || payloadSegments.some((segment) => mutableNames.has(segment))
    || GLOB_META_PATTERN.test(ref)
    || !supportedExactKind
  ) {
    throw new Error(`${label} must identify one exact immutable typed target using a content address or explicit version, without a branch, HEAD, latest, tag, or glob syntax`);
  }
  return ref;
}

function requireNullableEvolutionRecordRef(
  value: unknown,
  kind: EvolutionRecordKind,
  label: string,
): string | null {
  if (value === null) {
    return null;
  }
  return requireEvolutionRecordRef(value, kind, label);
}

function requireExactStringSet<T extends string>(
  value: unknown,
  expected: readonly T[],
  label: string,
): T[] {
  const items = requireArray(value, label, expected.length).map((entry, index) =>
    requireEnum(entry, new Set(expected), `${label}[${index}]`),
  );
  requireUniqueStrings(items, label);
  if (items.length !== expected.length || expected.some((entry) => !items.includes(entry))) {
    throw new Error(`${label} must contain exactly ${expected.join(", ")}`);
  }
  return items;
}

function requireExactOrderedStrings<T extends string>(
  value: unknown,
  expected: readonly T[],
  label: string,
): T[] {
  const items = requireExactStringSet(value, expected, label);
  if (items.some((entry, index) => entry !== expected[index])) {
    throw new Error(`${label} must preserve the required order ${expected.join(", ")}`);
  }
  return items;
}

function requireSafeShortIdentifier(value: unknown, label: string): string {
  const identifier = requireString(value, label, TARGET_EVOLUTION_LIMITS.maxIdentifierLength);
  if (!SAFE_SHORT_REF_PATTERN.test(identifier)) {
    throw new Error(`${label} must be a safe short identifier`);
  }
  requireNoSensitiveRefText(identifier, label);
  return identifier;
}

function requireNoSensitiveRefText(value: string, label: string): void {
  if (SENSITIVE_REF_TEXT_PATTERN.test(value)) {
    throw new Error(`${label} must not contain credential-like or sensitive text`);
  }
}

function requireNonSensitiveText(
  value: unknown,
  label: string,
  maxLength = TARGET_EVOLUTION_LIMITS.maxTextLength,
): string {
  const text = requireString(value, label, maxLength);
  if (redactCredentialLikeText(text) !== text) {
    throw new Error(`${label} must not contain credential-like or sensitive text`);
  }
  return text;
}

function redactCredentialLikeText(value: string): string {
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

function requireUniqueNonEmptyStringArray(
  value: unknown,
  label: string,
  maxItems: number,
  maxItemLength: number = TARGET_EVOLUTION_LIMITS.maxTextLength,
): string[] {
  const result = requireNonEmptyStringArray(value, label, maxItems, maxItemLength);
  requireUniqueStrings(result, label);
  return result;
}

function requireUniqueProjectRelativePaths(value: unknown, label: string): string[] {
  const paths = requireProjectRelativePaths(value, label);
  requireUniqueStrings(paths, label);
  return paths;
}

function requireUniqueExactProjectRelativePaths(value: unknown, label: string): string[] {
  const paths = requireUniqueProjectRelativePaths(value, label);
  for (const path of paths) {
    if (GLOB_META_PATTERN.test(path)) {
      throw new Error(`${label} must contain exact project-relative file paths without glob syntax`);
    }
  }
  return paths;
}

function requirePlainJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain JSON object`);
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    throw new Error(`${label} must contain only JSON object keys`);
  }
  return value as Record<string, unknown>;
}

function canonicalEvolutionValue(
  value: unknown,
  label: string,
  ancestors: Set<object>,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} numbers must be finite JSON numbers`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`${label} must contain only JSON-compatible values`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${label} must not contain circular JSON values`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => canonicalEvolutionValue(item, `${label}[${index}]`, ancestors));
    }
    const record = requirePlainJsonObject(value, label);
    const keys = Object.keys(record).sort();
    if (keys.length !== Reflect.ownKeys(record).length) {
      throw new Error(`${label} must not contain hidden non-JSON fields`);
    }
    return Object.fromEntries(keys.map((key) => [
      key,
      canonicalEvolutionValue(record[key], `${label}.${key}`, ancestors),
    ]));
  } finally {
    ancestors.delete(value);
  }
}

function strictObject(value: unknown, allowedKeys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  const unknownKeys = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unknownKeys.sort().join(", ")}`);
  }
  return record;
}

function requireSchemaVersion(value: unknown, label: string): asserts value is 1 {
  if (value !== 1) {
    throw new Error(`${label} must be 1`);
  }
}

function requireString(
  value: unknown,
  label: string,
  maxLength: number = TARGET_EVOLUTION_LIMITS.maxTextLength,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not contain surrounding whitespace`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} must contain at most ${maxLength} characters`);
  }
  return value;
}

function requireArray(value: unknown, label: string, maxItems?: number): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  if (maxItems !== undefined && value.length > maxItems) {
    throw new Error(`${label} must contain at most ${maxItems} items`);
  }
  return value;
}

function requireStringArray(
  value: unknown,
  label: string,
  maxItems: number,
  maxItemLength: number = TARGET_EVOLUTION_LIMITS.maxTextLength,
): string[] {
  return requireArray(value, label, maxItems).map((item, index) =>
    requireString(item, `${label}[${index}]`, maxItemLength),
  );
}

function requireNonEmptyStringArray(
  value: unknown,
  label: string,
  maxItems: number,
  maxItemLength: number = TARGET_EVOLUTION_LIMITS.maxTextLength,
): string[] {
  const result = requireStringArray(value, label, maxItems, maxItemLength);
  requireNonEmpty(result, label);
  return result;
}

function requireProjectRelativePaths(value: unknown, label: string): string[] {
  const paths = requireArray(value, label, TARGET_EVOLUTION_LIMITS.maxPathsPerSurface).map(
    (path, index) => requireProjectRelativePath(path, `${label}[${index}]`),
  );
  requireNonEmpty(paths, label);
  return paths;
}

function requireProjectRelativePath(value: unknown, label: string): string {
  const path = requireString(value, label, TARGET_EVOLUTION_LIMITS.maxPathLength);
  if (
    path.startsWith("/")
    || path.includes("\\")
    || path.includes("\0")
    || /^[A-Za-z]:/.test(path)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)
  ) {
    throw new Error(`${label} must be a project-relative path or glob`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a canonical project-relative path or glob`);
  }
  return path;
}

function requireNonEmpty<T>(value: T[], label: string): void {
  if (value.length === 0) {
    throw new Error(`${label} must contain at least one item`);
  }
}

function requireEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new Error(`${label} must be one of ${[...allowed].join(", ")}`);
  }
  return value as T;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requirePositiveIntegerAtMost(value: unknown, maximum: number, label: string): number {
  const result = requirePositiveInteger(value, label);
  if (result > maximum) {
    throw new Error(`${label} must be at most ${maximum}`);
  }
  return result;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function requireNonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function requireTrue(value: unknown, label: string): asserts value is true {
  if (value !== true) {
    throw new Error(`${label} must be true`);
  }
}

function requireLiteralZero(value: unknown, label: string): 0 {
  if (!Object.is(value, 0)) {
    throw new Error(`${label} must be exactly zero`);
  }
  return 0;
}

function requireSha256(value: unknown, label: string): string {
  const hash = requireString(value, label);
  if (!SHA256_PATTERN.test(hash)) {
    throw new Error(`${label} must be a 64-character lowercase hexadecimal SHA-256`);
  }
  return hash;
}

function requireUniqueIds(values: Array<{ id: string }>, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) {
      throw new Error(`${label} contains duplicate id ${value.id}`);
    }
    seen.add(value.id);
  }
}

function requireUniqueStrings(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${label} contains duplicate value ${value}`);
    }
    seen.add(value);
  }
}

function requireGloballyUniqueEvidence(splits: string[][], label: string): void {
  const seen = new Set<string>();
  for (const split of splits) {
    for (const evidenceRef of split) {
      if (seen.has(evidenceRef)) {
        throw new Error(`${label} evidence refs must be unique across development, holdout, and unrelated splits`);
      }
      seen.add(evidenceRef);
    }
  }
}
