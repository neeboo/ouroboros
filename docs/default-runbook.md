# Default Runbook

This is the default way to use Ouroboros from another repository.

Keep the route Designer-first:

- `designer`, `planner`, `worker`, `verifier`, `outcome-review`, and `goal-review` use `codex-resumable`.
- Claude Code is available only when a task explicitly sets `config.agentBackend` to `claude-code`.
- A root run starts with a `designer` task that reads the active founder charter, strategy signals, lessons, run evidence, and due outcome reviews. It emits one evidence-backed proposal (with a frozen evaluation contract) or a mutation-free quiescent decision (no signal, no proposal — the rationale lives in the attempt summary).
- Accepted low-risk proposals create a child planner run automatically; only monetary or capital-policy decisions wait on human authority.
- Use the current worktree when the target repository already has relevant uncommitted changes.
- Use a git worktree only when the target repository is clean or the task should be isolated.
- If Claude Code through acpx fails or times out, the continuous supervisor creates a Codex recovery worker in the same run and reuses the source worktree.

## Shared default database

The default database is resolved from Git's common directory (`git rev-parse --git-common-dir`) and stored at `<git-common-dir>/orbs/ouroboros.db`. A main checkout and any linked Git worktree created with `git worktree add` therefore share one repository-common default database, so isolated agents can read durable run evidence without passing `--db`. Explicit `--db`, special SQLite paths (`:memory:`, `file:`), and the `.ouroboros/ouroboros.db` fallback used outside Git repositories remain unchanged.

For Ouroboros improving its own repository, the default entry point is:

```bash
orbs self-iterate-launch --parallel auto
```

That command starts the dashboard and the continuous self-improvement supervisor. It derives child-run goals from repository and run evidence, integrates verified changes locally, and waits when the repository fingerprint is unchanged.

## 1. Preflight

Run this inside the target repository:

```bash
cd /path/to/target-repo
git status --short
git branch --show-current
orbs init
orbs doctor-agent --agent claude-code
```

If `doctor-agent` fails, fix local Claude Code/acpx setup before creating real work.

## 2. Create The Run

Use this run context by default:

```bash
RUN_ID=$(orbs create-run \
  --project-root "$(pwd)" \
  --goal "REPLACE_WITH_GOAL" \
  --context-json '{
    "agentDefaults": {
      "global": "codex-resumable",
      "roles": {
        "planner": "codex-resumable",
        "worker": "codex-resumable",
        "verifier": "codex-resumable",
        "goal-review": "codex-resumable"
      }
    },
    "modelDefaults": {
      "global": { "model": "gpt-5.6-luna", "reasoning_effort": "high" },
      "roles": {
        "planner": { "model": "gpt-5.6-sol", "reasoning_effort": "high" },
        "verifier": { "model": "gpt-5.6-sol", "reasoning_effort": "high" },
        "goal-review": { "model": "gpt-5.6-sol", "reasoning_effort": "high" }
      }
    },
    "agentBackends": {
      "codex-resumable": { "kind": "codex-resumable" },
      "claude-code": {
        "kind": "acpx",
        "agent": "claude",
        "approval": "approve-all"
      }
    }
  }' | jq -r .id)

echo "$RUN_ID"
```

## 3. Create A Worker Task

Create one concrete worker task. Keep the prompt scoped and include real validation commands when known.

```bash
TASK_ID=$(orbs create-task \
  --run-id "$RUN_ID" \
  --role worker \
  --goal "REPLACE_WITH_SMALL_WORKER_GOAL" \
  --prompt "Work in $(pwd). REPLACE_WITH_EXACT_REQUIREMENTS. Keep changes scoped. Run the relevant validation commands. Return final Orbs JSON with changedFiles, checks, artifacts, and problems." \
  --done-when-json '[
    "required behavior is implemented",
    "relevant validation commands pass",
    "changed files are listed in final Orbs JSON",
    "any remaining risk is listed in problems"
  ]' \
  --config-json '{"agentBackend":"claude-code"}' | jq -r .id)

echo "$TASK_ID"
```

## 4. Run It In The Current Worktree

Use this when there are relevant uncommitted changes that the worker should continue.

```bash
orbs run-loop \
  --run-id "$RUN_ID" \
  --executor codex-resumable \
  --cwd "$(pwd)" \
  --sandbox workspace-write \
  --stop-hook create-runs,create-tasks,create-verifier,create-repair,context-summary \
  --start-hook none \
  --tasks 1 \
  --max-rounds 20 \
  --max-tries 3
```

## 5. Run It In An Isolated Worktree

Use this when the target repository is clean or isolation matters.

