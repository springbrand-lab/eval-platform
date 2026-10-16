import { createFileRoute } from "@tanstack/react-router";
import { DataEditorPage } from "@/features/datasets/data-editor-page";

export const Route = createFileRoute("/_authenticated/data/$dataId")({
  component: function DataRoute() {
    const { dataId } = Route.useParams();
    return <DataEditorPage dataId={dataId} />;
  },
});
