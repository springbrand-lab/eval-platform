import type { SearchMiddleware } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import type { ComparisonViewMode } from "@/features/metrics/comparison-view";

export interface DashboardReadSearch {
  dashboardId?: string;
  jsonPointer?: string;
  datasetId?: string;
  dataId?: string;
  projectSearch?: string;
  dataSearch?: string;
  differences?: boolean;
  sort?: "difference";
  projectPage?: number;
  dataPage?: number;
  sampling?: Record<string, string>;
  viewMode?: ComparisonViewMode;
  dashboardSearch?: string;
  dashboardPage?: number;
  dashboardSort?: SortingState;
}

export interface DashboardEditSearch extends DashboardReadSearch {
  removeProjectId?: string;
}

export interface DashboardSearch extends DashboardReadSearch {
  projectId: string[];
}

const text = (value: unknown) => typeof value === "string" && value.length > 0 ? value : undefined;
const page = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 1 ? value : undefined;

function directorySorting(input: unknown): SortingState | undefined {
  if (!Array.isArray(input)) return undefined;
  const sorting: SortingState = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object" || (entry.id !== "name" && entry.id !== "updated")
      || typeof entry.desc !== "boolean" || sorting.some((item) => item.id === entry.id)) continue;
    sorting.push({ id: entry.id, desc: entry.desc });
  }
  return sorting.length > 0 ? sorting : undefined;
}

export function validateDashboardReadSearch(search: Record<string, unknown>): DashboardReadSearch {
  const sampling = search.sampling && typeof search.sampling === "object" && !Array.isArray(search.sampling)
    ? Object.fromEntries(Object.entries(search.sampling).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined;
  return {
    dashboardId: text(search.dashboardId),
    jsonPointer: typeof search.jsonPointer === "string" ? search.jsonPointer : undefined,
    datasetId: text(search.datasetId), dataId: text(search.dataId),
    projectSearch: text(search.projectSearch), dataSearch: text(search.dataSearch),
    differences: search.differences === true || undefined,
    sort: search.sort === "difference" ? "difference" : undefined,
    projectPage: page(search.projectPage), dataPage: page(search.dataPage), sampling,
    viewMode: search.viewMode === "execution" ? "execution" : undefined,
    dashboardSearch: text(search.dashboardSearch), dashboardPage: page(search.dashboardPage),
    dashboardSort: directorySorting(search.dashboardSort),
  };
}

export function validateDashboardEditSearch(search: Record<string, unknown>): DashboardEditSearch {
  return { ...validateDashboardReadSearch(search), removeProjectId: text(search.removeProjectId) };
}

export const dashboardSearchMiddleware: SearchMiddleware<DashboardReadSearch> = ({ search, next }) =>
  validateDashboardReadSearch({ ...next(search) });

export const dashboardEditSearchMiddleware: SearchMiddleware<DashboardEditSearch> = ({ search, next }) =>
  validateDashboardEditSearch({ ...next(search) });

export type ChangeDashboardSearch = (patch: Partial<DashboardSearch>, replace?: boolean) => void;

export const clearedDataScope = {
  dataId: undefined, dataSearch: undefined, differences: undefined, sort: undefined, dataPage: undefined, sampling: undefined,
};

export const clearedComparisonScope = { ...clearedDataScope, datasetId: undefined, jsonPointer: undefined };
