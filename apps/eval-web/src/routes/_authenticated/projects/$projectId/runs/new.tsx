import { createFileRoute } from "@tanstack/react-router";
import { NewRunPage } from "@/features/runs/new-run-page";

export const Route = createFileRoute("/_authenticated/projects/$projectId/runs/new")({
  component: function NewRunRoute() {
    const { projectId } = Route.useParams();
    return <NewRunPage projectId={projectId} />;
  },
});
