import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  getMessages, getObservationRef, getWorkspaceTree, observationKeys, type ObservedKind,
} from "@/api-sdk/observations-api";
import { getProject, projectKeys } from "@/api-sdk/projects-api";
import { Page, PageHeader } from "@/components/layout/page";
import { StatusBadge } from "@/components/ui/badge";
import { CopyId, Tabs } from "@/components/ui/data-display";
import { EmptyState, ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { LangfuseLink } from "@/features/results/agent-panel";
import { MessagesTab } from "./messages-tab";
import { TrajectoryTab } from "./trajectory-tab";
import { WorkspaceTab } from "./workspace-tab";

type Tab = "messages" | "workspace" | "trajectory";

export function ObservationPage({ projectId, target }: { projectId: string; target: { role: "subject" | "evaluator"; id: string } }) {
  const kind: ObservedKind = target.role === "subject" ? "samplings" : "evaluations";
  const [tab, setTab] = useState<Tab>("messages");
  const view = useQuery({ queryKey: projectKeys.detail(projectId), queryFn: ({ signal }) => getProject(projectId, signal) });
  const ref = useQuery({
    queryKey: observationKeys.ref(projectId, kind, target.id),
    queryFn: ({ signal }) => getObservationRef(projectId, kind, target.id, signal),
  });
  const started = ref.data?.state === "available" && !!ref.data.chatId;
  const running = !!view.data?.currentRun;
  const refresh = running ? 5_000 : false;
  const messages = useQuery({
    queryKey: observationKeys.part(projectId, kind, target.id, "messages"),
    queryFn: ({ signal }) => getMessages(projectId, kind, target.id, signal),
    enabled: started && tab === "messages",
    refetchInterval: refresh,
  });
  const tree = useQuery({
    queryKey: observationKeys.part(projectId, kind, target.id, "tree"),
    queryFn: ({ signal }) => getWorkspaceTree(projectId, kind, target.id, signal),
    enabled: started && tab === "workspace",
    refetchInterval: refresh,
  });
  const samplingId = ref.data?.samplingId;
  const title = target.role === "subject" ? "被测 Agent 会话" : "评委会话";
  return (
    <Page>
      <PageHeader
        title={title}
        description="只读查看，不能在这里发送消息或操作 Agent。"
        crumbs={[
          { label: "Project", to: "/projects" },
          { label: view.data?.project.name ?? "Project", to: "/projects/$projectId", params: { projectId } },
          ...(samplingId ? [{ label: `采样 ${samplingId.slice(0, 8)}`, to: "/projects/$projectId/samplings/$samplingId", params: { projectId, samplingId } }] : []),
        ]}
        actions={ref.data?.chatId && (
          <span className="flex items-center gap-3">
            <CopyId value={ref.data.chatId} />
            <LangfuseLink chatId={ref.data.chatId} />
          </span>
        )}
      />
      {ref.isPending ? <LoadingBlock /> : ref.error ? <ErrorBlock error={ref.error} /> : !started ? (
        <EmptyState title="Agent 还没有开始运行" description="开始运行后，这里会显示会话、工作区和轨迹。" icon={<StatusBadge status="not-started" />} />
      ) : (
        <div className="flex flex-col gap-4">
          {target.role === "evaluator" && <Notice>评委在自己的工作区中评审：被测 Agent 的产物和完整轨迹以证据包的形式导入到 /evidence，评委把结果写在 /output/result.json。</Notice>}
          <Tabs<Tab> value={tab} onChange={setTab} tabs={[
            { value: "messages", label: "会话" },
            { value: "workspace", label: "工作区" },
            { value: "trajectory", label: "轨迹" },
          ]} />
          {tab === "messages" && (messages.isPending ? <LoadingBlock /> : messages.error ? <ErrorBlock error={messages.error} /> : <MessagesTab messages={messages.data} running={running} />)}
          {tab === "workspace" && (tree.isPending ? <LoadingBlock /> : tree.error ? <ErrorBlock error={tree.error} /> : <WorkspaceTab projectId={projectId} kind={kind} id={target.id} tree={tree.data} />)}
          {tab === "trajectory" && <TrajectoryTab projectId={projectId} kind={kind} id={target.id} />}
        </div>
      )}
    </Page>
  );
}
