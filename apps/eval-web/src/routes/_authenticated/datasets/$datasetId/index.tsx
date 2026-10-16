import { createFileRoute } from "@tanstack/react-router";
import { DatasetDetailPage } from "@/features/datasets/dataset-detail-page";

export const Route = createFileRoute("/_authenticated/datasets/$datasetId/")({
  component: function DatasetRoute() {
    const { datasetId } = Route.useParams();
    return <DatasetDetailPage datasetId={datasetId} />;
  },
});
