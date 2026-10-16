import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./input-limits.handlers.js";
import * as routes from "./input-limits.routes.js";

export default createRouter().openapi(routes.get, handlers.get);
