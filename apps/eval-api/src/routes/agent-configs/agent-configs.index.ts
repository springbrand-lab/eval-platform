import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./agent-configs.handlers.js";
import * as routes from "./agent-configs.routes.js";

const router = createRouter();
router.openapi(routes.list, handlers.list);
router.openapi(routes.create, handlers.create);
router.openapi(routes.get, handlers.get);
router.openapi(routes.update, handlers.update);
router.openapi(routes.remove, handlers.remove);

export default router;
