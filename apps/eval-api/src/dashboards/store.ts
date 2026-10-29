import type { Dashboard, DashboardInput } from "@eval-platform/eval-contracts";

export interface DashboardStore {
  list(): Promise<readonly Dashboard[]>;
  get(dashboardId: string): Promise<Dashboard | null>;
  create(input: DashboardInput, creation: { readonly key: string; readonly fingerprint: string }): Promise<Dashboard>;
  update(dashboardId: string, input: DashboardInput, revision: number): Promise<Dashboard>;
}
