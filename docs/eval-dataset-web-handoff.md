# Dataset 层与 Web 接入说明

本文是 Dataset Web 交互的接入约束。接口事实以 [Dataset 上传契约](eval-dataset-upload.md)、[Eval HTTP 接口](eval-http-api.md)和当前代码为准。

## Web 导航与操作

“数据集”入口下只有四个子卡片：初始素材、初始上下文、Prompt 数据集、评分 Schema。素材与上下文分别进入自己的 Bundle 列表和详情，不提供混合 Bundle 或旧路由。评分 Schema 是独立文件，名称和描述在平台填写，没有 Bundle。

两类 Bundle 支持创建时附 ZIP、向已有 Bundle 导入 ZIP、逐条上传，以及分别编辑包与条目的名称和描述。ZIP 出错显示条目路径和错误，不创建半包。样本编辑单独展示 name、description、执行 Prompt、评估 Prompt；任意额外 JSON 字段保持原样。执行素材和评估素材各为跨 Bundle 的有序多选，执行上下文为单选。选择器只列活动资源，不默默清除现有引用。软删除保持已创建 Project 的固定快照和文件读取能力。

四层 Metrics 统一消费服务端返回的 `evaluationOutputs` 展示定义、观察和资源统计。Web 不重新解释 Schema、不把任意数值字段当评分、不从下层均值反推上层统计；所有字段的 title、description、分布、null、缺失和覆盖状态都来自同一事实链。Sampling 的 Context、Workspace、Trajectory 观察均为只读。

## 背景与目的

一次评估需要两类输入：每条样本的启动和评估 Prompt，以及可选的初始素材和初始上下文。用户要管理的是有名称、描述的 Dataset 和资源，运行时使用的是服务端生成的 ID。Project 的评估计划还要选择一份评估结果的 JSON Schema（输出格式），约束评估 Agent 的输出。

各对象的关系如下：

| 对象 | 用户看到什么 | 关系与用途 |
| --- | --- | --- |
| Dataset | 必填的 `name`、`description` | 一次 Prompt JSON/JSONL 导入产生一个 Dataset；它关联多条 Data，不隶属于 Project。 |
| Data | 每条必填的 `name`、`description`、`userPrompt`、`evalPrompt` | 一条可复用样本；可额外绑定多个执行素材、多个评估素材和一个执行上下文。同一用户的 Data 可以属于多个 Dataset。 |
| 素材 Bundle（Material Bundle） | 必填的 `name`、`description` | 只装 Material。创建时可直接附带一个 ZIP 一次导入，之后也可再导入 ZIP 或逐条上传。 |
| 上下文 Bundle（Session Bundle） | 必填的 `name`、`description` | 只装 Session，没有文件夹概念。创建、导入和逐条上传方式与素材 Bundle 相同。两类 Bundle 是互相独立的资源，不能混放。 |
| Material | 必填的 `name`、`description` | 素材 Bundle 内的一条素材，可以是一个文件，也可以是一个目录下的多个文件。Data 绑定到具体 `bundleId + materialId`。 |
| Session | 必填的 `name`、`description` | 上下文 Bundle 内的一份 JSON/JSONL 初始上下文，一个文件就是一个 Session。Data 绑定到具体 `bundleId + sessionId`，只用于 Subject 执行。 |
| 输出格式 | 必填的 `name`、`description` | 单独上传的一份 JSON Schema 文件，没有 Bundle。Project 评估计划保存其 `outputSchemaId` 和内容摘要。 |

ID 由后端生成，前端保存 ID 供请求使用，列表和选择器优先展示用户填写的名称、描述。Dataset、Data、两类 Bundle、Material、Session 和输出格式的 ID 都是 UUID；路径和引用只接受 UUID（非 UUID 返回 `422`），可用大小写混合形式输入，保存和返回时统一为小写。资源元数据和 Data 绑定保存在 Eval 的 PostgreSQL；Material 文件和 Session 内容保存在 Eval 的 Bundle 目录。Web 只调用 Eval API，不直接访问该目录或 SP 的 DO 存储。

