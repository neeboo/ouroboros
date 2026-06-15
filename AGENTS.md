# Ouroboros Agent Instructions

This repository is building a local harness for autonomous coding loops. Treat it as a control system, not a prompt collection.

## Core Loop

Use this order for non-trivial work:

1. Define or inspect the goal contract.
2. Let planning sharpen the task graph and verifier contract.
3. Freeze the verifier contract before execution.
4. Run workers against the frozen contract.
5. Run verifiers against evidence, not agent confidence.
6. Create repair tasks for verifier failures.
7. Run goal review only when active work is drained.

Execution may satisfy a contract, but it must not quietly weaken the contract.

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
