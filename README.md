# Ouroboros

![Ouroboros pixel game cover](./docs/assets/ouroboros-cover-pixel-game.png)

English · [简体中文](./zh_CN.md)

Imagine a production system makes the same mistake for the third time. An agent can patch the code again. The tests can pass again. But if the next agent cannot see what happened, cannot reuse the fix, and cannot change the way future work is done, the system has learned nothing.

Ouroboros exists to make that learning durable. It is a local-first **meta self-improvement system**: it improves its own way of working, and it helps other systems, such as Hodor, design and operate their own self-improvement loops. The CLI is shortened to `orbs`.

## What Self-Improvement Means

A system truly self-improves when real experience can change how its next generation works:

```text
experience
  -> form a bounded improvement
  -> verify the result
  -> carry the proven capability into the next generation
  -> new experience
```

The last step matters. A lesson in a report is useful evidence, but it becomes system improvement only when the next run actually loads the updated prompt, knowledge, reusable capability package (skill), tool, or operating rule and records proof that it did so.

Ouroboros keeps this recursive method intentionally small. It can repeat at three levels:

- an implementer completes one product change;
- a target system improves how it performs its own domain work;
- Ouroboros improves the operating framework that designs, governs, and verifies both loops.

## Why Ouroboros

Suppose Hodor discovers from real production episodes that one part of its media workflow is slow, expensive, or unreliable. Ouroboros helps it turn that evidence into a bounded design, deliver the change, measure the result, and retain or roll it back. At the same time, Ouroboros watches its own failures: weak planning, lost context, repeated repairs, stale tools, or a scheduler that stops making progress. Those become candidates for improving Ouroboros itself.

This gives Ouroboros two connected responsibilities:

- **Improve Ouroboros:** make its planning, execution, verification, memory, tools, and resource decisions better over time.
- **Enable target systems:** give Hodor and other projects a governed way to observe outcomes, propose changes, verify them, and inherit successful capabilities.

Long-running agent work needs this control because common failures happen between prompts:

- task state lives in prompts instead of durable storage
- workers run in the same directory and step on each other
- verifier criteria drift while execution is already underway
- retries repeat the same failure
- logs are too raw for humans to understand
- finished worktrees are hard to integrate safely

Ouroboros keeps the control plane local and explicit. SQLite stores durable state, workers run in isolated worktrees and resumable sessions, verifiers check frozen contracts, repairs remain bounded, and integration leaves reviewable evidence.

## What Each Generation Must Inherit

Every run needs two kinds of context. For Hodor, they look like this:

- **Project knowledge:** production rules, cost records, past incidents, goals, and constraints from Hodor's own work.
- **ORBS capabilities:** the callable tools, prompts, reusable skills, and safety rules available to the agents working on Hodor.

Ouroboros now has a versioned operating framework (`HarnessRevision`). An approved revision binds prompts, project knowledge, reusable skills, tools, and agent policy by content hash. New runs freeze that revision, verify every component before startup, and record what was actually loaded. This is the mechanism that turns a proven change into capability inherited by the next generation. Project-wide activation of the first revision remains an explicit governed action, so old runs do not silently change underneath ongoing work.

## Resources and Human Decisions

When time, compute, and people are limited, the Designer contract asks every new proposal for one small resource request: expected value, information gain, maximum duration, task parallelism, human review time, and zero paid spend. The first allocator chooses the highest-value learning investment per project, caps its parallel tasks and duration, and leaves legacy work compatible. It deliberately avoids a separate planning bureaucracy; measured outcomes feed the next choice.

Humans define the charter, decide what risks are acceptable, and approve spending or other reserved high-impact changes. Linear is the durable approval and evidence surface. The dashboard can help with observation, but approval does not depend on it. Under the current managed charter, evidence-backed zero-spend changes may proceed automatically, while spending and charter changes require explicit human authority; projects can reserve additional high-risk decisions for people.

## The Operating Loop