## 后端能力

- `eval-dataset` 已支持独立的 Prompt JSON/JSONL 上传解析、Dataset/Data 关联和通用 JSON/YAML 导入导出。Prompt Dataset 在导入后继续约束自身描述及成员 Data 的名称、描述和两个 Prompt；资源引用中的 UUID 在模型入口统一成小写。
- 标准 Eval API 已提供 Dataset/Data、素材 Bundle/Material、上下文 Bundle/Session（含 ZIP 导入）和输出格式的路由；Project 在评估计划中选择输出格式。目录按固定 Eval 服务账号隔离，takt 用户负责访问控制和操作审计；Data 创建、修改和导入会校验引用的资源属于该服务账号且仍可选。
- 相关数据库表、关联和软删除字段都在 `apps/eval-api/migrations-postgres/0000_initial.sql` 初始基线内。删除规则见下文“编辑、关联与删除规则”。
- API 上传的文件由 Eval Bundle 目录保存，Run Worker 按 Project 快照中 Data 副本的 Material/Session 引用取用；评估输出格式按 Project 评估计划保存的 ID 解析。执行和评估仍通过 SP 公开接口完成，Web 不需要实现文件目录或 SP 内部存储协议。

## Web 应实现的主流程

### 1. 上传 Prompt Dataset

Dataset 页提供 Dataset 名称、描述输入框和一个 `.json` 或 `.jsonl` 文件选择框。**文件内只有逐条 Data；Dataset 的名称和描述与文件内容并列放在同一个创建请求中。** 不需要先调用 `POST /api/datasets`，也不要把 Dataset 元数据包进文件。

例如 `.json` 文件本身是这样的数组；`.jsonl` 则每行放一个同样结构的对象：

```json
[
  {
    "name": "首页",
    "description": "响应式首页",
    "userPrompt": "实现首页",
    "evalPrompt": "检查布局和可访问性"
  }
]
```

```http
POST /api/datasets/prompt-import
Content-Type: application/json
```

```json
{
  "name": "首页任务集",
  "description": "第一批页面评估样本",
  "format": "json",
  "content": "[{\"name\":\"首页\",\"description\":\"响应式首页\",\"userPrompt\":\"实现首页\",\"evalPrompt\":\"检查布局和可访问性\"}]"
}
```

`content` 是文件文本，不是解析后的数组，也不是 `multipart/form-data`。`json` 文件顶层必须是非空数组；`jsonl` 文件每个非空行是一条 JSON 对象。每条都要有非空白的 `name`、`description`、`userPrompt`、`evalPrompt`。Prompt 原文保留；其他可无损表示为 JSON 的业务字段可以保留。文件行不能带 `dataId` 或 `initialMaterials`、`evalInitialMaterials`、`initialSession`：资源在导入后逐条选择。重复 JSON 字段、注释和尾逗号会被拒绝。

成功返回 `201`，信封的 `msg` 是 `{dataset, data}`，其中 Dataset 和每条 Data 都已有服务端生成的 ID。导入是原子操作，失败时不会留下一部分样本。文件文本上限 10 MB，超出时为 `422` 字段校验错误；请求体上限由文件上限推导，不必另行限制。列表用 `GET /api/datasets`；选中 Dataset 后用 `GET /api/datasets/{datasetId}/data` 读取其样本。全局 `GET /api/data` 可查当前用户的所有活动 Data，包括尚未关联 Dataset 的条目。通用 `POST /api/datasets/import?format=json|yaml` 是另一种包含 Dataset 外壳的导入格式，Dataset 页的新 Prompt 上传应使用 `prompt-import`。

### 2. 建素材 Bundle 和上下文 Bundle

