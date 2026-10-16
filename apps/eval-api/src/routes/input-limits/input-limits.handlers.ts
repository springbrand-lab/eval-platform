import { ok } from "@eval-platform/eval-contracts/http";
import type { AppRouteHandler } from "../../lib/types.js";
import { INPUT_LIMITS } from "../../limits.js";
import type * as routes from "./input-limits.routes.js";

export const get: AppRouteHandler<typeof routes.get> = (c) => ok(c, INPUT_LIMITS);
