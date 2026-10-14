# eval-dataset 评审记录

> 评审对象：`packages/eval-dataset`
>
> 记录日期：2026-10-08
>
> 记录性质：逐项记录发现、复现证据、讨论结论和处理状态；发现不等于用户已确认。

## 评审方式

- 完整检查包内实现和直接消费契约，但每次只向用户讨论一条真实问题。
- 新发现先记为“待确认”；用户认可后标为“已确认”，不把未讨论项当作既定结论。
- 用户不认可的项目保留讨论结果和排除理由，不反复换说法重新提出。
- 确认的问题继续记录方案讨论、后续修复和再次 review 的结果。
- 只修改评审文档；修改业务代码需要用户另行明确授权。
- 不为凑数量提出理论风险、无意义抽象或已明确排除的问题；没有其他真实问题就结束。

## 边界与原则

- 保持现有分包及其职责，不重新拆包，不照搬 pydantic 实现。
- Dataset 按 Eval SP 用户隔离，同一用户的 Data 可复用；本包不管理 Project、Sample、Sampling、Agent、Submission、产物、轨迹或评分，用户归属由应用 Store 保证。
- 以零技术负债、唯一真相、逻辑清晰和长期可维护为判断标准，不局限于最小补丁。
- 复用 SP 的公开基础设施，不复制私有实现，不直接访问 SP Durable Object 存储。
- 真实 Store、数据库事务实现和 SP 生产化接入不作为本包当前核心代码的阻塞项；现有接口本身的真实缺陷仍需评审。

## 问题索引

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| D-01 | JSON/YAML 导入大整数时静默丢失精度 | 已修复，复审通过 |
| D-02 | JSON 导入接受同一对象内的重复字段名，并静默覆盖前值 | 已修复，复审通过 |
| D-03 | Data 接受业务字段 sampleId，但 Runtime 的同名身份字段与其冲突，Agent 输入丢失该字段 | 已修复，复审通过 |

## 逐项记录

### D-01：JSON/YAML 导入大整数时静默丢失精度（已修复，复审通过）

**严重程度**：P1。该缺陷会静默改写输入并把错误值交给 Store，属于数据完整性问题，不是普通的格式校验提示缺失。

**相关位置（发现时）**

- `packages/eval-dataset/src/dataset/serialization.ts:12`：JSON 直接通过 `JSON.parse()` 转为 JavaScript 值。
- `packages/eval-dataset/src/dataset/serialization.ts:15`：YAML 使用默认数值解析方式。
- `packages/eval-dataset/src/dataset/model.ts:23`：数值只检查 `Number.isFinite()`，已丢失精度的整数仍通过校验。
- `packages/eval-dataset/src/dataset/index.ts:103`：导入把已经改值的 Snapshot 交给 Store。

**大白话**

文档中写的是 `9007199254740993`，导入后却变成 `9007199254740992`，整个过程不报错。不是界面显示问题，交给 Store 的值已经错了。

**复现输入**

JSON：

```json
{"dataset":{"name":"tasks"},"data":[{"userPrompt":"fetch the specified record","externalDataId":9007199254740993}]}
```

YAML：

```yaml
dataset: { name: tasks }
data: [{ userPrompt: fetch the specified record, externalDataId: 9007199254740993 }]
```

**已验证事实**

- JSON 和 YAML 两种格式都接受上述输入。
- `importDataset()` 返回的 `externalDataId` 都是 `9007199254740992`。
- 注入的 Store 收到的 `snapshot.data[0].externalDataId` 也都是 `9007199254740992`。
- 把源数字分别换成 `9007199254740992` 和 `9007199254740993`，两者最终都得到相同数值。
- 复现直接使用当前包的实际代码，Store 只记录接收到的 Snapshot；没有连接实际数据库，也没有修改业务代码。

**影响**

任意 JSON 业务字段中的大整数可能被改写，包括外部业务 ID 和预期输出。后续读取、导出和 Runtime 消费得到的都是改写后的值，违背输入无损保留的约定。

**修复方案（2026-10-08）**

- Data 的统一 JSON 值校验要求数字有限，整数必须满足 `Number.isSafeInteger()`；创建、修改、持久化结果校验、导入和导出共用该规则。
- 大整数业务 ID 必须由调用方以字符串提供，不截断、不自动改成字符串，也不允许已丢失精度的不安全 Number 写入 Store。
- YAML 使用 `intAsBigInt: true`，检查原始整数处于安全范围后才转换成 Number；JSON 的数值在模型校验时拒绝不安全整数，失败发生在生成实体 ID 和调用 Store 之前。
- 正负安全边界、正常小数和字符串大整数保留原值；整数的十进制、科学计数、YAML 十六进制和八进制表示都纳入回归。

