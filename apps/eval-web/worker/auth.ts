// Sign-in through saas-iam (OAuth authorization code + S256 PKCE), as in saas-template:
//
// - GET  /api/auth/login?redirect=/path  sends the browser to IAM
// - GET  /api/auth/callback              IAM sends it back; starts this app's session
// - POST /api/auth/logout                ends this app's session (the IAM session stays)
// - GET  /api/auth/me                    who this session belongs to, so an embedding page can check it is the same person
//
// The session is a signed HttpOnly cookie; nothing is stored server-side. Every API request still asks
// IAM (cached briefly) whether the person is active and may use Eval. Failures land on `/?auth_error=…`.

export interface AuthEnv {
  readonly IAM_ORIGIN: string;
  readonly IAM_CLIENT_ID: string;
  readonly IAM_CLIENT_SECRET: string;
  /** At least 32 characters; signs the session and pending-login cookies. */
  readonly SESSION_SECRET: string;
}

/** The IAM action that lets someone use Eval; also the application's sign-in requirement in IAM. */
export const EVAL_ACTION = "eval:app:use";

export interface SessionUser {
  readonly id: string;
  readonly name: string;
}

interface Session extends SessionUser {
  readonly exp: number;
}

interface PendingLogin {
  readonly state: string;
  readonly verifier: string;
  readonly redirect: string;
}

const SESSION_COOKIE = "eval_session";
const LOGIN_COOKIE = "eval_login";
const SESSION_SECONDS = 12 * 60 * 60;
const LOGIN_SECONDS = 10 * 60;
const PERMISSION_CACHE_MS = 60_000;
const PERMISSION_CACHE_LIMIT = 1_000;

/** IAM could not answer; the caller reports the outage instead of signing anyone out. */
export class IamUnavailableError extends Error {}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const randomUrlSafe = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(value: unknown, secret: string): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(value)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload)));
  return `${payload}.${base64url(signature)}`;
}

async function unsign<T>(token: string | undefined, secret: string): Promise<T | null> {
  const [payload, signature, extra] = token?.split(".") ?? [];
  if (!payload || !signature || extra !== undefined) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromBase64url(signature), encoder.encode(payload));
    return valid ? JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as T : null;
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function cookie(request: Request, name: string, value: string, maxAge: number, path = "/"): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 302, headers });
}

/**
 * A path on this app to return to after signing in, or `/`. Resolved the way a browser resolves `Location`
 * (which drops tabs and newlines and treats `\\` as `/`), so nothing can turn it into another host.
 */
export function safeRedirect(path: string | null): string {
  if (!path?.startsWith("/")) return "/";
  const base = "https://eval.invalid";
  const target = new URL(path, base);
  const resolved = target.pathname + target.search + target.hash;
  // Dot segments can collapse into `//host` only after resolving, so the result must stay here when resolved again.
  if (target.origin !== base || target.pathname.startsWith("//") || target.pathname.startsWith("/api/") || new URL(resolved, base).origin !== base) return "/";
  return resolved;
}

const callbackUrl = (request: Request) => `${new URL(request.url).origin}/api/auth/callback`;
export const basicAuth = (env: AuthEnv) => `Basic ${btoa(`${encodeURIComponent(env.IAM_CLIENT_ID)}:${encodeURIComponent(env.IAM_CLIENT_SECRET)}`)}`;

export async function iamFetch(env: AuthEnv, fetcher: typeof fetch, path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(new URL(path, env.IAM_ORIGIN), { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } catch (cause) {
    throw new IamUnavailableError(`IAM ${path} unreachable`, { cause });
  }
}

/** The signed-in person, or null without a valid session. */
export async function readSession(request: Request, env: AuthEnv, now = Date.now()): Promise<SessionUser | null> {
  const session = await unsign<Session>(readCookie(request, SESSION_COOKIE), env.SESSION_SECRET);
  return session && session.exp > Math.floor(now / 1000) ? { id: session.id, name: session.name } : null;
}

/** A session cookie for tests, signed like a real one. */
export async function sessionCookieForTest(env: AuthEnv, user: SessionUser): Promise<string> {
  return `${SESSION_COOKIE}=${await sign({ ...user, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS }, env.SESSION_SECRET)}`;
}

const permissionCache = new Map<string, { allowed: boolean; expires: number }>();

/** Whether IAM reports this person active and allowed to use Eval; cached briefly. */
export async function mayUseEval(principalId: string, env: AuthEnv, fetcher: typeof fetch, now = Date.now()): Promise<boolean> {
  const hit = permissionCache.get(principalId);
  if (hit && hit.expires > now) return hit.allowed;
  const path = "/api/v1/app/permissions";
  const response = await iamFetch(env, fetcher, path, {
    method: "POST",
    headers: { Authorization: basicAuth(env), "Content-Type": "application/json" },
    body: JSON.stringify({ principal: principalId }),
  });
  const json = await response.json().catch(() => null) as { success?: unknown; msg?: { status?: unknown; permissions?: unknown } } | null;
  const status = json?.msg?.status;
  const permissions = json?.msg?.permissions;
  // An answer of another shape is an outage, not a refusal: it must not lock everyone out silently.
  if (!response.ok || json?.success !== true || typeof status !== "string" || !Array.isArray(permissions)) {
    throw new IamUnavailableError(`IAM ${path} → ${response.status}: unexpected answer`);
  }
  const actions = permissions.map((permission: { action?: unknown }) => permission?.action);
  const allowed = status === "active" && (actions.includes(EVAL_ACTION) || actions.includes("*"));
  if (permissionCache.size >= PERMISSION_CACHE_LIMIT) permissionCache.clear();
  permissionCache.set(principalId, { allowed, expires: now + PERMISSION_CACHE_MS });
  return allowed;
}

export function clearPermissionCacheForTest(): void {
  permissionCache.clear();
}

async function login(request: Request, env: AuthEnv): Promise<Response> {
  const pending: PendingLogin = { state: randomUrlSafe(), verifier: randomUrlSafe(), redirect: safeRedirect(new URL(request.url).searchParams.get("redirect")) };
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(pending.verifier))));
  const authorize = new URL("/oauth/authorize", env.IAM_ORIGIN);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: env.IAM_CLIENT_ID,
    redirect_uri: callbackUrl(request),
    state: pending.state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "profile",
  }).toString();
  return redirect(authorize.toString(), [cookie(request, LOGIN_COOKIE, await sign(pending, env.SESSION_SECRET), LOGIN_SECONDS, "/api/auth")]);
}

