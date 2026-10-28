import {
  canonicalJsonBytes,
  dashboardSchema,
  sha256Hex,
  type Dashboard,
  type DashboardCreateInput,
  type DashboardUpdateInput,
} from "@eval-platform/eval-contracts";
import { DashboardNotFoundError } from "./errors.js";
import { dashboardCreateInputSchema, dashboardUpdateInputSchema } from "./schemas.js";
import type { DashboardStore } from "./store.js";

export interface DashboardService {
  list(): Promise<readonly Dashboard[]>;
  get(dashboardId: string): Promise<Dashboard>;
  create(input: DashboardCreateInput): Promise<Dashboard>;
  update(dashboardId: string, input: DashboardUpdateInput): Promise<Dashboard>;
}

export function createDashboardService(store: DashboardStore): DashboardService {
  return {
    list: () => store.list(),
    async get(dashboardId) {
      const id = dashboardSchema.shape.dashboardId.parse(dashboardId);
      const dashboard = await store.get(id);
      if (!dashboard) throw new DashboardNotFoundError(id);
      return dashboard;
    },
    async create(command) {
      const { name, description, projectIds, idempotencyKey } = dashboardCreateInputSchema.parse(command);
      const input = { name, description, projectIds };
      return store.create(input, { key: idempotencyKey, fingerprint: await sha256Hex(canonicalJsonBytes(input)) });
    },
    async update(dashboardId, command) {
      const id = dashboardSchema.shape.dashboardId.parse(dashboardId);
      const { name, description, projectIds, revision } = dashboardUpdateInputSchema.parse(command);
      return store.update(id, { name, description, projectIds }, revision);
    },
  };
}
