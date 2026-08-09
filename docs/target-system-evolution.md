# Target-System Evolution

## Scope and current status

Ouroboros can describe how another project may evolve while keeping delivery, evidence, and authority boundaries explicit. The first reference target is Hodor.

The checked-in Hodor reference is a **designed-state contract only**. It proves that the current production parsers accept a bounded pack, causal hypothesis, and matched comparison. Ouroboros now also has strict, immutable declarations for a target profile, episode commitments intended for later replay, harness variants, and a pending shadow experiment specification. These records do not claim that Hodor is instrumented, has emitted real production episodes, has run a shadow experiment, has promoted a variant, has rolled it back, or operates autonomously.

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

## Declared runtime contracts

Four contracts are public, strict production parsers and can be stored as immutable, project-bound, content-addressed records. A draft promotion shape remains internal until result authority, exact target readback, canary evidence, and rollback execution exist. Runtime support in Ouroboros is platform capability; Hodor remains `designed` until independent evidence advances it through a later maturity receipt.

### 1. `EvolutionProfile`

A registered, immutable declaration of the target's evolution rules for one cycle.

```ts
type EvolutionProfile = {
  schemaVersion: 1;
  id: string;
  projectId: "project_hodor_reference";
  pack: { id: string; version: number; contentSha256: string };
  charter: { id: string; version: number; contentSha256: string };
  runtimeMaturity: "declared";
  allowedSurfaceIds: string[];
  registeredAt: string;
};
```

`runtimeMaturity: "declared"` is deliberately separate from the pack maturity ladder. Registration proves identity and frozen provenance only. It does not prove observation coverage, artifact readback, shadow execution, or promotion readiness. The profile binds every later episode, variant, and experiment declaration to the exact accepted proposal, approved authority decision, pack, and charter. A new profile is required when those inputs change; existing evidence is never relabeled.

### 2. `ProductionEpisode`

An immutable observation commitment intended for a later isolated replay executor.

```ts
type ProductionEpisode = {
  schemaVersion: 1;
  id: string;
  projectId: "project_hodor_reference";
  profileId: string;
  sourceRef: string;
  leakageGroupId: string;
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
  privacyReview: {
    status: "approved";
    policySha256: string;
    reviewerRef: string;
    dataClassification: string;
    retentionPolicyRef: string;
    inputSnapshotSha256: string;
    outcomeSnapshotSha256: string;
    evidenceRefs: string[];
  };
};
```

The episode parser and immutable storage contract accept hashes, bounded metrics, counters, and opaque evidence references only. Raw input and output are forbidden. Call and write counters are non-negative integers; `paidUsd` is a non-negative finite amount. `sourceRef` identifies exactly one frozen evidence split, while `leakageGroupId` prevents related observations from crossing splits. A heldout episode stores commitments only: its metrics are empty and its evidence is limited to a future host-owned privacy receipt. Fixtures may resemble an episode, but fixture data is not production telemetry.

V1 deliberately blocks the public `recordProductionEpisode` action. A normal verifier attempt is not a privacy authority because public harness commands can create tasks and attempt output. Enabling this action requires an immutable privacy receipt minted only by a private host runner completion path and bound to the exact proposal, authority decision, charter, profile, snapshots, policy, classification, retention rule, verifier contract, task, and attempt. Until that capability exists, no episode action receipt can be created and no matched experiment can be frozen.

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

