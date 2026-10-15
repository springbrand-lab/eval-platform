# Eval 独立 SP 的接口需求

> 目标契约，尚未全部实现。部署决定和数据归属见 [Eval 独立 SP 部署方案](eval-sp-deployment.md)；已实现的服务路由见 [Eval SP Harness 服务契约](eval-sp-harness-protocol.md)，不把下表中尚未实现的能力误认为现有接口。

## 对接前提

- Eval 独立发布 SP API/数据库、Agent Worker、Space Worker、DO 命名空间和 R2。Agent 的 `API_ORIGIN` 指向 Eval SP API；Eval 的登录、Agent Config、Chat、Submission、Trajectory、Workspace、计费和 Action 接入都指向这套 SP。运行时不请求 dev/production SP。
- Subject 和 Evaluator 使用 Eval SP **普通 Inbox/Chat**。Inbox 只存在于 Eval SP 的隔离存储中；Eval Web 不把它展示为普通聊天管理界面，而是从 Run、Sampling、EvaluationRecord 打开对应 Chat。无需 `ensureEvalChat`、Inbox 外 Chat 类型或独立 Chat 存储。
- Eval 只消费 SP 的公开 Chat、Submission、Trajectory、Workspace 边界；不访问 SP DO SQLite、SP API 私有数据库或 `sp-platform/agent/src/*`。SP 不保存 Eval 的 Project、Dataset、Run、Sampling、EvaluationRecord 或指标汇总。
- Agent Config 存在 Eval SP 自己的用户 `user-agent` 库，但只在 Eval 内增删改查，Eval API 经 Eval SP 公开接口转发；不会有人直接在 SP 操作，也不跨环境实时共享配置。Project 引用 Eval 通过 SP 公开创建接口生成的冻结副本 `{ownerUserId,userAgentId}`，Eval 维护副本与 Project 的对应关系并在自己的列表中隐藏副本；SP 不需要版本历史。

## SP 需要提供或确认的能力

