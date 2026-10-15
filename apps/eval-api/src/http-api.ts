import type { StartRunRequest, PipelineRequest, AgentRole } from "@eval-platform/eval-contracts";
import type { DataInput, DatasetInput, DatasetService } from "@eval-platform/eval-dataset";
import {
  DataInUseError,
  DatasetEntityNotFoundError,
  DatasetIdentityConflictError,
  dataIdSchema,
  datasetIdSchema,
} from "@eval-platform/eval-dataset";
import type { Metrics } from "@eval-platform/eval-metrics";
import { MetricsQueryError } from "@eval-platform/eval-metrics";
import type {
  EvalRunAdmission,
  EvalRuntime,
  EvaluationConfigInput,
  ExecutionConfigInput,
  PipelineConfigInput,
} from "@eval-platform/eval-runtime";
import { ConfigNotFoundError, RuntimeEvaluationSelectionError, RuntimeProjectBusyError, RuntimeRunIdentityConflictError, RuntimeRunNotFoundError } from "@eval-platform/eval-runtime";
import type { PostgresCatalog } from "./db/catalog.js";
import {
  ConfigEntityNotFoundError,
  ConfigIdentityConflictError,
  ConfigReferenceError,
  type PostgresConfigStore,
} from "./db/config.js";
import { DatasetInUseError } from "./db/dataset.js";
import { OutputSchemaInUseError, OutputSchemaNotFoundError } from "./db/output-schemas.js";
import { BundleResourceInUseError, BundleResourceNotFoundError } from "./db/resource-catalog.js";
import { EvaluationSelectionTooLargeError } from "./db/errors.js";
import { matchesIndependentEvaluationPath, type IndependentEvaluationApi } from "./independent-evaluation-api.js";
import { EvalSpApiError, EvalSpTransportError, type EvalSpClient } from "./sp/client.js";
import { SpHarnessError } from "./sp/harness.js";
import { parseStrictJson } from "@eval-platform/eval-dataset";

const JSON_BODY_LIMIT = 1_000_000;
const DOCUMENT_BODY_LIMIT = 10_000_000;

export interface EvalApiOwnerServices {
  readonly datasets: DatasetService;
  readonly catalog: PostgresCatalog;
  readonly configs: PostgresConfigStore;
  readonly runtime: Pick<EvalRunAdmission, "start" | "pipeline"> & Pick<EvalRuntime,
    "getRun" | "getSampling" | "getEvaluation" | "listEvaluations">;
  readonly metrics: Metrics;
  /** Releases the shared admission instance after this request completes. */
  readonly release?: () => void;
}

export interface EvalApiHandlerOptions {
  readonly sp: EvalSpClient;
  readonly forOwner: (ownerUserId: string, sessionToken: string) => EvalApiOwnerServices;
  readonly initialResources: (request: Request, ownerUserId: string) => Promise<Response | null>;
  readonly independentEvaluation?: IndependentEvaluationApi;
  readonly onError?: (error: Error) => void;
}

class HttpInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function empty(): Response {
  return new Response(null, { status: 204 });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function methodNotAllowed(allowed: string): Response {
  return new Response(JSON.stringify({ error: { code: "method_not_allowed", message: "Method not allowed" } }), {
    status: 405,
    headers: { "Content-Type": "application/json", Allow: allowed },
  });
}

function found<T>(value: T | null, label: string): T {
  if (value === null) throw new HttpInputError(`${label} not found`, 404);
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = allowed): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !(key in value))) {
    throw new HttpInputError(`Expected fields: ${allowed.join(", ")}`);
  }
}

async function readText(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) throw new HttpInputError("Request body is required");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  try {
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new HttpInputError("Request body is too large", 413);
      }
      try { text += decoder.decode(part.value, { stream: true }); }
      catch (error) {
        if (error instanceof TypeError) throw new HttpInputError("Request body must be valid UTF-8");
        throw error;
      }
    }
    try { text += decoder.decode(); }
    catch (error) {
      if (error instanceof TypeError) throw new HttpInputError("Request body must be valid UTF-8");
      throw error;
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

async function readObject(request: Request, maxBytes = JSON_BODY_LIMIT): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = parseStrictJson(await readText(request, maxBytes));
  } catch (error) {
    if (error instanceof HttpInputError) throw error;
    throw new HttpInputError("Request body must be valid JSON with unique fields");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpInputError("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new HttpInputError(`${name} must be a nonblank string without surrounding whitespace`);
  }
  return value;
}

