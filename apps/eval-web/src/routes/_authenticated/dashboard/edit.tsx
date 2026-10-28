import { createFileRoute } from "@tanstack/react-router";
import { EditDashboardPage } from "@/features/dashboard/dashboard-form-page";
import { dashboardEditSearchMiddleware, validateDashboardEditSearch } from "@/features/dashboard/dashboard-search";

export const Route = createFileRoute("/_authenticated/dashboard/edit")({
  validateSearch: validateDashboardEditSearch,
  search: { middlewares: [dashboardEditSearchMiddleware] },
  component: () => <EditDashboardPage search={Route.useSearch()} />,
});