```text
real evidence
  -> Designer proposes or deliberately waits
  -> authority accepts, rejects, or asks a human
  -> Planner freezes the delivery and verification contract
  -> Worker implements in an isolated, resumable session
  -> Verifier checks evidence; bounded repair handles failures
  -> verified integration
  -> outcome review retains, revises, or retires the change
  -> the next generation inherits the accepted result
```

## Status

Ouroboros is early. The control loop, durable capability inheritance, and the first zero-spend resource allocator work today; broader project adoption and measured long-term effectiveness are the next product milestone.

Available today:

- work can resume after interruption without losing task, session, lesson, or evidence history
- real evidence can become a reviewed design with a fixed success contract and bounded repair
- agents can work safely in isolated git worktrees and integrate verified changes
- Linear can receive work, record bounded status and evidence updates, and preserve human decisions
- Ouroboros can run continuous self-improvement without retrying the same failure forever

Active areas:

- activate the first governed Harness revision on every long-running project
- keep project knowledge separate from ORBS capabilities while refreshing both across runs
- carry approved skill and tool improvements into later generations automatically
- use measured outcomes to improve future value and information-gain estimates

Read the fuller product and system design:

- [Ouroboros and Hodor: Meta Self-Improvement](./docs/ouroboros-hodor-meta-self-improvement.md)
- [Designing Self-Evolution for a Target System](./docs/target-system-evolution.md)

## Install

Development:

```bash
bun install
bun link
orbs init
```

Before linking, the repo-local fallback is still available as `bun run orbs -- <command>`.

Distribution target:

```bash
brew install orbs
orbs init
```

## Quick Start

Initialize the local database:

```bash
orbs init
```

For normal project work, use the default runbook:

```text
docs/default-runbook.md
```

It keeps the default path Designer-first and routes every role, including `worker`, through `codex-resumable`. Claude Code remains available only when a task selects it explicitly.

Launch continuous self-improvement with the dashboard:

```bash
orbs self-iterate-launch \
  --parallel auto \
  --worktree-root .ouroboros/worktrees \
  --start-hook git-worktree
```

The root run starts with a `designer` task that reads the active founder charter, strategy signals, lessons, run evidence, and due outcome reviews. The designer emits one evidence-backed proposal (with a frozen evaluation contract) or a mutation-free quiescent decision whose rationale lives in the attempt summary. Accepted low-risk proposals create a child planner run automatically; high-risk proposals block on a human `decideDesign`. Implemented proposals move into outcome review after verified integration. Ouroboros waits when the evidence does not justify another change.

Open:

```text
http://localhost:7331
```

Create a project-scoped run manually:

```bash
orbs create-project --name "Ouroboros" --root-path "$(pwd)"
orbs create-run --goal "Use Ouroboros to improve this repository" --project-root "$(pwd)"
```

Create a planner task:

```bash
orbs create-task \
  --run-id <run_id> \
  --role planner \
  --goal "Plan next step" \
  --prompt "Inspect the repo and propose the smallest useful task graph."
```

Run the loop:

```bash
orbs run-loop \
  --run-id <run_id> \
  --executor codex-resumable \
  --cwd "$(pwd)" \
  --sandbox workspace-write \
  --timeout-ms 1800000 \
  --idle-timeout-ms 300000 \
  --stop-hook create-tasks,create-verifier,create-repair,context-summary \
  --tasks auto \
  --worktree-root .ouroboros/worktrees \
  --start-hook git-worktree \
  --max-rounds 8
```

## Configuration

Ouroboros uses local TOML config plus environment variables. Do not commit real tokens.

```bash
cp ouroboros.example.toml ouroboros.toml
```

Linear example:

```toml
[linear]
project_url = "https://linear.app/<workspace>/project/<project>/overview"
team_key = "<team-key>"
token_file = ".linear"

# Bounded supervisor polling is the primary transport when orbs self-improve-daemon runs.
poll_interval_ms = 60000
poll_page_size = 50
poll_max_pages_per_cycle = 5
poll_max_issues_per_cycle = 100
poll_overlap_ms = 300000
poll_max_retries = 4
poll_backoff_base_ms = 2000
poll_backoff_max_ms = 300000
```

