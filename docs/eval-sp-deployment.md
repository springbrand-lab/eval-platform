# Eval 独立 SP 部署方案

> 已确定的目标架构；Eval 侧 SP Harness 已实现，尚未完成部署和真实跨部署联调。当前阶段固定一个 SP Git 分支；运行时不切分支。

## 一次发布的组成

Eval 的发布流水线将选定的 SP 分支解析为确定的 commit，从该源码发布一套 **Eval 专用 SP**：SP API、它自己的数据库、Agent Worker（含 Inbox/Chat/SubAgent/Sandbox）、Space Worker，以及各自需要的 Durable Object 命名空间、R2、路由和服务凭据。随后发布 Eval API、Run Worker 和 Web；Run Worker 可多实例部署和滚动升级，调度方式见[架构方案](architecture.md#run-调度与停止)。这是一次发布流程，包含多个独立服务；不依赖 dev 或 production 的 SP 部署。

Eval SP Agent 的 `API_ORIGIN` 只指向 Eval SP API。Eval API、Run Worker、Web 和 CLI 使用的 SP 登录、Agent Config、Chat、Submission、Trajectory、Workspace、计费和 Action 接口也只指向这套 Eval SP。SP 内部其他服务地址和绑定须同样指向 Eval 环境；不能把运行写入导向 dev 或 production。

```text
SP branch @ commit ──一次发布流程──> Eval SP API + 独立数据库
                                 ├──> Eval SP Space Worker + SpaceDO + R2
                                 └──> Eval SP Agent Worker + Inbox/Chat DO

Eval Web/CLI ──> Eval API ──> Eval SP 的公开 API 与长连接
                       └──> Eval PostgreSQL
```

两个数据库的职责不同：Eval SP 数据库属于 SP 账户和 Agent 运行面；Eval PostgreSQL 属于评估业务。Eval 不直接访问 SP 数据库、DO SQLite 或 R2，只使用 SP 公开的 Chat、Submission、Trajectory、Workspace 等接口。

## 数据归属

| 所属系统 | 长期保存的事实 |
| --- | --- |
| Eval SP | 登录与用户账户、`user-agent` 配置、Inbox/Chat/Session/Submission、完整轨迹、Workspace 及文件、计费结算、Action 执行和 Creation 记录。Agent 与 Space 使用 Eval 专用 DO 命名空间和 R2。 |
| Eval PostgreSQL | Project、Dataset、Data、Sample、执行/评估配置、Run、Sampling、EvaluationRecord、Attempt、指标所需的原始资源快照，以及 SP Chat/Submission/产物/轨迹引用。 |

Eval 的 Agent Config 列表、创建、编辑和运行时解析均使用 **Eval SP 自己的** `user-agent` 库；Eval 使用的固定服务账号也建在 Eval SP 中。切换或更新 SP 源码不重建该数据库，因此不会改变已有用户配置或 Eval 业务记录。不从 dev/production 在线读取、写入或同步账户与配置。已有环境中的配置不会自动出现在 Eval SP；如需复用具体配置，应另行通过公开接口显式导入，然后在 Eval SP 中维护。

## Project、Run 与 Chat

- 分支绑定在 **Project**：固定分支阶段，Project 只能绑定当前部署的 SP 分支。每次 Run 记录发布时实际使用的 SP commit，作为执行或评估的代码来源；Sampling 不存分支。
- Subject 和 Evaluator 都使用 Eval SP 的**普通 Inbox/Chat 生命周期**。Eval 预先分配 Chat ID，SP 在自己的 Inbox 中按该 ID 幂等确保 Chat；不新增脱离 Inbox 的 `ensureEvalChat`、影子 Inbox 或专用 Chat 存储。Eval API 通过 Run、Sampling 和 EvaluationRecord 关联这些 Chat，Eval Web 不提供普通 Inbox 管理入口。
- 每个 Sampling 拥有独立 Subject Chat/Session。每个 EvaluationRecord 拥有独立 Evaluator Chat/Session，但其物理 Workspace 绑定 Subject 的 SpaceDO，仅向 `/evaluations/<evaluationId>/` 写入。一次 Chat 中每次 Prompt 提交产生自己的 Submission ID；Eval 在各 Attempt 上保存真实 ID。Subject 产物留在原位，SP 把完整 Subject 轨迹物化到同一个 SpaceDO；Eval 保存引用与运行事实。
- Eval 中打开 Subject 或 Evaluator Chat 时只能查看 Chat、Workspace 和轨迹。交互式用户不得发消息、取消、审批或调用写入接口；Eval Run Worker 可通过受控服务身份提交任务，SP 在提交/长连接内部自动处理审批和 `ask_user`。独立部署解决环境与 Chat 存储隔离，不自动实现只读访问控制。

## 包与部署边界

Eval 保持 `eval-contracts`、`eval-dataset`、`eval-runtime`、`eval-metrics` 四个 workspace 包，不增加 `eval-sp-adapter` 或 `eval-driver` 包。`eval-runtime` 定义 Harness 契约并编排运行；`apps/eval-api` 组合 SP 公开接口的客户端、登录鉴权、Config 存储、PostgreSQL 适配器和 Run Worker；Web/CLI 只消费 Eval 控制面。发布脚本或锁定 SP commit 的清单属于仓库级 `deploy/`，不是运行时包。

SP 仓库保留 Agent、Space、API 的实现并提供 Eval 部署配置与正式接口。Eval 发布流程从指定 SP commit 调用其部署目标，不导入 `sp-platform/agent/src/*` 私有源码，也不把评估业务逻辑搬进 SP。运行所需的新 SP 能力见 [接口需求](sp-eval-api-requirements.md)。

发布升级必须保留 Eval SP 的数据库、DO 命名空间、R2 和 Worker 身份，让已有 Chat/Workspace 可继续读取、未完成 Run 可恢复。发布前后应验证旧 Chat、Workspace 和 Submission 的兼容性；固定分支不等于固定 commit。
