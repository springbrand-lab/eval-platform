import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button, Field, FieldDescription, FieldLabel, Input, NativeSelect } from "@springbrand/site-block";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { agentKeys, listAgentOptions } from "@/api-sdk/agent-configs-api";
import { datasetKeys, listDatasetData, listDatasets } from "@/api-sdk/datasets-api";
import { OutputFormatPicker } from "@/features/output-schemas/output-format-picker";
import { createProject, projectKeys } from "@/api-sdk/projects-api";
import type { Data, ProjectCreateInput } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Card, CardBody, CardHeader, DescriptionList } from "@/components/ui/card";
import { Stepper } from "@/components/ui/data-display";
import { HierarchyBranch } from "@/components/ui/hierarchy-picker";
import { EmptyState, ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { Checkbox, RadioCards } from "@/components/ui/form";
import { dataTitle } from "@/features/datasets/dataset-detail-page";
import { isWriteOutcomeUnknown } from "@/lib/errors";
import { newIdempotencyKey } from "@/lib/files";
import type { EvalInputLimits } from "@eval-platform/eval-contracts";
import { useInputLimits } from "@/features/input-limits";

const STEPS = ["用例", "采样次数", "执行 Agent", "评估与运行"];

interface DatasetChoice {
  /** null: every current member. */
  dataIds: Set<string> | null;
}

export interface ProjectDraft {
  name: string;
  description: string;
  datasets: Map<string, DatasetChoice>;
  samplingCount: number;
  samplingCounts: Record<string, number>;
  subjectAgentId: string;
  executionConcurrency: number;
  executionTimeoutMinutes: string;
  withEvaluation: boolean;
  evaluatorAgentId: string;
  evaluationConcurrency: number;
  outputSchemaId: string;
  firstRun: "execution" | "pipeline";
}

function positive(value: number, max = Number.MAX_SAFE_INTEGER): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}

/** The request body, or the first problem in the draft. */
export function buildProjectInput(draft: ProjectDraft, idempotencyKey: string, members: Map<string, readonly Data[]>, limits: EvalInputLimits): ProjectCreateInput | string {
  if (!draft.name.trim()) return "请填写 Project 名称";
  if (draft.datasets.size === 0) return "请至少选择一个数据集";
  const selectedData = new Set<string>();
  const datasets = [...draft.datasets].map(([datasetId, choice]) => {
    if (choice.dataIds && choice.dataIds.size === 0) return null;
    for (const dataId of choice.dataIds ?? (members.get(datasetId) ?? []).map((item) => item.dataId)) selectedData.add(dataId);
    return choice.dataIds ? { datasetId, dataIds: [...choice.dataIds] } : { datasetId };
  });
  if (datasets.includes(null)) return "部分选择的数据集没有勾选任何用例";
  if (selectedData.size === 0) return "所选数据集没有用例";
  if (selectedData.size > limits.runTargetIds) return `用例总数不能超过 ${limits.runTargetIds}`;
  if (!positive(draft.samplingCount, limits.samplingCountMax)) return `默认采样次数需要是 1–${limits.samplingCountMax} 的整数`;
  const overrides = Object.entries(draft.samplingCounts).filter(([dataId, count]) => selectedData.has(dataId) && count !== draft.samplingCount);
  if (overrides.some(([, count]) => !positive(count, limits.samplingCountMax))) return `采样次数需要是 1–${limits.samplingCountMax} 的整数`;
  if (!draft.subjectAgentId) return "请选择执行 Agent";
  if (!positive(draft.executionConcurrency)) return "执行并发需要是正整数";
  const timeout = draft.executionTimeoutMinutes.trim() ? Number(draft.executionTimeoutMinutes) : undefined;
  const timeoutMs = timeout === undefined ? undefined : Math.round(timeout * 60_000);
  if (timeoutMs !== undefined && !positive(timeoutMs)) return "超时时间需要换算为有效的正整数毫秒";
  if (draft.withEvaluation) {
    if (!draft.evaluatorAgentId) return "请选择评估 Agent";
    if (!positive(draft.evaluationConcurrency)) return "评估并发需要是正整数";
    if (!draft.outputSchemaId) return "请选择评估结果格式";
  } else if (draft.firstRun === "pipeline") {
    return "执行 + 评估需要先填写评估计划";
  }
  return {
    idempotencyKey,
    name: draft.name.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    datasets: datasets as ProjectCreateInput["datasets"],
    samplingCount: draft.samplingCount,
    ...(overrides.length > 0 ? { samplingCounts: Object.fromEntries(overrides) } : {}),
    execution: {
      userAgentId: draft.subjectAgentId,
      framework: "sp",
      executionConcurrency: draft.executionConcurrency,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    },
    ...(draft.withEvaluation ? {
      evaluation: {
        userAgentId: draft.evaluatorAgentId,
        evaluationConcurrency: draft.evaluationConcurrency,
        outputSchemaId: draft.outputSchemaId,
      },
    } : {}),
    run: { operation: draft.firstRun },
  };
}

