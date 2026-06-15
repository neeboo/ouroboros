# Ouroboros

Ouroboros is a minimal local harness for self-prompting agent loops.

The system has two separate parts:

- **local harness**: owns runs, tasks, attempts, worktrees, sessions, verification, and repair loops.
- **Linear bridge skeleton**: records local mappings to Linear projects and issues so later sync work has stable anchors.

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
docs/control-loop-contracts.md   Planning, verification, guardrails, and experience
packages/harness/schema.sql      SQLite schema for the harness and bridge
packages/harness/src/            Local harness library
packages/runner/src/             Prompt builder and task runner
packages/cli/src/                Local CLI wrapper
```

## Local Commands

Local development uses `bun run orbs -- ...`. The distribution target is a Homebrew-installed binary:

```bash
brew install orbs
orbs init
```

```bash
bun run orbs -- init
bun run orbs -- self-iterate
bun run orbs -- self-iterate-launch --concurrency 3 --worktree-root .ouroboros/worktrees --start-hook git-worktree
bun run orbs -- create-project --name "Ouroboros" --root-path "$(pwd)"
bun run orbs -- create-run --goal "Use Ouroboros to iterate on Ouroboros"
bun run orbs -- create-run --goal "Use Ouroboros to iterate on Ouroboros" --project-root "$(pwd)"
bun run orbs -- create-run --goal "Use Ouroboros to iterate on Ouroboros" --context-json '{"modelDefaults":{"roles":{"worker":{"model":"gpt-5-mini"},"verifier":{"model":"gpt-5-mini"}}}}'
bun run orbs -- create-task --run-id <run_id> --role planner --goal "Plan next step" --prompt "Propose one small task."
bun run orbs -- create-task --run-id <run_id> --role worker --goal "Cheap follow-up" --prompt "Implement the follow-up." --config-json '{"modelPreference":{"model":"gpt-5-mini","reason":"low-risk task"}}'
bun run orbs -- next-task --run-id <run_id>

# synchronous task execution
bun run orbs -- run-next --run-id <run_id> --executor noop --limit 2
bun run orbs -- run-next --run-id <run_id> --executor acpx-codex --cwd "$(pwd)" --approval approve-reads --limit 2
bun run orbs -- run-next --run-id <run_id> --executor codex-cli --cwd "$(pwd)" --sandbox read-only --codex-bin "$(command -v codex)" --model gpt-5-codex --limit 2
bun run orbs -- run-next --run-id <run_id> --executor codex-cli --cwd "$(pwd)" --timeout-ms 1800000 --idle-timeout-ms 300000
bun run orbs -- run-next --run-id <run_id> --executor codex-cli --worktree-root ".ouroboros/worktrees" --limit 2
bun run orbs -- run-next --run-id <run_id> --executor codex-cli --worktree-root ".ouroboros/worktrees" --start-hook git-worktree
bun run orbs -- run-loop --run-id <run_id> --executor codex-cli --cwd "$(pwd)" --stop-hook create-tasks,create-verifier,create-repair,context-summary --max-rounds 8

# resumable Codex CLI execution
bun run orbs -- run-loop --run-id <run_id> --executor codex-resumable --cwd "$(pwd)" --sandbox workspace-write --timeout-ms 1800000 --idle-timeout-ms 300000 --stop-hook create-tasks,create-verifier,create-repair,context-summary --max-rounds 8
bun run orbs -- codex-start-attempt --task-id <task_id> --cwd "$(pwd)" --sandbox workspace-write --timeout-ms 1800000 --idle-timeout-ms 300000
bun run orbs -- list-running-attempts --run-id <run_id>
bun run orbs -- codex-resume-attempt --attempt-id <attempt_id> --cwd "$(pwd)" --sandbox workspace-write --timeout-ms 1800000 --idle-timeout-ms 300000

# observability
bun run orbs -- run-overview --run-id <run_id>
bun run orbs -- dashboard --run-id <run_id> --port 7331

# Linear bridge setup
cp ouroboros.example.toml ouroboros.toml
LINEAR_API_KEY=lin_api_... bun run orbs -- linear-check --run-id <run_id>
bun run orbs -- linear-link-issue --local-type run --local-id <run_id> --issue-key LIN-123
bun run orbs -- linear-link-issue --local-type task --local-id <task_id> --issue-id <linear_issue_id> --issue-url https://linear.app/<workspace>/issue/LIN-123/title

# manual attempt control
bun run orbs -- start-attempt --task-id <task_id> --input-json '{}'
bun run orbs -- finish-attempt --attempt-id <attempt_id> --output-json '{"status":"done","summary":"..."}'
bun run orbs -- record-attempt --task-id <task_id> --input-json '{}' --output-json '{"status":"done","summary":"..."}'
bun run orbs -- retry-task --task-id <task_id>

