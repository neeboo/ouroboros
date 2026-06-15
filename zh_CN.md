# Ouroboros

[English](./README.md) · 简体中文

Ouroboros 是一个本地优先的编码 agent 控制系统，用来承载长时间运行的目标、任务、会话、验证、修复和最终可审查产物。

它的核心模式是 Loop Engineering：让目标进入可观察、可验证、可修复、可继续迭代的工作循环。项目名保留 Ouroboros，因为这个名字本身就指向“循环”；命令行缩写为 `orbs`。

## 为什么做

编码 agent 很擅长完成聚焦任务，但长程工作常常卡在控制层：

- 任务状态只存在提示词里，没有持久记录。
- 多个 worker 在同一个目录里互相影响。
- verifier 的标准在 execution 期间漂移。
- retry 会重复同样的失败。
- stdout 信息量很大，但很难作为人类会话阅读。
- worker worktree 做完之后，很难安全合成 PR 或 patch。

Ouroboros 把控制面放在本地：

- SQLite 保存 runs、tasks、attempts、sessions、lessons、artifacts 和 external refs。
- planner 生成任务图。
- worker 在可恢复 session 中执行，通常分配独立 git worktree。
- verifier 根据契约和证据验证结果。
- repair 基于 verifier 的失败证据继续修复。
- integrator 把验证通过的 worktree 产物整理成可审查输出。
- dashboard 展示当前 run、sessions、todos、changed files、diff 和 runner 状态。

```text
goal
  -> planner task graph
  -> worker sessions in worktrees
  -> verifier evidence
  -> repair loop
  -> integrator / proposed artifact
  -> goal review
```

## 当前状态

Ouroboros 还在早期，但已经具备最小自举循环：

- SQLite-backed harness
- 数据库中的 prompt templates
- 按角色生效的 stop hooks
- 可恢复 Codex executor
- acpx/Codex executor 基础
- git worktree start hook
- dashboard：task graph、flow view、sessions、todos、changed files、diff inspection
- Linear mapping skeleton
- self-iteration command

正在推进：

- integrator stage：把已验证 worktree 产物合成可审查 patch、branch 或 PR。
- multi-agent backend：通过 ACP/acpx 接入 Codex、Claude Code、Reasonix、OpenCode、OpenClaw 等 coding agent。
- dashboard history：左侧 run history 从数据库读取并持久切换。
- conversation view：把 raw stdout 转成更像 coding-agent 会话的可读流。

## 安装

开发态：

```bash
bun install
bun run orbs -- init
```

目标分发形态：

```bash
brew install orbs
orbs init
```

## 快速开始

初始化本地数据库：

```bash
bun run orbs -- init
```

创建一个自迭代 run：

```bash
bun run orbs -- self-iterate
```

启动 dashboard 和后台 runner：

```bash
bun run orbs -- self-iterate-launch \
  --concurrency 3 \
  --worktree-root .ouroboros/worktrees \
  --start-hook git-worktree
```

打开：

```text
http://localhost:7331
```

手动创建项目和 run：

```bash
bun run orbs -- create-project --name "Ouroboros" --root-path "$(pwd)"
bun run orbs -- create-run --goal "Use Ouroboros to improve this repository" --project-root "$(pwd)"
```

创建 planner task：

```bash
bun run orbs -- create-task \
  --run-id <run_id> \
  --role planner \
  --goal "Plan next step" \
  --prompt "Inspect the repo and propose the smallest useful task graph."
```

运行队列：

```bash
bun run orbs -- run-loop \
  --run-id <run_id> \
  --executor codex-resumable \
  --cwd "$(pwd)" \
  --sandbox workspace-write \
  --timeout-ms 1800000 \
  --idle-timeout-ms 300000 \
  --stop-hook create-tasks,create-verifier,create-repair,context-summary \
  --concurrency 3 \
  --worktree-root .ouroboros/worktrees \
  --start-hook git-worktree \
  --max-rounds 8
```

## 配置

Ouroboros 使用本地 TOML 配置和环境变量。真实 token 不要提交进仓库。

```bash
cp ouroboros.example.toml ouroboros.toml
```

Linear 示例：

```toml
[linear]
project_url = "https://linear.app/<workspace>/project/<project>/overview"
team_key = "<team-key>"
token_file = ".linear"
```

也可以用环境变量：

```bash
LINEAR_API_KEY=lin_api_... bun run orbs -- linear-check --run-id <run_id>
```

