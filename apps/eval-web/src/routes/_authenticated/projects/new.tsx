import { createFileRoute } from "@tanstack/react-router";
import { NewProjectPage } from "@/features/projects/new-project-page";
export const Route = createFileRoute("/_authenticated/projects/new")({
  validateSearch: (search: Record<string, unknown>): { datasetId?: string } => ({ datasetId: typeof search.datasetId === "string" ? search.datasetId : undefined }),
  component: () => <NewProjectPage datasetId={Route.useSearch().datasetId} />,
});
