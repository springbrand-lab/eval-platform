# eval-runtime 评审记录

> 评审对象：`packages/eval-runtime`
>
> 记录日期：2026-10-06
>
> 记录性质：记录讨论中已经确认的问题及当前处理状态；未标注为“已处理”的问题仍属于后续工作。

## 评审共识

- 现有顶层包划分不需要重拆：`eval-contracts`、`eval-dataset`、`eval-runtime`、`eval-metrics`。
- `eval-runtime` 的核心流程已经成立，后续重点是合理修正和真实 SP 接入，不是重新设计整个 Runtime。
- Dataset 和 SP Submission 完全无关。Dataset 只保存可复用的输入数据；Submission、Agent、产物、轨迹和评估结果全部属于 Runtime。
- `Data/Sample` 是静态输入；`Sampling` 是一次实际运行实例。同一个 Sample 可以产生多个 Sampling，但不应该把静态输入内容重复持久化到每个 Sampling。
- Subject 产物是主要证据，完整 Trajectory 是辅助证据。
- 不复制 SP Runtime 内核，不访问 SP 私有实现和 Durable Object 内部存储，只通过 SP 的公开 Harness 边界接入。
- SP 真实接口、真正的 RuntimeStore 持久化、Agent 恢复/重启、超时、取消和推送丢失处理属于生产化接入与可靠性完善；它们不是核心 Runtime 流程的阻塞项。

## 已确认问题

### R-01：收集产物失败会重新执行 Agent（已处理）

**历史现象**

Subject 或 Evaluation 的 Submission 已经成功，但后续 `collectExecution()` 或 `collectEvaluation()` 失败时，生命周期会进入重试。由于已有 Submission，下一轮会调用 `restartAgent()`，重新投递任务。

相关位置：`packages/eval-runtime/src/runtime/agent-lifecycle.ts:230`、`packages/eval-runtime/src/runtime/agent-lifecycle.ts:248`。

**大白话**

Agent 已经把任务做完了，只是 Runtime 没把结果拿回来。现在的行为却是让 Agent 再做一遍，而不是继续收集原来的结果。

**影响**

- Subject 可能被重复执行；
- 产生重复成本和重复副作用；
- 后一次执行可能覆盖前一次执行的证据；
- 重试次数被错误地消耗在“收集失败”上。

**已落实**

`packages/eval-runtime/src/runtime/agent-lifecycle.ts` 现在按生命周期阶段处理：

- `RetryOperation` 明确区分 `submission`、`status`、`collection` 和 `restart`；
- Submission 响应不确定时，按本次操作的幂等键校准，重试提交也复用同一个幂等键；
- 状态确认失败只按 `status` 决策，永远不会直接进入 `restartAgent()`；
- 产物/轨迹收集失败只按 `collection` 决策，始终复用已完成的 Agent；
- 只有收到明确的终态失败，才构造 `ConfirmedSubmissionFailure` 并按 `restart` 决策；
- 默认控制器只定义确认失败后的重启策略，状态确认和收集策略由注入的控制器决定，避免提前固化尚未确定的次数和退避规则。

---

### R-02：重启请求响应丢失时，可能重复重启同一个 Agent（已处理）

**历史现象**

重启请求的幂等键包含 attempt 次数：

```text
execution:<samplingId>:restart:1
execution:<samplingId>:restart:2
```

相关位置：`packages/eval-runtime/src/runtime/agent-lifecycle.ts:208-224`。

**大白话**

第一次 `restartAgent()` 请求可能已经被 SP 接受，但 Runtime 没收到响应。下一轮重试使用了新的幂等键，SP 会把它当成一个新的重启请求。

**影响**

- 同一个 Sampling 可能被重复重启；
- 同一个 Chat/Workspace 可能收到多次重启消息；
- 原请求和新请求的结果会变得难以判断。

**已落实**

- `submitWithReconciliation()` 为一次重启操作固定一个幂等键；
- 响应丢失时调用 `inspectAgentOperation({ handle, idempotencyKey })`，只查询本次操作；
- 查询不到或查询失败时，重复调用复用原幂等键；
- 只有按原幂等键查到该次重启明确失败后，下一次有意发起的新重启才使用新的 attempt/key；
- 不再提供不带操作身份的 `inspectAgent()` 校准路径。

进程崩溃后的跨进程恢复仍依赖后续持久化的操作状态，不在本次 Runtime 核心实现范围内。

---

### R-03：一个 `Sampling.status` 同时表示执行阶段和评估阶段（已处理）

**现象**

Subject 执行成功后，`Sampling.status` 是 `succeeded`。调用 `evaluate()` 时，`resetEvaluation()` 又把同一个状态改回 `queued`，评估完成后再改为 `succeeded`。

相关位置：`packages/eval-runtime/src/runtime/index.ts:431-448`。

**大白话**

看到 `queued` 或 `succeeded` 时，外部不知道它表示：

- Subject 还没执行；
- Subject 已经完成、正在等待评估；
- Evaluation Agent 正在运行；
- 还是评估已经完成。

**影响**

- 执行状态和评估状态互相覆盖；
- 查询方无法判断下一步该做什么；
- Pipeline 需要靠额外特判解释状态；
- 恢复和重试无法只针对某一个阶段。

**正确原则**

执行和评估要有独立的阶段状态。Sampling 可以作为聚合对象，但不能用一个状态字段同时承载两个阶段的生命周期。

**已落实**

- `Sampling.execution` 只保存执行阶段状态；评估阶段状态由独立 `EvaluationRecord.status` 保存。
- 两个阶段都按 `queued → starting → running → retrying → succeeded/failed/cancelled` 流转，避免为评估另造一套状态类型。
- 未请求评估时不创建 `EvaluationRecord`，不引入额外的“尚未评估”状态。
- 执行和评估分别写入各自记录；评估失败不会覆盖执行成功状态，Run 聚合时按当前阶段读取对应记录。
- `packages/eval-runtime/src/runtime/index.test.ts` 覆盖仅执行、评估成功、评估失败三种状态隔离场景。

---

### R-04：创建 Agent 的响应丢失时，会重复创建 Agent（已处理）

**现象**

`startAgent()` 请求已经在 SP 侧创建成功，但返回 `AgentHandle` 时网络断开。Runtime 本地没有 `handle`，下一轮会再次调用 `startAgent()`。

相关位置：`packages/eval-runtime/src/runtime/agent-lifecycle.ts:190-197`。

**大白话**

SP 里已经有第一个 Agent 了，Runtime 不知道，于是又创建第二个。后续任务使用第二个 Agent，第一个 Agent 变成没人管理的孤儿。

**影响**

- 可能多启动一个 Agent；
- 第一个 Agent 可能继续占资源或执行；
- 一个 Sampling 对应多个 Chat/Workspace；
- 后续产物和轨迹归属不清楚。

**正确原则**

创建 Agent 也需要稳定的创建身份：

- 使用 `stage + samplingId` 等稳定键幂等创建；或
- 创建响应丢失时，可以按该身份查询并复用已有 Agent；
- 不能因为本地没拿到响应就直接重新创建。

**已落实**

- Runtime 在创建执行或评估 Agent 前先分配并持久化该阶段的 `submissionId`，把它作为 SP Chat/Agent 的稳定身份。
- Harness 改为 `ensureAgent()` 语义：同一身份重复或并发调用必须返回同一个 Agent，不能再次创建；这与 SP `Inbox.createChat(..., chatId)` → `lifecycle.ensure()` 的方案一致。
- 创建响应丢失后的重试保留完全相同的身份和创建参数；它使用 `creation` 重试操作，不增加 Sampling、执行/评估 attempt，也不使用新的 Agent 重启键。
- Runtime 校验返回的 Agent Handle 必须匹配请求身份；身份冲突或错误绑定不可重试。
- `packages/eval-runtime/src/runtime/index.test.ts` 覆盖创建响应丢失后复用同一身份的场景。

---

### R-05：Run 和 Sampling 的创建/准备不是原子操作（已处理）

