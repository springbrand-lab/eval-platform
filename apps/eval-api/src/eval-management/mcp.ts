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
import { text } from "./common.js";
import { managementSchemas } from "./schemas.js";
import { ManagementOutcomeUnknownError } from "./skill.js";
import { callTool } from "./tools.js";
import { MANAGEMENT_TRAJECTORY_PATH, streamTrajectory } from "./trajectory.js";

export const EVAL_MANAGEMENT_MCP_PATH = "/mcp/eval-management";
const SERVER = { name: "eval-platform-eval-management", version: "1.0.0" };
const DESCRIPTIONS: Record<keyof typeof managementSchemas, string> = {
  list_options: "Page through Eval Agent, Dataset, Project and output format choices. project_detail with projectId reads the frozen evaluation plan and Schema choice, not results.",
  prepare_inputs: "Prepare a Prompt Dataset from an uploaded JSON/JSONL file and up to 50 per-row Subject/Evaluator resource mappings. Creates Material/Session Bundles separately and binds each Data before any Project can start. Reuse operationKey after an unknown result.",
  get_preparation: "Read bounded durable progress, IDs and stage receipts by operationKey; no prompt, Schema content, bytes or attachment URL. Also reports uncertain Skill/Reference/Schema writes.",
  search_agent_resources: "Search live Eval SP resources. Actions need supplierId or unassigned:true; use action_groups first. id reads an Action or Reference. Toolkit pages use cursor, not page. Never returns connection credentials.",
  upload_agent_skill: "Upload a staged ZIP through SP's public Skill library. Explicit user approval for possible same-name overwrite is required by the trusted adapter; existingSkillId must match if one exists. Unknown SP writes are never repeated.",
  upload_agent_reference: "Upload one staged file as a public SP attachment, then create a Reference. Unknown writes are not blindly replayed or cleaned up; use get_preparation.",
  create_output_schema: "Create an output JSON Schema from trusted backend-sent content, never model context. Reuse operationKey after an unknown result; distinct keys may share names, so use the receipt ID. Returns only Schema ID/name.",
  create_agent: "Create an execution or evaluation Agent from SP's default template and verified resources. Reuse operationKey after an unknown result.",
  create_project: "Create a Project and start its first Run under one durable idempotencyKey. Requires approval in the trusted adapter.",
  preview_run: "Preview up to 50 fixed targets and prospective counts for one existing Project; these are not completed scores. Preserve the selector and targets for submit_run.",
  submit_run: "Submit an existing Project Run with its original selector and up to 50 fixed preview targets, under one idempotencyKey.",
  stop_run: "Stop one explicitly identified Run belonging to the specified Project.",
  get_run: "Read Run status and a page of Sampling and Evaluation IDs, without full records.",
  get_metrics: "Page existing Project/Dataset/Sample/Sampling Metrics and current Sampling/Evaluation IDs without runId, or filter to exact current members of runId. runScope distinguishes them; Subject/Evaluator tool success rates keep Metrics coverage and nulls.",
  inspect_case: "Inspect bounded evidence and Subject/Evaluator Metrics for one current owned Sampling/Evaluation (or exact Run member). For a complete SAFE Pi file use the authenticated fixed GET /mcp/eval-management/trajectories from the trusted backend, never an MCP tool.",
};
const TOOLS = (Object.keys(managementSchemas) as (keyof typeof managementSchemas)[]).map((name) => ({
  name, description: DESCRIPTIONS[name],
  inputSchema: z.toJSONSchema(managementSchemas[name], { target: "draft-07", io: "input", unrepresentable: "any" }),
}));

function toolFailure(error: unknown) {
  if (error instanceof ManagementOutcomeUnknownError) {
    return "OPERATION_OUTCOME_UNKNOWN: Check get_preparation with the original operationKey. Do not retry under a new key.";
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
        const result = await callTool(c, name as keyof typeof managementSchemas, params.arguments);
        return mcpResult(id, { content: [{ type: "text", text: text(result) }] });
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

for (const method of ["get", "delete", "put", "patch"] as const) {
  router[method](EVAL_MANAGEMENT_MCP_PATH, (c) => {
    c.header("Cache-Control", "no-store");
    if (!c.env.evalManagement) return c.json({ error: "Not found" }, 404);
    c.header("Allow", "POST");
    return c.json({ error: "Method not allowed" }, 405);
  });
}

export default router;
