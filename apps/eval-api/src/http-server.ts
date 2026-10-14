import type { Server } from "node:http";
import { createNodeFetchServer } from "./node-fetch-server.js";

export interface EvalHttpServer {
  readonly server: Server;
  close(): Promise<void>;
}

/** Bind a Fetch-style API handler to Node without changing its authentication boundary. */
export async function startEvalHttpServer(
  handler: (request: Request) => Promise<Response>,
  options: { readonly host: string; readonly port: number },
): Promise<EvalHttpServer> {
  const server = createNodeFetchServer(handler, {
    invalidTarget: () => Response.json({ error: { code: "invalid_request", message: "Invalid request target" } }, { status: 400 }),
    unexpected: () => Response.json({ error: { code: "internal_error", message: "Internal server error" } }, { status: 500 }),
    onError: (error) => console.error(error),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, close: () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }) };
}
