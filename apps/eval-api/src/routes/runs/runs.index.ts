import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./runs.handlers.js";
import * as routes from "./runs.routes.js";

const router = createRouter();
router.openapi(routes.startExecution, handlers.startExecution);
router.openapi(routes.startPipeline, handlers.startPipeline);
router.openapi(routes.getRun, handlers.getRun);
router.openapi(routes.evaluate, handlers.evaluate);
router.openapi(routes.getCurrentRun, handlers.getCurrentRun);
router.openapi(routes.stopRun, handlers.stopRun);
router.openapi(routes.syncRunScores, handlers.syncRunScores);
router.openapi(routes.getProjectRun, handlers.getProjectRun);
router.openapi(routes.listProjectRunEvaluations, handlers.listProjectRunEvaluations);
router.openapi(routes.listSuccessfulSamplings, handlers.listSuccessfulSamplings);
router.openapi(routes.selectSuccessfulSamplingIds, handlers.selectSuccessfulSamplingIds);
router.openapi(routes.getSampling, handlers.getSampling);
router.openapi(routes.listSamplingEvaluations, handlers.listSamplingEvaluations);
router.openapi(routes.getEvaluation, handlers.getEvaluation);

export default router;