`changedPaths` contains exact project-relative file paths, never glob expressions. `model` is intentionally absent from `evolutionTargets`. A later model-training charter would need separate provenance, compute, spend, isolation, distribution, and rollback controls. The current record binds a declared content hash; an independent artifact/commit attestation is still required before a maturity receipt may call the target instrumented.

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
  sideEffectCounters: {
    paidUsd: 0;
    realProviderCalls: 0;
    pancatWrites: 0;
    productionPublishes: 0;
    realAssetDeletes: 0;
    crossProjectMemoryReads: 0;
    crossProjectMemoryWrites: 0;
  };
  outcome: "pending" | "candidate_wins" | "control_wins" | "inconclusive" | "invalid";
  evidenceRefs: string[];
};
```

All three sets must be non-empty and pairwise disjoint. Source references, leakage groups, and input or outcome snapshot hashes cannot cross splits, including input-to-outcome collisions. Candidate generation may use development evidence only. Ordinary roles receive only a commitment and count for the heldout split; matching values are also removed from arbitrary nested prompt context. Unrelated episodes detect broad regressions. The current fixed action accepts only `outcome: "pending"`: it freezes a future comparison and does not run either arm or claim a result.

### Internal draft: promotion receipt

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

This shape is intentionally not exported from the public harness API. Ouroboros does not expose an action that records it, applies a promotion, performs readback, or runs rollback in this milestone. The `promotionPolicy` strings in the reference pack are frozen requirements for later design work, not executable promotion capability.

## Fixed runtime actions

Four narrow action names describe the intended runtime graph, with only the declaration-safe subset enabled:

- `registerEvolutionProfile`
- `recordProductionEpisode` — disabled until the host-owned privacy receipt path exists
- `registerHarnessVariant`
- `freezeMatchedExperiment`

Each enabled action requires a project-bound design delivery run. The action rebuilds its contract from the stored accepted proposal, latest approved authority decision, and active frozen charter; repeated context views must match exactly and neither generic context mutation path can replace them. It validates the comparison, surfaces, exact paths, and referenced records; writes one immutable record; reads it back in the same transaction; and binds a minimal audit event to an immutable action receipt carrying the exact proposal, decision, and charter provenance. An identical replay under the same authorization reuses the record; cross-authorization reuse and the same identity with different content fail closed. The actions do not use Git, network access, provider credentials, target repositories, or production databases.

There is no action for experiment results, promotion, rollback, or maturity advancement beyond the declared runtime state.

The supervising control plane submits these records through the existing strict action entry point. Independent inspection uses a project-bound, read-only command:

```bash
orbs action --action-json '<one exact fixed action>'
orbs show-evolution-record --kind profile --project-id <project_id> --id <profile_id> --json
orbs list-evolution-records --kind episode --project-id <project_id> --profile-id <profile_id> --json
```

`show-evolution-record` recomputes the canonical record hash and verifies the matching immutable action receipt, real source run, exact proposal, authority decision, charter, project, action, and successful artifact. Episode and experiment output is a commitment-only projection: it does not expose split references, metrics, evidence references, or privacy-review identities. Both inspection commands open the database read-only and do not run migrations or create SQLite sidecar files.

## First candidate: spatial-risk shadow comparison

The first candidate is a zero-side-effect shadow experiment for Hodor's spatial-risk policy. It is deliberately narrow:

- development, heldout, and unrelated episode references are all non-empty and mutually exclusive;
- control and candidate use the same model label, reasoning effort, wall-clock allowance, attempt count, token ceiling, tool policy, and concurrency;
- paid spend, real provider calls, Pancat writes, production publishing, real material deletion, and cross-project memory access all have a budget of zero;
- the only optimization targets are `artifact` and `harness`; `model` remains prohibited;
- allowed paths are limited to the reference spatial-risk policy and evaluation areas;
- production, provider, credential, production-asset, and cross-project-memory paths remain forbidden.

The production parser now enforces this candidate's static declaration: shadow mode only, `artifact` and `harness` targets only, explicit `model` prohibition, and zero for every side-effect budget counter. At `designed` maturity this remains a contract example. Ouroboros can register a declared profile and its exact variants, but it cannot record trusted production episodes or freeze the pending experiment until the host-owned privacy receipt path exists. It also does not yet provide the isolated Hodor experiment executor or artifact attestation needed to prove those declarations. Reaching `instrumented` requires source and artifact receipts plus an explicit maturity receipt. Reaching `shadowing` additionally requires sealed holdout access, equal-budget arm receipts, and independent side-effect readback. Promotion, canary readback, and rollback execution remain later capabilities.

## Maturity gates

| Maturity | Required evidence | May do |
| --- | --- | --- |
| `designed` | Production parsers accept the static pack, strict first candidate, hypothesis, and comparison; boundary tests reject unsafe variants | Design and review only |
| `instrumented` | Declared graph plus independent source, privacy, artifact, and maturity receipts | Capture and replay verified observations |
| `shadowing` | Matched experiments with sealed heldout data and zero-side-effect proof | Evaluate without promotion |
| `autonomous` | Authority-gated promotion receipts, exact readback, canary observation, and tested rollback | Promote and roll back within the frozen charter |
| `retired` | Retirement decision and retained evidence pointers | Historical read-only access |

`runtimeMaturity: "declared"` is a registration state, not a pack maturity. The Hodor reference remains at `designed`. Promotion and rollback are later capabilities and must not be inferred from the presence of `promotionPolicy` fields.
