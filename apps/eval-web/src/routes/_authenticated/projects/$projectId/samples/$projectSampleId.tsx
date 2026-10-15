import { createFileRoute } from "@tanstack/react-router";
import { SampleResultsPage } from "@/features/results/sample-results-page";

export const Route = createFileRoute("/_authenticated/projects/$projectId/samples/$projectSampleId")({
  component: function SampleResultsRoute() {
    const { projectId, projectSampleId } = Route.useParams();
    return <SampleResultsPage projectId={projectId} projectSampleId={projectSampleId} />;
  },
});
