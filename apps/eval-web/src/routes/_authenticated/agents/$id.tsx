import { createFileRoute } from "@tanstack/react-router";
import { AgentEditorPage } from "@/features/agents/agent-editor-page";

export const Route = createFileRoute("/_authenticated/agents/$id")({
  component: function AgentRoute() {
    const { id } = Route.useParams();
    return <AgentEditorPage id={id} />;
  },
});
