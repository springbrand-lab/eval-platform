import { serve } from "@hono/node-server";
import { Pool } from "pg";
import pino from "pino";
import { createRoutes } from "./app.js";
import { loadApiConfig } from "./config/api.js";
import { createEvalDb } from "./db/client.js";
import { createPostgresEvaluationSubmissions } from "./db/evaluation-submissions.js";
import { createLangfuseScorePublisher } from "./langfuse/scores.js";
import { errorDiagnostics } from "./lib/api-errors.js";
import type { ApiRuntime } from "./lib/types.js";
import { loggerOptions } from "./middlewares/pino-logger.js";
import { createOwnerServices } from "./owner-services.js";
import { startRunQueue } from "./run-worker-queue.js";
import { openBundleDirectory } from "./sp/bundle-directory.js";
import { createEvalSpClient } from "./sp/client.js";
import { createSpObservationClient } from "./sp/observation.js";

const logger = pino(loggerOptions);
const config = loadApiConfig(process.env);
const bundles = await openBundleDirectory(config.EVAL_BUNDLE_DIR);
const pool = new Pool({ connectionString: config.DATABASE_URL });
const runQueue = await startRunQueue(config.DATABASE_URL, logger);
const sp = createEvalSpClient({ origin: config.EVAL_SP_API_ORIGIN, writeOrigin: config.EVAL_WEB_ORIGIN });
const serviceUser = await sp.verifySession(config.EVAL_SP_SERVICE_SESSION_TOKEN);
if (serviceUser?.id !== config.EVAL_SP_SERVICE_USER_ID || !serviceUser.email) {
  throw new Error("EVAL_SP_SERVICE_SESSION_TOKEN does not belong to EVAL_SP_SERVICE_USER_ID");
}
const db = createEvalDb(pool);
const runtime: ApiRuntime = {
  webOrigin: config.EVAL_WEB_ORIGIN,
  ...(config.EVAL_WEB_API_TOKEN === undefined ? {} : { webApiToken: config.EVAL_WEB_API_TOKEN }),
  sp,
  observation: createSpObservationClient({
    agentOrigin: config.EVAL_SP_AGENT_ORIGIN,
    apiOrigin: config.EVAL_SP_API_ORIGIN,
    trustedOrigin: config.EVAL_SP_TRUSTED_ORIGIN,
    sessionToken: config.EVAL_SP_SERVICE_SESSION_TOKEN,
  }),
  serviceAccount: { user: serviceUser, email: serviceUser.email, sessionToken: config.EVAL_SP_SERVICE_SESSION_TOKEN },
  spAdminToken: config.EVAL_SP_ADMIN_TOKEN,
  ownerServices: createOwnerServices({
    db, sp, bundles, release: config.release, runQueue,
    ...(config.langfuse === undefined ? {} : { publishScore: createLangfuseScorePublisher({ config: config.langfuse }) }),
  }),
  ...(config.EVAL_RESULT_MCP_TOKEN === undefined ? {} : { evaluationResults: {
    token: config.EVAL_RESULT_MCP_TOKEN,
    submissions: createPostgresEvaluationSubmissions(db),
  } }),
};
const app = createRoutes(logger);
const server = serve({
  fetch: (request) => app.fetch(request, runtime),
  hostname: config.EVAL_API_HOST,
  port: config.EVAL_API_PORT,
});

logger.info({ event: "api_started", host: config.EVAL_API_HOST, port: config.EVAL_API_PORT }, "Eval API started");

/** Stop accepting requests, let in-flight requests finish, then close the Run queue and the database pool. */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      runQueue.close().then(() => pool.end()).then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error({ event: "api_shutdown_failed", error: errorDiagnostics(error) }, "Eval API shutdown failed");
          process.exit(1);
        },
      );
    });
  });
}
