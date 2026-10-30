# @eval-platform/eval-dataset

Data 的 `initialMaterials` 只给执行 Agent，`evalInitialMaterials` 只给评估 Agent。两者都是同样形状的 owner-scoped 素材 Bundle（Material Bundle）素材引用列表，上传和绑定方式相同；评估输出 JSON Schema 由 Project 的评估计划引用，不存在 Data 内。

## 职责与文件

本包只管理可编辑的来源 Dataset、可复用 Data 及二者的关联，不管理用户、Project、ProjectSample、Sampling、Agent 或评估结果，不引入 version。创建 Project 时 Eval API 在一次一致读取中把所选 Dataset 元数据、成员顺序和完整 Data 复制进 Project 快照；之后对 Dataset/Data 的修改、解除关联或软删除都不影响已有 Project。Eval API 注入按已认证用户限定的 Store；同一用户的 Data 可复用于其多个 Dataset，不可跨用户关联。用户身份与授权由应用和 PostgreSQL 保证，不写进 Data 业务 JSON。

- `dataset/model.ts`：严格 Zod schema、模型和输入类型，以及所有平台 UUID 共用的 `platformIdSchema`。模型从 schema 推导，不维护第二份校验规则。
- `dataset/input.ts`：把任何用户输入失败统一为 `DatasetInputError`，保留原始 cause。
- `dataset/serialization.ts`：JSON/YAML 文档解析与序列化，以及拒绝重复字段的 `parseStrictJson`（Eval API 读取 JSON 请求体也使用它），只处理文本和模型，不访问存储。
- `dataset/store.ts`：持久化接口及领域错误，规定数据库必须保证的原子操作。
- `dataset/index.ts`：`createDatasetService(store)`，提供创建、全量修改、查询、关联、删除和导入导出。

本包只有包根入口。

## Data 输入

每条 Data 的输入约定：

