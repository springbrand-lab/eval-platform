import { createFileRoute } from "@tanstack/react-router";
import { NewRunPage } from "@/features/runs/new-run-page";

export const Route = createFileRoute("/_authenticated/projects/$projectId/runs/new")({
  validateSearch: (search: Record<string, unknown>): { operation?: "execution" | "evaluation" | "pipeline"; datasetId?: string; projectSampleId?: string; samplingId?: string } => ({
    ...(search.operation === "execution" || search.operation === "evaluation" || search.operation === "pipeline" ? { operation: search.operation } : {}),
    ...(typeof search.datasetId === "string" ? { datasetId: search.datasetId } : {}),
    ...(typeof search.projectSampleId === "string" ? { projectSampleId: search.projectSampleId } : {}),
    ...(typeof search.samplingId === "string" ? { samplingId: search.samplingId } : {}),
  }),
  component: function NewRunRoute() {
    const { projectId } = Route.useParams();
    const initial = Route.useSearch();
    return <NewRunPage key={`${projectId}:${initial.datasetId ?? ""}:${initial.projectSampleId ?? ""}:${initial.samplingId ?? ""}:${initial.operation ?? ""}`} projectId={projectId} initial={initial} />;
  },
});
