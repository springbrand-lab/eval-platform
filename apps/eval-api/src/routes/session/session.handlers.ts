import { ok } from "@eval-platform/eval-contracts/http";
import type { AppRouteHandler } from "../../lib/types.js";
import type * as routes from "./session.routes.js";

export const me: AppRouteHandler<typeof routes.me> = (c) => ok(c, c.var.user);