function dataId(value: unknown): string {
  const parsed = dataIdSchema.safeParse(value);
  if (!parsed.success) throw new HttpInputError("dataId must be a UUID");
  return parsed.data;
}

function datasetId(value: unknown): string {
  const parsed = datasetIdSchema.safeParse(value);
  if (!parsed.success) throw new HttpInputError("datasetId must be a UUID");
  return parsed.data;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new HttpInputError(`${name} must be an array of nonblank strings`);
  }
  return value as string[];
}

function configInput(kind: "execution" | "evaluation" | "pipeline", body: Record<string, unknown>): void {
  if (kind === "execution") {
    exactKeys(body, ["datasetId", "sampleIds", "harness", "samplingCount", "executionConcurrency", "retryPolicy"],
      ["datasetId", "harness", "samplingCount", "executionConcurrency"]);
    body.datasetId = datasetId(body.datasetId);
  } else if (kind === "evaluation") {
    exactKeys(body, ["evaluationHarness", "evaluationConcurrency", "retryPolicy"],
      ["evaluationHarness", "evaluationConcurrency"]);
  } else exactKeys(body, ["executionConfigId", "evaluationConfigId"]);
}

function runInput(kind: "execution" | "pipeline", body: Record<string, unknown>): void {
  const configKey = kind === "execution" ? "executionConfigId" : "pipelineConfigId";
  exactKeys(body, ["idempotencyKey", "projectId", configKey]);
  requiredString(body.idempotencyKey, "idempotencyKey");
  requiredString(body.projectId, "projectId");
  requiredString(body[configKey], configKey);
}

function optionalRole(url: URL): AgentRole | undefined {
  const role = url.searchParams.get("role");
  if (role === null) return undefined;
  if (role !== "subject" && role !== "evaluator") throw new HttpInputError("role must be subject or evaluator");
  return role;
}

function documentFormat(url: URL): "json" | "yaml" {
  const format = url.searchParams.get("format");
  if (format !== "json" && format !== "yaml") throw new HttpInputError("format must be json or yaml");
  return format;
}

function runIds(url: URL): readonly string[] | undefined {
  const ids = url.searchParams.getAll("runId");
  if (ids.some((id) => !id.trim())) throw new HttpInputError("runId must not be blank");
  return ids.length ? ids : undefined;
}

