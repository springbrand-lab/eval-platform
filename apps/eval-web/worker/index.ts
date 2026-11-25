// eval-web Worker: serves the SPA, signs people in through saas-iam and forwards /api/* to the Eval API.
import { webGatewayErrorDefinitions, type WebGatewayErrorCode } from "@eval-platform/eval-contracts/web-gateway-errors";
import { type AuthEnv, handleAuth, IamUnavailableError, mayUseEval, readSession, type SessionUser } from "./auth";

export interface Env extends AuthEnv {
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  readonly EVAL_API_ORIGIN: string;
  /** Sent to the Eval API as Origin; must equal its EVAL_WEB_ORIGIN. */
  readonly EVAL_WEB_ORIGIN: string;
  readonly EVAL_WEB_API_TOKEN: string;
  /** Space-separated origins allowed to embed this app. */
  readonly FRAME_ANCESTORS: string;
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
    // Browser writes must come from this app's own origin (the session cookie is SameSite=Lax).
    const origin = request.headers.get("origin");
    if (request.method !== "GET" && request.method !== "HEAD" && origin && origin !== url.origin) return errorResponse("REQUEST_UNTRUSTED_ORIGIN");
    const auth = await handleAuth(request, env, fetcher);
    if (auth) return auth;
    const user = await readSession(request, env);
    if (!user) return errorResponse("AUTH_UNAUTHENTICATED", "请登录后使用 Eval");
    try {
      if (!await mayUseEval(user.id, env, fetcher)) return errorResponse("EVAL_ACCESS_DENIED");
    } catch (cause) {
      if (!(cause instanceof IamUnavailableError)) throw cause;
      return errorResponse("IAM_UNAVAILABLE");
    }
    try {
      return await proxyApi(request, env, user, fetcher);
    } catch {
      return errorResponse("EVAL_API_UNAVAILABLE");
    }
  }
  return withSecurityHeaders(await env.ASSETS.fetch(request), env);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
};
