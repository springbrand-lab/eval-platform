import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { getProject, projectKeys } from "@/api-sdk/projects-api";
import { previewRun, runKeys, submitRun } from "@/api-sdk/runs-api";
import type { ProjectSample, RunOperation, RunPreview, RunTargetSelector } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Tabs } from "@/components/ui/data-display";
import { ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { Checkbox, RadioCards, Textarea } from "@/components/ui/form";
import { dataTitle } from "@/features/datasets/dataset-detail-page";
import { ApiError } from "@/api-sdk/client";
import { describeError } from "@/lib/errors";
import { newIdempotencyKey } from "@/lib/files";
import { OPERATION_LABELS } from "@/lib/format";

type Scope = "all" | "datasets" | "samples" | "samplings";

const OPERATION_HELP: Record<RunOperation, string> = {
  execution: "重新执行，替换现有采样",
  pipeline: "重新执行，成功后评委打分",
  evaluation: "不执行，只给成功的采样重新打分",
};

export function buildSelector(scope: Scope, datasets: ReadonlySet<string>, samples: ReadonlySet<string>, samplingText: string): RunTargetSelector | string {
  if (scope === "all") return { all: true };
  if (scope === "datasets") return datasets.size > 0 ? { datasetIds: [...datasets] } : "请至少选择一个测试集";
  if (scope === "samples") return samples.size > 0 ? { projectSampleIds: [...samples] } : "请至少选择一条用例";
  const ids = [...new Set(samplingText.split(/[\s,]+/u).map((item) => item.trim()).filter(Boolean))];
  return ids.length > 0 ? { samplingIds: ids } : "请填写采样 ID";
}

export function NewRunPage({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const view = useQuery({ queryKey: projectKeys.detail(projectId), queryFn: ({ signal }) => getProject(projectId, signal) });
  const [operation, setOperation] = useState<RunOperation>("pipeline");
  const [scope, setScope] = useState<Scope>("all");
  const [datasets, setDatasets] = useState<Set<string>>(new Set());
  const [samples, setSamples] = useState<Set<string>>(new Set());
  const [samplingText, setSamplingText] = useState("");
  const [preview, setPreview] = useState<RunPreview | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey("run"));
  const selector = buildSelector(scope, datasets, samples, samplingText);
  const hasPlan = !!view.data?.evaluation;

  const runPreview = useMutation({
    mutationFn: () => {
      if (typeof selector === "string") throw new Error(selector);
      return previewRun(projectId, { operation, selector });
    },
    meta: { silent: true },
    onSuccess: (result) => {
      setPreview(result);
      setIdempotencyKey(newIdempotencyKey("run"));
    },
  });
  const submit = useMutation({
    mutationFn: () => submitRun(projectId, { idempotencyKey, operation: preview!.operation, selector: preview!.selector, targets: preview!.targets }),
    meta: { silent: true },
    onSuccess: async (handle) => {
      toast.success("Run 已提交");
      await queryClient.invalidateQueries({ queryKey: runKeys.current(projectId) });
      await queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
      void navigate({ to: "/projects/$projectId/runs/$runId", params: { projectId, runId: handle.runId } });
    },
    onError: (error) => {
      // Stale targets need a fresh preview; the user sees why.
      if (error instanceof ApiError && ["PROJECT_PLAN_CHANGED", "RUN_TARGETS_STALE"].includes(error.code)) setPreview(null);
    },
  });
  const reset = () => setPreview(null);

  return (
    <Page>
      <PageHeader title="发起 Run" crumbs={[{ label: "Project", to: "/projects" }, { label: view.data?.project.name ?? "Project", to: "/projects/$projectId", params: { projectId } }]} />
      {view.isPending ? <LoadingBlock /> : view.error ? <ErrorBlock error={view.error} /> : (
        <div className="flex flex-col gap-4">
          {view.data!.currentRun && <Notice tone="warning">当前 Run 结束后才能提交。</Notice>}
          <Card>
            <CardHeader title="操作" />
            <CardBody>
              <RadioCards<RunOperation> className="lg:grid-cols-3" value={operation}
                onValueChange={(value) => { setOperation(value); reset(); if (value === "evaluation" && scope === "samples") setScope("all"); }}
                options={(["pipeline", "execution", "evaluation"] as const).map((value) => ({
                  value, title: OPERATION_LABELS[value], description: OPERATION_HELP[value], disabled: value !== "execution" && !hasPlan,
                }))} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="范围" actions={(
              <Tabs<Scope> value={scope} onChange={(value) => { setScope(value); reset(); }} tabs={[
                { value: "all", label: "全部" },
                { value: "datasets", label: "测试集" },
                ...(operation === "evaluation" ? [] : [{ value: "samples" as const, label: "用例" }]),
                { value: "samplings", label: "采样 ID" },
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
                      reset();
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
                onSelectedChange={(next) => { setSamples(next); reset(); }}
                searchText={(row) => `${dataTitle(row.data)} ${row.data.userPrompt}`}
                columns={[
                  { key: "title", header: "用例", cell: (row) => <span className="line-clamp-1">{dataTitle(row.data)}</span> },
                  { key: "count", header: "采样次数", align: "right", cell: (row) => row.samplingCount },
                ]}
              />
            )}
            {scope === "samplings" && (
              <CardBody>
                <Textarea mono rows={4} placeholder="每行一个采样 ID，或用逗号分隔" value={samplingText}
                  onChange={(event) => { setSamplingText(event.target.value); reset(); }} />
              </CardBody>
            )}
          </Card>
          <Card>
            <CardHeader title="预览" actions={(
              <Button size="sm" disabled={typeof selector === "string"} loading={runPreview.isPending} onClick={() => runPreview.mutate()}>
                {preview ? "重新预览" : "预览"}
              </Button>
            )} />
            <CardBody className="flex flex-col gap-3">
              {runPreview.error && <Notice tone="danger">{describeError(runPreview.error)}</Notice>}
              {submit.error && <Notice tone="danger">{describeError(submit.error)}</Notice>}
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
              {preview && preview.replacedSamplingCount > 0 && <p className="text-xs text-text-muted">被替换的采样及其评估不再计入指标。</p>}
            </CardBody>
          </Card>
          <div className="sticky bottom-0 -mx-6 flex justify-end border-t border-border bg-bg/90 px-6 py-3 backdrop-blur">
            <Button variant="primary" loading={submit.isPending} disabled={!preview || !!view.data!.currentRun} onClick={() => submit.mutate()}>提交 Run</Button>
          </div>
        </div>
      )}
    </Page>
  );
}