Polling reads issues from exactly one Linear project and team. Configure `project_id` directly or provide `project_url` for one-time project resolution, together with `team_key`; the existing Linear token source (`LINEAR_API_KEY`, `token_env`, or `token_file`) is reused and never stored in run context. Polling advances the durable cursor only after durable ingestion, applies equal-timestamp overlap and bounded exponential backoff, and routes each issue through an issue-scoped Designer cycle. `orbs linear-ingest-event` remains the supported manual fallback.

Environment override:

```bash
LINEAR_API_KEY=lin_api_... orbs linear-check --run-id <run_id>
```

For a bounded end-to-end intake check, create one uniquely named issue through the same configured token, then let supervisor polling consume it. This proof uses the API and SQLite control state; it does not require a browser:

```bash
orbs linear-create-issue \
  --title "[orbs-dogfood] Verify autonomous Linear intake $(date +%s)" \
  --description "Zero-cost API verification for poll -> inbox -> Designer -> planning run -> external ref."
```

Two narrow writeback primitives close the Linear delivery loop without exposing arbitrary GraphQL. `linear-update-status` accepts exactly one of `--state-id` (immutable UUID) or `--state-name` (team-scoped, exact match) and verifies the result through an independent issue readback. `linear-write-evidence-comment` writes one bounded evidence comment per `(issue id, idempotency key, normalized evidence)` tuple, recovers from a lost mutation response by reusing the existing marker, and reports `idempotency_conflict` for duplicate markers with divergent bodies. The two commands are separate Linear requests, not a transaction; partial success is reported explicitly (status stays, comment-only retry). See `docs/protocol.md` for the full contract, including `state_name_unknown`, `state_name_ambiguous`, `permission_denied`, `readback_mismatch`, idempotency boundaries, and remote-side-effect notes.

```bash
orbs linear-update-status \
  --issue-id 0ad49c7d-9f2b-4f2e-8743-ee017d841171 \
  --state-name "In Progress"

orbs linear-write-evidence-comment \
  --issue-id 0ad49c7d-9f2b-4f2e-8743-ee017d841171 \
  --idempotency-key pan-1236-verifier-v1 \
  --idempotency-secret-file ./secrets/linear-writeback-hmac.txt \
  --evidence-summary "focused tests: pass; full suite: pass; typecheck: pass"
```

Autonomous self-improvement disables browser process launches across Codex and Claude Code by default. Use API, CLI, component-test, and SQLite evidence first. Pass `--browser-process-policy allow` only for a user-started run whose verification contract explicitly requires checking a rendered interface.

Model preference can live on the run or on a single task:

```bash
orbs create-run \
  --goal "Use Ouroboros to iterate on Ouroboros" \
  --context-json '{"modelDefaults":{"global":{"model":"gpt-5.6-luna","reasoning_effort":"high"},"roles":{"planner":{"model":"gpt-5.6-sol","reasoning_effort":"high"},"verifier":{"model":"gpt-5.6-sol","reasoning_effort":"high"}}}}'
```

```bash
orbs create-task \
  --run-id <run_id> \
  --role worker \
  --goal "Cheap implementation pass" \
  --prompt "Implement the scoped change." \
  --config-json '{"modelPreference":{"model":"gpt-5.6-luna","reasoning_effort":"high","reason":"implementation pass"}}'
```

Resolution order:

```text
task.config.modelPreference
then run.context.modelDefaults.roles[task.role]
then run.context.modelDefaults.global
then CLI --model
```

Agent backend selection can also live on the run or on a single task:

```bash
orbs create-run \
  --goal "Use Ouroboros to iterate on Ouroboros" \
  --context-json '{"agentDefaults":{"global":"codex-resumable","roles":{"worker":"codex-resumable","verifier":"codex-resumable"}},"agentBackends":{"claude-code":{"kind":"acpx","agent":"claude","approval":"approve-all"},"codex-resumable":{"kind":"codex-resumable"}}}'
```

```bash
orbs create-task \
  --run-id <run_id> \
  --role worker \
  --goal "Run through Claude Code" \
  --prompt "Implement the scoped change." \
  --config-json '{"agentBackend":"claude-code"}'
```

