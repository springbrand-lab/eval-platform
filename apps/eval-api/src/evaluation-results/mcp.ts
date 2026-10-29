import { EVALUATION_OUTPUT_SCHEMA_PATH, EVALUATION_SUBMIT_TOOL } from "@eval-platform/eval-contracts";
import { retryIdempotentOperation } from "@eval-platform/eval-runtime";
import type { Context } from "hono";
import { createRouter } from "../lib/create-app.js";
import { dispatchMcp, isMcpRequest, mcpError, mcpResult, type McpRpcId, type McpRpcResponse } from "../lib/mcp-transport.js";
import { sameSecret } from "../lib/secret.js";
import type { AppBindings } from "../lib/types.js";
import { createEvaluationResultCheck, verifyEvaluationSubmitToken } from "./submission.js";

/**
 * Stateless Streamable HTTP MCP Server with one tool, `submit_evaluation`. Eval SP loads it as a
 * user MCP Server selected by the Evaluator's Agent Config; see docs/eval-evaluation-result-submission.md.
 */
export const EVALUATION_RESULTS_MCP_PATH = "/mcp/evaluation-results";

const SERVER_INFO = { name: "eval-platform-evaluation-results", version: "1.0.0" };

/** Never changes at runtime: SP rejects a call whose tool definition differs from the one it discovered. */
const SUBMIT_TOOL = {
  name: EVALUATION_SUBMIT_TOOL,
  title: "Submit evaluation result",
  description: `Submit your final evaluation result directly to Eval Platform through this MCP tool. Call this MCP tool directly once you have finished evaluating; do not invoke it through codemode or the execution tool. Use the evaluationId and submitToken from your instructions and pass the result as one JSON object following ${EVALUATION_OUTPUT_SCHEMA_PATH}. If the result is rejected, the response lists what to correct; fix it and call this MCP tool again without re-evaluating.`,
  inputSchema: {
    type: "object",
    properties: {
      evaluationId: { type: "string", description: "The evaluationId given in your instructions." },
      submitToken: { type: "string", description: "The submitToken given in your instructions." },
      result: { type: "object", description: `Your evaluation result, following ${EVALUATION_OUTPUT_SCHEMA_PATH}.` },
    },
    required: ["evaluationId", "submitToken", "result"],
    additionalProperties: false,
  },
} as const;

const toolText = (text: string, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

const check = createEvaluationResultCheck();

async function submit(c: Context<AppBindings>, args: unknown) {
  const results = c.env.evaluationResults!;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return toolText("Arguments must be an object with evaluationId, submitToken and result.", true);
  const { evaluationId, submitToken, result } = args as Record<string, unknown>;
  if (typeof evaluationId !== "string" || typeof submitToken !== "string") return toolText("evaluationId and submitToken must be the strings given in your instructions.", true);
  if (!verifyEvaluationSubmitToken(results.token, evaluationId, submitToken)) return toolText("evaluationId and submitToken do not match. Use the exact values from your instructions.", true);
  const target = await results.submissions.target(evaluationId);
  if (!target) return toolText(`Evaluation ${evaluationId} does not exist.`, true);
  if (!target.schema) return toolText(`Evaluation ${evaluationId} has no output Schema; the result was not accepted.`, true);
  // Models sometimes pass the object as JSON text; anything else is checked as given.
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      // Left as a string; the Schema check reports it.
    }
  }
  if (value === undefined) return toolText("result is required.", true);
  const content = JSON.stringify(value);
  const verdict = check(target.schema, content);
  if (!verdict.valid) {
    return toolText(`The result does not match ${EVALUATION_OUTPUT_SCHEMA_PATH} and was not accepted. Correct these and call ${EVALUATION_SUBMIT_TOOL} again:\n${verdict.errors.map((error) => `- ${error}`).join("\n")}`, true);
  }
  const submission = { evaluationId, ownerUserId: target.ownerUserId, content, submittedAt: new Date() };
  const receipt = await retryIdempotentOperation({
    operation: "persistence",
    run: () => results.submissions.save(submission),
  });
  if (receipt === "closed") return toolText(`Evaluation ${evaluationId} is stopped, cancelled, replaced or unavailable; the result was not accepted.`, true);
  if (receipt === "conflict") return toolText(`Evaluation ${evaluationId} already has an accepted result; a different result cannot replace it.`, true);
  c.var.logger?.info({ event: "evaluation_result_submitted", evaluationId }, "Evaluation result submitted");
  return toolText("Evaluation result accepted. You are done; end with a short summary.");
}

async function handle(c: Context<AppBindings>, message: Record<string, unknown>): Promise<McpRpcResponse | null> {
  const id = message.id as McpRpcId | undefined;
  // Notifications (no id) get no response.
  if (id === undefined || id === null) return null;
  const params = (typeof message.params === "object" && message.params !== null ? message.params : {}) as Record<string, unknown>;
  return dispatchMcp(message.method, id, params, {
    serverInfo: SERVER_INFO,
    tools: [SUBMIT_TOOL],
    callTool: async (id, params) => {
      if (params.name !== EVALUATION_SUBMIT_TOOL) return mcpError(id, -32602, `Unknown tool: ${String(params.name)}`);
      return mcpResult(id, await submit(c, params.arguments));
    },
    methodNotFound: (method) => `Method not found: ${String(method)}`,
  });
}

const router = createRouter();

router.post(EVALUATION_RESULTS_MCP_PATH, async (c) => {
  const results = c.env.evaluationResults;
  if (!results) return c.json({ error: "Not found" }, 404);
  const authorization = c.req.header("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || !sameSecret(results.token, authorization.slice("Bearer ".length))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  let message: unknown;
  try {
    message = await c.req.json();
  } catch {
    return c.json(mcpError(null, -32700, "Parse error"), 400);
  }
  if (!isMcpRequest(message)) {
    return c.json(mcpError(null, -32600, "Invalid Request"), 400);
  }
  const response = await handle(c, message);
  if (response === null) return c.body(null, 202);
  return c.json(response);
});

for (const method of ["get", "delete"] as const) {
  router[method](EVALUATION_RESULTS_MCP_PATH, (c) => {
    c.header("Allow", "POST");
    return c.json({ error: "Method not allowed" }, 405);
  });
}

export default router;
