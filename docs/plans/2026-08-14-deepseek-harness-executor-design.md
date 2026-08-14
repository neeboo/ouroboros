# DeepSeek Harness 执行器接入设计

## 目标

让 Ouroboros 可以像调用 Codex 一样，把某个冻结任务交给 DeepSeek Harness（DSH）执行，同时继续由 Ouroboros 负责设计、权威门、任务图、资源约束、验证、修复和结果沉淀。

第一阶段只增加一种可选执行器，不改变现有默认路线。所有角色继续默认使用 `codex-resumable`；任务只有显式选择 `dsh-cli` 时才交给 DSH。

## 为什么先接命令行

DSH 当前提供三种可利用的接入面：

1. `dsh --profile headless`：一次任务、一次结果，边界最小，适合先验证真实工程能力。
2. DSH ACP：支持会话和取消，更适合后续做可恢复执行，但当前需要额外适配和配置。
3. 直接嵌入 DSH SDK：控制力最强，也会把两套运行时耦合起来，首版收益不足以覆盖复杂度。

第一阶段采用命令行适配。Ouroboros 保持环境和控制面，DSH 只是一个可替换的执行后端。第二阶段在有真实收益证据后再接 ACP。

## 第一阶段架构

新增后端类型 `dsh-cli`：

```toml
[agentDefaults.roles]
worker = "deepseek-harness"

[agentBackends.deepseek-harness]
kind = "dsh-cli"
command = "dsh"
profile = "headless"
```

执行链保持简单：

```text
冻结任务合同
  -> Ouroboros 选择 dsh-cli
  -> 在任务工作树中运行 dsh --profile headless <prompt>
  -> DSH 返回结构化 AttemptOutput
  -> Ouroboros 持久化证据并进入 Verifier
```

### 后端合同

- `profile` 首版只接受 `headless`。
- `command` 是单个可执行文件路径，不经过 shell。
- DSH 的模型选择由其 profile 管理，Ouroboros 不向它伪造 Codex 模型参数。
- 任务必须在自己的隔离工作树中启动，不能继承主仓库作为当前目录。
- 只允许 `read-only` 和 `workspace-write`；`danger-full-access` 失败关闭。
- 首版不接受 `hostExecutionCapabilities`。等 DSH 能执行同等权限合同时再开放。
- prompt 既受 Ouroboros 总长度门禁约束，也受更小的命令行参数上限约束。
- stdout 必须能解析为 Ouroboros 的 `AttemptOutput`；普通文本或畸形 JSON 记为阻断，不能冒充完成。
- stderr、异常和事件全部走现有有界诊断与凭据脱敏。

### 权限与环境

Ouroboros 把冻结沙箱等级映射为 `DSH_PERMISSION_MODE`，并以环境白名单方式传入显式配置。第一阶段不依赖 DSH 替 Ouroboros执行浏览器、数据库、远端 Git 或 Linear 能力；这些仍由现有宿主能力合同管理。

### 审计

每次执行至少记录：

- 后端 id 和类型；
- DSH profile；
- 工作树路径；
- prompt 字符数和摘要；
- 退出码、耗时和结构化结果；
- 有界错误证据。

事件不记录环境变量值、完整 prompt 或认证材料。

## 第二阶段

只有第一阶段出现稳定收益后才实现 `dsh-resumable`：

- 通过 ACP 建立、恢复和取消 DSH 会话；
- 把 DSH session id 写入 attempt 证明；
- 把 HarnessRevision 中的项目知识、Skill 和 ORBS 系统能力暴露为 DSH 可调用资源；
- 用同一任务在 Codex 与 DSH 上做有预算的对照验证，沉淀各自擅长的问题类型。

## 验收标准

第一阶段完成必须同时满足：

1. `dsh-cli` 可通过内置 id 或命名后端选择。
2. DSH 在精确任务工作树中运行。
3. 合法结构化结果能进入现有验证链。
4. 畸形输出、超长输入、缺少二进制、危险权限和宿主能力请求全部在模型执行前或结果入库前失败关闭。
5. Codex、ACPX、noop 现有路线无回归。
6. 完整测试、类型检查和差异检查通过。

