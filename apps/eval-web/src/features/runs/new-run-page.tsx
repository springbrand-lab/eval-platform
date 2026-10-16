import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@springbrand/site-block";
import { toast } from "sonner";
import { projectKeys } from "@/api-sdk/projects-api";
import { previewRun, submitRun } from "@/api-sdk/runs-api";
import type { RunOperation, RunTargetSelector } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { RadioCards } from "@/components/ui/form";
import { ApiError } from "@/api-sdk/client";
import { isWriteOutcomeUnknown } from "@/lib/errors";
import { newIdempotencyKey } from "@/lib/files";
import { OPERATION_LABELS } from "@/lib/format";
import { refreshProjectResults, useProject } from "@/features/projects/use-project";
import { RunScopePicker } from "./run-scope-picker";

type PreviewInput = Parameters<typeof previewRun>[1];
type RunInput = Parameters<typeof submitRun>[1];

const OPERATION_HELP: Record<RunOperation, string> = {
  execution: "重新执行，替换现有采样",
  pipeline: "重新执行，成功后由评估 Agent 打分",
  evaluation: "不执行，只给成功的采样重新打分",
};

export function buildSelector(selection: RunTargetSelector): RunTargetSelector | string {
  if (selection.all) return { all: true };
  const selector: RunTargetSelector = Object.fromEntries(
    (["datasetIds", "projectSampleIds", "samplingIds"] as const).filter((key) => selection[key]?.length)
      .map((key) => [key, [...new Set(selection[key])].sort()]),
  );
  return Object.keys(selector).length > 0 ? selector : "请至少选择一个测试集、用例或采样";
}

export function NewRunPage({ projectId, initial = {} }: { projectId: string; initial?: { datasetId?: string; projectSampleId?: string; samplingId?: string } }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const view = useProject(projectId);
  const [operation, setOperation] = useState<RunOperation>("execution");
  const [selection, setSelection] = useState<RunTargetSelector>(() => initial.samplingId ? { samplingIds: [initial.samplingId] }
    : initial.projectSampleId ? { projectSampleIds: [initial.projectSampleId] } : initial.datasetId ? { datasetIds: [initial.datasetId] } : { all: true });
  const selector = buildSelector(selection);
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
    <Page narrow>
      <PageHeader title="发起 Run" description="选择操作与层级范围，预览实际目标后再提交。" crumbs={[{ label: "项目管理", to: "/projects" }, { label: view.data?.project.name ?? "项目", to: "/projects/$projectId", params: { projectId } }]} />
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
            <CardHeader title="运行范围" description="按项目、测试集、用例或单个采样选择；支持跨测试集组合。" />
            <CardBody><RunScopePicker project={view.data} value={selection} disabled={frozen} initialSamplingId={initial.samplingId}
              onChange={(next) => { if (!frozen) setSelection(next); }} /></CardBody>
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
          <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-border bg-bg/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
            <Button variant="outline" disabled={submit.isPending} onClick={() => void navigate({ to: "/projects/$projectId", params: { projectId } })}>{uncertain ? "返回项目" : "取消"}</Button>
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
