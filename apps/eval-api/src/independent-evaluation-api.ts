import type { EvalRunAdmission } from "@eval-platform/eval-runtime";
import { ConfigNotFoundError, RuntimeEvaluationSelectionError, RuntimeProjectBusyError, RuntimeRunIdentityConflictError } from "@eval-platform/eval-runtime";
import type { PostgresProjectCatalog } from "./db/catalog.js";
import type { ProjectRunView } from "./db/run-view.js";
import { ProjectRunStopConflictError } from "./db/runtime.js";
import {
  EvaluationSelectionTooLargeError,
  MAX_EVALUATION_BODY_BYTES,
  MAX_EVALUATION_SAMPLING_IDS,
  MAX_SELECTION_RESPONSE_BYTES,
} from "./independent-evaluation-limits.js";
import type { EvalSpClient } from "./sp/client.js";
import { parseStrictJson } from "./strict-json.js";

export interface IndependentEvaluationOwnerServices {
  /** Every reader and writer must be scoped to the verified Eval SP user. */
  readonly catalog: Pick<PostgresProjectCatalog, "getProject" | "listSuccessfulSamplings" | "selectAllSuccessfulSamplingIds">;
  readonly runtime: Pick<EvalRunAdmission, "evaluate">;
  /** Return a consistent, owner-scoped Run view and its ordered Evaluation records. */
  readonly readRun: (projectId: string, runId: string) => Promise<ProjectRunView | null>;
  readonly getCurrentRun: (projectId: string) => Promise<{ runId: string; stopRequested?: true } | null>;
  readonly stopRun: (projectId: string, runId: string) => Promise<{ runId: string; stopRequested: true } | null>;
}

export interface IndependentEvaluationApiOptions {
  readonly spClient: Pick<EvalSpClient, "verifySession">;
  /** Shared by active requests for one verified user, then released from memory. */
  readonly createOwnerServices: (ownerUserId: string) =>
    IndependentEvaluationOwnerServices | Promise<IndependentEvaluationOwnerServices>;
  /** When set, only this browser Origin may make cross-origin requests. */
  readonly webOrigin?: string;
  readonly onError?: (error: Error) => void;
}

export interface IndependentEvaluationApi {
  handle(request: Request): Promise<Response>;
}

type Route =
  | { readonly kind: "samplingPage" | "samplingIds" | "evaluate" | "currentRun"; readonly projectId: string }
  | { readonly kind: "run" | "runEvaluations" | "stopRun"; readonly projectId: string; readonly runId: string };

type RouteShape =
  | { readonly kind: "samplingPage" | "samplingIds" | "evaluate" | "currentRun"; readonly projectSegment: string }
  | { readonly kind: "run" | "runEvaluations" | "stopRun"; readonly projectSegment: string; readonly runSegment: string };

function routeShape(pathname: string): RouteShape | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "projects" || !parts[2]) return null;
  const projectSegment = parts[2];
  if (parts.length === 5 && parts[3] === "samplings" && parts[4] === "successful") {
    return { kind: "samplingPage", projectSegment };
  }
  if (parts.length === 6 && parts[3] === "samplings" && parts[4] === "successful" && parts[5] === "ids") {
    return { kind: "samplingIds", projectSegment };
  }
  if (parts.length === 4 && parts[3] === "evaluations") return { kind: "evaluate", projectSegment };
  if (parts.length === 5 && parts[3] === "runs" && parts[4] === "current") {
    return { kind: "currentRun", projectSegment };
  }
  if (parts.length === 6 && parts[3] === "runs" && parts[4] && parts[5] === "stop") {
    return { kind: "stopRun", projectSegment, runSegment: parts[4] };
  }
  if (parts.length === 5 && parts[3] === "runs" && parts[4]) {
    return { kind: "run", projectSegment, runSegment: parts[4] };
  }
  if (parts.length === 6 && parts[3] === "runs" && parts[4] && parts[5] === "evaluations") {
    return { kind: "runEvaluations", projectSegment, runSegment: parts[4] };
  }
  return null;
}

