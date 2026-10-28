import type pino from "pino";
import { createApp } from "./lib/create-app.js";
import { serviceAccountScope } from "./middlewares/service-account.js";
import { webGateway } from "./middlewares/web-gateway.js";
import agentConfigRouter from "./routes/agent-configs/agent-configs.index.js";
import agentImportRouter from "./routes/agent-imports/agent-imports.index.js";
import agentRouter from "./routes/agents/agents.index.js";
import agentLibraryRouter from "./routes/agent-library/agent-library.index.js";
import creditRouter from "./routes/credits/credits.index.js";
import dataRouter from "./routes/data/data.index.js";
import dashboardRouter from "./routes/dashboards/dashboards.index.js";
import datasetRouter from "./routes/datasets/datasets.index.js";
import evaluationResultsMcpRouter from "./evaluation-results/mcp.js";
import healthRouter from "./routes/health/health.index.js";
import inputLimitsRouter from "./routes/input-limits/input-limits.index.js";
import materialBundleRouter from "./routes/material-bundles/material-bundles.index.js";
import metricsRouter from "./routes/metrics/metrics.index.js";
import outputSchemaRouter from "./routes/output-schemas/output-schemas.index.js";
import projectRouter from "./routes/projects/projects.index.js";
import runRouter from "./routes/runs/runs.index.js";
import sessionBundleRouter from "./routes/session-bundles/session-bundles.index.js";
import sessionRouter from "./routes/session/session.index.js";

/** Builds the Eval API route table; every `/api/*` route passes the Web gateway and runs as the fixed Eval SP service account. */
export function createRoutes(logger: pino.Logger) {
  const app = createApp(logger);
  app.use("/api/*", webGateway);
  app.use("/api/*", serviceAccountScope);
  app.route("/", healthRouter);
  // Called by Eval SP's Evaluator runtime with its own Bearer token, not by Eval Web.
  app.route("/", evaluationResultsMcpRouter);
  app.route("/api/me", sessionRouter);
  app.route("/api/input-limits", inputLimitsRouter);
  app.route("/api/dashboards", dashboardRouter);
  app.route("/api/agent-configs", agentConfigRouter);
  app.route("/api/agent-config-sync", agentImportRouter);
  app.route("/api/agent-library", agentLibraryRouter);
  app.route("/api/agents", agentRouter);
  app.route("/api/credits", creditRouter);
  app.route("/api/projects", projectRouter);
  app.route("/api", runRouter);
  app.route("/api/datasets", datasetRouter);
  app.route("/api/data", dataRouter);
  app.route("/api/metrics", metricsRouter);
  app.route("/api/material-bundles", materialBundleRouter);
  app.route("/api/session-bundles", sessionBundleRouter);
  app.route("/api/evaluation-output-schemas", outputSchemaRouter);
  return app;
}
