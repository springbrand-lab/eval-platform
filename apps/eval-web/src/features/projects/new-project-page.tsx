import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { agentKeys, listAgentOptions } from "@/api-sdk/agent-configs-api";
import { datasetKeys, listDatasetData, listDatasets } from "@/api-sdk/datasets-api";
import { listOutputSchemas, outputSchemaKeys } from "@/api-sdk/output-schemas-api";
import { createProject, projectKeys } from "@/api-sdk/projects-api";
import type { Data, ProjectCreateInput } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, DescriptionList } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Stepper } from "@/components/ui/data-display";
import { LoadingBlock, Notice } from "@/components/ui/feedback";
import { Checkbox, Field, Input, RadioCard, Select } from "@/components/ui/form";
import { dataTitle } from "@/features/datasets/dataset-detail-page";
import { describeError } from "@/lib/errors";
import { newIdempotencyKey } from "@/lib/files";
import { RUN_TARGET_IDS, SAMPLING_COUNT_MAX } from "@/lib/limits";

const STEPS = ["基本信息与用例", "采样次数", "被测 Agent", "评估计划与首个 Run"];

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
export function buildProjectInput(draft: ProjectDraft, idempotencyKey: string, members: Map<string, readonly Data[]>): ProjectCreateInput | string {
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
  if (selectedData.size > RUN_TARGET_IDS) return `用例总数不能超过 ${RUN_TARGET_IDS}`;
  if (!positive(draft.samplingCount, SAMPLING_COUNT_MAX)) return `默认采样次数需要是 1–${SAMPLING_COUNT_MAX} 的整数`;
  const overrides = Object.entries(draft.samplingCounts).filter(([dataId, count]) => selectedData.has(dataId) && count !== draft.samplingCount);
  if (overrides.some(([, count]) => !positive(count, SAMPLING_COUNT_MAX))) return `采样次数需要是 1–${SAMPLING_COUNT_MAX} 的整数`;
  if (!draft.subjectAgentId) return "请选择被测 Agent";
  if (!positive(draft.executionConcurrency)) return "执行并发需要是正整数";
  const timeout = draft.executionTimeoutMinutes.trim() ? Number(draft.executionTimeoutMinutes) : undefined;
  if (timeout !== undefined && !(timeout > 0)) return "超时时间需要是正数";
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
      ...(timeout !== undefined ? { timeoutMs: Math.round(timeout * 60_000) } : {}),
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  // One key for this form: retrying a failed submit replays the same creation.
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

  const result = buildProjectInput(draft, idempotencyKey, members);
  const create = useMutation({
    mutationFn: () => {
      if (typeof result === "string") throw new Error(result);
      return createProject(result);
    },
    meta: { silent: true },
    onSuccess: async ({ project }) => {
      toast.success("Project 已创建，首个 Run 已提交");
      await queryClient.invalidateQueries({ queryKey: projectKeys.all });
      void navigate({ to: "/projects/$projectId", params: { projectId: project.projectId } });
    },
  });

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
    positive(draft.samplingCount, SAMPLING_COUNT_MAX),
    !!draft.subjectAgentId && positive(draft.executionConcurrency),
    typeof result !== "string",
  ];

  return (
    <Page>
      <PageHeader title="新建 Project" crumbs={[{ label: "Project", to: "/projects" }]} />
      <div className="mb-5"><Stepper steps={STEPS} current={step} onSelect={setStep} /></div>

      {step === 0 && (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="基本信息" />
            <CardBody className="grid gap-4 md:grid-cols-2">
              <Field label="名称" required>{(id) => <Input id={id} value={draft.name} onChange={(event) => update({ name: event.target.value })} />}</Field>
              <Field label="说明">{(id) => <Input id={id} value={draft.description} onChange={(event) => update({ description: event.target.value })} />}</Field>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="选择测试集" description="Project 会复制所选用例，之后测试集的修改不影响这个 Project。同一用例出现在多个测试集中只算一次。" />
            {datasets.isPending ? <LoadingBlock rows={3} /> : (
              <div className="divide-y divide-border">
                {(datasets.data ?? []).map((dataset) => {
                  const choice = draft.datasets.get(dataset.datasetId);
                  const list = members.get(dataset.datasetId) ?? [];
                  return (
                    <div key={dataset.datasetId} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-4">
                        <Checkbox label={<span className="font-semibold">{dataset.name}</span>} checked={!!choice}
                          onChange={(event) => toggleDataset(dataset.datasetId, event.target.checked)} />
                        {choice && (
                          <div className="flex items-center gap-3 text-[13px]">
                            <label className="inline-flex items-center gap-1.5">
                              <input type="radio" checked={!choice.dataIds} onChange={() => setChoice(dataset.datasetId, null)} className="cursor-pointer accent-[var(--primary)]" />
                              全部用例（{list.length}）
                            </label>
                            <label className="inline-flex items-center gap-1.5">
                              <input type="radio" checked={!!choice.dataIds} onChange={() => setChoice(dataset.datasetId, new Set(list.map((item) => item.dataId)))} className="cursor-pointer accent-[var(--primary)]" />
                              部分用例
                            </label>
                          </div>
                        )}
                      </div>
                      {choice?.dataIds && (
                        <div className="mt-3 rounded-[var(--radius-control)] border border-border">
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
                {datasets.data?.length === 0 && <p className="px-4 py-6 text-sm text-text-muted">还没有测试集，请先在「测试集」中导入。</p>}
              </div>
            )}
          </Card>
          <p className="text-sm text-text-muted">已选择 {selectedData.length} 条用例。</p>
        </div>
      )}

      {step === 1 && (
        <Card>
          <CardHeader title="采样次数" description="每条用例每次执行会生成多少次独立的运行（采样）。可以按用例单独设置。" />
          <CardBody className="flex flex-col gap-4">
            <Field label="默认次数" required hint={`1–${SAMPLING_COUNT_MAX}`} className="max-w-xs">
              {(id) => <Input id={id} type="number" min={1} max={SAMPLING_COUNT_MAX} value={draft.samplingCount}
                onChange={(event) => update({ samplingCount: Number(event.target.value) })} />}
            </Field>
            <div className="rounded-[var(--radius-control)] border border-border">
              <DataTable<Data>
                rows={selectedData}
                rowKey={(row) => row.dataId}
                searchText={(row) => dataTitle(row)}
                columns={[
                  { key: "title", header: "用例", cell: (row) => <span className="line-clamp-1">{dataTitle(row)}</span> },
                  { key: "count", header: "次数", align: "right", cell: (row) => (
                    <Input type="number" min={1} max={SAMPLING_COUNT_MAX} className="ml-auto h-8 w-24 text-right"
                      value={draft.samplingCounts[row.dataId] ?? draft.samplingCount}
                      onChange={(event) => update({ samplingCounts: { ...draft.samplingCounts, [row.dataId]: Number(event.target.value) } })} />
                  ) },
                ]}
              />
            </div>
            <p className="text-sm text-text-muted">首次执行共 {totalSamplings} 次采样。</p>
          </CardBody>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardHeader title="被测 Agent" description="创建时会冻结所选 Agent 配置的副本，之后修改原配置不影响这个 Project。" />
          <CardBody className="grid gap-4 md:grid-cols-3">
            <Field label="Agent 配置" required>
              {(id) => (
                <Select id={id} value={draft.subjectAgentId} onChange={(event) => update({ subjectAgentId: event.target.value })}>
                  <option value="">请选择</option>
                  {agents.data?.map((option) => <option key={option.agentConfig.userAgentId} value={option.agentConfig.userAgentId}>{option.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="执行并发" required hint="同时运行的采样数">
              {(id) => <Input id={id} type="number" min={1} value={draft.executionConcurrency} onChange={(event) => update({ executionConcurrency: Number(event.target.value) })} />}
            </Field>
            <Field label="单次超时（分钟）" hint="留空使用默认值">
              {(id) => <Input id={id} inputMode="decimal" value={draft.executionTimeoutMinutes} onChange={(event) => update({ executionTimeoutMinutes: event.target.value })} />}
            </Field>
          </CardBody>
        </Card>
      )}

      {step === 3 && (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="评估计划" description="可以先不填，之后在 Project 中补填；首个评估 Run 之后锁定。" />
            <CardBody className="flex flex-col gap-4">
              <Checkbox label="现在填写评估计划" checked={draft.withEvaluation}
                onChange={(event) => update({ withEvaluation: event.target.checked, firstRun: event.target.checked ? draft.firstRun : "execution" })} />
              {draft.withEvaluation && (
                <div className="grid gap-4 md:grid-cols-3">
                  <Field label="评委 Agent" required>
                    {(id) => (
                      <Select id={id} value={draft.evaluatorAgentId} onChange={(event) => update({ evaluatorAgentId: event.target.value })}>
                        <option value="">请选择</option>
                        {agents.data?.map((option) => <option key={option.agentConfig.userAgentId} value={option.agentConfig.userAgentId}>{option.name}</option>)}
                      </Select>
                    )}
                  </Field>
                  <Field label="评估并发" required>
                    {(id) => <Input id={id} type="number" min={1} value={draft.evaluationConcurrency} onChange={(event) => update({ evaluationConcurrency: Number(event.target.value) })} />}
                  </Field>
                  <Field label="评分格式" required>
                    {(id) => (
                      <Select id={id} value={draft.outputSchemaId} onChange={(event) => update({ outputSchemaId: event.target.value })}>
                        <option value="">请选择</option>
                        {schemas.data?.map((schema) => <option key={schema.outputSchemaId} value={schema.outputSchemaId}>{schema.name}</option>)}
                      </Select>
                    )}
                  </Field>
                </div>
              )}
              {draft.withEvaluation && missingEvalPrompt > 0 && (
                <Notice tone="warning">有 {missingEvalPrompt} 条用例没有评审要求（evalPrompt），评估时会被拒绝。</Notice>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="首个 Run" description="创建后立即开始" />
            <CardBody role="radiogroup" className="grid gap-3 md:grid-cols-2">
              <RadioCard checked={draft.firstRun === "pipeline"} disabled={!draft.withEvaluation} onSelect={() => update({ firstRun: "pipeline" })}
                title="执行 + 评估（推荐）" description="每个采样执行成功后由评委打分" />
              <RadioCard checked={draft.firstRun === "execution"} onSelect={() => update({ firstRun: "execution" })}
                title="只执行" description="先看产物，之后再单独发起评估" />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="确认" />
            <CardBody>
              <DescriptionList items={[
                { label: "名称", value: draft.name || "—" },
                { label: "用例", value: `${selectedData.length} 条，首次执行 ${totalSamplings} 次采样` },
                { label: "被测 Agent", value: agents.data?.find((item) => item.agentConfig.userAgentId === draft.subjectAgentId)?.name ?? "—" },
                { label: "评估", value: draft.withEvaluation ? "已填写评估计划" : "暂不评估" },
              ]} />
              <Notice tone="warning">提交后会立即开始运行，按每轮 Agent 对话消耗服务账号的积分。</Notice>
            </CardBody>
          </Card>
          {typeof result === "string" && <p className="text-sm text-danger">{result}</p>}
          {create.error && <Notice tone="danger">{describeError(create.error)}</Notice>}
        </div>
      )}

      <div className="sticky bottom-0 -mx-6 mt-5 flex justify-between border-t border-border bg-bg/90 px-6 py-3 backdrop-blur">
        <Button disabled={step === 0} onClick={() => setStep(step - 1)}>上一步</Button>
        {step < STEPS.length - 1
          ? <Button variant="primary" disabled={!stepValid[step]} onClick={() => setStep(step + 1)}>下一步</Button>
          : <Button variant="primary" disabled={typeof result === "string"} loading={create.isPending} onClick={() => create.mutate()}>创建并开始运行</Button>}
      </div>
    </Page>
  );
}
