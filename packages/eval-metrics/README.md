# @eval-platform/eval-metrics

评估结果量化边界，模型从包根入口、`./model` 和各子模块入口导出。

子模块职责如下：

```text
evaluators/  # 评估上下文、Evaluator 和评估结果契约
attribution/ # 失败归因和证据解释契约
aggregation/ # 分数归一化、样本/采样/项目级聚合
reporting/   # 单条结果、失败、分组、实验报告和分析视图
```

后续负责把 Subject 产物作为主对象、把每次执行都完整收集的轨迹作为补充证据，并结合 Evaluation Agent 产物，转换为评估结果、归因结果和展示所需的汇总视图。

本包不启动 Agent、不读取原始 DO、不定义 Dataset，也不拆出独立的 Evaluator 或 Attribution workspace package。
