// The person's IAM access token, which the main App (saas-console) passes when Eval runs inside it as a
// micro app. Verified locally like @springbrand/auth/verify: an EdDSA JWT signed by IAM (keys from its
// JWKS), issued by IAM_ORIGIN, not expired, for a person (`typ: "human"`). Whether they may use Eval is
// then asked of IAM like for a session (`mayUseEval`).
import { type AuthEnv, basicAuth, fromBase64url, iamFetch, IamUnavailableError, type SessionUser } from "./auth";

interface Jwk extends JsonWebKey { kid?: string }

const KEYS_TTL_MS = 10 * 60_000;
const NAME_TTL_MS = 10 * 60_000;
const CLOCK_TOLERANCE_SECONDS = 30;

const keySets = new Map<string, { keys: Jwk[]; expires: number }>();
const names = new Map<string, { name: string; expires: number }>();

async function iamKeys(env: AuthEnv, fetcher: typeof fetch, now: number, fresh: boolean): Promise<Jwk[]> {
  const hit = keySets.get(env.IAM_ORIGIN);
  if (hit && !fresh && hit.expires > now) return hit.keys;
  const response = await iamFetch(env, fetcher, "/.well-known/jwks.json", {});
  const json = await response.json().catch(() => null) as { keys?: unknown } | null;
  if (!response.ok || !Array.isArray(json?.keys)) throw new IamUnavailableError(`IAM JWKS → ${response.status}`);
  const keys = json.keys as Jwk[];
  keySets.set(env.IAM_ORIGIN, { keys, expires: now + KEYS_TTL_MS });
  return keys;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(fromBase64url(part)));
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The person an IAM access token names, or null when it is not a valid person's token from this IAM. */
export async function verifyIamToken(token: string, env: AuthEnv, fetcher: typeof fetch, now = Date.now()): Promise<string | null> {
  const [header, payload, signature, extra] = token.split(".");
  if (!header || !payload || !signature || extra !== undefined) return null;
  const head = decodeJson(header);
  const claims = decodeJson(payload);
  if (head?.alg !== "EdDSA" || !claims) return null;
  // A key IAM has just rotated in is not in the cached set yet: look once more before refusing.
  let keys = await iamKeys(env, fetcher, now, false);
  let jwk = keys.find((key) => key.kid === head.kid);
  if (!jwk) {
    keys = await iamKeys(env, fetcher, now, true);
    jwk = keys.find((key) => key.kid === head.kid);
  }
  if (!jwk) return null;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("Ed25519", key, fromBase64url(signature), new TextEncoder().encode(`${header}.${payload}`));
    if (!valid) return null;
  } catch {
    return null;
  }
  const seconds = Math.floor(now / 1000);
  const issuer = env.IAM_ORIGIN.replace(/\/+$/u, "");
  if (claims.iss !== issuer || typeof claims.exp !== "number" || claims.exp + CLOCK_TOLERANCE_SECONDS < seconds) return null;
  if (claims.typ !== "human" || typeof claims.sub !== "string" || !claims.sub) return null;
  return claims.sub;
}

/** The person's display name for the Eval API's audit actor; their id when IAM does not say. Cached. */
export async function principalName(principalId: string, env: AuthEnv, fetcher: typeof fetch, now = Date.now()): Promise<SessionUser> {
  const hit = names.get(principalId);
  if (hit && hit.expires > now) return { id: principalId, name: hit.name };
  const response = await iamFetch(env, fetcher, `/api/v1/app/principals/${encodeURIComponent(principalId)}`, { headers: { Authorization: basicAuth(env) } })
    .catch(() => null);
  const json = await response?.json().catch(() => null) as { msg?: { displayName?: unknown } } | null;
  const name = typeof json?.msg?.displayName === "string" && json.msg.displayName.trim() ? json.msg.displayName.trim() : principalId;
  if (response?.ok) names.set(principalId, { name, expires: now + NAME_TTL_MS });
  return { id: principalId, name };
}

export function clearIamTokenCachesForTest(): void {
  keySets.clear();
  names.clear();
}
