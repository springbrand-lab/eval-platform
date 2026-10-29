import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../lib/types.js";

/**
 * Scopes every protected request to the fixed Eval SP service account verified at startup.
 * There is no interactive login, so requests carry no credentials and cannot choose an owner.
 */
export const serviceAccountScope: MiddlewareHandler<AppBindings> = async (c, next) => {
  const { user, sessionToken } = c.env.serviceAccount;
  const { services, release } = c.env.ownerServices(user, sessionToken);
  try {
    c.set("user", user);
    c.set("sessionToken", sessionToken);
    c.set("services", services);
    await next();
  } finally {
    release();
  }
};
