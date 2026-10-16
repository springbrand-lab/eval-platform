import { createFileRoute } from "@tanstack/react-router";
import { ProjectOutputSchemaPage } from "@/features/projects/project-output-schema-page";

export const Route = createFileRoute("/_authenticated/projects/$projectId/output-schema")({
  component: function ProjectOutputSchemaRoute() {
    const { projectId } = Route.useParams();
    return <ProjectOutputSchemaPage projectId={projectId} />;
  },
});
