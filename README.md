# eval-platform

`eval-platform` 是独立的内部评估平台。它负责编排数据、被评估 Agent、评估 Agent 和评估结果，不把评估逻辑放回 `sp-platform`。

当前阶段已完成包边界、公共契约、`eval-dataset` 的数据管理、`eval-runtime` 的核心编排和 `eval-metrics` 的统计与四层查询实现；API、Web、CLI 和真实持久化/查询投影仍由应用层接入。

## 当前包与应用骨架

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

四个目录是顶层 workspace package，包内再按职责提供子模块：

```text
eval-dataset/
└── dataset/

eval-runtime/
├── config/
├── harness/
└── runtime/

eval-metrics/
├── evaluators/
├── aggregation/
└── reporting/
```

`@eval-platform/eval-runtime` 已把 SP 作为第一方 Harness，通过公开的 Chat、Submission、Trajectory 和 Workspace 边界驱动 Agent；`eval-metrics` 读取 Dataset/Runtime 的原始事实，提供执行/评估分开的资源统计与 Project、Dataset、Sample、Sampling 查询。

运行方案由 `eval-runtime/config` 管理：ExecutionConfig 绑定 Dataset、Sampling 次数和 Subject Agent，EvaluationConfig 绑定评估 Agent，PipelineConfig 组合两者。配置 ID 由代码生成；Runtime 启动请求只引用配置 ID，不重复传递 Dataset、Harness、并发或重试字段。

`eval-metrics` 已实现状态、分数、Agent 耗时、费用、Token、模型请求、Turn、工具调用统计和四层展示模型。应用层通过只读 `MetricsSource` 提供一致的原始数据投影，不新增指标数据库或访问 SP 私有存储；实验对比与 API/Web/CLI 后续实现。

## 运行层次

```text
Project
└── Data
    └── Sample
        └── Sampling
            ├── Subject Chat / Workspace
            └── Evaluation Chat / Workspace
```

- `samplingCount` 创建多个独立 `Sampling`，不是一次执行的重试次数。
- `executionConcurrency` 是执行阶段同时启动的最大 DO 数量，一个 Subject Agent 对应一个 DO。
- `evaluationConcurrency` 是评估阶段同时启动的最大 DO 数量，一个 Evaluation Agent 对应一个 DO。
- 网络、模型或网站临时故障重试同一个 `Sampling`，不创建新的采样。
- 每次执行都完整收集 Subject 产物和轨迹，并完整复制给评估 Agent；评估以产物为主，轨迹作为补充证据。
- 每条 `Data` 必须提供 `userPrompt`，可以附带任意其他 JSON 业务字段；`initialSession` 与 `initialMaterials` 都可选，正文独立保存，启动时由 SP 初始化能力恢复 Context。

## SP 对齐边界

实现阶段只能依赖 SP 的公开契约和正式接口：

- `ownerUserId`、`userAgentId` Agent Config 引用；
- `Inbox.createChat(title, userAgentId, chatId?)`；
- `dispatchMessage(message, "enqueue" | "steer")`；
- Submission 终态推送；`SubmissionReceipt` 和 `getSubmission(submissionId)` 作为校准与恢复边界；
- `TrajectoryPage` 分页读取，单页上限遵循 SP 的 `200`；
- Workspace tree、manifest 和 content 读取边界。

Eval 只记录一个 `submissionId` 作为 SP Chat/Submission 标识，不重复记录 `chatId`。

Submission 的正常完成路径采用终态推送；`getSubmission(submissionId)` 只用于初始确认、断线恢复、超时校准和重试前确认，不做持续轮询。

禁止导入 `sp-platform/agent/src/*` 私有实现、直接读取 Durable Object 内部存储或复制 SP Runtime 内核。

## 包依赖方向

```text
eval-contracts → eval-dataset → eval-runtime → eval-metrics
                        ↓             ↓             ↓
                       eval-api / eval-web / eval-cli
```

`eval-runtime` 消费 `eval-dataset`，并将每个 `Sampling` 的执行产物、完整轨迹和评估输出交给 `eval-metrics`；应用层只消费四个顶层包的公共入口。SP Harness 直接收敛在 `eval-runtime`，不新增 `eval-sp-adapter`。CC、Codex 等进程细节也不进入评估核心；未来需要时再通过统一远程 Harness 接入。

## 开发基线

- Node.js `>=24`
- pnpm `11.6.0`
- TypeScript `7.x`
- ESM + Bundler module resolution

工程约定与 `sp-platform` 对齐：每个 workspace 都有独立的 package metadata、TypeScript 配置、README、公共入口和 Vitest 入口；应用额外拥有自己的 `CONTEXT.md`。目前没有复制 SP 的 Cloudflare 部署、数据库或私有 Agent 实现。

接入真实环境前，还需要确定 `@springbrand/agent-contracts` 的共享或发布方式、SP 侧把 Subject Workspace 复制到 Evaluation Workspace 的正式写入边界，以及 `RuntimeStore` 的 API/DO/数据库实现。

## CI

GitHub Actions 会先根据 Git 变更和 workspace 依赖图计算受影响项目，再并行检查和测试受影响的 shared packages 与应用。根配置、锁文件、CI 配置或受影响项目检测逻辑变化会触发完整测试；不涉及 workspace 的仓库级文档变更不会启动包测试。
