import { createFileRoute } from "@tanstack/react-router";
import { EvaluationPlanPage } from "@/features/projects/evaluation-plan-page";

export const Route = createFileRoute("/_authenticated/projects/$projectId/evaluation-plan")({
  component: function EvaluationPlanRoute() {
    const { projectId } = Route.useParams();
    return <EvaluationPlanPage projectId={projectId} />;
  },
});
