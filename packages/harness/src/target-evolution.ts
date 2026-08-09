import { createHash } from "node:crypto";
import { requireStrictIsoTimestamp } from "./iso-timestamp";
import type {
  EvolutionCausalHypothesis,
  EvolutionComparison,
  EvolutionCycleKind,
  EvolutionFirstCandidate,
  EvolutionInstance,
  EvolutionMode,
  EvolutionMutationLayer,
  EvolutionPackMaturity,
  EvolutionPackV1,
  EvolutionProfile,
  EvolutionRecordKind,
  EvolutionSideEffectCounters,
  EvolutionTarget,
  HarnessVariant,
  MatchedExperiment,
  ProductionEpisode,
  PromotionReceipt,
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
const PROMOTION_RECEIPT_ACTIONS = new Set<PromotionReceipt["action"]>(["promote", "rollback"]);
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
      genericizationEvidence: requireStringArray(
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
  const developmentEvidenceRefs = requireNonEmptyStringArray(
    record.developmentEvidenceRefs,
    `${label}.developmentEvidenceRefs`,
    TARGET_EVOLUTION_LIMITS.maxEvidenceRefsPerSplit,
  );
  const holdoutEvidenceRefs = requireNonEmptyStringArray(
    record.holdoutEvidenceRefs,
    `${label}.holdoutEvidenceRefs`,
    TARGET_EVOLUTION_LIMITS.maxEvidenceRefsPerSplit,
  );
  const unrelatedEvidenceRefs = requireNonEmptyStringArray(
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
    controlRef: requireString(
      record.controlRef,
      `${label}.controlRef`,
      TARGET_EVOLUTION_LIMITS.maxTextLength,
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
      "maturity",
      "allowedSurfaceIds",
      "activatedAt",
      "activatedByReceipt",
    ],
    label,
  );
  requireSchemaVersion(record.schemaVersion, `${label}.schemaVersion`);
  const activatedByReceipt = record.activatedByReceipt === undefined
    ? undefined
    : requireEvolutionRecordRef(record.activatedByReceipt, "receipt", `${label}.activatedByReceipt`);
  const normalized: EvolutionProfile = {
    schemaVersion: 1,
    id: requireString(record.id, `${label}.id`, TARGET_EVOLUTION_LIMITS.maxIdentifierLength),
    projectId: requireExpectedProjectId(record.projectId, expectedProjectId, label),
    pack: parseVersionedContentRef(record.pack, `${label}.pack`),
    charter: parseVersionedContentRef(record.charter, `${label}.charter`),
    maturity: requireEnum(record.maturity, PACK_MATURITIES, `${label}.maturity`),
    allowedSurfaceIds: requireUniqueNonEmptyStringArray(
      record.allowedSurfaceIds,
      `${label}.allowedSurfaceIds`,
      TARGET_EVOLUTION_LIMITS.maxMutationSurfaces,
      TARGET_EVOLUTION_LIMITS.maxIdentifierLength,
    ),
    activatedAt: requireEvolutionTimestamp(record.activatedAt, `${label}.activatedAt`),
    ...(activatedByReceipt === undefined ? {} : { activatedByReceipt }),
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
    sourceRef: requireString(record.sourceRef, `${label}.sourceRef`, TARGET_EVOLUTION_LIMITS.maxTextLength),
    leakageGroupId: requireString(
      record.leakageGroupId,
      `${label}.leakageGroupId`,
      TARGET_EVOLUTION_LIMITS.maxIdentifierLength,
    ),
    observedAt: requireEvolutionTimestamp(record.observedAt, `${label}.observedAt`),
    inputSnapshotSha256,
    outcomeSnapshotSha256,
    policyRef: requireString(
      record.policyRef,
      `${label}.policyRef`,
      TARGET_EVOLUTION_LIMITS.maxIdentifierLength,
    ),
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
    changedPaths: requireUniqueProjectRelativePaths(record.changedPaths, `${label}.changedPaths`),
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

export function parsePromotionReceipt(
  value: unknown,
  expectedProjectId: string,
  label = "promotionReceipt",
): PromotionReceipt {
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
  const normalized: PromotionReceipt = {
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
    authorizedDecisionRef: requireString(
      record.authorizedDecisionRef,
      `${label}.authorizedDecisionRef`,
      TARGET_EVOLUTION_LIMITS.maxTextLength,
    ),
    appliedAt: requireEvolutionTimestamp(record.appliedAt, `${label}.appliedAt`),
    exactTargetRef: requireString(
      record.exactTargetRef,
      `${label}.exactTargetRef`,
      TARGET_EVOLUTION_LIMITS.maxTextLength,
    ),
    readbackEvidenceRefs: requireEvidenceRefs(
      record.readbackEvidenceRefs,
      `${label}.readbackEvidenceRefs`,
    ),
    canaryEvidenceRefs: requireEvidenceRefs(
      record.canaryEvidenceRefs,
      `${label}.canaryEvidenceRefs`,
    ),
    rollbackPlanRef: requireString(
      record.rollbackPlanRef,
      `${label}.rollbackPlanRef`,
      TARGET_EVOLUTION_LIMITS.maxTextLength,
    ),
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
    id: requireString(record.id, `${label}.id`, TARGET_EVOLUTION_LIMITS.maxIdentifierLength),
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
    reviewerRef: requireString(
      record.reviewerRef,
      `${label}.reviewerRef`,
      TARGET_EVOLUTION_LIMITS.maxTextLength,
    ),
    dataClassification: requireString(
      record.dataClassification,
      `${label}.dataClassification`,
      TARGET_EVOLUTION_LIMITS.maxIdentifierLength,
    ),
    retentionPolicyRef: requireString(
      record.retentionPolicyRef,
      `${label}.retentionPolicyRef`,
      TARGET_EVOLUTION_LIMITS.maxTextLength,
    ),
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
    requireString(key, `${label} metric name`, TARGET_EVOLUTION_LIMITS.maxIdentifierLength),
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
  return requireUniqueNonEmptyStringArray(
    value,
    label,
    TARGET_EVOLUTION_LIMITS.maxEvidenceRefsPerSplit,
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
