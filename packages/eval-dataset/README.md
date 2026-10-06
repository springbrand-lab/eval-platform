# @eval-platform/eval-dataset

数据集与数据边界，模型从包根入口、`./model` 和 `./dataset` 子路径导出。

后续负责 Dataset、Data、JSON、初始上下文和初始素材集合引用。Data 可以被多个 Dataset 复用，Dataset 不隶属于用户。运行时的 Sample 不属于本包。

R2 上传、下载和 Agent Workspace 物化由运行时 Harness 注入，本包不直接操作 R2 或 Durable Object。
