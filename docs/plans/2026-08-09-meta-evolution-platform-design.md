# Meta-Evolution Platform Design

## Product definition

Ouroboros is the meta-control system that designs, incubates, governs, and improves self-evolving systems. Ouroboros also runs the same method against its own repository, making self-evolution one instance of the broader product rather than the whole product.

The platform has three explicit layers:

```text
Ouroboros Evolution Kernel
  designs evolution systems, freezes experiments, governs promotion and rollback
                |
                v
Project Evolution Pack
  defines how one target system observes, changes, evaluates, learns, and hands off
                |
                v
Delivery Plane
  implements and verifies concrete changes in bounded repositories and worktrees
```

The first target-system reference is Hodor. Milestone one designs the Hodor evolution system and proves its contracts in Ouroboros. It does not modify Hodor business code or activate autonomous production changes.

The organizational layers above are separate from the thing being improved. Every evolution surface also declares one optimization target from the article's taxonomy:

- `artifact`: improve a bounded deliverable such as code, a production plan, or a policy instance;
- `harness`: improve prompts, memory, skills, tools, routing, workflow, or evaluation machinery that affects later tasks;
- `model`: improve model weights or training. This target is representable for future designs but prohibited by default in milestone one.

This distinction matters operationally. Repeatedly fixing repository tests is usually artifact evolution, even when the repository happens to contain a harness. A harness change only counts as harness evolution after a budget-matched candidate proves improvement on held-out tasks without unrelated regressions.

## Architectural choice

Three approaches were considered:

1. Extend the existing self-iteration loop without a project layer. This is cheap initially but conflates Ouroboros' own evolution with the target system's domain evolution.
2. Keep one reusable kernel and add versioned project evolution packs. This preserves the existing Designer, authority, delivery, verification, and outcome machinery while separating domain ownership. This is the selected approach.
3. Run a federated network of independently evolving projects. This may follow after the project-pack contract is proven, but adds premature compatibility and transfer-governance work.

## Layer ownership

### Evolution Kernel

The kernel owns reusable protocol and enforcement:

- Designer, Planner, Worker, Verifier, Goal Review, and Outcome Review lifecycles;
- evidence validity, authority, budget, and stop rules;
- matched experiment validation;
- bounded repository mutation, integration, promotion, readback, and rollback primitives;
- project identity and cross-project isolation;
- capability-transfer evidence and genericization gates.

It does not own Hodor's production metrics, creative policy, or domain-specific mutation choices.

### Project Evolution Pack

A versioned pack defines how one target system can evolve:

- target objective and charter reference;
- observable signals and freshness rules;
- mutable components and prohibited surfaces;
- causal failure taxonomy;
- matched experiment policy;
- promotion, canary, rollback, and observation rules;
- handoff maturity;
- project-local knowledge and evidence required before proposing a kernel-level generalization.

### Delivery Plane

The existing run/task/attempt and Git control plane executes a concrete accepted proposal. Delivery workers may satisfy a frozen pack and evaluation contract but cannot change them.

## Project and instance identity

Every target-system design run is bound to the target project. The run carries an immutable `evolutionInstance` context:

```ts
type EvolutionInstance = {
  schemaVersion: 1;
  mode: "self" | "design-target" | "target-cycle";
  kernelProjectId: string;
  targetProjectId: string;
  cycle: {
    kind: "design" | "bootstrap" | "operate" | "assess-handoff";
    index: number;
  };
  pack?: {
    id: string;
    version: number;
    contentSha256: string;
  };
};
```

For every design action, the run, target project, proposal, charter, strategy signals, and child delivery run must resolve to the same target project. The kernel project identifies who designed and governs the pack; it does not grant permission to mutate the kernel while working on the target.

Legacy unbound runs remain readable, but all new self-iteration and target-design entry points create project-bound runs.

## Evolution pack v1

Milestone one represents the designed pack inside the accepted design proposal. The proposal is versioned, authority-gated, normalized through the strict production parser, hashed canonically, and frozen into child delivery runs. Pack activation and autonomous target cycles follow in a later milestone after the design contract is proven.

```ts
type EvolutionPackV1 = {
  schemaVersion: 1;
  id: string;
  targetSystemId: string;
  version: number;
  knowledgeScope: `project:${string}`;
  objective: {
    charterId: string;
    domainOutcomes: string[];
    nonGoals: string[];
  };
  observation: {
    signalSources: Array<{
      id: string;
      kind: "run-evidence" | "repository" | "external-ref" | "domain-metric";
      freshnessMs?: number;
    }>;
  };
  mutationSurfaces: Array<{
    id: string;
    evolutionTarget: "artifact" | "harness" | "model";
    layer: "artifact" | "workflow" | "prompt" | "tool" | "policy" | "code";
    projectId: string;
    allowedPaths: string[];
    forbiddenPaths: string[];
    owner: "ouroboros" | "target";
  }>;
  experimentPolicy: {
    controlRequired: true;
    holdoutRequired: true;
    unrelatedRegressionRequired: true;
    equalBudgetRequired: true;
    maxCandidates: number;
  };
  promotionPolicy: {
    guardMetrics: string[];
    observationWindow: string;
    rollback: string;
  };
  handoff: {
    maturity: "designed" | "instrumented" | "shadowing" | "autonomous" | "retired";
    targetOwner: string;
    requiredCapabilities: string[];
  };
  portability: {
    projectLocalRules: string[];
    genericizationEvidence: string[];
  };
  firstCandidate?: {
    id: string;
    mode: "shadow";
    allowedEvolutionTargets: Array<"artifact" | "harness">;
    prohibitedEvolutionTargets: ["model"];
    sideEffectBudget: {
      paidUsd: 0;
      realProviderCalls: 0;
      pancatWrites: 0;
      productionPublishes: 0;
      realAssetDeletes: 0;
      crossProjectMemoryReads: 0;
      crossProjectMemoryWrites: 0;
    };
  };
};
```

