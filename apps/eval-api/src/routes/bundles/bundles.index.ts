import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./bundles.handlers.js";
import * as routes from "./bundles.routes.js";

const router = createRouter();
router.openapi(routes.listBundles, handlers.listBundles);
router.openapi(routes.createBundle, handlers.createBundle);
router.openapi(routes.getBundle, handlers.getBundle);
router.openapi(routes.updateBundle, handlers.updateBundle);
router.openapi(routes.deleteBundle, handlers.deleteBundle);
router.openapi(routes.listMaterials, handlers.listMaterials);
router.openapi(routes.createMaterial, handlers.createMaterial);
router.openapi(routes.getMaterial, handlers.getMaterial);
router.openapi(routes.updateMaterial, handlers.updateMaterial);
router.openapi(routes.deleteMaterial, handlers.deleteMaterial);
router.openapi(routes.listSessions, handlers.listSessions);
router.openapi(routes.createSession, handlers.createSession);
router.openapi(routes.getSession, handlers.getSession);
router.openapi(routes.updateSession, handlers.updateSession);
router.openapi(routes.deleteSession, handlers.deleteSession);

export default router;
