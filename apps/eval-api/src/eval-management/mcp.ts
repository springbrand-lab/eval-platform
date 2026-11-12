import { parseStrictJson } from "@eval-platform/eval-dataset";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { Context } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { apiError } from "../lib/api-errors.js";
import { createRouter } from "../lib/create-app.js";
import { dispatchMcp, isMcpRequest, mcpError, mcpResult, type McpRpcResponse } from "../lib/mcp-transport.js";
import { readTextBody } from "../lib/request-body.js";
import { sameSecret } from "../lib/secret.js";
import type { AppBindings } from "../lib/types.js";
import { JSON_BODY_BYTES, MANAGEMENT_OUTPUT_SCHEMA_BODY_BYTES } from "../limits.js";
import { serviceAccountScope } from "../middlewares/service-account.js";
import { METRICS_TOOL_RESULT_BYTES, record, redactLiteral, TAKT_RESULT_CHARS, text } from "./common.js";
import { managementSchemas } from "./schemas.js";
import { ManagementOutcomeUnknownError } from "./skill.js";
import { callTool } from "./tools.js";
import { ManagementReconciliationUnknownError } from "./runs.js";
import { MANAGEMENT_TRAJECTORY_PATH, streamTrajectory } from "./trajectory.js";
import { MANAGEMENT_DOCUMENT_PATH, streamDocument } from "./documents.js";

