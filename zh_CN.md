# Ouroboros

[English](./README.md) · 简体中文

想象一个生产系统第三次犯了同样的错。智能体可以再修一遍代码，测试也可以再绿一次。可下一位智能体看不到这次经历，用不上这次修复，也没有改变后续工作的办法。系统忙了很久，却没有学会任何东西。

Ouroboros 要让这种学习真正留下来。它是一个本地优先的**元自进化系统**：一边改进自己的工作方式，一边帮助 Hodor 等其他系统设计和运行各自的自进化能力。命令行缩写为 `orbs`。

## 什么是真正的自进化

真正的自进化，是让真实经历改变下一代如何工作：

```text
真实经历
  -> 形成一个边界清楚的改进
  -> 验证结果
  -> 让下一代继承已经证明有效的能力
  -> 获得新的真实经历
```

最后一步决定了学习有没有发生。一条经验写进报告，只能算留下了证据。下一轮实际加载了更新后的提示、知识、可复用能力包（Skill）、工具或运行规则，并留下采用证明，这条经验才真正变成系统能力。

Ouroboros 把递归方法压缩到这条短循环，并让它在三个层次上重复：

- 执行者完成一次产品改进；
- Hodor 这样的目标系统改进自己完成领域工作的方式；
- Ouroboros 改进负责设计、治理和验证这些循环的运行框架。

## 为什么做

比如，Hodor 从真实制作记录里发现某段媒体流程太慢、成本过高或经常失败。Ouroboros 帮它把证据变成一个有边界的设计，完成交付，测量结果，再决定保留还是回滚。与此同时，Ouroboros 也观察自己的失败：规划不清、上下文丢失、反复修复、工具过期，或调度器失去进展。这些问题会成为 Ouroboros 改进自己的候选项。

所以 Ouroboros 同时承担两份工作：

- **改进 Ouroboros 自己：**持续改善规划、执行、验证、记忆、工具和资源选择。
- **赋能目标系统：**让 Hodor 和其他项目能够观察结果、提出改进、验证成效，并把成功能力交给下一代。

长程工作需要这套控制，因为很多失败发生在两次提示之间：

- 任务状态只存在提示里，没有持久记录。
- 多个执行者在同一个目录里互相影响。
- 验收标准在执行期间发生漂移。
- 重试不断重复同一种失败。
- 大量日志很难让人快速看懂。
- 隔离工作区完成后，成果很难安全集成。

Ouroboros 把控制信息保存在本地。SQLite 记录进展；执行者使用隔离工作区和可恢复会话；验证者根据已经定好的标准验收；修复次数有明确上限；集成过程留下可复查证据。

## 下一代要继承什么

每次运行都需要两层上下文。以 Hodor 为例：

- **项目领域知识：**Hodor 自己的制作规则、成本记录、历史事故、目标和限制。
- **ORBS 系统能力：**帮助 Hodor 工作的智能体可以调用哪些工具、使用哪些提示和可复用能力，以及必须遵守哪些安全规则。

Ouroboros 现在已经有版本化的运行框架（`HarnessRevision`）。一份获批的版本会用内容哈希绑定提示、项目知识、可复用能力、工具和智能体规则。新一轮运行会冻结这个版本，在启动前逐项验证，并记录实际装载了什么。经过验证的改进由此成为下一代真正继承的能力。每个项目首次启用新版本仍需走明确的治理动作，进行中的旧任务不会被悄悄换掉能力。

## 资源和人的角色

时间、算力和人力有限时，设计者合同会要求每个新提案提交一份很小的资源申请：预期价值、信息增益、最长时间、任务并发、人工复核时间，以及固定为零的付费金额。第一版分配器会为每个项目选择优先级最高的一项，限制它的并发和时长，同时兼容已有任务。它不会再造一套复杂流程；测量结果会进入下一轮选择。

人负责确定章程、可接受风险和资金边界，并审批花钱或其他预留的高影响变化。Linear 是持久的审批与证据入口。Dashboard 可以帮助观察运行状态，但审批不依赖它。按照当前托管章程，有证据且零成本的技术改进可以自动推进；花钱和修改章程需要人明确批准；项目也可以把额外的高风险决策保留给人。

## 运行循环

```text
真实证据
  -> 设计者（Designer）提出改进，或有理由地等待
  -> 权限规则接受、拒绝，或交给人审批
  -> 规划者（Planner）确定交付范围和验收标准
  -> 执行者（Worker）在隔离、可恢复的会话中实施
  -> 验证者（Verifier）查验证据，失败时做有限修复
  -> 验证通过后集成
  -> 结果复核决定保留、修订或退役
  -> 下一代继承已接受的结果
```

## 当前状态

Ouroboros 还在早期。控制循环、能力代际继承和第一版零付费资源分配已经能工作；下一阶段重点是让更多项目正式启用，并持续证明长期效果。

目前已经具备：

- 任务中断后可以继续，运行记录、会话、经验和证据不会丢失
- 真实证据可以变成经过审查的设计，成功标准提前确定，失败修复有次数上限
- 智能体可以在隔离的 Git 工作区安全协作，并集成已经验证的修改
- Linear 可以接收需求、记录受限的状态和证据更新，并保留人的决定
- Ouroboros 可以持续改进自己，同时避免对同一种失败无限重试

正在推进：

- 让每个长期运行的项目正式启用第一份受治理的运行框架版本
- 分开管理项目知识和 ORBS 能力，让两者都能跨周期及时更新
- 把已经批准的能力包和工具改进自动带进后续代际
- 用真实测量结果持续修正后续的价值和信息增益判断

更完整的产品与系统设计：

- [Ouroboros 与 Hodor：元自进化系统如何赋能目标系统](./docs/ouroboros-hodor-meta-self-improvement.md)
- [如何为目标系统设计自进化能力](./docs/target-system-evolution.md)

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

## 接入 DeepSeek Harness

DeepSeek Harness 可以作为另一种任务执行器。先单独安装并配置官方 `dsh` 命令，再在配置中声明一个后端：

```toml
[agentDefaults.roles]
worker = "deepseek-harness"

["agentBackends"."deepseek-harness"]
kind = "dsh-cli"
command = "dsh"
profile = "headless"
```

也可以只让一次运行使用内置路线：

```bash
bun run orbs -- run-next \
  --run-id <run_id> \
  --executor dsh-cli \
  --cwd "$(pwd)" \
  --sandbox workspace-write
```

第一版只做单次执行。Ouroboros 会在任务自己的隔离工作区中启动 `dsh --profile headless`，继续管理已经冻结的任务和验收合同，并且只接受结构化的 `AttemptOutput` 结果。危险权限、不支持的 DSH profile、超长命令参数，以及需要 Ouroboros 宿主执行能力的任务，都会在 DSH 开始工作前被阻断。DSH 使用自己 profile 中的模型配置，不继承 Ouroboros 的模型默认值。等真实任务证明 DSH 带来稳定收益后，再接 ACP 可恢复会话，并把 HarnessRevision 中的项目知识、能力包和 ORBS 工具提供给 DSH。

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
