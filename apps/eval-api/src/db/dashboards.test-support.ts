import { dashboardDataExclusionsSchema, type Dashboard } from "@eval-platform/eval-contracts";
import { DatabaseError } from "pg";
import { dashboardProjects, dashboards } from "./schema.js";
import { createTestDriver, driverRow, type TestDriverQuery } from "./test-driver.js";

type DashboardRow = typeof dashboards.$inferSelect;
type ProjectRow = typeof dashboardProjects.$inferSelect;

export const dashboardOwner = "dashboard-owner";

function binding(query: TestDriverQuery, column: string): unknown {
  const match = new RegExp(`"${column}" = \\$(\\d+)`, "u").exec(query.text.split(" where ")[1] ?? "");
  return match ? query.params[Number(match[1]) - 1] : undefined;
}

function bindings(query: TestDriverQuery, column: string): readonly unknown[] | undefined {
  const match = new RegExp(`"${column}" in \\(([^)]+)\\)`, "u").exec(query.text);
  return match ? [...match[1]!.matchAll(/\$(\d+)/gu)].map((item) => query.params[Number(item[1]) - 1]) : undefined;
}

function inserted(query: TestDriverQuery): Record<string, unknown>[] {
  const match = /^insert into "[^"]+" \(([^)]+)\) values (.+?)(?: on conflict | returning |$)/u.exec(query.text);
  if (!match) throw new Error(`Unexpected insertion: ${query.text}`);
  const columns = [...match[1]!.matchAll(/"([^"]+)"/gu)].map((item) => item[1]!);
  return [...match[2]!.matchAll(/\(([^()]+)\)/gu)].map((tuple) => Object.fromEntries(
    tuple[1]!.split(",").map((token, index) => {
      const parameter = /^\$(\d+)$/u.exec(token.trim());
      return [columns[index]!, parameter ? query.params[Number(parameter[1]) - 1] : undefined];
    }),
  ));
}

function constraint(code: string, name: string): DatabaseError {
  const error = new DatabaseError("Test database constraint violation", 0, "error");
  error.code = code;
  error.constraint = name;
  return error;
}

