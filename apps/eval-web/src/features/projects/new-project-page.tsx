import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button, Field, FieldDescription, FieldLabel, Input, NativeSelect } from "@springbrand/site-block";
import { toast } from "sonner";
import { agentKeys, listAgentOptions } from "@/api-sdk/agent-configs-api";
import { datasetKeys, listDatasetData, listDatasets } from "@/api-sdk/datasets-api";
import { listOutputSchemas, outputSchemaKeys } from "@/api-sdk/output-schemas-api";
import { createProject, projectKeys } from "@/api-sdk/projects-api";
import type { Data, ProjectCreateInput } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Card, CardBody, CardHeader, DescriptionList } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Stepper, Tabs } from "@/components/ui/data-display";
import { EmptyState, ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { Checkbox, RadioCards } from "@/components/ui/form";
import { dataTitle } from "@/features/datasets/dataset-detail-page";
import { isWriteOutcomeUnknown } from "@/lib/errors";
import { newIdempotencyKey } from "@/lib/files";
import type { EvalInputLimits } from "@eval-platform/eval-contracts";
import { useInputLimits } from "@/features/input-limits";

const STEPS = ["用例", "采样次数", "被测 Agent", "评估与运行"];

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
  if (draft.datasets.size === 0) return "请至少选择一个测试集";
  const selectedData = new Set<string>();
  const datasets = [...draft.datasets].map(([datasetId, choice]) => {
    if (choice.dataIds && choice.dataIds.size === 0) return null;
    for (const dataId of choice.dataIds ?? (members.get(datasetId) ?? []).map((item) => item.dataId)) selectedData.add(dataId);
    return choice.dataIds ? { datasetId, dataIds: [...choice.dataIds] } : { datasetId };
  });
  if (datasets.includes(null)) return "部分选择的测试集没有勾选任何用例";
  if (selectedData.size === 0) return "所选测试集没有用例";
  if (selectedData.size > limits.runTargetIds) return `用例总数不能超过 ${limits.runTargetIds}`;
  if (!positive(draft.samplingCount, limits.samplingCountMax)) return `默认采样次数需要是 1–${limits.samplingCountMax} 的整数`;
  const overrides = Object.entries(draft.samplingCounts).filter(([dataId, count]) => selectedData.has(dataId) && count !== draft.samplingCount);
  if (overrides.some(([, count]) => !positive(count, limits.samplingCountMax))) return `采样次数需要是 1–${limits.samplingCountMax} 的整数`;
  if (!draft.subjectAgentId) return "请选择被测 Agent";
  if (!positive(draft.executionConcurrency)) return "执行并发需要是正整数";
  const timeout = draft.executionTimeoutMinutes.trim() ? Number(draft.executionTimeoutMinutes) : undefined;
  const timeoutMs = timeout === undefined ? undefined : Math.round(timeout * 60_000);
  if (timeoutMs !== undefined && !positive(timeoutMs)) return "超时时间需要换算为有效的正整数毫秒";
  if (draft.withEvaluation) {
    if (!draft.evaluatorAgentId) return "请选择评委 Agent";
    if (!positive(draft.evaluationConcurrency)) return "评估并发需要是正整数";
    if (!draft.outputSchemaId) return "请选择评分格式";
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

export function NewProjectPage() {
  const limits = useInputLimits();
  if (!limits.data) return <Page><PageHeader title="新建项目" />{limits.error ? <ErrorBlock error={limits.error} onRetry={() => void limits.refetch()} /> : <LoadingBlock />}</Page>;
  return <ProjectForm limits={limits.data} />;
}

function ProjectForm({ limits }: { limits: EvalInputLimits }) {
  const formId = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  // Unknown outcomes replay the captured request with this same key.
  const [idempotencyKey] = useState(() => newIdempotencyKey("project"));
  const [draft, setDraft] = useState<ProjectDraft>({
    name: "", description: "", datasets: new Map(), samplingCount: 1, samplingCounts: {},
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
  const agents = useQuery({ queryKey: agentKeys.options("subject"), queryFn: ({ signal }) => listAgentOptions("subject", signal) });
  const evaluators = useQuery({ queryKey: agentKeys.options("evaluator"), queryFn: ({ signal }) => listAgentOptions("evaluator", signal) });
  const schemas = useQuery({ queryKey: outputSchemaKeys.list(), queryFn: ({ signal }) => listOutputSchemas(signal) });

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

  const toggleDataset = (datasetId: string, on: boolean) => {
    const next = new Map(draft.datasets);
    if (on) next.set(datasetId, { dataIds: null });
    else next.delete(datasetId);
    update({ datasets: next });
  };
  const setChoice = (datasetId: string, dataIds: Set<string> | null) => {
    const next = new Map(draft.datasets);
    next.set(datasetId, { dataIds });
    update({ datasets: next });
  };

  const stepValid = [
    !!draft.name.trim() && draft.datasets.size > 0 && selectedData.length > 0,
    positive(draft.samplingCount, limits.samplingCountMax),
    !!draft.subjectAgentId && positive(draft.executionConcurrency),
    typeof result !== "string",
  ];

  const agentOptions = (agents.data ?? []).map((option) => ({ value: option.agentConfig.userAgentId, label: option.name }));
  const evaluatorOptions = (evaluators.data ?? []).map((option) => ({ value: option.agentConfig.userAgentId, label: option.name }));
  const schemaOptions = (schemas.data ?? []).map((schema) => ({ value: schema.outputSchemaId, label: schema.name }));

  return (
    <Page>
      <PageHeader title="新建项目" crumbs={[{ label: "项目管理", to: "/projects" }]} />
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
            <CardHeader title="测试集" actions={<span className="text-xs text-text-muted tabular">已选 {selectedData.length} 条用例</span>} />
            {datasets.isPending ? <LoadingBlock rows={3} /> : (datasets.data ?? []).length === 0 ? (
              <EmptyState title="还没有测试集" action={<Link to="/datasets" className="link text-[13px] font-semibold">去导入</Link>} />
            ) : (
              <div className="divide-y divide-border">
                {(datasets.data ?? []).map((dataset) => {
                  const choice = draft.datasets.get(dataset.datasetId);
                  const list = members.get(dataset.datasetId) ?? [];
                  return (
                    <div key={dataset.datasetId} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-4">
                        <Checkbox label={dataset.name} checked={!!choice} onCheckedChange={(checked) => toggleDataset(dataset.datasetId, checked)} />
                        {choice && (
                          <Tabs<"all" | "some"> value={choice.dataIds ? "some" : "all"} tabs={[
                            { value: "all", label: "全部", count: list.length },
                            { value: "some", label: "部分", ...(choice.dataIds ? { count: choice.dataIds.size } : {}) },
                          ]} onChange={(value) => setChoice(dataset.datasetId, value === "all" ? null : new Set(list.map((item) => item.dataId)))} />
                        )}
                      </div>
                      {choice?.dataIds && (
                        <div className="mt-3 overflow-hidden rounded-[var(--radius-control)] border border-border">
                          <DataTable<Data>
                            rows={list}
                            rowKey={(row) => row.dataId}
                            selectable
                            selected={choice.dataIds}
                            onSelectedChange={(next) => setChoice(dataset.datasetId, next)}
                            searchText={(row) => `${dataTitle(row)} ${row.userPrompt}`}
                            columns={[{ key: "title", header: "用例", cell: (row) => <span className="line-clamp-1">{dataTitle(row)}</span> }]}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
          {datasets.error && <ErrorBlock error={datasets.error} onRetry={() => void datasets.refetch()} />}
          {memberQueries.map((query, index) => query.error && <ErrorBlock key={selectedIds[index]} error={query.error} onRetry={() => void query.refetch()} />)}
        </div>
      )}

      {step === 1 && (
        <Card>
          <CardBody className="flex flex-col gap-4">
            <Field className="max-w-xs"><FieldLabel htmlFor={`${formId}-count`}>每条用例采样次数</FieldLabel>
              <Input id={`${formId}-count`} required type="number" min={1} max={limits.samplingCountMax} value={draft.samplingCount}
                onChange={(event) => update({ samplingCount: Number(event.target.value) })} />
              <FieldDescription>{`1–${limits.samplingCountMax}，下表可逐条覆盖`}</FieldDescription>
            </Field>
            <div className="overflow-hidden rounded-[var(--radius-control)] border border-border">
              <DataTable<Data>
                rows={selectedData}
                rowKey={(row) => row.dataId}
                searchText={(row) => dataTitle(row)}
                columns={[
                  { key: "title", header: "用例", cell: (row) => <span className="line-clamp-1">{dataTitle(row)}</span> },
                  { key: "count", header: "次数", align: "right", cell: (row) => (
                    <Input aria-label={`${dataTitle(row)}的采样次数`} type="number" min={1} max={limits.samplingCountMax} className="ml-auto h-8 w-24 text-right"
                      value={draft.samplingCounts[row.dataId] ?? draft.samplingCount}
                      onChange={(event) => update({ samplingCounts: { ...draft.samplingCounts, [row.dataId]: Number(event.target.value) } })} />
                  ) },
                ]}
              />
            </div>
            <p className="text-xs text-text-muted tabular">首次执行共 {totalSamplings} 次采样</p>
          </CardBody>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardBody className="grid gap-4 md:grid-cols-3">
            <Field><FieldLabel htmlFor={`${formId}-subject`}>被测 Agent</FieldLabel>
              <NativeSelect id={`${formId}-subject`} required value={draft.subjectAgentId} onChange={(event) => update({ subjectAgentId: event.target.value })}>
                <option value="" disabled>请选择</option>{agentOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </NativeSelect>
            </Field>
            {agents.error && <ErrorBlock error={agents.error} onRetry={() => void agents.refetch()} />}
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
                <div className="grid gap-4 md:grid-cols-3">
                  <Field><FieldLabel htmlFor={`${formId}-evaluator`}>评委 Agent</FieldLabel>
                    <NativeSelect id={`${formId}-evaluator`} required value={draft.evaluatorAgentId} onChange={(event) => update({ evaluatorAgentId: event.target.value })}>
                      <option value="" disabled>请选择</option>{evaluatorOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </NativeSelect>
                  </Field>
                  <Field><FieldLabel htmlFor={`${formId}-evaluation-concurrency`}>评估并发</FieldLabel>
                    <Input id={`${formId}-evaluation-concurrency`} required type="number" min={1} value={draft.evaluationConcurrency} onChange={(event) => update({ evaluationConcurrency: Number(event.target.value) })} />
                  </Field>
                  <Field><FieldLabel htmlFor={`${formId}-schema`}>评分 Schema</FieldLabel>
                    <NativeSelect id={`${formId}-schema`} required value={draft.outputSchemaId} onChange={(event) => update({ outputSchemaId: event.target.value })}>
                      <option value="" disabled>请选择</option>{schemaOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </NativeSelect>
                  </Field>
                </div>
                {evaluators.error && <ErrorBlock error={evaluators.error} onRetry={() => void evaluators.refetch()} />}
                {schemas.error && <ErrorBlock error={schemas.error} onRetry={() => void schemas.refetch()} />}
                {missingEvalPrompt > 0 && <Notice tone="warning">{missingEvalPrompt} 条用例没有 evalPrompt，评估时会被拒绝。</Notice>}
              </CardBody>
            ) : <CardBody className="text-[13px] text-text-muted">可在项目中填写评估配置。</CardBody>}
          </Card>
          <Card>
            <CardHeader title="首个 Run" />
            <CardBody>
              <RadioCards<"pipeline" | "execution"> className="md:grid-cols-2" value={draft.firstRun} onValueChange={(value) => update({ firstRun: value })} options={[
                { value: "pipeline", title: "执行 + 评估", description: "采样成功后由评委打分", disabled: !draft.withEvaluation },
                { value: "execution", title: "只执行", description: "之后再单独评估" },
              ]} />
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <DescriptionList items={[
                { label: "名称", value: draft.name || "—" },
                { label: "用例", value: `${selectedData.length} 条 · 首次 ${totalSamplings} 次采样` },
                { label: "被测 Agent", value: agentOptions.find((item) => item.value === draft.subjectAgentId)?.label ?? "—" },
                { label: "评委 Agent", value: draft.withEvaluation ? evaluatorOptions.find((item) => item.value === draft.evaluatorAgentId)?.label ?? "—" : "不评估" },
              ]} />
            </CardBody>
          </Card>
          {typeof result === "string" && <p className="text-[13px] text-danger">{result}</p>}
          {create.error && <ErrorBlock error={create.error} />}
        </div>
      )}
      </fieldset>
      {uncertain && <Notice tone="warning">提交结果尚未确认。重试会使用同一份创建请求，也可以返回项目管理查看。</Notice>}

      <div className="sticky bottom-0 -mx-6 mt-5 flex items-center justify-between gap-3 border-t border-border bg-bg/90 px-6 py-3 backdrop-blur">
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
