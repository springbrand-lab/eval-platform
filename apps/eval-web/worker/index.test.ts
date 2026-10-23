// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearVerificationCacheForTest, handle, type Env } from "./index";

const env: Env = {
  ASSETS: { fetch: async () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html", "X-Frame-Options": "DENY" } }) },
  TAKT_ORIGIN: "https://takt.test",
  TAKT_EVAL_MENU_ID: "eval",
  EVAL_API_ORIGIN: "https://eval-api.test",
  EVAL_WEB_ORIGIN: "https://eval-web.test",
  EVAL_WEB_API_TOKEN: "w".repeat(40),
  FRAME_ANCESTORS: "https://takt.test",
};

function takt(user: object | null, status = 200) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://takt.test")) {
      return user ? Response.json({ user }, { status }) : new Response("", { status });
    }
    return Response.json({ success: true, msg: { url, headers: Object.fromEntries(new Headers(init?.headers)) } });
  });
}

const allowed = { userId: "ou_1", name: "张三", access: { isAdmin: false, menuIds: ["eval"] } };
const api = (token?: string) => new Request("https://eval-web.test/api/projects?x=1", token ? { headers: { Authorization: `Bearer ${token}` } } : {});

describe("eval-web Worker", () => {
  beforeEach(() => clearVerificationCacheForTest());

  it("rejects /api without a takt token, with an expired one and without the Eval menu", async () => {
    expect((await handle(api(), env, takt(allowed))).status).toBe(401);
    expect((await handle(api("t"), env, takt(null, 401))).status).toBe(401);
    const denied = await handle(api("t"), env, takt({ ...allowed, access: { isAdmin: false, menuIds: ["issues"] } }));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "EVAL_ACCESS_DENIED" });
    expect((await handle(api("t2"), env, takt(null, 500))).status).toBe(503);
  });

  it("forwards with the service token and actor, never the takt token, and caches the check", async () => {
    const fetcher = takt(allowed);
    const response = await handle(api("secret-takt-token"), env, fetcher);
    const forwarded = (await response.json() as { msg: { url: string; headers: Record<string, string> } }).msg;
    expect(forwarded.url).toBe("https://eval-api.test/api/projects?x=1");
    expect(forwarded.headers["x-eval-web-token"]).toBe(env.EVAL_WEB_API_TOKEN);
    expect(forwarded.headers.origin).toBe(env.EVAL_WEB_ORIGIN);
    expect(JSON.parse(decodeURIComponent(forwarded.headers["x-eval-actor"]!))).toEqual({ id: "ou_1", name: "张三" });
    expect(forwarded.headers.authorization).toBeUndefined();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await handle(api("secret-takt-token"), env, fetcher);
    expect(fetcher.mock.calls.filter(([input]) => String(input).startsWith("https://takt.test"))).toHaveLength(1);
  });

  it("passes a project result ZIP through without buffering or changing attachment protections", async () => {
    const first = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const last = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        finish = () => { controller.enqueue(last); controller.close(); };
      },
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith("https://takt.test")
      ? Response.json({ user: allowed })
      : new Response(body, { headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="project-1-evaluation-results.zip"',
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
      } }));
    const response = await handle(new Request("https://eval-web.test/api/projects/project-1/evaluation-results.zip", {
      headers: { Authorization: "Bearer zip-download" },
    }), env, fetcher);

    expect(response.status).toBe(200);
    expect(String(fetcher.mock.calls[1]![0])).toBe("https://eval-api.test/api/projects/project-1/evaluation-results.zip");
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="project-1-evaluation-results.zip"');
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(first);
    finish();
    expect((await reader.read()).value).toEqual(last);
    expect((await reader.read()).done).toBe(true);
  });

  it("propagates download cancellation to the upstream result stream", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith("https://takt.test")
      ? Response.json({ user: allowed })
      : new Response(body, { headers: { "Content-Type": "application/zip" } }));
    const response = await handle(new Request("https://eval-web.test/api/projects/project-1/evaluation-results.zip", {
      headers: { Authorization: "Bearer cancelled-download" },
    }), env, fetcher);

    await response.body!.cancel("download cancelled");
    expect(cancel).toHaveBeenCalledExactlyOnceWith("download cancelled");
  });

  it("lets takt admins in and serves pages that only takt may frame", async () => {
    expect((await handle(api("admin"), env, takt({ ...allowed, access: { isAdmin: true, menuIds: [] } }))).status).toBe(200);
    const page = await handle(new Request("https://eval-web.test/projects"), env, takt(allowed));
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'self' https://takt.test");
    expect(page.headers.get("x-frame-options")).toBeNull();
  });
});
