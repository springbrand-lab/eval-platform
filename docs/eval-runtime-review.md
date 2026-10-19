# eval-runtime 评审记录

> 历史快照：记录当时代码的事实，不代表当前实现；当前行为以 `packages/eval-runtime/README.md` 与 `docs/architecture.md` 为准。

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

### R-09：三个 Run 入口缺少统一的请求级幂等（已处理）

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

- `StartRunRequest`、`EvaluateRequest` 和 `PipelineRequest` 都要求调用方提供同一次意图稳定的 `idempotencyKey`；主动重评估使用新 key。
- Runtime 按 Project 和 key 在解析可变 Config/Dataset/Sample 前快速查重；以已保存的 Run 配置快照校验请求事实，重复请求直接返回原 `RunHandle`。
- 同一 Runtime 实例中，同一 Project/key 的并发提交先按调用方事实同步：相同事实共用首次提交的 Promise 与配置快照，不同事实冲突；提交结束清理内存条目。持久化 Store 仍是最终幂等依据。
- Runtime 为操作、配置 ID、已准入的生效配置及独立评估的确定 Sampling ID 列表生成稳定指纹，避免同一身份被不同事实静默复用。
- `RuntimeStore.createRunWithSamplings()` 返回原子准入结果；Store 必须在持久化事务内再次查重，竞争请求只有一个能创建 Run/Sampling，其余复用原 Run。
- 同一 Project 的 key 对应不同请求事实时，直接返回不可重试的冲突错误。
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
- `HarnessConfig.runtime` 不只是快照字段；Runtime 将其作为 `HarnessRuntimeOptions` 交给 Harness：SP Harness 在确保 Chat 和提交 Prompt 时发送给 SP，并用其中的超时约束终态等待。Evaluator 的 Workspace 绑定由 Runtime 在创建时给出，不是运行选项。
- `HarnessConfig.framework` 必填并支持 `sp | codex | cc`；Subject 可选择三者，EvaluationConfig 固定 SP 宿主和 SP 框架。框架经 Resolver 校验、归一化后保存在 Run 快照中，参与请求幂等指纹，并传入 `ensureAgent`；返回 Handle 必须绑定所选框架，之后的提交、重启和收集复用同一 Handle。缺少或非法框架直接拒绝，不兼容静默默认 SP。
- Harness 配置只有 SP 一种，没有未实现的远程 Harness 分支。
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

### R-22：证据最终化失败时每轮从头下载，且 Run 重试预算重新计数（已实现，待复审）

**发现日期**：2026-10-19。线上 Project `稳定性测试mcp工具`（Project `7ee18b4b-abc8-4a82-929b-9d4f4769ee1e`）的 Pipeline Run `75223d13-247f-4150-91d2-8da6e3be7114` 复现。

**线上现象**

- 26 个执行中 21 个成功、5 个 `retrying`；其中 4 个的 Subject Attempt 已是 `completed`，都有产物和轨迹，但 `evidence` 为空，错误为 `execution evidence finalization failed: 服务暂时无法完成请求，请稍后重试`。
- 这 4 个不是 Agent 重跑，Attempt 都是第 1 次，执行重启数为 0；对应的 5 个评估保持 `queued`。
- 数据库只保存最后状态，不保存证据导出已经重试了多少次，也不保存每个文件的完成进度。

**大白话**

Agent 已经做完，产物也拿到了。保存证据包时只要一个文件、轨迹页或 manifest 出错，下一轮就重新列产物、重新下载全部文件、重新读完整轨迹。前面成功的文件不会写坏，但不会被流程级进度复用，带宽和时间都会重复消耗。

**相关位置**

- `packages/eval-runtime/src/runtime/execution.ts:63-89`：`exportEvidence()` 和 `EvidenceStore.save()` 被同一个幂等收集重试包住；一次失败后整段重新开始。
- `packages/eval-runtime/src/runtime/execution.ts:111-123`：瞬态失败耗尽后写入 `retrying + evidencePending`，不记录已经完成的文件或导出游标。
- `packages/eval-runtime/src/harness/evidence.ts:69-120`：先逐文件写 Blob，最后才写 manifest；中途失败没有可恢复的 bundle 进度记录。
- `apps/eval-api/src/evidence/r2-blobs.ts:91-103`：R2 Blob 会先读完整文件并计算 hash，再检查目标是否已存在，重试仍会重新从 SP 下载文件。
- `apps/eval-api/src/run-worker-queue.ts:13-22`：Run 的 pg-boss 重试跨轮重新调用 Runtime；每轮 Runtime 又创建新的固定幂等重试预算。

