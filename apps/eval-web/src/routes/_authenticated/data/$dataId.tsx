import { createFileRoute } from "@tanstack/react-router";
import { DataEditorPage } from "@/features/datasets/data-editor-page";

export const Route = createFileRoute("/_authenticated/data/$dataId")({
  validateSearch: (search: Record<string, unknown>): { datasetId?: string } => ({ datasetId: typeof search.datasetId === "string" ? search.datasetId : undefined }),
  component: function DataRoute() {
    const { dataId } = Route.useParams();
    return <DataEditorPage dataId={dataId} datasetId={Route.useSearch().datasetId} />;
  },
});
