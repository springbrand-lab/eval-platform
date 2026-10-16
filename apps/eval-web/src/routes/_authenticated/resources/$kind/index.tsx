import { createFileRoute, notFound } from "@tanstack/react-router";
import { ResourcesPage } from "@/features/resources/resources-page";
export const Route = createFileRoute("/_authenticated/resources/$kind/")({
  component: function ResourcesRoute() {
    const { kind } = Route.useParams();
    if (kind !== "material" && kind !== "session") throw notFound();
    return <ResourcesPage key={kind} kind={kind} />;
  },
});
