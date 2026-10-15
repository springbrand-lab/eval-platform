import { serve } from "@hono/node-server";
import { Pool } from "pg";
import pino from "pino";
import { createRoutes } from "./app.js";
import { loadApiConfig } from "./config/api.js";
import { createEvalDb } from "./db/client.js";
import { errorDiagnostics } from "./lib/api-errors.js";
import type { ApiRuntime } from "./lib/types.js";
import { loggerOptions } from "./middlewares/pino-logger.js";
import { createOwnerServices } from "./owner-services.js";
import { openBundleDirectory } from "./sp/bundle-directory.js";
import { createEvalSpClient } from "./sp/client.js";

const logger = pino(loggerOptions);
const config = loadApiConfig(process.env);
const bundles = await openBundleDirectory(config.EVAL_BUNDLE_DIR);
const pool = new Pool({ connectionString: config.DATABASE_URL });
const sp = createEvalSpClient({ origin: config.EVAL_SP_API_ORIGIN, writeOrigin: config.EVAL_WEB_ORIGIN });
const runtime: ApiRuntime = {
  webOrigin: config.EVAL_WEB_ORIGIN,
  sp,
  ownerServices: createOwnerServices({ db: createEvalDb(pool), sp, bundles, release: config.release }),
};
const app = createRoutes(logger);
const server = serve({
  fetch: (request) => app.fetch(request, runtime),
  hostname: config.EVAL_API_HOST,
  port: config.EVAL_API_PORT,
});

logger.info({ event: "api_started", host: config.EVAL_API_HOST, port: config.EVAL_API_PORT }, "Eval API started");

/** Stop accepting requests, let in-flight requests finish, then close the database pool. */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      pool.end().then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error({ event: "api_shutdown_failed", error: errorDiagnostics(error) }, "Eval API shutdown failed");
          process.exit(1);
        },
      );
    });
  });
}