**影响**

- 一个坏文件或一次轨迹请求失败会阻塞整个证据包，不能利用已经成功的部分继续。
- 同一批产物和轨迹被反复读取；部分 Blob 可能留下但没有 manifest，形成无引用存储。
- 每个 Worker 轮次都重新开始 10 次瞬态重试，外层 Run 长期保持 active，页面还会把 `evidencePending` 显示成执行中。
- 不会因此重复提交或重启已完成的 Agent；风险主要是重复下载、Run 长时间不结束和错误信号误导。

**处理要求**

- 证据导出/保存需要可恢复：保存稳定的导出事实或进度，重试时复用已成功的文件和轨迹分片，不从产物列表开始重新下载全部内容。
- 重试预算不能在每次 Worker Run 轮次无条件清零；耗尽后的状态要有明确的终态或人工补收入口，不能无限保持 `retrying`。
- 展示层将“Agent 已完成、证据整理中”与“执行 Agent 仍在运行”分开统计和提示。
- 增加失败发生在单个文件、轨迹分页和 manifest 写入之后的回归，验证不会重复提交 Agent，且已保存的 Blob/manifest 可安全复用。

**用户结论**：2026-10-19 已确认。用户表示：“这是一个问题，记录下”。

**处理状态**：已实现（2026-10-19），待独立复审；SP 侧配套修复见 R-24，未修改线上数据，未提交 Git。

**实现摘要**

- 契约：`Sampling.evidenceExport`（`EvidenceExportState`：`submissionId`、`passes`、`lastError`、`progress`）。`progress` 冻结首轮的产物/Subject 输入清单、`omitted` 与 `exportedAt`，每个文件存入后记录 `sha256`，轨迹记录 `afterSeq`、已存分片和 `done`。`EVIDENCE_EXPORT_MAX_PASSES = 5`。
- EvidenceStore：`resume({evidence, limits, progress?, onProgress})` 拆成清单冻结、按 hash 存缺失文件、从游标续存轨迹分片、确定性 manifest 四步；`resume()` 是唯一入口，无进度时即新的一次导出。每完成一个文件或分片，经 `onProgress` 串行（合并排队）写入，已启动的读取全部结束后才报告失败。轨迹仍只在事件边界切分，从分片边界续读，结果与一次不中断的导出逐字节相同；单个超过文件上限的事件不会被截断或丢弃：导出在写入任何分片前以不可重试的明确错误失败。manifest 使用已持久化的 `exportedAt`，写入响应丢失后重放得到同一 `evidenceId`，`putManifest` 仍是写一次。
- Runtime：进度写入走 `persistRuntimeRecord` 条件写（R-20/R-21），写入失败或 Run 停止原样上抛，不被当作导出失败。只复用同一 `submissionId` 的进度。每轮失败 `passes + 1`；瞬态失败未满 5 轮保持 `retrying + evidencePending`，满 5 轮或不可重试时执行置为 `failed`（`evidence export failed after 5 passes: …` / `evidence export failed: …`），保留产物、输出与进度；评估保持排队，从不重新提交或重启 Subject。人工补收（`collectionPending`）在同一进度上重新给 5 轮预算；数据库 `recollect` 保留 `evidenceExport`。成功后 `evidenceExport` 被 `evidence` 引用替换。
- SP Harness：`exportEvidence` 接收 `submissionId`，作为必填查询参数随清单、文件和轨迹页请求发送，SP 按它锁定就绪判断与身份；`readTrajectory(afterSeq)` 从给定游标分页。导入前先检查所有文件大小，超过 `EVAL_EVIDENCE_FILE_MAX_BYTES` 的文件（例如单事件超大分片）在任何写入前以不可重试的明确错误失败。
- 回归：`packages/eval-runtime/src/harness/evidence.test.ts`、`src/runtime/index.test.ts`（resumable Subject evidence export）、`apps/eval-api/src/sp/harness.test.ts`、`src/sp/evidence.test.ts`、`src/evidence/blobs.test.ts`（R2 manifest 响应丢失）、`src/db/persistence.postgres.test.ts`（recollect 保留进度）。
- 展示层已由 `apps/eval-web/src/features/runs/run-status.ts` 将 `evidencePending` 显示为“整理证据中”；采样详情页由 `apps/eval-web/src/features/runs/evidence-export-progress.tsx` 展示 `evidenceExport` 的轮次、已存产物/执行输入、轨迹分段与最近错误；运行列表仍只显示“整理证据中”。WS 观察等其他预算按 R-23 处理。

