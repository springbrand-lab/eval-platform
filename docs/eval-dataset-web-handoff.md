# Dataset 层改造与 Web 接入说明

本文给后续实现 Dataset 页和 Project 输出格式选择的 Web 开发使用。接口事实以 [Dataset 上传契约](eval-dataset-upload.md)、[Eval HTTP 接口](eval-http-api.md)和当前代码为准。当前仓库的 `eval-web` 仍是骨架；本文描述的是已经实现的后端能力和 Web 需要接上的操作。

## 背景与目的

一次评估需要两类输入：每条样本的启动和评估 Prompt，以及可选的初始素材和初始上下文。用户要管理的是有名称、描述的 Dataset 和资源，运行时使用的是服务端生成的 ID。Project 还可以选择一份评估结果的 JSON Schema，约束评估 Agent 的输出格式。

这次改造把这些东西拆清楚了：

| 对象 | 用户看到什么 | 关系与用途 |
| --- | --- | --- |
| Dataset | 必填的 `name`、`description` | 一次 Prompt JSON/JSONL 导入产生一个 Dataset；它关联多条 Data，不隶属于 Project。 |
| Data | 每条必填的 `name`、`description`、`userPrompt`、`evalPrompt` | 一条可复用样本；可额外绑定执行素材、评估素材、执行上下文。同一用户的 Data 可以属于多个 Dataset。 |
| Bundle | 必填的 `name`、`description` | 资源分组。先创建空 Bundle，再逐条上传其中的资源；没有“上传整个 Bundle”的接口。 |
| Material | 必填的 `name`、`description` | Bundle 内的一条素材，可以是一个文件，也可以是一个目录下的多个文件。Data 绑定到具体 `bundleId + materialId`。 |
| Session | 必填的 `name`、`description` | Bundle 内的一份 JSON/JSONL 初始上下文。Data 绑定到具体 `bundleId + sessionId`，只用于 Subject 执行。 |
| 输出格式 | 必填的 `name`、`description` | 单独上传的一份 JSON Schema 文件，没有 Bundle。Project 只保存其 `outputSchemaId`。 |

ID 由后端生成，前端保存 ID 供请求使用，列表和选择器优先展示用户填写的名称、描述。Dataset、Data、Bundle、Material、Session 和输出格式的 ID 都是 UUID；路径和引用只接受 UUID（非 UUID 返回 `422`），可用大小写混合形式输入，保存和返回时统一为小写。资源元数据和 Data 绑定保存在 Eval 的 PostgreSQL；Material 文件和 Session 内容保存在 Eval 的 Bundle 目录。Web 只调用 Eval API，不直接访问该目录或 SP 的 DO 存储。

## 已完成的后端改造

- `eval-dataset` 已支持独立的 Prompt JSON/JSONL 上传解析、Dataset/Data 关联和通用 JSON/YAML 导入导出。Prompt Dataset 在导入后继续约束自身描述及成员 Data 的名称、描述和两个 Prompt；资源引用中的 UUID 在模型入口统一成小写。
- 标准 Eval API 已提供 Dataset/Data、Bundle/Material/Session、输出格式和 Project 格式绑定的路由。资源由已认证用户隔离；通用 Data 创建、修改和导入也会校验引用的资源属于该用户且仍可选。
- 相关数据库表、关联和软删除字段都在 `apps/eval-api/migrations-postgres/0000_initial.sql` 初始基线内。仍有活动绑定时阻止删除，并返回冲突；无级联清空绑定。
- API 上传的文件由 Eval Bundle 目录保存，标准 Run Worker 按 Data 的具体 Material/Session 引用取用；评估输出格式按 Project 保存的 ID 解析。执行和评估仍通过 SP 公开接口完成，Web 不需要实现文件目录或 SP 内部存储协议。

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
Authorization: Bearer <Eval SP session token>
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

### 2. 建资源目录，再逐条上传

用户可在导入 Dataset 前后管理资源。资源按当前登录用户共享，不属于某个 Dataset。流程是创建 Bundle，然后在该 Bundle 下每次上传一条 Material 或 Session。

| 操作 | 请求 | Web 处理 |
| --- | --- | --- |
| 创建与选择 Bundle | `POST /api/bundles`，`GET /api/bundles` | 创建体 `{name,description}`；列表显示名称和描述。 |
| 上传与选择 Material | `POST /api/bundles/{bundleId}/materials`，`GET /api/bundles/{bundleId}/materials` | 每次上传一条；返回 `materialId`。 |
| 上传与选择 Session | `POST /api/bundles/{bundleId}/sessions`，`GET /api/bundles/{bundleId}/sessions` | 每次上传一份上下文；返回 `sessionId`。 |

