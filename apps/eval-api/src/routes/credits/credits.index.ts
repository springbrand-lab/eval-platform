import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./credits.handlers.js";
import * as routes from "./credits.routes.js";

const router = createRouter();
router.openapi(routes.balance, handlers.balance);
router.openapi(routes.listGrants, handlers.listGrants);
router.openapi(routes.grant, handlers.grant);

export default router;