### R-23：Submission WebSocket 断链与证据导出就绪状态没有形成一个可恢复的收尾流程（已实现，待复审）

**发现日期**：2026-10-19。目标是一次 Pipeline Run 中 Subject 执行和 Evaluator 评估都能完成；Subject 已经产生结果时，连接断开或证据服务暂时未就绪不能再次执行 Agent，也不能让 Run 无限停留在 `retrying`。

**先确认 WebSocket 契约是否对得上**

- Eval 的服务契约要求连接时先发送持久化状态快照，随后发送 `{"type":"submission.status","submission":AgentSubmission}`；见 `docs/eval-sp-harness-protocol.md:14`。
- 当前独立 Eval SP 分支的实现确实把连接时快照和后续通知都编码成这个事件：`/Users/apple/code/sp-platform-eval-agent-model/apps/agent/src/chat/severn-agent.ts:681-697`、`:700-714`；SP 的集成测试也断言了 `type`、真实 `submissionId` 和 `normalizedStatus`：`.../apps/agent/src/eval/http.worker.test.ts:720-733`、`:788-807`。
- Eval 端 `apps/eval-api/src/sp/submission-observer.ts:120-129` 只接受字符串 JSON 且只解析 `type === "submission.status"`，这和当前 SP 分支一致；所以现有证据不能把本次 WS 问题归因于“快照格式不一致”。仍需在 Eval 端补一个“连接后立即收到 completed 快照”的单测，避免未来 SP 只发裸 `AgentSubmission` 或改事件名时被静默忽略。

**当前已经有的兜底**

- `createSpHarness().waitForSubmission()` 先按稳定操作键读一次状态；已是终态就不建 WS，见 `apps/eval-api/src/sp/harness.ts:256-273`。
- 每次连接只观察同一个真实 `submissionId`；连接异常、关闭或 Ping/Pong 超时后做一次按键校准，再以有限次数（3 个连接）重连，见 `apps/eval-api/src/sp/submission-observer.ts:29-57`、`:60-134`。健康连接不轮询。
- Runtime 只有收到明确终态才更新 Attempt；状态不确定时不会直接重启 Agent，见 `packages/eval-runtime/src/runtime/agent-lifecycle.ts:319-367`、`:624-711`。提交重试也复用同一个操作键，见 `:514-537`。

**WS 的实际缺口**

1. `observeTerminalSubmission()` 在一次断线后的校准返回 `null` 且没有 HTTP 错误时，会在 `apps/eval-api/src/sp/submission-observer.ts:50-52` 立即抛错，不再重连。已拿到真实 Submission ID 后，`null` 只能说明“这次校准没有读到”，不能证明 Submission 已失败或不存在；应把它当作未知状态，继续使用同一 `submissionId` 重连，或持久化为 `observationPending` 交给下一轮恢复。
2. 连接次数、校准次数和等待期限只存在当前 Worker 内存。`retryIdempotentOperation()` 每次进入 `resume()` 都从 1 开始，见 `packages/eval-runtime/src/runtime/retry.ts:76-101`；外层 pg-boss 虽有 100 次重试，见 `apps/eval-api/src/run-worker-queue.ts:13-22`，但每轮又创建新的 Runtime 重试预算。连接一直不稳时，Run 会长时间处于活动态，直到 Worker 最后一轮请求停止，见 `apps/eval-api/src/worker.ts:76-96`。
3. `inspectUncertainOperation()` 会吞掉所有校准异常并返回 `undefined`，见 `packages/eval-runtime/src/runtime/agent-lifecycle.ts:624-635`。这保护了“不因校准失败而重启”，但没有把 HTTP 状态、是否返回 `null`、连接次数和下一次恢复时间写入记录或日志，线上只能看到笼统的 `Submission WebSocket closed before terminal status`。
4. 证据导出没有绑定 Attempt 的 `submissionId`：`Harness.exportEvidence` 的输入只有 Chat 和 Sampling 相关信息，见 `packages/eval-runtime/src/harness/model.ts:112-117`；SP 的 `#finishedEvalChat()` 读取的是 Chat 的 latest Submission，见 `/Users/apple/code/sp-platform-eval-agent-model/apps/agent/src/chat/severn-agent.ts:498-513`。正常流程不会在证据待收尾时再提交，但收尾、停止或人工补收并发时应显式锁定原 Submission，避免“最后一次 Submission”漂移。

