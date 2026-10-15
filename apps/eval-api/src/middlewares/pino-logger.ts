import type { Context } from "hono";
import { pinoLogger as honoPinoLogger } from "hono-pino";
import pino from "pino";
import { errorDiagnostics } from "../lib/api-errors.js";

export const loggerOptions: pino.LoggerOptions = {
  level: "info",
  base: null,
  redact: {
    paths: ["authorization", "headers.authorization", "req.headers.authorization"],
    censor: "[Redacted]",
  },
};

function responseLevel(c: Context): pino.Level {
  if (c.res.status >= 500) return "error";
  if (c.res.status >= 400) return "warn";
  return "info";
}

/** One structured line per request; failures carry the translated error's diagnostics, never raw bodies. */
export function pinoLogger(logger: pino.Logger) {
  return honoPinoLogger({
    pino: logger,
    http: {
      reqId: false,
      referRequestIdKey: "requestId",
      onReqBindings: (c) => ({ method: c.req.method, path: c.req.path }),
      onResBindings: (c) => ({
        status: c.res.status,
        ...(c.res.status >= 400 ? { error: errorDiagnostics(c.get("apiError") ?? c.error) } : {}),
      }),
      onResLevel: responseLevel,
      onResMessage: (c) => `${c.req.method} ${c.req.path} ${c.res.status}`,
    },
  });
}
