# @eval-platform/eval-cli

内部评估 CLI 应用骨架。

后续提供 Dataset 校验、初始资源上传、Project 创建、Run 预览/提交/停止，以及 Run、Sampling、评估、产物和轨迹查询命令，复用 Eval API 的语义。

当前 `src/index.ts` 仍是无 Run 命令的应用骨架；未来提交须带同次 preview 的固定 targets 与 `expectedPlanDigests`，不可自行读取当前计划摘要代替原始调用意图。

CLI 不是云上 Agent 轨迹的事实来源，轨迹必须由 runtime Harness 通过 SP 正式接口获取。
