import { describe, expect, it } from "vitest";
import { startEvalHttpServer } from "./http-server.js";
import { createIndependentEvaluationHttpServer } from "./independent-evaluation-http.js";

describe("Eval Node HTTP transport", () => {
  it("passes the request body and response status through the Fetch handler", async () => {
    const server = await startEvalHttpServer(async (request) => {
      const body = await request.json();
      return Response.json({ method: request.method, body }, { status: 201 });
    }, { host: "127.0.0.1", port: 0 });
    try {
      const address = server.server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const response = await fetch(`http://127.0.0.1:${address.port}/test`, {
        method: "POST", body: JSON.stringify({ value: 1 }),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ method: "POST", body: { value: 1 } });
    } finally {
      await server.close();
    }
  });

  it("keeps each API's internal-error envelope when a handler fails", async () => {
    const full = await startEvalHttpServer(async () => { throw new Error("secret"); }, { host: "127.0.0.1", port: 0 });
    const independent = createIndependentEvaluationHttpServer({ handle: async () => { throw new Error("secret"); } });
    await new Promise<void>((resolve) => independent.listen(0, "127.0.0.1", resolve));
    try {
      const fullAddress = full.server.address();
      const independentAddress = independent.address();
      if (!fullAddress || typeof fullAddress === "string" || !independentAddress || typeof independentAddress === "string") {
        throw new Error("Expected TCP listeners");
      }
      const fullResponse = await fetch(`http://127.0.0.1:${fullAddress.port}/api/me`);
      const independentResponse = await fetch(`http://127.0.0.1:${independentAddress.port}/api/projects/p/evaluations`);
      expect(fullResponse.status).toBe(500);
      expect(await fullResponse.json()).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
      expect(independentResponse.status).toBe(500);
      expect(await independentResponse.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "Evaluation API request failed" } });
    } finally {
      await full.close();
      await new Promise<void>((resolve, reject) => independent.close((error) => error ? reject(error) : resolve()));
    }
  });
});
