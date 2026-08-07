# Ouroboros Autonomous Self-Improvement

Ouroboros owns the goals in this loop. The human supplies the durable mission and safety boundaries once; each cycle derives its own concrete improvement goal from repository state, run evidence, verifier results, lessons, and operational failures.

The default route is Designer-first. A root run starts with a `designer` task that reads the active founder charter, strategy signals, lessons, run evidence, and due outcome reviews. The designer emits one evidence-backed proposal (with a frozen evaluation contract) or a mutation-free quiescent decision whose rationale lives in the attempt summary. Accepted low-risk proposals create a child planner run automatically; high-risk proposals block on a human `decideDesign`. Implemented proposals move into outcome review after verified integration. Ouroboros waits when the evidence does not justify another change.

## Default Command

```bash
orbs self-iterate-launch --parallel auto
```

This starts the dashboard and `self-improve-daemon`. Use `orbs self-iterate` only when a root assessment run should be created without starting background processes.

## Control Model

The loop has three levels:

1. The root run is the durable history anchor and carries the self-improvement mission, role routing, model defaults, guardrails, repository fingerprint, and the active founder charter.
2. A designer cycle inspects current evidence and emits at most one evidence-backed proposal (or a mutation-free quiescent decision recorded in the attempt summary). Accepted low-risk proposals spawn a child planner run via `createRunsFromDesign`.
3. The child run plans worker and verifier tasks, executes them in isolated worktrees when configured, repairs failures, runs goal review, integrates verified changes, and creates a bounded `outcome-review` task that records `retain`/`revise`/`retire`.

After the run tree drains, the daemon compares the repository fingerprint with the fingerprint used by the last designer cycle:

- changed repository: create another designer cycle;
- unchanged repository with no unresolved blocked delivery: enter `quiescent` and wait;
- blocked delivery: reopen the same run and create an automatic recovery task; return Claude Code failures to Codex, continue Codex failures as bounded Codex repair, and use Codex to diagnose logical or verification blocks;
- active or repairable work: continue supervising the same run tree;
- exhausted local retry budget: preserve auditable evidence and continue through automatic recovery; only a monetary or capital-policy checkpoint may wait for human authority.

This prevents both “say next before it moves” and repeated no-op planning.

## Designer Cycle Contract

The designer task at the root of each cycle must inspect:

- `README.md`, `AGENTS.md`, and the control-loop documentation;
- the active founder charter (`orbs design-status`);
- current strategy signals (`orbs list-signals`) and any conflicting or expired entries that need follow-up;
- due design outcome reviews (`orbs list-design-outcomes --status due --due-before <ISO UTC>`) that may reopen accepted decisions;
- current source, tests, and dashboard behavior;
- recent run graphs, attempts, verifier decisions, integrations, and outcome reviews;
- lessons, repeated failure patterns, and active guardrails;
- the repository diff and current Git state.

It returns one of the following through fixed actions:

- `recordSignal` to capture a fresh sourced observation with confidence, evidence, and expiry;
- `proposeDesign` with options, recommendation, evaluation contract, and investment shape — the proposal is the only path to a child planner run;
- a mutation-free quiescent decision (no `recordSignal`, no `proposeDesign`) when no evidence justifies new work. The rationale lives in the attempt summary so the loop stays asleep.

The authority evaluator applies the active charter before any scoring. Automatic authority is limited to reversible experiments inside the experiment budget that cite current (non-expired) evidence and do not cross a mission, capital, legal, privacy, destructive, production, dependency, schema, or infrastructure-commitment checkpoint. Everything else blocks on a human `decideDesign`.

When the proposal is accepted, `createRunsFromDesign` reads the stored proposal, copies the frozen evaluation contract and proposal id into the child run context, and starts a planner run. The proposing designer cannot represent a high-risk proposal as human-approved through its own output payload — the gate writes the `design_decisions` row, not the prompt.

## Role And Model Defaults

Self-improvement uses these Codex defaults:

