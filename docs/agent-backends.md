# Agent Backends

Ouroboros now treats **Codex** and **Claude Code** as the only supported agent backends.

Hermes support is deprecated and removed from the default smoke matrix, doctor path, docs, and backend-specific runtime handling. OpenCode, OpenClaw, Reasonix, and other ACP servers are not supported backends for Orbs. The generic `agentCommand` escape hatch remains for local experiments, but using it means the operator owns the smoke test, cwd safety, auth setup, output contract, and failure recovery.

Every backend must still finish an attempt by returning the final Orbs JSON:

```json
{
  "status": "done",
  "summary": "What changed",
  "changedFiles": [],
  "checks": [],
  "artifacts": [],
  "problems": [],
  "nextTasks": []
}
```

ACP/acpx events, tool calls, diffs, and stream chunks are observability only. They do not replace `changedFiles`, `checks`, `artifacts`, or `problems`.

## Supported Backends

| Backend | Kind | Use |
| --- | --- | --- |
| `codex-resumable` | `codex-resumable` | Default for every self-iteration role and durable Codex work. Records native Codex session ids. |
| `codex` / `acpx-codex` | `acpx` | Codex through acpx named sessions. Useful for ACP smoke and subsessions. |
| `codex-cli` | `codex-cli` | One-shot Codex CLI compatibility path. |
| `claude-code` | `acpx` agent `claude` | Explicitly routed Claude Code tasks; not the self-iteration default. |
| `noop` | `noop` | Tests and dry plumbing. |

Built-in acpx agent ids are limited to `codex` and `claude`. `claude-code` is the Orbs alias for acpx `claude`.

## Configuration

Backend selection lives in `run.context` and `task.config`.

```json
{
  "agentDefaults": {
    "global": "codex-resumable",
    "roles": {
      "designer": "codex-resumable",
      "planner": "codex-resumable",
      "worker": "codex-resumable",
      "verifier": "codex-resumable",
      "outcome-review": "codex-resumable",
      "goal-review": "codex-resumable"
    }
  },
  "agentBackends": {
    "codex-resumable": { "kind": "codex-resumable" },
    "codex": { "kind": "acpx", "agent": "codex" },
    "claude-code": { "kind": "acpx", "agent": "claude", "approval": "approve-all" },
    "noop": { "kind": "noop" }
  }
}
```

Task-level override:

```json
{
  "agentBackend": "claude-code",
  "modelPreference": {
    "model": "sonnet",
    "reason": "use Claude Code for this specific worker task"
  }
}
```

Resolution order:

```text
task.config.agentBackend
then run.context.agentDefaults.roles[task.role]
then run.context.agentDefaults.global
then CLI --agent-backend
then CLI --executor
```

Supported backend kinds are:

- `acpx`
- `codex-cli`
- `codex-resumable`
- `noop`

For `acpx`, `agent` is the semantic agent/provider identity (`codex` or `claude`), while `agentCommand` is only the transport used to start an adapter. The fields may be declared together: routing and model inheritance use `agent`, and execution prefers `agentCommand`. When `agent` is omitted, the reserved backend ids `claude-code`, `claude`, `codex`, and `acpx-codex` supply their built-in semantic identity even if the definition replaces the built-in transport with `agentCommand`. Other raw backends are never classified from command text; a custom raw Claude backend must declare `agent: "claude"` explicitly. `agentCommand` remains an experimental path outside the supported production matrix.

## Model Defaults

Run model defaults can be seeded from TOML at run creation time. `--config <path>` wins when supplied; otherwise the CLI checks `ouroboros.toml` and then `config.toml`.

```toml
[models]
model = "gpt-5.6-luna"
reasoning_effort = "high"

[models.roles.worker]
model = "gpt-5.6-luna"
reasoning_effort = "high"
provider = "openai"
profile = "fast"
base_url = "https://api.example.test/v1"
env_key = "OPENAI_API_KEY"

[models.roles.verifier]
model = "gpt-5.6-sol"
reasoning_effort = "high"
```

Model resolution order:

```text
task.config.modelPreference
then run.context.modelDefaults.roles[task.role]
then run.context.modelDefaults.global
then CLI --model
```

