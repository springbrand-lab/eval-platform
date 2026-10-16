import { createFileRoute } from "@tanstack/react-router";
import { ProjectDetailPage } from "@/features/projects/project-detail-page";

export const Route = createFileRoute("/_authenticated/projects/$projectId/")({
  component: function ProjectRoute() {
    const { projectId } = Route.useParams();
    return <ProjectDetailPage projectId={projectId} />;
  },
});
