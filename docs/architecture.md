# eval-platform 架构方案

## 目标

`eval-platform` 是独立项目，负责把数据和 Agent Harness 解耦，并围绕 Agent 产物完成评估。SP 只是第一方 Harness，不是评估平台的父项目。

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
```

四个顶层包内部再按职责提供子模块：

```text
eval-dataset: dataset/
eval-runtime: config/ harness/ runtime/
eval-metrics: evaluators/ aggregation/ reporting/
```

`@eval-platform/eval-runtime` 拥有评估流程的控制面和 SP Harness 边界，但不复制 SP Runtime 的执行内核。`SpHarnessConfig.kind: "sp"` 表示统一云端宿主，必填的 `framework: "sp" | "codex" | "cc"` 表示执行框架；三者复用同一套 Chat/Submission/Workspace 生命周期，不在 eval 内创建 CLI 或进程启动器。ExecutionConfig 选择 Subject 框架和 SP 管理的 Agent Config；EvaluationConfig 固定 SP 框架并选择评估 Agent Config。框架进入配置快照、请求幂等指纹和 Agent 创建事实，SP 实际的 Codex/CC 云端部署由 SP 负责。

运行配置由 `eval-runtime/config` 统一管理：`ExecutionConfig` 绑定 Dataset、可选 Sample 子集、Sampling 次数和 Subject 执行策略；`EvaluationConfig` 绑定评估 Agent 和评估策略；`PipelineConfig` 只组合前两者。配置创建时由代码生成唯一 `configId`，运行请求只引用配置 ID，不重复传递 Harness、并发、重试或 Dataset 字段。Runtime 通过 `ConfigResolver` 读取、校验和归一化配置，补齐默认重试策略并生成独立的有效配置对象后，才创建 Run；Run 原子保存本次生效配置快照，不引入 version。

以下包明确不单独创建：

- `eval-config`：配置属于 `eval-runtime/config` 子模块；
- `eval-evaluators`：评估器属于 `eval-metrics/evaluators` 子模块；
- `eval-sp-adapter`：SP 边界直接属于 runtime 的 Harness seam；
- `eval-process-adapter`：CC、Codex 等未来统一经过 Cloudflare Agent，不提前引入进程层；
- `eval-storage`：Agent 项目素材由对应 Harness 的 Workspace 持有，评估运行记录的持久化由未来应用层决定；
- `eval-agent-tools`：评估 Agent 工具属于 SP Agent Config 和 Runtime 能力，不在评估包内重建；
- 独立轨迹树或线上流量评估包：轨迹从 SP 正式接口获取，线上评估不属于当前核心范围。

`eval-contracts` 只定义评估域的稳定契约，不复制 SP 的 Agent、Submission 或 Trajectory 内部实现；SP 公共契约在 Harness 边界消费。`eval-metrics` 负责已有评估结果整理、资源统计、聚合和四层查询。证据与解释由评估 Agent 输出，不引入独立归因流程。

## 核心实体

```text
Project
└── Data
    └── Sample
        └── Sampling
            └── execution attempts / artifacts / trajectory

EvaluationRecord
├── evaluationId
├── samplingId
├── evaluator / submissionId
├── evaluation attempts
├── status
└── evaluation output
```

- `Project` 属于用户；
- `Dataset` 是可复用的数据组织，不挂在用户下；
- `Data` 可以被多个 Dataset 引用；
- `Data.userPrompt` 是必填的当前任务，其余 JSON 业务字段自由提供并完整保留；`initialSession` 与 `initialMaterials` 都可选，引用内的 Bundle ID 和资源 ID 必须由外部提供；
- `initialSession` 只引用独立保存的初始化 Session，启动时由 Harness 复制到目标 DO 并交给所选框架加载、重建 Context；准备完成后发送原始 `userPrompt`；
- `Sample` 是运行时生成的一次具体测试输入，结构为 `{ sampleId, data: Data }`；外层是平台身份，Data 内任意同名业务字段完整保留，Sampling 不重复持久化 Data；
- `Sampling` 是一次独立运行，拥有自己的 Subject Chat / Workspace；
- 评估使用独立 Evaluation Chat / Workspace，但不改变 `Sampling` 身份；每次评估产生独立 `EvaluationRecord`。

## SP Harness 对齐

Harness 只依赖以下正式边界：

1. Agent Config 引用：`ownerUserId`、`userAgentId`；
2. Chat 创建：`Inbox.createChat(title, userAgentId, chatId?)`；
3. 消息投递：`dispatchMessage(message, "enqueue" | "steer")`；
4. Submission 终态推送：Harness 接收可靠的完成/失败/取消通知；`SubmissionReceipt` 和按幂等键的操作查询只用于提交后的初始确认、断线恢复和重试前校准；
5. Trajectory：`TrajectoryPage`，按 `beforeSeq` 分页读取完整轨迹，单页不超过 `200`；
6. Workspace：tree、manifest 和 content 的正式接口。

评估输入复制流程必须是：

```text
Subject Chat / Workspace
          │
          ├── Submission 终态事件 ──推送──→ Runtime
          │                                  │
          ├── Workspace 产物 ────────────────┤
          └── 完整 Trajectory ───────────────┘
                                             ↓ 复制
                           Evaluation Chat / Workspace 初始素材
                                             ↓
                                      Evaluation Agent
```

复制逻辑应记录来源 `submissionId`、目标 `submissionId`、内容 hash 和复制清单，并保持幂等。生产阶段需要为目标 Workspace 选择 SP 正式写入边界，不能绕过 Workspace 直接操作 DO 存储。

## 生命周期语义

- `start()` 只创建并运行 Subject Sampling；
- `evaluate()` 只消费已有 `Sampling` 的成功执行结果；
- `pipeline()` 只是两个阶段的编排，不是第三种执行模型；
- `samplingCount` 创建多个 Sampling；
- `executionConcurrency` 是执行阶段同时启动的最大 DO 数量，一个 Subject Agent 对应一个 DO；
- `evaluationConcurrency` 是评估阶段同时启动的最大 DO 数量，一个 Evaluation Agent 对应一个 DO；
- 正常完成路径由 Submission 终态推送驱动；
- 推送丢失、连接断开或运行时恢复时，有限次调用 `getSubmission()` 做校准；
- 网络、LLM、网站等临时故障先查询原 Submission，再决定是否重启同一个 Chat / Workspace；
- 手动取消、鉴权失败、配置错误不自动重启；
- 每次执行和评估都完整收集对应 Agent 的产物与轨迹，并将 Subject 的两者复制到 Evaluation Workspace；结果评估以 Subject 产物为主，轨迹作为补充证据。

## 接入真实环境前的剩余事项

1. 共享或发布 SP Agent Contracts，让评估平台直接消费 SP 的公开类型；
2. 确认 SP 侧复制 Workspace 到另一个 Chat / Workspace 的正式写入接口；
3. 确认评估运行记录由哪个应用层存储承载；
4. 为 `RuntimeStore` 和 `MetricsSource` 接入应用层真实持久化/只读投影实现；Metric 的统计与四层查询不依赖这些适配器的部署。
5. SP 的公开 Agent 创建边界需支持 `framework` 选择和绑定，并实际提供 Codex/CC 云端运行；评估侧只传递选择，不重建这些启动器。
