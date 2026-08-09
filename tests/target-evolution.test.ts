import { describe, expect, test } from "bun:test";
import * as harnessModule from "../packages/harness/src";
import type {
  DesignProposalData,
  EvolutionCausalHypothesis,
  EvolutionComparison,
  EvolutionPackV1,
} from "../packages/harness/src";
import { buildTaskPrompt, proposeDesignAction } from "../packages/runner/src";

const PROJECT_ID = "project_hodor";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

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

describe("target-system evolution contracts", () => {
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

  test("keeps the Designer prompt compact and explicit about matched evolution evidence", () => {
    const prompt = buildTaskPrompt({
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
});