export const EVAL_MANAGEMENT_MCP_PATH = "/mcp/eval-management";
const SERVER = { name: "eval-platform-eval-management", version: "1.0.0" };
const DESCRIPTIONS: Record<keyof typeof managementSchemas, string> = {
  list_options: "Page Agent/Dataset/Project/Schema choices. dataset_data(datasetId) returns up to 20 safe Data IDs/names per page, adapting displayed names to the 4,800-byte limit without dropping IDs; order:upload is proven original membership, order:unknown never identifies row 1. dataset_data_resources(datasetId,dataId) reads a current member's stored Material/Session UUID bindings in original field/index order, at most 20 refs per page, with counts and a complete bindingDigest shared across pages (not the full Data approval digest). Soft-deleted refs remain listed; check materials/sessions directories for availability. No prompts, raw bytes or URLs. material_bundles/session_bundles, materials/sessions(bundleId), and material_files/session_files(bundleId,materialId|sessionId) return at most five owner-scoped active metadata items, never file bytes or URLs. project_detail reads the frozen plan's Schema ID. output_schema_detail reads the active catalog; project_schema_detail(projectId) reads the owned, digest-checked frozen Project Schema even after catalog deletion. Small JSON uses schemaOffset; streamRequired:true needs the fixed authenticated documents GET (kind=project_schema for Projects). Verify the displayed SHA-256 and Project Schema ID/digest; source redactions are explicit.",
  save_initial_resource: "Persist one staged owned Material (no format) or Session (json/jsonl format required) as an independent Bundle and child, without Dataset, Data or Prompt. Only a confirmed save returns the Bundle and Material/Session UUIDs. Reconcile an unknown result with the original operationKey/get_preparation; never retry an uncertain write under a new key.",
  prepare_inputs: "Import an uploaded Prompt JSON/JSONL as a new Dataset with up to 50 cases. Cases bind only existing owned Material/Session UUID references; save resources independently first. Reuse operationKey after an unknown result; never creates a Bundle or starts a Run.",
  bind_data_resources: "Bind only existing owned Material/Session UUIDs to one Dataset member (legacy single input) or 1–20 distinct members in one atomic transaction (bindings array). Supply each original full Data contentDigest and at least one field; an already-satisfied member is valid, even if all are satisfied. The same Material can serve multiple Data and both Material fields, with multiple distinct Materials per field. Null clears, omission preserves. Reuse operationKey and get_preparation after a lost response; never retry uncertain writes under a new key. EP does not approve bindings.",
  get_preparation: "Read bounded durable progress, identities and real stage/status by operationKey, including initial_resource pending/attempted/confirmed; only final confirmation is completed. No prompt, Schema content, uploadRef, bytes or attachment URL. Also reports uncertain Skill/Reference/Schema writes.",
  search_agent_resources: "Search live Eval SP resources. Actions need supplierId or unassigned:true; use action_groups first. id reads an Action or Reference. Toolkit pages use cursor, not page. Never returns connection credentials.",
  upload_agent_skill: "Upload a staged ZIP through SP's public Skill library. Explicit user approval for possible same-name overwrite is required by the trusted adapter; existingSkillId must match if one exists. Unknown SP writes are never repeated.",
  upload_agent_reference: "Upload one staged file as a public SP attachment, then create a Reference. Unknown writes are not blindly replayed or cleaned up; use get_preparation.",
  create_output_schema: "Create an output JSON Schema from trusted backend-sent content, never model context. Reuse operationKey after an unknown result; distinct keys may share names, so use the receipt ID. Returns only Schema ID/name.",
  create_agent: "Create an execution or evaluation Agent from SP's default template and verified resources. Reuse operationKey after an unknown result.",
  create_project: "Create a Project and start its first Run under one durable idempotencyKey. The trusted adapter supplies approved Dataset/Agent/Schema snapshot digests; changed sources fail closed.",
  preview_run: "Preview up to 50 fixed targets, plan digests and prospective counts; these are not completed scores. Keep both digests, selector and targets for submit_run.",
  submit_run: "Submit the original fixed targets and expected preview plan digests under one Project/idempotencyKey. Runtime verifies both at admission.",
  reconcile_operation: "READ ONLY: look up an already-persisted Run or Project from its original request/key/fingerprint. Run requests may omit expected digests only for old stored Runs. Never starts work.",
  stop_run: "Stop one explicitly identified Run belonging to the specified Project.",
  get_run: "Read Run status and a page of Sampling and Evaluation IDs, without full records.",
  get_metrics: "Read current owner-scoped or exact-Run Metrics. Project/Dataset default section=overview returns compact complete summary with field total but no rows or byTool. section=samples pages existing scoreIndex and navigation; section=tools requires role=execution|evaluation and pages only that role's Metrics-authoritative native byTool rates; section=fields pages countable output fields. Sample/Sampling and sampling+evaluationId keep their existing resultOffset contract; large selected JSON uses the authenticated documents GET.",
  inspect_case: "Inspect bounded evidence and Subject/Evaluator Metrics for one current owned Sampling/Evaluation (or exact Run member). For a complete raw Pi file use the authenticated fixed GET /mcp/eval-management/trajectories from the trusted backend, never an MCP tool.",
  get_case_usage: "READ ONLY: list owned execution/evaluation Attempts, or page one Attempt's models, Action receipts, separate Super Link debit tools, or tool_calls: every observed raw-derived v2 compact Pi Tool Call (free/read-only/status/Super Link/Action, failed/unreturned). toolCalls items give resultState and nullable top-level Pi Tool Result toolDurationMs in ms (zero is real; not Action/provider lifetime); total:null with a present snapshot means native inventory unproven. Action receipts keep authoritative actionId/chargedCredits; actions.toolDurationMs needs a uniquely matched initiating execute_capability or direct action_* Result, never a status-only get_capability_execution. No Super Link debit-to-Pi-Call pairing is claimed. role=execution forbids evaluationId; role=evaluation requires it. Optional runId checks exact original AND current membership. section defaults to attempts; selected sections require attemptId. At most 10 rows, no raw snapshot, account/Chat/Call ID, args or result bodies. Old raw/v1 and missing/partial proof never supply durations.",
};
const TOOLS = (Object.keys(managementSchemas) as (keyof typeof managementSchemas)[]).map((name) => ({
  name, description: DESCRIPTIONS[name],
  inputSchema: z.toJSONSchema(managementSchemas[name],
    { target: "draft-07", io: "input", unrepresentable: "any" }),
}));

const count = (value: unknown): number | null => {
  const n = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
};
/** PostgreSQL returns JSON number scalars as canonical decimal text, never a
 * provider/event string; keep the second read boundary strict as well. */