模型偏好可以放在 run context 或 task config：

```bash
bun run orbs -- create-run \
  --goal "Use Ouroboros to iterate on Ouroboros" \
  --context-json '{"modelDefaults":{"roles":{"worker":{"model":"gpt-5.4-mini"},"verifier":{"model":"gpt-5.5"}}}}'
```

```bash
bun run orbs -- create-task \
  --run-id <run_id> \
  --role worker \
  --goal "Cheap implementation pass" \
  --prompt "Implement the scoped change." \
  --config-json '{"modelPreference":{"model":"gpt-5.4-mini","reason":"low-risk worker"}}'
```

解析顺序：

```text
task.config.modelPreference
then run.context.modelDefaults.roles[task.role]
then run.context.modelDefaults.global
then CLI --model
```

## 常用命令

```bash
# observability
bun run orbs -- run-overview --run-id <run_id>
bun run orbs -- dashboard --run-id <run_id> --port 7331

# task execution
bun run orbs -- next-task --run-id <run_id>
bun run orbs -- run-next --run-id <run_id> --executor noop --limit 2
bun run orbs -- run-next --run-id <run_id> --executor codex-cli --cwd "$(pwd)" --sandbox read-only
bun run orbs -- run-loop --run-id <run_id> --executor codex-resumable --cwd "$(pwd)"

# resumable Codex
bun run orbs -- codex-start-attempt --task-id <task_id> --cwd "$(pwd)"
bun run orbs -- list-running-attempts --run-id <run_id>
bun run orbs -- codex-resume-attempt --attempt-id <attempt_id> --cwd "$(pwd)"

# manual attempt control
bun run orbs -- start-attempt --task-id <task_id> --input-json '{}'
bun run orbs -- finish-attempt --attempt-id <attempt_id> --output-json '{"status":"done","summary":"..."}'
bun run orbs -- retry-task --task-id <task_id>

# prompt templates and lessons
bun run orbs -- list-lessons --run-id <run_id>
bun run orbs -- show-task-prompt --task-id <task_id>
bun run orbs -- show-prompt-template --key task
bun run orbs -- set-prompt-template --key task --content "# Custom template..."

# Linear bridge
bun run orbs -- linear-link-issue --local-type run --local-id <run_id> --issue-key LIN-123
bun run orbs -- linear-link-issue --local-type task --local-id <task_id> --issue-url https://linear.app/<workspace>/issue/LIN-123/title
```

## 角色

| Role | 责任 |
| --- | --- |
| `planner` | 读取目标、约束和历史经验，生成可执行任务图。 |
| `worker` | 在自己的 session/worktree 里实现一个明确任务。 |
| `verifier` | 通过测试、命令、diff、浏览器或契约标准验证结果。 |
| `repair` | 根据 verifier 的失败证据修复，同时保留原成功标准。 |
| `goal-review` | 队列清空后判断原始目标是否已经满足。 |
| `integrator` | 规划中：收集已验证 worktree 产物，生成可审查的集成结果。 |

## Dashboard

Dashboard 是 Ouroboros 的运行控制界面。它应该快速回答：

- 当前 goal 是什么？
- 哪些 task 正在跑、完成、阻塞或等待 repair？
- planner、worker、verifier、integrator session 正在做什么？
- 哪些文件改了？
- verifier 的证据是什么？
- runner 是否还在运行、可恢复或已停止？

启动：

```bash
bun run orbs -- dashboard --run-id <run_id> --port 7331
```

本地接口：

```text
GET /api/runs/<run_id>/overview
GET /api/runs/<run_id>/changed-files
GET /api/runs/<run_id>/diff?path=<tracked_path>
```

## Linear Bridge

Linear 是协作入口，GitHub 是代码入口，本地 Ouroboros 数据库是控制面。

当前 bridge 范围：

- `linear-check` 校验 Linear token，并记录 run 到 project 的引用。
- `linear-link-issue` 把本地 run/task 映射到外部 Linear issue。

暂未实现：

- 自动创建 issue
- webhook/event listening
- comment sync
- PR status sync

这些事件之后应该进入 harness inbox，再由本地控制循环判断它们对 run 和 task 意味着什么。

## 项目结构

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

## 开发

```bash
bun install
bun run typecheck
bun test
```

定向检查：

```bash
bun test tests/dashboard.test.ts
bun test tests/harness.test.ts tests/runner.test.ts
```

## License

MIT, unless a future release says otherwise.
