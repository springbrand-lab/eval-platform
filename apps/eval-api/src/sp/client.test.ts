import { describe, expect, it, vi } from "vitest";
import { createEvalSpClient, EvalSpApiError, EvalSpTransportError } from "./client.js";

const ok = (msg: unknown) => Response.json({ success: true, msg, errMsg: "", code: "" });
const failure = (status: number, code: string) => Response.json({ code, errMsg: code }, { status });
const origins = { origin: "https://eval-sp.example.test", writeOrigin: "https://eval-web.example.test" };

function recordingFetch(...responses: Response[]) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return response;
  });
  return { fetch, requests };
}

describe("Eval SP public API client", () => {
  it("checks an active Bearer session with SP on every call and does not turn outages into 401", async () => {
    const { fetch, requests } = recordingFetch(
      ok({ user: { id: "user-1", role: "admin", email: "private" } }),
      failure(401, "AUTH_UNAUTHENTICATED"),
      failure(503, "DATABASE_UNAVAILABLE"),
    );
    const client = createEvalSpClient({ ...origins, fetch });

    await expect(client.verifySession("session-token")).resolves.toEqual({ id: "user-1", role: "admin" });
    await expect(client.verifySession("session-token")).resolves.toBeNull();
    await expect(client.verifySession("session-token")).rejects.toMatchObject({
      name: "EvalSpApiError", status: 503, payload: { code: "DATABASE_UNAVAILABLE" },
    } satisfies Partial<EvalSpApiError>);
    expect(requests.map((request) => [request.method, request.url, request.headers.get("Authorization"),
      request.credentials, request.redirect])).toEqual(Array.from({ length: 3 }, () => [
      "GET", "https://eval-sp.example.test/api/auth/me", "Bearer session-token", "omit", "manual",
    ]));
  });

  it("uses only Eval SP Agent Config endpoints with the caller's Bearer token", async () => {
    const config = { id: "agent-1", user_id: "user-1", name: "Judge", revision: 1 };
    const { fetch, requests } = recordingFetch(ok([config]), ok(config), ok(config), ok(config), ok({ id: "agent-1" }));
    const client = createEvalSpClient({ ...origins, fetch });

    await expect(client.listAgentConfigs("token")).resolves.toEqual([config]);
    await expect(client.getAgentConfig("token", "agent-1")).resolves.toEqual(config);
    await expect(client.createAgentConfig("token", { name: "Judge" })).resolves.toEqual(config);
    await expect(client.updateAgentConfig("token", "agent-1", { revision: 1, name: "Judge" })).resolves.toEqual(config);
    await expect(client.deleteAgentConfig("token", "agent-1")).resolves.toEqual({ id: "agent-1" });

    expect(requests.map((request) => [new URL(request.url).pathname, request.method])).toEqual([
      ["/api/user-agent-configs", "GET"],
      ["/api/user-agent-configs/agent-1", "GET"],
      ["/api/user-agent-configs", "POST"],
      ["/api/user-agent-configs/agent-1", "PATCH"],
      ["/api/user-agent-configs/agent-1", "DELETE"],
    ]);
    for (const request of requests) {
      expect(request.headers.get("Authorization")).toBe("Bearer token");
      expect(request.headers.get("Origin")).toBe(request.method === "GET" ? null : "https://eval-web.example.test");
    }
    expect(await requests[3]!.json()).toEqual({ revision: 1, name: "Judge" });
  });

  it("rejects an invalid SP origin before sending anything", () => {
    expect(() => createEvalSpClient({ ...origins, origin: "https://eval-sp.example.test/other" })).toThrow();
    expect(() => createEvalSpClient({ ...origins, writeOrigin: "https://eval-web.example.test/other" })).toThrow();
  });

  it("reports an unreachable SP or an unusable response as a transport failure", async () => {
    const unreachable = createEvalSpClient({ ...origins, fetch: vi.fn(async () => { throw new TypeError("fetch failed"); }) });
    await expect(unreachable.verifySession("token")).rejects.toBeInstanceOf(EvalSpTransportError);

    const { fetch } = recordingFetch(
      ok({ user: { id: "user-1" } }),
      Response.json({ id: "agent-1" }),
      new Response(null, { status: 302, headers: { Location: "https://elsewhere.example.test" } }),
    );
    const client = createEvalSpClient({ ...origins, fetch });
    await expect(client.verifySession("token")).rejects.toBeInstanceOf(EvalSpTransportError);
    await expect(client.getAgentConfig("token", "agent-1")).rejects.toBeInstanceOf(EvalSpTransportError);
    await expect(client.listAgentConfigs("token")).rejects.toBeInstanceOf(EvalSpTransportError);
  });
});
