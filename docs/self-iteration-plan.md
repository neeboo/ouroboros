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

## Next Iteration Goal

Make Ouroboros able to plan and drain its own next improvement cycle before it asks for human intervention.

The current self-iteration state is past bootstrap, past the first frozen verifier-contract slice, and past the candidate-guardrail prompt work. The self-iteration command exists, planner-created worker tasks can carry a frozen verifier contract through task config into verifier creation, repeated lessons are already rendered as prompt-only candidate guardrails, and successful experiences are already rendered as reusable evidence.

This slice follows commits `592d380` for role model defaults and `18265b4` for explicit goal-review decision recovery. Those behaviors are already accounted for and stay out of scope here.

The next planning candidate after this slice is durable lesson-to-guardrail promotion: active role-scoped guardrails, preflight checks, or schema-backed persistence will require a later planner or amendment slice with an explicit boundary. Keep that future path separate. Do not change database schema, prompt contracts, or dependency sets until a planner has proposed the smallest verifiable slice and an amendment path.

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