/** Select the established independent-evaluation routes before another API handler authenticates. */
export function matchesIndependentEvaluationPath(pathname: string): boolean {
  return routeShape(pathname) !== null;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function validId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512
    || value.trim() !== value || /[\x00-\x1f/]/.test(value)) {
    throw new HttpError(400, "INVALID_REQUEST", `${field} must be a non-empty identifier`);
  }
  return value;
}

function validIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512
    || value.trim() !== value || /[\x00-\x1f]/.test(value)) {
    throw new HttpError(400, "INVALID_REQUEST", "idempotencyKey must be a non-empty key without surrounding whitespace");
  }
  return value;
}

function routeFor(pathname: string): Route | null {
  const shape = routeShape(pathname);
  if (!shape) return null;
  let projectId: string;
  try {
    projectId = validId(decodeURIComponent(shape.projectSegment), "projectId");
  } catch (error) {
    if (error instanceof URIError) throw new HttpError(400, "INVALID_REQUEST", "Invalid projectId encoding");
    throw error;
  }
  if (shape.kind === "run" || shape.kind === "runEvaluations" || shape.kind === "stopRun") {
    let runId: string;
    try {
      runId = validId(decodeURIComponent(shape.runSegment), "runId");
    } catch (error) {
      if (error instanceof URIError) throw new HttpError(400, "INVALID_REQUEST", "Invalid runId encoding");
      throw error;
    }
    return { kind: shape.kind, projectId, runId };
  }
  return { kind: shape.kind, projectId };
}

function methodFor(route: Route): "GET" | "POST" {
  return route.kind === "evaluate" || route.kind === "stopRun" ? "POST" : "GET";
}

function queryValues(url: URL, allowed: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) {
      throw new HttpError(400, "INVALID_REQUEST", `Invalid query parameter: ${key}`);
    }
    values[key] = url.searchParams.get(key)!;
  }
  return values;
}

function optionalId(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : validId(value, field);
}

function pageLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new HttpError(400, "INVALID_REQUEST", "limit must be an integer between 1 and 1000");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 1000) {
    throw new HttpError(400, "INVALID_REQUEST", "limit must be an integer between 1 and 1000");
  }
  return limit;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  if (!request.body) throw new HttpError(400, "INVALID_REQUEST", "JSON request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_EVALUATION_BODY_BYTES) {
        throw new HttpError(413, "BODY_TOO_LARGE", "Evaluation request body exceeds 8 MiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "INVALID_REQUEST", "Request body must be valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_REQUEST", "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function evaluationInput(body: Record<string, unknown>): {
  readonly evaluationConfigId: string;
  readonly samplingIds: readonly string[];
  readonly idempotencyKey: string;
} {
  const fields = ["evaluationConfigId", "samplingIds", "idempotencyKey"];
  if (Object.keys(body).some((field) => !fields.includes(field))) {
    throw new HttpError(400, "INVALID_REQUEST", "Evaluation request contains an unknown field");
  }
  const evaluationConfigId = validId(body.evaluationConfigId, "evaluationConfigId");
  const idempotencyKey = validIdempotencyKey(body.idempotencyKey);
  if (!Array.isArray(body.samplingIds) || body.samplingIds.length === 0) {
    throw new HttpError(400, "INVALID_REQUEST", "samplingIds must be a non-empty array");
  }
  if (body.samplingIds.length > MAX_EVALUATION_SAMPLING_IDS) {
    throw new HttpError(413, "SELECTION_TOO_LARGE", "Evaluation selection exceeds 10,000 Samplings");
  }
  const samplingIds = body.samplingIds.map((id) => validId(id, "samplingIds entry"));
  if (new Set(samplingIds).size !== samplingIds.length) {
    throw new HttpError(400, "INVALID_REQUEST", "samplingIds must not contain duplicates");
  }
  return { evaluationConfigId, samplingIds, idempotencyKey };
}

function json(status: number, value: unknown, webOrigin?: string): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  if (webOrigin) {
    headers.set("Access-Control-Allow-Origin", webOrigin);
    headers.set("Vary", "Origin");
  }
  return new Response(JSON.stringify(value), { status, headers });
}

function failure(error: HttpError, webOrigin?: string): Response {
  return json(error.status, { error: { code: error.code, message: error.message } }, webOrigin);
}

function verifiedToken(request: Request): string {
  const match = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new HttpError(401, "UNAUTHENTICATED", "An Eval SP Bearer session is required");
  return match[1]!;
}

function checkedWebOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("webOrigin must be an HTTP origin without path or credentials");
  }
  return url.origin;
}

