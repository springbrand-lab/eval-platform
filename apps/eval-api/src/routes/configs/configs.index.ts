import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./configs.handlers.js";
import * as routes from "./configs.routes.js";

const router = createRouter();
router.openapi(routes.execution.list, handlers.listExecution);
router.openapi(routes.execution.create, handlers.createExecution);
router.openapi(routes.execution.get, handlers.getExecution);
router.openapi(routes.execution.replace, handlers.replaceExecution);
router.openapi(routes.evaluation.list, handlers.listEvaluation);
router.openapi(routes.evaluation.create, handlers.createEvaluation);
router.openapi(routes.evaluation.get, handlers.getEvaluation);
router.openapi(routes.evaluation.replace, handlers.replaceEvaluation);
router.openapi(routes.pipeline.list, handlers.listPipeline);
router.openapi(routes.pipeline.create, handlers.createPipeline);
router.openapi(routes.pipeline.get, handlers.getPipeline);
router.openapi(routes.pipeline.replace, handlers.replacePipeline);

export default router;
