# Eval 独立 SP 部署方案

> 已确定的目标架构；Eval 侧 SP Harness 已实现，尚未完成部署和真实跨部署联调。当前阶段固定一个 SP Git 分支；运行时不切分支。

## 一次发布的组成

Eval 的发布流水线将选定的 SP 分支解析为确定的 commit，从该源码发布一套 **Eval 专用 SP**：SP API、它自己的数据库、Agent Worker（含 Inbox/Chat/SubAgent/Sandbox）、Space Worker，以及各自需要的 Durable Object 命名空间、R2、路由和服务凭据。随后发布 Eval API、Run Worker 和 Web；Run Worker 可多实例部署和滚动升级，调度方式见[架构方案](architecture.md#run-调度与停止)。这是一次发布流程，包含多个独立服务；不依赖 dev 或 production 的 SP 部署。

Eval SP Agent 的 `API_ORIGIN` 只指向 Eval SP API。Eval API、Run Worker、Web 和 CLI 使用的 SP 登录、Agent Config、Chat、Submission、Trajectory、Workspace、计费和 Action 接口也只指向这套 Eval SP。SP 内部其他服务地址和绑定须同样指向 Eval 环境；不能把运行写入导向 dev 或 production。

```text
SP branch @ commit ──一次发布流程──> Eval SP API + 独立数据库
                                 ├──> Eval SP Space Worker + SpaceDO + R2
                                 └──> Eval SP Agent Worker + Inbox/Chat DO

Eval Web/CLI ──> Eval API ──> Eval SP 的公开 API
                       └──> Eval PostgreSQL <── Run Worker ──> Eval SP 的 eval-harness 服务路由与长连接
                                                    └──> Eval 证据存储（Eval 专用 R2 桶或本地目录）
```

两个数据库的职责不同：Eval SP 数据库属于 SP 账户和 Agent 运行面；Eval PostgreSQL 属于评估业务。Eval 不直接访问 SP 数据库、DO SQLite 或 SP 的 R2，只使用 SP 公开的 Chat、Submission、Trajectory、Workspace 等接口。

当前 Eval API/Web 的 CI 按改动发布：同一次发布涉及 API 时，新 Web 必须等待本次 AWS API 发布及冒烟检查成功；API 测试、迁移或发布失败不能让新 Web 先上线。只改 Web、API 未改动时，允许 API 发布 job 跳过，不阻断独立 Web 发布。此门禁不替代上游 Eval SP 的独立部署与验收。

导入弹窗的配置请求是 `GET /api/agent-config-sync/config`。来源未配置时应返回 `200 {enabled:false,...}`；`404` 不是正常的关闭状态，应核对实际 AWS API 版本及 Cloudflare 的 `EVAL_API_ORIGIN`，不能通过吞掉 404、临时写库或关闭迁移校验绕过。

## 数据归属

Agent 从 dev 导入是可选控制面能力，不改变运行部署选择。dev 的只读导出接口复用现有 Takt 服务管理令牌；不要为导入执行 dev 数据回填、资源写入、创建会话或分享记录。新增资源来源/任务迁移属于 Eval 业务库，create-only 导入回执迁移属于目标 Eval SP；两者都不能指向 dev 或其他共享库。本轮实现不执行部署或迁移。

不新增密钥：来源 SP 复用该 Dev 环境已有的 `RESOURCE_ADMIN_TOKEN`，也就是 Takt 的 `SP_PLATFORM_RESOURCE_ADMIN_TOKEN`。在 `eval-platform/api/production` 现有 AWS 应用 Secret 中提供 `EVAL_DEV_SP_API_ORIGIN=https://devrapi.springbrand.ai` 和 `SP_PLATFORM_RESOURCE_ADMIN_TOKEN` 的这个已有值；不要生成另一枚导出 token，不使用 Takt 个人登录 token、production 令牌或 Eval 目标的 `EVAL_SP_ADMIN_TOKEN`。只有配置来源地址才启用导入，共享令牌单独存在不启用导入。同时在来源 SP 明文配置 `AGENT_CONFIG_EXPORT_USER_IDS`，只授权明确的 UUID 用户列表，或显式 `*` 授权全范围，空范围保持禁用。不要将真实密钥填进模板或浏览器配置。

来源 SP 的 AWS 部署沿用现有必需的 `RESOURCE_ADMIN_TOKEN` 注入 API，不注入 Cloudflared、Agent Worker 或 Web。该共享令牌本身保留原管理权限，只有导出接口是受范围限制的只读入口；管理员轮换时须同步更新 Takt 和 Eval 调用方。启用前先发布包含 canonical export 和依赖证据契约的来源/目标 SP 代码，再开放允许列表。目标的只读依赖证据查询、插入和回执重放须使用同一版指纹规则；旧来源缺少规范化字段或所选平台定义证据时会阻断，不退回仅比较 ID。

目标 Eval SP 的 `AGENT_CONFIG_IMPORT_USER_IDS` 只填写 Eval 服务账号 UUID，默认空且不接受 `*`。导入端须先读取目标公开能力 `GET /api/agent-config-imports/config` 并确认 `{version:1,enabled:true}`，然后才能上传目标附件或调用三类导入。该允许列表不写入 dev 配置；来源管理令牌不能用于目标导入鉴权，目标写入仍使用固定 Eval 服务账号的会话。普通 Agent 创建不应依赖该导入开关。

目标 Skill 的内容地址必须为独立 `https://creation-file-eval.springbrand.ai`，绑定 `sp-platform-content-eval-enam`；Reference 使用 `https://evalworkspace.springbrand.ai`。不能因为 Eval 暂无 Creation 页面就让目标 Skill 回读 `creation-file-dev.springbrand.ai`。仓库已修正 Eval 的内容 origin，但域名/bucket 绑定与部署后的实际读取尚未核验，必须由运维在启用导入前完成。导入端按 source/target 分开的精确 CDN 允许列表校验，不能从导出 payload 自动授权新域名。

部署环境生成器按进程白名单下发变量：API 和独立 `import-worker` 获得 dev 只读连接，Run Worker 永远不获得 dev 凭据。只有导入连接启用时才启动 `agent-imports` Compose profile；导入进程使用同一个受保护 Bundle 卷暂存校验后的资源，所有目标写请求仍指向 Eval SP。关闭该可选连接会停止导入进程，不删除任务或已导入对象。环境隔离测试运行 `pnpm test:deployment`。

关闭连接后，原 owner 仍可只读查询已持久化任务；新用户搜索、预览和应用保持禁用。目录证据只覆盖平台公开定义、Revision 与已发布内容摘要，不保证外部 MCP 服务在相同 URL/Revision 下的动态工具行为不变，也不冻结普通本地编辑入口。

| 所属系统 | 长期保存的事实 |
| --- | --- |
| Eval SP | 登录与用户账户、`user-agent` 配置、Inbox/Chat/Session/Submission、完整轨迹、Workspace 及文件、计费结算、Action 执行和 Creation 记录。Agent 与 Space 使用 Eval 专用 DO 命名空间和 R2。 |
| Eval PostgreSQL | Dataset、Data、资源目录与输出格式；Project 及其执行/评估计划、Dataset/ProjectSample 快照和冻结 Agent Config 副本引用；Run、Sampling、EvaluationRecord、Attempt、指标所需的原始资源快照与评估原始输出，以及 SP Chat/Submission 引用和证据包引用（`Sampling.evidence`）。 |
| Eval 证据存储 | Subject 证据包：`evidence/<evidence hex>/manifest.json` 与按 sha256 去重的 `evidence/blobs/<sha256>`（产物文件和轨迹 JSONL），写入后不可变。Run Worker 同时配置 `EVAL_EVIDENCE_R2_ENDPOINT`、`EVAL_EVIDENCE_R2_BUCKET`、`EVAL_EVIDENCE_R2_ACCESS_KEY_ID`、`EVAL_EVIDENCE_R2_SECRET_ACCESS_KEY` 时经 S3 API 使用 Eval 专用 R2 桶，否则使用 `<EVAL_BUNDLE_DIR>/evidence/` 本地目录。 |

Eval 的 Agent Config 列表、创建、编辑和运行时解析均使用 **Eval SP 自己的** `user-agent` 库；Eval 使用的固定服务账号也建在 Eval SP 中。切换或更新 SP 源码不重建该数据库，因此不会改变已有用户配置或 Eval 业务记录。不从 dev/production 在线读取、写入或同步账户与配置。已有环境中的配置不会自动出现在 Eval SP；如需复用具体配置，应另行通过公开接口显式导入，然后在 Eval SP 中维护。

## Project、Run 与 Chat

- 分支绑定在 **Project**：固定分支阶段，Project 只能绑定当前部署的 SP 分支。每次 Run 记录发布时实际使用的 SP commit，作为执行或评估的代码来源；Sampling 不存分支。
- Subject 和 Evaluator 都使用 Eval SP 的**普通 Inbox/Chat 生命周期**。Eval 预先分配 Chat ID，SP 在自己的 Inbox 中按该 ID 幂等确保 Chat；不新增脱离 Inbox 的 `ensureEvalChat`、影子 Inbox 或专用 Chat 存储。Eval API 通过 Run、Sampling 和 EvaluationRecord 关联这些 Chat，Eval Web 不提供普通 Inbox 管理入口。
- 每个 Sampling 拥有独立 Subject Chat/Session。每个 EvaluationRecord 拥有独立 Evaluator Chat/Session 和自己的 Space，不绑定 Subject。一次 Chat 中每次 Prompt 提交产生自己的 Submission ID；Eval 在各 Attempt 上保存真实 ID。Subject 执行成功后，Eval 经 SP 导出产物与完整轨迹，固化为不可变证据包；评估时导入 Evaluator Space 的 `/evidence/`，Evaluator 结果写在 `/output/result.json`。Eval 保存引用与运行事实。
- Eval 中打开 Subject 或 Evaluator Chat 时只能查看 Chat、Workspace 和轨迹。交互式用户不得发消息、取消、审批或调用写入接口；Eval Run Worker 可通过受控服务身份提交任务，SP 在提交/长连接内部自动处理审批和 `ask_user`。独立部署解决环境与 Chat 存储隔离，不自动实现只读访问控制。

## 包与部署边界

Eval 保持 `eval-contracts`、`eval-dataset`、`eval-runtime`、`eval-metrics` 四个 workspace 包，不增加 `eval-sp-adapter` 或 `eval-driver` 包。`eval-runtime` 定义 Harness 契约并编排运行；`apps/eval-api` 组合 SP 公开接口的客户端、登录鉴权、Agent Config 转发与冻结副本、PostgreSQL 适配器和 Run Worker；Web/CLI 只消费 Eval 控制面。发布脚本或锁定 SP commit 的清单属于仓库级 `deploy/`，不是运行时包。

SP 仓库保留 Agent、Space、API 的实现并提供 Eval 部署配置与正式接口。Eval 发布流程从指定 SP commit 调用其部署目标，不导入 `sp-platform/agent/src/*` 私有源码，也不把评估业务逻辑搬进 SP。运行所需的新 SP 能力见 [接口需求](sp-eval-api-requirements.md)。

发布升级必须保留 Eval SP 的数据库、DO 命名空间、R2 和 Worker 身份，让已有 Chat/Workspace 可继续读取、未完成 Run 可恢复。发布前后应验证旧 Chat、Workspace 和 Submission 的兼容性；固定分支不等于固定 commit。