/** Trades IAM's code for the person it signed in; null when the code is not valid. */
async function signIn(request: Request, env: AuthEnv, fetcher: typeof fetch, code: string, verifier: string): Promise<SessionUser | null> {
  const tokenResponse = await iamFetch(env, fetcher, "/oauth/token", {
    method: "POST",
    headers: { Authorization: basicAuth(env), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: callbackUrl(request) }),
  });
  const token = await tokenResponse.json().catch(() => null) as { access_token?: string; error?: string } | null;
  if (tokenResponse.status === 400 && token?.error === "invalid_grant") return null;
  if (!tokenResponse.ok || !token?.access_token) throw new IamUnavailableError(`IAM /oauth/token → ${tokenResponse.status}`);
  const infoResponse = await iamFetch(env, fetcher, "/oauth/userinfo", { headers: { Authorization: `Bearer ${token.access_token}` } });
  const info = await infoResponse.json().catch(() => null) as { sub?: string; name?: string } | null;
  if (!infoResponse.ok || !info?.sub) throw new IamUnavailableError(`IAM /oauth/userinfo → ${infoResponse.status}`);
  return { id: info.sub, name: info.name?.trim() || info.sub };
}

async function callback(request: Request, env: AuthEnv, fetcher: typeof fetch): Promise<Response> {
  const pending = await unsign<PendingLogin>(readCookie(request, LOGIN_COOKIE), env.SESSION_SECRET);
  const clearLogin = cookie(request, LOGIN_COOKIE, "", 0, "/api/auth");
  const fail = (reason: string) => redirect(`/?auth_error=${encodeURIComponent(reason)}`, [clearLogin]);
  const query = new URL(request.url).searchParams;
  const error = query.get("error");
  if (!pending || query.get("state") !== pending.state) return fail("expired");
  if (error) return fail(error === "access_denied" ? (query.get("error_description") === "not_permitted" ? "not_permitted" : "access_denied") : "failed");
  const code = query.get("code");
  if (!code) return fail("failed");
  try {
    const user = await signIn(request, env, fetcher, code, pending.verifier);
    if (!user) return fail("expired");
    const session: Session = { ...user, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS };
    return redirect(pending.redirect, [clearLogin, cookie(request, SESSION_COOKIE, await sign(session, env.SESSION_SECRET), SESSION_SECONDS)]);
  } catch (cause) {
    if (!(cause instanceof IamUnavailableError)) throw cause;
    return fail("iam_unavailable");
  }
}

/** Handles `/api/auth/*`; null for any other path. */
export async function handleAuth(request: Request, env: AuthEnv, fetcher: typeof fetch): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/auth/login" && request.method === "GET") return login(request, env);
  if (pathname === "/api/auth/callback" && request.method === "GET") return callback(request, env, fetcher);
  if (pathname === "/api/auth/me" && request.method === "GET") {
    const user = await readSession(request, env);
    return user
      ? Response.json({ success: true, msg: user }, { headers: { "Cache-Control": "no-store" } })
      : Response.json({ code: "AUTH_UNAUTHENTICATED", errMsg: "请登录后使用 Eval" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (pathname === "/api/auth/logout" && request.method === "POST") {
    return new Response(null, { status: 204, headers: { "Set-Cookie": cookie(request, SESSION_COOKIE, "", 0), "Cache-Control": "no-store" } });
  }
  return null;
}
