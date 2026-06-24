# Harness-Managed ACP Subsessions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Let an Orbs task safely fan out bounded ACP/acpx child sessions inside its assigned worktree, while keeping ownership, status, cancellation, collection, and evidence in the harness database.

**Architecture:** Subsessions are protocol actions owned by Orbs. A planner, worker, verifier, or goal-review task may request a fixed `HarnessAction` payload, but only the harness validates and starts acpx, records `execution_threads`, watches status, cancels children, and collects summaries. Prompt text may describe the need for parallel work; it must not be the control plane.

**Tech Stack:** Bun, TypeScript, SQLite, existing `HarnessAction` events, existing `execution_threads`, existing acpx executor primitives, dashboard overview APIs.

---

## Non-Negotiable Constraint

Do not implement this as "tell the agent in a prompt to open child sessions and report back."

The implementation must make child-session lifecycle a harness-owned protocol:

1. A node emits a fixed, parseable action request.
2. Orbs validates ownership, cwd, limits, backend, and payload shape.
3. Orbs starts or cancels the child acpx session.
4. Orbs writes `execution_threads` and `harness_action_events`.
5. Orbs collects child outputs into parent attempt evidence.
6. Orbs exposes the child sessions to CLI and dashboard views.

Agents can propose work. The harness owns execution.

## Current Baseline

Relevant existing pieces:

- `docs/protocol.md` already defines `ExecutionThread` with `parent_thread_id`, `owner_type`, `owner_id`, `session_name`, `agent_session_id`, and `worktree_path`.
- `packages/harness/src/actions.ts` already defines audited fixed actions through `HarnessAction`, `parseHarnessAction`, and `applyHarnessAction`.
- `packages/harness/src/harness.ts` already supports `upsertExecutionThread`, `updateExecutionThread`, and `listExecutionThreads`.
- `packages/runner/src/executors/acpx.ts` already knows how to build acpx commands, create named sessions, run prompts, stream output, and classify idle failures.
- `packages/cli/src/action-server.ts` already exposes a DB-writable action bridge.

This means the first implementation should reuse existing tables and action plumbing before adding schema.

## Protocol Shape

Add three harness actions:

```ts
type HarnessAction =
  | {
      type: "startSubsession";
      parentTaskId: string;
      purpose: string;
      prompt: string;
      role?: string;
      backend?: string;
      sessionName?: string;
      timeoutMs?: number;
      idleTimeoutMs?: number;
    }
  | {
      type: "collectSubsessions";
      parentTaskId: string;
      status?: "running" | "done" | "blocked" | "interrupted" | "orphaned";
      reason?: string;
    }
  | {
      type: "cancelSubsessions";
      parentTaskId: string;
      threadIds?: string[];
      reason: string;
    };
```

Validation rules:

- `parentTaskId` must exist.
- The parent task must belong to a run.
- The parent task must have an assigned `worktreePath` or a resolvable run cwd.
- The child `cwd` must be the parent task worktree. No child action can choose an arbitrary cwd.
- `sessionName` must be generated or normalized by Orbs with a task prefix, for example `task_<id>__<slug>`.
- The action must enforce a small default limit, for example `maxSubsessionsPerTask = 3`.
- The action must reject prompt strings that are empty or too small to be meaningful.
- The action must reject unknown backends unless the run context declares them.
- Timeouts must have defaults and upper bounds.

Recording rules:

- `execution_threads.owner_type = "subsession"`.
- `execution_threads.owner_id = <harness action event id or generated subsession id>`.
- `execution_threads.parent_thread_id` points to the parent task attempt thread when available.
- `execution_threads.task_id = parentTaskId`.
- `execution_threads.worktree_path = parent worktree path`.
- `execution_threads.session_name = generated acpx session name`.
- `execution_threads.agent_session_id` records the acpx session identifier when available. If acpx only exposes the named session, record the same stable name.

## Implementation Tasks

### Task 1: Document the protocol in `docs/protocol.md`

Files:

- `docs/protocol.md`
- `docs/agent-backends.md`

Steps:

