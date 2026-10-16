import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { ApiError, type HttpClient, type HttpRequestOptions } from "@springbrand/http/client";
import { createSpHttpClient, throwSpClientError, type Fetch } from "./http.js";

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

export function createSpObservationClient(input: {
  readonly agentOrigin: string;
  readonly apiOrigin: string;
  /** An Origin Eval SP trusts for browser reads; the reads are made server-side with the service session. */
  readonly trustedOrigin: string;
  readonly sessionToken: string;
  readonly fetch?: Fetch;
}): SpObservationClient {
  const headers = { Authorization: `Bearer ${input.sessionToken}`, Origin: input.trustedOrigin };
  const agent = createSpHttpClient({ origin: input.agentOrigin, responseMode: "json", timeoutMs: TIMEOUT_MS,
    maxResponseBytes: OBSERVATION_FILE_BYTES, headers, fetch: input.fetch });
  const api = createSpHttpClient({ origin: input.apiOrigin, responseMode: "envelope", timeoutMs: TIMEOUT_MS,
    maxResponseBytes: OBSERVATION_FILE_BYTES, headers, fetch: input.fetch });
  const chatPath = (chat: ChatRef, suffix: string) =>
    `/agents/inbox/${encodeURIComponent(chat.ownerUserId)}/chat-sockets/${encodeURIComponent(chat.chatId)}/${suffix}`;

  async function get<T>(http: HttpClient, path: string, options?: HttpRequestOptions) {
    try {
      return await http.request<T>(path, options);
    } catch (error) {
      if (options?.responseMode === "blob" && error instanceof ApiError && error.code === "RESPONSE_TOO_LARGE") {
        throw new HttpError("CATALOG_PAYLOAD_TOO_LARGE", "Workspace file is too large to preview", { cause: error });
      }
      throwSpClientError(error);
    }
  }

  return {
    async messages(chat) {
      return (await get(agent, chatPath(chat, "get-messages"), { params: { view: "hydration" } })).data;
    },
    async tree(chat) {
      return (await get(agent, chatPath(chat, "workspace/tree"))).data;
    },
    async file(chat, path) {
      // The shared transport counts actual streamed bytes before any response is relayed to Web.
      const { data } = await get<Blob>(agent, chatPath(chat, "workspace/content"), { params: { path }, responseMode: "blob" });
      return { body: data.stream(), contentType: data.type || "application/octet-stream", contentLength: String(data.size) };
    },
    async trajectory(chat, query) {
      return (await get(api, `/api/chats/${encodeURIComponent(chat.chatId)}/trajectory`, { params: { ...query } })).data;
    },
  };
}
