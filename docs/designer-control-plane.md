# Designer Control Plane

Ouroboros needs a strategy loop above planning. A planner turns a known objective into executable work. A designer decides which objective is worth pursuing, which alternatives deserve experiments, what should be removed, and when the system should remain idle.

The designer acts like a bounded product founder. It can research, form hypotheses, allocate a configured experiment budget, and propose product or system changes. It does not optimize for its own survival, revenue alone, benchmark scores alone, or novelty. It remains accountable to a human-owned charter.

## Control Layers

```text
founder charter
  -> observe signals
  -> designer synthesis
  -> design proposal and evaluation contract
  -> authority and budget gate
  -> experiment or accepted design
  -> planner task graph
  -> worker execution
  -> verifier evidence
  -> integration or release
  -> outcome review
  -> updated signals and design judgment
```

The delivery loop remains responsible for implementation. The strategy loop owns product direction, system shape, capital allocation, and the decision to add, replace, simplify, or remove capabilities.

## Founder Charter

The charter is versioned, durable, and human-owned. It defines the objective function and the authority delegated to the designer.

Minimum shape:

```ts
type FounderCharter = {
  mission: string;
  targetUsers: string[];
  valueMetrics: string[];
  principles: string[];
  nonGoals: string[];
  constraints: string[];
  capitalPolicy: {
    currency: string;
    monthlyBudget?: number;
    experimentBudget?: number;
    recurringSpendApprovalAbove?: number;
    runwayFloorMonths?: number;
    portfolio?: {
      core: number;
      growth: number;
      exploration: number;
    };
  };
  authority: {
    autoResearch: boolean;
    autoReversibleExperiments: boolean;
    autoIntegrateVerifiedCode: boolean;
    requireHumanFor: string[];
  };
  reviewCadenceDays: number;
};
```

The designer may propose a charter amendment. Only a human or an explicitly configured governance actor may activate it. Mission, spending limits, legal or privacy boundaries, destructive operations, production deployment, and irreversible infrastructure commitments are human checkpoints by default.

## Evidence Model

The designer maintains a time-aware world model from six signal classes:

- user: behavior, feedback, retention, failures, support, and issues;
- delivery: cycle time, verifier failures, retries, interventions, and rollback rate;
- technology: papers, releases, pricing, licenses, model capabilities, and deprecations;
- market: competitors, positioning, distribution, pricing, and user sentiment;
- economics: revenue, conversion, acquisition cost, serving cost, and runway;
- system: topology, duplication, maintenance burden, reliability, and unused capability.

Every signal records its source, observation time, confidence, evidence, and expiry. Expired market, pricing, and model claims cannot authorize a new investment until refreshed. Conflicting signals are preserved rather than overwritten.

Research is event-driven and periodic:

- a value or reliability metric crosses a configured threshold;
- repeated lessons or human interventions reveal a systemic gap;
- a material external change is detected;
- a decision or signal reaches its review date;
- the configured strategy cadence expires.

No trigger and no evidence-backed opportunity means quiescence.

## Design Proposal Contract

A designer produces a proposal before a planner produces tasks.

```ts
type DesignProposal = {
  problem: string;
  evidenceRefs: string[];
  targetOutcome: string;
  options: Array<{
    name: string;
    benefits: string[];
    costs: string[];
    risks: string[];
    lockIn: string[];
  }>;
  recommendation: string;
  additions: string[];
  removals: string[];
  assumptions: string[];
  uncertainty: string[];
  evaluationContract: {
    baseline: string[];
    successMetrics: string[];
    guardMetrics: string[];
    requiredEvidence: string[];
    reviewAt?: string;
  };
  investment: {
    oneTimeCost?: number;
    recurringCost?: number;
    timeBudget?: string;
    reversibility: "easy" | "moderate" | "hard";
    portfolio: "core" | "growth" | "exploration";
  };
  experiment?: {
    hypothesis: string;
    smallestTest: string;
    stopConditions: string[];
    rollback: string;
  };
};
```

The evaluation contract is frozen before execution. A worker cannot weaken it. A designer can propose a new version after an outcome review, while prior versions and results remain auditable.

Every proposal must consider removal. New nodes and features require an explanation of why composition with existing primitives is insufficient. A proposal that adds complexity without naming its maintenance cost is incomplete.

## Decision Policy

Ouroboros cannot guarantee correct decisions. It can improve calibration and reduce the cost of mistakes.

Decision order:

