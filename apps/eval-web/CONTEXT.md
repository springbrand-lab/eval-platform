# Web Context

`eval-web` is the internal evaluation console, embedded in takt and sharing its login.

It prepares Datasets, Data, initial resources, output formats and Agent Configs; creates Projects
from Datasets, Data subsets and Sampling counts with a Subject Agent and execution policy; fills or
replaces the evaluation plan until the first evaluating Run locks it; previews and submits Runs over
Project, Dataset, ProjectSample and Sampling selections; stops Runs and re-syncs judge scores; and
displays the four-level metrics, artifacts, evaluation results, Langfuse links and read-only Chat,
Workspace and Trajectory views. It also shows the service account's credits and records manual grants.

It consumes only the Eval API and package public contracts. It never drives an Agent, never connects
to SP Durable Objects, and never reconstructs trajectory facts from UI state. Its Worker is the only
place the takt token is checked; the Eval API sees the verified user only as an audit actor.

Agent management receives a current `execution` or `evaluation` purpose on every selectable
Agent option. The API reconciles missing purpose records before returning options; an unavailable
or ambiguous MCP catalog is a blocking 503, so the page never renders an unknown-purpose row or
lets a Project selector continue with an incomplete list. The Web uses the same filtered options
for Agent management, Project execution selection and the evaluation plan.

## Language

**执行 Agent（Subject）**:
执行用例任务并交付产物的 Agent，其产物是评估的主要证据。
_Avoid_: 被测 Agent、测试 Agent、实验 Agent、被测会话

**评估 Agent（Evaluator）**:
依据评估要求与评分格式检查执行 Agent 产物、给出评估结果的 Agent。
_Avoid_: 评委、评委 Agent、评委会话

## Comparison vocabulary

**数据看板**：有名称且可反复打开的项目对比配置，记录要观察的项目集合，不是评估结果快照。

**看板配置**：看板的名称、说明、有序项目选择和已确认的数据展示选择。创建或编辑看板不执行 Agent，也不改变项目已有结果。

**数据展示选择**：从共同已评数据中确认保留的范围。勾选草稿不影响当前统计，确定后整个看板使用同一保留范围；恢复全部还原当前有效交集，不删除或恢复项目原始事实。

**项目对比**：多个 Project 当前已评分结果的对称阅读方式，没有基线项目或候选项目之分。

**共同指标**：所选 Project 的 Schema 中身份相同、统计类型兼容，且在共同用例上实际取得有效评分的词条。

**共同已评数据**：同一 Data 身份在各 Project 的当前共同指标上都有有效评分的数据。真实的 0 和 false 属于评分，未评分及 null 不属于评分。

**对比范围**：当前指标下的全部共同已评数据，或按数据集、单条数据逐级缩小的集合。显示页不是新的统计范围。
