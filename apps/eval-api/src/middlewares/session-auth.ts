import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../lib/types.js";

const BEARER = /^Bearer ([^\s,]+)$/iu;

/**
 * Verifies the Eval SP Bearer session on every protected request and scopes services to its user.
 * An unreachable SP propagates as its own error, never as an invalid session.
 */
export const sessionAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const token = BEARER.exec(c.req.header("authorization") ?? "")?.[1];
  if (!token) throw new HttpError("AUTH_UNAUTHENTICATED");
  const user = await c.env.sp.verifySession(token);
  if (!user) throw new HttpError("AUTH_UNAUTHENTICATED", "Eval SP session is invalid");
  const { services, release } = c.env.ownerServices(user, token);
  c.set("user", user);
  c.set("sessionToken", token);
  c.set("services", services);
  try {
    await next();
  } finally {
    release();
  }
};
