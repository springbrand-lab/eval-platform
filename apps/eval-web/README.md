# @eval-platform/eval-web

内部评估 Web 应用骨架。

后续用于选择 Project、Dataset、Sample、Subject Agent、Judge Agent、执行并发和评估并发，并展示产物、评估结果、指标和评估证据。

登录和 Agent Config 浏览/定制均通过 Eval API 接入独立部署的 Eval SP，不连接 dev/production SP。Subject Sampling 和 EvaluationRecord 均可进入对应 Chat、Workspace 与轨迹，只读查看且不提供聊天驱动、取消或审批操作；普通 Inbox 不作为 Eval 的管理页面。

当前不包含 React、Vite、路由、页面或对外产品能力。