1. Add a section named `Harness-Managed Subsessions`.
2. State that subsessions are fixed actions, not prompt-managed behavior.
3. Define lifecycle states: `requested`, `running`, `done`, `blocked`, `interrupted`, `orphaned`. Map these to current `execution_threads.status` where possible.
4. Document the three actions: `startSubsession`, `collectSubsessions`, `cancelSubsessions`.
5. Add acpx-specific notes:
   - Orbs passes `--cwd <parent worktree>`.
   - Orbs uses named sessions.
   - Orbs treats ACP streams as observability, while final structured output and collected summaries remain the evidence contract.
6. Explain the first safe scope: child sessions may research, inspect, and propose; write-capable child sessions require explicit backend policy.

Tests:

- Documentation review only.

### Task 2: Add action parsing and validation

Files:

- `packages/harness/src/actions.ts`
- `packages/harness/src/types.ts` if shared types are needed
- New or existing action tests under the repo test suite

Steps:

1. Extend `HarnessAction` with the three subsession actions.
2. Extend `parseHarnessAction` with strict field parsing.
3. Add helper validation:
   - `requireParentTaskWithRun`
   - `resolveParentWorktree`
   - `normalizeSubsessionName`
   - `enforceSubsessionLimit`
4. For `collectSubsessions` and `cancelSubsessions`, block if the parent task has no recorded child threads.
5. Keep all failures as `HarnessActionResult` with useful checks and problems.

Tests:

```bash
bun test packages/harness
bun test
```

Expected coverage:

- Missing parent task blocks.
- Parent task without worktree blocks unless fallback cwd exists.
- Too many child sessions blocks.
- Session names are normalized and task-prefixed.
- Invalid backend blocks.

### Task 3: Extract reusable acpx session operations

Files:

- `packages/runner/src/executors/acpx.ts`
- New file, likely `packages/runner/src/acpx-subsessions.ts`
- `packages/runner/src/index.ts`

Steps:

1. Export a small internal API that can:
   - build the acpx base command
   - prepare backend environment
   - create or reuse a named session
   - submit a prompt with `--no-wait` when supported
   - inspect session status
   - cancel a session
2. Keep the existing executor behavior unchanged.
3. Prefer a narrow wrapper rather than moving the whole executor.
4. Preserve existing idle-timeout and diagnostic behavior.

Tests:

```bash
bun test packages/runner
bun test
```

Expected coverage:

- Command construction includes `--cwd <parent worktree>`.
- Built-in acpx agents and custom `agentCommand` are handled.
- Cancellation command is formed deterministically.
- No existing acpx executor tests regress.

### Task 4: Connect actions to runner-side subsession execution

Files:

- `packages/harness/src/actions.ts`
- `packages/runner/src/*`
- `packages/cli/src/main.ts`
- `packages/cli/src/action-server.ts`

Steps:

1. Decide the narrow boundary for executing side effects:
   - Either make `applyHarnessAction` accept an injected `subsessionRunner`.
   - Or route subsession actions through a CLI/server command that has runner dependencies.
2. Avoid importing runner code into harness if it creates a package cycle.
3. On `startSubsession`:
   - validate the action
   - record a `harness_action_events` row
   - create/update the child `execution_threads` row
   - start acpx asynchronously
   - return the thread id, session name, backend, cwd, and policy checks
4. On `collectSubsessions`:
   - inspect child threads
   - collect summaries or status from acpx
   - update thread statuses
   - write artifacts into the action result
5. On `cancelSubsessions`:
   - send cooperative acpx cancel
   - mark threads `interrupted` with `interruptReason`
   - report any cancel failures.

Tests:

```bash
bun test
bun run typecheck
```

Expected coverage:

- Harness can be tested with a fake `subsessionRunner`.
- No shell acpx call is required in unit tests.
- Action events are written for start, collect, and cancel.

### Task 5: Make parent attempts collect child evidence

Files:

- `packages/runner/src/codex-resumable-runner.ts`
- `packages/runner/src/hooks/*` if stop hooks need a collection phase
- `packages/harness/src/harness.ts`

Steps:

1. At parent attempt stop, list child threads for the parent task.
2. Run a bounded collection pass.
3. Add child summaries to attempt artifacts, for example:

