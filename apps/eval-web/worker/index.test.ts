// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearPermissionCacheForTest, EVAL_ACTION, safeRedirect, sessionCookieForTest } from "./auth";
import { handle, type Env } from "./index";

const env: Env = {
  ASSETS: { fetch: async () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html", "X-Frame-Options": "DENY" } }) },
  IAM_ORIGIN: "https://iam.test",
  IAM_CLIENT_ID: "app_eval",
  IAM_CLIENT_SECRET: "client-secret",
  SESSION_SECRET: "s".repeat(32),
  EVAL_API_ORIGIN: "https://eval-api.test",
  EVAL_WEB_ORIGIN: "https://eval-web.test",
  EVAL_WEB_API_TOKEN: "w".repeat(40),
  FRAME_ANCESTORS: "https://takt.test",
};

const user = { id: "principal-1", name: "张三" };

/** IAM answering permissions (and, for sign-in, token and userinfo); other calls echo what the Eval API received. */
function upstream(options: { actions?: string[]; status?: string; iamDown?: boolean } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(env.IAM_ORIGIN)) {
      if (options.iamDown) throw new TypeError("network unavailable");
      if (url.endsWith("/oauth/token")) return Response.json({ access_token: "iam-access" });
      if (url.endsWith("/oauth/userinfo")) return Response.json({ sub: user.id, name: user.name });
      return Response.json({ success: true, msg: { status: options.status ?? "active", permissions: (options.actions ?? [EVAL_ACTION]).map((action) => ({ action })) } });
    }
    return Response.json({ success: true, msg: { url, headers: Object.fromEntries(new Headers(init?.headers)) } });
  });
}

async function api(init: RequestInit = {}, signedIn = true) {
  const headers = new Headers(init.headers);
  if (signedIn) headers.set("cookie", await sessionCookieForTest(env, user));
  return new Request("https://eval-web.test/api/projects?x=1", { ...init, headers });
}

const setCookies = (response: Response): string[] => [...response.headers].filter(([name]) => name === "set-cookie").map(([, value]) => value);
const cookieValue = (response: Response, name: string) => setCookies(response).find((value) => value.startsWith(`${name}=`))!.split(";")[0]!;

