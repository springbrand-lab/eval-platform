# @eval-platform/eval-metrics

执行与评估的统计、四层展示查询。只读取 Dataset/Runtime 原始事实，不运行 Agent，不保存第二份运行状态。

子模块职责如下：

```text
src/
├── model.ts                 # 统一类型出口
├── index.ts                 # 统一函数出口
├── evaluators/
│   ├── model.ts             # 评估结果与分数统计
│   └── index.ts             # 整理已有评估输出
├── aggregation/
│   ├── model.ts             # 资源、状态与汇总统计模型
│   ├── resources.ts         # 原始资源解析、去重、重叠处理
│   ├── statistics.ts        # 分数与耗时的基础分布计算
│   └── index.ts             # 单次采样及分组聚合
└── reporting/
    ├── model.ts             # 查询、只读来源、四层展示模型
    └── index.ts             # 关联数据并返回四层视图
```

`createMetrics({ source })` 提供 `getProjectOverview()`、`getDatasetOverview()`、`getSampleOverview()`、`getSamplingDetail()`。所有查询显式指定 Project；Dataset 仍是全局共享实体。可选 `runIds` 同时限制采样和该 Run 的评估记录；省略时保留所有重评记录，不默认挑最后一次。共享 Data 在不同 Dataset 中可分别展示，但项目总计直接对采样去重，不能相加 Dataset 小计。

应用注入 `MetricsSource` 后，四层共用同一组查询语义：

```ts
import { createMetrics } from "@eval-platform/eval-metrics";

const metrics = createMetrics({ source });
const scope = { projectId, runIds };
await metrics.getProjectOverview(scope);
await metrics.getDatasetOverview({ ...scope, datasetId });
await metrics.getSampleOverview({ ...scope, sampleId });
await metrics.getSamplingDetail({ ...scope, samplingId });
```

`MetricsSource.read(query)` 由应用层注入，返回一次一致的公开原始事实投影，含 Project、DatasetSnapshot、Sample、SamplingSnapshot、EvaluationRecord、RunSnapshot；不是新的 Store。真实读模型可以复用 Dataset/Runtime 公开查询或 SP 已有事务设施，包内不连接数据库，不访问 SP 私有源码/DO，不下载产物/轨迹或重建 Session。

Project 的 Data 数量表示当前查询中已有采样的数据；Dataset 的 Data 数量和 `dataIds` 表示完整的当前目录，包含尚未跑测的数据。Source 必须完整返回查询范围内的事实；子层查询可以省略其他数据的记录，但不能省略该范围内的重评。

统计包含执行/评估状态、Attempt/重启数量、Agent 耗时、按评估 Agent 分组的分数、费用、Token、模型请求、Turn、工具调用和工具耗时。Sampling 明细保留产物、完整轨迹、评估依据及原始 Attempt/资源记录。产物为主要对象，轨迹只作补充；解释与证据直接展示评估 Agent 的输出，没有归因模块。

缺失值使用 null 和完整性标记，不能补零；完整空流才可确认零。费用区分 Provider USD 和 SP 已结算单位，模型、Action、平台承担与短缺分别展示，不重算价格。模型账单按 `accountId + eventId` 去重，Action 按执行身份，工具/模型请求/Turn 按 Session 内 operationId 合并起止事件。Token 总数按 SP 的输入/输出/缓存独立桶相加，不再加输出子集 reasoning。Subagent 汇总只在对应 Token 或 Provider USD 指标有可信值时抑制子明细；摘要缺少某个指标时继续使用有效子明细，并保留 partial/unavailable 语义。不同真实结算不被丢弃。

评估分数不假设 0～1，不设置通过阈值，不把未知或失败当作 0，不跨评估 Agent 混算平均分。阶段成功率分母只包含终态记录；Agent 耗时不冒充并发批次墙钟时间。默认保留失败、取消、重启和历次重评的资源。

本阶段不实现实验对比、归因、缓存、指标持久化或 API/Web/CLI。模型从包根入口、`./model` 和各子模块入口导出。
