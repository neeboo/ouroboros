# Meta-Evolution Platform V1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Ouroboros safely design a versioned self-evolution system for a target project, with strict project identity, a typed evolution pack, and a falsifiable equal-budget evaluation contract.

**Architecture:** Reuse the existing Founder Charter, Strategy Signal, Design Proposal, authority, delivery, verifier, and outcome pipeline. Add a typed target-evolution contract to design proposals and freeze it into project-bound child runs. Milestone one stops at the `designed` maturity and does not mutate Hodor.

**Tech Stack:** Bun, TypeScript, SQLite-backed Harness, existing Designer fixed actions and CLI.

---

### Task 1: Close project identity boundaries

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/runner/src/hooks/apply-design-actions.ts`
- Modify: `tests/runner.test.ts`
- Modify: `tests/cli.test.ts`

**Steps:**

1. Add failing tests showing that new self-iteration root and assessment runs carry the Ouroboros project ID.
2. Add failing action tests showing that a project-bound run rejects a `recordSignal` or `proposeDesign` payload for another project.
3. Add failing tests showing that a proposal charter must belong to the same project.
4. Add a failing test showing that `createRunsFromDesign` binds its child run to the proposal project.
5. Implement the minimum project binding checks and child-run propagation.
6. Run the focused runner and CLI tests.
7. Commit only Task 1 files.

### Task 2: Add strict target-evolution contracts

**Files:**
- Create: `packages/harness/src/target-evolution.ts`
- Modify: `packages/harness/src/types.ts`
- Modify: `packages/harness/src/index.ts`
- Modify: `packages/runner/src/agent-actions.ts`
- Modify: `packages/runner/src/prompt.ts`
- Create: `tests/target-evolution.test.ts`
- Modify: `tests/runner.test.ts`

**Steps:**

1. Add parser tests for valid `EvolutionInstance`, `EvolutionPackV1`, `EvolutionCausalHypothesis`, and `EvolutionComparison` values, including the explicit `artifact | harness | model` optimization target taxonomy and a strict zero-side-effect shadow candidate.
2. Add rejection tests for missing holdout/unrelated splits, duplicate evidence across splits, invalid hashes, invalid budgets, unknown mutation layers, cross-project mutation surfaces, and milestone-one model-weight mutation.
3. Add a test showing that non-evolution proposals remain compatible.
4. Implement pure validation and normalization helpers in `target-evolution.ts`.
5. Extend `DesignProposalData` and `DesignEvaluationContract` with explicit optional target-evolution fields.
6. Require the pack, causal hypothesis, and comparison as one complete group; reject partial evolution proposals.
7. Update the compact Designer action example and contract text so generated payloads match the parser.
8. Run target-evolution and runner focused tests.
9. Commit only Task 2 files.

### Task 3: Freeze the evolution instance into delivery

**Files:**
- Modify: `packages/runner/src/hooks/apply-design-actions.ts`
- Modify: `packages/runner/src/prompt.ts`
- Modify: `tests/runner.test.ts`
- Modify: `tests/design-actions-adversarial.test.ts`

**Steps:**

1. Add a failing test showing that an accepted target-evolution proposal copies the complete normalized pack, causal hypothesis, comparison, and target project into its child run.
2. Add a failing test showing that planned run context cannot replace the frozen target project or evolution contract.
3. Add a failing test showing that an existing replay with a different target project or pack hash fails closed.
4. Implement `evolutionInstance` inheritance and protected context precedence.
5. Inject the frozen target-evolution context into Planner, Worker, Verifier, and Outcome Review prompts through existing run context rendering.
6. Run focused adversarial and runner tests.
7. Commit only Task 3 files.

### Task 4: Add the Hodor designed-state reference pack

**Files:**
- Create: `docs/target-system-evolution.md`
- Create: `docs/examples/hodor-evolution-pack-v0.json`
- Create: `tests/fixtures/hodor-evolution-pack-v0.json`
- Modify: `tests/target-evolution.test.ts`

**Steps:**

1. Add a failing test that parses the checked-in Hodor pack and its embedded `firstCandidate` using the production parser.
2. Add assertions for Hodor ownership, prohibited production mutations, zero-side-effect experiment policy, and `designed` maturity.
3. Add the minimal reference JSON with spatial-risk policy as the first future shadow experiment.
4. Document the kernel/project/delivery boundary, maturity states, and the later ProductionEpisode, HarnessVariant, MatchedExperiment, and PromotionReceipt contracts.
5. Run the fixture test and documentation diff check.
6. Commit only Task 4 files.

### Task 5: Verify and review

**Files:**
- Review all files changed by Tasks 1-4.

**Steps:**

1. Run `bun test tests/target-evolution.test.ts`.
2. Run focused design action, runner, and CLI tests.
3. Run `bun run typecheck`.
4. Run `bun test tests/cli.test.ts`.
5. Run `bun test`.
6. Run `git diff --check`.
7. Confirm `package.json`, `bun.lock`, schema, runtime databases, `README.md`, and `docs/default-runbook.md` are unchanged.
8. Request an independent architecture and security review.
9. Address findings with new failing tests before implementation changes.
10. Commit the final reviewed delta, push the feature branch, merge it into `main`, push normally, and independently read back `origin/main`.
