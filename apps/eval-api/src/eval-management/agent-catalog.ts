import { createActionsClient, createApiSuppliersClient, type AgentEditorRequest, type ActionCatalogQuery } from "@springbrand/agent-config-editor/client";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { Context } from "hono";
import type { AppBindings } from "../lib/types.js";
import { EvalSpApiError, EvalSpTransportError } from "../sp/http.js";
import { readLibrary } from "./common.js";

/** The published editor owns catalog query serialization and response validation. */
function clients(c: Context<AppBindings>) {
  const request: AgentEditorRequest = async <T>(path: string) => {
    const url = new URL(path, "https://eval-sp.invalid");
    if (url.pathname === "/api/actions") return await readLibrary(c, "/actions", url.searchParams) as T;
    if (url.pathname === "/api/api-suppliers") return await readLibrary(c, "/api-suppliers") as T;
    if (url.pathname.startsWith("/api/actions/")) {
      return await readLibrary(c, "/actions/{id}", url.searchParams,
        decodeURIComponent(url.pathname.slice("/api/actions/".length))) as T;
    }
    throw new HttpError("REQUEST_INVALID_INPUT", "Unknown catalog");
  };
  return { actions: createActionsClient(request), suppliers: createApiSuppliersClient(request) };
}

async function validated<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (error instanceof EvalSpApiError || error instanceof EvalSpTransportError || error instanceof HttpError) throw error;
    throw new HttpError("RESPONSE_INVALID", "SP returned invalid resource metadata", { cause: error });
  }
}

export const readActionPage = (c: Context<AppBindings>, query: ActionCatalogQuery) =>
  validated(() => clients(c).actions.listActions(query, c.req.raw.signal));
export const readAction = (c: Context<AppBindings>, id: string) =>
  validated(() => clients(c).actions.getAction(id, c.req.raw.signal));
export const readSuppliers = (c: Context<AppBindings>) =>
  validated(() => clients(c).suppliers.listSuppliers(c.req.raw.signal));