**验证状态**

- 发现时基线：Dataset 114 个测试及类型检查通过，但没有覆盖该复现场景。
- 新增回归先复现旧实现接受不安全整数，修复后验证嵌套值、创建、修改、导入和导出均拒绝；错误导入不生成实体 ID、不调用 Store、不留下半批数据。
- 修复后 Dataset 170 个测试及类型检查通过；全仓验证结果见文末。

**用户结论**：2026-10-08 已确认，必须修复。用户明确表示：“d01肯定要修啊，这太严重了吧”。

**处理状态**：2026-10-08 用户明确授权修复三项后，业务代码、回归测试和契约文档已更新；本次 code review 复审通过，独立验证结果见文末。

---

### D-02：JSON 导入接受同一对象内的重复字段名，并静默覆盖前值（已修复，复审通过）

**严重程度**：P2。

**相关位置（发现时）**

- `packages/eval-dataset/src/dataset/serialization.ts:12`：`JSON.parse()` 在 Schema 校验之前只保留重复字段的最后一个值。
- `packages/eval-dataset/src/dataset/serialization.ts:18`：YAML 已通过 `uniqueKeys: true` 拒绝重复字段，但 JSON 没有对应检查。
- `packages/eval-dataset/src/dataset/serialization.ts:36`：Schema 收到的对象已不包含被覆盖的字段，无法再发现原文的重复声明。

**大白话**

同一条 Data 里把 `userPrompt` 写了两遍，分别是“修复首页”和“修改登录页”。JSON 导入不报错，直接丢掉前一个任务，成功地把“修改登录页”交给 Store。相同的重复声明写成 YAML 则会报错。

**复现输入**

```json
{"dataset":{"name":"tasks"},"data":[{"userPrompt":"修复首页","userPrompt":"修改登录页"}]}
```

资源引用内也能复现：

```json
{"dataset":{"name":"tasks"},"data":[{"userPrompt":"task","initialSession":{"bundleId":"sessions","sessionId":"homepage-seed","sessionId":"login-seed"}}]}
```

**已验证事实**

- 第一份 JSON 成功导入，返回值和注入的 Store 收到的 `userPrompt` 都是“修改登录页”。
- 同样的双重 `userPrompt` 写成 YAML，会报 `Map keys must be unique`。
- 第二份 JSON 同样成功导入，只保留 `sessionId: "login-seed"`。
- 复现使用当前包的实际 `parseDatasetDocument()` 和 `importDataset()`；没有连接实际数据库，也没有修改业务代码。

**影响**

手写或拼接 JSON 文档时的重复字段会被当成导入成功，任务、初始 Session 引用或其他业务字段可能因此被悄悄替换。后续 Schema 校验和 Store 的原子提交无法发现已经被解析器丢掉的原始声明。

**已同意的处理原则**

JSON 也应在解析入口拒绝同一个对象内的重复字段名，直接报错，而不是自动选择最后一个值。不同对象使用相同字段名属于正常结构，不应受影响。

**修复方案（2026-10-08）**

- 使用 `jsonc-parser` 的严格遍历能力，在原生 `JSON.parse()` 覆盖字段之前按对象检查重复键，不自行实现 JSON 词法或语法解析器。
- 每个对象独立记录已解码的字段名，拒绝 Unicode 转义后相同的键；嵌套对象、数组中的对象、资源引用和任意业务字段都执行相同规则。
- 重复键抛出包含字段名和文本位置的 `SyntaxError`；不同对象的同名键、字符串正文中的重复键样例及特殊字段名不会被误判。
- 明确禁用注释、尾逗号和空文档，仍使用原生 JSON 解析保证 JSON 语法，不把 JSONC 扩展作为兼容输入。

**验证状态**

- 发现时已通过实际代码复现 JSON 导入成功和 YAML 拒绝的差异；原序列化测试只覆盖 YAML 重复键。
- 新增回归验证普通、嵌套、引用、Unicode 转义和特殊字段名的重复键均失败；不同对象和字符串正文保持合法。
- 服务层回归验证重复键在生成实体 ID 和调用 Store 之前被拒绝。

**用户结论**：2026-10-08 已确认，用户明确表示：“是问题，同意你的合理行为，下一个”。同意同一对象内重复字段直接报错的处理原则。

**处理状态**：2026-10-08 业务代码、回归测试和契约文档已更新；本次 code review 复审通过，独立验证结果见文末。

---

### D-03：Data 业务字段 sampleId 与 Runtime 身份字段冲突，传给 Agent 时丢失（已修复，复审通过）

**严重程度**：P2。

**问题归属**：Dataset 与 Runtime 的消费契约不一致。Dataset 自身保存了该字段，直接丢字段的位置在 Runtime；不是 Dataset 应管理 Runtime 身份，也不是 SP 接入尚未完成。