**现象**

`start()` 和 `pipeline()` 先批量创建 Sampling，再创建 Run：

```text
createSampling(...)
createRun(...)
```

相关位置：`packages/eval-runtime/src/runtime/index.ts:285-290`。

`evaluate()` 则先重置并写回 Sampling，再创建新的 Run，相关位置是 `packages/eval-runtime/src/runtime/index.ts:140-157`。

**大白话**

- 创建 Sampling 成功、创建 Run 失败，会留下没有 Run 管理的孤儿 Sampling；
- 批量创建 Sampling 时中途失败，会留下半批数据；
- `evaluate()` 先把旧评估清掉，之后创建 Run 失败，会变成旧结果没了、新任务也没有。

**影响**

- 持久化数据不完整；
- 运行恢复时不知道这些 Sampling 属于哪次操作；
- 评估准备动作可能已经发生，但没有对应的 Run 记录。

**正确原则**

Run、Sampling 和评估准备需要有明确的一致性边界：

- 优先使用同一事务/聚合写入；或
- 使用可恢复的准备-提交流程；或
- 使用明确的补偿和清理机制。

不能继续依赖“先写一部分，后面大概率成功”。

**已落实**

- `RuntimeStore` 提供语义化的 `createRunWithSamplings()`，`start()`、`pipeline()` 和 `evaluate()` 都通过一次 Store 操作创建 Run、Sampling 和关联的 EvaluationRecord；Runtime 不再分别调用 `createSampling()` 和 `createRun()`。
- `createRunWithSamplings()` 一次原子提交 Run、Sampling 和本次 `EvaluationRecord`；Pipeline 在执行阶段就分配评估 ID，执行失败的样本将对应评估标记为 `cancelled`。
- `evaluate()` 为每次主动评估创建新的 `EvaluationRecord`，与新的评估 Run 一起原子写入；写入失败时，旧评估记录保持不变。
- Store 实现必须在自己的单一持久化边界内使用 PostgreSQL/DO SQLite 事务；事务内不执行 Harness、网络或其他外部调用。
- 语义化写入按 Run/Sampling 身份保持可重试，具体幂等和唯一约束由 Store 实现负责；跨存储场景不伪造分布式事务，改用持久化操作记录和补偿恢复。
- `packages/eval-runtime/src/runtime/index.test.ts` 覆盖评估准备原子提交失败时保留旧结果的场景。

---

### R-06：Pipeline 中一个 Subject 失败会阻塞所有成功 Subject 的评估（已处理）

**现象**

`runPipeline()` 只要发现一个执行结果不是 `succeeded`，就直接返回：

```ts
if (executedRecords.some(({ sampling }) => sampling.status !== "succeeded")) {
  return;
}
```

相关位置：`packages/eval-runtime/src/runtime/index.ts:341-349`。

**大白话**

10 个 Sampling 执行时，9 个成功、1 个失败。现在 9 个已经有产物和轨迹的 Sampling 也不会进入 Evaluation Agent，最后没有评分。

**影响**

- 成功样本的结果被浪费；
- 一个样本故障扩大成整批评估缺失；
- 不符合 Sampling 彼此独立的模型；
- 后续重试时无法只处理失败样本和未评估样本。

**正确原则**

- 成功的 Sampling 继续进入评估；
- 失败的 Sampling 保留失败状态；
- Run 只汇总结果，不阻断其他 Sampling 的独立生命周期。

**已落实**

- Pipeline 执行完成后只筛选 `execution.status === "succeeded"` 的 Sampling 进入评估。
- 执行失败的 Sampling 不启动评估 Agent，保留执行失败，`evaluation` 不创建。
- Run 聚合会等待仍在执行或评估中的 Sampling 完成后再判定最终失败，避免提前结束 Pipeline。
- 只有全部可评估 Sampling 完成后，执行失败或评估失败才会让整个 Pipeline Run 最终为 `failed`。
- `packages/eval-runtime/src/runtime/index.test.ts` 覆盖“部分执行成功、部分执行失败仍继续评估”的场景。

---

### R-07：Run 不应该维护一份独立的权威状态（已处理）

**现象**

Run 有自己的 `status`，Runtime 又根据 Sampling 状态不断聚合和更新它。相关位置包括：

- `packages/eval-runtime/src/runtime/store.ts:13-15`；
- `packages/eval-runtime/src/runtime/index.ts:392-408`；
- `packages/eval-runtime/src/runtime/index.ts:452-470`。

**大白话**

真正执行的是 Sampling，Run 只是把一批 Sampling 绑在一起的容器和查询句柄。但现在 Sampling 有状态，Run 又保存一份聚合状态，形成两份真相。

**影响**

- Run 状态可能和 Sampling 状态不一致；
- Pipeline 需要反复把 Run 改成 `queued/running/succeeded/failed`；
- 部分成功、取消、阶段切换都要靠额外的聚合特判；
- Run 的状态更新可能覆盖真实的 Sampling 状态语义。

**正确原则**

- Run 主要保存 `runId`、`projectId`、`samplingIds` 以及运行类型/请求信息；
- Sampling 保存真实的执行和评估状态；
- Run 状态需要时从 Sampling 即时推导；
- 如果为了查询性能保留缓存，只能是派生投影，不能成为第二个权威状态。

**已落实**

- 持久化的 `RuntimeRunRecord` 只保存 `runId`、`projectId`、`samplingIds` 和阶段范围 `phases`，不再保存当前阶段或 `status`。
- `RuntimeStore` 不再提供 `updateRun()`；Run 创建后不需要随着 Sampling 生命周期反复写回状态。
- `getRun()` 读取关联 Sampling，并通过阶段聚合逻辑即时生成对外 `RunSnapshot.phase/status`；这些字段是查询投影，不是第二份持久化事实。
- 执行、评估、Pipeline 的生命周期只更新 Sampling；失败、部分成功和阶段切换都由 Sampling 状态自然聚合。
- Pipeline 在所有 Execution Sampling 仍为 `queued` 时返回 `queued`；至少一个 Execution 已开始后返回运行态，Execution 全部成功但 Evaluation 尚未完成时返回 `running`。
- Runtime 测试在没有任何 Run 状态写入接口的情况下覆盖运行中、成功和失败状态查询。

---

### R-08：Subject 产物和轨迹存了两份

**现象**

同一份 Subject 产物和轨迹同时存在于：

- `Sampling.artifacts`、`Sampling.trajectory`；
- 历史 Runtime 包装中的 `execution.artifacts`、`execution.trajectory`。

相关位置：

- 契约：`packages/eval-contracts/src/model.ts:115-128`、`packages/eval-contracts/src/model.ts:166-171`；
- 写入：`packages/eval-runtime/src/runtime/execution.ts:94-105`；
- 读取：`packages/eval-runtime/src/runtime/evaluation.ts:37-38`、`packages/eval-runtime/src/runtime/evaluation.ts:99-105`。

**大白话**

执行完成时要同时写两边。评估读取一边，查询方可能读取另一边。以后两份内容不一致时，不知道哪份是真的。

**正确原则**

Subject 的产物和完整轨迹只在 `Sampling` 中保留一份，作为唯一真相。`ExecutionOutput` 如果继续存在，只能是生命周期函数的临时返回值，不能再作为第二份持久化结果。

**已处理**

- `SamplingState` 不再持久化额外的 `execution` 副本。
- `collectExecution()` 仍返回临时的 `ExecutionOutput`，由 Runtime 将结果写入 `Sampling.execution`、`Sampling.artifacts` 和 `Sampling.trajectory`。
- Evaluation 只从 `Sampling` 读取 Subject 产物和完整轨迹。

---

### R-09：`start()` 和 `pipeline()` 缺少请求级幂等（已处理）

**现象**

入口每次调用都会生成新的 Run ID 和 Sampling ID。请求本身没有调用方幂等键，也没有“已处理请求 → 原 Run”的持久化映射。

