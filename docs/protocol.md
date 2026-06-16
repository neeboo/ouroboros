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

The CLI can seed the same `modelDefaults` object from TOML when creating runs. Missing config files are ignored. `--config <path>` is used when supplied; otherwise the CLI looks for `ouroboros.toml` and then `config.toml`.

```toml
[models]
model = "gpt-5-codex"

[models.roles.worker]
model = "gpt-5.4-mini"
provider = "openai"
profile = "fast"
base_url = "https://api.example.test/v1"
env_key = "OPENAI_API_KEY"

[models.roles.verifier]
model = "gpt-5.5"
```

`provider`, `profile`, `base_url`, and `env_key` are stored on the resolved model preference for future adapter work only. Current executors do not select providers, route base URLs, load env key values, or execute profiles from these fields.

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

Planner-created tasks may also persist a frozen verifier contract in task config:

```json
{
  "verifierContract": {
    "successCriteria": ["The worker evidence satisfies the scoped task goal."],
    "deterministicChecks": [],
    "agentReviewRubric": ["Check the worker output against the frozen task scope."]
  }
}
```

`verifierContract` is optional for backward compatibility. When present on planner output, the create-tasks hook stores it in `config_json`; the create-verifier hook reads it from task config, includes it in the verifier prompt, and cites it on the `created_verifier_task` artifact.

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

### ExecutionThread

An execution thread is the harness-owned record for a live or recently live agent process/session. It is intentionally agent-neutral: Codex, Claude Code, opencode, Reasonix, or another ACP-compatible agent may all write the same shape.

Required fields:

- `id`
- `run_id`
- `owner_type`
- `role`
- `status`

Optional but useful fields:

- `task_id`
- `attempt_id`
- `parent_thread_id`
- `owner_id`
- `pid`
- `session_name`
- `agent_session_id`
- `worktree_path`
- `heartbeat_at`
- `interrupted_at`
- `interrupt_reason`

`agent_session_id` is the external agent session identifier when the executor has one. For the current Codex resumable executor, this value is copied from the Codex session id. Future agent adapters should not add tool-specific columns unless the field is genuinely not portable.

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
bun run orbs -- linear-link-issue --local-type run --local-id <run_id> --issue-key LIN-123
bun run orbs -- linear-link-issue --local-type task --local-id <task_id> --issue-url https://linear.app/<workspace>/issue/LIN-123/title
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

The current v0 runner supports the same shape with an injectable executor. The `noop` executor is only for testing the loop. The `acpx-codex` executor creates or reuses a named acpx Codex session per task and returns the same structured output. The generic `acpx` backend path can select other ACP/acpx-backed agents through backend config. The `codex-cli` executor can run one-shot Codex subagents when named ACP sessions are unavailable.

Model resolution is protocol-level state, not only an executor flag. The resolver uses this precedence:

```text
task.config.modelPreference
then run.context.modelDefaults.roles[task.role]
then run.context.modelDefaults.global
then CLI --model
```

Explicit `--context-json` values win over config-seeded defaults: if `context.modelDefaults` is present, the CLI leaves it unchanged. The resolved model object is recorded in `attempts.input_json.model`, including `model`, `source`, `role`, and any inert metadata fields supplied in config. Run overview sessions expose the same stored object for dashboard visibility. `codex-cli` passes only the resolved `model` to `codex exec -m <model>`. `codex-resumable` passes only the resolved `model` on both `codex exec` start and `codex exec resume`, and resumed attempts reuse the model stored on the running attempt.

Agent backend resolution is also protocol-level state. A run can define named backends in `context_json.agentBackends`, choose defaults in `context_json.agentDefaults`, and a task can override with `config_json.agentBackend`:

