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
