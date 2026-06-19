# Ouroboros Self-Iteration Plan

This document is the seed plan for letting Ouroboros improve Ouroboros through its own run loop.

The human role is to provide the iteration goal and review visible artifacts. The harness role is to turn that goal into a small task graph, execute one increment at a time, verify the result, record lessons, and decide whether the run goal is complete.

## Current Baseline

Ouroboros already has the minimum working loop:

- SQLite-backed runs, tasks, attempts, lessons, prompt templates, sessions, and external refs.
- Planner, worker, verifier, repair, and goal-review roles.
- Stop hooks for task creation, verifier creation, repair creation, and context summaries.
- Resumable Codex execution with streaming attempt events.
- Dashboard visibility for goals, task flow, todos, sessions, runner state, and manual interruption.
- Bounded goal-review retries and proxy-aware child process execution.
- A first-class self-iteration bootstrap command that creates a self-iteration run, seeds the planner task, and can launch the dashboard and runner together.
- Frozen verifier-contract plumbing for planner-created worker tasks: optional `verifierContract` planner output stays backward-compatible when omitted, is persisted in task config when supplied, is injected into verifier prompts, and is cited on `created_verifier_task` artifacts.
- Prompt rendering already turns repeated lessons into prompt-only candidate guardrails and successful experiences into reusable evidence.
- Accepted active guardrails can now be carried in `run.context.guardrails` and rendered into matching role prompts before prompt-only candidate guardrails.

## Recovered Self-Iteration Backend Policy

Self-iteration runs keep `planner`, `verifier`, and `goal-review` on `codex-resumable` by default. This is the recovered policy after a real run observed the silent-start failure mode below. The `claude-code`/acpx backend stays available for `worker` and as the `agentDefaults.global` default so worker routes can still use Claude Code when configured.

Operational reason (concise): on `run_5a21fbd4ee724772bb543903b31dcf22`, attempt `attempt_49c1f7965ee74e5cbddb4eb9b79f89b7` on planner task `task_93d064b935f1484ba785a0f699bd4086` used route backend `claude-code`/acpx, stayed running from `2026-06-18 21:21:44` to `21:35:31`, produced zero attempt events, zero output, and no worktree changes, and was interrupted by the overseer after more than 13 minutes. The lesson is recorded in that run and rendered into future self-iteration planner prompts.

The recovered policy lives in `run.context.agentDefaults`:

```json
{
  "agentDefaults": {
    "global": "claude-code",
    "roles": {
      "planner": "codex-resumable",
      "verifier": "codex-resumable",
      "goal-review": "codex-resumable"
    }
  },
  "agentBackends": {
    "claude-code": { "kind": "acpx", "agent": "claude", "approval": "approve-all" },
    "codex-resumable": { "kind": "codex-resumable" }
  }
}
```

The bootstrap command does not force this context itself; it inherits `agentDefaults`/`agentBackends` from `ouroboros.toml` or `config.toml` via `withConfigDefaults`. Local configs that pin those roles to `codex-resumable` (as the committed `ouroboros.example.toml` recommends for `verifier`) carry the recovered policy forward into every self-iteration run.

### Verifying Future Self-Iteration Evidence

Use these commands to inspect a self-iteration run and confirm the recovered policy held:

```bash
# Run-level overview: goalContract, agentDefaults.roles, agentBackends, task graph, and latest attempts.
orbs run-overview --run-id <run_id>

# Run-level lessons: failure summaries and successful experiences with evidence.
orbs list-lessons --run-id <run_id>
```

When reviewing whether a future self-iteration run stayed on the recovered policy:

1. `orbs run-overview --run-id <run_id>` — confirm `run.context.goalContract` is present with desired state, success criteria, constraints, required evidence, budget, and stop policy; also confirm `run.context.agentDefaults.roles.planner`, `roles.verifier`, and `roles.goal-review` are all `codex-resumable`, and that `run.context.agentBackends` defines both `claude-code` and `codex-resumable`.
2. `orbs list-lessons --run-id <run_id>` — confirm no new silent-start lesson was recorded against `claude-code`/acpx planner attempts.
3. If a planner attempt blocked with a silent-start reason again, treat it as a regression of this policy and re-pin the role defaults before the next run.

