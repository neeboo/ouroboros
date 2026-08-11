# Continual Harness v1 设计

## 为什么先做这一层

Ouroboros 已经能发现问题、提出设计、创建交付运行、验证代码并更新自身进程代际。但一次成功经验目前主要留在提交、lesson、experience 或提示文字里。下一轮是否真的加载了新的知识、Skill、工具策略和提示版本，还缺少一份统一、可回读的证据。

Continual Harness v1 补上这个继承点：每个项目拥有一个版本化 Harness。新一轮开始时冻结当前版本，运行结束后可以提出候选版本；候选经过验证和授权后成为下一代。后续运行必须证明自己实际加载了这一代。

## 最小递归

```text
真实运行
  -> 经验与缺口
  -> HarnessVariant 候选
  -> 验证与授权
  -> activateHarnessRevision
  -> 下一轮冻结并加载
  -> 新的真实运行
```

本阶段只实现“候选如何被激活、下一轮如何继承、如何证明加载”。复杂的自动学习、动态资源预测和多项目市场暂不进入 v1。

## HarnessRevisionV1

`HarnessRevisionV1` 是轻量、内容寻址的版本清单，不新建数据库表：

```ts
interface HarnessRevisionV1 {
  schemaVersion: 1;
  projectId: string;
  version: number;
  parentSha256: string | null;
  variant: {
    id: string;
    recordSha256: string;
    contentSha256: string;
  };
  components: Array<{
    kind: "prompt" | "knowledge" | "skills" | "tools" | "agent-policy";
    ref: string;
    sha256: string;
  }>;
  evidenceRefs: string[];
  contentSha256: string;
}
```

五类组件各出现一次，按固定顺序规范化。正文不进入 run context；`ref + sha256` 可以指向仓库清单、MCP 资源或内容寻址快照。`contentSha256` 对除自身外的规范 JSON 计算。

现有不可变 `HarnessVariant` 继续表示候选。`HarnessRevision` 表示候选已经被激活并成为项目可继承的一代。它与 `controlPlaneRuntime.generation` 保持独立：前者描述项目采用的能力清单，后者只描述守护进程、代码 HEAD 和运行时交接。

## 激活、冻结与使用证据

新增固定动作 `activateHarnessRevision`。动作验证项目、候选 variant、父版本、版本递增、内容哈希以及授权和验证证据。成功后将完整清单写入长期根运行的 `context.activeHarnessRevision`，同时记录审计事件。相同请求顺序重试返回 reused；父版本、版本号或哈希冲突失败关闭。

创建新一轮时，控制面把 active 版本复制到 `run.context.harnessRevision`。运行开始后该字段不可被通用 context 更新或合同修订覆盖。设计产生的子运行继续复制同一版本，并对重放漂移失败关闭。

Runner 启动 agent 前校验清单与组件摘要，把 `harnessRevision` 和 `loadedHarnessComponents` 写入 attempt input。任务提示只展示版本、总摘要以及五项组件的 ref/sha，不注入大段正文。

一个版本真正被下一代采用，需要三方一致：激活动作回执、child run context、attempt input 加载回执。组件缺失、哈希不符或来源不可读取时，在 agent 启动前阻断。

## 项目知识与 ORBS 能力

五类组件同时覆盖两层内容：

- `knowledge` 保存项目领域知识清单，例如 Hodor 的影视生产规范；
- `skills`、`tools` 和 `agent-policy` 保存 ORBS 系统能力与使用边界；
- `prompt` 连接本轮目标、领域语义和系统能力。

v1 不新建知识库或 Skill 仓库。清单引用现有文件或资源。后续可以把同样的 ref 接到 ORBS MCP，但 Harness 继承合同无需因此变化。

## ResourceAllocator v0

资源分配在 Harness 继承闭环完成后接入。v0 只处理已经通过 authority gate 且已经形成交付运行的候选：价值和信息增益形成简单分数；同项目只选一项；同分时优先更短的时间申请，最后按 proposal ID 排序。

资源申请由现有 `createRunsFromDesign` 动作冻结到 child run context，并沿用它的审计记录。Supervisor 用它限制任务并发和单次执行时长。它不决定权限、不绕过成本审批，也不动态切换模型。首版不做抢占、金额账本、多项目公平性、权重学习或复杂优化。

## 人类审批

Dashboard 不参与审批正确性。需要人批准的 Harness 变化由 ORBS 创建唯一 Linear issue，人用带 approval ID 和摘要哈希的结构化评论批准或拒绝。ORBS 独立回读作者、内容和当前 issue 状态，再把核验后的决定写入本地回执。

零成本、可回滚、不新增权限和外部副作用的变化可以继续走自动 authority gate。新增权限、付费投入、跨项目能力和真实外部副作用必须等待 Linear 人工批准。

## 本阶段边界

- 不新增数据库表和依赖。
- 不实现通用任意 MCP 写入口。
- 不把知识正文或秘密写进 prompt、run context 或审计事件。
- 不让运行中的 run 切换 HarnessRevision。
- 不让 outcome-review 直接激活候选。
- 不依赖 Dashboard 完成任何状态转换。
