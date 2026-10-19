import { MutationCache, QueryClient } from "@tanstack/react-query";
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

  it("accepts an empty successful deletion without reporting a response error", async () => {
    let deleted = false;
    const upstream: typeof fetch = async (input, init) => {
      if (String(input).startsWith(env.TAKT_ORIGIN)) {
        return Response.json({ user: { userId: "operator-1", access: { menuIds: ["eval"] } } });
      }
      expect(String(input)).toBe(`${env.EVAL_API_ORIGIN}/api/projects/project-a`);
      expect(init?.method).toBe("DELETE");
      deleted = true;
      return new Response(null, { status: 204 });
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init), env, upstream));
    vi.stubGlobal("fetch", fetcher);
    const auth = await import("@/auth/session");
    auth.resetAuthForTest({ status: "ready", token: "valid-takt-token" });
    const { deleteProject } = await import("./projects-api");

    await expect(deleteProject("project-a")).resolves.toBeUndefined();
    expect(deleted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(auth.getAuthState().status).toBe("ready");
  });

  it.each(["disconnect", "response-invalid", "gateway-failure"] as const)("confirms a committed deletion after its response is lost (%s) instead of reporting a network failure", async (failure) => {
    let deleted = false;
    const methods: string[] = [];
    const upstream: typeof fetch = async (input, init) => {
      if (String(input).startsWith(env.TAKT_ORIGIN)) {
        return Response.json({ user: { userId: "operator-1", access: { menuIds: ["eval"] } } });
      }
      expect(String(input)).toBe(`${env.EVAL_API_ORIGIN}/api/projects/project-a`);
      methods.push(init!.method!);
      if (init?.method === "DELETE") {
        deleted = true;
        if (failure === "response-invalid") {
          return new Response("{", { headers: { "Content-Type": "application/json" } });
        }
        if (failure === "gateway-failure") {
          return Response.json({ code: "EVAL_API_UNAVAILABLE", errMsg: "Response lost" }, { status: 503 });
        }
        return new Response(null, { status: 204 });
      }
      expect(deleted).toBe(true);
      return Response.json({ code: "PROJECT_NOT_FOUND", errMsg: "Project not found" }, { status: 404 });
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const response = await handle(request, env, upstream);
      if (request.method === "DELETE" && failure === "disconnect") throw new TypeError("Connection closed after deletion");
      return response;
    }));
    const auth = await import("@/auth/session");
    auth.resetAuthForTest({ status: "ready", token: "valid-takt-token" });
    const { deleteProject } = await import("./projects-api");
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const queryClient = new QueryClient({ mutationCache: new MutationCache({ onError }) });
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: () => deleteProject("project-a"), onSuccess,
    });

    try {
      await expect(mutation.execute(undefined)).resolves.toBeUndefined();
      expect(deleted).toBe(true);
      expect(methods).toEqual(["DELETE", "GET"]);
      expect(onSuccess).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
      expect(auth.getAuthState().status).toBe("ready");
    } finally {
      queryClient.clear();
    }
  });

  it.each([
    [200, null],
    [404, "REQUEST_NOT_FOUND"],
    [403, "EVAL_ACCESS_DENIED"],
    [500, "PROJECT_NOT_FOUND"],
  ] as const)("does not confirm deletion from an unrelated verification result (%i %s)", async (status, code) => {
    const methods: string[] = [];
    const upstream: typeof fetch = async (input, init) => {
      if (String(input).startsWith(env.TAKT_ORIGIN)) {
        return Response.json({ user: { userId: "operator-1", access: { menuIds: ["eval"] } } });
      }
      methods.push(init!.method!);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json(status === 200
        ? { success: true, msg: { project: { projectId: "project-a" } } }
        : { code, errMsg: "Verification did not confirm deletion" }, { status });
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const response = await handle(request, env, upstream);
      if (request.method === "DELETE") throw new TypeError("Connection closed after deletion");
      return response;
    }));
    const auth = await import("@/auth/session");
    auth.resetAuthForTest({ status: "ready", token: "valid-takt-token" });
    const { deleteProject } = await import("./projects-api");

    await expect(deleteProject("project-a")).rejects.toMatchObject({
      code: "NETWORK_ERROR", status: 0, context: { method: "DELETE" },
    });
    expect(methods).toEqual(["DELETE", "GET"]);
  });

  it("preserves a rejected deletion without making a confirmation request", async () => {
    const methods: string[] = [];
    const upstream: typeof fetch = async (input, init) => {
      if (String(input).startsWith(env.TAKT_ORIGIN)) {
        return Response.json({ user: { userId: "operator-1", access: { menuIds: ["eval"] } } });
      }
      methods.push(init!.method!);
      return Response.json({ code: "PROJECT_BUSY", errMsg: "Project has an active Run" }, { status: 409 });
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      handle(new Request(input, init), env, upstream)));
    const auth = await import("@/auth/session");
    auth.resetAuthForTest({ status: "ready", token: "valid-takt-token" });
    const { deleteProject } = await import("./projects-api");

    await expect(deleteProject("project-a")).rejects.toMatchObject({ code: "PROJECT_BUSY", status: 409 });
    expect(methods).toEqual(["DELETE"]);
  });

  it.each(["POST", "DELETE"] as const)("accepts an empty successful dataset membership %s", async (method) => {
    let changes = 0;
    const upstream: typeof fetch = async (input, init) => {
      if (String(input).startsWith(env.TAKT_ORIGIN)) {
        return Response.json({ user: { userId: "operator-1", access: { menuIds: ["eval"] } } });
      }
      expect(String(input)).toBe(`${env.EVAL_API_ORIGIN}/api/datasets/dataset-a/data`);
      expect(init?.method).toBe(method);
      expect(await new Response(init?.body).json()).toEqual({ dataIds: ["data-a"] });
      changes += 1;
      return new Response(null, { status: 204 });
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init), env, upstream)));
    const auth = await import("@/auth/session");
    auth.resetAuthForTest({ status: "ready", token: "valid-takt-token" });
    const { attachData, detachData } = await import("./datasets-api");

    await expect((method === "POST" ? attachData : detachData)("dataset-a", ["data-a"])).resolves.toBeUndefined();
    expect(changes).toBe(1);
    expect(auth.getAuthState().status).toBe("ready");
  });

  it("keeps a lost deletion response unknown when its confirmation is unavailable and never repeats the write", async () => {
    let deletions = 0;
    let confirmations = 0;
    const upstream: typeof fetch = async (input, init) => {
      if (String(input).startsWith(env.TAKT_ORIGIN)) {
        return Response.json({ user: { userId: "operator-1", access: { menuIds: ["eval"] } } });
      }
      if (init?.method === "DELETE") {
        deletions += 1;
        return new Response(null, { status: 204 });
      }
      confirmations += 1;
      return Response.json({ code: "INTERNAL_ERROR", errMsg: "Verification unavailable" }, { status: 500 });
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const response = await handle(request, env, upstream);
      if (request.method === "DELETE") throw new TypeError("Connection closed after deletion");
      return response;
    });
    vi.stubGlobal("fetch", fetcher);
    const auth = await import("@/auth/session");
    auth.resetAuthForTest({ status: "ready", token: "valid-takt-token" });
    const { deleteProject } = await import("./projects-api");
    const { isWriteOutcomeUnknown } = await import("@/lib/errors");

    const error: unknown = await deleteProject("project-a").then(() => null, (failure: unknown) => failure);
    expect(error).toMatchObject({ code: "NETWORK_ERROR", kind: "network", status: 0, context: { method: "DELETE" } });
    expect(isWriteOutcomeUnknown(error)).toBe(true);
    expect(deletions).toBe(1);
    expect(confirmations).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(auth.getAuthState().status).toBe("ready");
  });

  it("loads sampling details larger than the SDK's default response limit without truncation", async () => {
    const content = "x".repeat(10 * 1024 * 1024 + 1);
    const upstream: typeof fetch = async (input) => String(input).startsWith(env.TAKT_ORIGIN)
      ? Response.json({ user: { userId: "operator-1", access: { menuIds: ["eval"] } } })
      : Response.json({ success: true, msg: { sampling: { samplingId: "sampling-a", execution: { status: "failed", lastError: content } } } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init), env, upstream)));
    const auth = await import("@/auth/session");
    auth.resetAuthForTest({ status: "ready", token: "valid-takt-token" });
    const { getSamplingDetail } = await import("./metrics-api");
    const detail = await getSamplingDetail("project-a", "sampling-a");
    expect(detail.sampling.samplingId).toBe("sampling-a");
    expect(detail.sampling.execution.lastError).toBe(content);
    expect(auth.getAuthState().status).toBe("ready");
  });

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
