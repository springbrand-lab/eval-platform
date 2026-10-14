import type { Server } from "node:http";
import { Pool } from "pg";
import { createEvalDb } from "./db/client.js";
import { requireEvalSpRelease } from "./db/release.js";
import { createIndependentEvaluationHttpServer } from "./independent-evaluation-http.js";
import { createPostgresIndependentEvaluationApi } from "./independent-evaluation-postgres.js";
import { createEvalSpClient } from "./sp/client.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function portEnv(): number {
  const value = process.env.EVAL_API_PORT;
  if (value === undefined) return 3000;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("EVAL_API_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(port, host, () => {
      server.off("error", failed);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function main(): Promise<void> {
  const databaseUrl = requiredEnv("DATABASE_URL");
  const spOrigin = requiredEnv("EVAL_SP_ORIGIN");
  const webOrigin = requiredEnv("EVAL_WEB_ORIGIN");
  const release = requireEvalSpRelease({
    sourceBranch: requiredEnv("EVAL_SP_SOURCE_BRANCH"),
    sourceCommit: requiredEnv("EVAL_SP_SOURCE_COMMIT"),
  });
  const host = process.env.EVAL_API_HOST ?? "0.0.0.0";
  const port = portEnv();
  const pool = new Pool({ connectionString: databaseUrl });
  const api = createPostgresIndependentEvaluationApi({
    db: createEvalDb(pool),
    release,
    spClient: createEvalSpClient({ origin: spOrigin, writeOrigin: webOrigin }),
    webOrigin,
  });
  const server = createIndependentEvaluationHttpServer(api);
  try {
    await listen(server, host, port);
  } catch (error) {
    await pool.end();
    throw error;
  }
  console.info(`Eval API listening on ${host}:${port}`);

  let closing: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    closing ??= (async () => {
      await close(server);
      await pool.end();
    })();
    return closing;
  };
  const onSignal = (): void => {
    void stop().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