相关位置：`packages/eval-runtime/src/runtime/index.ts:116-134`、`packages/eval-runtime/src/runtime/index.ts:164-180`。

**大白话**

1. 客户端调用 `start()`；
2. Runtime 已经创建了 Run、Sampling 和 Agent；
3. 返回 `RunHandle` 时网络断了；
4. 客户端重试；
5. Runtime 又创建并执行一整批新的 Sampling。

**影响**

- 同一个逻辑请求被执行两次；
- 产生重复成本、重复产物和重复评估；
- SP 内部的 Submission 幂等无法解决 Runtime 整体重复创建的问题。

**正确原则**

入口需要调用方提供幂等键，并把它和原 Run 绑定。相同幂等键再次请求时，直接返回原来的 RunHandle，而不是重新创建 Sampling。

**已落实**

- `StartRunRequest` / `PipelineRequest` 要求调用方提供 `requestId`，并支持可选 `idempotencyKey`；`evaluate()` 保持独立的主动重评估语义。
- Runtime 在解析 Dataset/Sample 前按 `idempotencyKey` 优先、`requestId` 其次快速查重；重复请求直接返回原 `RunHandle`。
- Runtime 为请求事实生成稳定指纹，避免同一身份被不同项目、Dataset、Sample、采样次数、并发参数或 Agent 配置静默复用。
- `RuntimeStore.createRunWithSamplings()` 返回原子准入结果；Store 必须在持久化事务内再次查重，竞争请求只有一个能创建 Run/Sampling，其余复用原 Run。
- `requestId` 与 `idempotencyKey` 指向不同 Run，或同一身份对应不同请求事实时，直接返回不可重试的冲突错误。
- 幂等映射必须由 Store 持久化并用唯一约束兜底，不能用 Runtime 进程内 Map 代替。
- `packages/eval-runtime/src/runtime/index.test.ts` 覆盖重复请求、幂等键重试、请求事实冲突和并发准入场景。

---

### R-10：静态输入被重复塞进每个 Runtime Sampling（已处理）

**现象**

Dataset 的 `Data` 保存静态输入，但 Runtime 又定义了复制这些字段的 `Sample`：

- `packages/eval-dataset/src/dataset/model.ts:21-28`；
- `packages/eval-runtime/src/runtime/model.ts:19-26`。

同时，旧 Runtime 包装记录又直接包含完整 `sample`：

- `packages/eval-runtime/src/runtime/store.ts:17-22`；
- `packages/eval-runtime/src/runtime/index.ts:249-268`。

`persistNewRun()` 再把完整的 Runtime 包装记录交给 `RuntimeStore`：

- `packages/eval-runtime/src/runtime/index.ts:285-290`。

**大白话**

一个 Sample 启动 100 次，真正需要的是 100 份不同的运行状态；不是把同一份 JSON、初始 Session 引用和素材描述复制 100 次。

**边界共识**

- Dataset 只负责 `Data/Sample` 静态输入；
- Dataset 和 Submission 完全无关；
- `Sampling` 只保存 `sampleId` 和这一次运行自己的状态、Submission、产物、轨迹、评估结果；
- 运行时拼出的 `sample` 如果为了执行方便保留，只能属于临时 Context，不能作为每个 Sampling 的持久化副本。

**正确原则**

```text
Data/Sample：存一份静态输入
Sampling：存 N 份独立运行状态，只引用 sampleId
RuntimeSamplingContext：运行时 join，不作为持久化结构
```

**已落实**

- `SamplingState` 只保存 `Sampling` 运行状态；`RuntimeStore` 不接收静态输入副本，`getSampling()` 通过 `SamplingSnapshot` 返回稳定查询结果。
- Runtime 使用临时 `RuntimeSamplingContext`，只在执行/评估流程中把 `SamplingState` 与 `Sample` 拼接起来。
- `start()` / `pipeline()` 解析 Dataset 后生成临时 Context，持久化时只提交 Context 中的 `state`；Pipeline 在执行阶段和评估阶段之间复用 Context，不重复查询输入。
- 独立 `evaluate()` 通过 `RuntimeCatalog.getSample(sampleId)` 重新关联输入；Sample 不存在或 ID 不匹配时在提交评估准备前失败，不清除旧结果。
- 不引入 Sample 版本、快照或新的持久化副本；输入仍由 Dataset/Catalog 负责，Sampling 只通过 `sampleId` 引用。
- `packages/eval-runtime/src/runtime/index.test.ts` 覆盖持久化记录不含 Sample，以及独立评估按 `sampleId` 重新关联输入。

---

### R-11：`RunPhase` 把 Pipeline 错当成了阶段（已处理）

**现象**

旧模型把下面三个值放在同一个 `RunPhase` 中：

```ts
"execution" | "evaluation" | "pipeline"
```

相关位置：`packages/eval-contracts/src/model.ts` 的 `RunPhase` 定义，以及 `packages/eval-runtime/src/runtime/index.ts:271-282`、`packages/eval-runtime/src/runtime/index.ts:452-463`。

**大白话**

真正的执行阶段只有两个：

```text
execution
evaluation
```

`pipeline` 不是第三个执行阶段，只是把这两个阶段串起来的编排方式。

**影响**

- `phase` 这个字段名和真实语义不一致；
- 聚合逻辑需要写 `phase === "pipeline"` 的特殊判断；
- 后续独立设计执行状态和评估状态时，模型会继续混淆；
- 查询方无法区分“Run 的阶段范围”和“当前正在执行的阶段”。

**已处理**

- `RunPhase` 收敛为 `execution | evaluation`，删除 `pipeline` 值。
- `RunPhases` 只允许三种合法阶段范围：`["execution"]`、`["evaluation"]`、`["execution", "evaluation"]`。
- `RuntimeRunRecord` 保存阶段范围，不保存 Pipeline kind 或第二份当前状态。
- `RunSnapshot.phase` 和 `RunSnapshot.status` 都由阶段范围及 Sampling 状态即时推导：执行未完成时为 `execution`；执行结束且有成功 Sampling 后为 `evaluation`；成功执行等待评估时 Run 保持运行态。
- 单独执行 Run 不会因为同一 Sampling 后续被独立评估而改变查询结果，因为它的阶段范围只有 `["execution"]`。
- Pipeline 仍是 Runtime 内部的顺序编排，不创建独立实体，也不进入持久化阶段枚举。

旧方案曾试图拆开两个概念：

```text
runKind / orchestration: execution | evaluation | pipeline
stage: execution | evaluation
```

本实现不再增加 `runKind`；阶段范围已经表达了这个边界，Pipeline 只保留为调用编排行为。

---

### R-12：评估结果应该独立建模为 `EvaluationRecord`（已处理）

**现象**

旧模型中 Subject 的执行事实和评估事实混在 `Sampling` 与 Runtime 包装记录的 `evaluation`：

```ts
interface LegacyRuntimeSamplingWrapper {
  readonly sampling: Sampling;
  readonly evaluation?: EvaluationAgentOutput;
}
```

**大白话**

一个 Sampling 的执行事实在 `Sampling` 里，评估事实却挂在 Runtime 的临时包装对象旁边。单独拿到 `Sampling`，看不到评估结果；只拿旧包装记录，又把领域数据和运行时拼装结构绑在了一起。

**已处理**

评估结果现在独立建模成明确的 `EvaluationRecord`，通过 `samplingId` 关联，并通过 `evaluationId` 由 Run 固定引用：

```text
Sampling
└── samplingId

EvaluationRecord
├── evaluationId
├── samplingId
├── evaluator
├── submissionId
├── attempts
├── output
└── status
```

这样执行记录和评估记录各自有清晰的所有权：`Sampling` 不再包含评估 Agent、评估 Submission、评估尝试或评估状态；Runtime 通过 `getEvaluation()` / `listEvaluations()` 查询独立评估记录。每次主动 `evaluate()` 都保留一条新的 EvaluationRecord，不覆盖旧结果。

---

### R-13：`config` 必须成为真正的配置入口（已处理）

**现象**

