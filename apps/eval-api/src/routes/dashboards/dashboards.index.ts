import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./dashboards.handlers.js";
import * as routes from "./dashboards.routes.js";

const router = createRouter();
router.openapi(routes.list, handlers.list);
router.openapi(routes.create, handlers.create);
router.openapi(routes.get, handlers.get);
router.openapi(routes.update, handlers.update);

export default router;