describe("eval-web Worker", () => {
  beforeEach(() => clearPermissionCacheForTest());

  it("rejects /api without a session, without the Eval action, for inactive people and when IAM is down", async () => {
    expect((await handle(await api({}, false), env, upstream())).status).toBe(401);
    const tampered = new Request("https://eval-web.test/api/projects", { headers: { cookie: `${(await sessionCookieForTest(env, user)).slice(0, -2)}xx` } });
    expect((await handle(tampered, env, upstream())).status).toBe(401);
    const denied = await handle(await api(), env, upstream({ actions: ["other:app:use"] }));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "EVAL_ACCESS_DENIED" });
    clearPermissionCacheForTest();
    expect((await handle(await api(), env, upstream({ status: "inactive" }))).status).toBe(403);
    clearPermissionCacheForTest();
    expect(await (await handle(await api(), env, upstream({ iamDown: true }))).json()).toMatchObject({ code: "IAM_UNAVAILABLE" });
  });

  it("refuses browser writes from another origin", async () => {
    const response = await handle(await api({ method: "POST", headers: { Origin: "https://other.cuecue.cc" } }), env, upstream());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "REQUEST_UNTRUSTED_ORIGIN" });
    expect((await handle(await api({ method: "POST", headers: { Origin: "https://eval-web.test" } }), env, upstream())).status).toBe(200);
  });

  it("forwards with the service token and actor, never the session cookie, and caches the permission check", async () => {
    const fetcher = upstream();
    const response = await handle(await api(), env, fetcher);
    const forwarded = (await response.json() as { msg: { url: string; headers: Record<string, string> } }).msg;
    expect(forwarded.url).toBe("https://eval-api.test/api/projects?x=1");
    expect(forwarded.headers["x-eval-web-token"]).toBe(env.EVAL_WEB_API_TOKEN);
    expect(forwarded.headers.origin).toBe(env.EVAL_WEB_ORIGIN);
    expect(JSON.parse(decodeURIComponent(forwarded.headers["x-eval-actor"]!))).toEqual(user);
    expect(forwarded.headers.cookie).toBeUndefined();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await handle(await api(), env, fetcher);
    expect(fetcher.mock.calls.filter(([input]) => String(input).startsWith(env.IAM_ORIGIN))).toHaveLength(1);
  });

  it("signs in through IAM with PKCE and returns to the requested page", async () => {
    const login = await handle(new Request("https://eval-web.test/api/auth/login?redirect=%2Fprojects%2Fp1"), env, upstream());
    expect(login.status).toBe(302);
    const authorize = new URL(login.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe("https://iam.test/oauth/authorize");
    expect(authorize.searchParams.get("client_id")).toBe("app_eval");
    expect(authorize.searchParams.get("redirect_uri")).toBe("https://eval-web.test/api/auth/callback");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const pending = cookieValue(login, "eval_login");
    expect(setCookies(login)[0]).toContain("HttpOnly; SameSite=Lax; Secure");

    const fetcher = upstream();
    const callback = await handle(new Request(`https://eval-web.test/api/auth/callback?code=c1&state=${authorize.searchParams.get("state")}`, { headers: { cookie: pending } }), env, fetcher);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/projects/p1");
    const tokenRequest = fetcher.mock.calls.find(([input]) => String(input).endsWith("/oauth/token"))!;
    expect(String(tokenRequest[1]!.body)).toContain("code=c1");
    const session = cookieValue(callback, "eval_session");
    const forwarded = await handle(new Request("https://eval-web.test/api/projects", { headers: { cookie: session } }), env, upstream());
    expect(forwarded.status).toBe(200);
  });

  it("lands sign-in failures on the page and never trusts an unknown state or return path", async () => {
    const login = await handle(new Request("https://eval-web.test/api/auth/login?redirect=%2F%2Fevil.test"), env, upstream());
    const state = new URL(login.headers.get("location")!).searchParams.get("state");
    const pending = cookieValue(login, "eval_login");
    const callback = (query: string, cookie = pending) => handle(new Request(`https://eval-web.test/api/auth/callback?${query}`, { headers: { cookie } }), env, upstream());
    expect((await callback("code=c1&state=wrong")).headers.get("location")).toBe("/?auth_error=expired");
    expect((await callback(`state=${state}&error=access_denied&error_description=not_permitted`)).headers.get("location")).toBe("/?auth_error=not_permitted");
    expect((await callback(`code=c1&state=${state}`)).headers.get("location")).toBe("/");
    const down = await handle(new Request(`https://eval-web.test/api/auth/callback?code=c1&state=${state}`, { headers: { cookie: pending } }), env, upstream({ iamDown: true }));
    expect(down.headers.get("location")).toBe("/?auth_error=iam_unavailable");
  });

  it("keeps return paths on this app however the browser would resolve them", () => {
    for (const path of ["/\t/evil.com", "/\n/evil.com", "//evil.com", "/\\evil.com", "/.//evil.com", "/a/..//evil.com", "/./\\evil.com", "/./api/x", "https://evil.com", "/api/projects", null]) expect(safeRedirect(path)).toBe("/");
    expect(safeRedirect("/projects/p1?tab=runs#top")).toBe("/projects/p1?tab=runs#top");
    expect(safeRedirect("/%09/evil.com")).toBe("/%09/evil.com");
  });

  it("treats an IAM permission answer of another shape as an outage, not a refusal", async () => {
    const odd = vi.fn(async () => Response.json({ success: true, msg: { allowed: true } }));
    expect(await (await handle(await api(), env, odd)).json()).toMatchObject({ code: "IAM_UNAVAILABLE" });
  });

  it("tells an embedding page who the session belongs to", async () => {
    const me = await handle(new Request("https://eval-web.test/api/auth/me", { headers: { cookie: await sessionCookieForTest(env, user) } }), env, upstream());
    expect(await me.json()).toEqual({ success: true, msg: user });
    expect((await handle(new Request("https://eval-web.test/api/auth/me"), env, upstream())).status).toBe(401);
  });

  it("signs out by clearing the session cookie", async () => {
    const response = await handle(new Request("https://eval-web.test/api/auth/logout", { method: "POST" }), env, upstream());
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("eval_session=; Path=/; Max-Age=0");
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
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith(env.IAM_ORIGIN)
      ? Response.json({ success: true, msg: { status: "active", permissions: [{ action: EVAL_ACTION }] } })
      : new Response(body, { headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="project-1-evaluation-results.zip"',
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
      } }));
    const response = await handle(new Request("https://eval-web.test/api/projects/project-1/evaluation-results.zip", {
      headers: { cookie: await sessionCookieForTest(env, user) },
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
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith(env.IAM_ORIGIN)
      ? Response.json({ success: true, msg: { status: "active", permissions: [{ action: EVAL_ACTION }] } })
      : new Response(body, { headers: { "Content-Type": "application/zip" } }));
    const response = await handle(new Request("https://eval-web.test/api/projects/project-1/evaluation-results.zip", {
      headers: { cookie: await sessionCookieForTest(env, user) },
    }), env, fetcher);

    await response.body!.cancel("download cancelled");
    expect(cancel).toHaveBeenCalledExactlyOnceWith("download cancelled");
  });

  it("serves pages that only the configured hosts may frame", async () => {
    const page = await handle(new Request("https://eval-web.test/projects"), env, upstream());
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'self' https://takt.test");
    expect(page.headers.get("x-frame-options")).toBeNull();
  });
});
