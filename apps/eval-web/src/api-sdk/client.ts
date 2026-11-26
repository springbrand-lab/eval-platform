import { ApiError, createHttpClient, type HttpRequestOptions } from "@springbrand/http/client";
import { decodeError } from "@eval-platform/eval-contracts/http-errors";
import { markForbidden, markUnauthorized } from "@/auth/session";
import { apiOrigin, hosted, hostAccessToken } from "@/lib/host";

export { ApiError };

/** The Worker answers 403 with this code when IAM does not let the person use Eval. */
export const ACCESS_DENIED_CODE = "EVAL_ACCESS_DENIED";

/**
 * Inside the main App, Eval's API is on another origin: no cookie, the person's IAM access token instead,
 * and a token re-issued from the IAM session after a 401 (tokens last 15 minutes). Outside it, the
 * session is the Worker's HttpOnly cookie, which the SDK sends only with credentials "include".
 */
const client = createHttpClient({
  baseUrl: apiOrigin,
  ...(hosted
    ? { credentials: "omit", getToken: () => hostAccessToken(), refreshToken: () => hostAccessToken(true) }
    : { credentials: "include" }),
  responseMode: "envelope",
  decodeError,
  timeoutMs: 60_000,
  maxResponseBytes: Number.MAX_SAFE_INTEGER,
});

function watch<T>(pending: Promise<T>): Promise<T> {
  return pending.catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) markUnauthorized();
    if (error instanceof ApiError && error.status === 403 && error.code === ACCESS_DENIED_CODE) markForbidden();
    throw error;
  });
}

export const api = {
  request: <T>(path: string, options?: HttpRequestOptions) => watch(client.request<T>(path, options)).then((result) => result.data),
  get: <T>(path: string, options?: HttpRequestOptions) => watch(client.get<T>(path, options)),
  post: <T>(path: string, body?: unknown, options?: HttpRequestOptions) => watch(client.post<T>(path, body, options)),
  put: <T>(path: string, body?: unknown, options?: HttpRequestOptions) => watch(client.put<T>(path, body, options)),
  patch: <T>(path: string, body?: unknown, options?: HttpRequestOptions) => watch(client.patch<T>(path, body, options)),
  delete: <T = void>(path: string, options?: HttpRequestOptions) =>
    watch(client.delete<T>(path, { ...options, responseMode: "json" })),
  /** Text endpoints such as Dataset export, outside the JSON envelope. */
  text: (path: string, options?: HttpRequestOptions) =>
    watch(client.get<string>(path, { ...options, responseMode: "text" })),
  blob: (path: string, options?: HttpRequestOptions) =>
    watch(client.get<Blob>(path, { ...options, responseMode: "blob" })),
};

export const enc = encodeURIComponent;
