import { createHttpClient, type HttpClient } from "@springbrand/http/client";
import { httpOriginSchema } from "../config/env.js";

export type Fetch = typeof globalThis.fetch;

/** The one HTTP transport for every Eval SP seam: origin-bound, redirect-free, time- and size-bounded. */
export function createSpHttpClient(input: {
  readonly origin: string;
  readonly responseMode: "envelope" | "json";
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: Fetch | undefined;
}): HttpClient {
  const { timeoutMs, maxResponseBytes, headers, fetch } = input;
  return createHttpClient({
    baseUrl: httpOriginSchema.parse(input.origin),
    responseMode: input.responseMode,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
    ...(headers === undefined ? {} : { getHeaders: () => ({ ...headers }) }),
    ...(fetch === undefined ? {} : { fetch }),
  });
}