**证据导出的实际失败点**

- SP 契约明确说三个导出接口在 Submission 尚未终态或 telemetry 尚未投递完时返回 `409`，见 `docs/eval-sp-harness-protocol.md:19`。独立 SP 分支的 `#finishedEvalChat()` 在非终态时抛 `EvalChatConflict`，在 telemetry 仍待投递时抛 `Complete Chat trajectory is not available yet`，见 `/Users/apple/code/sp-platform-eval-agent-model/apps/agent/src/chat/severn-agent.ts:498-513`；路由层将冲突映射为 409，通用错误则可能变成 5xx，见 `.../apps/agent/src/eval/http.ts:114-135`、`:166-188`。因此“模型已完成但证据接口暂时不可读”是正常的可恢复就绪状态，不应当作永久证据错误。
- Eval Harness 的瞬态 HTTP 分类只认 `408`、`429` 和 `>=500`，见 `apps/eval-api/src/sp/harness.ts:81-91`；证据导出中的 `409` 会变成不可重试的 `SpHarnessError`，导致 `freezeEvidence()` 直接进入失败收尾。应给证据路由返回机器可判定的 `EVIDENCE_NOT_READY`（带 `Retry-After`），只把该证据专用 409 标成可重试，不能把 Chat 身份冲突等普通 409 一并重试。
- `execution.ts:68-89` 将 `exportEvidence()`、所有文件下载、轨迹分页和 `EvidenceStore.save()` 包在一个收集重试里；`packages/eval-runtime/src/harness/evidence.ts:69-120` 逐个写 Blob/轨迹分片，manifest 最后才写，中间没有持久化游标。R2 虽按 hash 检查已存在 Blob，`apps/eval-api/src/evidence/r2-blobs.ts:85-103` 仍需先从 SP 重新读完整文件并计算 hash，再发 HEAD；所以已有 Blob 能避免二次写入，却不能避免二次下载。轨迹迭代器也每次从 `afterSeq=0` 重新分页，见 `apps/eval-api/src/sp/harness.ts:160-177`。
- 证据待收尾只保存 `retrying + evidencePending` 和最后错误，见 `packages/eval-runtime/src/runtime/execution.ts:111-139`；没有文件、轨迹游标、manifest 候选或跨 Worker 重试计数。下一轮 `executeSampling()` 又从 `collectExecution()` 和 `exportEvidence()` 的开头开始，见 `:143-169`；这正是线上“Agent 已完成、证据一直下载失败、5 个评估排队”的根因链。

**修复方案（按这个顺序实现）**

1. **先修 SP/Eval 语义，不扩大普通 409 的重试范围。** 导出接口带上锁定的 `submissionId`（或返回一次性的 immutable export snapshot ID），SP 只为这个 Submission 判断终态和 telemetry readiness；新增机器错误码 `EVIDENCE_NOT_READY` 与 `Retry-After`，终态未确认、telemetry 未投递都返回该可重试状态，文件超限、路径/身份冲突仍不可重试。SP 必须先持久化终态再发 WS 快照，重连仍发送同一 Submission 的最新快照；当前独立 SP 分支已做到快照事件，但要把“导出 readiness”从通用异常变成明确契约。
2. **Eval 端把“未知状态”和“已失败”分开。** WS 断开后按原操作键校准；返回终态就收尾，返回 running 就用同一真实 Submission ID 重连，返回 `null` 或临时 HTTP 错误就持久化 `observationPending` 并延迟恢复，绝不创建新 Attempt、绝不换幂等键、绝不因未知状态进入 `restart`。将当前内存中的 observer 次数、最近状态、下次观察时间和全局 deadline 写入 Attempt/RuntimeStore；Worker 重启后继续同一预算。只有明确的 `failed/interrupted/cancelled` 才进入 Agent 重启策略。
3. **把证据保存拆成可恢复的小步骤。** 为每个 `samplingId + attemptId + submissionId` 建立一个稳定的 Evidence Export Job（可落在 Sampling facts 的受控字段或独立 RuntimeStore 表），至少保存：导出身份、冻结后的 artifact 清单摘要、每个 artifact/Subject input 的 hash/size/完成状态、轨迹最后 `afterSeq`、已写入的 trajectory parts、omitted、manifest 候选、重试次数/下一次时间/最后错误。扩展 `EvidenceStore` 为“按 hash 写入并返回已存在、按 part/cursor 提交进度、最后 finalize manifest”的幂等操作；重试只下载缺少的文件或下一页轨迹，manifest 写入响应丢失时按内容 hash 重放，不重复提交 Agent。
4. **把重试预算持久化并设置明确出口。** Agent 的 `maxRestarts`、WS 状态观察、证据 readiness、文件/轨迹读取、R2/DB 持久化分别计数；同一收尾操作跨 Worker 累计，不在 `resume()` 里清零。预算耗尽时写明确的 `evidence_failed`/`observation_failed` 收尾事实并保留已保存内容，或转入已有的人工补收入口（`packages/eval-runtime/README.md:120`），不能无限保持 `retrying`。成功条件必须是 manifest 已保存且 `Sampling.evidence` 与执行成功状态一次条件写入；然后才解锁对应 Evaluation。
5. **补齐可观测性。** 每次 `ws_open/ws_close/ws_inspect/evidence_list/file/page/blob/manifest` 记录结构化字段：`runId,samplingId,stage,attemptId,submissionId,idempotencyKey,operation,phase,retryNumber,httpStatus,path,afterSeq`；错误只记录状态和摘要，不记录产物内容或凭证。`onError` 仍保留，但不能只报一条最终错误。

