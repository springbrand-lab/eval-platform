import { createFileRoute } from "@tanstack/react-router";
import { NewDashboardPage } from "@/features/dashboard/dashboard-form-page";
import { dashboardSearchMiddleware, validateDashboardReadSearch } from "@/features/dashboard/dashboard-search";

export const Route = createFileRoute("/_authenticated/dashboard/new")({
  validateSearch: validateDashboardReadSearch,
  search: { middlewares: [dashboardSearchMiddleware] },
  component: () => <NewDashboardPage search={Route.useSearch()} />,
});
