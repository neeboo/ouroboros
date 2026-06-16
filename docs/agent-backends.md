# Multi-Agent Backends

Ouroboros can select the coding-agent backend for a task without changing the task prompt contract. The backend runs the turn, but the attempt is still accepted only from the final Orbs structured JSON:

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

ACP/acpx events, tool calls, diffs, and stream chunks are supplemental observability. They do not replace `changedFiles`, `checks`, `artifacts`, or `problems` in the final structured output. Stop hooks may add checks or artifacts after the agent turn, but Orbs should not infer task success from ACP event streams alone.

## Configuration Schema

Backend selection lives in `run.context` and `task.config`.

Run model defaults can be seeded from TOML at run creation time. `--config <path>` wins when supplied; otherwise the CLI checks `ouroboros.toml` and then `config.toml`. The TOML is converted into `run.context.modelDefaults` only when the caller did not already provide `modelDefaults` in `--context-json`.

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

Model resolution order is unchanged:

```text
task.config.modelPreference
then run.context.modelDefaults.roles[task.role]
then run.context.modelDefaults.global
then CLI --model
```

Resolved attempts record `attempt.input.model` with `model`, `source`, `role`, and any supplied `provider`, `profile`, `base_url`, or `env_key` strings. Those extra fields are inert metadata in this slice: Orbs does not use them to select a third-party provider, route base URLs, read env var values, or execute profiles. Current Codex executors pass only the resolved `model` string.

```json
{
  "agentDefaults": {
    "global": "codex",
    "roles": {
      "planner": "codex",
      "worker": "opencode",
      "verifier": "claude-code"
    }
  },
  "agentBackends": {
    "claude-code": {
      "kind": "acpx",
      "agent": "claude",
      "approval": "approve-reads"
    },
    "opencode": {
      "kind": "acpx",
      "agent": "opencode",
      "approval": "approve-reads"
    },
    "reasonix": {
      "kind": "acpx",
      "agentCommand": "reasonix acp",
      "approval": "approve-reads"
    },
    "hermes": {
      "kind": "acpx",
      "agentCommand": "hermes acp",
      "approval": "approve-reads"
    },
    "openclaw-main": {
      "kind": "acpx",
      "agent": "openclaw",
      "approval": "approve-reads"
    },
    "codex-resumable": {
      "kind": "codex-resumable"
    },
    "codex-cli": {
      "kind": "codex-cli"
    },
    "noop": {
      "kind": "noop"
    }
  }
}
```

Task-level override:

```json
{
  "agentBackend": "reasonix",
  "modelPreference": {
    "model": "reasonix-default",
    "reason": "agent-specific smoke test"
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

Supported backend kinds:

- `acpx`: run a stateful ACP-compatible agent through acpx. Use `agent` for built-in acpx targets and `agentCommand` for a custom ACP server command.
- `codex-cli`: run the existing one-shot Codex CLI executor.
- `codex-resumable`: run the existing resumable Codex CLI path.
- `noop`: test executor.

Known built-in acpx agent ids in Orbs are `codex`, `claude`, `opencode`, and `openclaw`; `claude-code` is accepted as an alias for acpx `claude`. Other ACP agents can be configured through `agentCommand` if a local smoke test proves that the command starts an ACP server and honors cwd, auth, permissions, and final JSON output.

Copy-pasteable `run.context`:

```json
{
  "modelDefaults": {
    "global": { "model": "gpt-5-codex" },
    "roles": {
      "worker": { "model": "gpt-5-mini" },
      "verifier": { "model": "gpt-5-mini" }
    }
  },
  "agentDefaults": {
    "global": "codex",
    "roles": {
      "planner": "codex",
      "worker": "opencode",
      "verifier": "claude-code"
    }
  },
  "agentBackends": {
    "codex": { "kind": "acpx", "agent": "codex" },
    "opencode": { "kind": "acpx", "agent": "opencode" },
    "claude-code": { "kind": "acpx", "agent": "claude" },
    "reasonix": { "kind": "acpx", "agentCommand": "reasonix acp" },
    "hermes": { "kind": "acpx", "agentCommand": "hermes acp" },
    "openclaw-main": { "kind": "acpx", "agent": "openclaw" }
  }
}
```

Copy-pasteable `task.config`:

```json
{
  "agentBackend": "claude-code",
  "modelPreference": {
    "model": "sonnet",
    "reason": "use Claude Code for this specific worker task"
  }
}
```

## Hermes Doctor

Hermes support starts with a read-only doctor, not worker routing:

```bash
bun run scripts/acpx-agent-smoke.ts hermes --doctor
```

The doctor reports the normalized child `PATH`, `acpx` discovery, `hermes` discovery, `hermes-acp` discovery, and the selected raw acpx `agentCommand`. It prefers `hermes acp`; it selects `hermes-acp` only when command discovery proves `hermes-acp` is available and `hermes` is not. A skipped result means Hermes is not proven on that machine. The doctor does not start an ACP session, does not run a write probe, and does not enable a worker default.

Keep Hermes config role-scoped and explicit until a separate smoke proves cwd/worktree behavior:

```json
{
  "agentDefaults": {
    "roles": {
      "verifier": "hermes"
    }
  },
  "agentBackends": {
    "hermes": {
      "kind": "acpx",
      "agentCommand": "hermes acp",
      "approval": "approve-reads"
    }
  }
}
```

If the doctor selects `hermes-acp`, mirror that exact command in `agentCommand`. Do not route worker write tasks to `hermes` by default until a separate smoke proves cwd/worktree reads, writes, command execution, diff reporting, and final Orbs JSON from the intended task worktree.

## Claude Code Smoke

Claude Code support is gated on read-only smoke evidence. The first supported smoke path is a one-shot ACP session through acpx:

```bash
bun run scripts/acpx-agent-smoke.ts claude-code
```

The script checks for local `acpx` and `claude` commands, then verifies that `@agentclientprotocol/claude-agent-acp@^0.36.1` can start from local npm state with `npm exec --offline`. This keeps the smoke from silently depending on a registry fetch. If those preflight checks pass, it creates a temporary cwd, runs `acpx --cwd <tmp> --auth-policy fail --approve-reads --non-interactive-permissions fail --format text claude exec`, and accepts only final Orbs JSON with passed `cwd`, `read-only prompt`, and `final Orbs JSON` checks. A skipped result means the backend is not proven on that machine. A passed result proves only read-only ACP execution in the temporary cwd; it does not enable write workloads.

Future doctor scope: add a backend doctor that reports normalized child PATH entries, required command locations, auth status, and cwd/worktree capability before any write-task backend is enabled.

Keep Claude Code backend config minimal and role-scoped until stronger evidence exists:

```json
{
  "agentDefaults": {
    "roles": {
      "verifier": "claude-code"
    }
  },
  "agentBackends": {
    "claude-code": {
      "kind": "acpx",
      "agent": "claude",
      "approval": "approve-reads"
    }
  }
}
```

Do not route worker write tasks to `claude-code` by default until a separate smoke proves cwd/worktree reads, writes, command execution, diff reporting, and final Orbs JSON from the intended task worktree.

CLI example:

```bash
bun run orbs -- create-run \
  --goal "Try multi-agent execution" \
  --context-json '{"agentDefaults":{"roles":{"worker":"opencode"}},"agentBackends":{"opencode":{"kind":"acpx","agent":"opencode"}}}'