See `docs/default-runbook.md` for the recommended end-to-end run commands. See `docs/agent-backends.md` for capability boundaries, smoke testing, and the experimental custom `agentCommand` escape hatch.

Claude Code uses its local Claude configuration by default. When a route resolves to semantic `agent: "claude"`, including a reserved `claude-code` backend using raw `agentCommand` transport, Orbs drops inherited `modelDefaults` and CLI `--model` values, including inert metadata such as `base_url` and `env_key`. A task can still set an explicit `config.modelPreference` when the Claude adapter should receive a specific `--model`; an explicit provider must be `anthropic` or `claude`. Provider identity is declared by backend metadata and is never inferred from the command path.

### DeepSeek Harness

DeepSeek Harness can be selected as another task executor. Install and configure the official `dsh` CLI separately, then declare a named backend:

```toml
[agentDefaults.roles]
worker = "deepseek-harness"

["agentBackends"."deepseek-harness"]
kind = "dsh-cli"
command = "dsh"
profile = "headless"
```

Or select the built-in route for one run:

```bash
orbs run-next \
  --run-id <run_id> \
  --executor dsh-cli \
  --cwd "$(pwd)" \
  --sandbox workspace-write
```

This first adapter is intentionally one-shot. Ouroboros starts `dsh --profile headless` in the exact task worktree, keeps the frozen task and verifier contracts, and accepts only a structured `AttemptOutput` result. `danger-full-access`, unsupported DSH profiles, oversized command arguments, and tasks requesting Ouroboros host execution capabilities fail before DSH can act. DSH owns its model selection through its profile, so Ouroboros model defaults are not forwarded. ACP session recovery and HarnessRevision-backed DSH skills are planned after real task evidence shows where DSH improves the executor portfolio.

Inspect readiness without starting a task or contacting a provider:

```bash
# built-in command resolved from the execution child PATH
orbs doctor-agent --agent dsh-cli

# named backend from a TOML file; the entry must be dsh-cli/headless
orbs doctor-agent --agent deepseek-harness --config ./config.toml
```

The receipt identifies the configured command, resolution mode, selected executable, canonical path when available, installation state, observed version, version/help probe status, callability, readiness, and `lifecycle: "one-shot"`. A bare `dsh` selects the first executable PATH candidate in deterministic order; an explicit path stays explicit. A symlink or wrapper is reported as the selected executable, with its canonical path shown separately when resolvable, and is never represented as an inferred underlying program. Only `[selectedPath, "--version"]` and `[selectedPath, "--help"]` run, with empty stdin and bounded timeouts. Provider calls, model inference calls, paid spend, and task execution are explicitly recorded as zero. Missing, timeout, malformed, nonzero, and spawn-failure cases return bounded redacted evidence.

This inspection does not add model routing, sessions, ACP, plugins, dependencies, schema changes, or paid infrastructure. Rollback removes the DSH doctor branch, readiness helper, focused tests, and documentation while retaining the existing explicit one-shot adapter and Codex defaults.

### Self-Iteration Backend Default

Self-iteration runs keep `designer`, `planner`, `worker`, `verifier`, `outcome-review`, and `goal-review` on `codex-resumable` by default. Claude Code remains available only through an explicit task-level `config.agentBackend = "claude-code"`. Claude failures recover to Codex; Codex failures continue as bounded Codex repair tasks under the repair budget. This policy is finite and does not rotate backends automatically or retry forever. Configure it through `ouroboros.toml`:

```toml
[agentDefaults]
global = "codex-resumable"

[agentDefaults.roles]
planner = "codex-resumable"
worker = "codex-resumable"
verifier = "codex-resumable"
goal-review = "codex-resumable"

["agentBackends"."claude-code"]
kind = "acpx"
agent = "claude"
approval = "approve-all"

["agentBackends"."codex-resumable"]
kind = "codex-resumable"
```

Inspect future self-iteration run evidence with:

