import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./agents.handlers.js";
import * as routes from "./agents.routes.js";

const router = createRouter();
router.openapi(routes.list, handlers.list);

export default router;
