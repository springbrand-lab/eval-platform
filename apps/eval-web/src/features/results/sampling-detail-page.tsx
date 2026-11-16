import { RecollectResultButton } from "./recollect-result-button";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { CloudOsRoot, CloudOsWorkspaceSplit } from "@springbrand/message-panel/cloud-os";
import { getMessages, getWorkspaceTree, observationKeys, type ObservedKind } from "@/api-sdk/observations-api";
import { MessagesTab } from "@/features/observation/messages-tab";
import { TrajectoryTab } from "@/features/observation/trajectory-tab";
import { WorkspaceTab, defaultPreviewPath, findFile } from "@/features/observation/workspace-tab";
import { Tabs } from "@/components/ui/data-display";
import { getSamplingDetail, metricKeys } from "@/api-sdk/metrics-api";
import { listSamplingEvaluations, runKeys } from "@/api-sdk/runs-api";
import type { EvaluationDetail, OutputFieldSummary } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardBody, DescriptionList } from "@/components/ui/card";
import { CodeBlock, JsonViewer } from "@/components/ui/data-display";
import { Button, NativeSelect } from "@springbrand/site-block";
import { ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { dataTitle } from "@/features/datasets/dataset-detail-page";
import { ScoreSyncBadge } from "@/features/runs/run-detail-page";
import { Dialog } from "@/components/ui/dialog";
import { formatDateTime, formatDuration } from "@/lib/format";
import { useDarkMode } from "@/lib/use-dark";
import { langfuseScoreId } from "@/lib/langfuse";
import { SummaryCards } from "@/features/metrics/summary";
import type { ComparisonViewMode } from "@/features/metrics/comparison-view";
import { ExecutionMetrics } from "@/features/metrics/execution-metrics";
import { AgentPanel, LangfuseLink } from "./agent-panel";
import { useProject } from "@/features/projects/use-project";
import { POLL_MS } from "@/features/runs/use-run-polling";
import { StageHint } from "@/features/runs/stage-hint";
import { EvidenceExportProgress } from "@/features/runs/evidence-export-progress";

const VALIDATION_REASON: Record<string, string> = {
  "invalid-json": "结果文件不是有效的 JSON",
  "unsafe-number": "包含无法精确表示的数字",
  "schema-mismatch": "不符合评估结果格式",
  "no-output": "平台尚未收集到评估输出",
  "no-structured-output": "未收集到评估结果文件",
  "no-schema": "没有评估结果格式",
  "invalid-schema": "评估结果格式无效",
};

/** A file to open in an Agent's Workspace; `request` reopens it after the user browsed elsewhere. */
type WorkspaceFocus = { kind: ObservedKind; id: string; path: string; request: number };

function JudgeResult({ projectId, detail, subjectChatId, busy, fields, onEvidence, readOnly = false }: {
  projectId: string; detail: EvaluationDetail; subjectChatId: string | null; busy: boolean;
  fields: readonly OutputFieldSummary[]; onEvidence: (path: string) => void;
  readOnly?: boolean;
}) {
  const { record, output } = detail;
  const validation = output.validation;
  const entries = output.rawJson !== null && typeof output.rawJson === "object" && !Array.isArray(output.rawJson) ? Object.entries(output.rawJson) : [];
  const scalar = (value: unknown) => value === null || typeof value === "number" || typeof value === "boolean";
  const scores = entries.filter(([, value]) => scalar(value));
  const prose = entries.filter(([, value]) => !scalar(value));
  const label = (key: string) => fields.find((field) => field.jsonPointer === `/${key.replace(/~/gu, "~0").replace(/\//gu, "~1")}`)?.title
    ?? ({ score: "分数", reason: "评估理由", evidence: "证据", passed: "是否通过" } as Record<string, string>)[key] ?? key;
  const evidence = prose.filter(([, value]) => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.startsWith("/evidence/")));
  const descriptions = prose.filter(([key]) => !evidence.some(([evidenceKey]) => key === evidenceKey));
  return <Card>
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
      <span className="flex flex-wrap items-center gap-2"><h3 className="text-xs font-semibold">评估 Agent 结果</h3><StatusBadge status={detail.agent.stage.status} /><StageHint stage="evaluation" state={record.status} /></span>
      <p className="w-full text-[11px] text-text-muted">{record.evaluationId.slice(0, 8)} · {formatDateTime(detail.agent.lastCompletedAt)}</p>
    </div>
    <CardBody className="@container flex min-w-0 flex-col gap-3 p-3">
      {record.status.status === "cancelled" && record.attempts.length === 0 && record.status.lastError === "execution did not succeed"
        ? <p className="text-xs text-text-muted">此前因执行失败而取消，尚未评估。执行结果恢复后，可点击顶部“重新评估”。</p>
        : detail.agent.stage.lastError && <p role="alert" className="break-words text-xs text-danger">{detail.agent.stage.lastError}</p>}
      {!readOnly && <RecollectResultButton projectId={projectId} samplingId={record.samplingId} evaluationId={record.evaluationId} stage={record.status} busy={busy} resources={detail.agent.resources.collections}
        eligible={!!record.chatId && record.attempts.at(-1)?.status === "completed"} />}
      {validation.status !== "valid" && <p className="rounded-md bg-surface-muted p-2 text-xs text-warning">{VALIDATION_REASON[validation.reason] ?? validation.reason}，暂不计入有效评估。</p>}
      {scores.length > 0 && <dl aria-label="评估数值" className="grid grid-cols-2 @min-[360px]:grid-cols-4 gap-px overflow-hidden rounded-md border border-border bg-border">{scores.map(([key, value]) => <div key={key} className="min-w-0 bg-surface px-2.5 py-2"><dt className="truncate text-[11px] text-text-muted" title={label(key)}>{label(key)}</dt><dd className="mt-1 text-base font-semibold tabular-nums">{value === true ? "是" : value === false ? "否" : value === null ? "空值" : String(value)}</dd></div>)}</dl>}
      {descriptions.length > 0 && <section aria-label="评估说明全文" tabIndex={0} className="max-h-[48dvh] min-w-0 space-y-3 overflow-y-auto overscroll-contain pr-2 text-xs leading-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{descriptions.map(([key, value]) => <div key={key}><h4 className="sticky top-0 mb-1 bg-surface font-medium">{label(key)}<span className="ml-2 font-normal text-text-muted">滚动查看全文</span></h4><p className="whitespace-pre-wrap break-words text-text-secondary">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</p></div>)}</section>}
      {entries.length === 0 && output.rawJson !== null && <div className="max-h-60 overflow-auto text-xs"><JsonViewer value={output.rawJson} /></div>}
      {evidence.map(([key, value]) => <section key={key} className="border-t border-border pt-2"><h4 className="mb-1 text-[11px] font-medium text-text-muted">{label(key)} · 点击在评估过程中查看</h4><ul className="space-y-1">{(value as string[]).map((path) => <li key={path}><button className="block w-full truncate text-left text-xs text-text-secondary hover:text-text-strong hover:underline" title={path} onClick={() => onEvidence(path)}>{path}</button></li>)}</ul></section>)}
      <details className="border-t border-border pt-2 text-xs"><summary className="cursor-pointer text-text-muted">原始结果、格式校验与同步</summary><div className="mt-2 space-y-3">
        <LangfuseLink chatId={subjectChatId} label="在 Langfuse 查看分数" />
        <DescriptionList items={[
          { label: "格式校验", value: <StatusBadge status={validation.status} /> },
          { label: "分数同步", value: <ScoreSyncBadge record={record} /> },
          ...(record.scoreSync?.lastError ? [{ label: "同步错误", value: <span className="text-danger">{record.scoreSync.lastError}</span> }] : []),
          ...(output.path ? [{ label: "结果文件", value: <span className="break-all font-mono text-xs">{output.path}</span> }] : []),
          { label: "同步 ID", value: <span className="break-all text-xs">{langfuseScoreId(record.evaluationId)}</span> },
        ]} />
        {validation.errors.length > 0 && <ul className="list-inside list-disc text-danger">{validation.errors.map((error, index) => <li key={index}>{error.instancePath || "/"} {error.message}</li>)}</ul>}
        {output.rawJson !== null ? <JsonViewer value={output.rawJson} /> : output.content ? <CodeBlock value={output.content} /> : null}
      </div></details>
    </CardBody>
  </Card>;
}

function AgentWorkspace({ projectId, kind, id, running, artifactCount, focusPath, focusKey }: {
  projectId: string; kind: ObservedKind; id: string; running: boolean; artifactCount: number; focusPath: string | null; focusKey: string;
}) {
  const tree = useQuery({ queryKey: observationKeys.part(projectId, kind, id, "tree"), queryFn: ({ signal }) => getWorkspaceTree(projectId, kind, id, signal), staleTime: 0, refetchInterval: running ? POLL_MS : false });
  return <section aria-label="Workspace" className="flex h-full min-h-0 min-w-0 flex-col bg-surface">
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2"><h3 className="text-xs font-semibold">Workspace</h3>{artifactCount > 0 && <span className="text-[11px] text-text-muted">{artifactCount} 个已收集产物</span>}</div>
    <div className="min-h-0 flex-1 overflow-y-auto p-3">{tree.error ? <ErrorBlock error={tree.error} onRetry={() => void tree.refetch()} /> : !tree.data ? <LoadingBlock /> :
      <WorkspaceTab key={focusKey} compact projectId={projectId} kind={kind} id={id} tree={tree.data} running={running}
        initialPath={focusPath && findFile(tree.data, focusPath) ? focusPath : defaultPreviewPath(tree.data)} />}</div>
  </section>;
}

/** SP Chat's read-only layout: the Agent's conversation beside its live Workspace, so output and files are reviewed together. */
function AgentProcess({ projectId, kind, id, running, title, status, duration, artifactCount, focus, stacked }: {
  projectId: string; kind: ObservedKind; id: string; running: boolean; title: string; status: string; duration: number | null;
  artifactCount: number; focus: WorkspaceFocus | null; stacked: boolean;
}) {
  const [traceOpen, setTraceOpen] = useState(false);
  const dark = useDarkMode();
  const messages = useQuery({ queryKey: observationKeys.part(projectId, kind, id, "messages"), queryFn: ({ signal }) => getMessages(projectId, kind, id, signal), staleTime: 0, refetchInterval: running ? POLL_MS : false });
  const chat = <section aria-label={`${title}会话`} className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs"><span className="font-medium">{title}</span><StatusBadge status={status} /><span className="text-text-muted">{formatDuration(duration)}</span></div>
      <button className="link text-xs" onClick={() => setTraceOpen(true)}>查看原始轨迹</button>
    </div>
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{messages.error ? <div className="p-3"><ErrorBlock error={messages.error} onRetry={() => void messages.refetch()} /></div> : !messages.data ? <LoadingBlock /> : <MessagesTab messages={messages.data} running={running} />}</div>
  </section>;
  const workspace = <AgentWorkspace projectId={projectId} kind={kind} id={id} running={running} artifactCount={artifactCount}
    focusPath={focus?.path ?? null} focusKey={focus ? `${focus.kind}:${focus.id}:${focus.request}` : "default"} />;
  return <>
    {stacked ? <div className="space-y-3">
      <div className="h-[calc(100dvh-15rem)] min-h-80 overflow-hidden rounded-lg border border-border">{chat}</div>
      <div className="overflow-hidden rounded-lg border border-border">{workspace}</div>
    </div> : <div className="eval-chat h-[calc(100dvh-14rem)] min-h-96 overflow-hidden rounded-lg border border-border">
      <CloudOsRoot mode={dark ? "dark" : "light"} className="flex h-full min-h-0"><CloudOsWorkspaceSplit workspaceOpen chat={chat} workspace={workspace} /></CloudOsRoot>
    </div>}
    {traceOpen && <Dialog open compact placement="right" title={`${title} · 原始轨迹`} description="原始 Pi 记录用于排查运行细节，关闭后返回会话。" onClose={() => setTraceOpen(false)} footer={<Button variant="outline" size="sm" onClick={() => setTraceOpen(false)}>返回会话</Button>}>
      <TrajectoryTab projectId={projectId} kind={kind} id={id} running={running} />
    </Dialog>}
  </>;
}

export function SamplingResult({ projectId, samplingId, standalone = false, presentation = "default", comparisonViewMode = "evaluation" }: {
  projectId: string; samplingId: string; standalone?: boolean; presentation?: "default" | "comparison";
  comparisonViewMode?: ComparisonViewMode;
}) {
  const comparing = presentation === "comparison";
  const view = useProject(projectId);
  const running = !!view.data?.currentRun;
  const refresh = running ? POLL_MS : false;
  const [tab, setTab] = useState<"result" | "execution" | "evaluation" | "resources">("result");
  const [focus, setFocus] = useState<WorkspaceFocus | null>(null);
  const [evaluationId, setEvaluationId] = useState<string | null>(null);
  const detail = useQuery({ queryKey: metricKeys.sampling(projectId, samplingId), queryFn: ({ signal }) => getSamplingDetail(projectId, samplingId, signal), enabled: !!view.data, staleTime: 0, refetchInterval: refresh });
  const records = useQuery({ queryKey: runKeys.samplingEvaluations(projectId, samplingId), queryFn: ({ signal }) => listSamplingEvaluations(samplingId, signal), enabled: !!view.data, staleTime: 0, refetchInterval: refresh });
  const data = detail.data;
  if (view.error || detail.error) return <ErrorBlock error={view.error ?? detail.error} onRetry={() => { void view.refetch(); void detail.refetch(); }} />;
  if (!data) return <LoadingBlock />;
  const evaluator = data.evaluations.find((item) => item.record.evaluationId === evaluationId) ?? data.evaluations[0];
  const debugTarget = tab === "evaluation" && evaluator ? { agent: evaluator.agent, id: evaluator.record.evaluationId, kind: "evaluations" as const, title: "评估 Agent" } : { agent: data.subject, id: samplingId, kind: "samplings" as const, title: "执行 Agent" };
  const openEvidence = (id: string, path: string) => { setEvaluationId(id); setFocus((current) => ({ kind: "evaluations", id, path, request: (current?.request ?? 0) + 1 })); setTab("evaluation"); };
  const actions = comparing ? null : <div className="flex items-center gap-2">
    <Button asChild size="sm" variant="ghost" disabled={running}><Link to="/projects/$projectId/runs/new" disabled={running} params={{ projectId }} search={{ samplingId, operation: "execution" }}>重新执行</Link></Button>
    <Button asChild size="sm" variant="outline" disabled={running || data.subject.stage.status !== "succeeded" || !view.data?.evaluation}><Link to="/projects/$projectId/runs/new" disabled={running || data.subject.stage.status !== "succeeded" || !view.data?.evaluation} params={{ projectId }} search={{ samplingId, operation: "evaluation" }}>重新评估</Link></Button>
  </div>;
  const identity = <span className="flex flex-wrap items-center gap-2"><span className="font-mono text-[11px] text-text-muted">采样 {samplingId.slice(0, 8)}</span><span className="text-xs text-text-muted">执行</span><StatusBadge status={data.subject.stage.status} /><StageHint stage="execution" state={data.subject.stage} /></span>;
  return <div className="flex min-w-0 flex-col gap-3">
    {standalone ? <PageHeader compact title={dataTitle(data.projectSample.data)} meta={identity} actions={actions} crumbs={[{ label: "项目管理", to: "/projects" }, { label: view.data?.project.name ?? "返回项目", to: "/projects/$projectId", params: { projectId } }]} />
      : <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap items-center gap-2">{!comparing && <h2 className="text-sm font-semibold">{dataTitle(data.projectSample.data)}</h2>}{identity}</div>{actions}</div>}
    {comparing && comparisonViewMode === "execution" && <section aria-label="当前采样执行 Agent 指标" className="rounded-lg border border-border bg-surface-muted/30 p-3">
      <h4 className="mb-3 text-[11px] font-medium text-text-muted">本次采样 · 执行 Agent</h4>
      <ExecutionMetrics value={{
        chargedUnits: data.subject.resources.costs.chargedUnits,
        durationMs: data.subject.agentDurationMs,
        cacheHitRate: data.subject.resources.cacheHitRate,
        toolSuccessRate: data.subject.resources.trajectory.toolSuccessRate,
      }} />
    </section>}
    {data.subject.stage.lastError && <p role="alert" className="break-words rounded-md border border-danger/20 px-3 py-2 text-xs text-danger">执行阶段异常：{data.subject.stage.lastError}</p>}
    <EvidenceExportProgress state={data.sampling.evidenceExport} executionStatus={data.subject.stage.status} />
    {!comparing && <RecollectResultButton projectId={projectId} samplingId={samplingId} stage={data.subject.stage} busy={running} resources={data.subject.resources.collections}
      eligible={!!data.subject.chatId && data.subject.attempts.items.at(-1)?.status === "completed"} />}
    <Tabs variant="line" value={tab} onChange={setTab} tabs={[{ value: "result", label: "结果" }, { value: "execution", label: "执行过程" }, { value: "evaluation", label: "评估过程" }, ...comparing ? [] : [{ value: "resources" as const, label: "资源统计" }]]} />
    {tab === "result" ? <div className="@container min-w-0">
      <div className="grid min-w-0 grid-cols-1 items-start gap-3 @min-[880px]:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-3" aria-label="评分与评估说明">
          {!data.evaluations.length && <Notice tone="neutral">{comparing ? "还没有评估结果，请刷新当前范围。" : "还没有评估结果，可点击顶部“重新评估”。"}</Notice>}
          {data.evaluations.map((evaluation) => <JudgeResult readOnly={comparing} busy={running} projectId={projectId} key={evaluation.record.evaluationId} detail={{ ...evaluation, record: records.data?.find((record) => record.evaluationId === evaluation.record.evaluationId) ?? evaluation.record }} subjectChatId={data.subject.chatId} fields={data.summary.evaluationOutputs.fields}
            onEvidence={(path) => openEvidence(evaluation.record.evaluationId, path)} />)}
        </div>
        <aside className="min-w-0 space-y-3 @min-[880px]:sticky @min-[880px]:top-0" aria-label="执行任务与评估要求">
          {[{ title: "执行任务", text: data.projectSample.data.userPrompt }, { title: "评估要求", text: data.projectSample.data.evalPrompt ?? "未填写" }].map((item) => <Card key={item.title}>
            <div className="border-b border-border px-3 py-2"><h3 className="text-xs font-semibold">{item.title}</h3></div>
            <CardBody className="max-h-64 overflow-y-auto overscroll-contain p-3"><p className="whitespace-pre-wrap break-words text-xs leading-5 text-text-secondary">{item.text}</p></CardBody>
          </Card>)}
          <p className="text-[11px] leading-4 text-text-muted">{data.subject.artifacts.length} 个执行产物，<button className="link" onClick={() => setTab("execution")}>在「执行过程」中与会话对照查看</button>。</p>
        </aside>
      </div>
    </div> : tab === "resources" ? <div className="space-y-3">
      <SummaryCards summary={data.summary} />
      <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-xs font-medium">执行 Agent · 尝试与原始资源</summary><div className="mt-3"><AgentPanel projectId={projectId} title="执行 Agent" agent={data.subject} /></div></details>
      {data.evaluations.map((evaluation) => <details key={evaluation.record.evaluationId} className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-xs font-medium">评估 Agent · {evaluation.record.evaluationId.slice(0, 8)} · 尝试与原始资源</summary><div className="mt-3"><AgentPanel projectId={projectId} title="评估 Agent" agent={evaluation.agent} /></div></details>)}
    </div> : tab === "evaluation" && !evaluator ? <Notice tone="neutral">还没有评估记录。执行完成后可点击“重新评估”。</Notice> : <div className="space-y-3">
      {tab === "evaluation" && data.evaluations.length > 1 && <NativeSelect aria-label="评估记录" value={evaluator?.record.evaluationId ?? ""} onChange={(event) => setEvaluationId(event.target.value)}>{data.evaluations.map((evaluation, index) => <option key={evaluation.record.evaluationId} value={evaluation.record.evaluationId}>评估 {index + 1} · {evaluation.record.evaluationId.slice(0, 8)}</option>)}</NativeSelect>}
      {debugTarget.agent.chatId ? <AgentProcess key={debugTarget.id} projectId={projectId} kind={debugTarget.kind} id={debugTarget.id} title={debugTarget.title} status={debugTarget.agent.stage.status} duration={debugTarget.agent.agentDurationMs} running={running}
        artifactCount={debugTarget.agent.artifacts.length} stacked={comparing} focus={focus?.kind === debugTarget.kind && focus.id === debugTarget.id ? focus : null} /> : <Notice tone="neutral">该 Agent 尚未开始运行，没有会话可查看。</Notice>}
    </div>}

  </div>;

}

export function SamplingDetailPage({ projectId, samplingId }: { projectId: string; samplingId: string }) {
  return <Page><SamplingResult standalone key={samplingId} projectId={projectId} samplingId={samplingId} /></Page>;
}
