import type {
  EvolutionCausalHypothesis,
  EvolutionComparison,
  EvolutionCycleKind,
  EvolutionInstance,
  EvolutionMode,
  EvolutionMutationLayer,
  EvolutionPackMaturity,
  EvolutionPackV1,
  EvolutionTarget,
} from "./types";

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
    kernelProjectId: requireString(record.kernelProjectId, `${label}.kernelProjectId`),
    targetProjectId: requireString(record.targetProjectId, `${label}.targetProjectId`),
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
  requireString(expectedProjectId, `${label} expected projectId`);
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
    ],
    label,
  );
  requireSchemaVersion(record.schemaVersion, `${label}.schemaVersion`);

  const knowledgeScope = requireString(record.knowledgeScope, `${label}.knowledgeScope`);
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
  const signalSources = requireArray(observation.signalSources, `${label}.observation.signalSources`).map(
    (source, index) => parseSignalSource(source, `${label}.observation.signalSources[${index}]`),
  );
  requireNonEmpty(signalSources, `${label}.observation.signalSources`);
  requireUniqueIds(signalSources, `${label}.observation.signalSources`);

  const mutationSurfaces = requireArray(record.mutationSurfaces, `${label}.mutationSurfaces`).map(
    (surface, index) => parseMutationSurface(surface, expectedProjectId, `${label}.mutationSurfaces[${index}]`),
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

  return {
    schemaVersion: 1,
    id: requireString(record.id, `${label}.id`),
    targetSystemId: requireString(record.targetSystemId, `${label}.targetSystemId`),
    version: requirePositiveInteger(record.version, `${label}.version`),
    knowledgeScope: expectedKnowledgeScope,
    objective: {
      charterId: requireString(objective.charterId, `${label}.objective.charterId`),
      domainOutcomes: requireNonEmptyStringArray(
        objective.domainOutcomes,
        `${label}.objective.domainOutcomes`,
      ),
      nonGoals: requireNonEmptyStringArray(objective.nonGoals, `${label}.objective.nonGoals`),
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
      ),
      observationWindow: requireString(
        promotionPolicy.observationWindow,
        `${label}.promotionPolicy.observationWindow`,
      ),
      rollback: requireString(promotionPolicy.rollback, `${label}.promotionPolicy.rollback`),
    },
    handoff: {
      maturity,
      targetOwner: requireString(handoff.targetOwner, `${label}.handoff.targetOwner`),
      requiredCapabilities: requireNonEmptyStringArray(
        handoff.requiredCapabilities,
        `${label}.handoff.requiredCapabilities`,
      ),
    },
    portability: {
      projectLocalRules: requireNonEmptyStringArray(
        portability.projectLocalRules,
        `${label}.portability.projectLocalRules`,
      ),
      genericizationEvidence: requireStringArray(
        portability.genericizationEvidence,
        `${label}.portability.genericizationEvidence`,
      ),
    },
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
    mechanism: requireString(record.mechanism, `${label}.mechanism`),
    predictedEffects: requireNonEmptyStringArray(record.predictedEffects, `${label}.predictedEffects`),
    disconfirmingEvidence: requireNonEmptyStringArray(
      record.disconfirmingEvidence,
      `${label}.disconfirmingEvidence`,
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
  );
  const holdoutEvidenceRefs = requireNonEmptyStringArray(
    record.holdoutEvidenceRefs,
    `${label}.holdoutEvidenceRefs`,
  );
  const unrelatedEvidenceRefs = requireNonEmptyStringArray(
    record.unrelatedEvidenceRefs,
    `${label}.unrelatedEvidenceRefs`,
  );
  requireGloballyUniqueEvidence(
    [developmentEvidenceRefs, holdoutEvidenceRefs, unrelatedEvidenceRefs],
    label,
  );

  const equalBudget = strictObject(
    record.equalBudget,
    ["model", "reasoningEffort", "wallClockMs", "maxAttempts", "maxTokens", "toolPolicySha256", "concurrency"],
    `${label}.equalBudget`,
  );
  const maxTokens = equalBudget.maxTokens === undefined
    ? undefined
    : requirePositiveInteger(equalBudget.maxTokens, `${label}.equalBudget.maxTokens`);

  return {
    controlRef: requireString(record.controlRef, `${label}.controlRef`),
    developmentEvidenceRefs,
    holdoutEvidenceRefs,
    unrelatedEvidenceRefs,
    corpusSnapshotSha256: requireSha256(
      record.corpusSnapshotSha256,
      `${label}.corpusSnapshotSha256`,
    ),
    equalBudget: {
      model: requireString(equalBudget.model, `${label}.equalBudget.model`),
      reasoningEffort: requireEnum(
        equalBudget.reasoningEffort,
        REASONING_EFFORTS,
        `${label}.equalBudget.reasoningEffort`,
      ),
      wallClockMs: requirePositiveInteger(
        equalBudget.wallClockMs,
        `${label}.equalBudget.wallClockMs`,
      ),
      maxAttempts: requirePositiveInteger(
        equalBudget.maxAttempts,
        `${label}.equalBudget.maxAttempts`,
      ),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      toolPolicySha256: requireSha256(
        equalBudget.toolPolicySha256,
        `${label}.equalBudget.toolPolicySha256`,
      ),
      concurrency: requirePositiveInteger(
        equalBudget.concurrency,
        `${label}.equalBudget.concurrency`,
      ),
    },
    primaryMetric: requireString(record.primaryMetric, `${label}.primaryMetric`),
    minimumUplift: requireNonNegativeFinite(record.minimumUplift, `${label}.minimumUplift`),
    maximumGuardRegression: requireNonNegativeFinite(
      record.maximumGuardRegression,
      `${label}.maximumGuardRegression`,
    ),
  };
}

function parseEvolutionInstancePack(value: unknown, label: string): NonNullable<EvolutionInstance["pack"]> {
  const record = strictObject(value, ["id", "version", "contentSha256"], label);
  return {
    id: requireString(record.id, `${label}.id`),
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
    id: requireString(record.id, `${label}.id`),
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
  const projectId = requireString(record.projectId, `${label}.projectId`);
  if (projectId !== expectedProjectId) {
    throw new Error(`${label}.projectId must equal proposal projectId ${expectedProjectId}`);
  }
  return {
    id: requireString(record.id, `${label}.id`),
    evolutionTarget,
    layer: requireEnum(record.layer, MUTATION_LAYERS, `${label}.layer`),
    projectId,
    allowedPaths: requireNonEmptyStringArray(record.allowedPaths, `${label}.allowedPaths`),
    forbiddenPaths: requireNonEmptyStringArray(record.forbiddenPaths, `${label}.forbiddenPaths`),
    owner: requireEnum(record.owner, MUTATION_OWNERS, `${label}.owner`),
  };
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

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  return requireArray(value, label).map((item, index) => requireString(item, `${label}[${index}]`));
}

function requireNonEmptyStringArray(value: unknown, label: string): string[] {
  const result = requireStringArray(value, label);
  requireNonEmpty(result, label);
  return result;
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

function requireTrue(value: unknown, label: string): asserts value is true {
  if (value !== true) {
    throw new Error(`${label} must be true`);
  }
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
