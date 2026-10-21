import pino from "pino";
import { startAgentImportWorkerProcess } from "./agent-import-worker-process.js";
import { loadAgentImportWorkerConfig } from "./config/agent-imports.js";
import { errorDiagnostics } from "./lib/api-errors.js";
import { loggerOptions } from "./middlewares/pino-logger.js";

const logger = pino(loggerOptions);
try {
  const worker = await startAgentImportWorkerProcess(loadAgentImportWorkerConfig(process.env), logger);
  logger.info({ enabled: worker.enabled }, "agent_import_worker_started");
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    worker.close().then(() => process.exit(0), (error: unknown) => {
      logger.error({ error: errorDiagnostics(error) }, "agent_import_worker_shutdown_failed");
      process.exit(1);
    });
  });
} catch (error) {
  logger.fatal({ error: errorDiagnostics(error) }, "agent_import_worker_start_failed");
  process.exit(1);
}
