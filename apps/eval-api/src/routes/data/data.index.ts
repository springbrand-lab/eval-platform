import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./data.handlers.js";
import * as routes from "./data.routes.js";

const router = createRouter();
router.openapi(routes.list, handlers.list);
router.openapi(routes.create, handlers.create);
router.openapi(routes.get, handlers.get);
router.openapi(routes.replace, handlers.replace);
router.openapi(routes.remove, handlers.remove);
router.openapi(routes.bindInitialResources, handlers.bindInitialResources);

export default router;
