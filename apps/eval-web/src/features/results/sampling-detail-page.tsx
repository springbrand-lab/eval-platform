import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MessagesSquare, Scale } from "lucide-react";
import { getSamplingDetail, metricKeys } from "@/api-sdk/metrics-api";
import { getProject, projectKeys } from "@/api-sdk/projects-api";
import { listSamplingEvaluations, runKeys } from "@/api-sdk/runs-api";
import type { EvaluationDetail } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, DescriptionList } from "@/components/ui/card";
import { CodeBlock, JsonViewer } from "@/components/ui/data-display";
import { Button } from "@/components/ui/button";
import { ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { dataTitle } from "@/features/datasets/dataset-detail-page";
import { ScoreSyncBadge } from "@/features/runs/run-detail-page";
import { formatDateTime } from "@/lib/format";
import { langfuseScoreId } from "@/lib/langfuse";
import { SummaryCards } from "@/features/metrics/summary";
import { AgentPanel, LangfuseLink } from "./agent-panel";

const VALIDATION_REASON: Record<string, string> = {
  "invalid-json": "结果文件不是有效的 JSON",
  "unsafe-number": "包含无法精确表示的数字",
  "schema-mismatch": "不符合评分格式",
  "no-output": "评委没有输出",
  "no-structured-output": "评委没有写结果文件",
  "no-schema": "没有评分格式",
  "invalid-schema": "评分格式无效",
};

function JudgeResult({ detail, subjectChatId }: { detail: EvaluationDetail; subjectChatId: string | null }) {
  const { record, output } = detail;
  const validation = output.validation;
  return (
    <Card>
      <CardHeader
        title="评委结果"
        description={`评估 ${record.evaluationId.slice(0, 8)} · ${formatDateTime(detail.agent.lastCompletedAt)}`}
        actions={<LangfuseLink chatId={subjectChatId} label="在 Langfuse 查看分数" />}
      />
      <CardBody className="flex flex-col gap-4">
        <DescriptionList items={[
          { label: "评分格式校验", value: (
            <span className="flex flex-wrap items-center gap-2">
              <StatusBadge status={validation.status} />
              {validation.status !== "valid" && <span className="text-text-muted">{VALIDATION_REASON[validation.reason] ?? validation.reason}</span>}
            </span>
          ) },
          { label: "Langfuse 同步", value: <span className="flex items-center gap-2"><ScoreSyncBadge record={record} /><span className="font-mono text-xs text-text-muted">{langfuseScoreId(record.evaluationId)}</span></span> },
          ...(record.scoreSync?.lastError ? [{ label: "同步错误", value: <span className="text-danger">{record.scoreSync.lastError}</span> }] : []),
          ...(output.path ? [{ label: "结果文件", value: <span className="font-mono text-xs">{output.path}</span> }] : []),
        ]} />
        {validation.errors.length > 0 && (
          <Notice tone="danger">
            <ul className="list-inside list-disc">
              {validation.errors.map((error, index) => <li key={index}><span className="font-mono">{error.instancePath || "/"}</span> {error.message}</li>)}
            </ul>
          </Notice>
        )}
        {output.rawJson !== null ? <JsonViewer value={output.rawJson} /> : output.content ? <CodeBlock value={output.content} /> : null}
      </CardBody>
    </Card>
  );
}

export function SamplingDetailPage({ projectId, samplingId }: { projectId: string; samplingId: string }) {
  const view = useQuery({ queryKey: projectKeys.detail(projectId), queryFn: ({ signal }) => getProject(projectId, signal) });
  const detail = useQuery({ queryKey: metricKeys.sampling(projectId, samplingId), queryFn: ({ signal }) => getSamplingDetail(projectId, samplingId, signal) });
  // Score sync state lives on the raw EvaluationRecord, read with the Metrics view.
  const records = useQuery({ queryKey: runKeys.samplingEvaluations(samplingId), queryFn: ({ signal }) => listSamplingEvaluations(samplingId, signal) });
  const data = detail.data;
  const sample = data?.projectSample;
  const subjectChatId = data?.subject.chatId ?? null;
  const firstEvaluation = data?.evaluations[0];
  return (
    <Page>
      <PageHeader
        title={`采样 ${samplingId.slice(0, 8)}`}
        description={sample ? dataTitle(sample.data) : undefined}
        crumbs={[
          { label: "Project", to: "/projects" },
          { label: view.data?.project.name ?? "Project", to: "/projects/$projectId", params: { projectId } },
          ...(sample ? [{ label: "用例", to: "/projects/$projectId/samples/$projectSampleId", params: { projectId, projectSampleId: sample.projectSampleId } }] : []),
        ]}
        meta={data && <StatusBadge status={data.subject.stage.status} />}
        actions={data && (
          <>
            <LangfuseLink chatId={subjectChatId} label="Langfuse" />
            {subjectChatId && (
              <Link to="/projects/$projectId/samplings/$samplingId/observe" params={{ projectId, samplingId }}>
                <Button icon={<MessagesSquare />}>被测会话</Button>
              </Link>
            )}
            {firstEvaluation?.agent.chatId && (
              <Link to="/projects/$projectId/evaluations/$evaluationId/observe" params={{ projectId, evaluationId: firstEvaluation.record.evaluationId }}>
                <Button icon={<Scale />}>评委会话</Button>
              </Link>
            )}
          </>
        )}
      />
      {detail.isPending ? <LoadingBlock /> : detail.error ? <ErrorBlock error={detail.error} /> : data && (
        <div className="flex flex-col gap-4">
          <SummaryCards summary={data.summary} />
          {!firstEvaluation && <Notice tone="neutral">这个采样还没有评估。</Notice>}
          {data.evaluations.map((evaluation) => {
            const record = records.data?.find((item) => item.evaluationId === evaluation.record.evaluationId) ?? evaluation.record;
            return <JudgeResult key={record.evaluationId} detail={{ ...evaluation, record }} subjectChatId={subjectChatId} />;
          })}
          <AgentPanel title="被测 Agent" agent={data.subject} />
          {data.evaluations.map((evaluation) => (
            <AgentPanel key={evaluation.record.evaluationId} title="评委 Agent" agent={evaluation.agent} />
          ))}
        </div>
      )}
    </Page>
  );
}
