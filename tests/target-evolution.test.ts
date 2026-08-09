import { describe, expect, test } from "bun:test";
import * as harnessModule from "../packages/harness/src";
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

interface HodorEvolutionReference {
  projectId: string;
  evolutionPack: EvolutionPackV1;
  causalHypothesis: EvolutionCausalHypothesis;
  comparison: EvolutionComparison;
  firstCandidate: EvolutionFirstCandidate;
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

function validEvolutionProposal(): DesignProposalData {
  return {
    ...ordinaryProposal(),
    evolutionPack: validEvolutionPack(),
    causalHypothesis: validCausalHypothesis(),
    evaluationContract: {
      ...ordinaryProposal().evaluationContract,
      comparison: validComparison(),
    },
  };
}

function parser(name: string): (...args: unknown[]) => unknown {
  const candidate = (harnessModule as unknown as Record<string, unknown>)[name];
  expect(candidate, `${name} must be exported by @ouroboros/harness`).toBeFunction();
  return candidate as (...args: unknown[]) => unknown;
}

function designerPrompt(): string {
  return buildTaskPrompt({
    run: {
      id: "run_1",
      projectId: PROJECT_ID,
      projectRoot: "/tmp/hodor",
      goal: "Design Hodor evolution",
      status: "todo",
      context: {},
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
        {
          ...candidateReference.evolutionPack,
          firstCandidate: candidateReference.firstCandidate,
        },
        candidateReference.projectId,
      ) as EvolutionPackV1;
      expect(parsedPack.firstCandidate).toEqual(candidateReference.firstCandidate);
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
    expect(reference.firstCandidate).toMatchObject({
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

  test("normalizes and preserves a complete target-evolution proposal", () => {
    const action = proposeDesignAction({
      projectId: PROJECT_ID,
      title: "Design Hodor evolution",
      proposal: validEvolutionProposal(),
    });

    expect(action.payload.proposal).toMatchObject(validEvolutionProposal());
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
    expect(prompt).toContain("equal budget");
    expect(prompt).toContain("holdout");
    expect(prompt).toContain("unrelated");
    expect(prompt).toContain("model");
    expect(prompt).toContain("prohibited");
    expect(prompt).not.toContain("episode_holdout_1");
    expect(prompt.length).toBeLessThan(20_000);
  });

  test("provides one standalone exact evolution extension fragment accepted by the parser", () => {
    const prompt = designerPrompt();
    const extension = jsonFenceAfter(prompt, "## Target System Evolution Proposal Contract");
    const requiredOutput = jsonFenceAfter(prompt, "## Required Output");
    const actions = requiredOutput.actions as Array<Record<string, unknown>>;
    const proposals = actions.filter((action) => action.type === "proposeDesign");
    expect(proposals).toHaveLength(1);
    expect(extension.type).toBeUndefined();

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
        projectId: basePayload.projectId as string,
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
