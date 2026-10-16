import { createFileRoute } from "@tanstack/react-router";
import { BundleDetailPage } from "@/features/resources/bundle-detail-page";

export const Route = createFileRoute("/_authenticated/resources/$bundleId")({
  component: function BundleRoute() {
    const { bundleId } = Route.useParams();
    return <BundleDetailPage bundleId={bundleId} />;
  },
});
