# Autonomous Self-Improvement Controller Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let Ouroboros continuously assess itself, derive evidence-backed improvement goals, execute and verify them, integrate successful changes, and begin the next cycle without a human supplying each goal.

**Architecture:** Keep a root self-improvement run as the visible history anchor. Its assessment planner emits one concrete child run through `nextRuns`; the child planner decomposes that objective into worker and verifier tasks. A bounded daemon supervises the full run tree and creates another assessment only after the prior tree is drained and the repository fingerprint has changed. An unchanged fingerprint leaves the controller quiescent, preventing repetitive busywork.

**Tech Stack:** Bun, TypeScript, SQLite-backed Harness, Codex resumable runner, ACPX Claude Code worker routing, Git worktrees.

---

### Task 1: Persist Codex reasoning effort in model preferences

**Files:**
- Modify: `packages/harness/src/types.ts`
- Modify: `packages/cli/src/config.ts`
- Modify: `packages/runner/src/model-preferences.ts`
- Modify: `packages/runner/src/executors/types.ts`
- Modify: `packages/runner/src/executors/codex-cli.ts`
- Modify: `packages/runner/src/executors/codex-resumable.ts`
- Modify: `packages/runner/src/route-executor.ts`
- Modify: `packages/runner/src/codex-resumable-runner.ts`
- Test: `tests/config.test.ts`
- Test: `tests/codex-executor.test.ts`

**Steps:**
1. Add failing tests for `reasoning_effort = "high"` parsing and Codex start/resume command arguments.
2. Run the focused tests and confirm the missing field and missing `-c model_reasoning_effort="high"` argument failures.
3. Add `reasoning_effort` to model preference normalization and resolved attempt metadata.
4. Pass the resolved value to Codex CLI and resumable start/resume commands.
5. Run the focused tests until green.

### Task 2: Make self-assessment derive a child run goal

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/runner/src/hooks/create-runs.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/runner.test.ts`

**Steps:**
1. Change the self-iteration CLI expectations to require an assessment planner that emits `nextRuns`, plus built-in GPT-5.6 role defaults.
2. Add a failing hook test showing that child runs inherit model defaults, agent defaults, agent backends, and active guardrails from the parent run.
3. Replace the prompt-only self-iteration patch with a fixed assessment contract: inspect current evidence, derive one objective, and return one child run or no child when no meaningful gap exists.
4. Add built-in model defaults: global/worker `gpt-5.6-luna` high; planner/verifier/goal-review `gpt-5.6-sol` high. Explicit repository config remains higher priority.
5. Make `create-runs` inherit execution routing and guardrail context without asking the planner to repeat protocol fields.
6. Run the focused tests until green.

### Task 3: Add the continuous self-improvement daemon

**Files:**
- Modify: `packages/cli/src/main.ts`
- Test: `tests/cli.test.ts`

**Steps:**
1. Add a failing CLI test for `self-improve-daemon --max-ticks 1`: it creates an assessment run when none is active and scopes supervision to the root tree.
2. Add a failing test proving that an unchanged repository fingerprint leaves a drained tree quiescent instead of creating duplicate assessment runs.
3. Implement repository fingerprinting from Git HEAD plus tracked/untracked status.
4. Implement cycle creation under the original root run, carrying routing context and an incrementing cycle index.
5. Run the supervisor with automatic run/task concurrency and local integration enabled by default; pushing remains opt-in.
6. Update `self-iterate-launch` so its background supervisor uses the continuous controller.
7. Run the focused tests until green.

### Task 4: Publish the new defaults and operating contract

**Files:**
- Modify: `ouroboros.example.toml`
- Modify: `docs/self-iteration-plan.md`
- Modify: `docs/default-runbook.md`
- Modify: `docs/protocol.md`
- Modify: `docs/agent-backends.md`
- Modify: `README.md`

**Steps:**
1. Document the single command used to start autonomous self-improvement.
2. Explain the distinction between a durable mission, an assessment cycle, and a generated child-run goal.
3. Document quiescence, retry budgets, integration behavior, and human checkpoints.
4. Replace stale GPT-5.4/5.5 examples with GPT-5.6 Sol/Luna high defaults while keeping Claude Code worker routing clear.
5. Run `bun run typecheck`, focused tests, then the full `bun test` suite.
6. Inspect the staged file list, commit, and push `main`.
