# Designer Control Plane Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a persistent, bounded designer loop that researches evidence, proposes and evaluates product or system changes, converts accepted designs into delivery runs, and records outcomes without letting prompt text bypass budget or human-approval rules.

**Architecture:** Add strategy entities to the existing SQLite harness and expose them through typed Harness methods and fixed action payloads. A designer task runs before planning, stores a proposal with a frozen evaluation contract, and may create delivery runs only after a deterministic authority gate accepts a reversible in-budget experiment or records a human decision. The self-improvement daemon observes due design and outcome work, stays quiescent without evidence, and keeps the existing planner, worker, verifier, goal-review, integration, and worktree machinery intact.

**Tech Stack:** Bun, TypeScript, SQLite, existing Harness actions and stop hooks, Codex resumable designer/planner/verifier, Claude Code workers, existing dashboard React boundary.

---

### Task 1: Add strategy domain types and persistent records

**Files:**
- Modify: `packages/harness/schema.sql`
- Modify: `packages/harness/src/database.ts`
- Modify: `packages/harness/src/types.ts`
- Modify: `packages/harness/src/rows.ts`
- Modify: `packages/harness/src/mappers.ts`
- Modify: `packages/harness/src/harness.ts`
- Test: `tests/harness.test.ts`

**Steps:**
1. Write failing harness tests that initialize a new database and migrate an existing database with no strategy tables.
2. Define typed records for `FounderCharter`, `StrategySignal`, `DesignProposal`, `DesignDecision`, and `DesignOutcome` using small JSON payloads for evolvable substructures.
3. Add `founder_charters`, `strategy_signals`, `design_proposals`, `design_decisions`, and `design_outcomes` tables with project/run/task references, timestamps, status checks, and useful indexes.
4. Add Harness create/get/list methods with generated ids, strict required fields, immutable charter versions, one active charter per project, and append-only decisions and outcomes.
5. Verify that activating a new charter supersedes the prior active version without deleting history.
6. Run `bun test tests/harness.test.ts` and confirm all strategy persistence tests pass.
7. Commit the domain slice.

### Task 2: Add fixed designer actions and deterministic validation

**Files:**
- Modify: `packages/runner/src/agent-actions.ts`
- Modify: `packages/runner/src/executors/output.ts`
- Create: `packages/runner/src/hooks/apply-design-actions.ts`
- Modify: `packages/runner/src/index.ts`
- Modify: `packages/cli/src/main.ts`
- Test: `tests/runner.test.ts`
- Test: `tests/cli.test.ts`

**Steps:**
1. Add failing parser tests for `recordSignal`, `proposeDesign`, `decideDesign`, `recordDesignOutcome`, and `createRunsFromDesign` action payloads.
2. Reject missing evidence references, empty alternatives, missing evaluation contracts, invalid investment values, unknown proposal ids, and malformed outcomes.
3. Extend `AttemptOutput` with typed design actions while preserving current `createTasks`, `createRuns`, and `setRunDecision` behavior.
4. Implement an `apply-design-actions` stop hook that performs validated Harness writes and records auditable harness action events.
5. Make `createRunsFromDesign` read the stored accepted proposal, copy its frozen evaluation contract and proposal id into child run context, and reject direct prompt-only run creation for a proposal that has not passed its authority gate.
6. Add the hook to the self-improvement default stop-hook sequence.
7. Run `bun test tests/runner.test.ts tests/cli.test.ts` until green.
8. Commit the fixed-action slice.

### Task 3: Implement the founder charter and authority policy

**Files:**
- Create: `packages/harness/src/design-authority.ts`
- Modify: `packages/harness/src/types.ts`
- Modify: `packages/harness/src/actions.ts`
- Modify: `packages/cli/src/main.ts`
- Test: `tests/harness-actions.test.ts`
- Test: `tests/cli.test.ts`

**Steps:**
1. Write failing tests for auto-approved reversible experiments, human-review proposals, budget rejection, expired evidence, and charter-amendment proposals.
2. Implement a pure authority evaluator that applies hard charter constraints before scoring options.
3. Allow automatic experiments only when reversibility is `easy`, one-time and recurring costs fit the configured experiment budget, evidence is current, and no legal, privacy, destructive, production, mission, dependency, schema, or infrastructure-commitment checkpoint is crossed.
4. Record the authority result as a `design_decisions` row with reasons and the charter version used.
5. Add a human `decideDesign` Harness action and CLI path for accepted, rejected, deferred, and retired decisions.
6. Ensure the proposing designer cannot represent a high-risk proposal as human-approved through its output payload.
7. Run `bun test tests/harness-actions.test.ts tests/cli.test.ts` until green.
8. Commit the authority slice.