Resolved attempts record `attempt.input.model` with `model`, `reasoning_effort`, `source`, `role`, and any supplied `provider`, `profile`, `base_url`, or `env_key` strings. Direct Codex executors pass `model` and `reasoning_effort`; the remaining adapter fields stay as metadata.

Claude Code is isolated from inherited Codex model defaults. When a route resolves to semantic `agent: "claude"`—including `claude-code` backed by a raw `agentCommand`—Orbs drops model preferences from role defaults, run defaults, and CLI `--model`. Only a task-level `config.modelPreference` is treated as an explicit Claude model override. For backward compatibility, a task override may omit `provider`; when present, it must be `anthropic` or `claude`, otherwise the route drops the incompatible model. Raw backends without a semantic `agent` keep their existing model routing and are not inferred from executable paths or filenames.

## Doctor And Smoke

Agent readiness checks should start with a doctor:

```bash
orbs doctor-agent --agent codex
orbs doctor-agent --agent claude-code
```

Run the read-only smoke before routing real work:

```bash
bun run scripts/acpx-agent-smoke.ts codex
bun run scripts/acpx-agent-smoke.ts claude-code
```

Claude Code support is gated on read-only smoke evidence. The smoke checks for local `acpx` and `claude`, verifies that `@agentclientprotocol/claude-agent-acp@^0.36.1` is available from local npm state with `npm exec --offline`, creates a temporary cwd, runs acpx with read-only approval, and accepts only final Orbs JSON with passed `cwd`, `read-only prompt`, and `final Orbs JSON` checks.

A passed smoke proves only read-only ACP execution in the temporary cwd. Write workloads require a separate isolated worktree run that proves file edits, command execution, diff reporting, cancellation, and final Orbs JSON.

## Recommended Role Routing

Self-iteration runs keep `designer`, `planner`, `worker`, `verifier`, `outcome-review`, and `goal-review` on `codex-resumable` by default. Claude Code is supported only for a task with an explicit `config.agentBackend = "claude-code"`.

Recovery is finite and Codex-first: Claude Code executor failures return to Codex, while Codex executor failures continue as bounded Codex repair tasks. The recovery record preserves the source worktree and task contract and includes `fromBackend`, `toBackend`, `sourceAttemptId`, `terminalReason`, and `generation`. It never means automatic backend rotation or unlimited retry.

For the shortest operational recipe, start with `docs/default-runbook.md`.

```toml
[agentDefaults]
global = "codex-resumable"

[agentDefaults.roles]
designer = "codex-resumable"
planner = "codex-resumable"
worker = "codex-resumable"
verifier = "codex-resumable"
"outcome-review" = "codex-resumable"
"goal-review" = "codex-resumable"

["agentBackends"."claude-code"]
kind = "acpx"
agent = "claude"
approval = "approve-all"

["agentBackends"."codex-resumable"]
kind = "codex-resumable"
```

## Harness-Managed Subsessions

Subsessions are harness-owned child sessions. A task may request a fixed `HarnessAction` payload, but only the harness validates the parent task, resolves the parent worktree as `cwd`, checks the backend, records `execution_threads`, and starts acpx.

Supported built-in subsession backends:

```json
{
  "agentBackends": {
    "claude-code": { "kind": "acpx", "agent": "claude", "approval": "approve-reads" },
    "codex": { "kind": "acpx", "agent": "codex" },
    "codex-resumable": { "kind": "codex-resumable" },
    "noop": { "kind": "noop" }
  }
}
```

A subsession backend must be declared in `run.context.agentBackends` or be one of the built-in aliases: `claude-code`, `codex`, `codex-resumable`, `codex-cli`, `acpx-codex`, `noop`.

The first safe subsession scope is read/propose. Promote a backend to write access only after a smoke proves it can read, write, run commands, and emit final Orbs JSON from the intended worktree.

## Deprecated Backends

Hermes support is deprecated. Orbs no longer:

- includes Hermes in `scripts/acpx-agent-smoke.ts`;
- exposes a Hermes-specific doctor;
- prepares `HERMES_HOME`;
- documents Hermes routing examples;
- carries Hermes-specific stop or setup guidance.

Use Codex or Claude Code. If an operator still experiments with a local Hermes ACP command through `agentCommand`, that is outside supported Orbs behavior and should be treated as a custom adapter experiment.
