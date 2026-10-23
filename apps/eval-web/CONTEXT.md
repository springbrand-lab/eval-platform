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

Live trajectory pages contain only `pi-trajectory/v1` native records. Classification,
summary and model/tool filters use the shared `eval-runtime/harness` reader seam;
raw expansion retains the complete source record. Receiving-store cursors and
actor-scoped identities govern paging and overlap, not actor-local native IDs.
The loaded interval survives refreshes and failed history reads. Unknown formats
are explicit errors. Historical evidence decoding does not enable a legacy live
observation mode.

API and Web use the same Harness safe page parser. On-demand canonical Pi
conversation context, request parameters/outcome/response and typed hook values
call the official SDK reader against the loaded native records. Safe changes
are audit records, not replayed messages or full before/after model-input
snapshots. Compaction does not require an input recipe. Missing earlier
dependencies are an explicit inspection gap, never a second transcript.
Raw Chat history is not an execution metrics/final-reply
source by UI selection. Native tasks, invocations and deferred polls are shown
as distinct resource observations in the existing operations panel.
Unknown/unavailable metrics, including operation outcome cells and cached zero
values without complete coverage, render as “未获得”, not a known zero.
Cross-page policy changes for one actor are rejected before cache replacement.

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
