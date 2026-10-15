import { createFileRoute } from "@tanstack/react-router";
import { ObservationPage } from "@/features/observation/observation-page";

export const Route = createFileRoute("/_authenticated/projects/$projectId/evaluations/$evaluationId/observe")({
  component: function EvaluatorObservationRoute() {
    const { projectId, evaluationId } = Route.useParams();
    return <ObservationPage projectId={projectId} target={{ role: "evaluator", id: evaluationId }} />;
  },
});