export function NewProjectPage({ datasetId }: { datasetId?: string } = {}) {
  const limits = useInputLimits();
  if (!limits.data) return <Page><PageHeader title="新建项目" />{limits.error ? <ErrorBlock error={limits.error} onRetry={() => void limits.refetch()} /> : <LoadingBlock />}</Page>;
  return <ProjectForm limits={limits.data} datasetId={datasetId} />;
}

function DatasetCases({ datasetId, choice, disabled, onChange }: {
  datasetId: string; choice?: DatasetChoice; disabled: boolean;
  onChange: (ids: Set<string>) => void;
}) {
  const members = useQuery({ queryKey: datasetKeys.members(datasetId), queryFn: ({ signal }) => listDatasetData(datasetId, signal) });
  if (members.isPending) return <LoadingBlock rows={2} />;
  if (members.error) return <ErrorBlock error={members.error} onRetry={() => void members.refetch()} />;
  return members.data.length === 0 ? <p className="px-4 py-3 text-xs text-text-muted">这个数据集还没有用例。</p> : members.data.map((item) => (
    <HierarchyBranch key={item.dataId} label={dataTitle(item)} detail="用例" collapsible={false} checked={!!choice && (!choice.dataIds || choice.dataIds.has(item.dataId))}
      disabled={disabled} onCheckedChange={(checked) => {
        const next = new Set(choice ? choice.dataIds ?? members.data.map((data) => data.dataId) : []);
        if (checked) next.add(item.dataId); else next.delete(item.dataId);
        onChange(next);
      }} />
  ));
}

function DatasetSelection({ datasets, selectedIds, search, disabled, onToggle }: {
  datasets: readonly { datasetId: string; name: string; description?: string | null }[];
  selectedIds: ReadonlySet<string>;
  search: string;
  disabled: boolean;
  onToggle: (datasetId: string, checked: boolean) => void;
}) {
  const query = search.trim().toLowerCase();
  const visible = datasets.filter((dataset) => `${dataset.name} ${dataset.description ?? ""}`.toLowerCase().includes(query));
  return <div className="flex flex-col gap-3">
    <div className="border-b border-border px-3 pb-3">
      <p className="text-sm font-semibold text-text-strong">选择数据集</p>
      <p className="mt-1 text-xs text-text-muted">先添加数据集，下一步再从数据集中选择具体用例。</p>
    </div>
    <div className="flex flex-col gap-1">
      {visible.map((dataset) => <HierarchyBranch key={dataset.datasetId} label={dataset.name}
        detail={dataset.description || "数据集"} collapsible={false} checked={selectedIds.has(dataset.datasetId)}
        disabled={disabled} onCheckedChange={(checked) => onToggle(dataset.datasetId, checked)} />)}
      {visible.length === 0 && <p className="px-3 py-5 text-sm text-text-muted">没有匹配的数据集。</p>}
    </div>
  </div>;
}