`packages/eval-runtime/src/config/model.ts` 定义了 `ExecutionConfig`、`EvaluationConfig` 和 `PipelineConfig`，但 Runtime 实际执行仍直接接收 `StartRunRequest`、`EvaluateRequest` 和 `PipelineRequest`。

**大白话**

现在有两套配置模型，但只有 Request 真正生效。`config` 只是被导出、没有参与配置解析、校验、查找或运行。

**已处理**

- `ExecutionConfig` 现在持有 `datasetId`、可选 `sampleIds`、`samplingCount`、Subject Harness、执行并发和重试策略；Dataset 是配置引用，不把 Dataset 内容复制进 Config。
- `EvaluationConfig` 持有评估 Harness、评估并发和重试策略。
- `PipelineConfig` 持有自动生成的 `configId`，只组合 `executionConfigId` 和 `evaluationConfigId`；Pipeline 仍只是两个阶段的编排，不是新的运行实体或阶段。
- `ConfigStore` 是配置持久化端口，`ConfigResolver` 统一读取、校验、归一化和组合配置；Config 创建函数负责自动生成唯一 ID。
- `StartRunRequest`、`EvaluateRequest`、`PipelineRequest` 不再重复携带 Harness、Dataset、并发或重试字段，只分别引用 Execution、Evaluation 或 Pipeline Config。
- Runtime 在解析 Config 后才进行 Sample 解析和 Run admission；请求幂等指纹包含解析后的有效配置，配置事实变化不会错误复用旧 Run。

---

### R-14：Sampling 的三种职责不能由一个类型同时承担（已处理）

**现象**

旧实现中的一个 Runtime 包装类型同时被用作：

1. `RuntimeStore` 的持久化记录；
2. Runtime 内部执行状态的中间对象；
3. `getSampling()` 对外返回的查询结果。

它把 `sampling` 同时用于持久化、Runtime 内部流程和对外查询；评估记录已经从这里移出，但三种 Sampling 边界仍未分开。

**大白话**

数据库记录、Runtime 临时对象和公开 API 返回值全部挤在一个类型里。于是 Sample 被带进持久化，EvaluationRecord 独立后又无法自然归位，Store 的变化也会直接变成 API 变化。

**正确原则**

现在固定区分三个边界：

```text
SamplingState             持久化的 Sampling 状态
RuntimeSamplingContext    Runtime 执行时拼出的 Sample + SamplingState
SamplingSnapshot          对外查询结果
```

不拆新的 workspace package；三种职责在 `eval-runtime` 内通过不同类型和边界完成。

**已处理**

- `RuntimeStore` 只保存和返回 `SamplingState`，不接收 Runtime Context。
- `RuntimeSamplingContext` 只在执行和 Pipeline 阶段临时关联 `state` 与 `sample`，不会进入 Store。
- `getSampling()` 通过 `toSamplingSnapshot()` 返回扁平 `SamplingSnapshot`，复制数组和公开引用，不暴露静态 Sample 或临时 Context。
- `RuntimeEvaluationContext` 使用 `SamplingState`、`EvaluationRecord` 和 `Sample` 的临时组合；独立评估仍按 `sampleId` 重新解析 Sample。
- Runtime 测试覆盖 Store 状态、临时输入隔离和公开查询 DTO 三个边界。

---

### R-15：配置需要统一的运行时解析、校验和归一化入口（已处理）

**现象**

当前配置校验散落在多个位置：

- `packages/eval-runtime/src/runtime/index.ts` 校验 ID、并发数和请求结构；
- `packages/eval-runtime/src/runtime/retry.ts` 校验重试参数；
- `packages/eval-runtime/src/runtime/agent-lifecycle.ts` 校验 Harness 类型；
- `packages/eval-runtime/src/config/model.ts` 只有 TypeScript 接口，没有运行时解析和校验。

**大白话**

外部配置进来后，不是先变成一份确定、合法的有效配置，而是执行到哪里再临时检查哪里。

**正确原则**

配置成为正式入口后，应该统一走：

```text
加载配置 → 解析 → 完整校验 → 归一化 → Runtime 只消费有效配置
```

Runtime 内部不再对同一份配置做分散、重复和不一致的临时判断。

同时，本次解析出的有效配置必须和运行绑定并固化为不可变快照；不能只保存 `runId`、`projectId` 和 `samplingIds`，却无法知道本次运行实际采用了什么并发、重试和 Harness 参数。本项目当前不引入配置 version 概念。

**已处理**

- `ConfigResolver` 是配置进入 Runtime 的唯一解析入口；Execution、Evaluation 和 Pipeline 都先读取、校验并归一化，再交给 Runtime。
- Resolver 将省略的 `retryPolicy` 归一化为明确的默认策略，返回 `ResolvedExecutionConfig` / `ResolvedEvaluationConfig`；Runtime 阶段只接收这些有效配置。
- Resolver 会剥离未参与契约的额外字段，并复制 Sample ID、Harness、运行参数和 RetryPolicy，避免配置 Store 的可变对象泄漏到运行时。
- `RuntimeRunRecord.config` 保存本次 Run 的 `RunConfigSnapshot`：执行 Run 保存 Execution 配置，评估 Run 保存 Evaluation 配置，Pipeline 保存 Pipeline 及其解析后的两份阶段配置。
- `SpHarnessConfig.runtime` 不只是快照字段；Runtime 将 `workspaceMode`、`timeoutMs` 作为 `HarnessRuntimeOptions` 贯穿 Subject/Evaluator 的创建、素材准备、提交、状态等待/校准、产物收集和评估输入准备调用。
- `SpHarnessConfig.framework` 必填并支持 `sp | codex | cc`；Subject 可选择三者，EvaluationConfig 固定 SP 宿主和 SP 框架。框架经 Resolver 校验、归一化后保存在 Run 快照中，参与请求幂等指纹，并传入 `ensureAgent`；返回 Handle 必须绑定所选框架，之后的提交、重启和收集复用同一 Handle。缺少或非法框架直接拒绝，不兼容静默默认 SP。
- 当前 Runtime 只实现 SP Harness；遇到 `RemoteHarnessConfig` 会明确报未实现错误，不会静默丢弃 `runOptions`。
- Run、Sampling、EvaluationRecord 和有效配置快照通过 `createRunWithSamplings()` 一次原子提交；后续配置 Store 的变化不会改变已创建 Run 的生效配置。
- 不引入 version；配置 ID 保留在快照中，同时保存完整生效字段。
- `packages/eval-runtime/src/runtime/index.test.ts` 覆盖 Subject 和 Evaluator 的运行参数确实到达 Harness 生命周期调用。
- 配置测试覆盖三种框架保留、非法选择和非 SP Evaluator 拒绝；Runtime 测试覆盖三种框架共用生命周期、Codex/CC 与 SP Evaluator 联跑、确保/重启时框架不变，以及切换框架后的幂等冲突。SP 真正的 Codex/CC 云端启动实现不属于本次 eval 侧改动。

## 明确不计入本次问题

以下内容在讨论中被明确排除，不能重新当作已确认问题：

- SP 中 Chat ID 和 Submission ID 的重复：两者在当前 SP 语义中相同，不作为问题；
- `materializeEvaluationInput()` 当前没有返回复制回执：这是 SP 正式写入接口接入工作，不作为当前 Runtime 核心问题；
- Sampling 并发写入、旧 Worker 与新 Worker 同时写入、因此必须增加版本号/CAS：当前没有确认这些场景，版本号不作为独立问题；
- 未分类错误默认是否可重试：错误分类方案尚未确定，先预留，不作为当前问题；
- 重新评估是否覆盖历史结果：当前不把它作为问题；
- 通过持续轮询、超时、取消、推送丢失等生产化机制完善运行可靠性：属于后续接入和可靠性工作，不阻塞核心 Runtime 设计；
- 重新拆分顶层 workspace 包、照搬 pydantic 代码细节、增加没有明确职责的 adapter/config 包：均不属于本次评审目标。

## 当前结论

