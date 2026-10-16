import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./datasets.handlers.js";
import * as routes from "./datasets.routes.js";

const router = createRouter();
router.openapi(routes.list, handlers.list);
router.openapi(routes.create, handlers.create);
router.openapi(routes.importDocument, handlers.importDocument);
router.openapi(routes.importPrompt, handlers.importPrompt);
router.openapi(routes.get, handlers.get);
router.openapi(routes.replace, handlers.replace);
router.openapi(routes.remove, handlers.remove);
router.openapi(routes.listData, handlers.listData);
router.openapi(routes.importData, handlers.importData);
router.openapi(routes.attachData, handlers.attachData);
router.openapi(routes.detachData, handlers.detachData);
router.openapi(routes.exportDocument, handlers.exportDocument);

export default router;
