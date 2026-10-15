import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  getMessages, getObservationRef, getWorkspaceTree, observationKeys, type ObservedKind,
} from "@/api-sdk/observations-api";
import { getProject, projectKeys } from "@/api-sdk/projects-api";
import { PageHeader } from "@/components/layout/page";
import { CopyId, Tabs } from "@/components/ui/data-display";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
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
  const tabs = (
    <Tabs<Tab> value={tab} onChange={setTab} tabs={[
      { value: "messages", label: "会话" },
      { value: "workspace", label: "工作区" },
      { value: "trajectory", label: "轨迹" },
    ]} />
  );
  return (
    <div className="flex h-full flex-col">
      <div className="px-6">
        <PageHeader
          flush
          title={title}
          crumbs={[
            { label: "Project", to: "/projects" },
            { label: view.data?.project.name ?? "Project", to: "/projects/$projectId", params: { projectId } },
            ...(samplingId ? [{ label: `采样 ${samplingId.slice(0, 8)}`, to: "/projects/$projectId/samplings/$samplingId", params: { projectId, samplingId } }] : []),
          ]}
          meta={ref.data?.chatId && <CopyId value={ref.data.chatId} />}
          actions={started && (
            <>
              <LangfuseLink chatId={ref.data!.chatId} label="Langfuse" />
              {tabs}
            </>
          )}
        />
      </div>
      {ref.isPending ? <LoadingBlock /> : ref.error ? <div className="p-6"><ErrorBlock error={ref.error} /></div> : !started ? (
        <EmptyState title="Agent 还没有开始运行" />
      ) : tab === "messages" ? (
        messages.isPending ? <LoadingBlock /> : messages.error ? <div className="p-6"><ErrorBlock error={messages.error} /></div>
          : <MessagesTab messages={messages.data} running={running} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {tab === "workspace" && (tree.isPending ? <LoadingBlock /> : tree.error ? <ErrorBlock error={tree.error} /> : <WorkspaceTab projectId={projectId} kind={kind} id={target.id} tree={tree.data} />)}
          {tab === "trajectory" && <TrajectoryTab projectId={projectId} kind={kind} id={target.id} />}
        </div>
      )}
    </div>
  );
}
