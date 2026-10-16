import pino from "pino";
import { createRoutes } from "./app.js";
import type { ApiRuntime } from "./lib/types.js";

export const WEB_ORIGIN = "https://eval-web.test";

/** Serve one in-process request through the full route table and its middleware. */
export function requestApp(runtime: ApiRuntime) {
  const app = createRoutes(pino({ level: "silent" }));
  return async (path: string, init: RequestInit = {}) => app.request(path, init, runtime);
}

/** Request options for an authenticated JSON call. */
export function jsonRequest(method: string, body: unknown, token = "session", headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

export function authorized(token = "session", init: RequestInit = {}): RequestInit {
  return { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } };
}
