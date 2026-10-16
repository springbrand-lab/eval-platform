import { createFileRoute } from "@tanstack/react-router";
import { NewDataPage } from "@/features/datasets/data-editor-page";

export const Route = createFileRoute("/_authenticated/datasets/$datasetId/data/new")({
  component: function NewDataRoute() {
    const { datasetId } = Route.useParams();
    return <NewDataPage datasetId={datasetId} />;
  },
});
