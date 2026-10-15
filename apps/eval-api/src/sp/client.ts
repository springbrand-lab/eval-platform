import { ApiError } from "@springbrand/http/client";
import { z } from "zod";
import { httpOriginSchema } from "../config/env.js";
import { createSpHttpClient, type Fetch } from "./http.js";

export interface EvalSpUser {
  readonly id: string;
  readonly role: "user" | "admin" | "super_admin";
}

export interface EvalSpAgentConfig {
  readonly id: string;
  readonly user_id: string;
  readonly name: string;
  readonly [field: string]: unknown;
}

/** Eval SP answered with an HTTP failure; `payload` is its error response body. */
export class EvalSpApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
    options?: ErrorOptions,
  ) {
    super(`Eval SP API returned ${status}`, options);
    this.name = "EvalSpApiError";
  }
}

/** Eval SP could not be reached or did not return a usable response. */
export class EvalSpTransportError extends Error {
  constructor(cause: unknown) {
    super("Eval SP request failed", { cause });
    this.name = "EvalSpTransportError";
  }
}

export interface EvalSpClient {
  verifySession(token: string): Promise<EvalSpUser | null>;
  listAgentConfigs(token: string): Promise<readonly EvalSpAgentConfig[]>;
  getAgentConfig(token: string, id: string): Promise<EvalSpAgentConfig>;
  createAgentConfig(token: string, input: unknown): Promise<EvalSpAgentConfig>;
  updateAgentConfig(token: string, id: string, input: unknown): Promise<EvalSpAgentConfig>;
  deleteAgentConfig(token: string, id: string): Promise<unknown>;
}

const sessionSchema = z.object({
  user: z.object({ id: z.string().min(1), role: z.enum(["user", "admin", "super_admin"]) }),
});
const agentConfigSchema = z.looseObject({ id: z.string().min(1), user_id: z.string().min(1), name: z.string() });

function read<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EvalSpTransportError(parsed.error);
  return parsed.data;
}

function configPath(id: string): string {
  if (typeof id !== "string" || id.length === 0) throw new TypeError("Agent Config ID is required");
  return `/api/user-agent-configs/${encodeURIComponent(id)}`;
}

export function createEvalSpClient(input: {
  readonly origin: string;
  readonly writeOrigin: string;
  readonly fetch?: Fetch;
}): EvalSpClient {
  const http = createSpHttpClient({ origin: input.origin, responseMode: "envelope", fetch: input.fetch });
  const writeOrigin = httpOriginSchema.parse(input.writeOrigin);

  async function request(token: string, path: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
    body?: unknown): Promise<unknown> {
    if (typeof token !== "string" || token.length === 0) throw new TypeError("Session token is required");
    try {
      const result = await http.request<unknown>(path, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(method === "GET" ? {} : { Origin: writeOrigin }) },
        ...(body === undefined ? {} : { body }),
      });
      return result.data;
    } catch (error) {
      if (!(error instanceof ApiError) || error.kind === "input" || error.kind === "runtime") throw error;
      if (error.kind !== "http") throw new EvalSpTransportError(error);
      throw new EvalSpApiError(error.status, {
        code: error.code,
        errMsg: error.message,
        ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
        ...(error.errors === undefined ? {} : { errors: error.errors }),
      }, { cause: error });
    }
  }

  return {
    async verifySession(token) {
      try {
        return read(sessionSchema, await request(token, "/api/auth/me")).user;
      } catch (error) {
        if (error instanceof EvalSpApiError && error.status === 401) return null;
        throw error;
      }
    },
    async listAgentConfigs(token) {
      return read(z.array(agentConfigSchema), await request(token, "/api/user-agent-configs"));
    },
    async getAgentConfig(token, id) {
      return read(agentConfigSchema, await request(token, configPath(id)));
    },
    async createAgentConfig(token, body) {
      return read(agentConfigSchema, await request(token, "/api/user-agent-configs", "POST", body));
    },
    async updateAgentConfig(token, id, body) {
      return read(agentConfigSchema, await request(token, configPath(id), "PATCH", body));
    },
    deleteAgentConfig(token, id) {
      return request(token, configPath(id), "DELETE");
    },
  };
}
