import { ApiError, createHttpClient, parseHttpError, type HttpClient } from "@springbrand/http/client";
import { decodeError, isSpEditorErrorCode } from "@eval-platform/eval-contracts/http-errors";
import { httpOriginSchema } from "../config/env.js";

export type Fetch = typeof globalThis.fetch;

/** Eval SP answered with an HTTP failure; only safe public error fields are carried. */
export class EvalSpApiError extends Error {
  constructor(readonly status: number, readonly payload: unknown, options?: ErrorOptions) {
    super(`Eval SP API returned ${status}`, options);
    this.name = "EvalSpApiError";
  }
}

export class EvalSpTransportError extends Error {
  constructor(cause: unknown) {
    super("Eval SP request failed", { cause });
    this.name = "EvalSpTransportError";
  }
}

/** Common dependency diagnostics for the authenticated API and read-only observation clients. */
export function throwSpClientError(error: unknown): never {
  if (!(error instanceof ApiError) || error.kind === "input" || error.kind === "runtime") throw error;
  if (error.kind !== "http") throw new EvalSpTransportError(error);
  throw new EvalSpApiError(error.status, {
    code: error.code,
    errMsg: error.message,
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    ...(error.errors === undefined ? {} : { errors: error.errors }),
    ...(error.details === undefined ? {} : { details: error.details }),
  }, { cause: error });
}

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
    decodeError: (data, info) => {
      const parsed = parseHttpError(data, info);
      return isSpEditorErrorCode(parsed.code) ? decodeError(data, info) : parsed;
    },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
    ...(headers === undefined ? {} : { getHeaders: () => ({ ...headers }) }),
    ...(fetch === undefined ? {} : { fetch }),
  });
}