function mappedError(error: unknown, onError?: (error: Error) => void): Response {
  if (error instanceof HttpInputError) return errorResponse(error.status, error.status === 404 ? "not_found" : "invalid_request", error.message);
  if (error instanceof DatasetEntityNotFoundError || error instanceof ConfigEntityNotFoundError ||
    error instanceof BundleResourceNotFoundError || error instanceof OutputSchemaNotFoundError) {
    return errorResponse(404, "not_found", error.message);
  }
  if (error instanceof ConfigNotFoundError || error instanceof RuntimeRunNotFoundError) {
    return errorResponse(404, "not_found", error.message);
  }
  if (error instanceof RuntimeProjectBusyError) {
    return errorResponse(409, "project_busy", error.message);
  }
  if (error instanceof DatasetIdentityConflictError || error instanceof DatasetInUseError ||
    error instanceof DataInUseError || error instanceof BundleResourceInUseError ||
    error instanceof OutputSchemaInUseError || error instanceof ConfigIdentityConflictError ||
    error instanceof RuntimeRunIdentityConflictError) {
    return errorResponse(409, "conflict", error.message);
  }
  if (error instanceof RuntimeEvaluationSelectionError) {
    return errorResponse(409, "conflict", "Selected Sampling is unavailable for evaluation");
  }
  if (error instanceof EvaluationSelectionTooLargeError) {
    return errorResponse(413, "invalid_request", error.message);
  }
  if (error instanceof MetricsQueryError && /^Unknown\b/u.test(error.message)) {
    return errorResponse(404, "not_found", error.message);
  }
  if (error instanceof ConfigReferenceError || error instanceof MetricsQueryError) {
    return errorResponse(400, "invalid_request", error.message);
  }
  if (error instanceof EvalSpApiError) {
    if (error.status === 401) return errorResponse(401, "unauthorized", "Eval SP session is invalid");
    if (error.status === 403) return errorResponse(403, "forbidden", "Eval SP denied the request");
    if (error.status === 404) return errorResponse(404, "not_found", "Eval SP resource not found");
    if (error.status === 400 || error.status === 409) return errorResponse(error.status,
      error.status === 409 ? "conflict" : "invalid_request", "Eval SP rejected the request");
    return errorResponse(502, "upstream_error", "Eval SP request failed");
  }
  if (error instanceof EvalSpTransportError) return errorResponse(502, "upstream_error", "Eval SP request failed");
  if (error instanceof SpHarnessError) {
    if (error.retryable) return errorResponse(503, "resource_unavailable", "Bundle resource could not be read");
    if (/\bmissing\b/iu.test(error.message)) return errorResponse(404, "not_found", error.message);
    if (/\balready has different content\b/iu.test(error.message)) return errorResponse(409, "conflict", error.message);
    if (/\btoo large\b/iu.test(error.message)) return errorResponse(413, "invalid_request", error.message);
    return errorResponse(400, "invalid_request", error.message);
  }
  if (error instanceof RangeError && (error.message === "Request body is too large"
    || error.message === "Evaluation output JSON Schema is too large")) {
    return errorResponse(413, "invalid_request", error.message);
  }
  if (error instanceof SyntaxError || error instanceof URIError ||
    (error instanceof Error && (error.name === "ZodError" || error.name === "YAMLParseError" || error.name === "YAMLWarning"))) {
    return errorResponse(400, "invalid_request", "Request body or Dataset document is invalid");
  }
  if (error instanceof TypeError && /^(?:Project name must not be blank|Successful Sampling page size must be between 1 and 1000|Initial resource binding must specify materials or Session|JSON body is required|JSON object is required|YAML mapping keys must be strings|Expected a JSON value|JSON values must not depend on toJSON transformations|Prompt data file|Expected fields:|Metadata patch must|(?:name|description) must|content must|outputSchemaId must)/u.test(error.message)) {
    return errorResponse(400, "invalid_request", error.message);
  }
  if (error instanceof TypeError && error.message.startsWith("Evaluation output JSON Schema")) {
    return errorResponse(400, "invalid_request", error.message);
  }
  if (error instanceof RangeError && error.message.startsWith("YAML integers must be within the safe-integer range")) {
    return errorResponse(400, "invalid_request", error.message);
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    try { if (error instanceof Error) onError?.(error); } catch { /* Reporting cannot alter the response. */ }
    return errorResponse(500, "internal_error", "Internal server error");
  }
  if (error instanceof Error && /^Unknown (?:Project|run|sample|sampling|evaluation|execution config|evaluation config|pipeline config)\b/u.test(error.message)) {
    return errorResponse(404, "not_found", error.message);
  }
  if (error instanceof Error && /^(?:Project source branch|Project launch selection|Project evaluation output JSON Schema|An empty Project cannot)/u.test(error.message)) {
    return errorResponse(409, "conflict", error.message);
  }
  if (error instanceof Error && /^(?:(?:config|configId|datasetId|sampleIds(?:\[\d+\])?|samplingIds|samplingCount|executionConcurrency|evaluationConcurrency|harness(?:\.[A-Za-z]+)*|evaluationHarness(?:\.[A-Za-z]+)*|retryPolicy(?:\.[A-Za-z]+)*|projectId|executionConfigId|evaluationConfigId|pipelineConfigId|idempotencyKey) (?:must\b|is required\b|is not supported\b)|No samples found\b|Sample .+ does not belong to dataset\b)/u.test(error.message)) {
    return errorResponse(400, "invalid_request", error.message);
  }
  if (error instanceof Error) {
    try { onError?.(error); } catch { /* Reporting cannot alter the response. */ }
  }
  return errorResponse(500, "internal_error", "Internal server error");
}

