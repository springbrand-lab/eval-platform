import type { Server } from "node:http";
import type { IndependentEvaluationApi } from "./independent-evaluation-api.js";
import { createNodeFetchServer } from "./node-fetch-server.js";

/** A Node HTTP transport for the independent-evaluation Fetch handler. The caller owns listen/close. */
export function createIndependentEvaluationHttpServer(api: IndependentEvaluationApi): Server {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  return createNodeFetchServer((request) => api.handle(request), {
    invalidTarget: () => new Response(JSON.stringify({ error: { code: "INVALID_REQUEST", message: "Invalid request target" } }), { status: 400, headers }),
    unexpected: () => new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Evaluation API request failed" } }), { status: 500, headers }),
  });
}
