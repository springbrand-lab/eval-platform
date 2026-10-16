import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearVerificationCacheForTest, handle, type Env } from "../../worker/index";

const env: Env = {
  ASSETS: { fetch: async () => new Response("assets") },
  TAKT_ORIGIN: "https://takt.test", TAKT_EVAL_MENU_ID: "eval",
  EVAL_API_ORIGIN: "https://eval-api.test", EVAL_WEB_ORIGIN: "https://eval-web.test",
  EVAL_WEB_API_TOKEN: "worker-service-key", FRAME_ANCESTORS: "https://takt.test",
};

describe("browser SDK and Web gateway errors", () => {
  beforeEach(() => { vi.resetModules(); clearVerificationCacheForTest(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); clearVerificationCacheForTest(); });

  it.each([
    ["denied", "EVAL_ACCESS_DENIED", 403, "forbidden"],
    ["expired", "AUTH_UNAUTHENTICATED", 401, "unauthorized"],
    ["takt-outage", "TAKT_UNAVAILABLE", 503, "ready"],
    ["api-outage", "EVAL_API_UNAVAILABLE", 503, "ready"],
    ["service-outage", "EVAL_SP_UNAVAILABLE", 503, "ready"],
  ] as const)("preserves %s and its correct auth state", async (scenario, code, status, authStatus) => {
    const upstream: typeof fetch = async (input) => {
      if (String(input).startsWith(env.TAKT_ORIGIN)) {
        if (scenario === "expired") return new Response(null, { status: 401 });
        if (scenario === "takt-outage") throw new TypeError("network unavailable");
        return Response.json({ user: { userId: "operator-1", name: "Operator", access: { menuIds: scenario === "denied" ? [] : ["eval"] } } });
      }
      if (scenario === "api-outage") throw new TypeError("network unavailable");
      return Response.json({ code: "EVAL_SP_UNAVAILABLE", errMsg: "Service session unavailable" }, { status: 503 });
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init), env, upstream)));
    const auth = await import("@/auth/session");
    auth.resetAuthForTest({ status: "ready", token: "valid-takt-token" });
    const { api } = await import("./client");
    await expect(api.get("/api/me")).rejects.toMatchObject({ code, status });
    expect(auth.getAuthState().status).toBe(authStatus);
  });

  it("retains validated domain details through the Worker and browser decoder", async () => {
    const details = { allowed: false, activeChatIds: ["00000000-0000-4000-8000-000000000001"], enabledScheduleIds: [], unfinishedRunIds: [] };
    const upstream: typeof fetch = async (input) => String(input).startsWith(env.TAKT_ORIGIN)
      ? Response.json({ user: { userId: "operator-1", access: { menuIds: ["eval"] } } })
      : Response.json({ code: "AGENT_CONFIG_ACTIVE_CHAT", errMsg: "Blocked", details }, { status: 409 });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init), env, upstream)));
    const auth = await import("@/auth/session");
    auth.resetAuthForTest({ status: "ready", token: "valid-takt-token" });
    const { api } = await import("./client");
    await expect(api.delete("/api/agent-configs/agent-a")).rejects.toMatchObject({ code: "AGENT_CONFIG_ACTIVE_CHAT", status: 409, details });
    expect(auth.getAuthState().status).toBe("ready");
  });
});