```json
{
  "kind": "subsession_summary",
  "threadId": "thread_...",
  "sessionName": "task_...__research_api",
  "status": "done",
  "summary": "..."
}
```

4. If child sessions are still running after the parent attempt ends, either:
   - block the parent with a clear diagnostic, or
   - mark children orphaned and create a repair task.

Tests:

```bash
bun test
bun run typecheck
```

Expected coverage:

- Parent attempt output contains child artifacts.
- Running child sessions cannot silently disappear.
- Orphaned child sessions are visible in run overview.

### Task 6: Expose subsessions in CLI and dashboard

Files:

- `packages/cli/src/main.ts`
- Dashboard React files under `packages/cli/src/dashboard*` or current dashboard paths
- Existing run overview API

Steps:

1. Extend run overview to include child thread grouping.
2. Add CLI visibility:

```bash
orbs run-threads --run-id <run_id>
orbs action --action-json '{"type":"collectSubsessions","parentTaskId":"task_..."}'
orbs action --action-json '{"type":"cancelSubsessions","parentTaskId":"task_...","reason":"manual stop"}'
```

3. Dashboard should show child sessions under their parent task with:
   - role/backend
   - running/done/blocked/interrupted/orphaned status
   - last heartbeat
   - session name
   - latest summary when collected
4. Do not block the whole dashboard refresh while polling child sessions.

Tests:

```bash
bun test
bun run typecheck
```

Manual check:

```bash
orbs dashboard --run-id <run_id> --port 7331
```

### Task 7: Self-iteration acceptance run

Create a real Orbs run that asks the planner to use this plan to continue implementation.

Suggested run:

```bash
orbs create-run \
  --goal "Implement harness-managed ACP subsessions from docs/plans/2026-06-25-harness-managed-subsessions.md" \
  --project-root /Users/ghostcorn/dev/ouroboros
```

Suggested planner task:

```bash
orbs create-task \
  --run-id <run_id> \
  --role planner \
  --goal "Split harness-managed ACP subsessions into executable implementation tasks" \
  --prompt "Read docs/plans/2026-06-25-harness-managed-subsessions.md, docs/protocol.md, packages/harness/src/actions.ts, packages/runner/src/executors/acpx.ts, packages/harness/src/harness.ts, and packages/cli/src/main.ts. Produce a small task graph with frozen verifier contracts. Preserve the rule that child sessions are harness actions, not prompt-managed side effects."
```

Suggested loop:

```bash
orbs run-loop \
  --run-id <run_id> \
  --executor codex-resumable \
  --cwd /Users/ghostcorn/dev/ouroboros \
  --sandbox workspace-write \
  --timeout-ms 1800000 \
  --idle-timeout-ms 300000 \
  --stop-hook create-tasks,create-verifier,create-repair,context-summary \
  --concurrency auto \
  --worktree-root /Users/ghostcorn/dev/ouroboros-worktrees \
  --start-hook git-worktree \
  --max-rounds 8 \
  --max-tries 2
```

Acceptance criteria:

- The planner produces implementation tasks that mention action payloads, validation, collection, cancellation, and dashboard visibility.
- At least one verifier contract checks that child sessions are not only prompt instructions.
- Unit tests cover invalid payloads and missing parent task.
- No direct child acpx process is launched from a worker prompt without a recorded harness action.

## Risks

- Package layering: `@ouroboros/harness` should not depend on `@ouroboros/runner` if that creates a cycle. Use dependency injection or move runner side effects to CLI/action server.
- acpx async semantics may differ by agent. Start with a fake runner in tests and one proven local backend smoke.
- Cancellation may be best effort for some agents. Record the requested cancel and the observed result separately.
- Child write access can create merge conflicts inside the parent worktree. Phase 1 should default to read/propose unless an explicit backend policy enables writes.
- Dashboard polling must not block on acpx status calls.

## Definition of Done

- `docs/protocol.md` documents harness-managed subsessions.
- `HarnessAction` supports start, collect, and cancel with strict validation.
- Child sessions are represented as `execution_threads` with parent linkage.
- Parent attempts can collect child evidence.
- CLI and dashboard can show child sessions.
- Tests pass:

```bash
bun test
bun run typecheck
```

