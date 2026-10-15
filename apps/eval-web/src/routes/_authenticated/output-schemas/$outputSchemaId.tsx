import { createFileRoute } from "@tanstack/react-router";
import { OutputSchemaDetailPage } from "@/features/output-schemas/output-schema-detail-page";

export const Route = createFileRoute("/_authenticated/output-schemas/$outputSchemaId")({
  component: function OutputSchemaRoute() {
    const { outputSchemaId } = Route.useParams();
    return <OutputSchemaDetailPage outputSchemaId={outputSchemaId} />;
  },
});
