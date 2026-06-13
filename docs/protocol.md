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
4. builds the prompt from run context plus task fields
5. records an attempt
6. updates task status from the attempt result

The current v0 runner supports the same shape with an injectable executor. The `noop` executor is only for testing the loop. The `acpx-codex` executor creates or reuses a named acpx Codex session per task and returns the same structured output. The `codex-cli` executor can run one-shot Codex subagents when named ACP sessions are unavailable.

## Prompt Contract

Every generated prompt should contain:

- run goal
- run context
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

## Verification

A verifier is just another task with role `verifier`.

Verifier output may:

- mark the target task accepted
- mark the target task blocked
- create a repair task

The verifier should read database state and real artifacts. It should not trust agent summaries alone.

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

## Linear Bridge Rule

Linear events never mutate task state directly.

They enter through `inbox_events`. The harness consumes them and decides whether to:

- create a run
- create a task
- add context
- create a repair task
- ignore the event

Progress back to Linear is derived from accepted harness state.
