# Ouroboros Agent Instructions

This repository is building a local harness for autonomous coding loops. Treat it as a control system, not a prompt collection.

## Core Loop

For normal project work, follow `docs/default-runbook.md` first. The default route is Codex for `designer`, `planner`, `verifier`, `outcome-review`, and `goal-review`, plus Claude Code for `worker`.

The Designer-first control plane is the default operating mode. A run starts with a `designer` task that reads the active founder charter, strategy signals, lessons, run evidence, and due outcome reviews. The designer emits one of:

- an evidence-backed `proposeDesign` action with a frozen evaluation contract;
- a mutation-free quiescent decision (no design actions) when no signal justifies new work — the rationale lives in the attempt summary;
- a `recordSignal` action that captures fresh evidence for a later cycle.

Planner runs only start from accepted proposals. A high-risk proposal that has not passed its authority gate cannot create delivery runs by writing prompt prose — the fixed `createRunsFromDesign` action reads the stored accepted proposal and copies the frozen contract into the child run context.

Use this order for non-trivial work:

1. Activate or inspect the founder charter.
2. Let the designer research evidence and propose (or quiesce).
3. Apply the deterministic authority gate; record human decisions through `decideDesign`.
4. Let planning sharpen the task graph and verifier contract from the accepted proposal.
5. Freeze the verifier contract before execution.
6. Run workers against the frozen contract.
7. Run verifiers against evidence, not agent confidence.
8. Create repair tasks for verifier failures.
9. Run goal review only when active work is drained.
10. After verified integration, run outcome review against the frozen evaluation contract.

Execution may satisfy a contract, but it must not quietly weaken the contract.

## Designer Boundaries

The designer is a bounded product founder. It can research, form hypotheses, compare alternatives, and propose product or system changes inside the active charter. It does not optimize for its own survival, revenue alone, benchmark scores alone, or novelty.

Hard boundaries:

- The designer cannot amend the founder charter. Only a human or explicitly configured governance actor can activate a new charter version.
- The designer cannot represent a high-risk proposal as human-approved through its own output payload. Decisions are recorded as `design_decisions` rows by the authority gate or by an explicit `decideDesign` action.
- The designer cannot bypass evidence validity or spending checkpoints. The authority evaluator rejects malformed or stale proposals and independently decides evidence-backed technical changes.
- The designer cannot mutate strategy records through prose. Durable conclusions return through fixed actions: `recordSignal`, `proposeDesign`, `decideDesign`, `recordDesignOutcome`, `createRunsFromDesign`.
- The designer must consider removal. A proposal that adds complexity without naming its maintenance cost is incomplete.

## Authority And Human Checkpoints

The authority evaluator is a pure function over the active charter and a proposal. Ouroboros' managed charter uses `humanApprovalPolicy: "cost-only"`: evidence-backed zero-spend technical and product proposals are decided automatically, while malformed or stale proposals are rejected and returned for revision.

Human checkpoints are reserved for monetary decisions:

- one-time or recurring spend;
- capital-policy changes;
- purchasing commitments;
- recurring infrastructure commitments.

The designer may propose a charter amendment. The proposal records the diff and rationale; only the configured governance actor can activate it.

## Evidence Expiry And Quiescence

Every strategy signal records its source, observation time, confidence, evidence, and expiry. Expired market, pricing, and model claims cannot authorize a new investment until refreshed. Conflicting signals are preserved rather than overwritten.

When no trigger and no evidence-backed opportunity exists, the designer returns a mutation-free quiescent decision. The rationale lives in the durable attempt summary and the run's exit reason — it names which signals were inspected, why no work is justified, and when the next review cadence falls. The quiescent cycle writes no new strategy signal, proposal, or design decision, so a quiet repository stays quiet rather than waking itself.

## Outcome Review

An implemented proposal moves into `measuring` after verified integration. The harness creates a bounded `outcome-review` task whose config carries the frozen evaluation contract, baseline, success metrics, guard metrics, and review time. The reviewer records baseline, observed metrics, evidence, unexpected effects, and a `retain`, `revise`, or `retire` recommendation through `recordDesignOutcome`.

Adverse outcomes (revise, retire) become new strategy signals without silently reopening completed delivery tasks. The next designer cycle decides whether the signal justifies new work.

## Contracts

Prefer small JSON contracts stored in the harness database or task config.

A goal contract should cover:

- desired final state
- success criteria
- constraints
- required evidence
- budget or retry limits
- stop policy

A verifier contract should cover:

- deterministic checks
- agent review rubric
- required artifacts
- failure modes to catch
- repair policy
- amendment policy

If a verifier contract is wrong, create an explicit amendment path. Do not hide contract changes inside worker prompts.

## Verification

Use deterministic checks whenever possible: typecheck, tests, lint, browser checks, scripts, diff inspection, or reproducible commands.

Use agent review only for fuzzy judgment: product feel, UI hierarchy, architectural fit, plan quality, or ambiguous completion.

Verifier output should cite evidence. A worker saying it is done is not evidence.

## Lessons and Experience

Lessons are for failures, near misses, blocked verifiers, brittle assumptions, and repeated mistakes.

Promote repeated lessons into guardrails:

- role-scoped rules
- preflight checks
- planner constraints
- verifier checklist items

Experience records successful patterns and useful commands. Keep experience as compact evidence for future prompts. Do not promote experience into repo skills unless a human explicitly asks for that.

## Planning

Planners should split work only when each task has:

- one role
- one concrete goal
- clear dependencies
- done criteria
- expected evidence
- a natural verifier or repair path

Do not start broad implementation from vague tasks. Create another planner task when the next step is still underspecified.

## Dashboard and UX

The dashboard is the control surface for long-running work.

When changing the dashboard, preserve:

- active goal visibility
- task and session relationship
- streaming updates without full-page flashing
- stable scroll behavior
- text truncation for long titles
- evidence visibility: checks, artifacts, files, diffs, and verifier decisions

Verify meaningful dashboard changes in a browser when possible.

## Worktrees and Sessions

Independent tasks should be able to run in separate sessions and worktrees.

When reading changed files or diffs for a task, use the task worktree when one exists. Do not assume the main worktree contains the task result.

## Scope

Keep protocols small. Prefer JSON fields and narrow hooks before adding new subsystems.

Avoid adding dependencies unless they directly improve scheduling, verification, observability, or dashboard usability.