function ProjectForm({ limits, datasetId }: { limits: EvalInputLimits; datasetId?: string }) {
  const formId = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [datasetPickerOpen, setDatasetPickerOpen] = useState(false);
  const [pendingDatasetIds, setPendingDatasetIds] = useState<Set<string>>(new Set());
  const [datasetSearch, setDatasetSearch] = useState("");
  // Unknown outcomes replay the captured request with this same key.
  const [idempotencyKey] = useState(() => newIdempotencyKey("project"));
  const [draft, setDraft] = useState<ProjectDraft>({
    name: "", description: "", datasets: new Map(datasetId ? [[datasetId, { dataIds: null }]] : []), samplingCount: 1, samplingCounts: {},
    subjectAgentId: "", executionConcurrency: 2, executionTimeoutMinutes: "",
    withEvaluation: true, evaluatorAgentId: "", evaluationConcurrency: 2, outputSchemaId: "", firstRun: "pipeline",
  });
  const update = (patch: Partial<ProjectDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const datasets = useQuery({ queryKey: datasetKeys.list(), queryFn: ({ signal }) => listDatasets(signal) });
  const selectedIds = [...draft.datasets.keys()];
  const memberQueries = useQueries({
    queries: selectedIds.map((datasetId) => ({
      queryKey: datasetKeys.members(datasetId),
      queryFn: ({ signal }: { signal: AbortSignal }) => listDatasetData(datasetId, signal),
    })),
  });
  const members = new Map(selectedIds.map((id, index) => [id, memberQueries[index]?.data ?? []] as const));
  const agents = useQuery({ queryKey: agentKeys.options("subject", "execution"), queryFn: ({ signal }) => listAgentOptions("subject", "execution", signal) });
  const evaluators = useQuery({ queryKey: agentKeys.options("evaluator", "evaluation"), queryFn: ({ signal }) => listAgentOptions("evaluator", "evaluation", signal) });

  const selectedById = new Map<string, Data>();
  for (const [datasetId, choice] of draft.datasets) {
    for (const item of members.get(datasetId) ?? []) {
      if (!choice.dataIds || choice.dataIds.has(item.dataId)) selectedById.set(item.dataId, item);
    }
  }
  const selectedData = [...selectedById.values()];
  const totalSamplings = selectedData.reduce((sum, item) => sum + (draft.samplingCounts[item.dataId] ?? draft.samplingCount), 0);
  const missingEvalPrompt = selectedData.filter((item) => !item.evalPrompt).length;

  const result = buildProjectInput(draft, idempotencyKey, members, limits);
  const create = useMutation({
    mutationFn: (input: ProjectCreateInput) => createProject(input),
    meta: { silent: true },
    onSuccess: async ({ project }) => {
      toast.success("项目已创建，首个 Run 已提交");
      await queryClient.invalidateQueries({ queryKey: projectKeys.all });
      void navigate({ to: "/projects/$projectId", params: { projectId: project.projectId } });
    },
  });
  const uncertain = create.isError && isWriteOutcomeUnknown(create.error);
  const frozen = create.isPending || uncertain;

  const openDatasetPicker = () => {
    if (frozen) return;
    setPendingDatasetIds(new Set(draft.datasets.keys()));
    setDatasetPickerOpen(true);
  };
  const cancelDatasetPicker = () => {
    if (frozen) return;
    setDatasetPickerOpen(false);
    setDatasetSearch("");
  };
  const applyDatasetSelection = () => {
    if (frozen || pendingDatasetIds.size === 0) return;
    const next = new Map<string, DatasetChoice>();
    for (const datasetId of pendingDatasetIds) next.set(datasetId, draft.datasets.get(datasetId) ?? { dataIds: new Set() });
    update({ datasets: next });
    setDatasetPickerOpen(false);
    setDatasetSearch("");
  };
  const togglePendingDataset = (datasetId: string, checked: boolean) => {
    if (frozen) return;
    setPendingDatasetIds((current) => {
      const next = new Set(current);
      if (checked) next.add(datasetId); else next.delete(datasetId);
      return next;
    });
  };
  const removeDataset = (datasetId: string) => {
    if (frozen) return;
    const next = new Map(draft.datasets);
    next.delete(datasetId);
    update({ datasets: next });
    if (next.size === 0) setDatasetPickerOpen(false);
  };
  const setChoice = (datasetId: string, dataIds: Set<string> | null) => {
    if (frozen) return;
    const next = new Map(draft.datasets);
    next.set(datasetId, { dataIds });
    update({ datasets: next });
  };

  const stepValid = [
    !!draft.name.trim() && draft.datasets.size > 0 && selectedData.length > 0,
    selectedData.length > 0 && positive(draft.samplingCount, limits.samplingCountMax),
    !!draft.subjectAgentId && positive(draft.executionConcurrency),
    typeof result !== "string",
  ];

  const agentOptions = (agents.data ?? []).map((option) => ({ value: option.agentConfig.userAgentId, label: option.name }));
  const evaluatorOptions = (evaluators.data ?? []).map((option) => ({ value: option.agentConfig.userAgentId, label: option.name }));

  return (
    <Page narrow>
      <PageHeader title="新建项目" description="选择测试数据，定义采样与 Agent，确认后开始第一次运行。" crumbs={[{ label: "项目管理", to: "/projects" }]} />
      <fieldset disabled={frozen} className="min-w-0">
      <div className="mb-5"><Stepper steps={STEPS} current={step} onSelect={setStep} /></div>

      {step === 0 && (
        <div className="flex flex-col gap-4">
          <Card>
            <CardBody className="grid gap-4 md:grid-cols-2">
              <Field><FieldLabel htmlFor={`${formId}-name`}>名称</FieldLabel><Input id={`${formId}-name`} required value={draft.name} onChange={(event) => update({ name: event.target.value })} /></Field>
              <Field><FieldLabel htmlFor={`${formId}-description`}>说明</FieldLabel><Input id={`${formId}-description`} value={draft.description} onChange={(event) => update({ description: event.target.value })} /></Field>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="测试数据范围" description="按数据集选择用例。创建项目时保存当前数据副本，之后修改数据集不会更新已有项目。" actions={<span className="text-xs text-text-muted tabular">已选 {selectedData.length} 条用例</span>} />
            {datasets.isPending ? <LoadingBlock rows={3} /> : (datasets.data ?? []).length === 0 ? (
              <EmptyState title="还没有数据集" action={<Link to="/datasets" className="link text-[13px] font-semibold">去导入</Link>} />
            ) : !datasetPickerOpen && draft.datasets.size === 0 ? (
              <EmptyState
                title="还没有添加数据集"
                description="先添加数据集，再选择其中的用例。"
                action={<Button type="button" onClick={openDatasetPicker}><Plus className="size-4" />添加数据集</Button>}
              />
            ) : datasetPickerOpen ? (
              <CardBody className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <Input aria-label="搜索数据集" placeholder="搜索数据集" value={datasetSearch} disabled={frozen} onChange={(event) => setDatasetSearch(event.target.value)} />
                  <Button type="button" variant="ghost" size="sm" disabled={frozen} onClick={cancelDatasetPicker}>取消</Button>
                </div>
                <DatasetSelection datasets={datasets.data ?? []} selectedIds={pendingDatasetIds} search={datasetSearch} disabled={frozen} onToggle={togglePendingDataset} />
                <div className="flex items-center justify-between border-t border-border pt-3">
                  <span className="text-xs text-text-muted">已选 {pendingDatasetIds.size} 个数据集</span>
                  <Button type="button" size="sm" disabled={frozen || pendingDatasetIds.size === 0} onClick={applyDatasetSelection}>添加数据集</Button>
                </div>
              </CardBody>
            ) : (
              <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-muted/40 px-3 py-2.5">
                  <div><p className="text-sm font-semibold text-text-strong">选择用例</p><p className="mt-0.5 text-xs text-text-muted">数据集已添加。勾选要运行的具体用例。</p></div>
                  <div className="flex items-center gap-2"><span className="text-xs text-text-muted">已选 {selectedData.length} 条用例</span><Button type="button" variant="outline" size="sm" disabled={frozen} onClick={openDatasetPicker}><Plus className="size-3.5" />添加数据集</Button></div>
                </div>
                <div aria-label="数据集与用例" className="flex min-w-0 flex-col gap-3">
                {[...(datasets.data ?? [])].filter((dataset) => draft.datasets.has(dataset.datasetId)).map((dataset) => {
                  const choice = draft.datasets.get(dataset.datasetId);
                  const list = members.get(dataset.datasetId) ?? [];
                  const selected = choice?.dataIds === null ? list.length : choice?.dataIds.size ?? 0;
                  const allSelected = !!choice && (choice.dataIds === null || (list.length > 0 && list.every((item) => choice.dataIds?.has(item.dataId))));
                  const partiallySelected = !!choice && !allSelected && selected > 0;
                  return (
                    <div key={dataset.datasetId} className="overflow-hidden rounded-lg border border-border">
                    <HierarchyBranch label={dataset.name} defaultOpen detail={`已选 ${selected}/${list.length} 条用例`} checked={partiallySelected ? "indeterminate" : allSelected}
                      disabled={frozen} onCheckedChange={(checked) => setChoice(dataset.datasetId, checked ? new Set(list.map((item) => item.dataId)) : new Set())}
                      actions={<Button type="button" variant="ghost" size="sm" disabled={frozen} onClick={() => removeDataset(dataset.datasetId)}>移除</Button>}>
                      <DatasetCases datasetId={dataset.datasetId} choice={choice} disabled={frozen} onChange={(ids) => setChoice(dataset.datasetId, ids)} />
                    </HierarchyBranch>
                    </div>
                  );
                })}
                </div>
                <p className="text-xs leading-5 text-text-muted">同一用例可能属于多个数据集，创建时只保留一份。下一步可设置默认采样次数，并单独覆盖某条用例。</p>
                {selectedData.length === 0 && <Notice tone="warning">请至少选择一个用例后继续。</Notice>}
                {draft.datasets.size > 0 && <Button type="button" variant="ghost" size="sm" className="self-start" disabled={frozen} onClick={() => { update({ datasets: new Map() }); setPendingDatasetIds(new Set()); }}>清空已选数据集</Button>}
              </CardBody>
            )}
          </Card>
          {datasets.error && <ErrorBlock error={datasets.error} onRetry={() => void datasets.refetch()} />}
          {memberQueries.map((query, index) => query.error && <ErrorBlock key={selectedIds[index]} error={query.error} onRetry={() => void query.refetch()} />)}
        </div>
      )}

      {step === 1 && (
        <Card>
          <CardBody className="flex flex-col gap-4">
            <Field className="max-w-lg"><FieldLabel htmlFor={`${formId}-count`}>默认采样次数</FieldLabel>
              <Input id={`${formId}-count`} required type="number" min={1} max={limits.samplingCountMax} value={draft.samplingCount}
                onChange={(event) => update({ samplingCount: Number(event.target.value) })} />
              <FieldDescription>{`1–${limits.samplingCountMax}。下方可以单独覆盖某条用例，共享用例的次数会保持同步。`}</FieldDescription>
            </Field>
            <div className="overflow-hidden rounded-[var(--radius-control)] border border-border">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-muted/60 px-4 py-3 text-xs text-text-muted">
                <span>数据集 → 用例 · 同一用例只创建一次，次数跨数据集同步</span>
                {Object.keys(draft.samplingCounts).some((dataId) => selectedData.some((item) => item.dataId === dataId)) && <Button type="button" variant="ghost" size="sm" onClick={() => update({ samplingCounts: {} })}>全部恢复默认</Button>}
              </div>
              <div className="p-2">
                {(datasets.data ?? []).filter((dataset) => draft.datasets.has(dataset.datasetId)).map((dataset) => {
                  const choice = draft.datasets.get(dataset.datasetId)!;
                  const list = (members.get(dataset.datasetId) ?? []).filter((item) => !choice.dataIds || choice.dataIds.has(item.dataId));
                  return <HierarchyBranch key={dataset.datasetId} label={dataset.name} detail={`数据集 · ${list.length} 条用例`} defaultOpen>
                    {list.map((item) => <HierarchyBranch key={item.dataId} label={dataTitle(item)} detail="用例" actions={
                        <div className="flex items-center gap-2">
                          <Input aria-label={`${dataTitle(item)}的采样次数`} type="number" min={1} max={limits.samplingCountMax} className="h-9 w-24 text-right"
                            value={draft.samplingCounts[item.dataId] ?? draft.samplingCount}
                            onChange={(event) => {
                              const count = Number(event.target.value);
                              const samplingCounts = { ...draft.samplingCounts };
                              if (count === draft.samplingCount) delete samplingCounts[item.dataId];
                              else samplingCounts[item.dataId] = count;
                              update({ samplingCounts });
                            }} />
                          {draft.samplingCounts[item.dataId] !== undefined && <Button type="button" variant="ghost" size="sm" onClick={() => {
                            const samplingCounts = { ...draft.samplingCounts };
                            delete samplingCounts[item.dataId];
                            update({ samplingCounts });
                          }}>恢复默认</Button>}
                        </div>
                    } />)}
                  </HierarchyBranch>;
                })}
              </div>
            </div>
            <p className="text-xs text-text-muted tabular">首次执行共 {totalSamplings} 次采样</p>
          </CardBody>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardBody className="grid gap-4 md:grid-cols-3">
            <Field><FieldLabel htmlFor={`${formId}-subject`}>执行 Agent</FieldLabel>
              <NativeSelect id={`${formId}-subject`} required value={draft.subjectAgentId} onChange={(event) => update({ subjectAgentId: event.target.value })}>
                <option value="" disabled>请选择</option>{agentOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </NativeSelect>
              <FieldDescription>仅展示用途为“执行”的 Agent。</FieldDescription>
            </Field>
            {agents.error && <div className="md:col-span-3"><ErrorBlock error={agents.error} onRetry={() => void agents.refetch()} /></div>}
            {agents.isSuccess && agentOptions.length === 0 && <div className="md:col-span-3"><Notice tone="warning">还没有可用的执行 Agent。<Link className="link font-semibold" to="/agents/new">去创建 Agent</Link></Notice></div>}
            <Field><FieldLabel htmlFor={`${formId}-execution-concurrency`}>执行并发</FieldLabel>
              <Input id={`${formId}-execution-concurrency`} required type="number" min={1} value={draft.executionConcurrency} onChange={(event) => update({ executionConcurrency: Number(event.target.value) })} />
            </Field>
            <Field><FieldLabel htmlFor={`${formId}-timeout`}>单次超时（分钟）</FieldLabel>
              <Input id={`${formId}-timeout`} inputMode="decimal" value={draft.executionTimeoutMinutes} onChange={(event) => update({ executionTimeoutMinutes: event.target.value })} />
              <FieldDescription>留空用默认值</FieldDescription>
            </Field>
          </CardBody>
        </Card>
      )}

      {step === 3 && (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="评估计划" actions={(
              <Checkbox label="现在填写" checked={draft.withEvaluation}
                onCheckedChange={(checked) => update({ withEvaluation: checked, firstRun: checked ? draft.firstRun : "execution" })} />
            )} />
            {draft.withEvaluation ? (
              <CardBody className="flex flex-col gap-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <Field><FieldLabel htmlFor={`${formId}-evaluator`}>评估 Agent</FieldLabel>
                    <NativeSelect id={`${formId}-evaluator`} required value={draft.evaluatorAgentId} onChange={(event) => update({ evaluatorAgentId: event.target.value })}>
                      <option value="" disabled>请选择</option>{evaluatorOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </NativeSelect>
                    <FieldDescription>仅展示用途为“评估”的 Agent。</FieldDescription>
                  </Field>
                  <Field><FieldLabel htmlFor={`${formId}-evaluation-concurrency`}>评估并发</FieldLabel>
                    <Input id={`${formId}-evaluation-concurrency`} required type="number" min={1} value={draft.evaluationConcurrency} onChange={(event) => update({ evaluationConcurrency: Number(event.target.value) })} />
                  </Field>
                  <Field className="md:col-span-2"><FieldLabel htmlFor={`${formId}-schema`}>评估结果格式</FieldLabel>
                    <OutputFormatPicker id={`${formId}-schema`} value={draft.outputSchemaId} disabled={frozen} onChange={(outputSchemaId) => update({ outputSchemaId })} />
                  </Field>
                </div>
                {evaluators.error && <div className="md:col-span-2"><ErrorBlock error={evaluators.error} onRetry={() => void evaluators.refetch()} /></div>}
                {evaluators.isSuccess && evaluatorOptions.length === 0 && <div className="md:col-span-2"><Notice tone="warning">还没有可用的评估 Agent。<Link className="link font-semibold" to="/agents/new">去创建 Agent，并在用途中选择“评估”</Link></Notice></div>}
                {missingEvalPrompt > 0 && <Notice tone="warning">{missingEvalPrompt} 条用例没有评估要求，评估时会被拒绝。</Notice>}
              </CardBody>
            ) : <CardBody className="text-[13px] text-text-muted">可在项目中填写评估配置。</CardBody>}
          </Card>
          <Card>
            <CardHeader title="首次运行" description="确认后复制当前用例和资源引用到项目；后续修改数据集不会改变本项目。" />
            <CardBody>
              <RadioCards<"pipeline" | "execution"> className="md:grid-cols-2" value={draft.firstRun} onValueChange={(value) => update({ firstRun: value })} options={[
                { value: "pipeline", title: "执行 + 评估", description: "采样成功后由评估 Agent 打分", disabled: !draft.withEvaluation },
                { value: "execution", title: "只执行", description: "之后再单独评估" },
              ]} />
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <DescriptionList items={[
                { label: "名称", value: draft.name || "—" },
                { label: "用例", value: `${selectedData.length} 条 · 首次 ${totalSamplings} 次采样` },
                { label: "执行 Agent", value: agentOptions.find((item) => item.value === draft.subjectAgentId)?.label ?? "—" },
                { label: "评估 Agent", value: draft.withEvaluation ? evaluatorOptions.find((item) => item.value === draft.evaluatorAgentId)?.label ?? "—" : "不评估" },
              ]} />
            </CardBody>
          </Card>
          {typeof result === "string" && <p className="text-[13px] text-danger">{result}</p>}
          {create.error && <ErrorBlock error={create.error} />}
        </div>
      )}
      </fieldset>
      {uncertain && <Notice tone="warning">提交结果尚未确认。重试会使用同一份创建请求，也可以返回项目管理查看。</Notice>}

      <div className="sticky bottom-0 -mx-4 mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex gap-2">
          <Button disabled={create.isPending} onClick={() => void navigate({ to: "/projects" })}>{uncertain ? "返回项目管理" : "取消"}</Button>
          <Button disabled={step === 0 || frozen} onClick={() => setStep(step - 1)}>上一步</Button>
        </div>
        <div className="flex items-center gap-3">
          {step === STEPS.length - 1 && <span className="text-xs text-text-muted">提交后立即开始运行，会消耗积分</span>}
          {step < STEPS.length - 1
            ? <Button disabled={!stepValid[step]} onClick={() => setStep(step + 1)}>下一步</Button>
            : <Button disabled={!uncertain && typeof result === "string"} loading={create.isPending} onClick={() => {
              const input = uncertain ? create.variables : result;
              if (input && typeof input !== "string") create.mutate(input);
            }}>{uncertain ? "重试创建" : "创建并运行"}</Button>}
        </div>
      </div>
    </Page>
  );
}
