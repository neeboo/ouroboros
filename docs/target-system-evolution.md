# Target-System Evolution

## Scope and current status

Ouroboros can describe how another project may evolve while keeping delivery, evidence, and authority boundaries explicit. The first reference target is Hodor.

The checked-in Hodor reference is a **designed-state contract only**. It proves that the current production parsers accept a bounded pack, causal hypothesis, and matched comparison. It does not claim that Hodor has an experiment executor, emits production episodes, runs shadow experiments, promotes variants, rolls them back, or operates autonomously.

The machine-readable reference is [the Hodor evolution pack v0](examples/hodor-evolution-pack-v0.json). Tests parse its `evolutionPack`, `causalHypothesis`, and `comparison` fields with the production target-evolution parsers.

## Create a target-system design run

Register the Evolution Kernel and target as separate projects, and activate a founder charter for the target. Then create the target-bound Designer root:

```bash
orbs design-target-system \
  --kernel-project-id <kernel_project_id> \
  --target-project-id <target_project_id> \
  --goal "Design the target's bounded self-evolution system"
```

The command fails before creating a run when either project is missing, both identities are equal, or the target has no active founder charter. Its run belongs to the target project and freezes the target charter plus a `design-target` evolution identity. It creates one Designer task and prints a safe `codex-resumable` runner command; it does not start the runner, dashboard, or daemon.

The Designer may return a justified quiescent result or use the fixed `proposeDesign` action. A target-evolution proposal must carry the target project identity and the complete `evolutionPack`, `causalHypothesis`, and matched `comparison` contract. Delivery remains behind the authority decision and the fixed `createRunsFromDesign` action.

## Three responsibility layers

The platform has three organizational layers. Each layer answers who owns a decision or action.

| Responsibility layer | Owns | Must not own |
| --- | --- | --- |
| **Ouroboros Evolution Kernel** | Reusable lifecycle, evidence validity, authority and budget checks, matched-experiment enforcement, project isolation, and future promotion/readback/rollback primitives | Hodor's creative semantics, domain metrics, or local mutation choices |
| **Project Evolution Pack** | A versioned target-local contract for objectives, observations, allowed and forbidden mutation surfaces, experiment rules, handoff maturity, and portability evidence | Execution of repository changes or unilateral changes to kernel rules |
| **Delivery Plane** | Concrete planning, worktree mutation, deterministic checks, verification evidence, and bounded repair for an accepted frozen contract | Quietly weakening or replacing the pack, comparison, project identity, or authority decision |

The normal flow is:

```text
Evolution Kernel
  validates identity, evidence, authority, and experiment rules
        |
        v
Project Evolution Pack
  freezes what this target may observe, change, and measure
        |
        v
Delivery Plane
  implements and verifies one accepted change inside that boundary
```

## Optimization targets are a separate classification

`artifact`, `harness`, and `model` answer **what is being optimized**. They are not a fourth responsibility layer and must not be placed beside Kernel, Pack, and Delivery as if the two classifications described the same thing.

| Optimization target | Meaning | Milestone-one status |
| --- | --- | --- |
| `artifact` | A bounded deliverable, policy instance, plan, or code result | Allowed when the pack names the project and paths |
| `harness` | Prompts, workflow, tools, memory, routing, or evaluation machinery that can affect later tasks | Allowed when a matched heldout comparison proves the change |
| `model` | Model weights or training | Prohibited |

For example, the Delivery Plane may implement either an `artifact` policy candidate or a `harness` evaluation change. The plane remains the executor in both cases; the optimization target changes, while responsibility ownership does not.

## Current v1 envelope

The current runtime validates three existing contracts:

- `EvolutionPackV1`: target objective, observations, mutation surfaces, experiment policy, promotion placeholders, handoff maturity, project-local knowledge boundary, and an optional strict `firstCandidate`;
- `EvolutionCausalHypothesis`: the proposed failure mechanism, predicted effects, and disconfirming evidence;
- `EvolutionComparison`: mutually exclusive development, heldout, and unrelated evidence references under one frozen equal budget.

Milestone one fails closed for cross-project mutation surfaces, non-canonical or escaping paths, a `model` optimization target, incomplete evidence splits, overlapping split references, invalid budgets, and any maturity beyond `designed`. When present inside `EvolutionPackV1`, `firstCandidate` is also parsed strictly: its only mode is `shadow`, its allowed optimization targets are limited to `artifact` and `harness`, `model` must remain prohibited, and every declared side-effect budget must equal zero.

The Hodor JSON uses the stable example identity `project_hodor_reference`. Its outer object is a reference envelope containing the three production-parsed contract blocks: `evolutionPack`, `causalHypothesis`, and `comparison`. `firstCandidate` is a strict field inside `evolutionPack`, so the production pack parser enforces its shadow-only shape and zero-side-effect budget without test-side assembly.

## Hodor domain contracts for later milestones

The following five contracts describe the Hodor-side data needed to advance beyond `designed`. They are domain contract designs, not implemented parsers or evidence that the capabilities exist today. Each durable record is project-bound and content-addressed where replay identity matters.

### 1. `EvolutionProfile`

An activated, immutable view of the target's evolution rules for one cycle.

```ts
type EvolutionProfile = {
  schemaVersion: 1;
  id: string;
  projectId: "project_hodor_reference";
  pack: { id: string; version: number; contentSha256: string };
  charter: { id: string; version: number; contentSha256: string };
  maturity: "designed" | "instrumented" | "shadowing" | "autonomous" | "retired";
  allowedSurfaceIds: string[];
  activatedAt: string;
  activatedByReceipt?: string;
};
```

