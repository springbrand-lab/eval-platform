import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { MiddlewareHandler } from "hono";
import { sameSecret } from "../lib/secret.js";
import type { AppBindings, WebActor } from "../lib/types.js";

export const WEB_TOKEN_HEADER = "X-Eval-Web-Token";
export const ACTOR_HEADER = "X-Eval-Actor";

/** The takt user the eval-web Worker verified; URI-encoded JSON `{id, name}`. Invalid values are ignored. */
export function readActor(header: string | undefined): WebActor | undefined {
  if (!header) return undefined;
  try {
    const value = JSON.parse(decodeURIComponent(header)) as { id?: unknown; name?: unknown };
    if (typeof value.id !== "string" || !value.id || value.id.length > 200) return undefined;
    const name = typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, 100) : value.id;
    return { id: value.id, name };
  } catch {
    return undefined;
  }
}

/**
 * With a configured Web token, `/api/*` accepts only requests forwarded by the eval-web Worker, which has
 * already verified the takt user. Without one (local development) every caller on the trusted network is accepted.
 */
export const webGateway: MiddlewareHandler<AppBindings> = async (c, next) => {
  const expected = c.env.webApiToken;
  if (expected !== undefined) {
    const given = c.req.header(WEB_TOKEN_HEADER);
    if (!given || !sameSecret(expected, given)) throw new HttpError("AUTH_UNAUTHENTICATED", "Requests must come through Eval Web");
  }
  const actor = readActor(c.req.header(ACTOR_HEADER));
  if (actor) c.set("actor", actor);
  await next();
};
