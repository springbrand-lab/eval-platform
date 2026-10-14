# Eval 独立 SP 的接口需求

> 目标契约，尚未全部实现。本文替代先前基于“Eval Chat 脱离普通 Inbox、共用 dev SP API”的接口方案。部署决定和数据归属见 [Eval 独立 SP 部署方案](eval-sp-deployment.md)。具体路由名称由 SP 实现时确定，不把下列能力误认为现有 HTTP API。

## 对接前提

- Eval 独立发布 SP API/数据库、Agent Worker、Space Worker、DO 命名空间和 R2。Agent 的 `API_ORIGIN` 指向 Eval SP API；Eval 的登录、Agent Config、Chat、Submission、Trajectory、Workspace、计费和 Action 接入都指向这套 SP。运行时不请求 dev/production SP。
- Subject 和 Evaluator 使用 Eval SP **普通 Inbox/Chat**。Inbox 只存在于 Eval SP 的隔离存储中；Eval Web 不把它展示为普通聊天管理界面，而是从 Run、Sampling、EvaluationRecord 打开对应 Chat。无需 `ensureEvalChat`、Inbox 外 Chat 类型或独立 Chat 存储。
- Eval 只消费 SP 的公开 Chat、Submission、Trajectory、Workspace 边界；不访问 SP DO SQLite、SP API 私有数据库或 `sp-platform/agent/src/*`。SP 不保存 Eval 的 Project、Dataset、Run、Sampling、EvaluationRecord 或指标汇总。
- Agent Config 使用 Eval SP 自己的用户 `user-agent` 库，Eval 只持久化 `{ownerUserId,userAgentId}` 引用。登录、配置创建和编辑也都走 Eval SP API，不跨环境实时共享配置。

## SP 需要提供或确认的能力

| 能力 | 对 Eval 的契约 | 现状与工作 |
| --- | --- | --- |
| 登录与 Agent Config | Eval Web/API 使用 Eval SP 的用户认证、配置列表、创建、编辑、删除及运行时解析；创建 Chat 时 SP 校验配置归属与可用性。 | 复用 SP API 现有账户与 `user-agent` 能力，给 Eval 域名和服务身份配置访问权限；不新增跨环境配置代理。 |
| Chat 幂等创建 | Eval 预分配 Chat ID，按相同用户、配置、框架和创建事实重复确保原 Chat；冲突事实返回明确错误。Subject 与 Evaluator 均在 Eval SP Inbox 中。 | 复用 `Inbox.createChat(..., chatId)`/普通 Chat 生命周期；确认服务身份接入与重试冲突校验。无需绕开 Inbox。 |
| 初始 Session 与材料 | 按 Data 中可选的 `bundleId + sessionId/materialId` 幂等准备目标 Chat，在首次提交前由对应 Agent 框架恢复 Context；重启不重复装载。 | 需要正式的材料/Session 准备接口；具体 Bundle 来源和各框架装载能力仍需在 SP 核实。 |
| 提交与恢复 | 按 Chat 与幂等键提交 Prompt，返回真实 Submission ID 和回执；响应不确定时按键找回原 Submission。重启产生同一 Chat 的新 Submission/Attempt，不产生新 Sampling。 | 复用 SP Submission 能力，补足 Eval Run Worker 可调用的服务边界和按键查询。Eval 契约已将 Chat ID 与 Attempt Submission ID 拆开，真实 SP Harness 尚未接线。 |
| 长连接终态 | Chat WebSocket 在连接及重连时给目标 Submission 的持久状态快照，在状态变化时推送带真实 Submission ID 的事件；断线后可校准，正常流程不轮询。 | 复用现有 Chat WebSocket，补足可靠的 Submission 身份与状态快照。 |
| 无人值守 | 由提交/长连接所属的运行模式在 SP 服务端自动处理等待：所有审批给 `allow_once`，`ask_user` 返回“随意，由你全权决定”。覆盖临时子 Agent，并把决策纳入同一轨迹。 | 需要 SP Runtime 支持；不能依赖观察者在线，也不新增独立审批服务。 |
| Evaluator 共享 Workspace | Evaluator 保持独立 Chat、Session、Submission 和轨迹，但不可变地绑定 Subject `{userId,chatId}` 所定位的物理 SpaceDO；只可写 `/evaluations/<evaluationId>/`，可读 Subject 证据。 | 需要 SP Chat/Host/Workspace 支持独立的 Chat 身份与 Workspace 定位，服务端覆盖文件、恢复、沙箱同步等所有写入通道的目录权限。 |
| Subject 产物与完整轨迹 | Subject 产物留在原 SpaceDO。SP 确认完整产物清单可读取；终态后从 Subject Chat 收集完整轨迹并按 Chat 幂等物化到同一 SpaceDO。后续独立评估复用该文件。 | 复用 Workspace 与 Trajectory 读写能力；需新增可确认完整性的轨迹物化服务操作，不让 Eval 下载后重传，也不复制产物。 |
| 原始资源 | 按 Chat 和真实 Submission/Attempt 身份返回原始模型用量、Token/cache 数量、结算回执与 Action 实际收费，并声明来源覆盖与是否最终完成。 | 数据来自 Eval SP 自己的 Agent 和 API；需补齐受授权的操作范围读取，不用账户级调试接口代替。Eval Metrics 自算总量、命中率、工具次数与耗时。 |
| 只读观察 | Subject Sampling 和每个 EvaluationRecord 均可进入对应 Chat、Workspace 和轨迹，包括运行中与失败记录。交互式观察者只能读；Run Worker 通过受控身份提交。 | 复用正常 Chat/Workspace 读能力，但仍需在服务端或受控代理限制观察连接的消息、取消、审批和写入 RPC。独立部署本身不提供只读权限。 |
| 框架选择 | Subject 可选 `sp`、`codex`、`cc`；Evaluator 使用 `sp`，全部经同一 Chat/Submission/Workspace 生命周期。 | SP 必须显式支持所选框架；不支持时返回错误，Eval 不静默回退。 |

