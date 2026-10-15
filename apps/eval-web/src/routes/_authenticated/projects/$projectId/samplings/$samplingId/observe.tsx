import { createFileRoute } from "@tanstack/react-router";
import { ObservationPage } from "@/features/observation/observation-page";

export const Route = createFileRoute("/_authenticated/projects/$projectId/samplings/$samplingId/observe")({
  component: function SubjectObservationRoute() {
    const { projectId, samplingId } = Route.useParams();
    return <ObservationPage projectId={projectId} target={{ role: "subject", id: samplingId }} />;
  },
});
