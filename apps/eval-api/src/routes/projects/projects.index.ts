import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./projects.handlers.js";
import * as routes from "./projects.routes.js";

const router = createRouter();
router.openapi(routes.list, handlers.list);
router.openapi(routes.create, handlers.create);
router.openapi(routes.get, handlers.get);
router.openapi(routes.bindOutputSchema, handlers.bindOutputSchema);

export default router;