The profile binds every later episode, variant, experiment, and receipt to the exact pack and charter. A new profile is required when those inputs change; existing evidence is never relabeled.

### 2. `ProductionEpisode`

An immutable, privacy-reviewed observation that can be replayed without calling a production provider.

```ts
type ProductionEpisode = {
  schemaVersion: 1;
  id: string;
  projectId: "project_hodor_reference";
  profileId: string;
  observedAt: string;
  inputSnapshotSha256: string;
  outcomeSnapshotSha256: string;
  policyRef: string;
  metrics: Record<string, number>;
  sideEffectCounters: {
    paidUsd: number;
    realProviderCalls: number;
    pancatWrites: number;
    productionPublishes: number;
    realAssetDeletes: number;
    crossProjectMemoryReads: number;
    crossProjectMemoryWrites: number;
  };
  evidenceRefs: string[];
};
```

Episode capture belongs to the future `instrumented` milestone. Fixtures may resemble an episode, but fixture data is not production telemetry.

### 3. `HarnessVariant`

A reproducible control or candidate definition for the exact policy and evaluation machinery under test.

```ts
type HarnessVariant = {
  schemaVersion: 1;
  id: string;
  projectId: "project_hodor_reference";
  profileId: string;
  role: "control" | "candidate";
  evolutionTargets: Array<"artifact" | "harness">;
  contentSha256: string;
  mutationSurfaceIds: string[];
  changedPaths: string[];
  toolPolicySha256: string;
  createdFromEvidenceRefs: string[];
};
```

`model` is intentionally absent from `evolutionTargets`. A later model-training charter would need separate provenance, compute, spend, isolation, distribution, and rollback controls.

### 4. `MatchedExperiment`

A frozen control-versus-candidate comparison over mutually exclusive evidence sets.

```ts
type MatchedExperiment = {
  schemaVersion: 1;
  id: string;
  projectId: "project_hodor_reference";
  profileId: string;
  controlVariantId: string;
  candidateVariantId: string;
  developmentEpisodeRefs: string[];
  heldoutEpisodeRefs: string[];
  unrelatedEpisodeRefs: string[];
  corpusSnapshotSha256: string;
  equalBudget: EvolutionComparison["equalBudget"];
  primaryMetric: string;
  guardMetrics: string[];
  decision: "pending" | "promote" | "reject" | "inconclusive";
  evidenceRefs: string[];
};
```

All three sets must be non-empty and pairwise disjoint. Candidate generation may use development evidence only. Heldout contents and results remain unavailable until the candidate and budget are frozen. Unrelated episodes detect broad regressions.

### 5. `PromotionReceipt`

An auditable record of a later promotion, canary readback, or rollback. Recording intent is insufficient; the receipt must cite observed state.

```ts
type PromotionReceipt = {
  schemaVersion: 1;
  id: string;
  projectId: "project_hodor_reference";
  profileId: string;
  experimentId: string;
  action: "promote" | "rollback";
  fromVariantId: string;
  toVariantId: string;
  authorizedDecisionRef: string;
  appliedAt: string;
  exactTargetRef: string;
  readbackEvidenceRefs: string[];
  canaryEvidenceRefs: string[];
  rollbackPlanRef: string;
  rollbackReceiptId?: string;
};
```

Ouroboros does not implement this Hodor receipt, promotion readback, or rollback path in milestone one. The `promotionPolicy` strings in the reference pack are frozen requirements for later design work, not executable promotion capability.

## First candidate: spatial-risk shadow comparison

The first candidate is a zero-side-effect shadow experiment for Hodor's spatial-risk policy. It is deliberately narrow:

- development, heldout, and unrelated episode references are all non-empty and mutually exclusive;
- control and candidate use the same model label, reasoning effort, wall-clock allowance, attempt count, token ceiling, tool policy, and concurrency;
- paid spend, real provider calls, Pancat writes, production publishing, real material deletion, and cross-project memory access all have a budget of zero;
- the only optimization targets are `artifact` and `harness`; `model` remains prohibited;
- allowed paths are limited to the reference spatial-risk policy and evaluation areas;
- production, provider, credential, production-asset, and cross-project-memory paths remain forbidden.

The production parser now enforces this candidate's static declaration: shadow mode only, `artifact` and `harness` targets only, explicit `model` prohibition, and zero for every side-effect budget counter. At `designed` maturity this remains a contract example. Ouroboros does not yet provide the Hodor experiment executor that could prove those counters stayed at zero during a run. Reaching `shadowing` requires real `EvolutionProfile`, `ProductionEpisode`, `HarnessVariant`, and `MatchedExperiment` support. Promotion, canary readback, and rollback execution remain later capabilities.

## Maturity gates

| Maturity | Required evidence | May do |
| --- | --- | --- |
| `designed` | Production parsers accept the static pack, strict first candidate, hypothesis, and comparison; boundary tests reject unsafe variants | Design and review only |
| `instrumented` | Immutable profile, episode, and variant identities with readback | Capture and replay observations |
| `shadowing` | Matched experiments with sealed heldout data and zero-side-effect proof | Evaluate without promotion |
| `autonomous` | Authority-gated promotion receipts, exact readback, canary observation, and tested rollback | Promote and roll back within the frozen charter |
| `retired` | Retirement decision and retained evidence pointers | Historical read-only access |

The Hodor reference remains at `designed`. Promotion and rollback are later capabilities and must not be inferred from the presence of `promotionPolicy` fields.
