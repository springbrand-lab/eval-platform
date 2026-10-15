import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { Context, MiddlewareHandler } from "hono";
import type { AppBindings } from "../lib/types.js";

/** Browsers may call the API only from Eval Web; requests without an Origin are non-browser clients. */
export const trustedOrigin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== c.env.webOrigin) throw new HttpError("REQUEST_UNTRUSTED_ORIGIN");
  await next();
};

export function allowedCorsOrigin(origin: string, c: Context<AppBindings>): string | undefined {
  return origin === c.env.webOrigin ? origin : undefined;
}
