import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as harnessModule from "../packages/harness/src";
import * as targetEvolutionModule from "../packages/harness/src/target-evolution";
import type {
  DesignProposalData,
  EvolutionCausalHypothesis,
  EvolutionComparison,
  EvolutionFirstCandidate,
  EvolutionPackV1,
} from "../packages/harness/src";
import { buildTaskPrompt, proposeDesignAction } from "../packages/runner/src";

const PROJECT_ID = "project_hodor";
const HODOR_REFERENCE_PROJECT_ID = "project_hodor_reference";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

interface HodorEvolutionReference {
  projectId: string;
  evolutionPack: EvolutionPackV1;
  causalHypothesis: EvolutionCausalHypothesis;
  comparison: EvolutionComparison;
}

const ZERO_SIDE_EFFECT_BUDGET = {
  paidUsd: 0,
  realProviderCalls: 0,
  pancatWrites: 0,
  productionPublishes: 0,
  realAssetDeletes: 0,
  crossProjectMemoryReads: 0,
  crossProjectMemoryWrites: 0,
} as const;

function validFirstCandidate(): EvolutionFirstCandidate {
  return {
    id: "hodor-spatial-risk-shadow-v1",
    mode: "shadow",
    allowedEvolutionTargets: ["artifact", "harness"],
    prohibitedEvolutionTargets: ["model"],
    sideEffectBudget: { ...ZERO_SIDE_EFFECT_BUDGET },
  };
}

async function hodorEvolutionReference(): Promise<HodorEvolutionReference> {
  return JSON.parse(
    await Bun.file(new URL("./fixtures/hodor-evolution-pack-v0.json", import.meta.url)).text(),
  ) as HodorEvolutionReference;
}

function ordinaryProposal(): DesignProposalData {
  return {
    problem: "A domain policy has no evidence-backed improvement loop",
    recommendation: "Keep the current bounded delivery path",
    evidenceRefs: ["signal_1"],
    options: [
      {
        name: "keep current behavior",
        benefits: ["no migration"],
        costs: ["manual tuning"],
        risks: ["slow learning"],
        lockIn: ["none"],
      },
    ],
    evaluationContract: {
      baseline: ["current behavior"],
      successMetrics: ["delivery remains correct"],
      guardMetrics: ["no production side effects"],
      requiredEvidence: ["deterministic test output"],
    },
    investment: {
      reversibility: "easy" as const,
      portfolio: "core" as const,
      oneTimeCost: 0,
      recurringCost: 0,
    },
  };
}

function validEvolutionPack(): EvolutionPackV1 {
  return {
    schemaVersion: 1,
    id: "hodor-evolution-pack",
    targetSystemId: "hodor",
    version: 1,
    knowledgeScope: `project:${PROJECT_ID}`,
    objective: {
      charterId: "charter_hodor",
      domainOutcomes: ["reduce spatial-risk false positives"],
      nonGoals: ["change production publishing"],
    },
    observation: {
      signalSources: [
        { id: "run-evidence", kind: "run-evidence", freshnessMs: 86_400_000 },
        { id: "domain-metric", kind: "domain-metric" },
      ],
    },
    mutationSurfaces: [
      {
        id: "risk-policy-artifact",
        evolutionTarget: "artifact",
        layer: "policy",
        projectId: PROJECT_ID,
        allowedPaths: ["config/spatial-risk.json"],
        forbiddenPaths: ["src/providers/**"],
        owner: "target",
      },
      {
        id: "evaluation-harness",
        evolutionTarget: "harness",
        layer: "workflow",
        projectId: PROJECT_ID,
        allowedPaths: ["tests/evolution/**"],
        forbiddenPaths: ["db/**"],
        owner: "ouroboros",
      },
    ],
    experimentPolicy: {
      controlRequired: true,
      holdoutRequired: true,
      unrelatedRegressionRequired: true,
      equalBudgetRequired: true,
      maxCandidates: 3,
    },
    promotionPolicy: {
      guardMetrics: ["zero production writes"],
      observationWindow: "three matched runs",
      rollback: "restore the frozen baseline policy",
    },
    handoff: {
      maturity: "designed",
      targetOwner: "hodor",
      requiredCapabilities: ["frozen evidence replay"],
    },
    portability: {
      projectLocalRules: ["spatial-risk semantics remain Hodor-local"],
      genericizationEvidence: [],
    },
  };
}

function validCausalHypothesis(): EvolutionCausalHypothesis {
  return {
    failureClass: "domain-hypothesis",
    mechanism: "a fixed threshold over-blocks low-risk layouts",
    predictedEffects: ["fewer false positives under the same guard budget"],
    disconfirmingEvidence: ["holdout false positives do not improve"],
  };
}

function validComparison(): EvolutionComparison {
  return {
    controlRef: "baseline_spatial_policy_v1",
    developmentEvidenceRefs: ["episode_development_1"],
    holdoutEvidenceRefs: ["episode_holdout_1"],
    unrelatedEvidenceRefs: ["episode_unrelated_1"],
    corpusSnapshotSha256: SHA_A,
    equalBudget: {
      model: "gpt-5.6",
      reasoningEffort: "high",
      wallClockMs: 300_000,
      maxAttempts: 2,
      maxTokens: 20_000,
      toolPolicySha256: SHA_B,
      concurrency: 1,
    },
    primaryMetric: "spatial-risk false-positive rate",
    minimumUplift: 0.05,
    maximumGuardRegression: 0,
  };
}

function validEvolutionDeliveryContracts(pack: EvolutionPackV1) {
  const privacyContractId = "hodor-production-episode-privacy-v1";
  const exactTargetRef = "artifact:hodor-evolution-policy-v4";
  const rollbackPlanRef = "plan:hodor-evolution-rollback-v4";
  return {
    episodeCollectionContract: {
      schemaVersion: 1,
      id: "hodor-episode-collection-v1",
      projectId: PROJECT_ID,
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
      privacyReceiptContractRef: privacyContractId,
      appendOnly: true,
      rawPayloadPolicy: "reject",
      sideEffectBudget: { ...ZERO_SIDE_EFFECT_BUDGET },
    },
    maturityGateContract: {
      schemaVersion: 1,
      id: "hodor-maturity-gates-v1",
      projectId: PROJECT_ID,
      packRef: {
        id: pack.id,
        version: pack.version,
        contentSha256: targetEvolutionModule.canonicalEvolutionValueSha256(pack),
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
          requiredEvidenceRefs: ["evidence:accepted-design-v4"],
          guardMetrics: ["zero external side effects"],
          allowedOperations: ["freeze contracts"],
          failureMaturity: "designed",
        },
        {
          id: "instrumented",
          requiredEvidenceRefs: ["evidence:host-privacy-receipt"],
          guardMetrics: ["all episodes are content addressed"],
          allowedOperations: ["collect commitments"],
          failureMaturity: "designed",
        },
        {
          id: "shadowing",
          requiredEvidenceRefs: ["evidence:matched-shadow-readback"],
          guardMetrics: ["all side effect counters remain zero"],
          allowedOperations: ["compare frozen variants"],
          failureMaturity: "instrumented",
        },
      ],
    },
    productionEpisodePrivacyReceiptContract: {
      schemaVersion: 1,
      id: privacyContractId,
      projectId: PROJECT_ID,
      mode: "requirements-only",
      privacyReview: {
        requiredStatus: "approved",
        policySha256: SHA_B,
        reviewerRef: "reviewer:host-privacy-verifier",
        dataClassification: "confidential",
        retentionPolicyRef: "policy:hodor-episode-retention-v1",
        evidenceRefs: ["evidence:privacy-review-v1"],
      },
      snapshotBinding: {
        inputSnapshotSha256Required: true,
        outcomeSnapshotSha256Required: true,
        mustMatchEpisode: true,
      },
      rawPayloadPolicy: "reject",
      appendOnly: true,
      rejectionConditions: ["privacy review receipt is absent or mismatched"],
    },
    promotionReceiptContract: {
      schemaVersion: 1,
      id: "hodor-promotion-receipt-v1",
      mode: "draft-only",
      projectId: PROJECT_ID,
      authorizedDecisionRef: "decision:hodor-evolution-v4",
      fromVariantId: `variant_${"1".repeat(64)}`,
      toVariantId: `variant_${"2".repeat(64)}`,
      exactTargetRef,
      readbackEvidenceRefs: ["evidence:promotion-readback-v1"],
      canaryEvidenceRefs: ["evidence:promotion-canary-v1"],
      observationWindow: {
        matchedRuns: 3,
        startsAfterMaturity: "instrumented",
      },
      rollbackPlanRef,
      rollbackReceiptId: null,
      issuerRef: "issuer:ouroboros-authority",
      issuedAtRequired: true,
    },
    rollbackContract: {
      schemaVersion: 1,
      id: "hodor-rollback-v1",
      projectId: PROJECT_ID,
      exactTargetRef,
      lastKnownGoodRef: "artifact:hodor-evolution-policy-v3",
      idempotencyKey: "rollback:hodor-evolution-policy-v4",
      rollbackPlanRef,
      rollbackReceiptId: null,
      triggers: [
        { id: "guard-regression", condition: "any frozen guard metric regresses" },
      ],
      readbackEvidenceRefs: ["evidence:rollback-readback-v1"],
      canaryEvidenceRefs: ["evidence:rollback-canary-v1"],
      appendOnly: true,
      deleteOrRewriteHistory: false,
      forbiddenScopes: ["HEAD", "latest", "wildcard target"],
    },
  } as unknown as Required<Pick<
    DesignProposalData,
    | "episodeCollectionContract"
    | "maturityGateContract"
    | "productionEpisodePrivacyReceiptContract"
    | "promotionReceiptContract"
    | "rollbackContract"
  >>;
}

