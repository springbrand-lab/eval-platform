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

Agent management receives an immutable `execution` or `evaluation` purpose on every selectable
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
