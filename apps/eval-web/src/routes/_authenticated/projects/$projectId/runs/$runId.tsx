import { createFileRoute } from "@tanstack/react-router";
import { RunDetailPage } from "@/features/runs/run-detail-page";

export const Route = createFileRoute("/_authenticated/projects/$projectId/runs/$runId")({
  component: function RunRoute() {
    const { projectId, runId } = Route.useParams();
    return <RunDetailPage projectId={projectId} runId={runId} />;
  },
});
