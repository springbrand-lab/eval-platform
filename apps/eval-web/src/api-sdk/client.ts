import { ApiError, createHttpClient, type HttpRequestOptions } from "@springbrand/http/client";
import { decodeError } from "@eval-platform/eval-contracts/http-errors";
import { currentToken, markForbidden, markUnauthorized } from "@/auth/session";

export { ApiError };

/** The Worker answers 403 with this code when the takt user lacks the Eval menu. */
export const ACCESS_DENIED_CODE = "EVAL_ACCESS_DENIED";

const client = createHttpClient({
  baseUrl: typeof window === "undefined" ? "http://localhost" : window.location.origin,
  responseMode: "envelope",
  decodeError,
  timeoutMs: 60_000,
  maxResponseBytes: Number.MAX_SAFE_INTEGER,
  getToken: currentToken,
  onUnauthorized: () => markUnauthorized(),
});

function watch<T>(pending: Promise<T>): Promise<T> {
  return pending.catch((error: unknown) => {
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
  delete: <T = void>(path: string, options?: HttpRequestOptions) => watch(client.delete<T>(path, options)),
  /** Text endpoints such as Dataset export, outside the JSON envelope. */
  text: (path: string, options?: HttpRequestOptions) =>
    watch(client.get<string>(path, { ...options, responseMode: "text" })),
  blob: (path: string, options?: HttpRequestOptions) =>
    watch(client.get<Blob>(path, { ...options, responseMode: "blob" })),
};

export const enc = encodeURIComponent;
