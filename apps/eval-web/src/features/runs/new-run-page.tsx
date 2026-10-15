import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { getProject, projectKeys } from "@/api-sdk/projects-api";
import { previewRun, runKeys, submitRun } from "@/api-sdk/runs-api";
import type { ProjectSample, RunOperation, RunPreview, RunTargetSelector } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, DescriptionList } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Tabs } from "@/components/ui/data-display";
import { ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { Checkbox, RadioCard, Textarea } from "@/components/ui/form";
import { dataTitle } from "@/features/datasets/dataset-detail-page";
import { ApiError } from "@/api-sdk/client";
import { describeError } from "@/lib/errors";
import { newIdempotencyKey } from "@/lib/files";
import { OPERATION_LABELS } from "@/lib/format";

type Scope = "all" | "datasets" | "samples" | "samplings";

const OPERATION_HELP: Record<RunOperation, string> = {
  execution: "重新执行所选用例：每条用例的现有采样会被替换成新的采样。",
  pipeline: "重新执行所选用例，并在每个采样成功后由评委打分。",
  evaluation: "不重新执行，只对所选的成功采样重新打分，替换原来的评估。",
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
          {view.data!.currentRun && <Notice tone="warning">当前还有未结束的 Run，结束后才能提交新的 Run。</Notice>}
          <Card>
            <CardHeader title="1. 操作" />
            <CardBody className="flex flex-col gap-3">
              <div role="radiogroup" className="grid gap-3 lg:grid-cols-3">
                {(["pipeline", "execution", "evaluation"] as const).map((value) => (
                  <RadioCard key={value} checked={operation === value} disabled={value !== "execution" && !hasPlan}
                    title={OPERATION_LABELS[value]} description={OPERATION_HELP[value]}
                    onSelect={() => { setOperation(value); reset(); if (value === "evaluation" && scope === "samples") setScope("all"); }} />
                ))}
              </div>
              {!hasPlan && <p className="text-[13px] text-text-muted">还没有评估计划，只能选择「只执行」。</p>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="2. 范围" />
            <CardBody className="flex flex-col gap-3 text-sm">
              <Tabs<Scope> value={scope} onChange={(value) => { setScope(value); reset(); }} tabs={[
                { value: "all", label: "全部用例" },
                { value: "datasets", label: "按测试集" },
                ...(operation === "evaluation" ? [] : [{ value: "samples" as const, label: "按用例" }]),
                { value: "samplings", label: "按采样 ID" },
              ]} />
              {scope === "datasets" && (
                <div className="flex flex-col gap-2">
                  {view.data!.datasets.map((dataset) => (
                    <Checkbox key={dataset.datasetId} label={`${dataset.name}（${dataset.projectSampleIds.length} 条）`}
                      checked={datasets.has(dataset.datasetId)}
                      onChange={(event) => {
                        const next = new Set(datasets);
                        if (event.target.checked) next.add(dataset.datasetId); else next.delete(dataset.datasetId);
                        setDatasets(next);
                        reset();
                      }} />
                  ))}
                </div>
              )}
              {scope === "samples" && (
                <div className="rounded-[var(--radius-control)] border border-border">
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
                </div>
              )}
              {scope === "samplings" && (
                <Textarea mono rows={4} placeholder="每行一个采样 ID，或用逗号分隔" value={samplingText}
                  onChange={(event) => { setSamplingText(event.target.value); reset(); }} />
              )}
              {typeof selector === "string" && scope !== "all" && <p className="text-xs text-text-muted">{selector}</p>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="3. 预览并提交" actions={(
              <Button disabled={typeof selector === "string"} loading={runPreview.isPending} onClick={() => runPreview.mutate()}>预览</Button>
            )} />
            <CardBody className="flex flex-col gap-3">
              {runPreview.error && <Notice tone="danger">{describeError(runPreview.error)}</Notice>}
              {submit.error && <Notice tone="danger">{describeError(submit.error)}</Notice>}
              {preview ? (
                <>
                  <DescriptionList items={[
                    { label: "操作", value: OPERATION_LABELS[preview.operation] },
                    { label: "用例", value: `${preview.targets.projectSampleIds.length} 条` },
                    { label: "替换的采样", value: preview.replacedSamplingCount },
                    { label: "新建的采样", value: preview.newSamplingCount },
                    { label: "评估", value: preview.evaluationCount },
                  ]} />
                  {preview.replacedSamplingCount > 0 && <Notice tone="warning">被替换的采样和它们的评估结果将不再计入指标。</Notice>}
                  <div className="flex justify-end">
                    <Button variant="primary" loading={submit.isPending} disabled={!!view.data!.currentRun} onClick={() => submit.mutate()}>提交 Run</Button>
                  </div>
                </>
              ) : <p className="text-sm text-text-muted">选择操作和范围后点击「预览」，确认影响范围再提交。</p>}
            </CardBody>
          </Card>
        </div>
      )}
    </Page>
  );
}
