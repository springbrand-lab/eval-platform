import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import type { IndependentEvaluationApi } from "./independent-evaluation-api.js";

/** A Node HTTP transport for the independent-evaluation Fetch handler. The caller owns listen/close. */
export function createIndependentEvaluationHttpServer(api: IndependentEvaluationApi): Server {
  return createServer(async (incoming, outgoing) => {
    try {
      const target = incoming.url ?? "";
      if (!target.startsWith("/")) {
        outgoing.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        outgoing.end(JSON.stringify({ error: { code: "INVALID_REQUEST", message: "Invalid request target" } }));
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
        else if (value !== undefined) headers.set(name, value);
      }
      const method = incoming.method ?? "GET";
      const hasBody = method !== "GET" && method !== "HEAD";
      const request = new Request(new URL(target, "http://localhost"), {
        method,
        headers,
        ...(hasBody ? { body: Readable.toWeb(incoming), duplex: "half" as const } : {}),
      } as RequestInit & { duplex?: "half" });
      const response = await api.handle(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (outgoing.headersSent) {
        outgoing.destroy(error instanceof Error ? error : undefined);
        return;
      }
      outgoing.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      outgoing.end(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Evaluation API request failed" } }));
    }
  });
}