Material 上传体是 `{name,description,files:[{path,mediaType,contentBase64}]}`。单文件也是长度为 1 的 `files`。目录上传时，Web 把选中的文件展开成数组，保留目录内相对路径；例如 `/brief.txt`、`/assets/logo.png`。`path` 必须以 `/` 开头，不接受空路径段、`.`、`..`、`.git` 或重复路径；空目录不能单独表示。`contentBase64` 是纯 Base64 字符串，不能带 `data:` 前缀；`mediaType` 必填。文件数量和大小上限见 [Dataset 上传契约](eval-dataset-upload.md)；超过单文件或总量上限返回 `413`。

Session 上传体是 `{name,description,format:"json"|"jsonl",content}`，`content` 同样是文件文本。JSON 格式的最小结构示例：

```json
{"entries":[{"id":"m1","createdAt":1,"message":{"role":"user","content":"之前的任务"}}]}
```

JSONL 则每行一条这样的 entry，而不是外层 `entries` 对象。服务端检查规范历史格式：首条是 `user`，每条有不重复的 `id`、非负整数 `createdAt` 和允许的消息角色。Web 可先读取文件文本交给后端校验；不要把它当成普通 Prompt 字符串。格式与上限由 SP 的规范历史规则决定，见 [Dataset 上传契约](eval-dataset-upload.md)。

### 3. 给每条 Data 选择资源

导入成功后，在每条 Data 上提供三个独立的可选选择器：

| Data 字段 | 选择粒度 | 使用阶段 |
| --- | --- | --- |
| `initialMaterials` | `{bundleId,materialId}` | Subject 执行 |
| `evalInitialMaterials` | `{bundleId,materialId}` | Evaluator 评估 |
| `initialSession` | `{bundleId,sessionId}` | Subject 执行 |

三个选择器可以选择不同 Bundle 下的资源。上下文只有执行阶段可选，没有评估上下文字段。提交到 `PATCH /api/data/{dataId}/initial-resources`：

```json
{
  "initialMaterials": { "bundleId": "<uuid>", "materialId": "<uuid>" },
  "evalInitialMaterials": null
}
```

请求只需包含本次要改变的字段；省略表示保持原绑定，`null` 表示清空，至少要提交一个字段。返回更新后的完整 Data。后端会检查资源存在、未删除且属于当前用户；Material 还会检查已上传文件可读取。选择器应使用 Bundle/Material/Session 列表的 `name` 和 `description`，不要让用户填写 ID。

### 4. 管理评估输出格式与 Project 绑定

输出格式是一个独立 JSON Schema 文件，不加入 Bundle，也不绑定到 Dataset 或 Data。上传时调用 `POST /api/evaluation-output-schemas`，体为 `{name,description,content}`；`content` 是 JSON Schema 文件文本。后端按 draft 2020-12 校验，保存解析后的 `schema`，返回 `outputSchemaId`。文件上限见 [Dataset 上传契约](eval-dataset-upload.md)。

Web 用 `GET /api/evaluation-output-schemas` 展示可选格式，再对 Project 调用 `PUT /api/projects/{projectId}/evaluation-output-schema`，体为 `{ "outputSchemaId": "<uuid>" }`。清空选择提交 `{ "outputSchemaId": null }`。Project 列表/详情展示所绑定的 ID；Web 可用格式列表按 ID 找到名称和描述。Project 不保存 Schema 正文。启动 Evaluation 或 Pipeline 前，Project 必须选定输出格式；首次 Evaluation Run 准入后，这个 ID 不能再改或清空，API 会返回 `409`。

## 编辑、关联与删除规则