```bash
orbs run-overview --run-id <run_id>   # confirms agentDefaults.roles and latest attempts
orbs list-lessons --run-id <run_id>   # confirms no new silent-start lesson was recorded
```

## Common Commands

```bash
# observability
orbs run-overview --run-id <run_id>
orbs dashboard --run-id <run_id> --port 7331

# task execution
orbs next-task --run-id <run_id>
orbs run-next --run-id <run_id> --executor noop --limit 2
orbs run-next --run-id <run_id> --executor codex-cli --cwd "$(pwd)" --sandbox read-only
orbs run-loop --run-id <run_id> --executor codex-resumable --cwd "$(pwd)"

# agent readiness
orbs doctor-agent --agent claude-code
bun run scripts/acpx-agent-smoke.ts claude-code

# resumable Codex
orbs codex-start-attempt --task-id <task_id> --cwd "$(pwd)"
orbs list-running-attempts --run-id <run_id>
orbs codex-resume-attempt --attempt-id <attempt_id> --cwd "$(pwd)"

# manual attempt control
orbs start-attempt --task-id <task_id> --input-json '{}'
orbs finish-attempt --attempt-id <attempt_id> --output-json '{"status":"done","summary":"..."}'
orbs retry-task --task-id <task_id>

# prompt templates and lessons
orbs list-lessons --run-id <run_id>
orbs show-task-prompt --task-id <task_id>
orbs show-prompt-template --key task
orbs set-prompt-template --key task --content "# Custom template..."

# Linear bridge
orbs linear-link-issue --local-type run --local-id <run_id> --issue-key LIN-123
orbs linear-link-issue --local-type task --local-id <task_id> --issue-url https://linear.app/<workspace>/issue/LIN-123/title
orbs linear-ingest-event --event-type issue.created --external-id LIN-123 --payload-json '{"action":"create"}'
```

## Roles

| Role | Responsibility |
| --- | --- |
| `designer` | Reads the active founder charter and current world model; researches evidence; compares alternatives; proposes designs; revisits decisions using outcome evidence. |
| `planner` | Accepts a frozen proposal and evaluation contract; creates executable tasks, dependencies, verifier contracts, and repair paths. Cannot invent product direction or weaken the design contract. |
| `worker` | Implements one scoped task in its own session and, usually, its own worktree. |
| `verifier` | Checks evidence through tests, commands, diff review, browser checks, or contract-specific criteria. |
| `repair` | Fixes verifier failures while preserving the original success contract. |
| `outcome-review` | Compares post-integration or post-release evidence with the proposal baseline; records `retain`, `revise`, or `retire`; feeds discrepancies back as strategy signals. |
| `goal-review` | Runs when the queue is empty and decides whether the original goal is complete. |
| `integrator` | Planned stage that turns verified worktree output into reviewable integration output. |

## Founder Charter

The founder charter is the durable, versioned, human-owned contract that bounds the designer. It defines the mission, value metrics, principles, non-goals, constraints, capital policy, delegated authority, and review cadence. The designer may propose amendments; only a human or explicitly configured governance actor can activate them.

The Ouroboros default charter is seeded automatically on first use. It is also reproduced in `docs/default-runbook.md` so operators can copy, edit, and activate a project-specific variant.

```bash
orbs design-status                              # active charter, current proposal, latest decision, next review
orbs list-signals                               # expiring evidence by class and status
orbs show-design --proposal-id <id>             # frozen contract, options, decisions, outcomes
orbs list-design-outcomes --status due \
  --due-before 2026-08-11T00:00:00Z             # only outcome reviews due at or before the given time
```

All four commands are read-only: they open an existing database in non-mutating mode and never create or alter schema, sidecar, or filesystem state, so they are safe to run inside restricted Designer worktrees.

## Designer Operating Contract

The designer runs before planning. It must produce durable conclusions through fixed actions:

- `recordSignal` — store a sourced, expiring observation.
- `proposeDesign` — store a proposal with options, recommendation, evaluation contract, and investment shape.
- `decideDesign` — human or governance actor records an approval, rejection, deferral, or retirement.
- `recordDesignOutcome` — record baseline, observed metrics, evidence, unexpected effects, and recommendation.
- `createRunsFromDesign` — read an accepted proposal and create a child planner run with the frozen contract.

