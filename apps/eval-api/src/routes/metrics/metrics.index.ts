import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./metrics.handlers.js";
import * as routes from "./metrics.routes.js";

const router = createRouter();
router.openapi(routes.projectOverview, handlers.projectOverview);
router.openapi(routes.datasetOverview, handlers.datasetOverview);
router.openapi(routes.sampleOverview, handlers.sampleOverview);
router.openapi(routes.samplingDetail, handlers.samplingDetail);

export default router;
