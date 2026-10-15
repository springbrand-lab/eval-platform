import { createFileRoute } from "@tanstack/react-router";
import { SamplingDetailPage } from "@/features/results/sampling-detail-page";

export const Route = createFileRoute("/_authenticated/projects/$projectId/samplings/$samplingId/")({
  component: function SamplingRoute() {
    const { projectId, samplingId } = Route.useParams();
    return <SamplingDetailPage projectId={projectId} samplingId={samplingId} />;
  },
});
