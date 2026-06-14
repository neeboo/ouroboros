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

# synchronous task execution
bun run cli -- run-next --run-id <run_id> --executor noop --limit 2
bun run cli -- run-next --run-id <run_id> --executor acpx-codex --cwd "$(pwd)" --approval approve-reads --limit 2
bun run cli -- run-next --run-id <run_id> --executor codex-cli --cwd "$(pwd)" --sandbox read-only --codex-bin "$(command -v codex)" --model gpt-5-codex --limit 2
bun run cli -- run-next --run-id <run_id> --executor codex-cli --cwd "$(pwd)" --timeout-ms 1800000 --idle-timeout-ms 300000
bun run cli -- run-next --run-id <run_id> --executor codex-cli --worktree-root ".ouroboros/worktrees" --limit 2
bun run cli -- run-next --run-id <run_id> --executor codex-cli --worktree-root ".ouroboros/worktrees" --start-hook git-worktree
bun run cli -- run-loop --run-id <run_id> --executor codex-cli --cwd "$(pwd)" --stop-hook create-tasks,create-verifier,create-repair,context-summary --max-rounds 8

# resumable Codex CLI execution
bun run cli -- run-loop --run-id <run_id> --executor codex-resumable --cwd "$(pwd)" --sandbox workspace-write --timeout-ms 1800000 --idle-timeout-ms 300000 --stop-hook create-tasks,create-verifier,create-repair,context-summary --max-rounds 8
bun run cli -- codex-start-attempt --task-id <task_id> --cwd "$(pwd)" --sandbox workspace-write --timeout-ms 1800000 --idle-timeout-ms 300000
bun run cli -- list-running-attempts --run-id <run_id>
bun run cli -- codex-resume-attempt --attempt-id <attempt_id> --cwd "$(pwd)" --sandbox workspace-write --timeout-ms 1800000 --idle-timeout-ms 300000

# observability
bun run cli -- run-overview --run-id <run_id>
bun run cli -- dashboard --run-id <run_id> --port 7331

# manual attempt control
bun run cli -- start-attempt --task-id <task_id> --input-json '{}'
bun run cli -- finish-attempt --attempt-id <attempt_id> --output-json '{"status":"done","summary":"..."}'
bun run cli -- record-attempt --task-id <task_id> --input-json '{}' --output-json '{"status":"done","summary":"..."}'
bun run cli -- retry-task --task-id <task_id>

# lessons and editable prompt templates
bun run cli -- list-lessons --run-id <run_id>
bun run cli -- show-task-prompt --task-id <task_id>
bun run cli -- show-prompt-template --key task
bun run cli -- show-prompt-template --key context-summary
bun run cli -- set-prompt-template --key task --content "# Custom template..."
```

`run-next` leases ready tasks first, assigns each task a separate session name, then runs the selected executor for each leased task. The `acpx-codex` executor creates or reuses an `acpx codex` named session per task. The `codex-cli` executor is a one-shot fallback for environments where the ACP adapter cannot create sessions.

`run-loop` repeats the same leasing and execution flow until there are no ready tasks, or until `--max-rounds` is reached.

For `codex-resumable`, an idle run does not blindly create another planner. When there are no `todo` or `running` tasks, `run-loop` creates a `goal-review` task that asks whether the original run goal is complete. A `goal-review` attempt must return `runDecision: "complete"`, `"continue"`, or `"verify"`. `complete` marks the run done and creates no tasks. `continue` or `verify` must include exactly one `nextTasks` item.

Use `--worktree-root` to assign each leased task a separate working directory path. The executor receives that path as its cwd.

Use `--start-hook git-worktree` with `--worktree-root` to create a real git worktree before the subagent runs.

Use `--timeout-ms` as a generous hard runtime cap. Use `--idle-timeout-ms` to stop commands only after they stop producing stdout or stderr. Long-running Codex work should use a large hard cap and rely on idle timeout for stuck-process detection.

`codex-start-attempt` starts a resumable Codex CLI task with `codex exec --json`. If the command window ends after Codex emits a session id, Ouroboros records a `running` attempt instead of marking the task blocked. `codex-resume-attempt` resumes that session with `codex exec resume <session_id>` and finishes the same attempt when structured JSON is returned.

`list-running-attempts` shows attempts that can be resumed. `start-attempt` and `finish-attempt` are lower-level commands for tools that want to manage running attempts themselves.

`run-overview` returns the run, tasks, observable sessions, and recent attempt events as JSON. `dashboard` starts a local web page that polls the same overview data so planner, worker, and verifier sessions can be watched side by side while they run.

Runner stop hooks run after a subagent turn and before the attempt is recorded. Hooks can append checks/artifacts/problems and decide `exit`, `continue`, or `retry`, which prevents a subagent from repeating itself indefinitely.

Stop hooks are role-scoped by the CLI:

```text
planner  -> create-tasks
worker   -> create-verifier
verifier -> create-repair, context-summary
```

The `create-tasks` stop hook turns planner `nextTasks` output into real DB tasks.

The `create-verifier` stop hook turns a successful worker attempt into a verifier task that depends on the worker. Multiple stop hooks can be enabled with a comma-separated list, for example `--stop-hook create-tasks,create-verifier`.

The `create-repair` stop hook turns a blocked verifier attempt into a ready worker repair task. A successful repair can then create another verifier through `create-verifier`.

The `context-summary` stop hook runs for verifier tasks. It rewrites verbose attempt summaries into compact reusable context and adds `context_experience_archive` and `context_lesson_archive` artifacts.

Every finished attempt also creates a run lesson. Successful attempts become `experience`; blocked attempts become `lesson`. Future prompts include compact lessons so the next loop can reuse working patterns and avoid known failures without growing prompts indefinitely. The task prompt currently includes the latest 12 lessons, with each summary compacted to 320 characters.

Prompt Markdown is stored in SQLite under `prompt_templates`. The default keys are `task`, `verifier-task`, `repair-task`, and `context-summary`, so the loop prompt, verifier prompt, repair prompt, and context-summary prompt can be edited without changing code.

## Boundaries

The local harness handles:

- task dependency scheduling
- worktree assignment
- session assignment
- prompt generation
- attempt recording
- lesson recording
- verification result handling
- repair task creation

The Linear bridge handles:

- Linear issue events
- Linear comments
- PR status updates
- mapping external issues to local runs or tasks
- posting progress and verifier summaries back to Linear

The bridge writes external events into the harness inbox. The harness decides what those events mean.