**相关位置（发现时）**

- `packages/eval-dataset/README.md:21`：承诺允许任意其他 JSON 业务字段，运行时输入准备也保留，不丢弃、不改名。
- `packages/eval-dataset/src/dataset/model.ts:78`：Data 输入只禁止覆盖平台 `dataId`，允许 `sampleId` 作为业务字段。
- `packages/eval-runtime/src/runtime/model.ts:26`：`Sample extends Data`，同时在同一层声明 Runtime 的 `sampleId`，无法同时表达同名业务字段和平台身份。
- `packages/eval-runtime/src/runtime/execution.ts:47`：准备执行 Agent 输入时直接去掉 `sampleId`。
- `packages/eval-runtime/src/runtime/evaluation.ts:76`：准备评估 Agent 输入时同样去掉 `sampleId`。

**大白话**

用户的数据里有一个 `sampleId: "source-sample-42"`，表示原始业务样本编号。Dataset 允许创建，并完整保存。但 Runtime 自己也用 `sampleId` 表示平台样本身份，两者挤在一个对象里。按现有扁平结构拼接 Runtime Sample 时，原始业务字段被平台 ID 覆盖；传给执行 Agent 和评估 Agent 的初始数据又会删除这个字段。流程照常成功，两个 Agent 都拿不到原始业务样本编号。

**复现输入**

```json
{
  "userPrompt": "按照原始测试样本编号核对结果",
  "sampleId": "source-sample-42",
  "expectedOutput": { "passed": true }
}
```

**已验证事实**

- 真实 `createData()` 接受该输入，返回值和注入的 Dataset Store 均保留 `sampleId: "source-sample-42"`。
- 复现按当前 `Sample` 契约构造临时 `{ ...data, sampleId: "runtime-sample-1" }`，其同名字段只能表示 Runtime 身份，不能同时保留原始业务值。
- 将该 Sample 交给真实 `executeSampling()` 和 `evaluateSampling()`，执行和评估都返回 `succeeded`。
- 两次 `materializeInitialData()` 收到的 `data` 都没有 `sampleId`，其余业务字段 `expectedOutput` 正常保留。
- 复现只注入记录参数的 Store 和 Harness，没有连接实际 SP/数据库，也没有修改业务代码；Sample 拼接属于按现有接口构造的测试输入，不声称存在已经接入的 Catalog 持久化实现。

**影响**

当前合法的 Data 输入并不都能无损成为 Agent 输入。业务方使用同名样本编号时，执行与评估缺少该信息，却没有失败或提示，违背任意业务字段完整保留的公开约定。

**已同意的处理原则**

平台样本身份与 Data 业务字段应有明确且不冲突的边界，不能靠混在同一对象后删除字段来区分。保持任意 JSON 业务字段的既定契约，让 Runtime 身份与完整 Data 分开表达；这不需要改变包职责，也不意味着给每个 Sampling 持久化一份 Data。

**修复方案（2026-10-08）**

```ts
interface Sample {
  readonly sampleId: string;
  readonly data: Data;
}
```

- 外层 `sampleId` 只表示平台身份，完整 Data 放在 `data` 中；移除 `Sample extends Data` 和扁平字段消费路径，不保留旧结构兼容分支。
- 执行和评估都从 `sample.data` 准备 Agent 输入，只去除 Data 的平台 `dataId`，不再删除业务 `sampleId`。
- 评估仍剥离 Subject 的初始 Session 引用，保持评估 Agent 独立会话；这不影响 `sampleId` 等业务字段的传递。
- Catalog 的查询、独立评估和 Pipeline 使用同一 Sample 结构，Sampling 仍只持久化平台 Sample 身份及运行事实，不重复保存 Data。

**验证状态**

- 发现时已通过实际 Dataset 服务及 Runtime 执行、评估阶段复现；原测试没有覆盖允许同名业务字段的交界场景。
- Dataset 回归验证业务 `sampleId` 在创建、修改、持久化和 JSON/YAML 导入导出中完整保留。
- Runtime 回归验证字符串、数字、对象和数组业务 `sampleId` 在 Pipeline 与独立执行后评估中都完整到达两个 Agent；同时验证平台身份不改变、嵌套业务 `data` 不被误剥离、Sampling 不保存 Data。
- 修复后 Runtime 100 个测试及类型检查通过。

**用户结论**：2026-10-08 已确认，用户明确表示：“合理，下一个”。认可 Runtime 平台身份与 Data 业务内容分开表达、不重复持久化 Data 的处理方向。

**处理状态**：2026-10-08 Dataset 与 Runtime 的公共契约、全部消费路径、测试和文档已更新；本次 code review 复审通过，独立验证结果见文末。