当前评审确认的核心方向不是重写 Runtime，而是收紧唯一真相和实体边界：

1. Sampling 只保存一次运行实例的真实状态；
2. Data/Sample 只保存静态输入，不携带任何 Submission；
3. 产物和轨迹只保留在 Sampling；
4. Run 作为分组/查询句柄，不维护第二份权威状态；
5. 执行阶段和评估阶段状态分开；
6. Pipeline 是编排方式，不是第三个阶段；
7. SP Agent 创建、提交、重启和收集遵守同一次操作的幂等语义；
8. Runtime 入口对整批请求提供幂等；
9. 每个 Sampling 的成功或失败不应阻断其他 Sampling 的独立生命周期。

## 新提交复审（2026-10-08）

**评审范围**：`5845b09` 的 Dataset 生产代码及 `ff9acee` 的 Contracts/Runtime 生产代码。用户明确暂不审核 CI，因此 `eafd88d` 不作通过或不通过结论。

**当前结果**：Dataset 未发现新的成立缺陷；Runtime 的复现记录如下。R-16、R-19 已按用户确认的范围修复并复审通过；R-17、R-18 未证实现有正常流程会触发，评审撤回，不计本轮问题。按用户要求逐项讨论，不将条件复现或未讨论的记录等同于用户已确认的问题。

| 编号 | 问题 | 严重程度 | 状态 |
| --- | --- | --- | --- |
| R-16 | Agent 已确认完成，资源记录持久化异常却将 Attempt 改成 Agent 失败 | P2 | 已修复，复审通过 |
| R-17 | Config 创建函数允许额外输入的 configId 覆盖新身份，但未证实现有正常流程会触发 | — | 已撤回，不计本轮问题 |
| R-18 | 嵌套配置保留非契约字段，但未证实现有正常流程携带这些字段 | — | 已撤回，不计本轮问题 |
| R-19 | 失败 Sampling 的评估取消记录保存异常，阻断成功 Sampling 的独立评估 | P2 | 已修复，复审通过 |

### R-16：资源持久化异常把已完成的 Agent Attempt 改成失败（已修复，复审通过）

**所属提交**：`ff9acee`。

**相关位置**

- `packages/eval-runtime/src/runtime/agent-lifecycle.ts:224`：`submissionCompleted` 初始为 false，直到产物收集入口才置为 true。
- `packages/eval-runtime/src/runtime/agent-lifecycle.ts:279`：此前已经接收到 Agent 的明确终态。
- `packages/eval-runtime/src/runtime/agent-lifecycle.ts:288`：资源采集和持久化在进入产物收集之前执行。
- `packages/eval-runtime/src/runtime/agent-lifecycle.ts:313`：资源持久化抛错时仍走未完成分支，将 Attempt 写成 `failed`。

**大白话**

SP 已明确通知 Agent 任务完成了。接下来 Runtime 保存费用/Token 记录时出错，代码却把这个 Agent Attempt 记成失败。实际失败的是 Runtime 收尾，不是 Agent 执行。Run/阶段是否失败可以单独决定，但不能改写已经确认的 Agent 完成事实。

**独立复现**

1. 分别调用真实 `executeSampling()`、`evaluateSampling()`，注入匹配身份的 Harness。
2. `submitAgent()` 返回 `status: "completed", normalizedStatus: "completed"`。
3. `collectAgentResources()` 返回归属正确、校验通过的原始快照。
4. 注入的 Store 将带 `resources: collected` 的记录实际保存，然后仅在第一次保存时抛出响应丢失错误；后续读写正常。
5. 两种角色最终持久化的 Attempt 都是 `status: "failed"`，资源快照仍为 `collected`，错误是保存响应丢失，产物收集未开始。

**判断边界**

- 本条不要求真实 Store 已接入，也不要求增加数据库事务、CAS 或版本；用户明确要求补齐资源持久化及相关收尾的重试能力，具体次数和退避策略尚未定案。
- 重试耗尽或不可重试的资源保存失败可以体现为阶段失败，但不能把已经确认完成的 Agent 状态改成失败。
- 现有回归验证了响应丢失后资源快照不被清掉及阶段失败，但没有断言这时已完成 Agent 的 Attempt 状态。

**已同意的处理原则与重试要求**

- 明确区分 Agent 终态与 Runtime 收尾结果，在观察到完成时保留该事实，后续资源保存/产物读取错误不应把已完成 Attempt 改成 Agent 失败。
- 资源持久化及相关收尾失败必须支持重试，重试的是失败的保存/收尾步骤，不是已经完成的 Agent 任务。
- 沿用同一个 Sampling/EvaluationRecord、Attempt、Submission 和操作幂等身份；保存同一份已采集资源快照，不因重试新建 Attempt、重新提交任务或重启成功 Agent。
- 保存响应丢失时，以最新持久化事实确认是否已经提交，或按同一事实幂等重试；不能用旧的 pending/失败副本覆盖已提交的资源和 Agent 完成状态。
- 保存成功后继续未完成的收尾流程；重试耗尽后的收尾失败单独表达，不能改写 Agent 终态。不在本轮擅自固化次数、退避或新增实现抽象。

**用户结论**：2026-10-08 已确认。用户明确表示：“合理，但要有重试，记录然后说下一个”。重试能力属于修复要求，不只修改状态标记。

**处理状态**：已修复，2026-10-08 复审通过。

**修复实现**

- `runtime/agent-lifecycle.ts` 在收到明确终态时固定并保存 Attempt 状态、完成时间和原 Agent 错误，再收集资源。收尾错误只进入阶段 `lastError`，不修改已经确认的 Agent 终态。
- `runtime/store.ts` 的同记录保存流程新增独立 `persistence` 重试。写入失败后读取最新记录核对是否已提交；未确认且注入策略允许时，重写同一份已捕获记录。JSON 对象键顺序不参与差异判断，原始数组顺序、重复事件和 null 不被忽略。
- Execution/Evaluation 的身份、Attempt、状态、资源、产物和失败收尾写入均接入该流程，生命周期与保存共用同一阶段 RetryController。不固化保存重试次数/退避，不新增幂等表或版本，不重新提交/重启 Agent。
- 回归覆盖两种 Agent 的终态/资源/产物保存写前失败、提交后响应丢失、完成时间固定、重试耗尽、原 Agent 失败保留，以及资源读取/产物读取/保存预算独立。已经采集的资源和产物在保存重试中不重新读取。

**复审结论**

- `agent-lifecycle.ts` 在资源采集之前捕获并保存终态；后续异常不再把已经完成的 Attempt 改成失败，也不把 Runtime 收尾错误写成 Agent 错误。终态状态、原 Agent 错误及完成时间在保存重试中保持不变。
- `persistRuntimeRecord()` 捕获同一份记录，写入异常先查询持久化事实；未确认且策略允许时仅重写该记录。对象键顺序不影响确认，数组顺序、重复事件和 null 仍参与比较。
- 身份、Attempt、资源和产物保存复用本阶段的 RetryController；重试不会重新采集已获得的结果、增加 Attempt、重提交任务或重启 Agent。重试耗尽可以使阶段失败，但已保存的 Agent 终态仍保留。
- 本次复审未发现与 R-16 修复相关的新缺陷；不要求增加默认重试政策、配置版本或另一套持久化身份。

### R-17：额外输入的 configId 可以覆盖新身份（已撤回，不计本轮问题）

**所属提交**：`ff9acee`。

**相关位置**

- `packages/eval-runtime/src/config/index.ts:190`：执行配置使用 `{ configId: idFactory(), ...input }`。
- `packages/eval-runtime/src/config/index.ts:197`：评估配置使用相同顺序。
- `packages/eval-runtime/src/config/index.ts:204`：组合配置使用相同顺序。

**大白话**

复现证明：额外传入 `configId` 时会覆盖新生成的 ID。但此前使用“拿现有配置复制出新配置”作为业务场景，该功能并不存在于当前库中，不能把假设的调用方式当成现有正常流程的缺陷依据。

