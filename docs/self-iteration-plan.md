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

## Next Iteration Goal

Make Ouroboros able to plan its own next improvement cycle before it implements anything.

The first self-planning run should produce a task graph that is narrow enough to execute safely, but complete enough that a human can understand why each task exists.

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
- this document
- `packages/cli/src/dashboard.ts`
- `packages/cli/src/main.ts`
- `packages/runner/src/runner.ts`
- recent run lessons from the harness database

It should return structured JSON with exactly one `nextTasks` item. That item should be either:

- a smaller planner task if the next improvement area is still broad;
- a worker task if the next increment is obvious and testable;
- a verifier task if the current baseline may already satisfy the goal.

## Candidate Improvement Areas

The planner should choose only one area per cycle:

- make the dashboard explain task-level actions versus runner-level actions more clearly;
- add a first-class self-iteration command that creates the run, planner task, dashboard, and runner together;
- persist dashboard-selected goal and scroll position without flashing;
- expose the generated task graph as a simple graph view;
- add a Linear bridge skeleton that maps local runs and tasks to external issues;
- improve run completion review so it can cite evidence from docs, tests, dashboard state, and lessons.

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
- its planner has produced a fine-grained next task or a justified verifier task;
- the dashboard shows the active goal, task stream, todos, and runner state for that run;
- the generated plan points to concrete files and checks;
- no implementation task starts from an underspecified prompt.