function validEvolutionProposal(): DesignProposalData {
  const pack = { ...validEvolutionPack(), version: 4 };
  return {
    ...ordinaryProposal(),
    evolutionPack: pack,
    causalHypothesis: validCausalHypothesis(),
    evaluationContract: {
      ...ordinaryProposal().evaluationContract,
      comparison: validComparison(),
    },
    ...validEvolutionDeliveryContracts(pack),
  };
}

function parser(name: string): (...args: unknown[]) => unknown {
  const candidate = (harnessModule as unknown as Record<string, unknown>)[name];
  expect(candidate, `${name} must be exported by @ouroboros/harness`).toBeFunction();
  return candidate as (...args: unknown[]) => unknown;
}

function draftParser(name: string): (...args: unknown[]) => unknown {
  const candidate = (targetEvolutionModule as unknown as Record<string, unknown>)[name];
  expect(candidate, `${name} must remain available only from the internal target-evolution module`).toBeFunction();
  return candidate as (...args: unknown[]) => unknown;
}

function runtimeRecordParser(name: string): (...args: unknown[]) => unknown {
  return name === "parseDraftPromotionReceipt" ? draftParser(name) : parser(name);
}

type EvolutionRecordKind = "profile" | "episode" | "variant" | "experiment" | "receipt";

function canonicalTestValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalTestValue);
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalTestValue(record[key])]),
  );
}

function testEvolutionRecordId(
  kind: EvolutionRecordKind,
  value: Record<string, unknown>,
): string {
  const { id: _ignored, ...recordWithoutId } = value;
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalTestValue(recordWithoutId)), "utf8")
    .digest("hex");
  return `${kind}_${digest}`;
}

function addressedRecord<T extends Record<string, unknown>>(
  kind: EvolutionRecordKind,
  value: T,
): T & { id: string } {
  return { ...value, id: testEvolutionRecordId(kind, value) };
}

function validEvolutionProfile() {
  return addressedRecord("profile", {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    pack: { id: "hodor-evolution-pack", version: 1, contentSha256: SHA_A },
    charter: { id: "charter_hodor", version: 2, contentSha256: SHA_B },
    runtimeMaturity: "declared",
    allowedSurfaceIds: ["risk-policy-artifact", "evaluation-harness"],
    registeredAt: "2026-08-09T01:02:03.456Z",
  });
}

function validProductionEpisode(sourceRef = "evidence:episode-development-1") {
  const profile = validEvolutionProfile();
  return addressedRecord("episode", {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    profileId: profile.id,
    sourceRef,
    leakageGroupId: "leakage_group_development_1",
    observedAt: "2026-08-09T02:03:04Z",
    inputSnapshotSha256: SHA_A,
    outcomeSnapshotSha256: SHA_B,
    policyRef: "policy:spatial-risk-v1",
    metrics: { quality: 0.95, signedDelta: -0.25 },
    sideEffectCounters: { ...ZERO_SIDE_EFFECT_BUDGET, realProviderCalls: 1 },
    evidenceRefs: ["evidence:episode-1"],
    privacyReview: {
      status: "approved",
      policySha256: SHA_C,
      reviewerRef: "reviewer:privacy-1",
      dataClassification: "confidential",
      retentionPolicyRef: "retention:policy-1",
      inputSnapshotSha256: SHA_A,
      outcomeSnapshotSha256: SHA_B,
      evidenceRefs: ["evidence:privacy-review-1"],
    },
  });
}

function validHarnessVariant(role: "control" | "candidate" = "control") {
  const profile = validEvolutionProfile();
  return addressedRecord("variant", {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    profileId: profile.id,
    role,
    evolutionTargets: role === "control" ? ["artifact"] : ["artifact", "harness"],
    contentSha256: role === "control" ? SHA_A : SHA_C,
    mutationSurfaceIds: ["risk-policy-artifact"],
    changedPaths: role === "control" ? ["config/spatial-risk.json"] : ["tests/evolution/policy.test.ts"],
    toolPolicySha256: SHA_B,
    createdFromEvidenceRefs: [role === "control" ? "evidence:baseline" : "evidence:candidate"],
  });
}

function validMatchedExperiment() {
  return addressedRecord("experiment", {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    profileId: validEvolutionProfile().id,
    controlVariantId: validHarnessVariant("control").id,
    candidateVariantId: validHarnessVariant("candidate").id,
    developmentEpisodeRefs: [validProductionEpisode("evidence:episode-development-1").id],
    heldoutEpisodeRefs: [validProductionEpisode("evidence:episode-heldout-1").id],
    unrelatedEpisodeRefs: [validProductionEpisode("evidence:episode-unrelated-1").id],
    corpusSnapshotSha256: SHA_C,
    equalBudget: { ...validComparison().equalBudget },
    primaryMetric: "spatial-risk false-positive rate",
    guardMetrics: ["zero production publishes"],
    sideEffectCounters: { ...ZERO_SIDE_EFFECT_BUDGET },
    outcome: "pending",
    evidenceRefs: ["evidence:experiment-1"],
  });
}

function validPromotionReceipt() {
  return addressedRecord("receipt", {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    profileId: validEvolutionProfile().id,
    experimentId: validMatchedExperiment().id,
    action: "promote",
    fromVariantId: validHarnessVariant("control").id,
    toVariantId: validHarnessVariant("candidate").id,
    authorizedDecisionRef: "decision:promote-1",
    appliedAt: "2026-08-09T03:04:05Z",
    exactTargetRef: "git:commit:0123456789abcdef",
    readbackEvidenceRefs: ["evidence:readback-1"],
    canaryEvidenceRefs: ["evidence:canary-1"],
    rollbackPlanRef: "rollback:plan-1",
  });
}

function readdress(
  kind: EvolutionRecordKind,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const { id: _ignored, ...withoutId } = value;
  return addressedRecord(kind, withoutId);
}

function designerPrompt(): string {
  return buildTaskPrompt({
    run: {
      id: "run_1",
      projectId: PROJECT_ID,
      projectRoot: "/tmp/hodor",
      goal: "Design Hodor evolution",
      status: "todo",
      context: { founderCharterId: "charter_hodor" },
    },
    task: {
      id: "task_1",
      runId: "run_1",
      parentId: null,
      cycleId: "cycle_1",
      status: "todo",
      role: "designer",
      goal: "Propose a bounded evolution pack",
      prompt: "Use evidence.",
      dependsOn: [],
      doneWhen: [],
      worktreePath: null,
      sessionRef: null,
      contextVersion: 1,
    },
    dependencyAttempts: [],
  });
}

function jsonFenceAfter(prompt: string, heading: string): Record<string, unknown> {
  const section = prompt.split(heading)[1];
  if (!section) {
    throw new Error(`prompt is missing ${heading}`);
  }
  const match = /```json\n([\s\S]*?)\n```/.exec(section);
  if (!match) {
    throw new Error(`${heading} is missing a JSON fence`);
  }
  return JSON.parse(match[1]!) as Record<string, unknown>;
}