**独立复现**

- 分别向三个真实 `create*Config()` 函数传入带 `configId: "existing-*"` 的已有配置，并注入返回 `"new-*"` 的 ID 工厂。
- 三次 ID 工厂都正常生成新 ID，但三个函数返回的 `configId` 都仍是输入中的旧 ID。
- TypeScript 的输入类型不包含 `configId`，但将一个完整配置变量传给对应输入参数符合结构类型规则；不需要绕过类型系统或手动篡改返回值。

**条件影响与证据限制**

- 三种创建输入的正式契约都不包含 `configId`；此前复现是额外带该字段的输入，不是已有复制功能的调用链。
- 核对 `apps`、`packages` 的全部 `createExecutionConfig`、`createEvaluationConfig`、`createPipelineConfig` 调用点，目前只有函数定义/导出和测试调用，应用层没有复制配置入口，也没有查到正常生产调用传入旧 ID 的路径。
- 边界行为确实存在，但此前的业务后果依赖假设场景，现有证据不足以按用户要求作为当前 P2 实际问题。
- 不声称未接入的真实 Store 已发生覆盖，不要求为不存在的复制功能修改代码。

**讨论结论**：撤回此前基于假设复制功能的缺陷结论；保留条件复现事实与排除原因，后续不能换一种说法重复提出同一假设场景。

**用户反馈**：2026-10-08 用户追问：“【比如拿现有配置 A 的对象，复制成一个新配置】哪里有这个功能？”用户未认可本条。核对调用链后，由评审方撤回，不冒充用户已经作出结论。

**处理状态**：已撤回，不计本轮问题。仅修正评审记录，未修改业务代码或测试。

### R-18：嵌套配置保留非契约字段（已撤回，不计本轮问题）

**所属提交**：`ff9acee`。

**相关位置**

- `packages/eval-runtime/src/config/index.ts:239`：RetryPolicy 直接展开原对象，保留非契约字段。
- `packages/eval-runtime/src/config/index.ts:260`：Agent Config 和运行参数直接展开原对象，保留非契约字段；额外嵌套对象也保留原引用。
- `packages/eval-runtime/src/runtime/index.ts:727`：整份解析后的配置参与请求幂等指纹。

**大白话**

条件复现证明：嵌套配置夹带非契约字段时，Resolver 会保留这些字段，并让它们参与请求指纹。但此前例子中的显示名、UI 提示和 UI 状态不是当前配置契约或已有功能，不能把人为塞入的字段当成正常业务路径。

**独立复现**

- Config Store 返回已知字段有效的配置，同时在 `agentConfig` 带 `displayName`，在 `retryPolicy` 带 `uiHint`，在 `runtime` 带额外的 `uiState` 对象。
- 真实 `createConfigResolver()` 接受该配置，输出保留上述额外字段，`resolved.harness.runtime.uiState` 与 Store 输入里的对象是同一个引用。
- 真实 `createEvalRuntime().start()` 首次执行成功；之后仅把 `displayName` 从 A 改成 B，项目、请求身份、配置 ID、Agent ID、采样次数及全部正式执行参数均不变。
- 使用完全相同的请求再次 `start()`，抛出 `RuntimeRunIdentityConflictError`，不能返回第一次的 Run。Store 中仍只有一个 Run。

**条件影响与证据限制**

- 不要求配置 version 或输入快照，不重提并行旧 Worker/CAS 场景。
- 实际执行参数或选定 Agent 改变时拒绝复用是正确行为；本条只涉及没有进入公开执行契约的额外字段。
- 接口没有采用严格拒绝非契约字段的策略，文档还明确承诺 Resolver 剥离额外字段；当前行为两者都没有做到。
- 核查当前应用和配置调用点，没有生产路径使用上述额外字段，也没有配置 Store 实现会返回上述 UI 对象；此前影响依赖构造输入。
- 条件复现和文档表述不够精确，不等同于证实当前正常流程存在缺陷。不以尚不存在的 UI/配置管理功能要求修改生产代码。

**讨论结论**：评审方主动撤回，保留条件复现及证据限制，不计本轮问题。不能换一种说法重复提出依赖非契约输入和假设功能的问题。

**用户结论**：尚未逐项讨论；撤回是评审方复核后的决定，不冒充用户结论。

**处理状态**：已撤回，不计本轮问题。仅修正评审记录，未修改业务代码或测试。

### R-19：失败 Sampling 的取消记录保存异常，阻断成功 Sampling 的评估（已修复，复审通过）

**所属提交**：`ff9acee`。属于 R-06 已确认的样本间失败隔离原则在新异常路径上的回归，不推翻既定分包或 Pipeline 编排方式。

**相关位置**

- `packages/eval-runtime/src/runtime/index.ts:492`：启动任何成功 Sampling 的评估前，先等待所有执行失败 Sampling 的评估取消记录写入。
- `packages/eval-runtime/src/runtime/index.ts:497`：任意一条取消记录的 `updateEvaluation()` 抛错都会让整个 `runPipeline()` 提前退出。
- `packages/eval-runtime/src/runtime/index.ts:519`：成功 Sampling 的评估阶段因此无法启动。
- `packages/eval-runtime/src/runtime/index.ts:557`：Run 兜底将成功执行但尚未启动评估的 Sampling 所关联 EvaluationRecord 写成失败，使用另一条取消记录的保存错误。

**大白话**

A 执行成功，B 执行失败。Runtime 本来应该继续评估 A，并把 B 的评估标成取消。但保存 B 的取消状态只要报一次错，A 的评估 Agent 就完全不会启动，A 的评估记录还会被直接标成失败。B 的收尾失败不应拖死已经可以独立评估的 A。

**独立复现**

1. 调用真实 `createEvalRuntime().pipeline()`，通过真实 `createConfigResolver()` 解析仅含正式字段的合法配置，Catalog 提供两个合法 Sample。
2. Harness 对 A 返回完成及合法产物、完整轨迹；对 B 返回明确、不可重试的执行失败。两者的资源采集和所有执行状态保存都成功。
3. 对照组所有 Store 操作正常：A 评估成功并有一个评估 Attempt，B 的评估取消，创建一个评估 Agent。
4. 故障组仅在保存 B 的取消记录时注入一次写入前异常，之后全部 Store 操作正常：A 的评估直接失败，评估 Attempt 为 0，未创建任何评估 Agent；B 的评估仍为 queued。
5. 另一次仅在 B 的取消记录实际提交后注入响应丢失，之后全部 Store 操作正常：B 的评估已经 cancelled，但 A 仍被写成评估失败，评估 Attempt 为 0，未创建任何评估 Agent。
6. 两个故障组 A 的执行事实都保持 succeeded；A 的评估错误却来自 B 的取消记录保存。

**判断边界**

- 不依赖额外字段、不存在的功能、重复 Worker、配置版本或 CAS；触发点就是当前正式流程中的 Store 写入异常。
- 不是要求实现真实数据库，也不是要求重新设计 Runtime；新加的批量取消写入成为了所有成功样本评估的共同门槛。
- 与 R-16 区分：R-16 是同一 Attempt 的 Agent 完成事实被收尾错误改写；本条是另一个 Sampling 的收尾错误阻断成功 Sampling 的独立生命周期。
- 本条不要求执行、评估跨阶段流式并发；仍可以先完成整批执行，再进入评估。

**修复要求**：将取消状态的保存及必要重试限制在对应失败 Sampling 的 EvaluationRecord 内，不让它阻止其他成功 Sampling 的评估。保留并处理取消写入错误，不能简单吞错，也不能把它写进无关 Sampling 的评估失败原因。不在本轮固化重试次数、退避或新增独立编排实体。

**用户结论**：2026-10-08 已确认。用户明确表示：“是问题，记录”。

**处理状态**：已修复，2026-10-08 复审通过。

**修复实现**