```json
{
  "agentDefaults": {
    "global": "codex",
    "roles": {
      "worker": "opencode",
      "verifier": "claude-code"
    }
  },
  "agentBackends": {
    "opencode": { "kind": "acpx", "agent": "opencode" },
    "claude-code": { "kind": "acpx", "agent": "claude" },
    "hermes": { "kind": "acpx", "agentCommand": "hermes acp" },
    "codex-resumable": { "kind": "codex-resumable" }
  }
}
```

```json
{
  "agentBackend": "claude-code"
}
```

Backend selection precedence is:

```text
task.config.agentBackend
then run.context.agentDefaults.roles[task.role]
then run.context.agentDefaults.global
then CLI --agent-backend
then CLI --executor
```

Supported backend kinds are `acpx`, `codex-cli`, `codex-resumable`, and `noop`. For `acpx`, built-in agent ids are `codex`, `claude`, `opencode`, and `openclaw`; custom ACP servers use `agentCommand`. Agent event streams are supplemental evidence only. Attempt status, checks, artifacts, problems, and changed files still come from the final Orbs structured JSON plus Orbs stop hooks. See `docs/agent-backends.md` for the researched boundaries, including the warning that remote or Gateway agents must prove cwd/worktree behavior before write tasks.

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
- candidate guardrails when repeated lessons exist
- reusable experience evidence for successful attempts
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
      },
      "verifierContract": {
        "successCriteria": ["The implementation matches this task's done criteria."],
        "deterministicChecks": [],
        "agentReviewRubric": ["Review changed files and check evidence against the task prompt."]
      }
    }
  ]
}
```

`modelPreference` and `verifierContract` are optional. Planners that omit `modelPreference` remain compatible; the harness falls back to role defaults or the global executor model. Planners that omit `verifierContract` remain compatible; the harness creates verifier tasks without a frozen contract section.

### Fixed action methods

Agents and adapters should prefer fixed action methods over loose top-level fields when they want the harness to create follow-up work or change run flow. The runner exports small builders:

```ts
import {
  createRunsAction,
  createTasksAction,
  doneOutput,
  setRunDecisionAction,
} from "@ouroboros/runner";
```

These methods produce the `actions` wire format below. The parser validates each action payload and converts it into the existing internal fields before stop hooks run. This keeps old outputs compatible while giving new prompts a safer method-style contract.

Supported wire actions:

```json
{
  "actions": [
    {
      "type": "createTasks",
      "payload": {
        "tasks": [
          {
            "role": "worker",
            "goal": "Implement a small change",
            "prompt": "Concrete instructions",
            "dependsOn": [],
            "doneWhen": []
          }
        ]
      }
    },
    {
      "type": "createRuns",
      "payload": {
        "runs": [
          {
            "goal": "Child run goal",
            "prompt": "Planner prompt for the child run",
            "doneWhen": [],
            "context": {}
          }
        ]
      }
    },
    {
      "type": "setRunDecision",
      "payload": {
        "decision": "continue"
      }
    }
  ]
}
```

Action aliases are accepted for machine-generated payloads: `create_tasks`, `create_runs`, `set_run_decision`, and `run_decision`.

Invalid action payloads block the attempt during parsing, so missing arrays, unknown action types, invalid task fields, and conflicting run decisions fail early instead of creating unusable graph nodes.

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

Repeated blocked lessons may also be rendered as prompt-only candidate guardrails in the task prompt, while successful experiences may be rendered as reusable experience evidence. That rendering is guidance only unless a later planner or amendment slice turns the pattern into a durable active guardrail, preflight check, or schema-backed rule.

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
- decide whether the scheduler may exit, must continue, or should retry

Hook decisions:

```text
exit      record the attempt and keep the resulting task status
retry     record a blocked attempt, then move the task back to todo
continue  record the attempt and guarantee scheduler re-entry for newly created or confirmed follow-up work
```

`continue` is a protocol guarantee, not a display hint. A stop hook that creates a ready task, verifier, repair task, or non-complete goal-review follow-up must return `continue`. The runner must surface that decision in its round result and must not treat that hook boundary as idle. If a hard budget prevents immediate execution, the run remains unfinished and the control surface must keep or restart the runner until the ready work is consumed.

The harness also needs a supervisor layer above individual runner processes. The supervisor is responsible for noticing orphaned ready work, resumable attempts without owners, stale runner exits, human-paused runs, and leased tasks that are marked `running` without a running attempt. Stop-hook guarantees tell the supervisor what must continue; supervisor state tells the system whether something is actually continuing.

A task lease is not complete until an attempt exists. If a runner exits after leasing a task but before recording or starting an attempt, the next runner loop must reclaim that task back to `todo`. This keeps the queue drainable even when a start hook, process, or host session exits in the middle of the handoff.

## Harness Actions

Some repairs are system-level database actions, not ordinary worker edits. A worker in an isolated worktree must not write the root harness database directly. Instead it should request a fixed `HarnessAction` from a DB-writable harness process.

The direct tool is:

```text
orbs action --action-json '{"type":"prepareRunDrain","runId":"run_..."}'
```

The proxy tool is:

```text
orbs action-server --host 127.0.0.1 --port 7332
orbs action-request --url http://127.0.0.1:7332 --action-json '{"type":"prepareRunDrain","runId":"run_..."}'
```

`action-server` may be protected with `--token` or `ORBS_ACTION_TOKEN`; `action-request` sends the same token. The server is intended to run from the main project process, while subagents in worktrees only call `action-request`.

Supported actions:

```json
{ "type": "reclaimRunningTasks", "runId": "run_..." }
{ "type": "retryTask", "taskId": "task_...", "reason": "optional" }
{ "type": "markRunTodo", "runId": "run_...", "reason": "optional" }
{ "type": "prepareRunDrain", "runId": "run_...", "maxTries": 3, "reason": "optional" }
{ "type": "completeSystemTask", "taskId": "task_...", "actionEventId": "action_...", "reason": "optional" }
```

`prepareRunDrain` reclaims orphaned task leases, marks the run `todo`, and creates or retries a bounded `goal-review` task when the queue is otherwise empty. It does not mark a run complete and does not weaken the verifier contract.

`completeSystemTask` records a task attempt from an existing `harness_action_events` row. It derives the attempt status, summary, checks, artifacts, and problems from the audited action result, so a system task can be closed without giving a worktree broad database write access or arbitrary attempt-writing power.

Every action writes a `harness_action_events` audit row with the validated request, result, checks, artifacts, and problems. Verifiers should cite these rows when checking whether a system-level repair actually happened.

Commit hooks should be explicit and opt-in. The default stop hook behavior should inspect and summarize, not create commits.

The `create-tasks` stop hook reads `nextTasks` from the subagent output and inserts those tasks into the harness database. If a planned task omits `dependsOn`, the hook makes it depend on the planner task that produced it. When it creates tasks, it returns `continue`.

Goal review is also a stop-hook path. A `goal-review` output with `runDecision: "complete"` marks the run done. A `continue` or `verify` decision can carry one to five `nextTasks`; `create-tasks` then inserts those follow-up tasks so a run can keep working through multiple remaining goals. If a goal-review attempt omits the structured field but writes an exact `runDecision complete`, `runDecision continue`, or `runDecision verify` phrase in summary, checks, artifacts, or problems, the hook may patch that field before recording the attempt. The drain controller also uses the same recovery for older blocked goal-review attempts so a run cannot remain forever `todo` only because a clear decision was written in the wrong field. Independent ready tasks can run together when the runner is started with `--concurrency <n>`; `--limit <n>` is retained as an alias.

The `create-verifier` stop hook reads a successful worker output and inserts a verifier task with `dependsOn` set to the worker task. It returns `continue` when it creates that verifier. It does not create verifier tasks for verifier attempts, which gives the loop a natural exit.

The `create-repair` stop hook reads a blocked verifier output and inserts a worker repair task. It returns `continue` when it creates that repair. A successful repair task may then create another verifier through `create-verifier`.

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
