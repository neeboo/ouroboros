# Ouroboros Autonomous Self-Improvement

Ouroboros owns the goals in this loop. The human supplies the durable mission and safety boundaries once; each cycle derives its own concrete improvement goal from repository state, run evidence, verifier results, lessons, and operational failures.

## Default Command

```bash
orbs self-iterate-launch --parallel auto
```

This starts the dashboard and `self-improve-daemon`. Use `orbs self-iterate` only when a root assessment run should be created without starting background processes.

## Control Model

The loop has three levels:

1. The root run is the durable history anchor and carries the self-improvement mission, role routing, model defaults, guardrails, and repository fingerprint.
2. An assessment run inspects current evidence and emits at most one concrete child goal through `nextRuns`.
3. The child run plans worker and verifier tasks, executes them in isolated worktrees when configured, repairs failures, runs goal review, and integrates verified changes.

After the run tree drains, the daemon compares the repository fingerprint with the fingerprint used by the last assessment:

- changed repository: create another assessment cycle;
- unchanged repository: enter `quiescent` and wait;
- active or repairable work: continue supervising the same run tree;
- exhausted retry budget or a human checkpoint: leave auditable blocked evidence.

This prevents both “say next before it moves” and repeated no-op planning.

## Assessment Contract

The assessment planner must inspect:

- `README.md` and the control-loop documentation;
- current source, tests, and dashboard behavior;
- recent run graphs, attempts, verifier decisions, and integrations;
- lessons, repeated failure patterns, and active guardrails;
- the repository diff and current Git state.

It returns one `nextRuns` item only when the evidence demonstrates a meaningful capability gap. The child run must contain:

- a concrete desired result;
- the evidence that proves the gap exists;
- exact files, commands, or runtime behavior for its planner to inspect;
- three to five completion checks;
- constraints and integration boundaries.

When no useful change is justified, it returns no child run and explains the quiescent decision in its summary.

## Role And Model Defaults

Self-improvement uses these Codex defaults:

| Role | Model | Reasoning |
| --- | --- | --- |
| planner | `gpt-5.6-sol` | `high` |
| verifier | `gpt-5.6-sol` | `high` |
| goal-review | `gpt-5.6-sol` | `high` |
| worker on Codex | `gpt-5.6-luna` | `high` |

Repository config can override these values. Claude Code workers remain isolated from inherited Codex model settings; only an explicit task-level Claude model preference is passed to that backend.

The default backend split remains:

- `planner`, `verifier`, and `goal-review`: `codex-resumable`;
- `worker`: `claude-code` when configured as the global or worker backend;
- repair work: worker routing.

Child runs inherit model defaults, agent defaults, agent backend definitions, and active guardrails at the protocol layer. Planners do not need to repeat control-plane fields in prompts.

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

Pause with clear evidence when a cycle proposes:

- a database schema migration;
- a new runtime dependency;
- a repository ownership or module-boundary change;
- a prompt or verifier contract amendment;
- destructive Git or deployment actions;
- ambiguous product behavior that evidence cannot resolve.

The controller may continue through implementation, tests, verification, repair, and local integration without a human checkpoint when the frozen contracts and configured budgets cover the work.

## Inspection

```bash
orbs run-overview --run-id <root_run_id>
orbs run-graph --run-id <root_run_id>
orbs run-evidence --run-id <root_run_id>
orbs list-lessons --run-id <root_run_id>
```

The dashboard should show the root mission, assessment cycles, generated child goals, worker/verifier sessions, current todos, evidence, and supervisor state as one continuous history.