- `runtime/index.ts` 在执行批次结束后，并行启动成功样本的评估调度与失败样本的取消收尾；取消不占评估 Agent 并发槽，也不构成成功样本启动评估的门槛。
- 每个取消流程仅校准/重试自己的 EvaluationRecord。耗尽或不可重试时，错误保存到对应记录的 `lastError`；已保存的取消在校准后直接确认，不降级为失败。
- 如果连对应错误记录也无法保存，`EvalRuntimeDependencies.onError` 接收包含 Evaluation/Sampling 身份及两次原始错误的 AggregateError；默认 `console.error`，自定义上报回调抛错时仍使用默认上报。不吞错，也不把取消异常交给整批 `failRun()`。
- 回归覆盖取消写前失败、提交后响应丢失、B 的重试被阻塞时 A 已完成评估、取消失败的局部记录、无法记录错误时的上报、取消校准读取暂时失败，以及没有可评估样本/多个取消的相互隔离。

**复审结论**

- 成功 Sampling 的评估调度与失败 Sampling 的取消收尾并行启动，取消不占用评估 Agent 并发槽。B 的保存重试被阻塞时，A 仍能独立完成评估。
- 每个取消流程仅处理自己的 EvaluationRecord：提交后响应丢失能够校准，已经保存的取消不降级；取消保存失败不会传播到其他 Sampling 或触发整批失败重写。
- 取消及其错误记录均无法保存时，错误通过带 Evaluation/Sampling 身份的 AggregateError 上报；默认上报和自定义回调同步抛错的回退路径均有覆盖，没有以吞错代替失败隔离。
- 本次复审未发现与 R-19 修复相关的新缺陷；既定分包、阶段顺序和 Pipeline 仅编排的边界保持不变。

### 问题复现时验证（修复前）

- 全仓 `pnpm check` 和 `pnpm test` 通过，共 337 个测试。既有测试通过不代表上述独立复现已被覆盖。
- 两次无文件修改的 Node 脚本独立复现三个行为：额外传入旧 ID 时三个 Config 创建函数丢弃新 ID；仅额外显示名变化导致同请求冲突；执行与评估的已完成 Attempt 被资源保存异常改写为失败。复现本身不等于证实现有业务触发路径，R-17 已据此撤回。
- 后续核对 R-18 的配置及应用调用链，同样未证实现有正常流程触发，评审方主动撤回。另以无文件修改的 Node 脚本运行 R-19 的正常对照、取消写入前异常及提交后响应丢失三组真实 Runtime 调用，断言两种异常下成功 Sampling 的评估 Agent 均未创建且评估被标为失败。
- 本轮只更新本评审 Markdown；不修改生产代码、测试或 CI，也不提交 Git。

### R-16 / R-19 修复后验证（2026-10-08）

- 先补回归并确认修复前五个聚焦用例失败：已完成 Attempt 被资源保存异常影响，以及 B 取消保存异常阻断 A 的评估。
- 修复后全仓 `pnpm check`、`pnpm test`、`pnpm build` 通过，共 376 个测试，其中 Runtime 201 个。
- 四个包均通过 `tsc --noEmit -p tsconfig.json --noUnusedLocals --noUnusedParameters`，`git diff --check` 通过。
- 仅修改 `eval-platform` 的 Runtime 实现、相关回归测试和边界/评审文档；不修改 SP、Dataset、Metrics、Config 或 CI 生产代码，不处理已撤回的 R-17/R-18，不提交 Git。SP 与真实数据库仍按注入的公开能力契约验证，不声称已完成真实云端集成。

### R-16 / R-19 复审验证（2026-10-08）

- 复审对象为 `ff9acee` 基础上的当前工作树修复，核对生产代码、共享保存流程、阶段 RetryController 和新增回归测试；CI 不在评审范围。
- 复审实际执行 Runtime 测试，201 个全部通过；随后全仓 `pnpm check`、`pnpm test` 通过，共 376 个测试；`git diff --check` 通过。
- 检查两种 Agent 的终态/资源/产物保存写前失败与提交后响应丢失、固定完成时间、保存重试耗尽、原 Agent 错误保留，以及取消保存异常、长时间重试、错误上报和多个取消之间的隔离。
- 共享保存函数具有明确的现有调用点，没有引入另一份 Agent 事实、重复 Run 状态、legacy 兼容分支、新配置版本、额外编排实体或 SP 私有实现依赖。
- R-16、R-19 均复审通过，未发现本次两项修复相关的新问题。本次复审仅更新本评审文档，不修改业务代码或测试，不提交 Git。

## 恢复与 Worker 新提交复审（2026-10-10）

**评审范围**：`741f645` 的共享查询投影、`c8e5e6c` 的 PostgreSQL 持久化和 `564c974` 的 Runtime 恢复、单实例 Worker；以当前 HEAD `564c974` 独立复现。只审核生产代码，不审核 Agent 或 CI/CD 改动。SP 接线尚未完成、默认重试策略及后续统一完善的超时/取消/通知补漏，不计为当前问题。

| 编号 | 问题 | 严重程度 | 状态 |
| --- | --- | --- | --- |
| R-20 | 保存响应丢失且读回确认失败时，旧内存对象的失败收尾覆盖已落库的 Agent 终态或资源快照 | P2 | 已修复，待复审 |
| R-21 | 恢复时刷新已有资源快照失败，会用采集失败覆盖并删除已保存的原始记录 | P2 | 已修复，待复审 |

### R-20：失败收尾用旧对象覆盖已经存好的事实（已修复，待复审）

**所属提交**：`564c974`。这是新恢复改动引入的 R-16 事实保留原则回归，不改变 R-16 在此前提交上的通过记录。

**相关位置**

- `packages/eval-runtime/src/runtime/execution.ts:45`：改为 `persistRuntimeRecord()` 成功返回后才推进 `current`；保存已经提交、但返回异常且读回失败时，`current` 仍是旧对象。
- `packages/eval-runtime/src/runtime/evaluation.ts:45`：Evaluation 使用同样的保存顺序，`currentEvaluation` 同样可能落后于数据库事实。
- `packages/eval-runtime/src/runtime/store.ts:82`：保存失败后的读回异常被视为无法确认提交；重试耗尽时抛出原保存错误。
- `packages/eval-runtime/src/runtime/agent-lifecycle.ts:342`：进入错误收尾时先调用 `setSamplingStatus("failed")`，其回调用尚未校准的旧对象保存整条记录。
- `packages/eval-runtime/src/runtime/execution.ts:137`、`packages/eval-runtime/src/runtime/evaluation.ts:167`：外层虽然会读取最新记录，但执行到这里前，Lifecycle 的失败状态写入已经覆盖了原事实。
- `apps/eval-api/src/db/runtime.ts:231`、`apps/eval-api/src/db/runtime.ts:242`：Sampling/Evaluation 更新原子替换整份 `facts`，因此旧对象确实会覆盖数据库里已有的终态和原始资源，不只是查询展示错误。

**大白话**

数据库已经存好了 Agent 的完成状态，或者已经存好了 Token、费用等原始资源记录。但是保存的成功响应丢了，Runtime 以为保存失败；紧接着读回确认又碰上临时故障。重试耗尽后，Runtime 拿内存里的旧记录写“本阶段失败”，把数据库里刚存好的内容也一起覆盖掉。结果可能把已经完成的 Agent 改回运行中，或者把已经保存的资源快照改回“待采集”。

**独立复现**

