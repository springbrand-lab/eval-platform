# eval-platform

`eval-platform` 是独立的内部评估平台。它负责编排数据、被评估 Agent、评估 Agent 和评估结果，不把评估逻辑放回 `sp-platform`。

当前阶段已完成包边界、公共契约、Dataset 管理、Runtime 编排、Metrics 四层查询，以及 `eval-api` 中的 PostgreSQL 持久化、Hono HTTP 控制面和基于 pg-boss、可多实例部署的 Run Worker。Web、CLI 仍是骨架；独立 SP 部署的真实端到端联调尚未完成。

已确定的部署目标是从固定 SP 分支的一次构建中独立发布 Eval SP API/数据库、Agent Worker、Space Worker、DO 命名空间和 R2；Eval 的登录、Agent Config 和全部 Agent 运行接口只指向这套 SP。Eval 业务事实仍在自己的 PostgreSQL 中。详见[独立 SP 部署方案](docs/eval-sp-deployment.md)和[SP 接口需求](docs/sp-eval-api-requirements.md)。

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

`@eval-platform/eval-runtime` 已把 SP 作为第一方 Harness 契约，通过公开的 Chat、Submission、Trajectory 和 Workspace 边界编排 Agent；`eval-api` 提供实际 HTTP/WebSocket 客户端和启动入口，仍需真实部署联调。`eval-metrics` 读取 Dataset/Runtime 的原始事实，提供执行/评估分开的资源统计与 Project、Dataset、Sample、Sampling 查询。

运行方案由 `eval-runtime/config` 管理：ExecutionConfig 绑定 Dataset、Sampling 次数和 Subject Agent，EvaluationConfig 绑定评估 Agent，PipelineConfig 组合两者。配置 ID 由代码生成；Runtime 启动请求只引用配置 ID，不重复传递 Dataset、Harness、并发或重试字段。

`eval-metrics` 已实现状态、分数、Agent 耗时、费用、Token、模型请求、Turn、工具调用统计和四层展示模型。`eval-api` 实现了真实 `DatasetStore`、`RuntimeStore`、只读 `MetricsSource` 和 HTTP 控制面，从 PostgreSQL 原始事实一致性投影，不新增指标数据库或访问 SP 私有存储；实验对比、Web 和 CLI 后续实现。

## 运行层次

```text
Project ──> Run ──> Sampling ──> Subject Chat / Workspace
                    Sampling ──> EvaluationRecord ──> Evaluator Chat
Dataset ──> Data ──> Sample ──(输入引用)──> Sampling
```

每个 Sampling 是一次独立运行，完整收集 Subject 产物与轨迹（产物为主，轨迹为补充证据）；实体定义见[核心实体](docs/architecture.md#核心实体)，并发、重试与证据语义见[生命周期语义](docs/architecture.md#生命周期语义)。

## SP 对齐边界

实现阶段只能依赖 SP 的公开契约和正式接口：

- Eval SP `user-agent` 库中的 `ownerUserId`、`userAgentId` Agent Config 引用；
- Eval SP 普通 `Inbox.createChat(title, userAgentId, chatId?)`；
- `dispatchMessage(message, "enqueue" | "steer")`；
- Submission 终态推送；`SubmissionReceipt` 和 `getSubmission(submissionId)` 作为校准与恢复边界；
- `TrajectoryPage` 分页读取，单页上限遵循 SP 的 `200`；
- Workspace tree、manifest 和 content 读取边界。

Runtime 预分配并保存 Subject/Evaluator 的 Chat ID；SP Chat 即持久 Session，每次提交返回的真实 Submission ID 保存在相应 Attempt。Eval 侧 SP Harness 已实现；真实环境中的生命周期仍需联调验证。

Submission 的正常完成路径采用终态推送；`getSubmission(submissionId)` 只用于初始确认、断线恢复、超时校准和重试前确认，不做持续轮询。

禁止导入 `sp-platform/agent/src/*` 私有实现、直接读取 Durable Object 内部存储或复制 SP Runtime 内核。

## 包依赖方向

```text
eval-contracts → eval-dataset → eval-runtime → eval-metrics
                        ↓             ↓             ↓
                       eval-api / eval-web / eval-cli
```

`eval-runtime` 消费 `eval-dataset`，并将每个 `Sampling` 的执行产物、完整轨迹和评估输出交给 `eval-metrics`；应用层只消费四个顶层包的公共入口。Harness 契约属于 `eval-runtime`，具体 Eval SP HTTP/WebSocket 接线由 `eval-api` 组合，不新增 `eval-sp-adapter`。CC、Codex 等框架通过 SP Harness 的 `framework` 选择接入，进程细节不进入评估核心。

## 开发基线

- Node.js `>=24`
- pnpm `11.6.0`
- TypeScript `7.x`
- ESM + Bundler module resolution

工程约定与 `sp-platform` 对齐：每个 workspace 都有独立的 package metadata、TypeScript 配置、README 和 Vitest 入口；共享包提供 `src/index.ts` 公共入口，应用只提供进程入口，并额外拥有自己的 `CONTEXT.md`。`eval-api` 使用注入的 `pg` 连接池、Drizzle 和独立迁移；不复制 SP 私有数据库客户端或 Agent 内核。Eval 发布流程从固定 SP 源码部署独立的 SP 运行环境，Eval 代码不导入其私有源文件。可使用 `DATABASE_URL` 运行数据库集成测试。

本地安装与联调要求 sp-platform 检出在本仓库的同级目录 `../sp-platform` 并已执行 `pnpm install`：`@springbrand/eval-harness`、`@springbrand/utils` 当前以 `link:` 依赖其工作区包，发布计划见 [SP 共享包发布待办](docs/sp-package-publishing-todo.md)。

接入真实环境前，还需要部署独立的 Eval SP 与 Eval API/Worker，配置各服务地址、数据库和 Bundle 目录（进程与环境变量见 [eval-api README](apps/eval-api/README.md)），并验证登录、Agent 初始化、执行、评估、证据和指标的完整链路。Project 分支绑定与 Run commit 来源记录已在类型和数据库中实现。

## CI

GitHub Actions 会先根据 Git 变更和 workspace 依赖图计算受影响项目，再并行检查和测试受影响的 shared packages 与应用。根配置、锁文件、CI 配置或受影响项目检测逻辑变化会触发完整测试；不涉及 workspace 的仓库级文档变更不会启动包测试。
