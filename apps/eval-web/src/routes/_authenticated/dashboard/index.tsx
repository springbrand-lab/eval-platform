import { createFileRoute } from "@tanstack/react-router";
import { DashboardPage } from "@/features/dashboard/dashboard-page";
import { dashboardSearchMiddleware, validateDashboardReadSearch } from "@/features/dashboard/dashboard-search";

export const Route = createFileRoute("/_authenticated/dashboard/")({
  validateSearch: validateDashboardReadSearch,
  search: { middlewares: [dashboardSearchMiddleware] },
  component: () => <DashboardPage search={Route.useSearch()} />,
});