describe("target-system evolution contracts", () => {
  test("accepts the checked-in Hodor designed-state reference through production parsers", async () => {
    const fixtureText = await Bun.file(
      new URL("./fixtures/hodor-evolution-pack-v0.json", import.meta.url),
    ).text();
    const docsText = await Bun.file(
      new URL("../docs/examples/hodor-evolution-pack-v0.json", import.meta.url),
    ).text();
    expect(docsText).toBe(fixtureText);

    const references = [JSON.parse(fixtureText), JSON.parse(docsText)] as HodorEvolutionReference[];
    const reference = references[0]!;
    for (const candidateReference of references) {
      const parsedPack = parser("parseEvolutionPackV1")(
        candidateReference.evolutionPack,
        candidateReference.projectId,
      ) as EvolutionPackV1;
      expect(parsedPack.firstCandidate).toEqual({
        id: "hodor-spatial-risk-shadow-v0",
        mode: "shadow",
        allowedEvolutionTargets: ["artifact", "harness"],
        prohibitedEvolutionTargets: ["model"],
        sideEffectBudget: ZERO_SIDE_EFFECT_BUDGET,
      });
    }
    const pack = parser("parseEvolutionPackV1")(
      reference.evolutionPack,
      reference.projectId,
    ) as EvolutionPackV1;
    const hypothesis = parser("parseEvolutionCausalHypothesis")(
      reference.causalHypothesis,
    );
    const comparison = parser("parseEvolutionComparison")(
      reference.comparison,
    ) as EvolutionComparison;

    expect(reference.projectId).toBe(HODOR_REFERENCE_PROJECT_ID);
    expect(pack).toEqual(reference.evolutionPack);
    expect(hypothesis).toEqual(reference.causalHypothesis);
    expect(comparison).toEqual(reference.comparison);
    expect(pack.targetSystemId).toBe("hodor");
    expect(pack.knowledgeScope).toBe(`project:${HODOR_REFERENCE_PROJECT_ID}`);
    expect(pack.handoff).toMatchObject({ maturity: "designed", targetOwner: "hodor" });

    const optimizationTargets = new Set(
      pack.mutationSurfaces.map((surface) => surface.evolutionTarget),
    );
    expect(optimizationTargets).toEqual(new Set(["artifact", "harness"]));
    expect(optimizationTargets.has("model")).toBeFalse();
    expect(pack.firstCandidate).toMatchObject({
      mode: "shadow",
      allowedEvolutionTargets: ["artifact", "harness"],
      prohibitedEvolutionTargets: ["model"],
      sideEffectBudget: {
        paidUsd: 0,
        realProviderCalls: 0,
        pancatWrites: 0,
        productionPublishes: 0,
        realAssetDeletes: 0,
        crossProjectMemoryReads: 0,
        crossProjectMemoryWrites: 0,
      },
    });

    const splitRefs = [
      comparison.developmentEvidenceRefs,
      comparison.holdoutEvidenceRefs,
      comparison.unrelatedEvidenceRefs,
    ];
    expect(splitRefs.every((split) => split.length > 0)).toBeTrue();
    expect(new Set(splitRefs.flat()).size).toBe(splitRefs.flat().length);
    expect(comparison.equalBudget).toEqual({
      model: "fixture-replay-no-provider",
      reasoningEffort: "high",
      wallClockMs: 120_000,
      maxAttempts: 1,
      maxTokens: 20_000,
      toolPolicySha256: "b".repeat(64),
      concurrency: 1,
    });

    const forbiddenPaths = new Set(
      pack.mutationSurfaces.flatMap((surface) => surface.forbiddenPaths),
    );
    expect(forbiddenPaths).toEqual(new Set([
      "production/**",
      "providers/**",
      "credentials/**",
      "assets/production/**",
      "memory/cross-project/**",
    ]));
  });

  test("normalizes a strict zero-side-effect first candidate on an evolution pack", () => {
    const firstCandidate = validFirstCandidate();
    const parsed = parser("parseEvolutionPackV1")(
      { ...validEvolutionPack(), firstCandidate },
      PROJECT_ID,
    ) as EvolutionPackV1;

    expect(parsed.firstCandidate).toEqual(firstCandidate);
    expect(parser("parseEvolutionPackV1")(validEvolutionPack(), PROJECT_ID)).toEqual(
      validEvolutionPack(),
    );
  });

  test.each(Object.keys(ZERO_SIDE_EFFECT_BUDGET))(
    "rejects nonzero first-candidate side-effect budget: %s",
    (budgetKey) => {
      const firstCandidate = {
        ...validFirstCandidate(),
        sideEffectBudget: {
          ...validFirstCandidate().sideEffectBudget,
          [budgetKey]: 1,
        },
      };

      expect(() =>
        parser("parseEvolutionPackV1")(
          { ...validEvolutionPack(), firstCandidate },
          PROJECT_ID,
        ),
      ).toThrow(/zero|0|sideEffectBudget/i);
    },
  );

  test.each([
    [
      "model in allowed targets",
      { ...validFirstCandidate(), allowedEvolutionTargets: ["artifact", "model"] },
    ],
    [
      "missing model prohibition",
      { ...validFirstCandidate(), prohibitedEvolutionTargets: [] },
    ],
    ["unknown candidate field", { ...validFirstCandidate(), surprise: true }],
    [
      "unknown side-effect field",
      {
        ...validFirstCandidate(),
        sideEffectBudget: { ...ZERO_SIDE_EFFECT_BUDGET, networkWrites: 0 },
      },
    ],
    ["illegal mode", { ...validFirstCandidate(), mode: "active" }],
    [
      "duplicate allowed target",
      { ...validFirstCandidate(), allowedEvolutionTargets: ["artifact", "artifact"] },
    ],
    ["whitespace-polluted id", { ...validFirstCandidate(), id: " padded-candidate " }],
    [
      "whitespace-polluted target",
      { ...validFirstCandidate(), allowedEvolutionTargets: ["artifact", " harness"] },
    ],
    ["empty allowed targets", { ...validFirstCandidate(), allowedEvolutionTargets: [] }],
    [
      "oversized allowed targets",
      {
        ...validFirstCandidate(),
        allowedEvolutionTargets: Array.from(
          { length: 101 },
          (_, index) => (index % 2 === 0 ? "artifact" : "harness"),
        ),
      },
    ],
    ["oversized id", { ...validFirstCandidate(), id: "x".repeat(257) }],
  ])("rejects invalid first-candidate contract: %s", (_name, firstCandidate) => {
    expect(() =>
      parser("parseEvolutionPackV1")(
        { ...validEvolutionPack(), firstCandidate },
        PROJECT_ID,
      ),
    ).toThrow();
  });

  test.each([
    ["model optimization", (reference: HodorEvolutionReference) => {
      reference.evolutionPack.mutationSurfaces[0]!.evolutionTarget = "model";
    }],
    ["cross-project surface", (reference: HodorEvolutionReference) => {
      reference.evolutionPack.mutationSurfaces[0]!.projectId = "project_other";
    }],
    ["path escape", (reference: HodorEvolutionReference) => {
      reference.evolutionPack.mutationSurfaces[0]!.allowedPaths = ["../Hodor/hodor-web/**"];
    }],
  ])("rejects unsafe Hodor reference mutations: %s", async (_name, mutate) => {
    const reference = await hodorEvolutionReference();
    mutate(reference);

    expect(() =>
      parser("parseEvolutionPackV1")(reference.evolutionPack, reference.projectId),
    ).toThrow();
  });

  test("keeps ordinary design proposals backward compatible", () => {
    const action = proposeDesignAction({
      projectId: PROJECT_ID,
      title: "Keep bounded delivery",
      proposal: ordinaryProposal(),
    });

    expect(action.payload.proposal).toEqual(ordinaryProposal());
  });

  test("keeps stored version-one through version-three evolution proposals readable", () => {
    const legacyPack = { ...validEvolutionPack(), version: 3 };
    const legacyProposal: DesignProposalData = {
      ...ordinaryProposal(),
      evolutionPack: legacyPack,
      causalHypothesis: validCausalHypothesis(),
      evaluationContract: {
        ...ordinaryProposal().evaluationContract,
        comparison: validComparison(),
      },
    };
    const action = proposeDesignAction({
      projectId: PROJECT_ID,
      title: "Read legacy target evolution",
      proposal: legacyProposal,
    });
    expect(action.payload.proposal).toEqual(legacyProposal);
  });

  test("normalizes and preserves a complete target-evolution proposal", () => {
    const action = proposeDesignAction({
      projectId: PROJECT_ID,
      title: "Design Hodor evolution",
      proposal: validEvolutionProposal(),
    });

    expect(action.payload.proposal).toMatchObject(validEvolutionProposal());
  });

  test("requires and preserves all version-four delivery contracts", () => {
    const proposal = validEvolutionProposal();
    const action = proposeDesignAction({
      projectId: PROJECT_ID,
      title: "Design Hodor evolution delivery contracts",
      proposal,
    });

    expect(action.payload.proposal).toEqual(proposal);

    for (const key of [
      "episodeCollectionContract",
      "maturityGateContract",
      "productionEpisodePrivacyReceiptContract",
      "promotionReceiptContract",
      "rollbackContract",
    ] as const) {
      const missing = structuredClone(proposal) as DesignProposalData & Record<string, unknown>;
      delete missing[key];
      expect(() => proposeDesignAction({
        projectId: PROJECT_ID,
        title: `Missing ${key}`,
        proposal: missing,
      })).toThrow(/delivery contracts|complete group/i);
    }
  });

  test("rejects unknown fields and invalid hashes inside delivery contracts", () => {
    const proposal = validEvolutionProposal() as DesignProposalData & Record<string, unknown>;
    for (const key of [
      "episodeCollectionContract",
      "maturityGateContract",
      "productionEpisodePrivacyReceiptContract",
      "promotionReceiptContract",
      "rollbackContract",
    ] as const) {
      const contract = proposal[key] as unknown as Record<string, unknown>;
      expect(() => proposeDesignAction({
        projectId: PROJECT_ID,
        title: `Unknown ${key} field`,
        proposal: {
          ...proposal,
          [key]: { ...contract, surprise: true },
        } as unknown as DesignProposalData,
      })).toThrow(/unknown field|surprise/i);
    }

    const privacy = proposal.productionEpisodePrivacyReceiptContract as unknown as Record<string, unknown>;
    const privacyReview = privacy.privacyReview as Record<string, unknown>;
    expect(() => proposeDesignAction({
      projectId: PROJECT_ID,
      title: "Invalid privacy policy hash",
      proposal: {
        ...proposal,
        productionEpisodePrivacyReceiptContract: {
          ...privacy,
          privacyReview: { ...privacyReview, policySha256: "ABC123" },
        },
      } as DesignProposalData,
    })).toThrow(/policySha256|sha256/i);
  });

  test("rejects isolated delivery contracts and reserved aliases instead of dropping them", () => {
    const rollbackContract = validEvolutionProposal().rollbackContract;
    expect(() => proposeDesignAction({
      projectId: PROJECT_ID,
      title: "Isolated rollback contract",
      proposal: { ...ordinaryProposal(), rollbackContract },
    })).toThrow(/target evolution|complete group|evolutionPack/i);

    const complete = validEvolutionProposal() as DesignProposalData & Record<string, unknown>;
    complete.privacyReceiptContract = complete.productionEpisodePrivacyReceiptContract;
    expect(() => proposeDesignAction({
      projectId: PROJECT_ID,
      title: "Reserved delivery alias",
      proposal: complete,
    })).toThrow(/privacyReceiptContract|alias|unsupported/i);
  });

  test("keeps the privacy block contract-only and rejects forged approval semantics", () => {
    const proposal = validEvolutionProposal() as DesignProposalData & Record<string, unknown>;
    const privacy = proposal.productionEpisodePrivacyReceiptContract as unknown as Record<string, unknown>;
    const privacyReview = privacy.privacyReview as Record<string, unknown>;
    expect(privacy.mode).toBe("requirements-only");
    expect(privacyReview.requiredStatus).toBe("approved");
    expect(privacyReview.status).toBeUndefined();
    expect(() => proposeDesignAction({
      projectId: PROJECT_ID,
      title: "Forged privacy approval",
      proposal: {
        ...proposal,
        productionEpisodePrivacyReceiptContract: {
          ...privacy,
          privacyReview: { ...privacyReview, requiredStatus: undefined, status: "approved" },
        },
      } as unknown as DesignProposalData,
    })).toThrow(/requiredStatus|unknown field|status/i);
  });

  test("rejects mutable exact targets and sensitive free text in delivery contracts", () => {
    for (const target of [
      "main",
      "branch:main",
      "git:refs/heads/main",
      "git:refs/tags/release-v1",
      "git:refs/remotes/origin/release-v1",
      "ref:latest",
      "artifact:unversioned-target",
    ]) {
      const mutable = structuredClone(validEvolutionProposal()) as unknown as Record<string, unknown>;
      const promotion = mutable.promotionReceiptContract as Record<string, unknown>;
      const rollback = mutable.rollbackContract as Record<string, unknown>;
      mutable.promotionReceiptContract = { ...promotion, exactTargetRef: target };
      mutable.rollbackContract = { ...rollback, exactTargetRef: target };
      expect(() => proposeDesignAction({
        projectId: PROJECT_ID,
        title: "Mutable target",
        proposal: mutable as unknown as DesignProposalData,
      })).toThrow(/exact|immutable|typed|versioned|content-addressed/i);
    }

    for (const mutate of [
      (proposal: Record<string, unknown>) => {
        const contract = proposal.rollbackContract as Record<string, unknown>;
        contract.triggers = [{ id: "guard-regression", condition: "Authorization: Bearer SECRET_VALUE" }];
      },
      (proposal: Record<string, unknown>) => {
        const contract = proposal.maturityGateContract as Record<string, unknown>;
        const stages = structuredClone(contract.stages) as Array<Record<string, unknown>>;
        stages[0]!.guardMetrics = ["api_key=SECRET_VALUE"];
        contract.stages = stages;
      },
      (proposal: Record<string, unknown>) => {
        const contract = proposal.productionEpisodePrivacyReceiptContract as Record<string, unknown>;
        contract.rejectionConditions = ["token: SECRET_VALUE"];
      },
    ]) {
      const proposal = structuredClone(validEvolutionProposal()) as unknown as Record<string, unknown>;
      mutate(proposal);
      expect(() => proposeDesignAction({
        projectId: PROJECT_ID,
        title: "Sensitive delivery text",
        proposal: proposal as unknown as DesignProposalData,
      })).toThrow(/sensitive|credential/i);
    }
  });

  test.each([
    ["episode source enum", (proposal: Record<string, unknown>) => {
      const contract = proposal.episodeCollectionContract as Record<string, unknown>;
      proposal.episodeCollectionContract = { ...contract, allowedSources: ["agent-generated"] };
    }],
    ["maturity pack hash", (proposal: Record<string, unknown>) => {
      const contract = proposal.maturityGateContract as Record<string, unknown>;
      const packRef = contract.packRef as Record<string, unknown>;
      proposal.maturityGateContract = { ...contract, packRef: { ...packRef, contentSha256: SHA_C } };
    }],
    ["promotion variant identity", (proposal: Record<string, unknown>) => {
      const contract = proposal.promotionReceiptContract as Record<string, unknown>;
      proposal.promotionReceiptContract = { ...contract, toVariantId: contract.fromVariantId };
    }],
    ["promotion exact target", (proposal: Record<string, unknown>) => {
      const promotion = proposal.promotionReceiptContract as Record<string, unknown>;
      const rollback = proposal.rollbackContract as Record<string, unknown>;
      proposal.promotionReceiptContract = { ...promotion, exactTargetRef: "HEAD" };
      proposal.rollbackContract = { ...rollback, exactTargetRef: "HEAD" };
    }],
    ["rollback idempotency key", (proposal: Record<string, unknown>) => {
      const contract = proposal.rollbackContract as Record<string, unknown>;
      proposal.rollbackContract = { ...contract, idempotencyKey: "token:rollback-secret" };
    }],
  ])("rejects invalid delivery contract value: %s", (_name, mutate) => {
    const proposal = structuredClone(validEvolutionProposal()) as unknown as Record<string, unknown>;
    mutate(proposal);
    expect(() => proposeDesignAction({
      projectId: PROJECT_ID,
      title: "Invalid delivery contract",
      proposal: proposal as unknown as DesignProposalData,
    })).toThrow();
  });

  test.each([
    ["pack only", { evolutionPack: validEvolutionPack() }],
    ["hypothesis only", { causalHypothesis: validCausalHypothesis() }],
    [
      "comparison only",
      {
        evaluationContract: {
          ...ordinaryProposal().evaluationContract,
          comparison: validComparison(),
        },
      },
    ],
    [
      "pack and hypothesis without comparison",
      { evolutionPack: validEvolutionPack(), causalHypothesis: validCausalHypothesis() },
    ],
  ])("rejects partial evolution proposal groups: %s", (_name, additions) => {
    const proposal = {
      ...ordinaryProposal(),
      ...additions,
      evaluationContract:
        (additions as Record<string, unknown>).evaluationContract ?? ordinaryProposal().evaluationContract,
    };

    expect(() =>
      proposeDesignAction({
        projectId: PROJECT_ID,
        title: "Incomplete evolution proposal",
        proposal: proposal as unknown as DesignProposalData,
      }),
    ).toThrow(/evolutionPack.*causalHypothesis.*comparison|complete group/i);
  });

  test.each([
    ["unknown pack field", { ...validEvolutionPack(), surprise: true }, validComparison()],
    [
      "unknown nested field",
      {
        ...validEvolutionPack(),
        objective: { ...validEvolutionPack().objective, surprise: true },
      },
      validComparison(),
    ],
    [
      "empty development split",
      validEvolutionPack(),
      { ...validComparison(), developmentEvidenceRefs: [] },
    ],
    [
      "duplicate evidence across splits",
      validEvolutionPack(),
      { ...validComparison(), holdoutEvidenceRefs: ["episode_development_1"] },
    ],
    [
      "bad corpus hash",
      validEvolutionPack(),
      { ...validComparison(), corpusSnapshotSha256: "ABC123" },
    ],
    [
      "bad budget",
      validEvolutionPack(),
      { ...validComparison(), equalBudget: { ...validComparison().equalBudget, maxAttempts: 0 } },
    ],
  ])("rejects invalid strict evolution data: %s", (_name, pack, comparison = validComparison()) => {
    expect(() =>
      proposeDesignAction({
        projectId: PROJECT_ID,
        title: "Invalid evolution proposal",
        proposal: {
          ...ordinaryProposal(),
          evolutionPack: pack,
          causalHypothesis: validCausalHypothesis(),
          evaluationContract: {
            ...ordinaryProposal().evaluationContract,
            comparison,
          },
        } as unknown as DesignProposalData,
      }),
    ).toThrow();
  });

  test.each([
    [
      "invalid signal kind",
      {
        ...validEvolutionPack(),
        observation: { signalSources: [{ id: "x", kind: "telemetry" }] },
      },
    ],
    [
      "duplicate signal source id",
      {
        ...validEvolutionPack(),
        observation: {
          signalSources: [
            { id: "same", kind: "repository" },
            { id: "same", kind: "external-ref" },
          ],
        },
      },
    ],
    [
      "cross-project mutation",
      {
        ...validEvolutionPack(),
        mutationSurfaces: [
          { ...validEvolutionPack().mutationSurfaces[0], projectId: "project_other" },
        ],
      },
    ],
    [
      "model weights",
      {
        ...validEvolutionPack(),
        mutationSurfaces: [
          { ...validEvolutionPack().mutationSurfaces[0], evolutionTarget: "model" },
        ],
      },
    ],
    [
      "unknown mutation layer",
      {
        ...validEvolutionPack(),
        mutationSurfaces: [
          { ...validEvolutionPack().mutationSurfaces[0], layer: "database" },
        ],
      },
    ],
    [
      "advanced maturity",
      {
        ...validEvolutionPack(),
        handoff: { ...validEvolutionPack().handoff, maturity: "shadowing" },
      },
    ],
    [
      "wrong knowledge scope",
      { ...validEvolutionPack(), knowledgeScope: "global" },
    ],
  ])("rejects unsafe milestone-one evolution packs: %s", (_name, pack) => {
    expect(() =>
      proposeDesignAction({
        projectId: PROJECT_ID,
        title: "Unsafe evolution proposal",
        proposal: {
          ...ordinaryProposal(),
          evolutionPack: pack,
          causalHypothesis: validCausalHypothesis(),
          evaluationContract: {
            ...ordinaryProposal().evaluationContract,
            comparison: validComparison(),
          },
        } as unknown as DesignProposalData,
      }),
    ).toThrow();
  });

  test("strict evolution pack parsing rejects the transient host receipt adapter alias", () => {
    expect(() => targetEvolutionModule.parseEvolutionPackV1({
      ...validEvolutionPack(),
      observation: { signalSources: [{ id: "host-receipt", kind: "host-receipt" }] },
    }, PROJECT_ID)).toThrow(/kind must be one of/);
  });

  test.each([
    ["invalid failure class", { ...validCausalHypothesis(), failureClass: "test-failure" }, validComparison()],
    ["empty mechanism", { ...validCausalHypothesis(), mechanism: "" }, validComparison()],
    ["unknown hypothesis field", { ...validCausalHypothesis(), surprise: true }, validComparison()],
    [
      "invalid reasoning effort",
      validCausalHypothesis(),
      {
        ...validComparison(),
        equalBudget: { ...validComparison().equalBudget, reasoningEffort: "extreme" },
      },
    ],
    [
      "unknown comparison field",
      validCausalHypothesis(),
      { ...validComparison(), surprise: true },
    ],
  ])("rejects invalid causal or comparison contracts: %s", (_name, causal, comparison = validComparison()) => {
    expect(() =>
      proposeDesignAction({
        projectId: PROJECT_ID,
        title: "Invalid causal contract",
        proposal: {
          ...ordinaryProposal(),
          evolutionPack: validEvolutionPack(),
          causalHypothesis: causal,
          evaluationContract: {
            ...ordinaryProposal().evaluationContract,
            comparison,
          },
        } as unknown as DesignProposalData,
      }),
    ).toThrow();
  });

  test.each([
    ["control credential", { controlRef: "authorization_bearer_secret" }],
    ["development api key", { developmentEvidenceRefs: ["evidence_api_key_prod"] }],
    ["development dotted api key", { developmentEvidenceRefs: ["evidence:api.key-prod"] }],
    ["holdout token", { holdoutEvidenceRefs: ["evidence:token-prod"] }],
    ["unrelated password", { unrelatedEvidenceRefs: ["password_prod"] }],
    ["non-opaque syntax", { controlRef: "control@example.com" }],
  ])("rejects unsafe EvolutionComparison ref: %s", (_name, override) => {
    expect(() => parser("parseEvolutionComparison")({ ...validComparison(), ...override })).toThrow(
      /opaque|credential|sensitive|ref/i,
    );
  });

  test.each([
    [
      "signal source credential",
      {
        observation: {
          signalSources: [{ id: "source_api_key_prod", kind: "repository" }],
        },
      },
    ],
    [
      "portability secret",
      {
        portability: {
          ...validEvolutionPack().portability,
          genericizationEvidence: ["evidence:secret-prod"],
        },
      },
    ],
  ])("rejects unsafe prompt-visible evolution pack ref: %s", (_name, override) => {
    const pack = { ...validEvolutionPack(), ...override };
    expect(() => parser("parseEvolutionPackV1")(pack, PROJECT_ID)).toThrow(
      /opaque|credential|sensitive|ref/i,
    );
  });

  test("parses a clean EvolutionInstance", () => {
    const value = {
      schemaVersion: 1,
      mode: "design-target",
      kernelProjectId: "project_ouroboros",
      targetProjectId: PROJECT_ID,
      cycle: { kind: "bootstrap", index: 0 },
      pack: { id: "hodor-evolution-pack", version: 1, contentSha256: SHA_A },
    };

    expect(parser("parseEvolutionInstance")(value)).toEqual(value);
  });

  test.each([
    ["unknown top-level field", { surprise: true }],
    ["unknown cycle field", { cycle: { kind: "bootstrap", index: 0, surprise: true } }],
    ["negative cycle index", { cycle: { kind: "bootstrap", index: -1 } }],
    ["bad pack hash", { pack: { id: "pack", version: 1, contentSha256: "BAD" } }],
  ])("rejects polluted EvolutionInstance: %s", (_name, override) => {
    const value = {
      schemaVersion: 1,
      mode: "design-target",
      kernelProjectId: "project_ouroboros",
      targetProjectId: PROJECT_ID,
      cycle: { kind: "bootstrap", index: 0 },
      pack: { id: "hodor-evolution-pack", version: 1, contentSha256: SHA_A },
      ...override,
    };

    expect(() => parser("parseEvolutionInstance")(value)).toThrow();
  });

  test.each([
    [
      "split reference with surrounding whitespace",
      {
        comparison: {
          ...validComparison(),
          holdoutEvidenceRefs: [" episode_development_1"],
        },
      },
    ],
    [
      "causal mechanism with surrounding whitespace",
      { causalHypothesis: { ...validCausalHypothesis(), mechanism: " padded mechanism " } },
    ],
    [
      "mutation identity with surrounding whitespace",
      {
        pack: {
          ...validEvolutionPack(),
          mutationSurfaces: [
            { ...validEvolutionPack().mutationSurfaces[0], id: " padded-id " },
          ],
        },
      },
    ],
  ])("rejects whitespace-polluted target-evolution identity: %s", (_name, overrides) => {
    const record = overrides as Record<string, Record<string, unknown>>;
    const comparison = record.comparison ?? validComparison();
    const causalHypothesis = record.causalHypothesis ?? validCausalHypothesis();
    const evolutionPack = record.pack ?? validEvolutionPack();
    expect(() =>
      proposeDesignAction({
        projectId: PROJECT_ID,
        title: "Whitespace-polluted evolution proposal",
        proposal: {
          ...ordinaryProposal(),
          evolutionPack,
          causalHypothesis,
          evaluationContract: {
            ...ordinaryProposal().evaluationContract,
            comparison,
          },
        } as unknown as DesignProposalData,
      }),
    ).toThrow(/whitespace|non-empty string/i);
  });

  test("rejects whitespace-polluted EvolutionInstance identities", () => {
    expect(() =>
      parser("parseEvolutionInstance")({
        schemaVersion: 1,
        mode: "design-target",
        kernelProjectId: " project_ouroboros",
        targetProjectId: PROJECT_ID,
        cycle: { kind: "bootstrap", index: 0 },
      }),
    ).toThrow(/whitespace/i);
  });

  test.each([
    [
      "development split",
      { developmentEvidenceRefs: Array.from({ length: 201 }, (_, index) => `dev_${index}`) },
    ],
    ["wall clock", { equalBudget: { ...validComparison().equalBudget, wallClockMs: 86_400_001 } }],
    ["attempts", { equalBudget: { ...validComparison().equalBudget, maxAttempts: 21 } }],
    ["tokens", { equalBudget: { ...validComparison().equalBudget, maxTokens: 2_000_001 } }],
    ["concurrency", { equalBudget: { ...validComparison().equalBudget, concurrency: 33 } }],
  ])("rejects oversized comparison data: %s", (_name, override) => {
    const comparison = { ...validComparison(), ...override };
    expect(() => parser("parseEvolutionComparison")(comparison)).toThrow(/at most|maximum/i);
  });

  test.each([
    [
      "signal sources",
      {
        observation: {
          signalSources: Array.from({ length: 101 }, (_, index) => ({
            id: `signal_${index}`,
            kind: "repository",
          })),
        },
      },
    ],
    [
      "mutation surfaces",
      {
        mutationSurfaces: Array.from({ length: 101 }, (_, index) => ({
          ...validEvolutionPack().mutationSurfaces[0],
          id: `surface_${index}`,
        })),
      },
    ],
    [
      "allowed paths",
      {
        mutationSurfaces: [
          {
            ...validEvolutionPack().mutationSurfaces[0],
            allowedPaths: Array.from({ length: 201 }, (_, index) => `src/${index}.ts`),
          },
        ],
      },
    ],
    [
      "forbidden paths",
      {
        mutationSurfaces: [
          {
            ...validEvolutionPack().mutationSurfaces[0],
            forbiddenPaths: Array.from({ length: 201 }, (_, index) => `private/${index}.json`),
          },
        ],
      },
    ],
    [
      "objective items",
      {
        objective: {
          ...validEvolutionPack().objective,
          nonGoals: Array.from({ length: 101 }, (_, index) => `non-goal ${index}`),
        },
      },
    ],
    [
      "major text",
      {
        objective: {
          ...validEvolutionPack().objective,
          domainOutcomes: ["x".repeat(4_001)],
        },
      },
    ],
  ])("rejects oversized evolution pack data: %s", (_name, override) => {
    const pack = { ...validEvolutionPack(), ...override };
    expect(() => parser("parseEvolutionPackV1")(pack, PROJECT_ID)).toThrow(/at most|maximum/i);
  });

  test.each([
    ["absolute path", "/etc/passwd"],
    ["parent traversal", "src/../secrets.json"],
    ["backslash", "src\\policy.json"],
    ["NUL byte", "src/\0policy.json"],
    ["empty segment", "src//policy.json"],
    ["current-directory segment", "./src/policy.json"],
    ["overlong path", `src/${"x".repeat(509)}`],
  ])("rejects unsafe project-relative mutation scope: %s", (_name, unsafePath) => {
    const pack = {
      ...validEvolutionPack(),
      mutationSurfaces: [
        {
          ...validEvolutionPack().mutationSurfaces[0],
          allowedPaths: [unsafePath],
        },
      ],
    };
    expect(() => parser("parseEvolutionPackV1")(pack, PROJECT_ID)).toThrow(/project-relative|path/i);
  });

  test("accepts a normal relative glob mutation scope", () => {
    expect(
      parser("parseEvolutionPackV1")(
        {
          ...validEvolutionPack(),
          mutationSurfaces: [
            {
              ...validEvolutionPack().mutationSurfaces[0],
              allowedPaths: ["src/**"],
            },
          ],
        },
        PROJECT_ID,
      ),
    ).toMatchObject({ mutationSurfaces: [{ allowedPaths: ["src/**"] }] });
  });

  test.each([
    ["artifact workflow", "artifact", "workflow"],
    ["harness artifact", "harness", "artifact"],
  ])("rejects invalid evolution target/layer combination: %s", (_name, evolutionTarget, layer) => {
    const pack = {
      ...validEvolutionPack(),
      mutationSurfaces: [
        {
          ...validEvolutionPack().mutationSurfaces[0],
          evolutionTarget,
          layer,
        },
      ],
    };
    expect(() => parser("parseEvolutionPackV1")(pack, PROJECT_ID)).toThrow(/layer.*evolutionTarget|combination/i);
  });

  test("exports conservative target-evolution capacity limits", () => {
    expect((harnessModule as unknown as Record<string, unknown>).TARGET_EVOLUTION_LIMITS).toEqual({
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
  });

  test("keeps the Designer prompt compact and explicit about matched evolution evidence", () => {
    const prompt = designerPrompt();

    expect(prompt).toContain("evolutionPack");
    expect(prompt).toContain("causalHypothesis");
    expect(prompt).toContain("evaluationContract.comparison");
    expect(prompt).toContain("all three");
    expect(prompt).toContain("all five strict delivery contracts");
    expect(prompt).toContain("episodeCollectionContract");
    expect(prompt).toContain("maturityGateContract");
    expect(prompt).toContain("productionEpisodePrivacyReceiptContract");
    expect(prompt).toContain("promotionReceiptContract");
    expect(prompt).toContain("rollbackContract");
    expect(prompt).toContain("equal budget");
    expect(prompt).toContain("holdout");
    expect(prompt).toContain("unrelated");
    expect(prompt).toContain("model");
    expect(prompt).toContain("prohibited");
    expect(prompt).not.toContain("episode_holdout_1");
    expect(prompt.length).toBeLessThan(20_000);
  });

  test("maps mutation surface targets and layers without overloading either enum", () => {
    const prompt = designerPrompt();
    const extension = jsonFenceAfter(prompt, "## Target System Evolution Proposal Contract");
    const pack = extension.evolutionPack as EvolutionPackV1;

    expect(prompt).toContain('evolutionTarget must be exactly "artifact" or "harness"');
    expect(prompt).toContain('artifact allows layer "artifact", "code", or "policy"');
    expect(prompt).toContain('harness allows layer "workflow", "prompt", "tool", "policy", or "code"');
    expect(prompt).toContain('Never use "workflow", "prompt", "tool", "policy", or "code" as evolutionTarget');
    expect(pack.mutationSurfaces).toContainEqual(expect.objectContaining({
      evolutionTarget: "artifact",
      layer: "policy",
    }));
    expect(pack.mutationSurfaces).toContainEqual(expect.objectContaining({
      evolutionTarget: "harness",
      layer: "workflow",
    }));
  });

  test("requires comparison to merge into the proposal's single evaluation contract", () => {
    const prompt = designerPrompt();

    expect(prompt).toContain("exactly one proposal.evaluationContract object");
    expect(prompt).toContain("comparison beside successMetrics and requiredEvidence");
    expect(prompt).toContain("Never place evaluationContract inside evolutionPack");
  });

  test("requires the maturity gate to hash the final normalized evolution pack", () => {
    const prompt = designerPrompt();

    expect(prompt).toContain("recompute maturityGateContract.packRef.contentSha256");
    expect(prompt).toContain("final normalized evolutionPack");
    expect(prompt).toContain("Never copy the example pack hash after changing the pack");
  });

  test("restricts proposal authority evidence to durable active strategy signals", () => {
    const prompt = designerPrompt();

    expect(prompt).toContain("proposal.evidenceRefs is authority input, not a bibliography");
    expect(prompt).toContain("only durable active strategy signal IDs from this target project");
    expect(prompt).toContain("Do not put proposal IDs, decision IDs, Git SHAs, or free-form evidence labels");
  });

  test("provides one standalone exact evolution extension fragment accepted by the parser", () => {
    const prompt = designerPrompt();
    const extension = jsonFenceAfter(prompt, "## Target System Evolution Proposal Contract");
    const requiredOutput = jsonFenceAfter(prompt, "## Required Output");
    const actions = requiredOutput.actions as Array<Record<string, unknown>>;
    const proposals = actions.filter((action) => action.type === "proposeDesign");
    expect(proposals).toHaveLength(1);
    expect(extension.type).toBeUndefined();
    expect(JSON.stringify(extension)).not.toContain("<project_id>");
    expect(JSON.stringify(extension)).not.toContain("<charter_id>");

    const basePayload = proposals[0]!.payload as Record<string, unknown>;
    const baseProposal = basePayload.proposal as Record<string, unknown>;
    const extensionEvaluation = extension.evaluationContract as Record<string, unknown>;
    const proposal = {
      ...baseProposal,
      ...extension,
      evaluationContract: {
        ...(baseProposal.evaluationContract as Record<string, unknown>),
        ...extensionEvaluation,
      },
    };

    expect(() =>
      proposeDesignAction({
        projectId: PROJECT_ID,
        title: basePayload.title as string,
        proposal: proposal as unknown as DesignProposalData,
      }),
    ).not.toThrow();
    const serializedExtension = JSON.stringify(extension).toLowerCase();
    expect(serializedExtension).toContain("holdoutevidencerefs");
    expect(serializedExtension).not.toContain("holdout content");
    expect(serializedExtension).not.toContain("holdout result");
  });
});

describe("target-system evolution runtime records", () => {
  test("exports content-address helpers with stable canonical key ordering", () => {
    const hashValue = parser("canonicalEvolutionValueSha256");
    const hashRecord = parser("canonicalEvolutionRecordSha256");
    const expectedId = parser("expectedEvolutionRecordId");
    const left = { z: [3, { b: 2, a: 1 }], a: "value" };
    const right = { a: "value", z: [3, { a: 1, b: 2 }] };
    const localHash = createHash("sha256")
      .update(JSON.stringify(canonicalTestValue(left)), "utf8")
      .digest("hex");

    expect(hashValue(left)).toBe(localHash);
    expect(hashValue(right)).toBe(localHash);
    expect(hashRecord({ id: "ignored_a", ...left })).toBe(localHash);
    expect(hashRecord({ ...right, id: "ignored_b" })).toBe(localHash);
    expect(expectedId("profile", { id: "ignored", ...left })).toBe(`profile_${localHash}`);
    expect(expectedId("episode", left)).toBe(`episode_${localHash}`);
    expect(expectedId("variant", left)).toBe(`variant_${localHash}`);
    expect(expectedId("experiment", left)).toBe(`experiment_${localHash}`);
    expect(expectedId("receipt", left)).toBe(`receipt_${localHash}`);
  });

  test.each([
    ["array root", []],
    ["undefined value", { value: undefined }],
    ["non-finite value", { value: Number.POSITIVE_INFINITY }],
    ["non-JSON value", { value: 1n }],
  ])("rejects invalid canonical evolution hash input: %s", (_name, value) => {
    expect(() => parser("canonicalEvolutionRecordSha256")(value)).toThrow(/JSON|object|finite/i);
  });

  test("parses valid project-bound content-addressed runtime records", () => {
    expect(parser("parseEvolutionProfile")(validEvolutionProfile(), PROJECT_ID)).toEqual(
      validEvolutionProfile(),
    );
    expect(parser("parseProductionEpisode")(validProductionEpisode(), PROJECT_ID)).toEqual(
      validProductionEpisode(),
    );
    expect(parser("parseHarnessVariant")(validHarnessVariant("candidate"), PROJECT_ID)).toEqual(
      validHarnessVariant("candidate"),
    );
    expect(parser("parseMatchedExperiment")(validMatchedExperiment(), PROJECT_ID)).toEqual(
      validMatchedExperiment(),
    );
    expect(draftParser("parseDraftPromotionReceipt")(validPromotionReceipt(), PROJECT_ID)).toEqual(
      validPromotionReceipt(),
    );
  });

  test("keeps PromotionReceipt draft-only and off the harness package surface", () => {
    expect(
      (harnessModule as unknown as Record<string, unknown>).parsePromotionReceipt,
    ).toBeUndefined();
    expect(
      (targetEvolutionModule as unknown as Record<string, unknown>).parseDraftPromotionReceipt,
    ).toBeFunction();
  });

  test("registers only declared runtime maturity without activation placeholders", () => {
    expect(() => parser("parseEvolutionProfile")(validEvolutionProfile(), PROJECT_ID)).not.toThrow();
    for (const unsafeMaturity of [
      { runtimeMaturity: "prepared" },
      { runtimeMaturity: "instrumented" },
      { maturity: "instrumented" },
      { activatedAt: "2026-08-09T01:02:03Z" },
      { activatedByReceipt: `receipt_${"a".repeat(64)}` },
    ]) {
      const profile = readdress("profile", { ...validEvolutionProfile(), ...unsafeMaturity });
      expect(() => parser("parseEvolutionProfile")(profile, PROJECT_ID)).toThrow(
        /runtimeMaturity|unsupported fields/i,
      );
    }
  });

  test.each([
    ["non-opaque source ref", () => ({ ...validProductionEpisode(), sourceRef: "ref@example.com" }), "episode"],
    ["authorization ref", () => ({ ...validProductionEpisode(), policyRef: "authorization:bearer-secret" }), "episode"],
    ["token evidence", () => ({ ...validProductionEpisode(), evidenceRefs: ["evidence:token-prod"] }), "episode"],
    [
      "credential reviewer",
      () => ({
        ...validProductionEpisode(),
        privacyReview: {
          ...validProductionEpisode().privacyReview,
          reviewerRef: "reviewer:credential-prod",
        },
      }),
      "episode",
    ],
    [
      "password retention ref",
      () => ({
        ...validProductionEpisode(),
        privacyReview: {
          ...validProductionEpisode().privacyReview,
          retentionPolicyRef: "retention:password-prod",
        },
      }),
      "episode",
    ],
    [
      "api key privacy evidence",
      () => ({
        ...validProductionEpisode(),
        privacyReview: {
          ...validProductionEpisode().privacyReview,
          evidenceRefs: ["evidence:api-key-prod"],
        },
      }),
      "episode",
    ],
    [
      "secret variant evidence",
      () => ({
        ...validHarnessVariant("candidate"),
        createdFromEvidenceRefs: ["evidence:secret-prod"],
      }),
      "variant",
    ],
    [
      "bearer experiment evidence",
      () => ({ ...validMatchedExperiment(), evidenceRefs: ["evidence:bearer-prod"] }),
      "experiment",
    ],
  ])("rejects non-opaque or credential-like runtime ref: %s", (_name, makeRecord, kind) => {
    const record = readdress(kind as EvolutionRecordKind, makeRecord() as Record<string, unknown>);
    const parse = kind === "episode" ? "parseProductionEpisode"
      : kind === "variant" ? "parseHarnessVariant"
        : "parseMatchedExperiment";
    expect(() => parser(parse)(record, PROJECT_ID)).toThrow(/opaque|credential|sensitive|ref/i);
  });

  test.each(["src/**", "src/file?.ts", "src/[ab].ts", "src/{a,b}.ts", "!src/file.ts"])(
    "rejects glob-like HarnessVariant changedPath %s",
    (changedPath) => {
      const variant = readdress("variant", {
        ...validHarnessVariant("candidate"),
        changedPaths: [changedPath],
      });
      expect(() => parser("parseHarnessVariant")(variant, PROJECT_ID)).toThrow(/exact|glob|path/i);
    },
  );

  test.each([
    ["profile", "parseEvolutionProfile", validEvolutionProfile],
    ["episode", "parseProductionEpisode", validProductionEpisode],
    ["variant", "parseHarnessVariant", () => validHarnessVariant("candidate")],
    ["experiment", "parseMatchedExperiment", validMatchedExperiment],
    ["receipt", "parseDraftPromotionReceipt", validPromotionReceipt],
  ])("rejects unknown fields and mismatched content IDs on %s", (kind, parserName, makeRecord) => {
    const record = makeRecord() as Record<string, unknown>;
    expect(() => runtimeRecordParser(parserName)({ ...record, surprise: true }, PROJECT_ID)).toThrow(
      /unsupported fields/i,
    );
    expect(() => runtimeRecordParser(parserName)({ ...record, id: `${kind}_${"f".repeat(64)}` }, PROJECT_ID)).toThrow(
      /content-addressed|id/i,
    );
  });

  test.each([
    ["profile", "parseEvolutionProfile", validEvolutionProfile],
    ["episode", "parseProductionEpisode", validProductionEpisode],
    ["variant", "parseHarnessVariant", () => validHarnessVariant("candidate")],
    ["experiment", "parseMatchedExperiment", validMatchedExperiment],
    ["receipt", "parseDraftPromotionReceipt", validPromotionReceipt],
  ])("requires schemaVersion 1 and strict identity text on %s", (kind, parserName, makeRecord) => {
    const record = makeRecord() as Record<string, unknown>;
    const wrongVersion = readdress(kind as EvolutionRecordKind, { ...record, schemaVersion: 2 });
    expect(() => runtimeRecordParser(parserName)(wrongVersion, PROJECT_ID)).toThrow(/schemaVersion/i);
    const paddedProject = readdress(kind as EvolutionRecordKind, {
      ...record,
      projectId: ` ${PROJECT_ID}`,
    });
    expect(() => runtimeRecordParser(parserName)(paddedProject, ` ${PROJECT_ID}`)).toThrow(/whitespace/i);
  });

  test("requires a non-empty unpadded ProductionEpisode sourceRef", () => {
    for (const sourceRef of ["", " episode_development_1 "]) {
      const episode = readdress("episode", { ...validProductionEpisode(), sourceRef });
      expect(() => parser("parseProductionEpisode")(episode, PROJECT_ID)).toThrow(
        /non-empty|whitespace/i,
      );
    }
  });

  test.each([
    ["profile", "parseEvolutionProfile", validEvolutionProfile],
    ["episode", "parseProductionEpisode", validProductionEpisode],
    ["variant", "parseHarnessVariant", () => validHarnessVariant("candidate")],
    ["experiment", "parseMatchedExperiment", validMatchedExperiment],
    ["receipt", "parseDraftPromotionReceipt", validPromotionReceipt],
  ])("rejects cross-project %s records", (_kind, parserName, makeRecord) => {
    const record = makeRecord() as Record<string, unknown>;
    expect(() => runtimeRecordParser(parserName)(record, "project_other")).toThrow(/projectId/i);
    expect(() => runtimeRecordParser(parserName)({ ...record, targetProjectId: PROJECT_ID }, PROJECT_ID)).toThrow(
      /unsupported fields/i,
    );
  });

  test.each(["input", "output", "rawInput", "rawOutput", "prompt", "response"])(
    "rejects raw episode content field %s",
    (field) => {
      expect(() =>
        parser("parseProductionEpisode")(
          { ...validProductionEpisode(), [field]: "private raw content" },
          PROJECT_ID,
        ),
      ).toThrow(/unsupported fields/i);
    },
  );

  test.each(["heldoutContents", "heldoutResults", "holdoutContent", "holdoutResult"])(
    "rejects heldout content or result field %s",
    (field) => {
      expect(() =>
        parser("parseMatchedExperiment")(
          { ...validMatchedExperiment(), [field]: "leaked heldout material" },
          PROJECT_ID,
        ),
      ).toThrow(/unsupported fields/i);
    },
  );

  test.each([
    ["NaN metric", { metrics: { score: Number.NaN } }],
    ["infinite metric", { metrics: { score: Number.POSITIVE_INFINITY } }],
    [
      "negative side-effect counter",
      { sideEffectCounters: { ...ZERO_SIDE_EFFECT_BUDGET, pancatWrites: -1 } },
    ],
    [
      "infinite side-effect counter",
      { sideEffectCounters: { ...ZERO_SIDE_EFFECT_BUDGET, paidUsd: Number.POSITIVE_INFINITY } },
    ],
  ])("rejects invalid ProductionEpisode numeric data: %s", (_name, override) => {
    const episode = readdress("episode", { ...validProductionEpisode(), ...override });
    expect(() => parser("parseProductionEpisode")(episode, PROJECT_ID)).toThrow(/finite|non-negative/i);
  });

  test.each([
    "realProviderCalls",
    "pancatWrites",
    "productionPublishes",
    "realAssetDeletes",
    "crossProjectMemoryReads",
    "crossProjectMemoryWrites",
  ])("rejects fractional ProductionEpisode count: %s", (counter) => {
    const episode = readdress("episode", {
      ...validProductionEpisode(),
      sideEffectCounters: { ...ZERO_SIDE_EFFECT_BUDGET, [counter]: 0.5 },
    });
    expect(() => parser("parseProductionEpisode")(episode, PROJECT_ID)).toThrow(/integer/i);
  });

  test("allows fractional paidUsd on a ProductionEpisode", () => {
    const episode = readdress("episode", {
      ...validProductionEpisode(),
      sideEffectCounters: { ...ZERO_SIDE_EFFECT_BUDGET, paidUsd: 0.5 },
    });
    expect(() => parser("parseProductionEpisode")(episode, PROJECT_ID)).not.toThrow();
  });

  test.each(Object.keys(ZERO_SIDE_EFFECT_BUDGET))(
    "requires zero MatchedExperiment side-effect counter: %s",
    (counter) => {
      const experiment = readdress("experiment", {
        ...validMatchedExperiment(),
        sideEffectCounters: { ...ZERO_SIDE_EFFECT_BUDGET, [counter]: 1 },
      });
      expect(() => parser("parseMatchedExperiment")(experiment, PROJECT_ID)).toThrow(/zero/i);
    },
  );

  test.each([
    ["empty development", { developmentEpisodeRefs: [] }],
    ["empty heldout", { heldoutEpisodeRefs: [] }],
    ["empty unrelated", { unrelatedEpisodeRefs: [] }],
    [
      "overlapping splits",
      { heldoutEpisodeRefs: validMatchedExperiment().developmentEpisodeRefs },
    ],
    [
      "same variants",
      { candidateVariantId: validMatchedExperiment().controlVariantId },
    ],
  ])("rejects invalid MatchedExperiment partitions: %s", (_name, override) => {
    const experiment = readdress("experiment", { ...validMatchedExperiment(), ...override });
    expect(() => parser("parseMatchedExperiment")(experiment, PROJECT_ID)).toThrow();
  });

  test.each(["promote", "reject", "rollback"])(
    "rejects executable MatchedExperiment outcome %s",
    (outcome) => {
      const experiment = readdress("experiment", { ...validMatchedExperiment(), outcome });
      expect(() => parser("parseMatchedExperiment")(experiment, PROJECT_ID)).toThrow(/outcome/i);
    },
  );

  test("accepts all non-executing MatchedExperiment outcomes", () => {
    for (const outcome of [
      "pending",
      "candidate_wins",
      "control_wins",
      "inconclusive",
      "invalid",
    ]) {
      const experiment = readdress("experiment", { ...validMatchedExperiment(), outcome });
      expect(() => parser("parseMatchedExperiment")(experiment, PROJECT_ID)).not.toThrow();
    }
  });

  test("rejects model targets and escaping HarnessVariant paths", () => {
    const modelVariant = readdress("variant", {
      ...validHarnessVariant("candidate"),
      evolutionTargets: ["artifact", "model"],
    });
    const escapingVariant = readdress("variant", {
      ...validHarnessVariant("candidate"),
      changedPaths: ["../production/policy.json"],
    });
    expect(() => parser("parseHarnessVariant")(modelVariant, PROJECT_ID)).toThrow(/model|target/i);
    expect(() => parser("parseHarnessVariant")(escapingVariant, PROJECT_ID)).toThrow(
      /project-relative|path/i,
    );
  });

  test.each([
    ["profile", "registeredAt", "parseEvolutionProfile", validEvolutionProfile],
    ["episode", "observedAt", "parseProductionEpisode", validProductionEpisode],
    ["receipt", "appliedAt", "parseDraftPromotionReceipt", validPromotionReceipt],
  ])("requires strict UTC ISO time on %s", (kind, field, parserName, makeRecord) => {
    for (const timestamp of [
      "2026-08-09 01:02:03Z",
      "2026-08-09T01:02:03+08:00",
      "2026-02-30T01:02:03Z",
      " padded ",
    ]) {
      const record = readdress(kind as EvolutionRecordKind, {
        ...(makeRecord() as Record<string, unknown>),
        [field]: timestamp,
      });
      expect(() => runtimeRecordParser(parserName)(record, PROJECT_ID)).toThrow(/UTC|ISO|timestamp/i);
    }
  });

  test("binds privacy review hashes to the exact ProductionEpisode snapshots", () => {
    const episode = validProductionEpisode();
    const mismatched = readdress("episode", {
      ...episode,
      privacyReview: {
        ...(episode.privacyReview as Record<string, unknown>),
        inputSnapshotSha256: SHA_C,
      },
    });
    expect(() => parser("parseProductionEpisode")(mismatched, PROJECT_ID)).toThrow(
      /privacyReview.*inputSnapshotSha256|match/i,
    );
    for (const privacyMutation of [
      { status: "pending" },
      { surprise: true },
      { evidenceRefs: [] },
    ]) {
      const invalid = readdress("episode", {
        ...episode,
        privacyReview: {
          ...(episode.privacyReview as Record<string, unknown>),
          ...privacyMutation,
        },
      });
      expect(() => parser("parseProductionEpisode")(invalid, PROJECT_ID)).toThrow();
    }
  });

  test.each(["derived-confidential", "private", "restricted-secret"])(
    "rejects unsupported privacy data classification %s",
    (dataClassification) => {
      const episode = validProductionEpisode();
      const invalid = readdress("episode", {
        ...episode,
        privacyReview: { ...episode.privacyReview, dataClassification },
      });
      expect(() => parser("parseProductionEpisode")(invalid, PROJECT_ID)).toThrow(
        /dataClassification/i,
      );
    },
  );

  test.each(["public", "internal", "confidential", "restricted"])(
    "accepts privacy data classification %s",
    (dataClassification) => {
      const episode = validProductionEpisode();
      const classified = readdress("episode", {
        ...episode,
        privacyReview: { ...episode.privacyReview, dataClassification },
      });
      expect(() => parser("parseProductionEpisode")(classified, PROJECT_ID)).not.toThrow();
    },
  );

  test.each(["api_key_count", "secret-score", "score@raw"])(
    "rejects unsafe ProductionEpisode metric key %s",
    (metricKey) => {
      const episode = readdress("episode", {
        ...validProductionEpisode(),
        metrics: { [metricKey]: 1 },
      });
      expect(() => parser("parseProductionEpisode")(episode, PROJECT_ID)).toThrow(
        /metric|opaque|sensitive/i,
      );
    },
  );

  test.each(["secret_group", "group@raw"])(
    "rejects unsafe ProductionEpisode leakageGroupId %s",
    (leakageGroupId) => {
      const episode = readdress("episode", {
        ...validProductionEpisode(),
        leakageGroupId,
      });
      expect(() => parser("parseProductionEpisode")(episode, PROJECT_ID)).toThrow(
        /leakageGroupId|sensitive|identifier/i,
      );
    },
  );

  test("requires receipt readback, canary evidence, and distinct variants", () => {
    const receipt = validPromotionReceipt();
    for (const override of [
      { readbackEvidenceRefs: [] },
      { canaryEvidenceRefs: [] },
      { toVariantId: receipt.fromVariantId },
    ]) {
      const invalid = readdress("receipt", { ...receipt, ...override });
      expect(() => draftParser("parseDraftPromotionReceipt")(invalid, PROJECT_ID)).toThrow();
    }
  });

  test.each([
    { authorizedDecisionRef: "decision:authorization-prod" },
    { exactTargetRef: "target@production" },
    { readbackEvidenceRefs: ["evidence:credential-prod"] },
    { canaryEvidenceRefs: ["evidence:bearer-prod"] },
    { rollbackPlanRef: "rollback:password-prod" },
  ])("rejects unsafe refs in the internal draft PromotionReceipt", (override) => {
    const receipt = readdress("receipt", { ...validPromotionReceipt(), ...override });
    expect(() => draftParser("parseDraftPromotionReceipt")(receipt, PROJECT_ID)).toThrow(
      /opaque|credential|sensitive|ref/i,
    );
  });

  test("enforces runtime record capacity boundaries", () => {
    const surfacesAtLimit = Array.from({ length: 100 }, (_, index) => `surface_${index}`);
    const profileAtLimit = readdress("profile", {
      ...validEvolutionProfile(),
      allowedSurfaceIds: surfacesAtLimit,
    });
    expect(() => parser("parseEvolutionProfile")(profileAtLimit, PROJECT_ID)).not.toThrow();

    const profileOverLimit = readdress("profile", {
      ...validEvolutionProfile(),
      allowedSurfaceIds: [...surfacesAtLimit, "surface_100"],
    });
    expect(() => parser("parseEvolutionProfile")(profileOverLimit, PROJECT_ID)).toThrow(/at most/i);

    const episodeAtLimit = readdress("episode", {
      ...validProductionEpisode(),
      sourceRef: `e:${"x".repeat(254)}`,
      metrics: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`metric_${index}`, index])),
    });
    expect(() => parser("parseProductionEpisode")(episodeAtLimit, PROJECT_ID)).not.toThrow();

    const episodeOverRefLimit = readdress("episode", {
      ...validProductionEpisode(),
      sourceRef: `e:${"x".repeat(255)}`,
    });
    expect(() => parser("parseProductionEpisode")(episodeOverRefLimit, PROJECT_ID)).toThrow(/at most/i);

    const episodeOverMetricsLimit = readdress("episode", {
      ...validProductionEpisode(),
      metrics: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`metric_${index}`, index])),
    });
    expect(() => parser("parseProductionEpisode")(episodeOverMetricsLimit, PROJECT_ID)).toThrow(/at most/i);
  });
});