The optional first candidate is a static authorization boundary for a later shadow experiment. It only permits a non-empty subset of `artifact` and `harness`, prohibits `model`, and freezes all seven side-effect counters at literal zero. Milestone one does not yet provide the runtime executor and evidence receipts needed to prove those counters stayed at zero during execution.

The same proposal carries a causal hypothesis. A delivery failure cannot silently become a kernel change:

```ts
type EvolutionCausalHypothesis = {
  failureClass:
    | "environment"
    | "control-lifecycle"
    | "contract-mismatch"
    | "agent-capability"
    | "evaluation-defect"
    | "domain-hypothesis";
  mechanism: string;
  predictedEffects: string[];
  disconfirmingEvidence: string[];
};
```

## Matched experiment contract

Tests remain hard safety gates. Promotion additionally requires a falsifiable matched comparison:

```ts
type EvolutionComparison = {
  controlRef: string;
  developmentEvidenceRefs: string[];
  holdoutEvidenceRefs: string[];
  unrelatedEvidenceRefs: string[];
  corpusSnapshotSha256: string;
  equalBudget: {
    model: string;
    reasoningEffort: string;
    wallClockMs: number;
    maxAttempts: number;
    maxTokens?: number;
    toolPolicySha256: string;
    concurrency: number;
  };
  primaryMetric: string;
  minimumUplift: number;
  maximumGuardRegression: number;
};
```

The parser fails closed when a split is empty, the same evidence appears in multiple splits, a budget field is invalid, or an evolution proposal omits the comparison. Candidate generation cannot receive holdout contents or results.

Milestone one permits `artifact` and `harness` surfaces only. A `model` surface must remain in the prohibited set until a later charter and authority contract defines training data provenance, compute and spend approval, evaluation isolation, rollback, and weight-distribution controls.

## Hodor reference pack

Hodor's first pack remains at maturity `designed`. It uses existing ProductionGraph and collaboration evidence, and initially opens only low-risk policy surfaces:

- spatial-risk and blocking thresholds;
- role quality contracts;
- provider knowledge selection;
- asset reuse and targeted repair policy.

It prohibits automatic schema changes, public action changes, provider replacement, spending, production publishing, credential changes, and cross-project memory transfer.

The first later shadow experiment compares spatial-risk policy variants over development, holdout, and unrelated shot sets with zero paid generation, zero real provider calls, and zero Pancat writes.

## Knowledge boundaries

Knowledge is scoped as `kernel`, `project:<id>`, or `delivery:<run-id>`. Hodor evidence remains project-local by default. Promotion to kernel knowledge requires a separate proposal supported by evidence from outside the originating project.

The later knowledge lifecycle is:

```text
raw -> candidate -> validated -> active -> retired
```

Each promoted item will carry applicability, counterexamples, source evidence, validation experiment, expiry, and retirement conditions. Milestone one only freezes the scope and genericization evidence requirements in the pack.

## Agent-native architecture checks

- **Parity:** target-system design available through the CLI must also be expressible through fixed Designer actions.
- **Granularity:** repository and remote mutations remain atomic, bounded primitives; the pack describes outcomes and policy rather than encoding a full workflow tool.
- **Composability:** a new target system is described by a pack and charter without adding a new orchestrator.
- **Emergent capability:** Designers can propose domain-specific evolution surfaces inside the frozen pack instead of selecting from a hardcoded Hodor workflow.
- **Shared workspace:** agents, users, dashboard, and CLI read the same SQLite evidence and worktree artifacts.
- **Explicit completion:** existing attempt output and fixed actions remain the completion protocol.
- **Dynamic context:** prompts receive the exact target project, charter, pack, evidence cutoff, and capabilities.
- **No silent mutation:** all design, delivery, integration, and later promotion transitions produce durable action evidence.

## Milestones

1. **Designed:** strict project identity, evolution instance context, evolution pack and matched comparison proposal contract, Hodor reference pack.
2. **Instrumented:** Hodor emits production episodes and immutable harness-version identities.
3. **Shadowing:** matched zero-side-effect experiments produce deterministic promote/reject/inconclusive results.
4. **Autonomous:** bounded target-local candidate generation, exact promotion/readback, canary observation, and rollback.
5. **Cross-project learning:** capability transfer receipts and evidence-gated promotion into the kernel.
