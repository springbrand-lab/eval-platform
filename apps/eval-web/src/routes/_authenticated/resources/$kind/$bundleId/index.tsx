import { createFileRoute, notFound } from "@tanstack/react-router";
import { BundleDetailPage } from "@/features/resources/bundle-detail-page";
export const Route = createFileRoute("/_authenticated/resources/$kind/$bundleId/")({
  component: function BundleRoute() {
    const { kind, bundleId } = Route.useParams();
    if (kind !== "material" && kind !== "session") throw notFound();
    return <BundleDetailPage key={`${kind}:${bundleId}`} kind={kind} bundleId={bundleId} />;
  },
});