## Next Iteration Goal

Make Ouroboros able to plan and drain its own next improvement cycle before it asks for human intervention.

The current self-iteration state is past bootstrap, past the first frozen verifier-contract slice, and past the candidate-guardrail prompt work. The self-iteration command exists, planner-created worker tasks can carry a frozen verifier contract through task config into verifier creation, repeated lessons are already rendered as prompt-only candidate guardrails, and successful experiences are already rendered as reusable evidence.

This slice follows commits `592d380` for role model defaults and `18265b4` for explicit goal-review decision recovery. Those behaviors are already accounted for and stay out of scope here.

The next planning candidate after this slice is automatic lesson-to-guardrail promotion: repeated lessons can be proposed as active role-scoped guardrails, preflight checks, or schema-backed persistence through a later planner or amendment slice with an explicit boundary. Keep that future path separate. Do not change database schema or dependency sets until a planner has proposed the smallest verifiable slice and an amendment path.

## Split-Enough Rule

A planner task has split the work enough when every proposed task has:

- one role: `worker`, `verifier`, or `planner`;
- one concrete goal that can be finished in one agent turn;
- one prompt with exact files, commands, or docs to inspect first;
- explicit `dependsOn` when ordering matters;
- three to five `doneWhen` checks;
- a clear artifact, code change, test, or decision;
- a natural failure path: verifier blocks, repair task is created, or goal-review asks for a new planner.

Do not start implementation from a vague task. If the next task still contains multiple unrelated product decisions, create another planner task instead.

## First Planning Prompt

The initial planner should inspect:

- `README.md`
- `docs/protocol.md`
- `docs/control-loop-contracts.md`
- this document
- `packages/cli/src/dashboard.ts`
- `packages/cli/src/main.ts`
- `packages/runner/src/runner.ts`
- recent run lessons from the harness database

It should return structured JSON with a small `nextTasks` graph. Prefer 2 to 5 tasks when there is enough certainty to split the work safely. A valid graph can include:

- planner tasks when a subproblem needs more decomposition;
- worker tasks for concrete implementation increments;
- verifier tasks when a current baseline or worker output needs independent validation.

Use `dependsOn` to express graph order. Independent worker tasks can run in parallel. Do not force everything into one task just because it is the first planning pass.

## Candidate Improvement Areas

The planner should choose as many areas as can be split into independent, verifiable tasks without making the graph vague. Prefer one area when dependencies or product decisions are still unclear. Prefer multiple areas when they can run independently under the configured concurrency:

- make the dashboard explain task-level actions versus runner-level actions more clearly;
- add a first-class self-iteration command that creates the run, planner task, dashboard, and runner together;
- persist dashboard-selected goal and scroll position without flashing;
- expose the generated task graph as a simple graph view;
- add a Linear bridge skeleton that maps local runs and tasks to external issues;
- improve run completion review so it can cite evidence from docs, tests, dashboard state, and lessons.
- extend the planning loop beyond the verified task-level verifier-contract baseline toward run-level contract amendment and audit paths.
- promote repeated lessons into durable active guardrails, preflight checks, or schema-backed guardrail storage in a later slice while keeping repeated experiences as reusable evidence patterns; this future path remains separate from the current prompt-only baseline.

## Human Checkpoints

Pause for human review when:

- a task wants to change repository structure;
- a task wants to introduce a new dependency;
- a task wants to alter the prompt contract or database schema;
- a verifier finds ambiguous product behavior;
- the run is done and the dashboard claims there is no queued work.

## Completion Criteria

This self-iteration planning cycle is complete when:

- a new Ouroboros run exists for self-iteration;
- its planner has produced a fine-grained task graph or a justified verifier task;
- the dashboard shows the active goal, task stream, todos, and runner state for that run;
- the generated graph points to concrete files and checks;
- no implementation task starts from an underspecified prompt;
- the run-loop can drain the generated graph to either done tasks, blocked tasks with repair paths, or a goal-review decision.
