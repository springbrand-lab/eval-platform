import { createFileRoute, notFound } from "@tanstack/react-router";
import { ResourceDetailPage } from "@/features/resources/resource-detail-page";

export const Route = createFileRoute("/_authenticated/resources/$kind/$bundleId/$resourceId")({
  component: function ResourceRoute() {
    const { kind, bundleId, resourceId } = Route.useParams();
    if (kind !== "material" && kind !== "session") throw notFound();
    return <ResourceDetailPage key={JSON.stringify([kind, bundleId, resourceId])} kind={kind} bundleId={bundleId} resourceId={resourceId} />;
  },
});