```bash
orbs run-loop \
  --run-id "$RUN_ID" \
  --executor codex-resumable \
  --cwd "$(pwd)" \
  --sandbox workspace-write \
  --stop-hook create-runs,create-tasks,create-verifier,create-repair,context-summary \
  --start-hook git-worktree \
  --worktree-root .orbs/worktrees \
  --tasks 1 \
  --max-rounds 20 \
  --max-tries 3
```

## 6. Watch The Run

```bash
orbs run-overview --run-id "$RUN_ID"
orbs run-graph --run-id "$RUN_ID"
orbs run-evidence --run-id "$RUN_ID"
orbs dashboard --run-id "$RUN_ID" --port 7331
```

## 7. Automatic Recovery

`self-improve-daemon` does not treat a blocked run as quiescent. It scans all blocked runs before ordinary scheduling and creates auditable recovery tasks in the same runs:

- Claude Code executor failures create a Codex recovery task.
- Codex executor failures continue as a bounded Codex repair task.
- Logical and verification blocks use a Codex repair worker.
- Recovery reuses the source task's actual worktree, completion criteria, and verifier contract.
- Recovery preserves the repair budget, permissions, timeout evidence, and generation metadata. It does not rotate backends automatically or retry forever.
- Multiple blocked runs receive recovery tasks in one tick; `--parallel auto` controls how many execute together.
- Only monetary or capital-policy authority may wait for a human decision.

## 8. Defaults For Agents

When an agent is asked how to run Ouroboros, prefer this answer:

1. Use `orbs self-iterate-launch --parallel auto` for Ouroboros improving itself. The root run starts with a `designer` task.
2. Create a run with Codex for `designer`, `planner`, `worker`, `verifier`, `outcome-review`, and `goal-review`.
3. Designer tasks return through fixed actions: `recordSignal`, `proposeDesign`, `decideDesign`, `recordDesignOutcome`, `createRunsFromDesign`. Only monetary or capital-policy decisions wait for human authority.
4. Create a small worker task with `--config-json '{"agentBackend":"claude-code"}'`.
5. Use `--start-hook none` if current uncommitted changes are part of the task.
6. Use `--start-hook git-worktree --worktree-root .orbs/worktrees` only for clean or isolated work.
7. Keep `self-improve-daemon` running; it creates finite Codex recovery tasks and preserves the source worktree automatically.
8. Let Codex verifier and goal-review finish each recovered run.
9. After verified integration, run `outcome-review` against the frozen evaluation contract.

Do not recommend Hermes, OpenCode, OpenClaw, or Reasonix. They are not supported backends.

## 9. Ouroboros Default Founder Charter

The first time `orbs self-iterate` or `orbs self-iterate-launch` runs in a new database, Ouroboros seeds the active founder charter below. The charter is versioned and immutable for the duration of a designer cycle. The designer may propose amendments as a diff with rationale; only a human or explicitly configured governance actor can activate a new version.

```json
{
  "managedBy": "ouroboros",
  "policyVersion": 2,
  "mission": "Make Ouroboros reliable, autonomous, observable, and useful for real coding work while adding measured commercial discipline without sacrificing safety.",
  "targetUsers": [
    "Solo developers running autonomous coding loops on local repositories",
    "Small teams using Ouroboros for evidence-backed product and infrastructure changes"
  ],
  "valueMetrics": [
    "time from goal to verified integrated change",
    "unattended completion rate",
    "human intervention and rescue rate",
    "cost per verified change"
  ],
  "principles": [
    "Strategy owns product direction; the planner, worker, and verifier loop own delivery",
    "Every durable strategy conclusion returns through validated fixed actions",
    "Quiescence is the correct answer when evidence does not justify new work",
    "Removals and simplifications are first-class outcomes alongside additions"
  ],
  "nonGoals": [
    "Incurring one-time or recurring monetary cost without a human spending decision",
    "Scraping competitor data or building a general finance system in this slice"
  ],
  "constraints": [
    "Technical, architecture, protocol, product, and repository decisions are delegated to the Designer and deterministic verifier loop",
    "Any monetary spend, capital-policy change, purchasing action, or recurring infrastructure commitment requires a human spending decision"
  ],
  "capitalPolicy": {
    "currency": "USD",
    "experimentBudget": 100,
    "recurringSpendApprovalAbove": 0,
    "portfolio": { "core": 4, "growth": 2, "exploration": 1 }
  },
  "authority": {
    "autoResearch": true,
    "autoReversibleExperiments": true,
    "autoIntegrateVerifiedCode": false,
    "humanApprovalPolicy": "cost-only",
    "requireHumanFor": [
      "capital-policy-amendment",
      "cost",
      "purchase",
      "recurring-infrastructure"
    ]
  },
  "reviewCadenceDays": 30
}
```

Inspect the active charter with `orbs design-status`. The charter serves as the durable objective function the designer is bounded by.

