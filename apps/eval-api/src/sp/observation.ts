import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { Fetch } from "./http.js";

/** One Eval SP Chat of the service account. */
export interface ChatRef {
  readonly ownerUserId: string;
  readonly chatId: string;
}

export interface TrajectoryQuery {
  readonly limit?: number;
  readonly beforeSeq?: number;
}

export interface WorkspaceFile {
  readonly body: ReadableStream<Uint8Array> | null;
  readonly contentType: string;
  readonly contentLength: string | null;
}

/** GET-only reads of Chats the service account owns; nothing here can drive an Agent. */
export interface SpObservationClient {
  messages(chat: ChatRef): Promise<unknown>;
  tree(chat: ChatRef): Promise<unknown>;
  file(chat: ChatRef, path: string): Promise<WorkspaceFile>;
  trajectory(chat: ChatRef, query: TrajectoryQuery): Promise<unknown>;
}

const TIMEOUT_MS = 30_000;
/** Workspace files above this size are offered for download only by Eval SP itself, never through Eval. */
export const OBSERVATION_FILE_BYTES = 10_000_000;

function relay(status: number): HttpError {
  if (status === 401 || status === 403) return new HttpError("EVAL_SP_FORBIDDEN");
  if (status === 404) return new HttpError("EVAL_SP_NOT_FOUND");
  if (status === 429) return new HttpError("REQUEST_RATE_LIMITED");
  if (status >= 500) return new HttpError("EVAL_SP_UNAVAILABLE");
  return new HttpError("EVAL_SP_REQUEST_FAILED");
}

export function createSpObservationClient(input: {
  readonly agentOrigin: string;
  readonly apiOrigin: string;
  /** An Origin Eval SP trusts for browser reads; the reads are made server-side with the service session. */
  readonly trustedOrigin: string;
  readonly sessionToken: string;
  readonly fetch?: Fetch;
}): SpObservationClient {
  const send = input.fetch ?? globalThis.fetch;
  const headers = { Authorization: `Bearer ${input.sessionToken}`, Origin: input.trustedOrigin };
  const chatPath = (chat: ChatRef, suffix: string) =>
    `/agents/inbox/${encodeURIComponent(chat.ownerUserId)}/chat-sockets/${encodeURIComponent(chat.chatId)}/${suffix}`;

  async function get(url: URL): Promise<Response> {
    let response: Response;
    try {
      response = await send(url, { headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (cause) {
      throw new HttpError("EVAL_SP_UNAVAILABLE", undefined, { cause });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw relay(response.status);
    }
    return response;
  }

  return {
    async messages(chat) {
      const url = new URL(chatPath(chat, "get-messages"), input.agentOrigin);
      url.searchParams.set("view", "hydration");
      return (await get(url)).json();
    },
    async tree(chat) {
      return (await get(new URL(chatPath(chat, "workspace/tree"), input.agentOrigin))).json();
    },
    async file(chat, path) {
      const url = new URL(chatPath(chat, "workspace/content"), input.agentOrigin);
      url.searchParams.set("path", path);
      const response = await get(url);
      const length = response.headers.get("content-length");
      if (length !== null && Number(length) > OBSERVATION_FILE_BYTES) {
        await response.body?.cancel();
        throw new HttpError("CATALOG_PAYLOAD_TOO_LARGE", "Workspace file is too large to preview");
      }
      return {
        body: response.body,
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
        contentLength: length,
      };
    },
    async trajectory(chat, query) {
      const url = new URL(`/api/chats/${encodeURIComponent(chat.chatId)}/trajectory`, input.apiOrigin);
      if (query.limit !== undefined) url.searchParams.set("limit", String(query.limit));
      if (query.beforeSeq !== undefined) url.searchParams.set("beforeSeq", String(query.beforeSeq));
      const envelope = await (await get(url)).json() as { success?: boolean; msg?: unknown };
      if (envelope.success !== true) throw new HttpError("EVAL_SP_REQUEST_FAILED");
      return envelope.msg;
    },
  };
}