The authority evaluator applies hard charter constraints (mission, capital, reversibility, evidence expiry, sensitive-data, destructive operations, production deployment) before scoring options. Automatic authority is limited to reversible experiments inside the experiment budget. Everything else becomes an explicit human decision recorded as a `design_decisions` row.

## Dashboard

The dashboard is the live control surface for a run. It should make these questions easy to answer:

- What is the current goal?
- Which tasks are running, done, blocked, or waiting for repair?
- What are the planner, worker, verifier, and integrator sessions doing?
- Which files changed?
- What evidence did the verifier produce?
- Is the runner still active, resumable, or stopped?

Start it with:

```bash
orbs dashboard --run-id <run_id> --port 7331
```

Useful local APIs:

```text
GET /api/runs/<run_id>/overview
GET /api/runs/<run_id>/changed-files
GET /api/runs/<run_id>/diff?path=<tracked_path>
```

## Linear Bridge

Linear is the collaboration surface. GitHub is the code surface. The local Ouroboros database is the control plane.

Current bridge scope:

- `linear-check` validates Linear access and records the run-to-project reference.
- `linear-link-issue` maps a local run or task to an external Linear issue.
- Bounded supervisor polling is the primary transport. While `orbs self-improve-daemon` (or `orbs self-iterate-launch`, which runs the dashboard and the daemon together) is active and `[linear]` polling is configured, the supervisor reads new issues from exactly one Linear project and team on each eligible tick, durably deduplicates them, and routes each issue through an issue-scoped Designer cycle. Polling uses bounded page and per-cycle limits, advances the durable cursor only after every issue in a page is durably ingested, applies bounded exponential backoff for rate-limit and transient failures, and surfaces permanent authentication, scope, or configuration failures as terminal blocked intake state on the dashboard.
- `linear-ingest-event` remains the supported manual fallback and feeds the same idempotent intake path. It records a Linear event payload into `inbox_events` with `provider linear` and `status todo`. This is intake only: it stores the raw event and does not interpret it, does not create or update runs or tasks, and does not write to `external_refs`.

Inbox intake and external refs are separate paths. `external_refs` records stable local-to-external anchors. `inbox_events` records incoming raw events. Each Linear `issue.created` inbox event derives a deterministic issue-scoped Designer run and task keyed by the supervised root run and the immutable Linear issue ID. Repeated polling, overlap-window replay, or supervisor restarts reuse the same durable identities instead of duplicating them. The Designer's durable conclusions return only through fixed actions; when an accepted proposal creates its delivery run, the deterministic action hook creates or reuses exactly one `external_refs` row linking that planning run to the Linear issue and transitions the matching inbox event to `done`.

The dashboard surfaces the full lifecycle on the inspector's "Linear intake" section: polling state (`retryAttempt`, `nextEligiblePollAt`, terminal failure, ingestion counters), the source Linear issue identifier and URL, inbox event state, the issue-scoped Designer task, recorded proposal and decision IDs, the linked planning run ID and status, and the current runner/supervisor state — without ever exposing tokens.

Not implemented yet:

- automatic issue creation
- webhook listener (bounded polling is the primary transport)
- comment sync
- PR status sync

Those events should enter through the harness inbox so the local control loop can decide what they mean.

## Project Layout

```text
docs/protocol.md                 Minimal runtime protocol
docs/control-loop-contracts.md   Planning, verification, guardrails, and experience
docs/self-iteration-plan.md      Self-iteration seed plan
AGENTS.md                        Repo-level instructions for future agents
packages/harness/schema.sql      SQLite schema
packages/harness/src/            Harness library
packages/runner/src/             Prompt builder, executors, hooks
packages/cli/src/                CLI and dashboard
```

## Development

```bash
bun install
bun run typecheck
bun test
```

Focused checks:

```bash
bun test tests/dashboard.test.ts
bun test tests/harness.test.ts tests/runner.test.ts
```

## License

MIT, unless a future release says otherwise.
