import { ApiError, createHttpClient, type HttpRequestOptions } from "@springbrand/http/client";
import { decodeError } from "@eval-platform/eval-contracts/http-errors";
import { markForbidden, markUnauthorized } from "@/auth/session";
import { apiOrigin, hosted, hostAccessToken } from "@/lib/host";

export { ApiError };

/** The Worker answers 403 with this code when IAM does not let the person use Eval. */
export const ACCESS_DENIED_CODE = "EVAL_ACCESS_DENIED";

/**
 * Inside the main App, Eval's API is on another origin: send the person's IAM access token, and on a
 * 401 once more with a token re-issued from the IAM session (tokens last 15 minutes).
 */
const hostedFetch: typeof fetch = async (input, init) => {
  const send = async (refresh: boolean) => {
    const headers = new Headers(init?.headers);
    const token = await hostAccessToken(refresh);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers, credentials: "omit" });
  };
  const response = await send(false);
  return response.status === 401 ? send(true) : response;
};

const client = createHttpClient({
  baseUrl: apiOrigin,
  ...(hosted ? { fetch: hostedFetch } : {}),
  responseMode: "envelope",
  decodeError,
  timeoutMs: 60_000,
  maxResponseBytes: Number.MAX_SAFE_INTEGER,
  // The session is the Worker's HttpOnly cookie. Without this the SDK's fetch adapter sends no cookies at all.
  credentials: "include",
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
