import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button, NativeSelect } from "@springbrand/site-block";
import { toast } from "sonner";
import { getSampleOverview, metricKeys } from "@/api-sdk/metrics-api";
import { StatusBadge } from "@/components/ui/badge";
import { projectKeys } from "@/api-sdk/projects-api";
import { previewRun, submitRun } from "@/api-sdk/runs-api";
import type { ProjectSample, RunOperation, RunTargetSelector } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Tabs } from "@/components/ui/data-display";
import { ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { Checkbox, RadioCards } from "@/components/ui/form";
import { dataTitle } from "@/features/datasets/dataset-detail-page";
import { ApiError } from "@/api-sdk/client";
import { isWriteOutcomeUnknown } from "@/lib/errors";
import { newIdempotencyKey } from "@/lib/files";
import { OPERATION_LABELS } from "@/lib/format";
import { refreshProjectResults, useProject } from "@/features/projects/use-project";

type Scope = "all" | "datasets" | "samples" | "samplings";
type PreviewInput = Parameters<typeof previewRun>[1];
type RunInput = Parameters<typeof submitRun>[1];

const OPERATION_HELP: Record<RunOperation, string> = {
  execution: "重新执行，替换现有采样",
  pipeline: "重新执行，成功后评委打分",
  evaluation: "不执行，只给成功的采样重新打分",
};

export function buildSelector(scope: Scope, datasets: ReadonlySet<string>, samples: ReadonlySet<string>, samplings: ReadonlySet<string>): RunTargetSelector | string {
  if (scope === "all") return { all: true };
  if (scope === "datasets") return datasets.size > 0 ? { datasetIds: [...datasets].sort() } : "请至少选择一个测试集";
  if (scope === "samples") return samples.size > 0 ? { projectSampleIds: [...samples].sort() } : "请至少选择一条用例";
  return samplings.size > 0 ? { samplingIds: [...samplings].sort() } : "请至少选择一个采样";
}

export function NewRunPage({ projectId, initial = {} }: { projectId: string; initial?: { datasetId?: string; projectSampleId?: string; samplingId?: string } }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const view = useProject(projectId);
  const [operation, setOperation] = useState<RunOperation>("execution");
  const [scope, setScope] = useState<Scope>(initial.samplingId ? "samplings" : initial.projectSampleId ? "samples" : initial.datasetId ? "datasets" : "all");
  const [datasets, setDatasets] = useState<Set<string>>(new Set(initial.datasetId ? [initial.datasetId] : []));
  const [samples, setSamples] = useState<Set<string>>(new Set(initial.projectSampleId ? [initial.projectSampleId] : []));
  const [samplings, setSamplings] = useState<Set<string>>(new Set(initial.samplingId ? [initial.samplingId] : []));
  const [browsedSample, setBrowsedSample] = useState("");
  const samplingChoices = useQuery({ queryKey: metricKeys.sample(projectId, browsedSample, []),
    queryFn: ({ signal }) => getSampleOverview(projectId, browsedSample, [], signal), enabled: scope === "samplings" && !!browsedSample });
  const selector = buildSelector(scope, datasets, samples, samplings);
  const requestKey = typeof selector === "string" ? null : JSON.stringify({ operation, selector });
  const hasPlan = !!view.data?.evaluation;

  const runPreview = useMutation({
    mutationFn: async (input: PreviewInput) => {
      const preview = await previewRun(projectId, input);
      return { requestKey: JSON.stringify(input), preview, command: {
        idempotencyKey: newIdempotencyKey("run"), operation: preview.operation, selector: preview.selector, targets: preview.targets,
      } satisfies RunInput };
    },
    meta: { silent: true },
  });
  const prepared = !runPreview.isPending && runPreview.data?.requestKey === requestKey ? runPreview.data : null;
  const preview = prepared?.preview;
  const previewError = JSON.stringify(runPreview.variables) === requestKey ? runPreview.error : null;
  const submit = useMutation({
    mutationFn: (input: RunInput) => submitRun(projectId, input),
    meta: { silent: true },
    onSuccess: async (handle) => {
      toast.success("Run 已提交");
      await queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
      await refreshProjectResults(queryClient, projectId);
      void navigate({ to: "/projects/$projectId/runs/$runId", params: { projectId, runId: handle.runId } });
    },
    onError: async (error) => {
      if (error instanceof ApiError && ["PROJECT_PLAN_CHANGED", "RUN_TARGETS_STALE"].includes(error.code)) runPreview.reset();
      await queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    },
  });
  const uncertain = submit.isError && isWriteOutcomeUnknown(submit.error);
  const frozen = submit.isPending || uncertain;

  return (
    <Page>
      <PageHeader title="发起 Run" crumbs={[{ label: "项目管理", to: "/projects" }, { label: view.data?.project.name ?? "项目", to: "/projects/$projectId", params: { projectId } }]} />
      {view.error && <ErrorBlock error={view.error} onRetry={() => void view.refetch()} />}
      {!view.data ? view.isPending && <LoadingBlock /> : (
        <div className="flex flex-col gap-4">
          {view.data!.currentRun && <Notice tone="warning">当前 Run 结束后才能提交。</Notice>}
          <fieldset disabled={frozen} className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="操作" />
            <CardBody>
              <RadioCards<RunOperation> className="lg:grid-cols-3" value={operation}
                onValueChange={setOperation}
                options={(["pipeline", "execution", "evaluation"] as const).map((value) => ({
                  value, title: OPERATION_LABELS[value], description: OPERATION_HELP[value], disabled: value !== "execution" && !hasPlan,
                }))} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="范围" actions={(
              <Tabs<Scope> value={scope} onChange={setScope} tabs={[
                { value: "all", label: "全部" },
                { value: "datasets", label: "测试集" },
                { value: "samples", label: "样本" },
                { value: "samplings", label: "采样" },
              ]} />
            )} />
            {scope === "all" && <CardBody className="text-[13px] text-text-muted">全部 {view.data!.projectSamples.length} 条用例</CardBody>}
            {scope === "datasets" && (
              <CardBody className="flex flex-col gap-2.5">
                {view.data!.datasets.map((dataset) => (
                  <Checkbox key={dataset.datasetId} label={dataset.name} description={`${dataset.projectSampleIds.length} 条用例`}
                    checked={datasets.has(dataset.datasetId)}
                    onCheckedChange={(checked) => {
                      const next = new Set(datasets);
                      if (checked) next.add(dataset.datasetId); else next.delete(dataset.datasetId);
                      setDatasets(next);
                    }} />
                ))}
              </CardBody>
            )}
            {scope === "samples" && (
              <DataTable<ProjectSample>
                rows={view.data!.projectSamples}
                rowKey={(row) => row.projectSampleId}
                selectable
                selected={samples}
                onSelectedChange={setSamples}
                searchText={(row) => `${dataTitle(row.data)} ${row.data.userPrompt}`}
                columns={[
                  { key: "title", header: "用例", cell: (row) => <span className="line-clamp-1">{dataTitle(row.data)}</span> },
                  { key: "count", header: "采样次数", align: "right", cell: (row) => row.samplingCount },
                ]}
              />
            )}
            {scope === "samplings" && <CardBody className="flex flex-col gap-3">
              <NativeSelect aria-label="查看样本的采样" value={browsedSample} onChange={(event) => setBrowsedSample(event.target.value)}>
                <option value="" disabled>选择样本，勾选其中的采样</option>
                {view.data!.projectSamples.map((sample) => <option key={sample.projectSampleId} value={sample.projectSampleId}>{dataTitle(sample.data)}</option>)}
              </NativeSelect>
              {browsedSample && (samplingChoices.isPending ? <LoadingBlock /> : samplingChoices.error ? <ErrorBlock error={samplingChoices.error} /> :
                <div className="flex flex-col gap-2">{samplingChoices.data.samplings.length === 0 && <p className="text-sm text-text-muted">这个样本还没有采样。</p>}
                  {samplingChoices.data.samplings.map((sampling, index) => <Checkbox key={sampling.samplingId} checked={samplings.has(sampling.samplingId)}
                    label={<span>采样 {index + 1} · {sampling.samplingId.slice(0, 8)} <StatusBadge status={sampling.execution.status} /></span>}
                    onCheckedChange={(checked) => { const next = new Set(samplings); if (checked) next.add(sampling.samplingId); else next.delete(sampling.samplingId); setSamplings(next); }} />)}
                </div>)}
              <p className="text-sm">已选 {samplings.size} 个采样</p>
              <div className="flex flex-wrap gap-2">{[...samplings].map((id) => <Button key={id} size="sm" aria-label={`移除采样 ${id}`} onClick={() => {
                const next = new Set(samplings); next.delete(id); setSamplings(next);
              }}>{id.slice(0, 8)} ×</Button>)}</div>
            </CardBody>}

          </Card>
          <Card>
            <CardHeader title="预览" actions={(
              <Button size="sm" disabled={typeof selector === "string"} loading={runPreview.isPending} onClick={() => {
                if (typeof selector !== "string") runPreview.mutate({ operation, selector });
              }}>
                {preview ? "重新预览" : "预览"}
              </Button>
            )} />
            <CardBody className="flex flex-col gap-3">
              {previewError && <ErrorBlock error={previewError} />}
              {preview ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    { label: "用例", value: preview.targets.projectSampleIds.length },
                    { label: "新建采样", value: preview.newSamplingCount },
                    { label: "替换采样", value: preview.replacedSamplingCount },
                    { label: "评估", value: preview.evaluationCount },
                  ].map((item) => (
                    <div key={item.label} className="rounded-[var(--radius-control)] bg-surface-muted px-3 py-2">
                      <p className="text-xs text-text-muted">{item.label}</p>
                      <p className="mt-0.5 text-lg font-semibold text-text-strong tabular">{item.value}</p>
                    </div>
                  ))}
                </div>
              ) : <p className="text-[13px] text-text-muted">{typeof selector === "string" ? selector : "预览后再提交"}</p>}
              {preview && preview.replacedSamplingCount > 0 && <p className="text-xs text-text-muted">重跑会清空所选采样的旧评估，未选中采样的执行和评估结果保留。</p>}
            </CardBody>
          </Card>
          </fieldset>
          {submit.error && <ErrorBlock error={submit.error} />}
          {uncertain && <Notice tone="warning">提交结果尚未确认。重试会使用同一份 Run 请求，也可以返回项目查看进度。</Notice>}
          <div className="sticky bottom-0 -mx-6 flex justify-end border-t border-border bg-bg/90 px-6 py-3 backdrop-blur">
            <Button disabled={submit.isPending} onClick={() => void navigate({ to: "/projects/$projectId", params: { projectId } })}>{uncertain ? "返回项目" : "取消"}</Button>
            <Button loading={submit.isPending} disabled={!uncertain && (!prepared || !!view.data!.currentRun)} onClick={() => {
              const command = uncertain ? submit.variables : prepared?.command;
              if (command) submit.mutate(command);
            }}>{uncertain ? "重试提交" : "提交 Run"}</Button>
          </div>
        </div>
      )}
    </Page>
  );
}