- `userPrompt`：必填的当前用户任务，必须是非空白字符串，保留原始文本，不从其他字段推导。
- `evalPrompt`：可选的本条 Data 的评估任务提示词；提供时必须是非空白字符串并原样保存。只执行不要求此字段；启动 pipeline 或 evaluation Run 时，涉及的每个 ProjectSample 的 Data 副本都必须提供，不能退回使用 Subject 的 `userPrompt`。
- `initialSession`：可选的初始 Session 引用，必须包含 Eval API 资源目录生成的上下文 Bundle（Session Bundle）`bundleId` 和 `sessionId`；上下文由 Eval 的上下文 Bundle 上传接口保存为 JSON/JSONL，可为空，SP 仅在提供时导入目标 Chat。
- `initialMaterials`：可选的 Subject 初始素材引用数组，每项必须包含资源目录生成的素材 Bundle `bundleId` 和 `materialId`，定位该 Bundle 内的具体素材资源。数组非空、有序、同一字段内不重复，各项可来自不同素材 Bundle；完整规则见[包边界](../../docs/package-boundaries.md#eval-dataset)。
- `evalInitialMaterials`：可选的 Evaluator 初始素材引用数组，规则与 `initialMaterials` 相同，与 Subject 素材分开。
- 其他业务字段：可以直接放在 Data 上，例如 `requirements`、`expectedOutput`、`tags` 或 `json`，只要求值可无损表示为 JSON。创建、修改、持久化、导入导出和运行时输入准备都保留这些字段，不丢弃、不改名，也不强制放进某个额外容器。

数值使用有限的 JavaScript Number；整数必须在 `Number.MIN_SAFE_INTEGER` 到 `Number.MAX_SAFE_INTEGER` 之间。超出范围的大整数业务 ID 必须由调用方以字符串提供，解析、创建、修改和导出都直接拒绝不安全整数，不自动截断、舍入或转换为字符串。YAML 整数先按 BigInt 解析，确认安全范围后才转为 Number。

业务字段 `sampleId` 可以正常使用。Runtime 的 ProjectSample 采用 `{ projectSampleId, projectId, dataId, datasetIds, samplingCount, data: Data }`，平台身份与 Project 创建时的完整 Data 副本分开，不覆盖或删除 `data.sampleId`；Sampling 只持久化 `projectSampleId`，不复制 Data。

如提供 `externalDataId`、`metadata` 等字段，它们也是用户自定义 JSON 业务字段，不作为平台主键或全局唯一约束。素材和 Session 正文不嵌入引用。本包不上传文件、不访问 R2、不直接读写 DO，不生成 manifest 或 hash，也不建立第二套 Session 存储。Runtime/Harness 使用 SP 的公开初始化能力，把输入物化到 Agent 的存储中。

初始 Session 的写法：

```json
"initialSession": {
  "bundleId": "5b0f3c1e-8a52-4d6e-9f3a-2c7d1e4b6a90",
  "sessionId": "0e9d6c4b-3f1a-4b2e-8c7d-5a6f9e1b2c3d"
}
```

`bundleId` 定位 Bundle，`sessionId` / `materialId` 定位其中的具体资源；素材和 Session 分属两类互相独立的 Bundle，因此同一条 Data 的素材与 Session 引用使用不同的 `bundleId`（类型规则见 [Dataset upload](../../docs/eval-dataset-upload.md)）。引用中的 ID 都必须是 `platformIdSchema` 接受的 UUID，规范为小写，Dataset 核心不会生成、推导或补齐。不接受只有 Bundle 的引用、内嵌正文或生成器配置。生产用的 Eval API Store 还会校验资源属于当前用户且未删除，通用 Data 创建、修改、导入也不能绕过该检查；已被 Project 快照引用的资源在目录中软删除后仍可按 ID 读取。

`sessionId` 标识已保存的初始化 Session 资源，不是此次运行的 Chat/Submission ID。Dataset 只校验和保存引用，不解析原生 Session 或维护消息格式。`userPrompt` 表示当前新任务；初始 Session 表示已有历史，不作为新任务再次发送。

启动时 Harness 按 ProjectSample 中 Data 副本的引用从 Eval Bundle 目录读取素材，并通过 SP 公开接口写入目标 Chat 的 Workspace。存在初始 Session 上下文时，通过同一初始化调用导入 Chat；没有正文时只保留引用。准备完成后才能提交新任务。每个 Sampling 独立物化，不能直接操作共享源 Session；eval 不实现框架恢复或 SP 内核。

## 管理入口

`createDatasetService(store)` 的公共方法：

- `createDataset(input)`、`updateDataset(datasetId, input)`、`getDataset(datasetId)`、`listDatasets()`、`deleteDataset(datasetId)`。
- `createData(input, options?)`、`updateData(dataId, input)`、`getData(dataId)`、`listData(datasetId?)`、`deleteData(dataId)`。可选 `options.datasetId` 让创建与加入目标 Dataset 在同一 Store 事务完成；目标必须自有且未软删除，Prompt Dataset 仍校验四个必选字段。任一步失败不留下孤立 Data。省略目标则独立创建 Data。
- `attachData(datasetId, dataIds)`、`detachData(datasetId, dataIds)`。
- `importDataset(source, format)`、`exportDataset(datasetId, format)`，format 必须明确为 `json` 或 `yaml`。
- `importPromptDataset({name,description,format,content})`：Dataset 元数据独立于文件，JSON 文件是 Data 数组，JSONL 每行一条 Data；每条都要求 `name`、`description`、`userPrompt` 和 `evalPrompt`，一次原子导入。Store 记录 Prompt Dataset 的内部种类，后续修改和关联 Data 时继续校验这些必填字段。详见 [Dataset upload](../../docs/eval-dataset-upload.md)。

Eval API 的受信管理准备流程可在 `importPromptDataset(input, {datasetId,dataIds})` 的第二参数中传入**已持久规划的** UUID。它仍先用相同的 Prompt 解析器拒绝文件里的 ID 与初始引用；Data ID 数量必须与行数一致，由已有 Store 的原子、身份相等导入处理未知响应与重放。普通 HTTP prompt-import 不提供这些身份，行为不变。

Dataset/Data 的新实体 ID 使用原生 `crypto.randomUUID()`，与 SP 的 ID 生成方式一致；两类 Bundle、Session 和素材 ID 由 Eval API 资源目录生成。平台 Dataset/Data ID 与资源引用 ID 都由同一个 `platformIdSchema` 按 SP 的 Zod UUID 校验与小写规范化模式处理：导入可接受大小写混合的 UUID，查重、Store 比较、目录读取、绑定删除检查、查询和返回值统一使用小写身份；Data 业务字段保持原值。创建实体时输入不允许调用方覆盖实体 ID。修改是全量替换可编辑字段，不是 PATCH；省略可选字段表示移除该字段。查询不存在的单个实体返回 null。数据库读写失败原样抛出，不能转成空结果。

Data 可以关联到同一用户的多个 Dataset，关联不复制 Data。修改 Data 会影响该用户所有引用它的 Dataset，但不影响已有 Project。重复关联和重复解除关联不报错，批量关联必须全成功或全失败。Eval API 删除 Dataset/Data 时设置 `deleted_at`，不删除行；被活动 Dataset 引用的 Data 不能删除，Project 保存的是 Data 副本，不阻止删除。删除已不存在的实体是无操作。Dataset 列表和未指定 Dataset 的全局 Data 列表按实体 ID 稳定排序；指定 Dataset 的 `listData(datasetId)` / `getDatasetSnapshot` / 导出按已验证的成员上传/新增顺序，老关联无法证明时采用确定性的回退顺序，**不**宣称 UUID 最小的是原始文件第一条。查询不存在 Dataset 的 Data 列表应抛出 `DatasetEntityNotFoundError`，不能伪装成空集合。

## 文档格式

JSON 和 YAML 使用同一个结构：

```json
{
  "dataset": { "name": "网站任务", "description": "内部评估数据" },
  "data": [
    {
      "userPrompt": "沿用现有项目风格完成首页",
      "evalPrompt": "检查首页是否满足响应式和无障碍要求，并说明依据",
      "requirements": { "responsive": true },
      "initialSession": {
        "bundleId": "5b0f3c1e-8a52-4d6e-9f3a-2c7d1e4b6a90",
        "sessionId": "0e9d6c4b-3f1a-4b2e-8c7d-5a6f9e1b2c3d"
      },
      "initialMaterials": [
        {
          "bundleId": "3a8d6f2b-9c41-4e7a-b5d0-6f1e2c9a4b83",
          "materialId": "7c2a9e5f-1d3b-4a6c-8e0f-9b4d2c6a1e57"
        },
        {
          "bundleId": "8f4e2a1c-6b3d-4c5e-9a7f-1d2b3c4e5f60",
          "materialId": "2d6b8f1a-4c3e-4f7a-9b5d-0e1c2a3b4d5f"
        }
      ]
    }
  ]
}
```

解析不会生成 ID 或写入数据库；已提供的平台 ID 在解析时规范为小写。导入时为缺失的 `datasetId`、`dataId` 生成 UUID，返回包含小写实际 ID 的 `DatasetSnapshot`。导出保留全部 ID，能够恢复共享关系。没有 ID 的同一文档再次导入会创建新实体；需要原身份恢复时应使用导出文档。

整个导入必须一次原子提交：新 Dataset 可以复用已有、内容完全相同的 Data ID；同一个 ID 对应不同内容时抛出 `DatasetIdentityConflictError`，不覆盖原记录。已有 Dataset 只有在元数据、Data ID 集合和每条 Data 内容都相同，且已验证的成员位置与原文件顺序一致时才视为重复导入；顺序不同或内容不同都整批拒绝。旧 Dataset 的成员位置未知时仅能核对身份和内容，不能推断旧文件顺序。一个文档内不能重复声明同一个 Data ID。**首次成功导入**时，Eval API 的 Store 按文档/Prompt 文件里的 Data 数组顺序保存成员位置（不是 ID 排序）；同一文件的重放不改写首次已保存的位置。新建单个 Data、批量新增、关联已有 Data 按请求顺序追加（已有成员重复关联不变）。`DatasetSnapshot` 不增添成员位置字段，Data 业务 JSON 也不承担这个内部关系事实。

Dataset、文档外壳和资源引用使用严格 schema；Data 允许任意其他 JSON 业务字段，但 `userPrompt`、`evalPrompt` 和资源引用仍按明确契约校验。Data 输入不能用扩展字段覆盖平台生成的 `dataId`，原身份恢复只通过带 ID 的导入文档。错误的对象/数组形状、空白 prompt 和不能无损表示为 JSON 的值都会失败。JSON 和 YAML 都拒绝同一个对象内的重复字段名，包括转义后相同的 JSON 字段名；不同对象使用相同字段名不构成冲突。JSON 不接受注释、尾逗号或其他 JSONC 扩展。YAML 使用严格模式，拒绝非字符串映射键、未知 tag、多文档和 alias；序列化不会输出 alias。文本数据与素材引用不会被隐式转换或下载。

## Store 与 SP 对齐

`DatasetStore` 是注入的持久化边界，不是内存数据库，也不是 DO/R2 实现。应用层应使用已有 PostgreSQL 设施实现它，沿用 SP 的事务、数据库唯一约束和外键约束模式：

- Dataset/Data 主键唯一，关联键 `(datasetId, dataId)` 唯一。
- 关联两端必须存在；创建、修改、批量关联、导入和带关联约束的删除都在数据库边界保证原子性，不能以服务层“先查询，再分别写入”代替事务。
- 删除 Data 的引用检查和删除必须是同一个受保护操作；并发新增关联不能绕过限制。
- `getDatasetSnapshot()` 必须返回同一读取时点的 Dataset、关联和 Data 内容，不能拼接不同读取时点的结果。应用 Store 的 nullable 关联位置仅证明新写入顺序；旧 `NULL` 不填假值。旧 Moss `prepare` 的 owner-scoped completed `plan.dataIds` 在完整成员身份/receipt 证明成立时可作为只读回退；其他旧 Dataset 的原始文件顺序不可恢复，管理选项会显式返回 `order:"unknown"`。
- 领域失败使用 `DatasetEntityNotFoundError`、`DatasetIdentityConflictError`、`DataInUseError`，用户输入失败使用 `DatasetInputError`；不引入 HTTP 错误或掩盖未知 I/O 错误。

本包不依赖 SP 包，也不复制 SP 的数据库实现。它使用原生 UUID/JSON、Zod/YAML 和 `jsonc-parser` 的严格遍历能力检查重复 JSON 字段，并在自己的 Zod schema 中沿用 SP 已采用的 UUID 校验与小写规范化模式；真实数据库客户端、事务执行和 Workspace 素材能力由其所属边界提供。


数据集维护：DatasetService.addData(datasetId, inputs) 校验全部输入并生成身份，DatasetStore.createDataBatch 在一个事务中创建全部 Data 及其关联，失败不保留部分用例。HTTP `POST /api/datasets/{datasetId}/data/import` 接受 `{format: "json" | "jsonl", content: string}`，采用用例列表的严格解析、资源引用限制及 prompt 文件/请求大小上限；返回 201 Data[]。原有完整文档导入的身份冲突和重放语义不变。Web 导航调整不改变 Subject/Evaluator、资源引用和项目冻结副本契约。
