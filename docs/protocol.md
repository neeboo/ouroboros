# Ouroboros Minimal Protocol

This protocol keeps the loop small enough to implement and strict enough to verify.

## Entities

### Project

A project is one local workspace folder. Phase 1 keeps it DB-backed and web-dashboard-first so a future desktop host can reuse the same data/API layer.

Required fields:

- `id`
- `name`
- `root_path`
- `context_json`

Native desktop shells, multi-repo sync, and remote deployment are out of scope for this phase.

### Run

A run is one user or external goal.

Required fields:

- `id`
- `project_id` (nullable)
- `goal`
- `status`
- `context_json`

`context_json` may include model defaults for tasks:

```json
{
  "modelDefaults": {
    "global": { "model": "gpt-5-codex" },
    "roles": {
      "worker": { "model": "gpt-5-mini", "reason": "cheaper implementation passes" },
      "verifier": { "model": "gpt-5-mini" }
    }
  }
}
```

### Task

A task is one schedulable node in a run.

Required fields:

- `id`
- `run_id`
- `status`
- `role`
- `goal`
- `prompt`
- `depends_on_json`
- `done_when_json`
- `config_json`

Optional but useful fields:

- `parent_id`
- `worktree_path`
- `session_ref`
- `context_version`

`config_json` is a small extensibility object. The first supported protocol field is:

```json
{
  "modelPreference": {
    "model": "gpt-5-mini",
    "reason": "low-risk follow-up"
  }
}
```

### Attempt

An attempt is one execution of one task by one agent session.

Required fields:

- `id`
- `task_id`
- `status`
- `input_json`
- `output_json`

Optional but useful fields:

- `checks_json`
- `artifacts_json`
- `error`

### ExternalRef

An external ref maps a local run or task to an outside collaboration object.

Required fields:

- `id`
- `local_type`
- `local_id`
- `provider`
- `external_type`
- `external_id`

For Linear issue skeletons, `provider` is `linear`, `external_type` is `issue`, and `external_id` is the Linear issue id, key, or URL supplied by the caller. `external_url` is set only when `--issue-url` is supplied. Repeating the same local entity and issue identifier should reuse the existing ref.

The implemented CLI command is:

```bash
bun run cli -- linear-link-issue --local-type run --local-id <run_id> --issue-key LIN-123
bun run cli -- linear-link-issue --local-type task --local-id <task_id> --issue-url https://linear.app/<workspace>/issue/LIN-123/title
```

Only `run` and `task` are valid local types for this command. The command validates that the local entity exists, accepts one identifier from `--issue-id`, `--issue-key`, or `--issue-url`, and stores the mapping in `external_refs`. It does not fetch, create, or update the Linear issue.

## Status Values

Keep statuses deliberately small:

```text
todo
running
done
blocked
```

Meaning:

- `todo`: ready or waiting for dependencies
- `running`: leased by a session
- `done`: accepted by the harness or verifier
- `blocked`: cannot continue without repair or human input

## Scheduler Rule

A task is runnable when:

```text
task.status = "todo"
and every task in depends_on_json has status = "done"
```

The scheduler then:

1. assigns a worktree if needed
2. leases one or more ready tasks
3. assigns or resumes one session per leased task
4. optionally assigns one worktree path per leased task
5. builds the prompt from run context plus task fields
6. resolves the execution model
7. records an attempt
8. updates task status from the attempt result

The current v0 runner supports the same shape with an injectable executor. The `noop` executor is only for testing the loop. The `acpx-codex` executor creates or reuses a named acpx Codex session per task and returns the same structured output. The `codex-cli` executor can run one-shot Codex subagents when named ACP sessions are unavailable.

Model resolution is protocol-level state, not only an executor flag. The resolver uses this precedence:

```text
task.config.modelPreference
then run.context.modelDefaults.roles[task.role]
then run.context.modelDefaults.global
then CLI --model
```

The resolved model object is recorded in `attempts.input_json.model`. `codex-cli` passes it to `codex exec -m <model>`. `codex-resumable` passes it on both `codex exec` start and `codex exec resume`, and resumed attempts reuse the model stored on the running attempt.

Runs may be bound to a project by `project_id`, or by a project root path that creates/reuses a matching `projects.root_path` row. Old databases keep `runs.project_id` nullable, and existing `context_json` remains compatible.

The CLI also exposes `self-iterate-launch` as a first-class opt-in workflow. It creates the self-iteration run, seeds the planner task, starts the dashboard, and starts the runner/autopilot together without requiring the user to chain the follow-up commands manually. Self-iteration launch defaults to `--concurrency 3`, `--worktree-root .ouroboros/worktrees`, and `--start-hook git-worktree`, so independent planner-selected goals can run together in separate git worktrees unless the user overrides concurrency or passes `--start-hook none`.

## Prompt Contract

Prompt Markdown lives in `prompt_templates`, not only in code. The built-in template keys are:

```text
task
verifier-task
repair-task
```

Every generated prompt should contain:

- run goal
- run context
- run lessons
- task goal
- task role
- dependencies and their latest results
- allowed working directory
- required output shape
- done criteria