bun run orbs -- create-task \
  --run-id <run_id> \
  --role worker \
  --goal "Run one task through Claude Code" \
  --prompt "Inspect the repo and return the required Orbs JSON." \
  --config-json '{"agentBackend":"claude-code"}'

bun run orbs -- run-next \
  --run-id <run_id> \
  --executor codex-cli \
  --cwd "$(pwd)" \
  --approval approve-reads
```

## Adapter Behavior

The acpx adapter should:

- create or reuse one named acpx session per Orbs task session;
- pass the assigned task cwd, including worktree cwd, through `--cwd`;
- pass the resolved Orbs model as acpx `--model` when the target supports it;
- pass the selected approval mode as an acpx permission flag;
- submit the generated Orbs task prompt on stdin;
- parse only the agent's final text output as Orbs structured JSON;
- block the attempt when session creation, command execution, or JSON parsing fails;
- record the resolved backend id, kind, source, cwd, and model in attempt input.

Session resume has two paths. The generic acpx executor relies on acpx named sessions and queue ownership for follow-up turns. The dedicated `codex-resumable` path is still separate because it records and resumes native Codex CLI session ids.

Stop and interrupt behavior is not uniform across agents. Orbs can stop a local runner process and mark the attempt blocked. acpx also exposes cooperative cancellation for ACP sessions, but each backend must be smoke-tested before Orbs treats cancel as durable cleanup.

Remote or Gateway-backed agents require cwd and worktree verification before normal use. The Orbs task may be assigned `/repo/.ouroboros/worktrees/task_...`, but a remote ACP server's file tools may run on another host. Do not enable remote Hermes, OpenClaw Gateway, or similar targets for write tasks until a smoke test proves the agent reads, writes, runs commands, and reports diffs in the intended worktree.

## Capability Boundaries

| Agent | Session Support | Streaming | Cwd / Worktree | Auth | Model Selection | Permissions | JSON Output | Resume | Stop / Interrupt | Artifacts / Checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `codex` | Supported through acpx named sessions; native `codex-resumable` also records Codex session ids. | acpx exposes structured ACP messages; Orbs currently parses final text only. | acpx receives `--cwd`; `codex-cli` and `codex-resumable` run in the assigned cwd. Verify worktree writes in smoke tests. | Uses local Codex CLI auth. | Orbs can pass resolved model through acpx `--model` or Codex CLI `-m`. | acpx approval flag or Codex sandbox flag, depending on executor. | Must return final Orbs JSON; ACP events are supplemental. | acpx named sessions or native Codex session id path. | acpx cancel exists, native dashboard stop marks blocked; durable cleanup should be verified. | From final Orbs JSON plus Orbs stop hooks; Codex session id may be recorded as an artifact. |
| `claude-code` | Feasible through acpx `claude`; OpenClaw docs describe ACP Claude as session-backed with resume controls. | ACP/acpx can surface structured messages, tool activity, and diffs; Orbs final parser remains text JSON. | acpx receives `--cwd`; smoke-test Claude Code against task worktrees before write tasks. | Requires local Claude Code auth. | Orbs may pass `--model`; confirm target adapter accepts the requested value. | acpx approval flag. Claude's own runtime permissions may also apply. | Must be prompted to return Orbs JSON. | acpx session resume only; no Orbs-native Claude resume id yet. | Treat stop as best-effort until cancellation has been tested for the adapter. | From final Orbs JSON and stop hooks only. |
| `opencode` | Feasible through acpx `opencode`; OpenCode documents an ACP subprocess command. | ACP streaming is available at protocol level; Orbs does not yet promote stream chunks to evidence. | acpx receives `--cwd`; verify OpenCode's file and terminal tools operate in the Orbs worktree. | Uses OpenCode local provider/auth config. | Orbs may pass `--model`; support depends on OpenCode/acpx adapter behavior. | acpx approval flag plus OpenCode's own permission flow, if any. | Must return final Orbs JSON. | acpx named sessions. | Best-effort local process stop/cancel until tested. | From final Orbs JSON and stop hooks only. |
| `openclaw` | Feasible through acpx `openclaw` when OpenClaw exposes an ACP bridge or Gateway session. | ACP streams tool activity and chat through the bridge; Orbs treats it as observability. | High risk for remote/Gateway sessions. Verify the Gateway session's actual filesystem matches the Orbs cwd before writes. | Requires OpenClaw Gateway or local OpenClaw auth/config. | Usually routed by OpenClaw agent/session config; Orbs `--model` may not select the downstream model. | OpenClaw/Gateway permissions are separate from Orbs. acpx approval only covers the client boundary. | Must return final Orbs JSON through the bridge. | Depends on OpenClaw session key/binding and acpx named session behavior. | Gateway stop semantics must be tested; Orbs can mark the attempt blocked locally. | From final Orbs JSON and stop hooks only. Gateway artifacts are supplemental unless copied into final JSON. |
| `hermes` | Feasible through custom `agentCommand`: `hermes acp` or `hermes-acp`; Hermes docs say ACP sessions are in-memory while the ACP server runs. | Hermes ACP exposes chat, tool activity, diffs, terminal commands, approvals, and streamed chunks. | Hermes says ACP sessions bind the editor cwd to the task, but remote installs still need Orbs worktree verification. | Uses Hermes config, provider credentials, and `hermes model` setup. | Hermes ACP stores a selected model in session state; Orbs `--model` passthrough needs adapter smoke testing. | Hermes ACP approval options map to allow once, allow always, deny, and session-scoped approval. | Must return final Orbs JSON. | Scoped to the running Hermes ACP server process; not yet Orbs-native durable resume. | Hermes stores a cancel event per ACP session; Orbs should still treat cancellation as unverified until tested. | From final Orbs JSON and stop hooks only. Hermes internal logs/tools are supplemental. |
| `reasonix` | Not claimed supported. Available evidence shows a VS Code extension running an existing `reasonix acp` backend, but Orbs has no smoke test. | Unknown until `reasonix acp` is exercised through acpx. | Unknown; must verify cwd/worktree before use. | Unknown; use Reasonix setup docs or extension behavior. | Unknown; do not assume Orbs `--model` works. | Unknown; do not assume acpx approval maps cleanly. | Must return final Orbs JSON if used. | Unknown. | Unknown. | From final Orbs JSON and stop hooks only if a run succeeds. |

## Research Notes

- acpx is an alpha CLI for Agent Client Protocol sessions. Its documented capabilities include named persistent sessions, prompt queueing, cooperative cancel, cwd sandboxing, auth handshake support, structured ACP messages, and built-in/custom agent targets.
- The Agent Client Protocol registry lists Codex CLI, Claude, Hermes, OpenClaw, and OpenCode as ACP-capable agents, but registry presence is not equivalent to an Orbs smoke test.
- OpenCode documents `opencode acp` as an ACP subprocess command.
- Hermes documents `hermes acp` / `hermes-acp`, session state containing cwd/model/history/cancel event, and approval handling. Its ACP resume/list behavior is scoped to the running ACP server process.
- OpenClaw documents both directions: OpenClaw can run external harnesses through acpx, and OpenClaw can expose an ACP bridge for clients. Gateway-backed sessions need an explicit filesystem/cwd check.
- Reasonix currently remains a documented candidate only. Treat `agentCommand: "reasonix acp"` as an adapter hypothesis until a local command smoke test proves session creation, cwd, auth, permissions, model handling, JSON output, resume, and stop behavior.

Useful source links:

- https://github.com/openclaw/acpx
- https://agentclientprotocol.com/get-started/agents
- https://opencode.ubitools.com/acp/
- https://hermes-agent.nousresearch.com/docs/user-guide/features/acp
- https://docs.openclaw.ai/tools/acp-agents
- https://docs.openclaw.ai/cli/acp
