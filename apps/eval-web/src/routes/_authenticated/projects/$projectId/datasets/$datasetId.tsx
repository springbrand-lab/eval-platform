import { createFileRoute } from "@tanstack/react-router";
import { DatasetResultsPage } from "@/features/results/dataset-results-page";

export const Route = createFileRoute("/_authenticated/projects/$projectId/datasets/$datasetId")({
  component: function DatasetResultsRoute() {
    const { projectId, datasetId } = Route.useParams();
    return <DatasetResultsPage projectId={projectId} datasetId={datasetId} />;
  },
});