用户可在导入 Dataset 前后管理资源。资源按 Eval 服务账号共享，不属于某个 Dataset。Web 提供两个独立入口：素材 Bundle 只管理 Material，上下文 Bundle 只管理 Session；两者的列表、详情和上传互不混用。

| 操作 | 素材 Bundle | 上下文 Bundle |
| --- | --- | --- |
| 列出与创建 Bundle | `GET`、`POST /api/material-bundles` | `GET`、`POST /api/session-bundles` |
| 向已有 Bundle 导入 ZIP | `POST /api/material-bundles/{bundleId}/import` | `POST /api/session-bundles/{bundleId}/import` |
| 逐条上传与列出资源 | `POST`、`GET /api/material-bundles/{bundleId}/materials` | `POST`、`GET /api/session-bundles/{bundleId}/sessions` |

创建 Bundle 用 `multipart/form-data`：字段 `name`、`description` 必填，文件字段 `zip` 可选。带 `zip` 时 Bundle 与其中的资源在一次原子操作中创建；不带时得到空 Bundle。导入已有 Bundle 时只提交 `zip` 字段。两者都返回 `201 {bundle, imported:[{source, material}]}`（上下文 Bundle 为 `{source, session}`），`source` 是 ZIP 中对应的顶层条目名，Web 可据此展示导入结果。ZIP 的目录结构、命名、格式与上限只以 [ZIP 导入规则](eval-dataset-upload.md#zip-import)为准；要点是：上下文 ZIP 只能在根目录放 `.json`/`.jsonl` 文件（扩展名前须有文件名，名为 `.json` 的文件会被拒绝），每个文件成为一个 Session；素材 ZIP 的每个顶层目录成为一个 Material，每个根目录文件成为一个单文件 Material。导入的资源名为顶层条目名（去空白后不能为空），描述沿用 Bundle 描述，之后都可修改。

ZIP 任一条目不合格时整个请求失败，不会创建 Bundle 或任何资源，Web 不需要做部分回滚。失败响应为 `400 BUNDLE_FILE_INVALID` 或 `413 BUNDLE_FILE_TOO_LARGE`，`errors[]` 的 `path` 是 ZIP 内的条目名（JSONL 某行出错时附 `:<行号>`；整个 Material 不合格时，如文件数或总大小超限，则是该 Material 的顶层名），`errMsg` 是原因；遇到第一个超限项时只返回该项（`413`）。素材 ZIP 中没有任何文件的顶层目录会被拒绝。Web 应逐条列出这些错误，让用户修正后重新上传整个 ZIP。导入没有幂等键：响应丢失后重试可能产生第二个 Bundle 或重复资源，应先刷新列表确认，再由用户删除多余项。

逐条上传的 Material 上传体是 `{name,description,files:[{path,mediaType,contentBase64}]}`。单文件也是长度为 1 的 `files`。目录上传时，Web 把选中的文件展开成数组，保留目录内相对路径；例如 `/brief.txt`、`/assets/logo.png`。`path` 必须以 `/` 开头，不接受空路径段、`.`、`..`、`.git` 或重复路径；空目录不能单独表示。`contentBase64` 是纯 Base64 字符串，不能带 `data:` 前缀；`mediaType` 必填。文件数量和大小上限见 [Dataset 上传契约](eval-dataset-upload.md)；超过单文件或总量上限返回 `413`。上传成功返回的 Material 带 `byteSize`（解码后字节数）。

Session 上传体是 `{name,description,format:"json"|"jsonl",content}`，`content` 同样是文件文本。JSON 格式的最小结构示例：

```json
{"entries":[{"id":"m1","createdAt":1,"message":{"role":"user","content":"之前的任务"}}]}
```

JSONL 则每行一条这样的 entry，而不是外层 `entries` 对象，整个文件仍是一个 Session。服务端先拒绝重复 JSON 字段，再检查规范历史格式：首条是 `user`，每条有不重复的 `id`、非负整数 `createdAt` 和允许的消息角色。Web 可先读取文件文本交给后端校验；不要把它当成普通 Prompt 字符串。格式与上限由 SP 的规范历史规则决定，见 [Dataset 上传契约](eval-dataset-upload.md)。

### 3. 给每条 Data 选择资源

导入成功后，在每条 Data 上提供三个独立的可选选择器：

| Data 字段 | 选择方式 | 值 | 可选来源 | 使用阶段 |
| --- | --- | --- | --- | --- |
| `initialMaterials`（执行素材） | 多选、有序 | `[{bundleId,materialId}, ...]` | 只列素材 Bundle 及其 Material | Subject 执行 |
| `evalInitialMaterials`（评估素材） | 多选、有序 | `[{bundleId,materialId}, ...]` | 只列素材 Bundle 及其 Material | Evaluator 评估 |
| `initialSession`（上下文） | 单选 | `{bundleId,sessionId}` | 只列上下文 Bundle 及其 Session | Subject 执行 |

素材选择器从 `GET /api/material-bundles` 选 Bundle、再从其 `materials` 选 Material，同一个选择器可以从不同素材 Bundle 中累加选择；上下文选择器从 `GET /api/session-bundles` 选 Bundle、再从其 `sessions` 选一个 Session。素材列表按用户排列的顺序提交，顺序会被保存；同一个 Material 在一个字段中只能出现一次，选择器应禁止重复选择。没有选中任何素材时提交 `null` 清空，不要提交空数组（`[]` 会被拒绝）。数组形状规则只以[包边界](package-boundaries.md#eval-dataset)为准。`bundleId` 填成另一类 Bundle 时后端返回 `404 BUNDLE_RESOURCE_NOT_FOUND`。上下文只有执行阶段可选，没有评估上下文字段。提交到 `PATCH /api/data/{dataId}/initial-resources`：

```json
{
  "initialMaterials": [
    { "bundleId": "<uuid>", "materialId": "<uuid>" },
    { "bundleId": "<另一个 uuid>", "materialId": "<uuid>" }
  ],
  "evalInitialMaterials": null,
  "initialSession": { "bundleId": "<uuid>", "sessionId": "<uuid>" }
}
```

请求只需包含本次要改变的字段；省略表示保持原绑定，`null` 表示清空，至少要提交一个字段。提交的素材数组整体替换该字段原有的全部素材，Web 增删其中一项时要提交完整的新数组。返回更新后的完整 Data。后端会检查资源存在、未删除且属于当前用户。同一字段绑定的所有 Material 解码后总大小不能超过 20 MB（SP 的 `EVAL_INITIALIZATION_MAX_BYTES`），超出时返回 `413 BUNDLE_FILE_TOO_LARGE`，`errors[0].path` 是该字段名；Material 记录的 `byteSize` 即其字节数，选择器可据此提前提示。通用 Data 创建、修改和导入同样执行这项检查。选择器应使用两类 Bundle、Material、Session 列表的 `name` 和 `description`，不要让用户填写 ID。

### 4. 管理评估输出格式并在评估计划中选择

输出格式是一个独立 JSON Schema 文件，不加入 Bundle，也不绑定到 Dataset 或 Data。上传时调用 `POST /api/evaluation-output-schemas`，体为 `{name,description,content}`；`content` 是 JSON Schema 文件文本。后端按 draft 2020-12 校验，保存解析后的 `schema`，返回 `outputSchemaId`。文件上限见 [Dataset 上传契约](eval-dataset-upload.md)。

Web 用 `GET /api/evaluation-output-schemas` 展示可选格式。输出格式是 Project 评估计划的一部分，评估计划体为 `{userAgentId, evaluationConcurrency, retryPolicy?, timeoutMs?, outputSchemaId}`：

- 创建 Project 时可放在 `POST /api/projects` 的 `evaluation` 字段中；首个 Run 选择执行并评估（`run.operation: "pipeline"`）时必填。
- 之后用 `PUT /api/projects/{projectId}/evaluation-plan` 整体替换评估计划，返回更新后的 Project 详情；没有“清空”操作。
- Project 详情的 `evaluation.plan.outputSchema` 是 `{outputSchemaId, digest}`。已有 Project 的只读查看通过 `GET /api/projects/{projectId}/evaluation-output-schema` 取得同一次摘要校验的引用与正文，目录软删除后仍可查看；新选择仍只列活动 Schema。
- 没有评估计划的 Project 启动执行并评估或仅评估返回 `409 PROJECT_EVALUATION_PLAN_REQUIRED`；首个带评估的 Run 准入后评估计划锁定，再替换返回 `409 PROJECT_EVALUATION_PLAN_LOCKED`，详情页应改为只读展示。

完整请求体、Project 详情结构和错误码见 [Eval HTTP 控制面](eval-http-api.md#projects)；评估计划的设计见 [Project、Runtime 与 Metrics 设计](eval-project-redesign.md)。

## 编辑、关联与删除规则

- 两类 Bundle、Material、Session 和输出格式的 `name`、`description` 可通过各自详情路由的 `PATCH` 修改，提交其中一个或两个字段即可，值必须非空白。详情路由分别是 `/api/material-bundles/{bundleId}`、`/api/material-bundles/{bundleId}/materials/{materialId}`、`/api/session-bundles/{bundleId}`、`/api/session-bundles/{bundleId}/sessions/{sessionId}`、`/api/evaluation-output-schemas/{outputSchemaId}`；它们也支持 `GET` 和 `DELETE`。上传后的文件或 Schema 正文不能修改；要换内容，创建新资源后重新绑定。
- Dataset 用 `PUT /api/datasets/{datasetId}` 全量替换可编辑字段。Prompt Dataset 的 `name`、`description` 始终必填。Data 用 `PUT /api/data/{dataId}` 全量替换；Web 从当前 Data 合并未改业务字段和资源引用，与四个可编辑字段一同保存。Prompt Dataset 成员的名称、描述和两个 Prompt 不能被改成空值。专用 `initial-resources` PATCH 供独立资源绑定调用使用，当前 Web 编辑器统一保存完整 Data。
- Data 可被同一用户的多个 Dataset 复用。`POST /api/datasets/{datasetId}/data` 用 `{dataIds:[...]}` 关联已有 Data；同一路径的 `DELETE` 解除关联。修改共享 Data 会影响所有引用它的 Dataset。
- 删除都是软删除，列表和详情不再返回已删除的资源，上传文件字节仍留在目录。Material、Session 及两类 Bundle 即使有 Data 绑定也允许删除，不要求先解绑；删除 Bundle 会把其中的活动资源一起标记删除。已有 Data 的同字段引用可继续保留、重排或移除，编辑和创建 Project 不受影响；新增绑定、跨字段移用或移除后重新绑定仍要求资源未删除。Web 保留目录外的当前绑定并说明它仍可使用，不请求已删除资源的目录文件。
- 输出格式的删除总是允许：已选用它的评估计划继续按 ID 读取 Schema，只是它不能再被新选择。
- Data 仍属于任一未删除 Dataset 时不能删除（`409 DATA_IN_USE`），先解除 Dataset 关联。Dataset 删除不受限制，也不会顺带删除可复用 Data。Project 保存的是 Dataset/Data 快照，目录中的修改和删除都不影响已有 Project，也从不因 Project 被阻止。

## 接口与页面实现提示

所有 `/api/*` 请求通过 Web Worker 的受信 gateway，以固定 Eval SP 服务账号运行；浏览器不持有该服务账号凭证，鉴权以 [Eval HTTP 控制面](eval-http-api.md) 为准。JSON 请求体必须使用 `Content-Type: application/json`；创建 Bundle 和导入 ZIP 使用 `multipart/form-data`（由浏览器 `FormData` 生成，不要手动设置边界）。Web 已提供四个数据入口，上传和选择的上限从 `GET /api/input-limits` 读取。信封、状态码和完整错误码目录以 HTTP 契约为准，要点如下：

- 成功：`{ "success": true, "msg": <数据>, "errMsg": "", "code": "" }`；创建返回 `201`，删除和 Dataset 关联变更返回空体 `204`。
- 失败：`{ "code", "errMsg", "requestId", "errors"?, "details"? }`，响应头 `X-Request-ID` 与 `requestId` 相同，便于反馈问题。按 `code` 区分原因，不解析 `errMsg` 文本；可用 `@eval-platform/eval-contracts/http-errors` 的 `decodeError` 解码。
- `422 REQUEST_VALIDATION_FAILED`：字段不合法，`errors[].path` 指向出错字段，可直接标注到表单。
- `400`：JSON 格式错误或重复字段（`REQUEST_INVALID_JSON`）、multipart 请求体无法解析（`REQUEST_INVALID_INPUT`），或通过格式校验后被业务规则拒绝（如 `DATASET_INPUT_INVALID`、`CATALOG_INPUT_INVALID`、`BUNDLE_FILE_INVALID`）。
- `401`：Worker 确认 takt 登录失效，需重新登录；`404`：资源不存在或不属于服务账号；`409`：用例仍属于活动数据集（`DATA_IN_USE`）或评估计划已锁定（`PROJECT_EVALUATION_PLAN_LOCKED`）等冲突；`413`：超过大小限制；`415`：`Content-Type` 与路由要求不符。ZIP 导入失败时按上文逐条展示 `errors[]`。
- `503`：Eval SP、数据库或 Bundle 目录暂不可用。GET 可重读；Bundle 创建和 ZIP 导入没有幂等键，提交结果未确认时先刷新检查目录，不能自动重发。Project/Run 创建则保留原请求体及幂等键重试。

删除收到 `409` 时保留当前列表状态，不要在 UI 中先把条目移除。

Web 最少需要完成以下闭环：

1. 上传 Prompt JSON/JSONL，并在 Dataset 列表和详情中显示 Dataset、Data 的名称与描述。
2. 分开的素材 Bundle 与上下文 Bundle 入口：创建（可附 ZIP）、导入 ZIP、逐条上传、列出 Material 或 Session，逐条上传素材支持单文件与目录文件数组；ZIP 失败时逐条展示条目错误。
3. 对每条 Data 独立绑定、改绑、清空执行素材（多选）、评估素材（多选）和执行上下文（单选）。
4. 上传、列出输出格式，并在 Project 创建或评估计划替换中选择其 ID；评估计划锁定后只读展示。
5. 提供元数据修改、关联解除和软删除入口；对 `422`、`409`、`404`、`413` 给出可操作的提示。

实现时可直接对照 [Dataset 模型](../packages/eval-dataset/src/dataset/model.ts)、[Prompt 文件解析](../packages/eval-dataset/src/dataset/serialization.ts)、[Dataset 路由](../apps/eval-api/src/routes/datasets/datasets.routes.ts)、[Data 路由](../apps/eval-api/src/routes/data/data.routes.ts)、[Bundle 路由](../apps/eval-api/src/routes/bundle-catalog.ts)（[素材 Bundle 配置](../apps/eval-api/src/routes/material-bundles/material-bundles.index.ts)、[上下文 Bundle 配置](../apps/eval-api/src/routes/session-bundles/session-bundles.index.ts)）、[输出格式路由](../apps/eval-api/src/routes/output-schemas/output-schemas.routes.ts)、[Project 路由](../apps/eval-api/src/routes/projects/projects.routes.ts)、[错误码目录](../packages/eval-contracts/src/http-errors.ts)和 [Bundle 文件校验](../apps/eval-api/src/sp/bundle-directory.ts)。后端已有单元及 PostgreSQL 集成测试；真实 Eval SP 跨部署联调仍需在接 Web 时验证。
