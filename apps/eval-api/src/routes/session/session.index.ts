import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./session.handlers.js";
import * as routes from "./session.routes.js";

const router = createRouter();
router.openapi(routes.me, handlers.me);

export default router;