---

## 初次评审结论（修复前）

- 已逐条确认 D-01、D-02、D-03，三项均待修复；D-02、D-03 的处理原则已获用户认可，具体实现尚未提交。
- D-03 属于 Dataset 与 Runtime 的消费契约问题，不改变 Dataset 独立、Data 可复用和 Sampling 不重复持久化输入的边界。
- 继续核对模型校验、JSON/YAML 序列化、服务层、Store 原子操作契约和直接消费入口后，未发现其他可以成立且值得新增的真实问题；本轮逐项评审到此结束。
- 2026-10-08 再次运行当前包测试，114 个通过；类型检查通过。测试通过不表示 D-01 至 D-03 已修复，这三项已有独立复现证据。
- 本轮只更新评审 Markdown，未修改业务代码；实际 Store、SP 接入和已明确后续统一完善的可靠性工作不计为新的核心代码缺陷。

## 修复验证记录（2026-10-08）

- 用户明确要求修复 D-01、D-02、D-03，本次授权覆盖相关业务代码、测试和文档；三项已实现，状态统一为“已修复，待复审”，不自行标记用户 review 通过。
- Dataset 170 个测试、Runtime 100 个测试通过；全仓共 275 个测试通过。
- `pnpm check`、`pnpm test`、`pnpm build` 通过；Dataset 和 Runtime 的未使用局部变量/参数严格检查通过。
- `git diff --check` 通过；生产代码已无 `Sample extends Data`、扁平 Sample 字段消费或删除业务 `sampleId` 的旧路径。
- 仅修改 `eval-platform`，未修改 SP、未增加平台 version、额外顶层包、真实 Store 或资源上传实现，也未提交 Git。

## 三项修复复审记录（2026-10-08）

**结论**：D-01、D-02、D-03 均复审通过。本次核对实现、所有 Sample 消费路径、回归测试与公开契约，并独立执行原问题场景；未发现这三项修复中仍成立的缺陷或新增回归。

### D-01 复审

- 安全整数规则位于统一 JSON 值校验中，创建、全量修改、Store 返回值校验、导入导出和 Agent 输入准备共用，不增加独立的业务校验模型。
- YAML 整数先按 BigInt 读取、校验范围，再转为 Number；JSON 中转换后仍不安全的整数在模型校验时拒绝，不把改错后的值交给 Store。
- 独立执行真实 `importDataset()`：JSON/YAML 共 12 个正负大整数、小数形式的大整数、科学计数和溢出场景全部拒绝，Store 未收到失败导入；字符串大整数、安全上边界和正常小数在两种格式中正确保留。
- 既有新增回归还验证了 ID 生成前失败、嵌套值、YAML 非十进制整数、创建、修改和导出边界。

### D-02 复审

- 使用现有 `jsonc-parser` 遍历已解码字段名，以每个对象独立的 Set 检查重复；严格错误处理加原生 `JSON.parse()` 保持 JSON 语法，不引入自写解析器或 JSONC 兼容分支。
- 独立执行真实 `importDataset()`：重复任务、Session 引用、嵌套数组中的转义后同名键、Dataset 元数据及文档外壳共 5 个场景全部抛出重复字段错误，没有追加 Store 提交。
- 不同对象的同名字段和字符串正文中的重复键样例正常保留；新增回归也覆盖特殊字段名和严格语法拒绝。

### D-03 复审

- Sample 唯一结构是 `{ sampleId, data: Data }`；生产代码没有 `Sample extends Data`、扁平消费或删除业务 `sampleId` 的旧路径，Catalog 与独立评估沿用同一契约。
- 独立执行真实 `createData()`、`executeSampling()` 和 `evaluateSampling()`，以字符串、数字、对象、数组、null、false 和空字符串共 7 种业务 `sampleId` 验证 14 次 Agent 输入准备，全部保留原业务值及业务字段 `data`。
- 平台 Sample 身份保持不变，Data 的平台 `dataId` 不进入 Agent 素材，评估仍不加载 Subject 初始 Session；注入的 Sampling Store 收到的状态均不包含 Data 或 Sample 副本。
- Runtime 回归另外覆盖 Pipeline、独立执行后评估、公开查询、无旧结构兼容和持久化边界。

### 本次验证与修改范围

- Dataset 170 个测试、Runtime 100 个测试通过；两包类型检查通过。
- 再次运行全仓 `pnpm check` 和 `pnpm test`，全部通过，共 275 个测试；`git diff --check` 通过。
- 独立复验只注入记录参数的 Store/Harness，不宣称已验证真实数据库或 SP 生产化接入，这些不属于本次三项修复的评审范围。
- 本次仅更新本评审 Markdown，没有修改业务代码、测试或 CI，也没有提交 Git。