export function dashboardsDriver() {
  let state = {
    dashboards: new Map<string, DashboardRow>(), projects: [] as ProjectRow[],
    catalogProjects: new Map([
      ["first", { ownerUserId: dashboardOwner, deletedAt: null as Date | null }],
      ["second", { ownerUserId: dashboardOwner, deletedAt: null as Date | null }],
      ["third", { ownerUserId: dashboardOwner, deletedAt: null as Date | null }],
      ["foreign", { ownerUserId: "other-owner", deletedAt: null as Date | null }],
      ["deleted", { ownerUserId: dashboardOwner, deletedAt: new Date() }],
      ["unadmitted", { ownerUserId: dashboardOwner, deletedAt: null as Date | null }],
    ]),
    runs: new Set(["first", "second", "third", "foreign", "deleted"]),
    frozenCopies: new Map<string, string[]>(),
  };
  const transactions = new Map<number, { state: typeof state; finish: () => void; readOnly: boolean }>();
  let queue = Promise.resolve();
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const faults: { projectInsert: Error | null } = { projectInsert: null };
  const driver = createTestDriver(async (query) => {
    const { text, params, connection } = query;
    if (text.startsWith("begin")) {
      const previous = queue;
      let finish!: () => void;
      queue = new Promise<void>((resolve) => { finish = resolve; });
      await previous;
      transactions.set(connection, { state: structuredClone(state), finish, readOnly: text.includes("read only") });
      return [];
    }
    const transaction = transactions.get(connection);
    if (!transaction) throw new Error("Query outside a transaction");
    if (text === "commit" || text === "rollback") {
      if (text === "commit" && !transaction.readOnly) state = transaction.state;
      transactions.delete(connection);
      transaction.finish();
      return [];
    }
    const data = transaction.state;
    const owner = binding(query, "owner_user_id");
    const id = binding(query, "dashboard_id");
    const projectId = binding(query, "project_id");
    if (text.startsWith("select ")) {
      if (text.includes(' from "eval_projects" ')) {
        const ids = bindings(query, "project_id");
        const requiresRun = text.includes('exists (select "run_id" from "eval_runs" where "eval_runs"."project_id" = "eval_projects"."project_id")');
        if (text.includes(' from "eval_runs"') && !requiresRun) throw new Error(`Unexpected Run predicate: ${text}`);
        return [...data.catalogProjects].filter(([candidate, project]) =>
          project.ownerUserId === owner && (ids === undefined || ids.includes(candidate))
          && (projectId === undefined || candidate === projectId)
          && (!text.includes('"deleted_at" is null') || project.deletedAt === null)
          && (!requiresRun || data.runs.has(candidate)))
          .sort(([left], [right]) => left.localeCompare(right)).map(([candidate]) => [candidate]);
      }
      if (text.includes(' from "eval_runs" ')) {
        return data.runs.has(String(projectId)) ? [[`run-${projectId}`]] : [];
      }
      if (text.includes(' from "eval_project_agent_configs" ')) {
        return (data.frozenCopies.get(String(projectId)) ?? []).map((userAgentId) => [userAgentId]);
      }
      if (text.includes(' from "eval_dashboards"')) {
        const key = binding(query, "creation_key");
        const rows = [...data.dashboards.values()].filter((row) =>
          row.ownerUserId === owner && (id === undefined || row.dashboardId === id) && (key === undefined || row.creationKey === key));
        if (text.includes("order by")) {
          const direction = text.includes('"updated_at" desc') ? -1 : 1;
          rows.sort((left, right) => direction * (left.updatedAt.getTime() - right.updatedAt.getTime())
            || left.dashboardId.localeCompare(right.dashboardId));
        }
        return rows.map((row) => driverRow(dashboards, row));
      }
      if (text.includes(' from "eval_dashboard_projects"')) {
        const ids = bindings(query, "dashboard_id");
        const rows = data.projects.filter((row) => row.ownerUserId === owner
          && (id === undefined || row.dashboardId === id) && (ids === undefined || ids.includes(row.dashboardId)));
        if (text.includes("order by")) {
          rows.sort((left, right) => left.dashboardId.localeCompare(right.dashboardId) || left.position - right.position);
        }
        return rows.map((row) => [row.dashboardId, row.projectId]);
      }
    }
    if (transaction.readOnly) throw new Error("Write inside a read-only snapshot");
    if (text.startsWith('insert into "eval_dashboards"')) {
      const [values] = inserted(query);
      if (!values) throw new Error("No Dashboard values");
      const existing = [...data.dashboards.values()].find((row) =>
        row.ownerUserId === values.owner_user_id && row.creationKey === values.creation_key);
      if (existing) {
        if (text.includes('on conflict ("owner_user_id","creation_key") do nothing')) return [];
        throw constraint("23505", "eval_dashboards_owner_creation_key_uq");
      }
      const now = new Date(clock++);
      const row: DashboardRow = {
        dashboardId: String(values.dashboard_id), ownerUserId: String(values.owner_user_id),
        name: String(values.name), description: String(values.description ?? ""), revision: Number(values.revision ?? 1),
        excludedDataIds: values.excluded_data_ids === undefined ? [] : dashboardDataExclusionsSchema.parse(dashboards.excludedDataIds.mapFromDriverValue(String(values.excluded_data_ids))),
        creationKey: String(values.creation_key), creationFingerprint: String(values.creation_fingerprint),
        createdAt: now, updatedAt: now,
      };
      data.dashboards.set(row.dashboardId, row);
      return [driverRow(dashboards, row)];
    }
    if (text.startsWith('insert into "eval_dashboard_projects"')) {
      if (faults.projectInsert) {
        const error = faults.projectInsert;
        faults.projectInsert = null;
        throw error;
      }
      for (const values of inserted(query)) {
        const row: ProjectRow = {
          ownerUserId: String(values.owner_user_id), dashboardId: String(values.dashboard_id),
          projectId: String(values.project_id), position: Number(values.position),
        };
        if (data.dashboards.get(row.dashboardId)?.ownerUserId !== row.ownerUserId) {
          throw constraint("23503", "eval_dashboard_projects_dashboard_fk");
        }
        if (data.catalogProjects.get(row.projectId)?.ownerUserId !== row.ownerUserId) {
          throw constraint("23503", "eval_dashboard_projects_project_fk");
        }
        if (data.projects.some((item) => item.dashboardId === row.dashboardId && item.projectId === row.projectId)) {
          throw constraint("23505", "eval_dashboard_projects_dashboard_id_project_id_pk");
        }
        if (data.projects.some((item) => item.dashboardId === row.dashboardId && item.position === row.position)) {
          throw constraint("23505", "eval_dashboard_projects_position_uq");
        }
        data.projects.push(row);
      }
      return [];
    }
    if (text.startsWith('update "eval_dashboards" ')) {
      const revision = binding(query, "revision");
      const row = data.dashboards.get(String(id));
      if (!row || row.ownerUserId !== owner || revision !== undefined && row.revision !== revision) return [];
      const assignments = / set (.+?) where /u.exec(text)?.[1];
      if (!assignments) throw new Error("No update values");
      for (const field of ["name", "description", "revision"] as const) {
        const match = new RegExp(`"${field}" = \\$(\\d+)`, "u").exec(assignments);
        if (!match) throw new Error(`Missing update field ${field}`);
        const value = params[Number(match[1]) - 1];
        if (field === "revision") row.revision = Number(value);
        else row[field] = String(value);
      }
      row.updatedAt = new Date(clock++);
      const exclusion = /"excluded_data_ids" = \$(\d+)/u.exec(assignments);
      if (exclusion) row.excludedDataIds = dashboardDataExclusionsSchema.parse(dashboards.excludedDataIds.mapFromDriverValue(String(params[Number(exclusion[1]) - 1])));
      return [driverRow(dashboards, row)];
    }
    if (text.startsWith('delete from "eval_dashboard_projects" ')) {
      data.projects = data.projects.filter((row) => !(row.ownerUserId === owner && row.dashboardId === id));
      return [];
    }
    if (text.startsWith('delete from "eval_projects" ')) {
      if (data.projects.some((row) => row.projectId === projectId)) {
        throw constraint("23503", "eval_dashboard_projects_project_fk");
      }
      if (data.runs.has(String(projectId))) throw constraint("23503", "eval_runs_project_fk");
      data.catalogProjects.delete(String(projectId));
      return [];
    }
    if (text.startsWith('delete from "eval_project_agent_configs" ')) {
      data.frozenCopies.delete(String(projectId));
      return [];
    }
    if (/^delete from "eval_project_(evaluation_plans|execution_plans|sample_datasets|samples|datasets)" /u.test(text)) return [];
    throw new Error(`Unexpected SQL: ${text}`);
  });
  function seedDashboard(dashboard: Dashboard, ownerUserId = dashboardOwner) {
    state.dashboards.set(dashboard.dashboardId, {
      dashboardId: dashboard.dashboardId, ownerUserId, name: dashboard.name, description: dashboard.description,
      revision: dashboard.revision, createdAt: new Date(dashboard.createdAt), updatedAt: new Date(dashboard.updatedAt),
      excludedDataIds: dashboard.excludedDataIds ?? [],
      creationKey: dashboard.dashboardId, creationFingerprint: "seeded",
    });
    state.projects.push(...dashboard.projectIds.map((projectId, position) => ({
      ownerUserId, dashboardId: dashboard.dashboardId, projectId, position,
    })).reverse());
  }
  return {
    ...driver, faults, seedDashboard, snapshot: () => structuredClone(state),
    get projects() { return state.catalogProjects; },
    get runs() { return state.runs; },
    get frozenCopies() { return state.frozenCopies; },
  };
}
