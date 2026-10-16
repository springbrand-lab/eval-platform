// eval-web Worker: serves the SPA and forwards /api/* to the Eval API after verifying the takt login.
import { webGatewayErrorDefinitions, type WebGatewayErrorCode } from "@eval-platform/eval-contracts/web-gateway-errors";

export interface Env {
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  /** takt, whose /api/auth/me verifies the token the embedding page handed over. */
  readonly TAKT_ORIGIN: string;
  /** The takt menu that grants Eval access. */
  readonly TAKT_EVAL_MENU_ID: string;
  readonly EVAL_API_ORIGIN: string;
  /** Sent to the Eval API as Origin; must equal its EVAL_WEB_ORIGIN. */
  readonly EVAL_WEB_ORIGIN: string;
  readonly EVAL_WEB_API_TOKEN: string;
  /** Space-separated origins allowed to embed this app. */
  readonly FRAME_ANCESTORS: string;
}

export interface TaktUser {
  readonly id: string;
  readonly name: string;
}

interface CacheEntry {
  readonly user: TaktUser | "forbidden";
  readonly expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_LIMIT = 1_000;
const cache = new Map<string, CacheEntry>();

function errorResponse(code: WebGatewayErrorCode, message?: string): Response {
  const { status, message: defaultMessage } = webGatewayErrorDefinitions[code];
  return Response.json({ code, errMsg: message ?? defaultMessage }, { status, headers: { "Cache-Control": "no-store" } });
}

async function cacheKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Verification = TaktUser | "unauthorized" | "forbidden" | "unavailable";

/** Ask takt who the token belongs to and whether that user may open Eval; results are cached briefly. */
export async function verifyTaktToken(token: string, env: Env, fetcher: typeof fetch = fetch, now = Date.now()): Promise<Verification> {
  const key = await cacheKey(token);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.user;
  let response: Response;
  try {
    response = await fetcher(new URL("/api/auth/me", env.TAKT_ORIGIN), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return "unavailable";
  }
  if (response.status === 401 || response.status === 403) return "unauthorized";
  if (!response.ok) return "unavailable";
  const body = await response.json().catch(() => null) as {
    user?: { userId?: unknown; name?: unknown; displayName?: unknown; access?: { isAdmin?: unknown; menuIds?: unknown } };
  } | null;
  const user = body?.user;
  if (!user || typeof user.userId !== "string") return "unavailable";
  const menuIds = Array.isArray(user.access?.menuIds) ? user.access.menuIds : [];
  const allowed = user.access?.isAdmin === true || menuIds.includes(env.TAKT_EVAL_MENU_ID);
  const name = [user.displayName, user.name].find((value): value is string => typeof value === "string" && value.trim() !== "");
  const result: TaktUser | "forbidden" = allowed ? { id: user.userId, name: name ?? user.userId } : "forbidden";
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, { user: result, expiresAt: now + CACHE_TTL_MS });
  return result;
}

const FORWARDED_HEADERS = ["content-type", "accept", "x-request-id"];

/** Forward to the Eval API; the takt token never leaves this Worker. */
export async function proxyApi(request: Request, env: Env, actor: TaktUser, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, env.EVAL_API_ORIGIN);
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("X-Eval-Web-Token", env.EVAL_WEB_API_TOKEN);
  headers.set("X-Eval-Actor", encodeURIComponent(JSON.stringify(actor)));
  headers.set("Origin", env.EVAL_WEB_ORIGIN);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const response = await fetcher(target, {
    method: request.method,
    headers,
    ...(hasBody ? { body: await request.arrayBuffer() } : {}),
    redirect: "manual",
  });
  const out = new Response(response.body, response);
  out.headers.set("Cache-Control", "private, no-store");
  out.headers.delete("access-control-allow-origin");
  out.headers.delete("access-control-allow-credentials");
  return out;
}

export function withSecurityHeaders(response: Response, env: Env): Response {
  const out = new Response(response.body, response);
  out.headers.set("Content-Security-Policy", `frame-ancestors 'self' ${env.FRAME_ANCESTORS}`.trim());
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  out.headers.delete("X-Frame-Options");
  return out;
}

export async function handle(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/healthz") return Response.json({ status: "ok" });
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    const token = /^Bearer\s+(\S+)$/iu.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token) return errorResponse("AUTH_UNAUTHENTICATED", "请在 takt 中登录后打开 Eval");
    const verified = await verifyTaktToken(token, env, fetcher);
    if (verified === "unauthorized") return errorResponse("AUTH_UNAUTHENTICATED", "takt 登录已失效");
    if (verified === "forbidden") return errorResponse("EVAL_ACCESS_DENIED");
    if (verified === "unavailable") return errorResponse("TAKT_UNAVAILABLE");
    try {
      return await proxyApi(request, env, verified, fetcher);
    } catch {
      return errorResponse("EVAL_API_UNAVAILABLE");
    }
  }
  return withSecurityHeaders(await env.ASSETS.fetch(request), env);
}

export function clearVerificationCacheForTest(): void {
  cache.clear();
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
};
