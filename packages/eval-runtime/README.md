# @eval-platform/eval-runtime

评估运行时的控制面和执行编排。它只依赖 SP 的公开 Harness 边界，不复制 SP Runtime，也不直接读取 Durable Object 存储。

## 对外边界

运行时最终向 API、Web 和 CLI 暴露同一组控制面：

- `listProjects()`
- `listAgents()`
- `listDatasets()`
- `listData()`
- `listSamples()`
- `start()`：只启动被评估 Agent；
- `evaluate()`：只评估已有执行结果；
- `pipeline()`：编排 `start()` 和 `evaluate()`；
- `getRun()`：读取项目、阶段、数据、样本、采样和执行状态；
- `getSampling()`：读取单次采样的执行、评估和尝试结果。

这些接口属于运行时控制面，不绑定具体的 HTTP、Web 或 CLI 实现。

## 文件职责

```text
src/
├── model.ts                 # 对 eval-contracts 和运行时 Sample 的公共导出
├── config/
│   ├── model.ts             # Execution / Evaluation / Pipeline 配置模型
│   └── index.ts             # 配置子包入口
├── harness/
│   ├── model.ts             # SP 公开 Chat / Submission / Workspace 边界
│   └── index.ts             # Harness 子包入口
├── runtime/
│   ├── model.ts             # Project / Data / Sample / Sampling 控制面模型
│   ├── index.ts             # API 控制面和阶段编排入口
│   ├── agent-lifecycle.ts   # Agent ensure、提交、终态推送、校准和重试
│   ├── execution.ts         # Subject 执行、初始数据、产物和完整轨迹
│   ├── evaluation.ts        # Evaluation Agent、输入复制和评估输出
│   ├── store.ts             # Run / Sampling 持久化端口
│   ├── scheduler.ts         # 执行 / 评估两套 Agent 并发限制契约
│   └── retry.ts             # 阶段化重试决策和 Agent 重启策略
└── index.ts                 # 包统一导出
```

四个顶层包及其内部文件均保持在当前仓库中；内部目录是模块，不是新的 workspace package。

配置、Harness 和 Runtime 是本包内的子模块，不是额外 workspace package。运行时只负责启动 Agent、完整收集产物和轨迹、分别控制执行/评估阶段的最大 DO 启动数量与重试，并把结果交给评估结果层；它不实现指标算法。`RuntimeStore` 是持久化端口，实际实现由 API/DO/数据库层注入。

## 重要约束

1. 一个 `Sampling` 必须对应一个独立的 Subject Chat / Workspace。
2. Evaluation Agent 使用独立的 Evaluation Chat / Workspace；对外只记录一个 `submissionId`，它同时表示 SP 的 Chat/Submission，不重复记录 `chatId`。
   Runtime 在调用 `ensureAgent` 前分配并持久化该 ID。Harness 必须按 ID 获取或创建，重复或并发请求返回同一个 Agent；同一 ID 的归属、角色或 Agent Config 不一致时返回不可重试的 `AgentIdentityConflictError`，不得静默重绑定。
3. 重试不能把一次采样变成新的采样，只能增加该采样的执行或评估 attempt。
   `RetryController` 按 `creation`、`submission`、`status`、`collection` 和 `restart` 区分决策；默认策略只定义确认失败后的 Agent 重启，其余操作是否重试由注入的控制器决定。Agent ensure 重试保留同一 ID 和创建参数，不新增执行/评估 attempt、不消耗 Agent 重启次数；收集失败不得重启已经完成的 Submission。
4. Submission 终态以 Harness 推送通知为主；自动重试前仍必须按本次操作的幂等键查询原 `Submission`，不得因为响应丢失就盲目再次投递。
5. Subject Workspace 产物和完整 Trajectory 必须复制到评估 Chat / Workspace 后，评估 Agent 才能启动。
6. 推送丢失、连接断开或运行时恢复时，`inspectAgentOperation` 只做一次或有限次状态校准，不作为主流程的持续轮询。
7. 评估平台只消费 SP 的公开契约，不依赖 SP 的 DO SQLite、内部类或 Web 投影。
8. 再次主动调用 `evaluate()` 会重置评估记录并在启动前分配新的评估 ID；这是有意重新评估，不是丢响应后的 ensure 重试。被评估 Agent 的 ID 保持不变。

轨迹通过 SP 正式接口完整获取，并无条件复制到评估 Agent 的 Workspace；本包不引入独立的轨迹树或线上流量评估子包。

## 暂不纳入本包

- 数据集持久化实现；
- 评估指标聚合实现；
- API、Web、CLI 应用；
- CC、Codex 等进程启动器；
- 第二套 SP Adapter 包。

后续非 SP Harness 接入若确有需要，再增加独立 Harness 实现，而不是改变本包的运行时控制面。
