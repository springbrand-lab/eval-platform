# 评估结果提交

评估 Agent 把评分直接交给 Eval 平台，平台校验并保存；不再依赖 Agent 自己写 `/output/result.json`。只有平台拿到并校验通过的结果，评估才记为成功。

## 背景

旧流程里，评估 Agent 用 `execute` 工具把结果写进自己 Space 的 `/output/result.json`，SP 的 `output` 接口再读出来。`execute` 沙箱一旦失败（例如 SP 的 dynamic worker 并发上限），Agent 已经有了评分却写不出文件；而 Runtime 只看 Agent 是否跑完，照样记为 `succeeded`，页面显示“评估完成”却没有结果。

## 提交通道

提交通道是 Eval API 自己提供的 MCP Server，通过 SP 已有的“用户 MCP Server”能力挂到评估 Agent 的 Agent Config 上。SP 代码不变，也不经过 `execute` 沙箱。

- 路由：`POST /mcp/evaluation-results`，在 `/api/*` 之外，不经过 Web 网关和会话。无状态 Streamable HTTP：只接受 JSON-RPC POST，以 `application/json` 应答，不发 `Mcp-Session-Id`；`GET`/`DELETE` 返回 `405`。支持 `initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`。
- 鉴权：`Authorization: Bearer <EVAL_RESULT_MCP_TOKEN>`。同一个值在 Eval SP 里注册为该 MCP Server 的 Bearer token。未配置 `EVAL_RESULT_MCP_TOKEN` 时路由返回 `404`，Worker 也不在提示词里提到这个工具。
- 工具 `submit_evaluation`，定义固定不变（SP 会校验发现时与调用时的工具签名）：
  - `evaluationId`：本次评估 ID，写在提示词里。
  - `submitToken`：本次评估的一次性提交凭证，写在提示词里，等于 `base64url(HMAC-SHA256(EVAL_RESULT_MCP_TOKEN, "submit:" + evaluationId))`。同一个 Agent Config 会被很多评估共用，Bearer token 无法区分是哪一条，所以每条评估另有凭证，防止结果串到别的评估。
  - `result`：符合 `/evaluation-output.schema.json` 的 JSON 对象。
- 处理：校验每条评估的提交凭证和锁定 Schema。校验通过后，在同一个事务中保存评分、将 Evaluation 标为 `succeeded` 并更新紧凑统计投影。首次合法结果生效；语义相同的重复提交返回成功，后续不同结果拒绝覆盖。事务重新检查项目和当前 Run，删除、停止、取消或被替换的评估不能提交。连接观测失败不阻止当前评估的晚到提交。

## 结果来源与成功判定

配置了 MCP 时，只有 `submit_evaluation` 校验通过并落库的结果是完成依据，来源为 `submission`。Agent 会话是否结束、WebSocket 是否断开，不决定评分是否成功；MCP 返回成功后，Agent 只需结束并简短总结，无需再写结果文件或重复输出 JSON。

- MCP 已接收：Evaluation 为 `succeeded`，后续状态观测或资源收集失败不能覆盖它。Worker 继续收集真实 Attempt 终态和资源，缺失信息仍按不完整展示，不伪造完成时间。
- 还未提交且连接观测失败：保留 `retrying`，由现有持久 Run 队列恢复观察，沿用原 Chat/Submission，不重新打分。主动停止和既有队列的有限恢复预算仍然有效。
- Agent 已结束但 MCP 没有合法结果：明确记录 `evaluation result not submitted`，不把最后回复或结果文件当成已提交。当前未停止/替换的评估仍可接收晚到的合法 MCP 结果。

仅未配置 MCP 的旧 Agent 保留 `result-file` 和 `final-reply` 的收集方式，依然经过同一 Schema 校验。原始产物、轨迹和 Attempt 记录保留。

## 未提交评分的重试

评估 Agent 的 Submission 已完成、平台尚无提交评分时，直接进入 Runtime 现有的 `restart` 决策，不检查错误文本或最终回复。在同一评估 Chat 使用新的幂等键提交下一次 Attempt，和失败 Submission 共用评估计划的 `maxRestarts`、退避及持久化 Attempt 次数；默认最多 4 次重启，加上首次共 5 次，不另加预算。不会重跑执行 Agent，也不重新初始化或导入证据。原 Attempt 的完成状态、资源及 `evaluation result not submitted` 原因保留，Worker 恢复不重置次数；耗尽后仍未提交则明确失败。

MCP 评分补交时只发送 `Please complete the evaluation, then use the MCP tool to submit the evaluation result.`，不再发送原评估消息。原 Chat 已有评估上下文、Schema 和提交凭证。补交模式从已保存的 completed Attempt 和未提交原因推导，Worker 恢复或后续补交消息失败后仍使用同一句提示；首次评估、补交前的普通失败重启及非 MCP 旧流程不改变提示词。

最终回复不作为 MCP 评分。合法结果已接受、结果格式无效、人工补收或 Run 已停止时不启动恢复；恢复决策前再读当前记录确认结果未被 MCP 接受。

## 配置

- Eval API 与 Run Worker 配置同一个 `EVAL_RESULT_MCP_TOKEN`（至少 32 个字符）。生产部署从应用 Secret 读取该值并传给两个容器（`infra/aws/deploy/deploy.sh`），MCP 地址为 `https://evalapi.springbrand.ai/mcp/evaluation-results`。
- Eval SP 必须能通过公网 HTTPS 访问该 MCP 地址（SP 只接受 `https:`，并只连接公网地址）。本地联调需要一个 HTTPS 隧道指向本地 Eval API。
- 在 Eval SP 的服务账号下创建用户 MCP Server（URL 为 `https://<公网地址>/mcp/evaluation-results`，鉴权为 Bearer）。Eval Agent Config 创建页的“Agent 用途”选择“评估”时，会按这个固定 URL 路径查找该服务并自动把它的 `serverId` 加入 `mcpServers`；选择“执行”时会移除这个自动绑定项。页面不会依赖数据库里的随机 MCP ID，找不到唯一且启用的结果 MCP 时会阻止评估配置保存并提示原因。只影响选中它的 Agent Config；SP 连不上该 MCP 时只把它标为不可用；未提交合法结果时评估不会记为成功。
- 评估 Chat 中的工具审批由 SP 无人值守逻辑自动允许，不会卡在审批。

## MCP completion authority

When MCP submission is configured, a schema-valid accepted submission is the authoritative completion fact, independent of the Agent status socket. The API atomically saves the first accepted result and marks the Evaluation succeeded, updating its compact metric projection in the same transaction. Identical semantic retries are idempotent; different subsequent results are rejected. A late valid result may recover a failed observation, but deleted Projects, stopped Runs, cancelled Evaluations and replaced Run memberships reject submissions. The transaction serializes with Project stop/replacement via the Project lock and checks the Evaluation again under its row lock.

A submitted output uses the existing Evaluator Chat's public trajectory URL when no collected output exists; this is a reference, not a claim that the Agent has terminated or resource collection is complete. Original Attempt lifecycle and collected evidence stay intact. Runtime must not overwrite an accepted result on a later status/collection/persistence failure. Without an accepted MCP result, status observation failures leave the Evaluation retrying for the existing durable Run recovery job; explicit stop and its finite job budget still apply. A completed Agent without a submitted MCP result is not successful, and file/final-reply fallback is only used when MCP is not configured.