const piMilliseconds = (value: unknown): number | null => {
  const n = typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/u.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const usd = (value: unknown): number | null => {
  const n = typeof value === "string" && /^[0-9.eE+-]{1,32}$/u.test(value) ? Number(value) : null;
  return n !== null && Number.isFinite(n) && n >= 0 ? n : null;
};
/** The public SP receipt permits non-integer chargedCredits; do not round an
 * observed debit or reprice it from model/Tool usage. */
const ledgerCredits = (value: unknown): number | null => {
  const n = typeof value === "number" ? value
    : typeof value === "string" && /^[0-9.eE+-]{1,32}$/u.test(value) ? Number(value) : null;
  return n !== null && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
};
/** No partial credential, URL or arbitrary source label can become an identity. */
const safeId = (value: unknown, length = 128): string | null =>
  typeof value === "string" && value.length <= length && /^[\w.:-]+$/u.test(value)
    && !redactLiteral(value).redacted ? value : null;
/** Ledger IDs only cross the model boundary as complete, bounded identifiers,
 * not as arbitrary SP-authored strings, private text or truncated prefixes. */
const safeLedgerId = (value: unknown): string | null =>
  typeof value === "string" && value.length <= 128
    && /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/u.test(value)
    && !/(?:^|[_.:-])(?:secret|token|password|api[_-]?key|bearer|credential|authorization|private|prompt)(?:$|[_.:-])/iu.test(value)
    && !/^(?:sk-|key_|ghp_|glpat-|xox[baprs]-)/iu.test(value)
    && !redactLiteral(value).redacted ? value : null;
/** The public SP Action catalog uses action.* IDs; UUID-shaped IDs are also
 * harmless to display. Anything else stays unavailable rather than leaking. */
const safeActionId = (value: unknown): string | null => {
  const id = safeLedgerId(value);
  return id !== null && (/^action\.[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) ? id : null;
};
const safeLabel = (value: unknown): string | null =>
  typeof value === "string" && value.length <= 96 && /^[\w .:/+-]+$/u.test(value)
    && !redactLiteral(value).redacted ? value : null;
const safeToolDisplayName = (value: unknown): string | null =>
  typeof value === "string" && value.length <= 96 && /^[A-Za-z_][A-Za-z0-9_./:-]*$/u.test(value)
    && !/(?:^|[_.:/-])(?:secret|token|password|api[_-]?key|bearer|private|prompt|credential|authorization)(?:$|[_.:/-])/iu.test(value)
    && !/^(?:sk-|key_|bearer|ghp_|glpat-|xox[baprs]-)/iu.test(value)
    && !redactLiteral(value).redacted ? value : null;
const coverage = (value: unknown): "complete" | "partial" | "unavailable" =>
  value === "complete" || value === "partial" ? value : "unavailable";
const attemptView = (raw: unknown) => {
  const row = record(raw) ?? {};
  const state = row.resourcesStatus === "collected" || row.resourcesStatus === "pending"
    || row.resourcesStatus === "failed" ? row.resourcesStatus : "unavailable";
  return {
    attemptId: safeId(row.attemptId, 512), attemptNumber: count(row.attemptNumber),
    status: ["queued", "running", "completed", "failed", "interrupted", "cancelled"].includes(String(row.status))
      ? row.status : null,
    resources: {
      status: state, finalized: state === "collected" ? row.finalized === "true" ? true
        : row.finalized === "false" ? false : null : null,
      coverage: {
        usageEvents: state === "collected" ? coverage(row.usageCoverage) : "unavailable",
        nativeRecords: state === "collected" ? coverage(row.nativeCoverage) : "unavailable",
        billingSettlements: state === "collected" ? coverage(row.billingCoverage) : "unavailable",
      },
      actionCharges: {
        complete: state === "collected" ? row.actionsComplete === "true" ? true
          : row.actionsComplete === "false" ? false : null : null,
        unsettledExecutions: state === "collected" ? count(row.unsettledExecutions) : null,
        missingExecutionIds: state === "collected" ? count(row.missingExecutionIds) : null,
      },
    },
  };
};

/** A single line is not a cross-Attempt aggregate: source coverage remains visible separately. */
function modelLine(raw: unknown, usageCoverage: "complete" | "partial" | "unavailable") {
  const row = record(raw) ?? {};
  const tokens = {
    input: count(row.inputTokens), output: count(row.outputTokens),
    cacheRead: count(row.cacheReadTokens), cacheWrite: count(row.cacheWriteTokens),
    reasoning: count(row.reasoningTokens),
    total: count(row.totalTokens),
  };
  if (tokens.total === null && tokens.input !== null && tokens.output !== null
    && tokens.cacheRead !== null && tokens.cacheWrite !== null) {
    tokens.total = count(tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite);
  }
  const denominator = tokens.input !== null && tokens.cacheRead !== null
    ? tokens.input + tokens.cacheRead : null;
  const eventId = safeId(row.eventId);
  const matches = count(row.settlementMatches);
  const status = ["settled", "platform_owned", "anomaly"].includes(String(row.status))
    ? row.status as string : null;
  const amounts = {
    ratedCredits: count(row.ratedUnits), debitedCredits: count(row.debitedUnits),
    shortfallCredits: count(row.shortfallUnits), platformOwnedCredits: count(row.platformOwnedUnits),
  };
  const state = count(row.usageMatches) !== 1 || eventId === null ? "ambiguous"
    : matches === 0 ? "missing"
      : matches !== 1 || row.accountPresent !== true ? "ambiguous"
        : status === null ? "unsettled"
          : status === "anomaly" || Object.values(amounts).some((amount) => amount === null) ? "partial" : "settled";
  const confirmedAmounts = status !== "anomaly" && (state === "settled" || state === "partial");
  return {
    index: count(row.index), eventId,
    kind: ["assistant_model", "compaction", "subagent", "chat_title"].includes(String(row.kind)) ? row.kind : null,
    provider: safeLabel(row.provider), model: safeLabel(row.model), tokens,
    cacheHitRate: { value: denominator !== null && Number.isSafeInteger(denominator) && denominator > 0
      ? tokens.cacheRead! / denominator : null,
      coverage: denominator === null || !Number.isSafeInteger(denominator) ? "unavailable" : usageCoverage },
    providerUsdEstimate: usd(row.providerUsd),
    modelSettlement: {
      state, status: state === "settled" || state === "partial" ? status : null,
      ratedCredits: confirmedAmounts ? amounts.ratedCredits : null,
      debitedCredits: confirmedAmounts ? amounts.debitedCredits : null,
      shortfallCredits: confirmedAmounts ? amounts.shortfallCredits : null,
      platformOwnedCredits: confirmedAmounts ? amounts.platformOwnedCredits : null,
    },
  };
}

/** Only one source-specific terminal SP receipt proves a charge. Neither model
 * usage nor raw Pi can supply an Action/Tool amount. */
function ledgerCharge(row: Record<string, unknown>) {
  const executionId = safeLedgerId(row.executionId);
  const status = ["succeeded", "failed", "outcome_unknown", "running"].includes(String(row.status))
    ? row.status : null;
  const charge = ledgerCredits(row.chargedCredits);
  const executionMatches = count(row.executionMatches);
  const observed = executionId !== null && executionMatches === 1
    && (status === "succeeded" || status === "failed"
      || status === "outcome_unknown" && charge === 0) && charge !== null;
  return {
    index: count(row.index), executionId, status, chargedCredits: observed ? charge : null,
    chargeState: observed ? "observed" : "unconfirmed",
  };
}

/** The receipt's actionId is authoritative for Action identity. Raw Pi can
 * independently describe a uniquely correlated Tool, but cannot name an Action. */
function actionLine(raw: unknown, nativeCoverage: "complete" | "partial" | "unavailable") {
  const row = record(raw) ?? {};
  if (row.billingSource !== "action") throw new HttpError("RESPONSE_INVALID");
  const charge = ledgerCharge(row);
  const executionMatches = count(row.executionMatches);
  const actionId = safeActionId(row.actionId);
  const actionIdentityState = charge.executionId === null || executionMatches === null
    ? "unavailable" : executionMatches !== 1
      ? "ambiguous" : actionId !== null
        ? "identified" : row.actionIdPresent === true || row.actionId != null
          ? "unsafe" : "missing";
  const linkMatches = count(row.linkMatches);
  const toolName = safeToolDisplayName(row.toolName);
  const calls = count(row.toolCallMatches);
  const namedCalls = count(row.namedToolCallMatches);
  const resultCalls = count(row.resultCallMatches);
  let toolMatchState: "matched" | "ambiguous" | "unavailable" | "unknown" = "unavailable";
  if (charge.executionId !== null && executionMatches !== null) {
    if (executionMatches !== 1 || linkMatches !== null && linkMatches > 1) toolMatchState = "ambiguous";
    else if (row.legacyCompact === true || nativeCoverage !== "complete") {
      // Old raw/v1 facts and a partial source cannot prove Tool uniqueness.
      toolMatchState = "unknown";
    } else if (linkMatches === 1 && toolName !== null
      && calls !== null && calls !== 0 && namedCalls !== null && resultCalls !== null) {
      toolMatchState = calls === 1 && namedCalls === 1 && resultCalls === 1 ? "matched" : "ambiguous";
    }
  }
  return {
    ...charge, source: "action" as const,
    actionId: actionIdentityState === "identified" ? actionId : null, actionIdentityState,
    toolName: toolMatchState === "matched" ? toolName : null, toolMatchState,
    toolDurationMs: toolMatchState === "matched"
      && (toolName === "execute_capability" || toolName !== null
        && toolName.startsWith("action_") && toolName.length > "action_".length)
      && (row.resultStatus === "completed" || row.resultStatus === "failed")
      ? piMilliseconds(row.toolDurationMs) : null,
  };
}

/** Tool calls, including unbilled and status-only ones, are not ledger entries. */
function toolCallLine(raw: unknown, completeInventory: boolean) {
  const row = record(raw) ?? {};
  const toolName = safeToolDisplayName(row.toolName);
  const calls = count(row.toolCallMatches);
  const results = count(row.resultCallMatches);
  const namedResults = count(row.namedResultMatches);
  let resultState: "completed" | "failed" | "missing" | "ambiguous" | "unknown" = "unknown";
  if (calls !== null && calls > 1 || results !== null && results > 1
    || results === 1 && namedResults !== null && namedResults !== 1) {
    resultState = "ambiguous";
  } else if (completeInventory && toolName !== null && calls === 1 && results !== null) {
    if (results === 0) resultState = "missing";
    else if (namedResults === 1 && (row.resultStatus === "completed" || row.resultStatus === "failed")) {
      resultState = row.resultStatus;
    }
  }
  return {
    index: count(row.index), toolName,
    toolDurationMs: resultState === "completed" || resultState === "failed" ? piMilliseconds(row.toolDurationMs) : null,
    resultState,
  };
}

/** Super Link Tool debits are real ledger charges, but never SP Actions. */
function toolLine(raw: unknown) {
  const row = record(raw) ?? {};
  if (row.billingSource !== "tool") throw new HttpError("RESPONSE_INVALID");
  return { ...ledgerCharge(row), source: "tool" as const };
}

async function getCaseUsage(c: Context<AppBindings>, input: z.output<typeof managementSchemas.get_case_usage>) {
  const { projectId, samplingId, role, evaluationId, runId, section, page, pageSize } = input;
  // Do not hydrate a Metrics detail, observation stage or entire Run to authorize one page:
  // the owner/current/role/original-Run joins are checked with the projection in one read-only DB snapshot.
  const projection = await c.var.services.resourceSnapshots.readCaseUsage(input);
  if (!Array.isArray(projection.rows) || projection.rows.length > pageSize
    || projection.total !== null && count(projection.total) === null) throw new HttpError("RESPONSE_INVALID");
  const base = { projectId, samplingId, role, ...(evaluationId === undefined ? {} : { evaluationId }),
    ...(runId === undefined ? { runScope: "project_current" } : { runScope: "exact_run", runId }), section };
  if (section === "attempts") return { ...base,
    attempts: { page, pageSize, total: projection.total, items: projection.rows.map(attemptView) } };
  if (!projection.attempt) throw new HttpError("RESPONSE_INVALID");
  const attempt = attemptView(projection.attempt);
  const availability = attempt.resources.status !== "collected" ? "not_collected"
    : section === "tool_calls" ? projection.snapshotPresent === true ? "available" : "snapshot_missing"
      : projection.total === null ? "snapshot_missing" : "available";
  if (section === "actions" && availability === "available") {
    const items = projection.rows.map((row) => actionLine(row, attempt.resources.coverage.nativeRecords));
    return { ...base, attempt, availability, actions: { page, pageSize, total: projection.total, items } };
  }
  if (section === "tool_calls" && availability === "available") {
    const items = projection.rows.map((row) => toolCallLine(row, projection.total !== null
      && attempt.resources.coverage.nativeRecords === "complete"));
    return { ...base, attempt, availability, toolCalls: { page, pageSize, total: projection.total, items } };
  }
  if (section === "tools" && availability === "available") {
    const items = projection.rows.map(toolLine);
    return { ...base, attempt, availability, tools: { page, pageSize, total: projection.total, items } };
  }
  const items = availability !== "available" ? [] : section === "models"
    ? projection.rows.map((row) => modelLine(row, attempt.resources.coverage.usageEvents)) : [];
  return { ...base, attempt, availability,
    [section === "tool_calls" ? "toolCalls" : section]:
      { page, pageSize, total: availability === "available" ? projection.total : null, items } };
}

function toolFailure(error: unknown) {
  if (error instanceof ManagementOutcomeUnknownError) {
    return "OPERATION_OUTCOME_UNKNOWN: Check get_preparation with the original operationKey. Do not retry under a new key.";
  }
  if (error instanceof ManagementReconciliationUnknownError) {
    return "OPERATION_OUTCOME_UNKNOWN: Project exists without its confirmed first Run. Reconcile manually before any new write.";
  }
  if (error instanceof z.ZodError) return "REQUEST_INVALID_INPUT: Check the tool's input schema.";
  const { code } = apiError(error instanceof Error ? error : new Error("Unknown tool failure"));
  const guidance = code === "CATALOG_PAYLOAD_TOO_LARGE" ? "Choose a smaller page, file or narrower scope."
    : code === "RUN_TARGETS_TOO_LARGE" ? "Narrow the selector to at most 50 fixed targets."
      : code.endsWith("_NOT_FOUND") ? "The requested resource is not available to this account."
        : code.endsWith("_CONFLICT") || code === "PROJECT_BUSY" ? "The requested facts conflict with current state."
          : "The operation could not be completed.";
  // apiError may carry SP or DB diagnostics in its *message*; only the public code is model-visible.
  return `${code}: ${guidance}`;
}

async function handle(c: Context<AppBindings>, message: Record<string, unknown>): Promise<McpRpcResponse | null> {
  const id = message.id;
  // Notifications never execute tools, including writes.
  if (id === undefined || id === null) return null;
  if (typeof id !== "string" && typeof id !== "number") return mcpError(null, -32600, "Invalid Request");
  if (typeof id === "string" && id.length > 128 || typeof id === "number" && !Number.isSafeInteger(id)) {
    return mcpError(null, -32600, "Invalid Request");
  }
  const params = message.params !== null && typeof message.params === "object" && !Array.isArray(message.params)
    ? message.params as Record<string, unknown> : {};
  return dispatchMcp(message.method, id, params, {
    serverInfo: SERVER,
    tools: TOOLS,
    callTool: async (id, params) => {
      const name = params.name;
      if (typeof name !== "string" || !Object.hasOwn(managementSchemas, name)) {
        return mcpError(id, -32602, "Unknown tool");
      }
      try {
        // This read is bound to the common authenticated tools/call seam; no raw snapshot or bulk GET enters it.
        const result = name === "get_case_usage"
          ? await getCaseUsage(c, managementSchemas.get_case_usage.parse(params.arguments))
          : await callTool(c, name as keyof typeof managementSchemas, params.arguments);
        // Other tools retain the MCP limit; trusted Takt alone handles large Metrics results.
        const category = record(result)?.category;
        const kind = record(result)?.kind;
        const metrics = name === "get_metrics";
        const smallCatalog = name === "list_options"
          && (category === "dataset_data" || category === "dataset_data_resources"
            || category === "output_schemas" || category === "output_schema_detail"
            || category === "project_schema_detail" || category === "material_bundles" || category === "session_bundles"
            || category === "materials" || category === "sessions" || category === "material_files"
            || category === "session_files");
        const smallBinding = name === "bind_data_resources" || name === "get_preparation" && kind === "bind";
        return mcpResult(id, { content: [{ type: "text", text: text(result,
          metrics ? METRICS_TOOL_RESULT_BYTES : smallCatalog || smallBinding ? TAKT_RESULT_CHARS : Infinity,
          metrics ? METRICS_TOOL_RESULT_BYTES : undefined) }] });
      } catch (error) {
        return mcpResult(id, { content: [{ type: "text", text: toolFailure(error) }], isError: true });
      }
    },
    methodNotFound: () => "Method not found",
  });
}

const router = createRouter();

/** Every management endpoint authenticates *before* leasing the fixed owner or reading a byte. */
export const managementBearer: MiddlewareHandler<AppBindings> = async (c, next) => {
  c.header("Cache-Control", "no-store");
  const management = c.env.evalManagement;
  if (!management) return c.json({ error: "Not found" }, 404);
  const bearer = c.req.header("authorization") ?? "";
  if (!bearer.startsWith("Bearer ") || !sameSecret(management.token, bearer.slice(7))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
};

router.post(EVAL_MANAGEMENT_MCP_PATH, managementBearer, serviceAccountScope, async (c) => {
  if (!/^application\/json(?:\s*;|$)/iu.test(c.req.header("content-type") ?? "")) {
    return c.json(mcpError(null, -32600, "Content-Type must be application/json"), 415);
  }
  let message: unknown;
  try {
    const textBody = await readTextBody(c.req.raw, MANAGEMENT_OUTPUT_SCHEMA_BODY_BYTES);
    message = parseStrictJson(textBody);
    // The larger escaped-JSON allowance is *only* for the trusted Schema tool.
    // Other RPC requests retain their original one-megabyte ingress bound.
    if (Buffer.byteLength(textBody, "utf8") > JSON_BODY_BYTES
      && (message === null || typeof message !== "object" || Array.isArray(message)
        || (message as { method?: unknown }).method !== "tools/call"
        || (message as { params?: { name?: unknown } }).params?.name !== "create_output_schema")) {
      throw new HttpError("REQUEST_PAYLOAD_TOO_LARGE", "Management request is too large");
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return c.json(mcpError(null, -32700, "Parse error"), 400);
  }
  if (!isMcpRequest(message)) {
    return c.json(mcpError(null, -32600, "Invalid Request"), 400);
  }
  const response = await handle(c, message);
  return response === null ? c.body(null, 202) : c.json(response);
});

router.get(MANAGEMENT_TRAJECTORY_PATH, managementBearer, serviceAccountScope, streamTrajectory);
for (const method of ["post", "delete", "put", "patch"] as const) {
  router[method](MANAGEMENT_TRAJECTORY_PATH, (c) => {
    c.header("Cache-Control", "no-store");
    if (!c.env.evalManagement) return c.json({ error: "Not found" }, 404);
    c.header("Allow", "GET");
    return c.json({ error: "Method not allowed" }, 405);
  });
}

router.get(MANAGEMENT_DOCUMENT_PATH, managementBearer, serviceAccountScope, streamDocument);
for (const method of ["post", "delete", "put", "patch"] as const) {
  router[method](MANAGEMENT_DOCUMENT_PATH, (c) => {
    c.header("Cache-Control", "no-store");
    if (!c.env.evalManagement) return c.json({ error: "Not found" }, 404);
    c.header("Allow", "GET");
    return c.json({ error: "Method not allowed" }, 405);
  });
}

for (const method of ["get", "delete", "put", "patch"] as const) {
  router[method](EVAL_MANAGEMENT_MCP_PATH, (c) => {
    c.header("Cache-Control", "no-store");
    if (!c.env.evalManagement) return c.json({ error: "Not found" }, 404);
    c.header("Allow", "POST");
    return c.json({ error: "Method not allowed" }, 405);
  });
}

export default router;