### Task 4: Bootstrap the designer before planning

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/runner/src/prompt.ts`
- Modify: `packages/runner/src/model-preferences.ts`
- Modify: `ouroboros.example.toml`
- Test: `tests/cli.test.ts`
- Test: `tests/runner.test.ts`

**Steps:**
1. Add failing tests showing that a self-iteration root starts with a `designer` task and that no delivery child run is created from an unaccepted proposal.
2. Seed the Ouroboros default founder charter from `docs/designer-control-plane.md`, preserving explicit repository configuration ahead of built-in defaults.
3. Route `designer` to `codex-resumable` with `gpt-5.6-sol` and high reasoning by default; keep workers on the configured worker backend and preserve planner/verifier/goal-review routing.
4. Replace the assessment-planner prompt with a designer contract that reads the active charter, signals, lessons, run evidence, repository state, and due design outcomes.
5. Let the designer use existing harness-managed research subsessions, but require all durable conclusions to return through fixed designer actions.
6. Create a planner child run only from an accepted proposal and include the frozen proposal, evaluation contract, budget, integration boundary, and removal decisions in run context.
7. Record a justified quiescent designer decision when no current signal supports useful work.
8. Run `bun test tests/cli.test.ts tests/runner.test.ts` until green.
9. Commit the designer bootstrap slice.

### Task 5: Close the outcome and strategy refresh loop

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/harness/src/overseer.ts`
- Modify: `packages/runner/src/hooks/goal-review.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/harness.test.ts`

**Steps:**
1. Add failing tests for an implemented proposal entering `measuring`, a due outcome review becoming runnable, and a future review remaining idle.
2. After verified integration, update the linked proposal to `measuring` and create a bounded `outcome-review` task when its review time or configured immediate proxy review is due.
3. Record baseline, observed metrics, evidence, unexpected effects, and a `retain`, `revise`, or `retire` recommendation through `recordDesignOutcome`.
4. Convert failed assumptions and adverse outcomes into new strategy signals without silently reopening completed delivery tasks.
5. Make the self-improvement daemon consider due outcome reviews before asking the designer for a new proposal.
6. Keep the daemon quiescent when there are no due outcomes, fresh signals, active proposals, or changed repository evidence.
7. Run `bun test tests/cli.test.ts tests/harness.test.ts` until green.
8. Commit the outcome-loop slice.

### Task 6: Add inspection and focused dashboard visibility

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/dashboard.ts`
- Modify: `packages/cli/src/dashboard-messages.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/dashboard.test.ts`

**Steps:**
1. Add failing CLI tests for `design-status`, `list-signals`, and `show-design`.
2. Print the active charter, current proposal, authority result, budget, next review, and recent outcomes in concise human-readable form with optional JSON output.
3. Add the same data to the dashboard API without changing the canvas-first layout.
4. Show Designer, research subsessions, planner, workers, verifiers, and outcome review in the existing chronological conversation stream.
5. Keep financial detail and full proposal evidence behind one inspector disclosure so the default dashboard remains calm.
6. Run `bun test tests/cli.test.ts tests/dashboard.test.ts` until green.
7. Commit the inspection slice.

### Task 7: Publish the operating contract and dogfood it

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/protocol.md`
- Modify: `docs/control-loop-contracts.md`
- Modify: `docs/self-iteration-plan.md`
- Modify: `docs/default-runbook.md`
- Modify: `docs/agent-backends.md`
- Modify: `ouroboros.example.toml`
- Test: `tests/cli.test.ts`

**Steps:**
1. Document one default command for autonomous design and delivery, keeping manual action commands in a troubleshooting section.
2. Document role boundaries, founder charter ownership, strategy signal expiry, budget gates, quiescence, outcome review, and human checkpoints.
3. Add an Ouroboros-specific default charter and a small sample proposal covering a real reliability improvement.
4. Start a bounded dogfood run against the current repository and confirm the designer produces either one evidence-backed proposal or a cited quiescent decision.
5. Confirm an accepted low-risk proposal creates a planner run and an unaccepted high-risk proposal does not.
6. Run `bun run typecheck`.
7. Run `bun test` and require zero failures.
8. Inspect `git diff --check`, the staged file list, and runtime-path exclusions.
9. Commit and integrate the verified branch without pushing from an agent worktree; push only from the target branch after readback.
