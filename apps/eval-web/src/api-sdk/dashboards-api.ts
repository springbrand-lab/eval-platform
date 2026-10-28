import type { Dashboard, DashboardCreateInput, DashboardUpdateInput } from "@eval-platform/eval-contracts";
import { api, enc } from "./client";

export const dashboardKeys = {
  all: ["dashboards"] as const,
  list: () => ["dashboards", "list"] as const,
  detail: (dashboardId: string) => ["dashboards", "detail", dashboardId] as const,
};

export const listDashboards = (signal?: AbortSignal) => api.get<Dashboard[]>("/api/dashboards", { signal });
export const getDashboard = (dashboardId: string, signal?: AbortSignal) =>
  api.get<Dashboard>(`/api/dashboards/${enc(dashboardId)}`, { signal });
export const createDashboard = (input: DashboardCreateInput) => api.post<Dashboard>("/api/dashboards", input);
export const updateDashboard = (dashboardId: string, input: DashboardUpdateInput) =>
  api.put<Dashboard>(`/api/dashboards/${enc(dashboardId)}`, input);