## 几个不能混用的身份

- **Project 分支**由 Eval 保存。固定分支阶段只能绑定当前发布的 SP 分支；Run 记录实际 commit，Sampling 不存分支。SP 不需要 Project 或“批量评估” API。
- **Chat ID** 在确保 Chat 前由 Eval 分配，重试沿用；**Submission ID** 是 SP 接受一次提交后产生的真实身份，Attempt 必须用它关联资源；**evaluationId** 是 Eval 的评估记录身份。三者不可互换。
- Evaluator 的 `evaluationWorkspace={subject:{userId,chatId},evaluationId}` 改变物理 Workspace 定位，不改变 Evaluator 自己的 Chat/Session。SP 必须确保同一 Evaluator Chat 重试不能改绑到另一个 Subject 或评估目录。
- 单独执行 Project、以后选择已有成功 Sampling 再评估，以及一键选择 Project 下全部成功 Sampling，均属于 Eval 查询和编排；SP 只处理每个 Agent 的公开生命周期。

## Eval 侧配合

1. Eval 已将预分配 Chat ID 与 Attempt 的真实 Submission ID 拆开；真实 Harness 须用 SP 回执/按键恢复填入后者，并保留 Chat ensure、提交和准备操作的稳定幂等键。资源采集在投递前以 `chatId + idempotencyKey` 登记，收集快照必须带真实 `submissionId`。
2. `apps/eval-api` 组合 Eval SP 的公开 HTTP/WebSocket 客户端、Eval SP 登录校验、Agent Config 列表/编辑和真实 Harness；`eval-runtime` 继续负责执行、独立评估、pipeline、并发与恢复。不新增第五个共享包。
3. Runtime 先完整收集 Subject 产物和轨迹，再请 SP 把轨迹物化到 Subject SpaceDO；Evaluator 写自己的评估目录。Runtime 保存原始资源快照，`eval-metrics` 再计算费用、Token/cache、工具和耗时。
4. Eval Web 只提供由 Project/Run/Sampling/Evaluation 进入的只读 Chat/Workspace 视图。配置编辑仅针对 Eval SP 中的用户 Agent Config，与观察 Chat 的只读权限分开。
