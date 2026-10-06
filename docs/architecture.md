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
eval-metrics: evaluators/ attribution/ aggregation/ reporting/
```

`@eval-platform/eval-runtime` 拥有评估流程的控制面和 SP Harness 边界，但不复制 SP Runtime 的执行内核。每个启动请求显式携带 `HarnessConfig`；SP 只通过 `SpHarnessConfig` 作为第一方实现出现。

以下包明确不单独创建：

- `eval-config`：配置属于 `eval-runtime/config` 子模块；
- `eval-evaluators`：评估器属于 `eval-metrics/evaluators` 子模块；
- `eval-attribution`：归因属于 `eval-metrics/attribution` 子模块；
- `eval-sp-adapter`：SP 边界直接属于 runtime 的 Harness seam；
- `eval-process-adapter`：CC、Codex 等未来统一经过 Cloudflare Agent，不提前引入进程层；
- `eval-storage`：Agent 项目素材由对应 Harness 的 Workspace 持有，评估运行记录的持久化由未来应用层决定；
- `eval-agent-tools`：评估 Agent 工具属于 SP Agent Config 和 Runtime 能力，不在评估包内重建；
- 独立轨迹树或线上流量评估包：轨迹从 SP 正式接口获取，线上评估不属于当前核心范围。

`eval-contracts` 只定义评估域的稳定契约，不复制 SP 的 Agent、Submission 或 Trajectory 内部实现；SP 公共契约在 Harness 边界消费。`eval-metrics` 负责评估结果的标准化、归因、聚合和报告模型。

## 核心实体

```text
Project
└── Data
    └── Sample
        └── Sampling
            ├── execution attempts / artifacts / trajectory
            └── evaluation attempts / evaluation output
```

- `Project` 属于用户；
- `Dataset` 是可复用的数据组织，不挂在用户下；
- `Data` 可以被多个 Dataset 引用；
- `Data` 内容由 `json`、`initialContext` 和 `initialMaterials` 三部分组成；
- `Sample` 是运行时生成的一次具体测试输入；
- `Sampling` 是一次独立运行，拥有自己的 Subject Chat / Workspace；
- 评估使用独立 Evaluation Chat / Workspace，但不改变 `Sampling` 身份。

## SP Harness 对齐

Harness 只依赖以下正式边界：

1. Agent Config 引用：`ownerUserId`、`userAgentId`；
2. Chat 创建：`Inbox.createChat(title, userAgentId, chatId?)`；
3. 消息投递：`dispatchMessage(message, "enqueue" | "steer")`；
4. Submission 终态推送：Harness 接收可靠的完成/失败/取消通知；`SubmissionReceipt`、`getSubmission()` 只用于提交后的初始确认、断线恢复和重试前校准；
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
4. 为 `RuntimeStore` 接入 API/DO/数据库实现；再继续实现 Evaluator 结果解析和 metrics 聚合。