The agent must return structured output matching:

```json
{
  "status": "done",
  "summary": "What changed",
  "changed_files": [],
  "checks": [],
  "artifacts": [],
  "problems": [],
  "nextTasks": [
    {
      "role": "worker",
      "goal": "Implement the next small capability",
      "prompt": "Concrete instructions for the next subagent",
      "dependsOn": [],
      "doneWhen": [],
      "modelPreference": {
        "model": "gpt-5-mini",
        "reason": "cheap task"
      }
    }
  ]
}
```

`modelPreference` is optional. Planners that omit it remain compatible; the harness falls back to role defaults or the global executor model.

Allowed `status` values in output:

```text
done
blocked
```

## Lessons

Every recorded attempt creates one run-level lesson:

- `experience`: created from a successful attempt
- `lesson`: created from a blocked attempt

The next prompt for the same run includes recent lessons in `## Run Lessons`. Successful lessons should preserve useful execution patterns. Failure lessons should preserve avoidable problems and their evidence.

Templates can decide how strongly lessons influence the next graph design. The default task template exposes lessons as JSON so planners can turn them into constraints, avoid repeated failure modes, and reuse successful patterns.

## Verification

A verifier is just another task with role `verifier`.

Verifier output may:

- mark the target task accepted
- mark the target task blocked
- create a repair task

The verifier should read database state and real artifacts. It should not trust agent summaries alone.

The built-in `create-verifier` stop hook creates verifier tasks only for successful worker attempts by default. The verifier depends on the worker task, so it becomes ready only after the worker attempt is recorded.

The built-in `create-repair` stop hook creates worker repair tasks for blocked verifier attempts. Repair tasks use the failed verifier as `parentId` instead of `dependsOn`, because blocked tasks do not unlock dependencies.

## Stop Hooks

After an executor returns and before an attempt is recorded, the runner may apply stop hooks.

Stop hooks are for turn-end control:

- append checks
- append artifacts
- append problems
- decide whether the task should exit or retry

Hook decisions:

```text
exit      record the attempt and keep the resulting task status
retry     record a blocked attempt, then move the task back to todo
continue  append information without forcing retry
```

Commit hooks should be explicit and opt-in. The default stop hook behavior should inspect and summarize, not create commits.

The `create-tasks` stop hook reads `nextTasks` from the subagent output and inserts those tasks into the harness database. If a planned task omits `dependsOn`, the hook makes it depend on the planner task that produced it.

Goal review is also a stop-hook path. A `goal-review` output with `runDecision: "complete"` marks the run done. A `continue` or `verify` decision can carry one to five `nextTasks`; `create-tasks` then inserts those follow-up tasks so a run can keep working through multiple remaining goals. Independent ready tasks can run together when the runner is started with `--concurrency <n>`; `--limit <n>` is retained as an alias.

The `create-verifier` stop hook reads a successful worker output and inserts a verifier task with `dependsOn` set to the worker task. It does not create verifier tasks for verifier attempts, which gives the loop a natural exit.

The `create-repair` stop hook reads a blocked verifier output and inserts a worker repair task. A successful repair task may then create another verifier through `create-verifier`.

Multiple stop hooks may be applied in order. The CLI accepts a comma-separated list such as:

```text
--stop-hook create-tasks,create-verifier,create-repair
```

## Start Hooks

Start hooks run after a task is leased and before the executor starts.

The first built-in start hook is `git-worktree`, which creates a branch and git worktree for the task:

```text
git worktree add <task_worktree_path> -b ouroboros/<task_id> <base_ref>
```

It then prepares Bun workspace links inside the task worktree:

```text
bun install --cwd <task_worktree_path> --frozen-lockfile
```

If the start hook fails, the runner records a blocked attempt and skips the executor.

## Linear Bridge Rule

The current Linear bridge implementation is an anchor-mapping skeleton. It can record:

- run to Linear project refs from `linear-check`
- run or task to Linear issue refs from `linear-link-issue`

These mappings live in `external_refs` and give future sync code stable local-to-external anchors. They are not inbox events and they do not change task status, create issues, create comments, or post progress.

Webhook and event sync are still out of scope. When implemented, Linear events must never mutate task state directly.

They enter through `inbox_events`. The harness consumes them and decides whether to:

- create a run
- create a task
- add context
- create a repair task
- ignore the event

Progress back to Linear is derived from accepted harness state.

## Dashboard File APIs

The web dashboard exposes project-scoped changed-file state without introducing a desktop shell:

```text
GET /api/runs/<run_id>/changed-files
GET /api/runs/<run_id>/diff?path=<tracked_path>
```

`changed-files` derives its payload from attempt output `changedFiles` for the current run. It returns normalized flat entries and a tree-friendly directory structure.

`diff` accepts only a tracked relative path, rejects path traversal, and shells out to:

```text
git diff -- <tracked_path>
```

The command runs under `project.root_path` when the run is project-bound, otherwise under a task worktree when available. Successful text responses use `text/plain`; errors can be returned as JSON with `format=json`.
