import { createHonoHttp } from "@springbrand/http/hono";
import { errorCatalog } from "./http-errors.js";

/** Server-side Hono responders for the Eval API; the error-code catalog lives in `./http-errors`. */
export const {
  ok,
  httpError,
  httpErrorResponse,
  httpUnauthorized,
  httpNotFound,
  httpValidationError,
  httpRateLimited,
  httpInternalError,
} = createHonoHttp(errorCatalog);