- Bundle、Material、Session 和输出格式的 `name`、`description` 可通过各自详情路由的 `PATCH` 修改，提交其中一个或两个字段即可，值必须非空白。详情路由分别是 `/api/bundles/{bundleId}`、`/api/bundles/{bundleId}/materials/{materialId}`、`/api/bundles/{bundleId}/sessions/{sessionId}`、`/api/evaluation-output-schemas/{outputSchemaId}`；它们也支持 `GET` 和 `DELETE`。上传后的文件或 Schema 正文不能修改；要换内容，创建新资源后重新绑定。
- Dataset 用 `PUT /api/datasets/{datasetId}` 全量替换可编辑字段。Prompt Dataset 的 `name`、`description` 始终必填。Data 用 `PUT /api/data/{dataId}` 全量替换；Web 必须从当前 Data 合并未改字段再提交，否则省略的 Prompt、业务字段或资源引用会被移除。Prompt Dataset 成员的名称、描述和两个 Prompt 不能被改成空值。只改资源 ID 时优先用上面的专用 `PATCH`。
- Data 可被同一用户的多个 Dataset 复用。`POST /api/datasets/{datasetId}/data` 用 `{dataIds:[...]}` 关联已有 Data；同一路径的 `DELETE` 解除关联。修改共享 Data 会影响所有引用它的 Dataset。
- 删除都是软删除，列表和详情不再返回已删除的资源，上传文件字节仍留在目录。只要任一**活动 Data** 仍引用 Material、Session 或 Bundle 内的资源，相应删除就返回 `409`；即使该 Data 当前不属于任何 Dataset，也算绑定。Web 应先清空或改绑相关 Data，再重试删除。删除 Bundle 会把其 Material 和 Session 一起标记删除。
- 输出格式仍被任一 Project 绑定时，删除返回 `409`。先将 Project 改绑或清空；如果该 Project 已有 Evaluation Run，绑定已锁定，清空也会返回 `409`。
- Data 被活动 Dataset 或 Sample 引用时不能删除；先解除 Dataset 关联。当前没有 Sample 删除接口，已有 Sample 引用的 Data 不能通过本页删除。Dataset 被 Execution Config 选用时不能删除。`DELETE /api/datasets/{id}` 不会顺带删除可复用 Data。

## 接口与页面实现提示

所有 `/api/*` 请求都带 Eval SP 会话的 `Authorization: Bearer`，浏览器请求的 `Origin` 必须是部署配置的 Eval Web 来源，否则返回 `403`。JSON 请求体必须使用 `Content-Type: application/json`。当前 `eval-web` 还没有页面实现。信封、状态码和完整错误码目录以 [Eval HTTP 控制面](eval-http-api.md) 为准，要点如下：

- 成功：`{ "success": true, "msg": <数据>, "errMsg": "", "code": "" }`；创建返回 `201`，删除和 Dataset 关联变更返回空体 `204`。
- 失败：`{ "code", "errMsg", "requestId", "errors"? }`，响应头 `X-Request-ID` 与 `requestId` 相同，便于反馈问题。按 `code` 区分原因，不解析 `errMsg` 文本；可用 `@eval-platform/eval-contracts/http-errors` 的 `decodeError` 解码。
- `422 REQUEST_VALIDATION_FAILED`：字段不合法，`errors[].path` 指向出错字段，可直接标注到表单。
- `400`：JSON 格式错误或重复字段（`REQUEST_INVALID_JSON`），或通过格式校验后被业务规则拒绝（如 `DATASET_INPUT_INVALID`、`CATALOG_INPUT_INVALID`、`BUNDLE_FILE_INVALID`）。
- `401`：会话无效，需重新登录；`404`：资源不存在或不属于当前用户；`409`：仍有绑定（如 `BUNDLE_RESOURCE_IN_USE`、`OUTPUT_SCHEMA_IN_USE`、`DATA_IN_USE`）或输出格式已锁定（`PROJECT_OUTPUT_SCHEMA_CONFLICT`）等冲突；`413`：超过大小限制；`415`：`Content-Type` 不是 JSON。
- `503`：Eval SP、数据库或 Bundle 目录暂不可用，可稍后原样重试。

删除收到 `409` 时保留当前列表状态，不要在 UI 中先把条目移除。

Web 最少需要完成以下闭环：

1. 上传 Prompt JSON/JSONL，并在 Dataset 列表和详情中显示 Dataset、Data 的名称与描述。
2. 创建 Bundle，分别上传、列出、选择 Material 和 Session；支持单文件与目录文件数组。
3. 对每条 Data 独立绑定、改绑、清空执行素材、评估素材和执行上下文。
4. 上传、列出输出格式，并在 Project 上绑定或清空其 ID。
5. 提供元数据修改、关联解除和软删除入口；对 `422`、`409`、`404`、`413` 给出可操作的提示。

实现时可直接对照 [Dataset 模型](../packages/eval-dataset/src/dataset/model.ts)、[Prompt 文件解析](../packages/eval-dataset/src/dataset/serialization.ts)、[Dataset 路由](../apps/eval-api/src/routes/datasets/datasets.routes.ts)、[Data 路由](../apps/eval-api/src/routes/data/data.routes.ts)、[资源路由](../apps/eval-api/src/routes/bundles/bundles.routes.ts)、[输出格式路由](../apps/eval-api/src/routes/output-schemas/output-schemas.routes.ts)、[错误码目录](../packages/eval-contracts/src/http-errors.ts)和 [Bundle 文件校验](../apps/eval-api/src/sp/bundle-directory.ts)。后端已有单元及 PostgreSQL 集成测试；真实 Eval SP 跨部署联调仍需在接 Web 时验证。
