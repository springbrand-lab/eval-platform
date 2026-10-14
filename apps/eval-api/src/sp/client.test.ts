import { describe, expect, it, vi } from "vitest";
import { createEvalSpClient, EvalSpApiError, EvalSpTransportError } from "./client.js";

const response = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
  status,
  headers: { "Content-Type": "application/json" },
});

describe("Eval SP public API client", () => {
  it("checks an active Bearer session with SP on every call and does not turn outages into 401", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { success: true, msg: { user: { id: "user-1", role: "admin" } } }))
      .mockResolvedValueOnce(response(401, { code: "AUTH_UNAUTHENTICATED" }))
      .mockResolvedValueOnce(response(503, { code: "DATABASE_UNAVAILABLE" }));
    const client = createEvalSpClient({ origin: "https://eval-sp.example.test", writeOrigin: "https://eval-web.example.test", fetch: fetcher });

    await expect(client.verifySession("session-token")).resolves.toEqual({ id: "user-1", role: "admin" });
    await expect(client.verifySession("session-token")).resolves.toBeNull();
    await expect(client.verifySession("session-token")).rejects.toMatchObject({
      name: "EvalSpApiError", status: 503,
    } satisfies Partial<EvalSpApiError>);
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).toBe("https://eval-sp.example.test/api/auth/me");
      expect(init).toMatchObject({
        method: "GET", redirect: "error", credentials: "omit",
        headers: { Authorization: "Bearer session-token" },
      });
    }
  });

  it("uses only Eval SP Agent Config endpoints with the caller's Bearer token", async () => {
    const config = { id: "agent-1", user_id: "user-1", name: "Judge", revision: 1 };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { success: true, msg: [config] }))
      .mockResolvedValueOnce(response(200, { success: true, msg: config }))
      .mockResolvedValueOnce(response(200, { success: true, msg: config }))
      .mockResolvedValueOnce(response(200, { success: true, msg: config }))
      .mockResolvedValueOnce(response(200, { success: true, msg: { id: "agent-1" } }));
    const client = createEvalSpClient({ origin: "https://eval-sp.example.test", writeOrigin: "https://eval-web.example.test", fetch: fetcher });

    await expect(client.listAgentConfigs("token")).resolves.toEqual([config]);
    await expect(client.getAgentConfig("token", "agent-1")).resolves.toEqual(config);
    await expect(client.createAgentConfig("token", { name: "Judge" })).resolves.toEqual(config);
    await expect(client.updateAgentConfig("token", "agent-1", { revision: 1, name: "Judge" })).resolves.toEqual(config);
    await expect(client.deleteAgentConfig("token", "agent-1")).resolves.toEqual({ id: "agent-1" });

    expect(fetcher.mock.calls.map(([url, init]) => [new URL(String(url)).pathname, init.method])).toEqual([
      ["/api/user-agent-configs", "GET"],
      ["/api/user-agent-configs/agent-1", "GET"],
      ["/api/user-agent-configs", "POST"],
      ["/api/user-agent-configs/agent-1", "PATCH"],
      ["/api/user-agent-configs/agent-1", "DELETE"],
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init.headers.Authorization).toBe("Bearer token");
      expect(init.credentials).toBe("omit");
      expect(init.headers.Origin).toBe(init.method === "GET" ? undefined : "https://eval-web.example.test");
    }
  });

  it("rejects an invalid SP origin or malformed trusted identity", async () => {
    expect(() => createEvalSpClient({ origin: "https://eval-sp.example.test/other", writeOrigin: "https://eval-web.example.test" })).toThrow();
    expect(() => createEvalSpClient({ origin: "https://eval-sp.example.test", writeOrigin: "https://eval-web.example.test/other" })).toThrow();
    const client = createEvalSpClient({
      origin: "https://eval-sp.example.test",
      writeOrigin: "https://eval-web.example.test",
      fetch: vi.fn(async () => response(200, { success: true, msg: { user: { id: "user-1" } } })),
    });
    await expect(client.verifySession("token")).rejects.toThrow("invalid user identity");
  });

  it("distinguishes an unavailable SP connection from invalid caller input", async () => {
    const client = createEvalSpClient({
      origin: "https://eval-sp.example.test",
      writeOrigin: "https://eval-web.example.test",
      fetch: vi.fn(async () => { throw new TypeError("fetch failed"); }),
    });
    await expect(client.verifySession("token")).rejects.toBeInstanceOf(EvalSpTransportError);
  });
});