The Designer inspection commands are read-only and safe to run inside a restricted worktree that cannot write to the database:

```bash
orbs design-status                                  # active charter, current proposal, latest decision, next review
orbs list-signals                                   # active, expired, or superseded evidence by class and status
orbs show-design --proposal-id <proposal-id>        # frozen proposal, options, decisions, and recorded outcomes
orbs list-design-outcomes --status due \
  --due-before 2026-08-11T00:00:00Z                 # only outcome reviews due at or before a deterministic UTC timestamp
```

`--due-before` is required for deterministic `--status due` output and accepts only an ISO 8601 UTC timestamp. Without `--status`, `list-design-outcomes` lists all outcomes for optional `--project-id`, `--proposal-id`, `--stage`, or `--limit` filters; `--status due` cannot be combined with `--stage` because due outcomes are review-stage records selected by `reviewAt`.

## 10. Real Reliability Proposal Example

This is an example of a real reliability proposal that fits the default charter and automatic authority. It is the kind of proposal a designer cycle would emit after observing repeated `exit 124` codes during self-iteration.

```json
{
  "type": "proposeDesign",
  "payload": {
    "title": "Defer initial idle deadline until first output chunk",
    "problem": "Worker attempts report exit 124 when the first output chunk arrives after the idle window even though the agent is making progress. The run wastes retry budget on a false positive and the dashboard shows 'silent start' even when the agent is healthy.",
    "targetOutcome": "Worker attempts that produce first output within the configured initial-grace window are not killed by the idle timeout.",
    "evidenceRefs": [
      "signal:delivery:exit-124-on-slow-first-chunk",
      "lesson:self-iteration:exit-124-with-empty-events",
      "attempt:9c3f...:exit-124-no-output"
    ],
    "options": [
      {
        "name": "Initial grace window before idle timeout",
        "benefits": ["Removes the false positive", "Keeps the existing idle timeout for true silent starts"],
        "costs": ["One runner config knob", "One test path"],
        "risks": ["A bad agent could run longer before being killed"],
        "lockIn": ["Runner owns idle-window semantics"]
      },
      {
        "name": "Disable idle timeout entirely",
        "benefits": ["No false positives"],
        "costs": ["Silent starts run until wall-clock timeout"],
        "risks": ["Wastes compute on truly stuck agents"],
        "lockIn": ["Removes a supervision signal"]
      }
    ],
    "recommendation": "Initial grace window before idle timeout",
    "additions": [
      "Runner config: idleInitialGraceMs (default 60000)",
      "Runner honors idle timeout only after first output chunk or grace expiry"
    ],
    "removals": [],
    "assumptions": [
      "Workers that produce no output for >60s and never produce output are silent starts",
      "Workers that produce output then go silent remain covered by the existing idle timeout"
    ],
    "uncertainty": [
      "Exact grace duration may need tuning per backend"
    ],
    "evaluationContract": {
      "baseline": [
        "Self-iteration run 2026-08-01: 4 attempts exited 124 with empty event stream",
        "0.0% of exit-124 attempts produced any worktree changes"
      ],
      "successMetrics": [
        "Attempts that produce first output within 60s no longer hit exit 124",
        "Silent-start attempts still hit exit 124 within idle timeout + grace"
      ],
      "guardMetrics": [
        "Wall-clock timeout still bounds total runtime",
        "No increase in average attempt wall time"
      ],
      "requiredEvidence": [
        "Replay of failing attempts passes with grace window",
        "New unit test covers grace-not-yet-expired path",
        "New unit test covers silent-start after grace expiry"
      ],
      "reviewAt": "2026-09-15"
    },
    "investment": {
      "reversibility": "easy",
      "portfolio": "core",
      "oneTimeCost": 0,
      "recurringCost": 0,
      "timeBudget": "1 day"
    },
    "experiment": {
      "hypothesis": "False-positive exit 124 disappears when first-output grace is honored",
      "smallestTest": "Apply grace window, replay two prior failing attempts, confirm pass",
      "stopConditions": ["Any silent-start attempt runs past idle timeout + grace"],
      "rollback": "git revert the runner change"
    }
  }
}
```

Why this proposal passes automatic authority:

- `investment.reversibility = "easy"` — pure runner code change reverted by `git revert`.
- One-time and recurring costs are zero — inside the `$100` experiment budget.
- Evidence is current — all three `evidenceRefs` are recent and not expired.
- It has zero monetary spend and does not alter capital policy, purchase services, or create recurring infrastructure commitments.

The authority evaluator would record an `approved` decision with the matched rules and write a `design_decisions` row. `createRunsFromDesign` would then read the accepted proposal, copy the frozen evaluation contract into a child planner run, and the planner would sharpen the task graph and verifier contract before any worker attempt.