1. 使用独立临时 PostgreSQL 数据库，应用本库迁移；通过真实 Dataset/Catalog/RuntimeStore、真实 `createConfigResolver()` 和真实 `createEvalRuntime().pipeline()` / `resume()` 运行，Harness 仅注入合法完成结果和合法资源快照。
2. 对目标 Stage 的真实 Store 写入增加故障注入：先完成实际数据库提交，再抛出“保存响应丢失”；紧接着的读回确认抛出一次临时错误。注入的 RetryController 明确允许一次 `persistence` 重试；两次同一事实保存均已提交，但两次确认都暂时不可用。之后读写恢复正常，未要求无限重试。
3. 对 Subject/Evaluator 分别在终态保存、资源保存、最终输出保存三个位置执行上述场景，并分别运行读回正常的对照，共 12 组。
4. Subject/Evaluator 的终态保存故障组均得到：最终 Stage 为 `failed`，原已落库 `Attempt.status: completed` 被覆盖为 `running`，原 `completedAt` 被清掉。
5. Subject/Evaluator 的资源保存故障组均得到：终态仍为 `completed`，但数据库中已经提交的 `resources: collected` 和完整快照被覆盖为 `resources: pending`；原快照不再存在。资源只采集一次，Stage 失败后没有重新采集。
6. 读回正常的对照全部成功；最终输出保存故障组也全部成功，因为这条路径在旧对象回写前就进入外层的最新记录校准。问题限定在 Lifecycle 内部收尾，不声称所有保存失败都会丢数据。
7. 再调用 `resume()`，故障组没有继续执行或补采集；真实 `listRecoverableRunIds()` 也不再返回这些 Run，因为 Stage 已被写成终态失败。因此丢掉的终态/快照不会由现有定时扫描自动修复。所有组均未重启 Agent。
8. 复现完成后删除临时数据库，未改动既有 SP 应用数据库或仓库生产代码。

**判断边界**

- 问题不是“保存必须永远重试”，也不是“SP 尚未接入”；允许重试耗尽和 Stage 收尾失败，但不能因此删除已经提交的 Agent 事实。
- 真正的触发条件是现有正式 Store 边界上的提交响应丢失及暂时读回失败，不需要多个 Worker、越过输入契约或假设新功能。
- 原子提交已经有效；错误发生在随后对同一记录的旧事实覆盖，不能靠补原子性解决。

**已确认的处理原则**：同一 Stage 的任何失败收尾都不能绕过最新事实校准；能够读回时基于真实持久化记录收尾，不能确认时不得拿旧整条对象覆盖，保留可恢复进度并上报异常。Agent 已确认终态和已经保存的资源必须保留，不增加第二份权威状态、版本或独立任务模型。后续授权的实现及验证见下方修复记录。

**SP 对照**：在用户指定的 `sp-agent-config-model-dev-release-20261008` worktree 中，`@springbrand/agent-runtime@0.3.0-alpha.15` 的 `SubmissionLifecycle.finish()` 写前读取最新持久化记录；`SubmissionFinalizer.commit()` 在事务内再次读取；`SubmissionRepository.updateTerminal()` 只更新非终态。SP API 的 Action Execution 同样以 `status = running` 为条件写首次终态并读回获胜记录。Eval 复用“最新事实优先、条件写入、未知结果不拿旧对象收尾”的规则，仍只通过 SP 公开 Harness 接口接入。核对位置：`agent/node_modules/@springbrand/agent-runtime/src/submission/lifecycle.ts:522`、`src/submission/finalization.ts:66`、`src/submission/repository.ts:410`、`api/src/models/action-execution-log/index.ts:86`。

**用户结论**：2026-10-10 已确认。用户明确表示：“确认是问题，记录，下一个”。

**前次评审修改范围**：只追加评审 Markdown；没有修改生产代码、测试、Agent 或 CI，没有提交 Git。

### R-21：补采失败清掉先前存好的原始资源（已修复，待复审）

**所属提交**：`564c974` 的 Attempt 恢复路径；与 R-20 的“保存响应丢失、旧对象回写”不同，本条只需再次读取 SP 资源失败，无需数据库写入或读回异常。

**相关位置**

- `packages/eval-runtime/src/runtime/agent-lifecycle.ts:307`：恢复的 Attempt 已有 `resources: collected`，但 Agent 终态刚被确认或快照未 finalized 时，会再次采集资源。
- `packages/eval-runtime/src/runtime/agent-lifecycle.ts:550`：补采失败或重试耗尽时返回新的 `resources: failed`，该对象没有旧快照。
- `packages/eval-runtime/src/runtime/agent-lifecycle.ts:314`：无条件把这个失败对象写回原 Attempt，覆盖先前 `collected` 的完整原始记录。
- `apps/eval-api/src/db/runtime.ts:231`、`apps/eval-api/src/db/runtime.ts:242`：真实 PostgreSQL Store 更新整份记录，无法保留被覆盖的旧快照。
- `packages/eval-runtime/src/runtime/index.test.ts:3107`：现有恢复测试已经把“终态未确认，但先前已采集资源”的状态作为正式恢复场景，只覆盖补采成功，没有覆盖补采失败。

**大白话**

上次已经存下一份 Agent 的 Token、费用或工具调用原始记录。进程恢复时确认 Agent 已结束，于是想重新采集一份更新的资源快照。如果这次补采刚好失败，代码会把旧快照删除，只留下“采集失败”。Agent 执行仍可能显示成功，但之前明明已知的资源事实也看不到了。

**独立复现**

1. 调用真实 `createEvalRuntime().start()` 准入一个合法执行 Run；为该 Run 设置已有 Attempt：执行仍待恢复、SP operation 身份已保存、`resources: collected` 含一条原始用量事件，快照 `finalized: false`、`coverage: partial`。该状态符合当前恢复路径和既有回归测试的前提。
2. 调用真实 `resume(runId)`；Harness `inspectAgentOperation()` 返回 `completed`，`collectAgentResources()` 本次抛出暂时不可用错误，`collectExecution()` 返回成功产物和轨迹；Store 只实现既定公开接口，无数据库或 SP 私有实现。
3. 结果：执行阶段 `succeeded`；补采确实调用一次，Submission 没有重新提交；Attempt 资源从 `collected` 变为 `failed`，已保存的原始用量快照消失。单纯补采失败就足以触发，不需要 R-20 的响应丢失或写入失败。
4. 代码的同一分支对终态尚未持久化、但已有 `finalized: true` 快照也会刷新；因此风险不限于部分快照。该进一步范围根据分支条件推断，本次独立脚本实际复现的是 `finalized: false`。

**已确认的共同原则**：与 R-20 一起遵守“已经保存的真实事实不能倒退或被失败收尾抹掉”。已有采集快照是已保存事实，刷新失败不能把它替换成无快照的失败结果；继续保留原始记录及其真实 `coverage/finalized`，另外如实处理此次刷新错误，不把不完整快照伪装成完整。两条触发路径可以在同一次修复中处理，但都要有独立回归；不预设新数据模型或重试次数。

**用户结论**：2026-10-10 已确认与 R-20 属于同一原则。用户明确表示：“相同原则，记录，下一个”。

**前次评审修改范围**：只更新评审 Markdown；没有修改生产代码、测试、SP、Agent 或 CI，没有提交 Git。

## R-20 / R-21 修复记录（2026-10-10）

- RuntimeStore 的 Sampling/Evaluation 更新现在携带预期旧事实。PostgreSQL 用同一条条件 UPDATE 校验 JSONB facts 后写入；条件不匹配时返回冲突，Runtime 只读回校准，不用旧整条记录覆盖。没有新增版本字段或表。
- 保存和读回都不能确认提交时，Lifecycle 不执行旧内存对象的失败回写；异常上报给 Worker，未完成阶段保留恢复入口。已确认写入未提交时，失败收尾先读取最新记录，并在条件写入下保留已观察到的 Agent 终态及已有的产物事实。收尾所见记录与预期旧事实、目标事实都不一致时停止写入。
- 首次资源采集失败仍记录 failed。已有 collected 快照的补采失败只报告带 Stage、Sampling、Submission 身份的错误，保留原始快照和它真实的 coverage/finalized；finalized 快照不再补采。
- 新增 Subject/Evaluator 在终态和资源保存的写前失败、提交后响应丢失且读回失败回归，以及两种角色的补采失败、finalized 快照跳过补采测试。Runtime 全套 223 项测试和 workspace 类型检查通过；使用临时 PostgreSQL 18.3 容器执行 eval-api 全套 19 项测试，全部通过。没有修改 SP 实现。
- 代码已修复，仍待独立复审。本轮未提交 Git。
