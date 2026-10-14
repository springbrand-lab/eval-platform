# eval-platform 架构方案

## 目标

`eval-platform` 是独立项目，负责把数据和 Agent Harness 解耦，并围绕 Agent 产物完成评估。SP 只是第一方 Harness，不是评估平台的父项目。

## 已确定的部署模式

Eval 的一次发布流程从固定的 SP Git 分支解析出 commit，独立发布一套 Eval SP：SP API 及其数据库、Agent Worker、Space Worker、专用 DO 命名空间和 R2。Eval SP Agent 的 `API_ORIGIN` 指向 Eval SP API；Eval 的登录、Agent Config、Chat、Submission、Workspace、轨迹、计费和 Action 接入也全部指向 Eval SP，不依赖 dev/production SP 服务。Eval API、单实例 Run Worker、Web 随同一发布流程上线。完整数据归属与发布约束见 [Eval 独立 SP 部署方案](eval-sp-deployment.md)。

Agent Config 使用 Eval SP 自己的 `user-agent` 库，Eval 不再建一份配置库，也不在线读取 dev/production 的配置。Git 分支绑定 Project；固定分支阶段只能选择已部署的分支。Run 记录实际 SP commit 作为代码来源，Sampling 不存分支；更新 SP 代码不重建 Eval SP 数据库或 Eval PostgreSQL。

## 第一阶段包边界

当前包边界保持四个 workspace；`eval-runtime` 已开始实现运行编排，其他包继续作为稳定契约和结果层基础：

```text
packages/
├── eval-contracts/
├── eval-dataset/
├── eval-runtime/
└── eval-metrics/

apps/
├── eval-api/
├── eval-web/
└── eval-cli/

deploy/  # 计划增加：固定 SP 源码与编排 Eval 发布；不是 workspace 包
```

四个顶层包内部再按职责提供子模块：

```text
eval-dataset: dataset/
eval-runtime: config/ harness/ runtime/
eval-metrics: evaluators/ aggregation/ reporting/
```

`@eval-platform/eval-runtime` 拥有评估流程的控制面和 SP Harness 边界，但不复制 SP Runtime 的执行内核。`SpHarnessConfig.kind: "sp"` 表示统一云端宿主，必填的 `framework: "sp" | "codex" | "cc"` 表示执行框架；三者复用同一套 Chat/Submission/Workspace 生命周期，不在 eval 内创建 CLI 或进程启动器。ExecutionConfig 选择 Subject 框架和 Eval SP 管理的 Agent Config；EvaluationConfig 固定 SP 框架并选择评估 Agent Config。框架进入配置快照、请求幂等指纹和 Agent 创建事实，SP 实际的 Codex/CC 云端部署由 SP 负责。

运行配置由 `eval-runtime/config` 统一管理：`ExecutionConfig` 绑定 Dataset、可选 Sample 子集、Sampling 次数和 Subject 执行策略；`EvaluationConfig` 绑定评估 Agent 和评估策略；`PipelineConfig` 只组合前两者。配置创建时由代码生成唯一 `configId`，运行请求只引用配置 ID，不重复传递 Harness、并发、重试或 Dataset 字段。Runtime 通过 `ConfigResolver` 读取、校验和归一化配置，补齐默认重试策略并生成独立的有效配置对象后，才创建 Run；Run 原子保存本次生效配置快照，不引入 version。

以下包明确不单独创建：

- `eval-config`：配置属于 `eval-runtime/config` 子模块；
- `eval-evaluators`：评估器属于 `eval-metrics/evaluators` 子模块；
- `eval-sp-adapter`：SP 边界直接属于 runtime 的 Harness seam；
- `eval-process-adapter`：CC、Codex 等未来统一经过 Cloudflare Agent，不提前引入进程层；
- `eval-storage`：Agent 项目素材由对应 Harness 的 Workspace 持有，评估运行记录由 `eval-api` 的 PostgreSQL 适配器持久化，不单独拆包；
- `eval-agent-tools`：评估 Agent 工具属于 SP Agent Config 和 Runtime 能力，不在评估包内重建；
- 独立轨迹树或线上流量评估包：轨迹从 SP 正式接口获取，线上评估不属于当前核心范围。