| Role | Model | Reasoning |
| --- | --- | --- |
| designer | `gpt-5.6-sol` | `high` |
| planner | `gpt-5.6-sol` | `high` |
| verifier | `gpt-5.6-sol` | `high` |
| outcome-review | `gpt-5.6-sol` | `high` |
| goal-review | `gpt-5.6-sol` | `high` |
| worker on Codex | `gpt-5.6-luna` | `high` |

Repository config can override these values. Claude Code workers remain isolated from inherited Codex model settings; only an explicit task-level Claude model preference is passed to that backend.

The default backend routing is:

- `designer`, `planner`, `worker`, `verifier`, `outcome-review`, and `goal-review`: `codex-resumable`;
- Claude Code: only for a task with an explicit `config.agentBackend = "claude-code"`;
- repair work: bounded `codex-resumable` routing.

The supervisor does not rotate backends automatically or retry forever. Each recovery charges `repairReplanBudget`, records `fromBackend`, `toBackend`, `sourceAttemptId`, `terminalReason`, and `generation`, and preserves the source worktree and task contract.

Child runs inherit model defaults, agent defaults, agent backend definitions, the active founder charter, the frozen evaluation contract, and active guardrails at the protocol layer. Planners do not need to repeat control-plane fields in prompts.

## Planning Boundary

A child planner has split the goal enough when every proposed task has:

- one role and one concrete result;
- explicit dependencies when order matters;
- exact files, commands, or evidence to inspect;
- three to five `doneWhen` checks;
- a deterministic or agent verifier path;
- a repair path for failed verification.

Worker execution cannot weaken the verifier contract. Contract amendments require an explicit planner or human checkpoint.

## Integration And Concurrency

`self-improve-daemon` supervises the root and every descendant run. Automatic parallelism chooses conservative run and task slots. Independent tasks use separate worktrees when `git-worktree` is enabled.

Verified self-improvement changes are integrated into the local target branch by default so the repository fingerprint advances and the next assessment sees the new baseline. Pushing remains opt-in through `--integration-push true`. Use `--no-integrate true` only for experiments that must leave worktrees unmerged.

## Human Checkpoints

Pause with clear evidence when a designer cycle proposes:

- a founder charter amendment (mission, capital limits, or principles);
- a database schema migration;
- a new runtime dependency;
- a repository ownership or module-boundary change;
- a prompt or verifier contract amendment;
- destructive Git or deployment actions;
- production deployment, billing, purchasing, or recurring infrastructure spend;
- ambiguous product behavior that evidence cannot resolve.

The authority evaluator rejects high-risk proposals before any scoring. The controller may continue through implementation, tests, verification, repair, and local integration without a human checkpoint when the frozen contracts and configured budgets cover the work and the proposal passed its authority gate.

## Outcome Review

After verified integration, the linked proposal moves into `measuring` and a bounded `outcome-review` task is created whose config carries the frozen evaluation contract, baseline, success metrics, guard metrics, and `reviewAt`. The reviewer records baseline, observed metrics, evidence, unexpected effects, and a `retain`, `revise`, or `retire` recommendation through `recordDesignOutcome`.

Adverse outcomes (revise, retire) become new `strategy_signal` records without silently reopening completed delivery tasks. The next designer cycle decides whether the signal justifies new work. A retained outcome closes the loop until the next review cadence.

## Inspection

```bash
orbs design-status                                       # active charter, current proposal, latest decision, next review
orbs list-signals                                        # expiring evidence by class and status
orbs show-design --proposal-id <id>                      # frozen contract, options, decisions, outcomes
orbs list-design-outcomes --status due --due-before <ISO UTC> # due outcome reviews only, deterministically filtered
orbs run-overview --run-id <root_run_id>
orbs run-graph --run-id <root_run_id>
orbs run-evidence --run-id <root_run_id>
orbs list-lessons --run-id <root_run_id>
```

All four Designer inspection commands (`design-status`, `list-signals`, `show-design`, `list-design-outcomes`) are read-only: they open an existing database in non-mutating mode and never create or alter schema, sidecar, or filesystem state, so the cycle can run inside a restricted Designer worktree that cannot write to the database.

The dashboard should show the root mission, designer cycle, accepted proposal, generated child goals, worker/verifier sessions, current todos, evidence, outcome review, and supervisor state as one continuous history.