export function createEvalApiHandler(options: EvalApiHandlerOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return request.method === "GET" ? json({ status: "ok" }) : methodNotAllowed("GET");
      if (!url.pathname.startsWith("/api/")) return errorResponse(404, "not_found", "Route not found");
      if (matchesIndependentEvaluationPath(url.pathname)) {
        return options.independentEvaluation
          ? await options.independentEvaluation.handle(request)
          : errorResponse(404, "not_found", "Route not found");
      }
      const authorization = request.headers.get("Authorization");
      const token = authorization?.match(/^Bearer ([^\s]+)$/iu)?.[1];
      if (!token) return errorResponse(401, "unauthorized", "Eval SP session token is required");
      const user = await options.sp.verifySession(token);
      if (!user) return errorResponse(401, "unauthorized", "Eval SP session is invalid");
      const resourceResponse = await options.initialResources(request, user.id);
      if (resourceResponse) return resourceResponse;
      const parts = url.pathname.split("/").slice(1).map((segment) => decodeURIComponent(segment));
      const services = options.forOwner(user.id, token);
      try {
      const [_, area, id, sub, leaf] = parts;
      const method = request.method;

      if (area === "me" && parts.length === 2) return method === "GET" ? json(user) : methodNotAllowed("GET");

      if (area === "agent-configs") {
        if (parts.length === 2) {
          if (method === "GET") return json(await options.sp.listAgentConfigs(token));
          if (method === "POST") return json(await options.sp.createAgentConfig(token, await readObject(request)), 201);
          return methodNotAllowed("GET, POST");
        }
        if (parts.length === 3 && id) {
          if (method === "GET") return json(await options.sp.getAgentConfig(token, id));
          if (method === "PATCH") return json(await options.sp.updateAgentConfig(token, id, await readObject(request)));
          if (method === "DELETE") { await options.sp.deleteAgentConfig(token, id); return empty(); }
          return methodNotAllowed("GET, PATCH, DELETE");
        }
      }

      if (area === "agents" && parts.length === 2) {
        return method === "GET" ? json(await services.catalog.listAgents(optionalRole(url))) : methodNotAllowed("GET");
      }

      if (area === "projects") {
        if (parts.length === 2) {
          if (method === "GET") return json(await services.catalog.listProjects());
          if (method === "POST") {
            const body = await readObject(request);
            exactKeys(body, ["name"]);
            return json(await services.catalog.createProject({ name: requiredString(body.name, "name") }), 201);
          }
          return methodNotAllowed("GET, POST");
        }
        if (parts.length === 3 && id) {
          if (method !== "GET") return methodNotAllowed("GET");
          const { evaluationOutputSchema: _schema, ...project } = found(await services.catalog.getProject(id), "Project");
          return json(project);
        }
      }

      if (area === "datasets") {
        if (parts.length === 2) {
          if (method === "GET") return json(await services.datasets.listDatasets());
          if (method === "POST") return json(await services.datasets.createDataset(await readObject(request) as unknown as DatasetInput), 201);
          return methodNotAllowed("GET, POST");
        }
        if (parts.length === 3 && id === "import") {
          if (method !== "POST") return methodNotAllowed("POST");
          return json(await services.datasets.importDataset(await readText(request, DOCUMENT_BODY_LIMIT), documentFormat(url)), 201);
        }
        if (parts.length === 3 && id === "prompt-import") {
          if (method !== "POST") return methodNotAllowed("POST");
          const body = await readObject(request, 20_000_000);
          exactKeys(body, ["name", "description", "format", "content"]);
          if (typeof body.content !== "string" || Buffer.byteLength(body.content, "utf8") > 10_000_000) {
            throw new HttpInputError("Prompt file is too large", 413);
          }
          return json(await services.datasets.importPromptDataset(body as unknown as {
            name: string; description: string; format: "json" | "jsonl"; content: string;
          }), 201);
        }
        if (parts.length === 3 && id) {
          if (method === "GET") return json(found(await services.datasets.getDataset(id), "Dataset"));
          if (method === "PUT") return json(await services.datasets.updateDataset(id, await readObject(request) as unknown as DatasetInput));
          if (method === "DELETE") { await services.datasets.deleteDataset(id); return empty(); }
          return methodNotAllowed("GET, PUT, DELETE");
        }
        if (parts.length === 4 && id && sub === "data") {
          if (method === "GET") return json(await services.datasets.listData(datasetId(id)));
          if (method === "POST" || method === "DELETE") {
            const body = await readObject(request);
            exactKeys(body, ["dataIds"]);
            const dataIds = stringArray(body.dataIds, "dataIds");
            if (method === "POST") await services.datasets.attachData(id, dataIds);
            else await services.datasets.detachData(id, dataIds);
            return empty();
          }
          return methodNotAllowed("GET, POST, DELETE");
        }
        if (parts.length === 4 && id && sub === "export") {
          if (method !== "GET") return methodNotAllowed("GET");
          const format = documentFormat(url);
          return new Response(await services.datasets.exportDataset(id, format), {
            headers: { "Content-Type": format === "json" ? "application/json; charset=utf-8" : "application/yaml; charset=utf-8" },
          });
        }
      }

      if (area === "data") {
        if (parts.length === 2) {
          if (method === "GET") return json(await services.datasets.listData(url.searchParams.has("datasetId")
            ? datasetId(url.searchParams.get("datasetId")) : undefined));
          if (method === "POST") return json(await services.datasets.createData(await readObject(request) as unknown as DataInput), 201);
          return methodNotAllowed("GET, POST");
        }
        if (parts.length === 3 && id) {
          if (method === "GET") return json(found(await services.datasets.getData(id), "Data"));
          if (method === "PUT") return json(await services.datasets.updateData(id, await readObject(request) as unknown as DataInput));
          if (method === "DELETE") { await services.datasets.deleteData(id); return empty(); }
          return methodNotAllowed("GET, PUT, DELETE");
        }
      }

      if (area === "samples") {
        if (parts.length === 2) {
          if (method === "GET") return json(await services.catalog.listSamples(dataId(url.searchParams.get("dataId"))));
          if (method === "POST") {
            const body = await readObject(request);
            exactKeys(body, ["dataId"]);
            return json(await services.catalog.createSample(dataId(body.dataId)), 201);
          }
          return methodNotAllowed("GET, POST");
        }
        if (parts.length === 3 && id) return method === "GET"
          ? json(found(await services.catalog.getSample(id), "Sample")) : methodNotAllowed("GET");
      }

      if (area === "configs" && (id === "execution" || id === "evaluation" || id === "pipeline")) {
        if (parts.length === 3) {
          if (method === "GET") return json(await (id === "execution" ? services.configs.listExecutionConfigs()
            : id === "evaluation" ? services.configs.listEvaluationConfigs() : services.configs.listPipelineConfigs()));
          if (method !== "POST") return methodNotAllowed("GET, POST");
          const body = await readObject(request);
          configInput(id, body);
          if (id === "execution") {
            return json(await services.configs.createExecutionConfig(body as unknown as ExecutionConfigInput), 201);
          }
          if (id === "evaluation") {
            return json(await services.configs.createEvaluationConfig(body as unknown as EvaluationConfigInput), 201);
          }
          return json(await services.configs.createPipelineConfig(body as unknown as PipelineConfigInput), 201);
        }
        if (parts.length === 4 && sub) {
          if (method === "GET") return json(found(await (id === "execution" ? services.configs.getExecutionConfig(sub)
            : id === "evaluation" ? services.configs.getEvaluationConfig(sub) : services.configs.getPipelineConfig(sub)), "Config"));
          if (method !== "PUT") return methodNotAllowed("GET, PUT");
          const body = await readObject(request);
          configInput(id, body);
          if (id === "execution") return json(await services.configs.updateExecutionConfig(sub, body as unknown as ExecutionConfigInput));
          if (id === "evaluation") return json(await services.configs.updateEvaluationConfig(sub, body as unknown as EvaluationConfigInput));
          return json(await services.configs.updatePipelineConfig(sub, body as unknown as PipelineConfigInput));
        }
      }

      if (area === "runs") {
        if (parts.length === 3 && (id === "execution" || id === "pipeline")) {
          if (method !== "POST") return methodNotAllowed("POST");
          const body = await readObject(request);
          runInput(id, body);
          if (id === "execution") {
            return json(await services.runtime.start(body as unknown as StartRunRequest), 201);
          }
          return json(await services.runtime.pipeline(body as unknown as PipelineRequest), 201);
        }
        if (parts.length === 3 && id && method === "GET") return json(await services.runtime.getRun(id));
      }

      if (area === "samplings" && parts.length === 3 && id) return method === "GET"
        ? json(await services.runtime.getSampling(id)) : methodNotAllowed("GET");
      if (area === "samplings" && parts.length === 4 && id && sub === "evaluations") {
        if (method !== "GET") return methodNotAllowed("GET");
        await services.runtime.getSampling(id);
        return json(await services.runtime.listEvaluations(id));
      }
      if (area === "evaluations" && parts.length === 3 && id) return method === "GET"
        ? json(await services.runtime.getEvaluation(id)) : methodNotAllowed("GET");

      if (area === "metrics" && id === "projects" && sub && method === "GET") {
        const selectedRunIds = runIds(url);
        const scope = { projectId: sub, ...(selectedRunIds === undefined ? {} : { runIds: selectedRunIds }) };
        if (parts.length === 4) return json(await services.metrics.getProjectOverview(scope));
        if (parts.length === 6 && leaf === "datasets" && parts[5]) return json(await services.metrics.getDatasetOverview({ ...scope, datasetId: datasetId(parts[5]) }));
        if (parts.length === 6 && leaf === "samples" && parts[5]) return json(await services.metrics.getSampleOverview({ ...scope, sampleId: parts[5] }));
        if (parts.length === 6 && leaf === "samplings" && parts[5]) return json(await services.metrics.getSamplingDetail({ ...scope, samplingId: parts[5] }));
      }

      return errorResponse(404, "not_found", "Route not found");
      } finally {
        services.release?.();
      }
    } catch (error) {
      return mappedError(error, options.onError);
    }
  };
}