`eval-contracts` 只定义评估域的稳定契约，不复制 SP 的 Agent、Submission 或 Trajectory 内部实现；SP 公共契约在 Harness 边界消费。`eval-metrics` 负责已有评估结果整理、资源统计、聚合和四层查询。证据与解释由评估 Agent 输出，不引入独立归因流程。

## Run 准入与独立评估

`start()`、`evaluate()` 和 `pipeline()` 共用 Run 准入规则。请求必须提供在 Project 内唯一的 `idempotencyKey`；请求指纹绑定操作、配置 ID、独立评估时确定且有序的 Sampling ID 列表，以及本次解析出的生效配置。首次准入在同一事务中保存 Run、生效配置快照及关联记录：新执行创建 Sampling，需要评估的 Run 创建 EvaluationRecord；独立评估复用并校验既有 Sampling。PostgreSQL 的 `(project_id, idempotency_key)` 唯一约束保证同一意图只创建一批。相同 key 和事实返回原 Run，不同事实冲突；有意再次执行或重评估使用新 key。已准入后的重放依据原 Run 快照校验，不重新读取已编辑的配置，也不引入单独的配置 version。

同一 Runtime 实例内，待准入的相同 Project/key 请求先比较调用方选择的事实：一致则共用首次提交的 Promise 与配置快照，即使提交期间配置被编辑也只返回同一个 Run；不一致立即冲突。请求结束后清理内存条目；持久化 Store 仍负责最终查重，内存不是权威状态。跨实例的唯一约束仍阻止重复建批，但进程内同步不保证配置同时变更时跨实例调用获得相同响应。

Eval API 的用户范围 Catalog 以同一 Project、可选 Sample 和执行成功状态筛选 Sampling，并提供分页与按 ID 稳定排序的全选查询。控制面接入时把全选得到的固定 ID 列表交给 `evaluate()`，重试沿用原列表与 key，不重新解析动态筛选条件；HTTP 调用尚未接入。选择、提交和错误语义见 [独立评估入口契约](eval-independent-evaluation-entry.md)。

## 核心实体

```text
Project ──> Run ──> Sampling ──> Subject Chat / execution attempts
                    Sampling ──> EvaluationRecord ──> Evaluator Chat / evaluation attempts
Dataset ──> Data ──> Sample ──(输入引用)──> Sampling
```

- `Project` 属于用户并绑定 SP Git 分支；当前固定分支阶段仅能绑定已部署分支，Run 记录实际 commit；
- `Dataset` 属于一个 Eval SP 用户；同一用户的 Data 可在多个 Dataset 和 Project 间复用；
- `Data` 可以被多个 Dataset 引用；
- `Data.userPrompt` 是必填的当前任务，其余 JSON 业务字段自由提供并完整保留；`initialSession` 与 `initialMaterials` 都可选，引用内的 Bundle ID 和资源 ID 必须由外部提供；
- `initialSession` 只引用独立保存的初始化 Session，启动时由 Harness 复制到目标 DO 并交给所选框架加载、重建 Context；准备完成后发送原始 `userPrompt`；
- `Sample` 是运行时生成的一次具体测试输入，结构为 `{ sampleId, data: Data }`；外层是平台身份，Data 内任意同名业务字段完整保留，Sampling 不重复持久化 Data；
- `Sampling` 是一次独立运行，拥有自己的 Subject Chat / Workspace；
- 评估使用独立 Evaluation Chat / Session，但 Workspace 绑定 Subject Chat 的同一个物理 SpaceDO；每次评估产生独立 `EvaluationRecord`，材料和结果写入自己的 `/evaluations/<evaluationId>/` 目录。

## SP Harness 对齐

Harness 只依赖以下正式边界：

SP Chat 是持久 Session：Sampling/EvaluationRecord 保存各自 Chat ID；每次 Prompt 提交在该 Chat 中创建一个 Submission，真实 Submission ID 由对应 Attempt 保存。自动重试沿用 Chat，而新提交拥有自己的 Submission 身份。

