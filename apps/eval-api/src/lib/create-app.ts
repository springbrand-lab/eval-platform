import { OpenAPIHono } from "@hono/zod-openapi";
import { httpError, httpNotFound, httpValidationError } from "@eval-platform/eval-contracts/http";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import type pino from "pino";
import { pinoLogger } from "../middlewares/pino-logger.js";
import { allowedCorsOrigin, trustedOrigin } from "../middlewares/trusted-origin.js";
import { apiError } from "./api-errors.js";
import type { AppBindings } from "./types.js";

const validationHook = (
  result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } },
  c: Parameters<typeof httpValidationError>[0],
) => {
  if (!result.success && result.error) {
    return httpValidationError(
      c,
      result.error.issues.map((issue) => ({ path: issue.path.join("."), errMsg: issue.message })),
    );
  }
};

export function createApp(logger: pino.Logger) {
  const app = new OpenAPIHono<AppBindings>({ defaultHook: validationHook });

  app.use(requestId());
  app.use(pinoLogger(logger));
  app.use(trustedOrigin);
  app.use(cors({
    origin: allowedCorsOrigin,
    allowHeaders: ["Authorization", "Content-Type", "X-Eval-Web-Token", "X-Eval-Actor"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: ["X-Request-ID"],
    maxAge: 86400,
  }));

  app.notFound((c) => httpNotFound(c, "Route not found"));
  app.onError((error, c) => httpError(c, apiError(error)));

  return app;
}

export function createRouter() {
  return new OpenAPIHono<AppBindings>({ defaultHook: validationHook });
}
