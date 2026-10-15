import type pino from "pino";
import { createApp } from "./lib/create-app.js";
import { serviceAccountScope } from "./middlewares/service-account.js";
import agentConfigRouter from "./routes/agent-configs/agent-configs.index.js";
import agentRouter from "./routes/agents/agents.index.js";
import bundleRouter from "./routes/bundles/bundles.index.js";
import configRouter from "./routes/configs/configs.index.js";
import creditRouter from "./routes/credits/credits.index.js";
import dataRouter from "./routes/data/data.index.js";
import datasetRouter from "./routes/datasets/datasets.index.js";
import healthRouter from "./routes/health/health.index.js";
import metricsRouter from "./routes/metrics/metrics.index.js";
import outputSchemaRouter from "./routes/output-schemas/output-schemas.index.js";
import projectRouter from "./routes/projects/projects.index.js";
import runRouter from "./routes/runs/runs.index.js";
import sampleRouter from "./routes/samples/samples.index.js";
import sessionRouter from "./routes/session/session.index.js";

/** Builds the Eval API route table; every `/api/*` route runs as the fixed Eval SP service account. */
export function createRoutes(logger: pino.Logger) {
  const app = createApp(logger);
  app.use("/api/*", serviceAccountScope);
  app.route("/", healthRouter);
  app.route("/api/me", sessionRouter);
  app.route("/api/agent-configs", agentConfigRouter);
  app.route("/api/agents", agentRouter);
  app.route("/api/credits", creditRouter);
  app.route("/api/projects", projectRouter);
  app.route("/api", runRouter);
  app.route("/api/datasets", datasetRouter);
  app.route("/api/data", dataRouter);
  app.route("/api/samples", sampleRouter);
  app.route("/api/configs", configRouter);
  app.route("/api/metrics", metricsRouter);
  app.route("/api/bundles", bundleRouter);
  app.route("/api/evaluation-output-schemas", outputSchemaRouter);
  return app;
}
