import { createFileRoute } from "@tanstack/react-router";
import { DataEditorPage } from "@/features/datasets/data-editor-page";

export const Route = createFileRoute("/_authenticated/data/new")({
  validateSearch: (search: Record<string, unknown>): { datasetId?: string } =>
    typeof search.datasetId === "string" ? { datasetId: search.datasetId } : {},
  component: function NewDataRoute() {
    const { datasetId } = Route.useSearch();
    return <DataEditorPage datasetId={datasetId} />;
  },
});
