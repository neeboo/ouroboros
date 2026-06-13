# Ouroboros

Ouroboros is a minimal local harness for self-prompting agent loops.

The system has two separate parts:

- **local harness**: owns runs, tasks, attempts, worktrees, sessions, verification, and repair loops.
- **Linear bridge**: listens to external collaboration events and mirrors useful progress back to Linear and PRs.

Linear is the collaboration surface. GitHub is the code surface. The harness database is the local control plane.

## Core Idea

The harness does not treat prompts as state. It derives prompts from database state, runs an agent, validates structured output, then updates the database.

```text
goal -> task graph -> ready task -> prompt -> agent attempt
     -> structured result -> verification -> done / repair / blocked
```

## Minimal Pieces

```text
docs/protocol.md                 Minimal runtime protocol
packages/harness/schema.sql      SQLite schema for the harness and bridge
packages/harness/src/            Local harness library
packages/runner/src/             Prompt builder and task runner
packages/cli/src/                Local CLI wrapper
```

## Local Commands

```bash
bun run cli -- init
bun run cli -- create-run --goal "Use Ouroboros to iterate on Ouroboros"
bun run cli -- create-task --run-id <run_id> --role planner --goal "Plan next step" --prompt "Propose one small task."
bun run cli -- next-task --run-id <run_id>
bun run cli -- run-next --run-id <run_id> --executor noop --limit 2
bun run cli -- run-next --run-id <run_id> --executor acpx-codex --cwd "$(pwd)" --approval approve-reads --limit 2
bun run cli -- run-next --run-id <run_id> --executor codex-cli --cwd "$(pwd)" --sandbox read-only --codex-bin "$(command -v codex)" --model gpt-5-codex --limit 2
bun run cli -- run-next --run-id <run_id> --executor codex-cli --worktree-root ".ouroboros/worktrees" --limit 2
bun run cli -- run-next --run-id <run_id> --executor codex-cli --worktree-root ".ouroboros/worktrees" --start-hook git-worktree
bun run cli -- run-next --run-id <run_id> --executor codex-cli --cwd "$(pwd)" --stop-hook create-tasks
bun run cli -- run-loop --run-id <run_id> --executor codex-cli --cwd "$(pwd)" --stop-hook create-tasks --max-rounds 5
bun run cli -- run-loop --run-id <run_id> --executor codex-cli --cwd "$(pwd)" --stop-hook create-tasks,create-verifier --max-rounds 5
bun run cli -- record-attempt --task-id <task_id> --input-json '{}' --output-json '{"status":"done","summary":"..."}'
bun run cli -- retry-task --task-id <task_id>
```

`run-next` leases ready tasks first, assigns each task a separate session name, then runs the selected executor for each leased task. The `acpx-codex` executor creates or reuses an `acpx codex` named session per task. The `codex-cli` executor is a one-shot fallback for environments where the ACP adapter cannot create sessions.

`run-loop` repeats the same leasing and execution flow until there are no ready tasks, or until `--max-rounds` is reached.

Use `--worktree-root` to assign each leased task a separate working directory path. The executor receives that path as its cwd.

Use `--start-hook git-worktree` with `--worktree-root` to create a real git worktree before the subagent runs.

Runner stop hooks run after a subagent turn and before the attempt is recorded. Hooks can append checks/artifacts/problems and decide `exit` or `retry`, which prevents a subagent from repeating itself indefinitely.

The `create-tasks` stop hook turns planner `nextTasks` output into real DB tasks.

The `create-verifier` stop hook turns a successful worker attempt into a verifier task that depends on the worker. Multiple stop hooks can be enabled with a comma-separated list, for example `--stop-hook create-tasks,create-verifier`.

## Boundaries

The local harness handles:

- task dependency scheduling
- worktree assignment
- session assignment
- prompt generation
- attempt recording
- verification result handling
- repair task creation

The Linear bridge handles:

- Linear issue events
- Linear comments
- PR status updates
- mapping external issues to local runs or tasks
- posting progress and verifier summaries back to Linear

The bridge writes external events into the harness inbox. The harness decides what those events mean.
