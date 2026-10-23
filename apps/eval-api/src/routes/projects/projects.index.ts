import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./projects.handlers.js";
import * as routes from "./projects.routes.js";

const router = createRouter();
router.openapi(routes.list, handlers.list);
router.openapi(routes.create, handlers.create);
router.openapi(routes.get, handlers.get);
router.openapi(routes.evaluationOutputSchema, handlers.evaluationOutputSchema);
router.openapi(routes.evaluationResults, handlers.evaluationResults);
router.openapi(routes.remove, handlers.remove);
router.openapi(routes.replaceEvaluationPlan, handlers.replaceEvaluationPlan);
router.openapi(routes.observeSampling, handlers.observeSampling);
router.openapi(routes.observeEvaluation, handlers.observeEvaluation);
// The file route is registered first so `file` is never read as a JSON part.
router.openapi(routes.observeFile, handlers.observeFile);
router.openapi(routes.observeChat, handlers.observeChat);
router.openapi(routes.resourceSnapshot, handlers.resourceSnapshot);

export default router;
