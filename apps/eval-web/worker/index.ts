// eval-web Worker: serves the SPA, signs people in through saas-iam and forwards /api/* to the Eval API.
// The main App (saas-console) may also load Eval as a micro app: then its pages run on the main App's origin,
// fetch Eval's assets and call /api cross-origin with the person's IAM access token (see iamToken.ts).
import { webGatewayErrorDefinitions, type WebGatewayErrorCode } from "@eval-platform/eval-contracts/web-gateway-errors";
import { type AuthEnv, handleAuth, IamUnavailableError, mayUseEval, readSession, type SessionUser } from "./auth";
import { principalName, verifyIamToken } from "./iamToken";

export interface Env extends AuthEnv {
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  readonly EVAL_API_ORIGIN: string;
  /** Sent to the Eval API as Origin; must equal its EVAL_WEB_ORIGIN. */
  readonly EVAL_WEB_ORIGIN: string;
  readonly EVAL_WEB_API_TOKEN: string;
  /** Space-separated origins that may host this app: frame it, or load it as a micro app (assets and /api, cross-origin). */
  readonly HOST_ORIGINS: string;
}

function errorResponse(code: WebGatewayErrorCode, message?: string): Response {
  const { status, message: defaultMessage } = webGatewayErrorDefinitions[code];
  return Response.json({ code, errMsg: message ?? defaultMessage }, { status, headers: { "Cache-Control": "no-store" } });
}

const FORWARDED_HEADERS = ["content-type", "accept", "x-request-id"];

/** Forward to the Eval API with the service token and the signed-in person as actor; cookies stay here. */
export async function proxyApi(request: Request, env: Env, actor: SessionUser, fetcher: typeof fetch = fetch): Promise<Response> {
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
  out.headers.set("Content-Security-Policy", `frame-ancestors 'self' ${env.HOST_ORIGINS}`.trim());
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  out.headers.delete("X-Frame-Options");
  return out;
}

/** The request's Origin when it is a host of this app; null otherwise (including same-origin requests). */
function hostOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("origin");
  return origin && env.HOST_ORIGINS.split(/\s+/u).includes(origin) ? origin : null;
}

/** Lets a host page read the response. No credentials: hosts call with a Bearer token, never Eval's cookie. */
function withCors(response: Response, origin: string | null): Response {
  if (!origin) return response;
  const out = new Response(response.body, response);
  out.headers.set("Access-Control-Allow-Origin", origin);
  out.headers.set("Access-Control-Expose-Headers", "Content-Disposition, X-Request-ID");
  out.headers.append("Vary", "Origin");
  return out;
}

/** The person behind an API request: an IAM access token from a host page, or this app's own session. */
async function apiUser(request: Request, env: Env, fetcher: typeof fetch): Promise<SessionUser | Response> {
  const bearer = /^Bearer\s+(\S+)$/iu.exec(request.headers.get("authorization") ?? "")?.[1];
  if (bearer) {
    const principalId = await verifyIamToken(bearer, env, fetcher);
    return principalId ? principalName(principalId, env, fetcher) : errorResponse("AUTH_UNAUTHENTICATED", "登录已失效，请刷新页面");
  }
  // Browser writes on the session must come from this app's own origin (the cookie is SameSite=Lax).
  const origin = request.headers.get("origin");
  if (request.method !== "GET" && request.method !== "HEAD" && origin && origin !== new URL(request.url).origin) return errorResponse("REQUEST_UNTRUSTED_ORIGIN");
  return await readSession(request, env) ?? errorResponse("AUTH_UNAUTHENTICATED", "请登录后使用 Eval");
}

async function api(request: Request, env: Env, fetcher: typeof fetch): Promise<Response> {
  const auth = await handleAuth(request, env, fetcher);
  if (auth) return auth;
  try {
    const user = await apiUser(request, env, fetcher);
    if (user instanceof Response) return user;
    if (!await mayUseEval(user.id, env, fetcher)) return errorResponse("EVAL_ACCESS_DENIED");
    try {
      return await proxyApi(request, env, user, fetcher);
    } catch {
      return errorResponse("EVAL_API_UNAVAILABLE");
    }
  } catch (cause) {
    if (!(cause instanceof IamUnavailableError)) throw cause;
    return errorResponse("IAM_UNAVAILABLE");
  }
}

export async function handle(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/healthz") return Response.json({ status: "ok" });
  const origin = hostOrigin(request, env);
  const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
  if (isApi && request.method === "OPTIONS" && origin) {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, X-Request-ID, If-Match",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    } });
  }
  if (isApi) return withCors(await api(request, env, fetcher), origin);
  return withCors(withSecurityHeaders(await env.ASSETS.fetch(request), env), origin);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
};
