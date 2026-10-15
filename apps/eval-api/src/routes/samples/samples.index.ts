import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./samples.handlers.js";
import * as routes from "./samples.routes.js";

const router = createRouter();
router.openapi(routes.list, handlers.list);
router.openapi(routes.create, handlers.create);
router.openapi(routes.get, handlers.get);

export default router;