| 能力 | 对 Eval 的契约 | 现状与工作 |
| --- | --- | --- |
| 登录与 Agent Config | Eval Web/API 使用 Eval SP 的用户认证、配置读取、创建、编辑、删除及运行时解析；冻结副本是一次普通创建，内容与原配置相同，之后不被修改；Evaluator 副本被替换或 Project 创建失败时由 Eval 删除。创建 Chat 时 SP 校验配置归属与可用性。 | 复用 SP API 现有账户与 `user-agent` 能力，给 Eval 域名和服务身份配置访问权限；不新增跨环境配置代理或版本历史。 |
| Chat 幂等创建 | Eval 预分配 Chat ID，按相同用户、配置、框架和创建事实重复确保原 Chat；冲突事实返回明确错误。Subject 与 Evaluator 均在 Eval SP Inbox 中。 | 复用 `Inbox.createChat(..., chatId)`/普通 Chat 生命周期；确认服务身份接入与重试冲突校验。无需绕开 Inbox。 |
| 初始 Session 与材料 | 按 Data 中可选的单个 `bundleId + sessionId` 和有序的多个 `bundleId + materialId`，在一次初始化中幂等准备目标 Chat（见 [SP Harness 协议](eval-sp-harness-protocol.md#initialization)），在首次提交前由对应 Agent 框架恢复 Context；重启不重复装载。 | 需要正式的材料/Session 准备接口；具体 Bundle 来源和各框架装载能力仍需在 SP 核实。 |
| 提交与恢复 | 按 Chat 与幂等键提交 Prompt，返回真实 Submission ID 和回执；响应不确定时按键找回原 Submission。重启产生同一 Chat 的新 Submission/Attempt，不产生新 Sampling。 | 复用 SP Submission 能力，补足 Eval Run Worker 可调用的服务边界和按键查询。Eval 契约已将 Chat ID 与 Attempt Submission ID 拆开，Eval 侧 SP Harness 已按[服务契约](eval-sp-harness-protocol.md)接线，待跨部署联调。 |
| 长连接终态 | Chat WebSocket 在连接及重连时给目标 Submission 的持久状态快照，在状态变化时推送带真实 Submission ID 的事件；断线后可校准，正常流程不轮询。 | 复用现有 Chat WebSocket，补足可靠的 Submission 身份与状态快照。 |
| 无人值守 | 由提交/长连接所属的运行模式在 SP 服务端自动处理等待：所有审批给 `allow_once`，`ask_user` 返回“随意，由你全权决定”。覆盖临时子 Agent，并把决策纳入同一轨迹。 | 需要 SP Runtime 支持；不能依赖观察者在线，也不新增独立审批服务。 |
| Evaluator 共享 Workspace | Evaluator 保持独立 Chat、Session、Submission 和轨迹，但不可变地绑定 Subject `{userId,chatId}` 所定位的物理 SpaceDO；只可写 `/evaluations/<evaluationId>/`，可读 Subject 证据。 | 需要 SP Chat/Host/Workspace 支持独立的 Chat 身份与 Workspace 定位，服务端覆盖文件、恢复、沙箱同步等所有写入通道的目录权限。 |
| Subject 产物与完整轨迹 | Subject 产物留在原 SpaceDO。SP 确认完整产物清单可读取；终态后从 Subject Chat 收集完整轨迹并按 Chat 幂等物化到同一 SpaceDO。后续独立评估复用该文件。 | 复用 Workspace 与 Trajectory 读写能力；需新增可确认完整性的轨迹物化服务操作，不让 Eval 下载后重传，也不复制产物。 |
| Evaluator 结构化输出 | 评估输出收集（`EvaluationAgentOutput`）在 `structuredOutput` 中返回 Evaluator 写在 `/evaluations/<evaluationId>/` 下的结果文件路径、原始 UTF-8 文本和可选内容 hash，不解析、不改写；没有结果文件时省略。Eval Metrics 按 Project 锁定的 Schema 校验并抽取数值。 | Eval 侧契约与接线已就绪；SP 输出收集需要实际返回该文件。 |
| 原始资源 | 按 Chat 和真实 Submission/Attempt 身份返回原始模型用量、Token/cache 数量、结算回执与 Action 实际收费，并声明来源覆盖与是否最终完成。Telemetry 事件需带稳定的 `sessionId`/`operationId`/`parentOperationId`：Turn、工具 `tool.started` 的 `payload.input` 与 `tool.finished` 的 `payload.output`（或 `response`），以及可关联到 Turn 的 `generation.finished` Token。 | 数据来自 Eval SP 自己的 Agent 和 API；需补齐受授权的操作范围读取，不用账户级调试接口代替。Eval Metrics 自算总量、命中率、轮数、工具次数与长度、非工具轮 Token 和耗时；缺少关联字段时显示 partial/unavailable。 |
| 只读观察 | Subject Sampling 和每个 EvaluationRecord 均可进入对应 Chat 的 Context、Workspace 和轨迹，包括未开始、运行中与失败记录。Eval API 校验归属后只给浏览器 `AgentObservationRef`（Chat 所属用户与 Chat ID），不给可写 Chat URL。交互式观察者只能读：消息、steer、审批、取消/停止和 Workspace 写入都被拒绝；Run Worker 通过受控服务身份提交。 | 复用正常 Chat/Workspace/Trajectory 读能力，但需在 SP 服务端或受控代理执行只读权限，覆盖所有写入 RPC，并提供由观察引用打开的只读页面或 deep link。独立部署本身不提供只读权限。 |
| 框架选择 | Subject 可选 `sp`、`codex`、`cc`；Evaluator 使用 `sp`，全部经同一 Chat/Submission/Workspace 生命周期。 | SP 必须显式支持所选框架；不支持时返回错误，Eval 不静默回退。 |

## 几个不能混用的身份

- **Project 分支**由 Eval 保存。固定分支阶段只能绑定当前发布的 SP 分支；Run 记录实际 commit，Sampling 不存分支。SP 不需要 Project 或“批量评估” API。
- **Chat ID** 在确保 Chat 前由 Eval 分配，重试沿用；**Submission ID** 是 SP 接受一次提交后产生的真实身份，Attempt 必须用它关联资源；**evaluationId** 是 Eval 的评估记录身份。三者不可互换。
- Evaluator 的 `evaluationWorkspace={subject:{userId,chatId},evaluationId}` 改变物理 Workspace 定位，不改变 Evaluator 自己的 Chat/Session。SP 必须确保同一 Evaluator Chat 重试不能改绑到另一个 Subject 或评估目录。
- 仅执行、执行并评估、仅评估，以及按 Project/Dataset/ProjectSample/Sampling 选择和局部替换，均属于 Eval 的 Project 快照与编排；SP 只处理每个 Agent 的公开生命周期。

## Eval 侧配合

1. Eval 已将预分配 Chat ID 与 Attempt 的真实 Submission ID 拆开；Harness 用 SP 回执/按键恢复填入后者，并保留 Chat ensure、提交和准备操作的稳定幂等键。资源采集在投递前以 `chatId + idempotencyKey` 登记，收集快照必须带真实 `submissionId`。
2. `apps/eval-api` 组合 Eval SP 的公开 HTTP/WebSocket 客户端、Eval SP 登录校验、Agent Config 增删改查与冻结副本（含失败补偿删除）和真实 Harness；`eval-runtime` 负责执行、仅评估、pipeline、并发与恢复。不新增第五个共享包。
3. Runtime 先完整收集 Subject 产物和轨迹，再请 SP 把轨迹物化到 Subject SpaceDO；Evaluator 写自己的评估目录。Runtime 保存原始资源快照和 Evaluator 原始结构化输出，`eval-metrics` 再计算费用、Token/cache、轨迹、工具、耗时和 Schema 数值。
4. Eval Web 只提供由 Project/Run/Sampling/Evaluation 进入的只读 Chat/Workspace/Trajectory 视图。Agent Config 编辑只针对用户自己的配置，冻结副本不可编辑，与观察 Chat 的只读权限分开。
