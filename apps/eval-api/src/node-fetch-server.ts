import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

export interface NodeFetchServerErrors {
  readonly invalidTarget: () => Response;
  readonly unexpected: () => Response;
  readonly onError?: (error: unknown) => void;
}

function webRequest(input: IncomingMessage): Request | null {
  const target = input.url ?? "";
  if (!target.startsWith("/")) return null;
  const headers = new Headers();
  for (const [key, value] of Object.entries(input.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, value);
  }
  const method = input.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(input);
  return new Request(new URL(target, "http://localhost"), {
    method,
    headers,
    ...(body ? { body, duplex: "half" } : {}),
  } as RequestInit);
}

async function send(output: ServerResponse, response: Response): Promise<void> {
  output.statusCode = response.status;
  response.headers.forEach((value, key) => output.setHeader(key, value));
  output.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

/** Shared Node transport; each API keeps its own error envelope and authentication. */
export function createNodeFetchServer(
  handler: (request: Request) => Promise<Response>,
  errors: NodeFetchServerErrors,
): Server {
  return createServer((input, output) => {
    void (async () => {
      try {
        const request = webRequest(input);
        await send(output, request ? await handler(request) : errors.invalidTarget());
      } catch (error) {
        try { errors.onError?.(error); } catch { /* Reporting cannot alter the response. */ }
        if (output.headersSent) output.destroy(error instanceof Error ? error : undefined);
        else await send(output, errors.unexpected());
      }
    })();
  });
}
