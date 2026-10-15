import pino from "pino";
import { describe, expect, it } from "vitest";
import { createRoutes } from "../app.js";
import type { ApiRuntime, OwnerServices } from "../lib/types.js";
import type { EvalSpClient } from "../sp/client.js";
import { loggerOptions } from "./pino-logger.js";

describe("request logging", () => {
  it("logs one diagnostic line per failed request without credentials or raw messages", async () => {
    const lines: string[] = [];
    const logger = pino(loggerOptions, { write: (line) => lines.push(line) });
    const services = { results: { async getRun() { throw new Error("leaked token=private-token"); } } };
    const runtime: ApiRuntime = {
      webOrigin: "https://eval-web.test",
      sp: {} as EvalSpClient,
      serviceAccount: { user: { id: "user-1", role: "user" }, sessionToken: "private-service-token" },
      ownerServices: () => ({ services: services as unknown as OwnerServices, release() {} }),
    };
    const response = await createRoutes(logger).request("/api/runs/run-1", {
      headers: { Authorization: "Bearer private-bearer" },
    }, runtime);
    expect(response.status).toBe(500);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: 50, status: 500, method: "GET", path: "/api/runs/run-1",
      reqId: response.headers.get("x-request-id"),
      error: { name: "HttpError", cause: { name: "Error", stack: expect.any(String) } },
    });
    expect(lines[0]).not.toContain("private-token");
    expect(lines[0]).not.toContain("private-bearer");
    expect(lines[0]).not.toContain("private-service-token");
  });
});
