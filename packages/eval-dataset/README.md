# @eval-platform/eval-dataset

## 职责与文件

本包只管理全局 Dataset、可复用 Data 及二者的关联，不管理用户、Project、Sample、Sampling、Agent 或评估结果，不引入 version。

- `dataset/model.ts`：严格 Zod schema、模型和输入类型。模型从 schema 推导，不维护第二份校验规则。
- `dataset/serialization.ts`：JSON/YAML 文档解析与序列化，只处理文本和模型，不访问存储。
- `dataset/store.ts`：持久化接口及领域错误，规定数据库必须保证的原子操作。
- `dataset/index.ts`：`createDatasetService(store)`，提供创建、全量修改、查询、关联、删除和导入导出。

包根入口与 `./dataset` 导出完整公共能力；`./model`、`./dataset/model`、`./dataset/serialization`、`./dataset/store` 支持按职责导入。

## Data 输入

每条 Data 的输入约定：

- `userPrompt`：必填的当前用户任务，必须是非空白字符串，保留原始文本，不从其他字段推导。
- `initialSession`：可选的初始 Session 引用，必须包含外部给定的 `bundleId` 和 `sessionId`；正文由 SP 的既有 Bundle/Session 能力独立保存，可以包含完整的原生会话、工具调用和恢复信息。
- `initialMaterials`：可选的初始素材集合引用，必须包含外部给定的 `bundleId` 和 `materialId`，定位 Bundle 内的具体素材资源。
- 其他业务字段：可以直接放在 Data 上，例如 `requirements`、`expectedOutput`、`tags` 或 `json`，只要求值可无损表示为 JSON。创建、修改、持久化、导入导出和运行时输入准备都保留这些字段，不丢弃、不改名，也不强制放进某个额外容器。

数值使用有限的 JavaScript Number；整数必须在 `Number.MIN_SAFE_INTEGER` 到 `Number.MAX_SAFE_INTEGER` 之间。超出范围的大整数业务 ID 必须由调用方以字符串提供，解析、创建、修改和导出都直接拒绝不安全整数，不自动截断、舍入或转换为字符串。YAML 整数先按 BigInt 解析，确认安全范围后才转为 Number。

业务字段 `sampleId` 可以正常使用。Runtime 的平台 Sample 采用 `{ sampleId, data: Data }`，平台身份与完整业务内容分开，不覆盖或删除 `data.sampleId`；Sampling 仍只持久化平台身份，不复制 Data。

如提供 `externalDataId`、`metadata` 等字段，它们也是用户自定义 JSON 业务字段，不作为平台主键或全局唯一约束。素材和 Session 正文不嵌入引用。本包不上传文件、不访问 R2、不直接读写 DO，不生成 manifest 或 hash，也不建立第二套 Session 存储。Runtime/Harness 使用 SP 的公开初始化能力，把输入物化到 Agent 的存储中。

初始 Session 的写法：

```json
"initialSession": { "bundleId": "sessions-bundle", "sessionId": "seed-session" }
```

`bundleId` 定位外部 Bundle，`sessionId` / `materialId` 定位其中的具体资源；这两个引用的所有 ID 都必须由调用方提供，Dataset 创建、修改、导入不会生成、推导、补齐或转换它们。不接受只有 Bundle 的引用、内嵌正文或生成器配置。ID 不允许空白或前后空格，校验通过后原样保存。

`sessionId` 标识已保存的初始化 Session 资源，不是此次运行的 Chat/Submission ID。Dataset 只校验和保存引用，不解析原生 Session 或维护消息格式。`userPrompt` 表示当前新任务；初始 Session 表示已有历史，不作为新任务再次发送。

启动时 Harness 先把初始素材与 Session 副本物化到目标 DO 的存储，再由选定框架加载 Session 并重建 Context，完成后才能提交新任务。每个 Sampling 独立恢复自己的副本，不能直接操作共享源 Session。本文假设 SP 已具备完整的公开初始化能力，不在 eval 实现框架恢复或 SP 内核。

## 管理入口

`createDatasetService(store)` 的公共方法：

- `createDataset(input)`、`updateDataset(datasetId, input)`、`getDataset(datasetId)`、`listDatasets()`、`deleteDataset(datasetId)`。
- `createData(input)`、`updateData(dataId, input)`、`getData(dataId)`、`listData(datasetId?)`、`deleteData(dataId)`。
- `attachData(datasetId, dataIds)`、`detachData(datasetId, dataIds)`。
- `importDataset(source, format)`、`exportDataset(datasetId, format)`，format 必须明确为 `json` 或 `yaml`。