# lessons and editable prompt templates
bun run orbs -- list-lessons --run-id <run_id>
bun run orbs -- show-task-prompt --task-id <task_id>
bun run orbs -- show-prompt-template --key task
bun run orbs -- show-prompt-template --key context-summary
bun run orbs -- set-prompt-template --key task --content "# Custom template..."
```

`self-iterate` initializes the local harness database if needed, creates a run for `Use Ouroboros to plan its own next self-iteration cycle`, and adds one planner task seeded from `docs/self-iteration-plan.md`. It prints JSON with the created `runId`, planner `taskId`, plus the exact commands to run next:

```json
{
  "runId": "run_...",
  "taskId": "task_...",
  "dashboardCommand": "bun run orbs -- --db .ouroboros/ouroboros.db dashboard --run-id run_... --port 7331",
  "runnerCommand": "bun run orbs -- --db .ouroboros/ouroboros.db run-loop --run-id run_... --executor codex-resumable --cwd $(pwd) --sandbox workspace-write --stop-hook create-tasks,create-verifier,create-repair,context-summary --concurrency 3 --worktree-root .ouroboros/worktrees --start-hook git-worktree --max-rounds 8",
  "launchCommand": "bun run orbs -- --db .ouroboros/ouroboros.db self-iterate-launch --port 7331 --concurrency 3 --worktree-root .ouroboros/worktrees --start-hook git-worktree"
}
```

`self-iterate-launch` runs the same bootstrap, starts the dashboard, and starts the background runner/autopilot in one long-lived command. It defaults self-iteration to `--concurrency 3`, `--worktree-root .ouroboros/worktrees`, and `--start-hook git-worktree`, so independent planner-selected goals can run together in separate git worktrees. Pass `--start-hook none` for single-worktree tests or local debugging.

`run-next` leases ready tasks first, assigns each task a separate session name, then runs the selected executor for each leased task. Use `--concurrency <n>` to run multiple ready tasks in parallel; `--limit <n>` remains as the older alias. The `acpx-codex` executor creates or reuses an `acpx codex` named session per task. The `codex-cli` executor is a one-shot fallback for environments where the ACP adapter cannot create sessions.

`run-loop` repeats the same leasing and execution flow until there are no ready tasks, or until `--max-rounds` is reached.

For `codex-resumable`, an idle run does not blindly create another planner. When there are no `todo` or `running` tasks, `run-loop` creates a `goal-review` task that asks whether the original run goal is complete. A `goal-review` attempt must return `runDecision: "complete"`, `"continue"`, or `"verify"`. `complete` marks the run done and creates no tasks. `continue` or `verify` can include one to five `nextTasks` items, so the loop can keep planning multiple remaining goals instead of stopping after one small increment.

Use `--worktree-root` to assign each leased task a separate working directory path. The executor receives that path as its cwd.

Use `--start-hook git-worktree` with `--worktree-root` to create a real git worktree before the subagent runs. Use `--start-hook none` to disable start hooks explicitly.

Use `--timeout-ms` as a generous hard runtime cap. Use `--idle-timeout-ms` to stop commands only after they stop producing stdout or stderr. Long-running Codex work should use a large hard cap and rely on idle timeout for stuck-process detection.

`codex-start-attempt` starts a resumable Codex CLI task with `codex exec --json`. If the command window ends after Codex emits a session id, Ouroboros records a `running` attempt instead of marking the task blocked. `codex-resume-attempt` resumes that session with `codex exec resume <session_id>` and finishes the same attempt when structured JSON is returned.

`list-running-attempts` shows attempts that can be resumed. `start-attempt` and `finish-attempt` are lower-level commands for tools that want to manage running attempts themselves.

`run-overview` returns the run, tasks, observable sessions, and recent attempt events as JSON. `dashboard` starts a local web page that polls the same overview data so planner, worker, and verifier sessions can be watched side by side while they run.

## Project Workspaces

Project Workspace phase 1 is web-dashboard-first. A project is a local folder recorded in SQLite with `id`, `name`, `root_path`, and optional JSON context. Runs can bind to a project with `--project-id`, or create/reuse one from a folder with `--project-root`.

```bash
bun run orbs -- create-project --name "Ouroboros" --root-path "$(pwd)"
bun run orbs -- create-run --goal "Add a project-scoped feature" --project-root "$(pwd)"
bun run orbs -- run-overview --run-id <run_id>
```

`run-overview` includes `project` metadata, and the dashboard shows the project name and root path in the header. The dashboard also exposes local APIs for project-scoped file inspection:

```text
GET /api/runs/<run_id>/changed-files
GET /api/runs/<run_id>/diff?path=<tracked_path>
```

Changed files are currently derived from attempt `changedFiles` output and normalized into a flat list plus a tree-friendly payload. Diffs use `git diff -- <path>` under the project root, or a task worktree when no project root is present, and reject path traversal.

Native desktop shells such as Tauri or Electron are out of scope for this phase. The project model is intentionally small so a future desktop host can reuse the same database and dashboard APIs.

When the dashboard starts its background runner, it launches `autopilot` with the standard stop hooks by default:

```text
create-tasks,create-verifier,create-repair,context-summary
```

Pass `--stop-hook` to override that list. The dashboard also forwards `--start-hook` and `--worktree-root` to the background runner.

Runner stop hooks run after a subagent turn and before the attempt is recorded. Hooks can append checks/artifacts/problems and decide `exit`, `continue`, or `retry`, which prevents a subagent from repeating itself indefinitely.

Stop hooks are role-scoped by the CLI:

```text
planner  -> create-tasks
worker   -> create-verifier
verifier -> create-repair, context-summary
```

The `create-tasks` stop hook turns planner `nextTasks` output into real DB tasks.

Planner-created `nextTasks` may include an optional `modelPreference` object. Tasks also have `config_json`, so manual tasks can carry the same preference through `--config-json`. At execution time Ouroboros resolves the model from task preference, then role defaults in `run.context.modelDefaults.roles`, then `run.context.modelDefaults.global`, then the CLI `--model` fallback. The resolved model is recorded in attempt input and passed to Codex for both one-shot and resumable execution.

The `create-verifier` stop hook turns a successful worker attempt into a verifier task that depends on the worker. Multiple stop hooks can be enabled with a comma-separated list, for example `--stop-hook create-tasks,create-verifier`.

The `create-repair` stop hook turns a blocked verifier attempt into a ready worker repair task. A successful repair can then create another verifier through `create-verifier`.

The `context-summary` stop hook runs for verifier tasks. It rewrites verbose attempt summaries into compact reusable context and adds `context_experience_archive` and `context_lesson_archive` artifacts.

Every finished attempt also creates a run lesson. Successful attempts become `experience`; blocked attempts become `lesson`. Future prompts include compact lessons so the next loop can reuse working patterns and avoid known failures without growing prompts indefinitely. The task prompt currently includes the latest 12 lessons, with each summary compacted to 320 characters.

Prompt Markdown is stored in SQLite under `prompt_templates`. The default keys are `task`, `verifier-task`, `repair-task`, and `context-summary`, so the loop prompt, verifier prompt, repair prompt, and context-summary prompt can be edited without changing code.

## Linear Configuration

Linear integration uses local configuration plus a secret source. Do not commit real tokens.

1. Copy `ouroboros.example.toml` to `ouroboros.toml`.
2. Set `LINEAR_API_KEY`, or set `linear.token_file` to a local ignored file such as `.linear`.
3. Set `linear.project_url`, `linear.project_id`, and `linear.team_key`.
4. Run `bun run orbs -- linear-check --run-id <run_id>`.

`linear-check` verifies the token through Linear GraphQL, resolves the project and team, and records the run-to-project mapping in `external_refs`. It never prints the token.

`linear-link-issue` records a local run or task to Linear issue mapping in `external_refs` with `provider=linear` and `external_type=issue`. Pass exactly one local entity with `--local-type run|task` and `--local-id`, plus one issue identifier through `--issue-id`, `--issue-key`, or `--issue-url`. Repeating the same local entity and issue identifier reuses the existing ref and returns `created: false`.

Concrete examples:

```bash
bun run orbs -- linear-link-issue \
  --local-type run \
  --local-id run_123 \
  --issue-key PAN-42

bun run orbs -- linear-link-issue \
  --local-type task \
  --local-id task_456 \
  --issue-id issue_abc \
  --issue-url https://linear.app/pancat/issue/PAN-42/map-ouroboros-task
```

This is only a mapping skeleton. It validates that the local run or task exists and stores the supplied Linear issue id, key, or URL as the external id. It does not create Linear issues, listen for webhooks, consume Linear events, or automatically sync comments/status.

CLI flags override config values:

```bash
bun run orbs -- linear-check \
  --config ouroboros.toml \
  --run-id <run_id> \
  --project-url https://linear.app/<workspace>/project/<project-slug>/overview \
  --team-key <team-key>
```

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

The implemented Linear bridge skeleton handles:

- checking Linear API access and recording a run-to-project ref
- mapping external issues to local runs or tasks

Future bridge work may handle Linear issue events, Linear comments, PR status updates, and progress posts back to Linear. Webhook/event sync and issue creation are out of scope for the current implementation. When those events are added, they should enter through the harness inbox and the harness should decide what they mean.
