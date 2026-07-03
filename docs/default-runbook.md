# Default Runbook

This is the default way to use Ouroboros from another repository.

Keep the route simple:

- `planner`, `verifier`, and `goal-review` use `codex-resumable`.
- `worker` uses `claude-code`.
- Use the current worktree when the target repository already has relevant uncommitted changes.
- Use a git worktree only when the target repository is clean or the task should be isolated.
- If Claude Code through acpx times out, run Claude Code manually and record the result back into Ouroboros.

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
        "worker": "claude-code",
        "verifier": "codex-resumable",
        "goal-review": "codex-resumable"
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

## 7. Manual Claude Code Fallback

Use this when `claude-code` through acpx times out, stays silent, or the local adapter is not ready.

First render the exact worker prompt:

```bash
orbs show-task-prompt --task-id "$TASK_ID"
```

Then run Claude Code directly in the target repository:

```bash
cd /path/to/target-repo
claude
```

Paste the rendered task prompt into Claude Code. Let it edit files and run validation commands.

When Claude Code finishes, record the result:

```bash
orbs record-attempt \
  --task-id "$TASK_ID" \
  --input-json '{
    "mode": "manual-claude-code",
    "cwd": "REPLACE_WITH_TARGET_REPO",
    "reason": "acpx timeout or manual fallback"
  }' \
  --output-json '{
    "status": "done",
    "summary": "REPLACE_WITH_HUMAN_READABLE_RESULT",
    "changedFiles": [
      "REPLACE_WITH_CHANGED_FILE"
    ],
    "checks": [
      {
        "name": "REPLACE_WITH_COMMAND_NAME",
        "status": "passed",
        "summary": "REPLACE_WITH_EXACT_COMMAND_AND_RESULT"
      }
    ],
    "artifacts": [],
    "problems": []
  }'
```

Then resume verifier and goal review:

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

## 8. Defaults For Agents

When an agent is asked how to run Ouroboros, prefer this answer:

1. Create a run with Codex for `planner`, `verifier`, and `goal-review`, and Claude Code for `worker`.
2. Create a small worker task with `--config-json '{"agentBackend":"claude-code"}'`.
3. Use `--start-hook none` if current uncommitted changes are part of the task.
4. Use `--start-hook git-worktree --worktree-root .orbs/worktrees` only for clean or isolated work.
5. If acpx fails or times out, use `orbs show-task-prompt`, run `claude` manually, then write evidence with `orbs record-attempt`.
6. Continue `orbs run-loop` so Codex verifier and goal-review can finish the run.

Do not recommend Hermes, OpenCode, OpenClaw, or Reasonix. They are not supported backends.
