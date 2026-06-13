# Ouroboros Minimal Protocol

This protocol keeps the loop small enough to implement and strict enough to verify.

## Entities

### Run

A run is one user or external goal.

Required fields:

- `id`
- `goal`
- `status`
- `context_json`

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

Optional but useful fields:

- `parent_id`
- `worktree_path`
- `session_ref`
- `context_version`

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
6. records an attempt
7. updates task status from the attempt result

The current v0 runner supports the same shape with an injectable executor. The `noop` executor is only for testing the loop. The `acpx-codex` executor creates or reuses a named acpx Codex session per task and returns the same structured output. The `codex-cli` executor can run one-shot Codex subagents when named ACP sessions are unavailable.

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
      "doneWhen": []
    }
  ]
}
```

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

If the start hook fails, the runner records a blocked attempt and skips the executor.

## Linear Bridge Rule

Linear events never mutate task state directly.

They enter through `inbox_events`. The harness consumes them and decides whether to:

- create a run
- create a task
- add context
- create a repair task
- ignore the event

Progress back to Linear is derived from accepted harness state.