**必须通过的验收场景**

- WS：连接后收到 `submission.status` 的已完成快照直接继续；首个连接断开且按键返回 running 时重连同一 URL；按键暂时 503 或返回 `null` 时不新建 Attempt，下一轮能继续观察；状态明确 failed 时才按 `maxRestarts` 重启；相同幂等键的提交响应丢失不会产生第二个 Submission。
- 证据 readiness：Submission completed 但 SP 仍返回 `EVIDENCE_NOT_READY/409` 时等待并重试；普通 Chat 冲突/413/非法轨迹游标不重试；readiness 后逐文件下载失败只重试缺失文件。
- 断点：第 2 个 artifact 失败后恢复只读第 2 个；轨迹第 2 页失败后恢复从已保存 cursor 继续；manifest 写入响应丢失后重复 finalize 得到同一 `evidenceId`，不会重复下载或产生错误 manifest。
- 全链路：模拟一次 WS 断线、telemetry 延迟、一个文件短暂 503 和一次 R2 响应丢失，单个 Run 最终得到 `execution.succeeded -> evaluation.succeeded`，每个 Subject/Evaluator 只产生一个正常 Attempt（除非明确 Submission failed 且策略允许重启），Run 不因未知状态进入失败或无限活动。

**处理状态**：已实现（2026-10-19），待独立复审；未修改线上数据，未提交 Git。

**实现摘要**

- 观察：`submission-observer.ts` 断线后优先用 SP 新增的 `GET .../submissions/{submissionId}` 校准（旧 SP 返回 404 时回退按键读取）；`null` 或瞬时错误继续重连同一 URL，耗尽后抛出可重试的 “status unconfirmed” 错误并带上最后一次读取结果。
- Runtime：`SamplingStageState.observationPending` 跨 Worker 轮次持久化观察次数，下一轮观察同一 Submission，不新建 Attempt、不换幂等键；`OBSERVATION_MAX_ATTEMPTS = 5` 轮后以明确信息置为 `failed`。MCP 已接受结果的评估断链后保持 `succeeded`，并标记 `resourcesPending` 补采资源。`inspectUncertainOperation` 不再吞错，状态错误附带 `inspect: null|<status>|error`。
- 就绪：SP 对未完成或 telemetry 未投递的证据请求返回 `409 EVIDENCE_NOT_READY` 与 `Retry-After`；Eval 只对 GET 上的该错误码重试。
- 可观测：harness 输出 `ws_open/ws_close/ws_inspect/ws_reconnect/submission_terminal/resources_read/evidence_*` 结构化日志，经 Run Worker 写入 pino。

### R-24：SP 以 Durable Object RPC 整值返回大数据，导致资源快照/证据轨迹失败与 isolate 内存重置（已实现，待复审）

**发现日期**：2026-10-19，来自 Cloudflare Workers Logs（`severn-agent-eval`，近 8 天）与 CloudWatch。

**线上证据**