1. Agent Config 引用：`ownerUserId`、`userAgentId`；
2. Eval SP 的普通 Inbox/Chat 创建：Subject 和 Evaluator 都进入 **Eval SP 自己的** Inbox，不进入 dev/production 的 Inbox；Eval 预分配 Chat ID 并要求同 ID 幂等。Evaluator 创建时携带 Subject 的 `{userId, chatId}` Workspace 引用和 `evaluationId`；
3. 消息投递：`dispatchMessage(message, "enqueue" | "steer")`；
4. Submission 终态推送：Harness 接收可靠的完成/失败/取消通知；`SubmissionReceipt` 和按幂等键的操作查询只用于提交后的初始确认、断线恢复和重试前校准；
5. Trajectory：`TrajectoryPage`，按 `beforeSeq` 分页读取完整轨迹，单页不超过 `200`；
6. Workspace：tree、manifest 和 content 的正式接口。

评估输入准备流程是：

```text
Subject Chat ──完整 Trajectory──→ SP 物化接口
     │                              │
     └── Workspace 产物 ────────────┴──→ Subject SpaceDO
                                         ↑        ↑
                                 Subject Chat  Evaluator Chat
                                               （仅写评估目录）
```

SP 根据执行 Chat 的 `{userId, chatId}` 定位同一 SpaceDO，按 Subject Chat 幂等物化完整轨迹；Subject 产物留在原处，不复制。Evaluator 有独立的 Chat、Submission 和轨迹，写权限限定在本次评估目录。Eval 不绕过 SP 的公开 Workspace/Trajectory 边界操作 DO。

## 生命周期语义

- `start()`、`evaluate()`、`pipeline()` 只原子提交对应 Run 和关联记录，随后返回；
- 单实例执行器按通知和恢复扫描调用 `resume(runId)`；`pipeline` 只顺序编排执行和评估，不是第三种阶段；
- 恢复从已保存的 Run 配置和 Attempt 幂等键继续，Agent 已完成时只补收集与保存；
- `samplingCount` 创建多个 Sampling；
- `executionConcurrency` 是执行阶段同时启动的最大 DO 数量，一个 Subject Agent 对应一个 DO；
- `evaluationConcurrency` 是评估阶段同时启动的最大 DO 数量，一个 Evaluation Agent 对应一个 DO；
- 正常完成路径由 Submission 终态推送驱动；
- 推送丢失、连接断开或运行时恢复时，有限次调用 `getSubmission()` 做校准；
- 网络、LLM、网站等临时故障先查询原 Submission，再决定是否重启同一个 Chat / Workspace；
- 手动取消、鉴权失败、配置错误不自动重启；
- 每次执行和评估都完整收集对应 Agent 的产物与轨迹；SP 把完整 Subject 轨迹物化到原 SpaceDO，评估直接读取留在原处的 Subject 产物；结果评估以产物为主，轨迹作为补充证据。

## 接入真实环境前的剩余事项

1. 给 SP API、Agent、Space 配置 Eval 独立发布目标和持久资源；Eval 的全部 SP 地址指向这套部署，登录与 Agent Config 由 Eval SP 提供；
2. 共享或发布 SP Agent Contracts，让评估平台直接消费 SP 的公开类型；
3. SP 在普通 Inbox/Chat 生命周期中支持 Evaluator 绑定 Subject SpaceDO、评估目录写入约束，以及按执行 Chat ID 物化完整轨迹；还需提供提交恢复、长连接终态、无人值守处理、原始资源读取和只读观察能力，详见[接口需求](sp-eval-api-requirements.md)；
4. 把现有 `eval-api` PostgreSQL 迁移与存储适配器部署到目标环境，并补齐 Project 分支/Run commit 记录、Config 持久化、鉴权、HTTP 控制面和真实 SP Harness；
5. SP 的公开 Agent 创建边界需支持 `framework` 选择和绑定，并实际提供 Codex/CC 云端运行；评估侧只传递选择，不重建这些启动器。
