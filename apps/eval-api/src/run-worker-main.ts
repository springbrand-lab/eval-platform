import { errorDiagnostics } from "@springbrand/http/server";
import pino from "pino";
import { loadWorkerConfig } from "./config/worker.js";
import { startSpEvalRunWorkerProcess } from "./run-worker-process.js";

const logger = pino({ level: "info", base: null });

try {
  const worker = await startSpEvalRunWorkerProcess(loadWorkerConfig(process.env), logger);
  logger.info("run_worker_started");
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      worker.close().then(() => process.exit(0), (error: unknown) => {
        logger.error({ error: errorDiagnostics(error) }, "run_worker_shutdown_failed");
        process.exit(1);
      });
    });
  }
} catch (error) {
  logger.fatal({ error: errorDiagnostics(error) }, "run_worker_start_failed");
  process.exit(1);
}