Dataset/Data 的新实体 ID 使用原生 `crypto.randomUUID()`，与 SP 的 ID 生成方式一致；这不包括外部 Bundle、Session 或素材 ID。创建实体时输入不允许调用方覆盖实体 ID。修改是全量替换可编辑字段，不是 PATCH；省略可选字段表示移除该字段。查询不存在的单个实体返回 null。数据库读写失败原样抛出，不能转成空结果。

Data 可以关联到多个 Dataset，关联不复制 Data。全局修改 Data 会影响所有引用它的 Dataset。重复关联和重复解除关联不报错，批量关联必须全成功或全失败。删除 Dataset 只移除 Dataset 和关联，不删除 Data；被任意 Dataset 引用的 Data 不能删除。删除已不存在的实体是无操作。列表必须按实体 ID 稳定排序；查询不存在 Dataset 的 Data 列表应抛出 `DatasetEntityNotFoundError`，不能伪装成空集合。

## 文档格式

JSON 和 YAML 使用同一个结构：

```json
{
  "dataset": { "name": "网站任务", "description": "内部评估数据" },
  "data": [
    {
      "userPrompt": "沿用现有项目风格完成首页",
      "requirements": { "responsive": true },
      "initialSession": { "bundleId": "sessions-bundle", "sessionId": "homepage-seed-session" },
      "initialMaterials": { "bundleId": "project-assets", "materialId": "homepage-files" }
    }
  ]
}
```

解析不会生成 ID 或写入数据库。导入时为缺失的 `datasetId`、`dataId` 生成 UUID，返回包含实际 ID 的 `DatasetSnapshot`。导出保留全部 ID，能够恢复共享关系。没有 ID 的同一文档再次导入会创建新实体；需要原身份恢复时应使用导出文档。

整个导入必须一次原子提交：新 Dataset 可以复用已有、内容完全相同的 Data ID；同一个 ID 对应不同内容时抛出 `DatasetIdentityConflictError`，不覆盖原记录。已有 Dataset 只有在元数据、Data ID 集合和每条 Data 内容都相同时才视为重复导入，Data 的排列顺序不构成冲突；否则整批拒绝。一个文档内不能重复声明同一个 Data ID。

Dataset、文档外壳和资源引用使用严格 schema；Data 允许任意其他 JSON 业务字段，但 `userPrompt` 和资源引用仍按明确契约校验。Data 输入不能用扩展字段覆盖平台生成的 `dataId`，原身份恢复只通过带 ID 的导入文档。错误的对象/数组形状、空白 prompt 和不能无损表示为 JSON 的值都会失败。JSON 和 YAML 都拒绝同一个对象内的重复字段名，包括转义后相同的 JSON 字段名；不同对象使用相同字段名不构成冲突。JSON 不接受注释、尾逗号或其他 JSONC 扩展。YAML 使用严格模式，拒绝非字符串映射键、未知 tag、多文档和 alias；序列化不会输出 alias。文本数据与素材引用不会被隐式转换或下载。

## Store 与 SP 对齐

`DatasetStore` 是注入的持久化边界，不是内存数据库，也不是 DO/R2 实现。应用层应使用已有 PostgreSQL 设施实现它，沿用 SP 的事务、数据库唯一约束和外键约束模式：

- Dataset/Data 主键唯一，关联键 `(datasetId, dataId)` 唯一。
- 关联两端必须存在；创建、修改、批量关联、导入和带关联约束的删除都在数据库边界保证原子性，不能以服务层“先查询，再分别写入”代替事务。
- 删除 Data 的引用检查和删除必须是同一个受保护操作；并发新增关联不能绕过限制。
- `getDatasetSnapshot()` 必须返回同一读取时点的 Dataset、关联和 Data 内容，不能拼接不同读取时点的结果。
- 领域失败使用 `DatasetEntityNotFoundError`、`DatasetIdentityConflictError`、`DataInUseError`；不引入 HTTP 错误或掩盖未知 I/O 错误。

SP 的 `@springbrand/utils` 和数据库客户端目前是其私有 workspace，不能跨仓库导入私有源码或复制这些实现。本包使用原生 UUID/JSON、Zod/YAML 和 `jsonc-parser` 的严格遍历能力检查重复 JSON 字段，不自己实现 JSON 语法解析器；真实数据库客户端、事务执行和 Workspace 素材能力由其所属边界提供。