- `resources/by-key`：评估 Agent 240 次读取中 100 次 500，执行 Agent 277 次中 58 次 500；异常几乎全部为 `Serialized RPC arguments or return values are limited to 32MiB`（35–79 MB）。早期读取能成功但 `finalized=false`，数据补齐后每次都超限；Eval 保存不完整快照或 `failed` 后不再补读，表现为“积分未获得”、工具数偏少。
- `evidence/trajectory?afterSeq=0&limit=200`：40 次 500，同为 RPC 超限，证据包永远导不完，执行一直“执行中”。
- SevernAgent `/eval/submissions/{id}/events`：470 次 exception、70 次 canceled；原因是 `Durable Object connection closed because the object was reset` 与 `Network connection lost`。同一脚本版本下出现 `Durable Object's isolate exceeded its memory limit and was reset`，时间与上述大数据读取和证据导入重合，同一 isolate 内其他 Chat 的观察连接被一并断开，即 R-23 中 “Submission WebSocket closed before terminal status” 的直接原因。

**修复（SP `fix/eval-harness-large-transport`，基于 `eval` @ d6e443ac）**

- 资源快照、证据轨迹、证据文件不再作为 RPC 返回值，改为流式 `fetch`：Agent Worker → Inbox（`forwardEvalChatRequest`，经 `withOwnedChat` 校验归属）→ Chat，不是 Worker 直连 Chat。直连路由刻意推迟：它要在 Worker 中复制 Inbox 的归属与停止校验；若 Cloudflare 日志显示 Inbox 成为热点再评估。资源快照逐行写出本 Submission 的原始 telemetry body（含工具输入输出，不压缩、不丢字段），按 SQL 分批读取，不再把整段轨迹读入内存。
- 证据文件 GET/PUT 流式读写，PUT 边写边算 SHA-256，不匹配时删除；`EVAL_EVIDENCE_FILE_MAX_BYTES` 提升至 95,000,000（受 Cloudflare 免费区 100 MB 请求体上限约束）。
- 资源快照必带 `readiness`，并新增只返回 `{scope, observedAt, finalized, readiness}` 的 `resources/by-key/{key}/readiness` 路由；`collectEvalActionCharges` 将 `failed/outcome_unknown` 视为已结算（`chargedCredits: 0`，与网关释放预留一致），工具结束但无 `executionId` 不再在 Submission 终态后永久阻塞。
- SP 证据读取（artifacts、files、trajectory）必须带 `submissionId`；按 ID 读取 Submission 的路由已上线，Eval 不再在 404 时回退按键读取。
- Eval 侧：Agent 结束后先轮询 readiness 路由（同轮 5/10/20/40 s，之后以 `resourcesPending.deadline` 跨轮每 60 s，最长到 Agent 结束后 10 分钟），定稿或到期后只完整下载一次快照，不再反复重读 100+ MB；每次调用仍有 Runtime 固定的 10 次内层重试。JSON 响应上限提升到 V8 字符串上限（约 512 MiB），资源与证据传输超时 5 分钟，readiness 使用 60 s 控制超时；Web 区分“整理证据中/补采资源中/确认 Agent 状态中/资源采集失败”，并提供“重新采集资源”。

**遗留**

- （已解决）eval-api 已升级到 `@springbrand/eval-harness@0.1.0-alpha.4`，其 `EVAL_EVIDENCE_FILE_MAX_BYTES` 为 95,000,000，`spEvidenceLimits(DEFAULT_EVIDENCE_LIMITS)` 的单文件上限现为 95 MB 并已生效。
- Eval 只等待 SP 的 telemetry/runtime outbox 投递，不触发投递；按需排空需要 `@springbrand/agent-runtime` 提供带保护的 flush API。
- 资源快照已移出 `facts`：每个 Attempt 一行存于 `eval_attempt_resources.snapshot`（JSONB 单值上限约 255 MB 仍适用于单个快照），阶段事实只保存状态与摘要；见下方 Worker 内存修复。
- Worker 内存修复（2026-10-20）：Worker 每轮调度、停止轮询与汇总此前读取全部 Sampling/Evaluation 的完整 `facts`（含每个 Attempt 的原始快照，单个 Run 约 168 MB），每次小写入又重写并字符串化新旧 `facts`，512 MB 堆反复 OOM；崩溃在下载中途时下载从不计数，于是无限重下。现在：快照原文单独存表，Metrics 投影同一语句写入，阶段写入按 `revision` 条件写；每次下载前先持久化下载计数，崩溃计入同一 `resources` 重试预算，预算用尽即放弃（`exhausted`，阶段状态不变，Run 可结束）；进程内同一时间只下载一个快照；快照原地校验，不再 `structuredClone`。迁移 `0004_attempt_resources` 不回填数据。