export function createIndependentEvaluationApi(options: IndependentEvaluationApiOptions): IndependentEvaluationApi {
  const webOrigin = checkedWebOrigin(options.webOrigin);
  type OwnerServicesEntry = {
    readonly promise: Promise<IndependentEvaluationOwnerServices>;
    activeRequests: number;
  };
  const ownerServices = new Map<string, OwnerServicesEntry>();
  const servicesFor = async (ownerUserId: string): Promise<{
    readonly services: IndependentEvaluationOwnerServices;
    readonly release: () => void;
  }> => {
    let entry = ownerServices.get(ownerUserId);
    if (!entry) {
      entry = {
        promise: Promise.resolve().then(() => options.createOwnerServices(ownerUserId)),
        activeRequests: 0,
      };
      ownerServices.set(ownerUserId, entry);
    }
    const current = entry;
    current.activeRequests += 1;
    const release = () => {
      current.activeRequests -= 1;
      if (current.activeRequests === 0 && ownerServices.get(ownerUserId) === current) {
        ownerServices.delete(ownerUserId);
      }
    };
    try {
      return { services: await current.promise, release };
    } catch (error) {
      release();
      throw error;
    }
  };

  return {
    async handle(request) {
      const requestOrigin = request.headers.get("origin");
      const corsOrigin = webOrigin && requestOrigin === webOrigin ? webOrigin : undefined;
      try {
        if (webOrigin && requestOrigin && requestOrigin !== webOrigin) {
          throw new HttpError(403, "ORIGIN_FORBIDDEN", "Origin is not allowed");
        }
        const url = new URL(request.url);
        const route = routeFor(url.pathname);
        if (!route) throw new HttpError(404, "NOT_FOUND", "Route not found");
        const method = methodFor(route);
        if (request.method === "OPTIONS" && corsOrigin) {
          return new Response(null, { status: 204, headers: {
            "Access-Control-Allow-Origin": corsOrigin,
            "Access-Control-Allow-Methods": method,
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Cache-Control": "no-store",
            Vary: "Origin",
          } });
        }
        if (request.method !== method) throw new HttpError(405, "METHOD_NOT_ALLOWED", `Use ${method}`);
        const token = verifiedToken(request);
        let ownerUserId: string;
        try {
          const user = await options.spClient.verifySession(token);
          if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Eval SP session is invalid");
          ownerUserId = user.id;
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(502, "SP_UNAVAILABLE", "Eval SP session verification failed");
        }
        const { services, release } = await servicesFor(ownerUserId);
        try {
          if (route.kind !== "run" && route.kind !== "runEvaluations"
            && !await services.catalog.getProject(route.projectId)) {
            throw new HttpError(404, "NOT_FOUND", "Project not found");
          }

          switch (route.kind) {
            case "samplingPage": {
              const query = queryValues(url, ["sampleId", "afterSamplingId", "limit"]);
              const sampleId = optionalId(query.sampleId, "sampleId");
              const afterSamplingId = optionalId(query.afterSamplingId, "afterSamplingId");
              const limit = pageLimit(query.limit);
              const page = await services.catalog.listSuccessfulSamplings(route.projectId, {
                ...(sampleId === undefined ? {} : { sampleId }),
                ...(afterSamplingId === undefined ? {} : { afterSamplingId }),
                ...(limit === undefined ? {} : { limit }),
              });
              return json(200, page, corsOrigin);
            }
            case "samplingIds": {
              const query = queryValues(url, ["sampleId"]);
              const sampleId = optionalId(query.sampleId, "sampleId");
              const filter = sampleId === undefined ? {} : { sampleId };
              const samplingIds = await services.catalog.selectAllSuccessfulSamplingIds(route.projectId, filter);
              if (samplingIds.length > MAX_EVALUATION_SAMPLING_IDS
                || new TextEncoder().encode(JSON.stringify({ samplingIds })).byteLength > MAX_SELECTION_RESPONSE_BYTES) {
                throw new HttpError(413, "SELECTION_TOO_LARGE", "Evaluation selection exceeds one request");
              }
              return json(200, { samplingIds }, corsOrigin);
            }
            case "evaluate": {
              queryValues(url, []);
              const body = evaluationInput(await readJsonObject(request));
              const handle = await services.runtime.evaluate({ projectId: route.projectId, ...body });
              return json(202, handle, corsOrigin);
            }
            case "currentRun": {
              queryValues(url, []);
              return json(200, { run: await services.getCurrentRun(route.projectId) }, corsOrigin);
            }
            case "stopRun": {
              queryValues(url, []);
              if (request.body) throw new HttpError(400, "INVALID_REQUEST", "Stop request must not have a body");
              const stopped = await services.stopRun(route.projectId, route.runId);
              if (!stopped) throw new HttpError(404, "NOT_FOUND", "Run not found");
              return json(202, stopped, corsOrigin);
            }
            case "run":
            case "runEvaluations": {
              queryValues(url, []);
              const view = await services.readRun(route.projectId, route.runId);
              if (!view || view.run.projectId !== route.projectId || view.run.runId !== route.runId) {
                throw new HttpError(404, "NOT_FOUND", "Run not found");
              }
              return route.kind === "run"
                ? json(200, { run: view.run }, corsOrigin)
                : json(200, { evaluations: view.evaluations }, corsOrigin);
            }
          }
        } finally {
          release();
        }
      } catch (error) {
        if (error instanceof EvaluationSelectionTooLargeError) {
          return failure(new HttpError(413, "SELECTION_TOO_LARGE", error.message), corsOrigin);
        }
        if (error instanceof RuntimeRunIdentityConflictError) {
          return failure(new HttpError(409, "IDEMPOTENCY_CONFLICT", error.message), corsOrigin);
        }
        if (error instanceof RuntimeProjectBusyError) {
          return failure(new HttpError(409, "PROJECT_BUSY", error.message), corsOrigin);
        }
        if (error instanceof RuntimeEvaluationSelectionError) {
          return failure(new HttpError(409, "SAMPLING_UNAVAILABLE", "Selected Sampling is unavailable for evaluation"), corsOrigin);
        }
        if (error instanceof ProjectRunStopConflictError) {
          return failure(new HttpError(409,
            error.reason === "no_active_run" ? "NO_ACTIVE_RUN" : "RUN_CHANGED", error.message), corsOrigin);
        }
        if (error instanceof HttpError) return failure(error, corsOrigin);
        if (error instanceof ConfigNotFoundError && error.kind === "evaluation") {
          return failure(new HttpError(404, "NOT_FOUND", "Evaluation config not found"), corsOrigin);
        }
        try { (options.onError ?? console.error)(error instanceof Error ? error : new Error(String(error))); }
        catch (reportingError) { console.error(error, reportingError); }
        return failure(new HttpError(500, "INTERNAL_ERROR", "Evaluation API request failed"), corsOrigin);
      }
    },
  };
}