1. Reject options that violate the charter or hard constraints.
2. Compare customer value, strategic fit, confidence, time to evidence, full cost, lock-in, and operational risk.
3. Prefer the smallest experiment that can distinguish the leading options.
4. Prefer reversible commitments while uncertainty is high.
5. Require stronger evidence as cost and irreversibility increase.
6. Revisit accepted decisions when their evidence expires or outcome metrics disagree.

Automatic authority is limited to changes that are reversible, inside the experiment budget, free of new sensitive-data or legal obligations, and below recurring-spend thresholds. Everything else becomes an explicit human decision.

Infrastructure follows a rent-before-buy policy. Cloud services are suitable while demand and workload shape are uncertain. Local execution is justified by measured offline, privacy, or latency value. Dedicated GPU capacity is justified only after representative workload tests show stable utilization and a favorable full-cost comparison that includes engineering and operational burden.

## Portfolio And Commercial Discipline

The designer treats development as a portfolio:

- core: reliability, user value, retention, and current revenue;
- growth: validated adjacent demand and distribution;
- exploration: low-cost technical or product options.

Portfolio percentages come from the charter. Exploration cannot silently consume core reliability or runway. A new paper or model release is a signal, not a task. It becomes work only when it addresses a measured bottleneck or buys useful information within the exploration budget.

For Ouroboros itself, initial business and product measures should include:

- time from goal to verified integrated change;
- unattended completion rate;
- human intervention and rescue rate;
- cost per verified change;
- planner rework and verifier false-decision rates;
- successful external-repository runs;
- installation-to-first-success time;
- repeated use after the first successful run.

These measures help the designer choose between deeper reliability, new agent backends, dashboard work, distribution, or commercial features. They also let it retire features that are expensive and unused.

## Persistent Protocol

The minimal database model is:

- `founder_charters`: immutable versions and one active version per project;
- `strategy_signals`: sourced, expiring observations;
- `design_proposals`: options, recommendation, evaluation contract, investment, and status;
- `design_decisions`: append-only approval, rejection, deferral, or retirement records;
- `design_outcomes`: experiment or release results tied to metrics and evidence.

The minimal fixed actions are:

- `recordSignal`
- `proposeDesign`
- `decideDesign`
- `recordDesignOutcome`
- `createRunsFromDesign`

These actions are parsed and validated by the harness. Prompt prose may explain judgment, but it cannot directly mutate strategy records.

Proposal states:

```text
draft -> proposed -> experimenting -> accepted -> implemented -> measuring -> retained
                       |              |              |
                       v              v              v
                    rejected        retired        revise
```

## Role Boundaries

### Designer

- reads the active charter and current world model;
- launches bounded research subsessions when evidence is missing;
- compares alternatives and creates design proposals;
- asks for experiments instead of pretending uncertainty is resolved;
- proposes removals and simplifications;
- hands accepted proposals to planning;
- revisits decisions using outcome evidence.

### Planner

- accepts a frozen proposal and evaluation contract;
- creates executable runs, tasks, dependencies, verifier contracts, and repair paths;
- cannot invent a new product direction or weaken the design contract.

### Worker

- changes artifacts inside its task and worktree boundary;
- reports checks, costs, unexpected constraints, and implementation evidence.

### Verifier

- verifies frozen delivery and design contracts;
- distinguishes implementation failure from an invalid design assumption;
- cannot approve its own contract amendment.

### Overseer

- supervises ownership, retries, budgets, and lifecycle;
- interrupts escaped or repetitive execution;
- does not choose product direction.

### Outcome Reviewer

- compares post-integration or post-release evidence with the proposal baseline;
- records retained, revised, or retired outcomes;
- feeds discrepancies back as strategy signals.

## Self-Design For Ouroboros

The first Ouroboros charter should preserve the existing mission of reliable, autonomous, observable coding work while adding commercial discipline. Its designer should inspect repository behavior, run evidence, lessons, current research, agent tooling, user feedback, and distribution friction.

It should be able to conclude that no new work is justified. It should also be able to prefer a protocol repair over another role, remove redundant orchestration, postpone an expensive backend, or run a bounded comparison of models before changing defaults.

Self-modification keeps an archive of proposals, decisions, commits, evaluations, and outcomes. New versions replace prior behavior only after passing held-out checks. Rollback remains available. The process that proposes a high-risk change cannot be the sole authority that approves it.

## Initial Scope

The first implementation includes persistent records, typed actions, deterministic authority gates, a designer bootstrap before planning, outcome recording, CLI inspection, and focused dashboard visibility.

It does not initially include automated billing, purchasing, production deployment, competitor scraping, a general finance system, or automatic charter amendments. The designer can later propose those capabilities when evidence and the charter justify them.
