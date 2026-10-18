import { z } from "zod";
import { httpOriginSchema } from "../config/env.js";
import { createSpHttpClient, EvalSpApiError, EvalSpTransportError, throwSpClientError, type Fetch } from "./http.js";
import { agentLibraryPath, type AgentLibraryRequest } from "./agent-library.js";

export interface EvalSpUser {
  readonly id: string;
  readonly role: "user" | "admin" | "super_admin";
  /** Present when read from Eval SP; credit grants address the account by email. */
  readonly email?: string | undefined;
}

/** The credit balance of one Eval SP account. */
export interface EvalSpCreditBalance {
  readonly availableUnits: number;
  readonly topupRemainingUnits: number;
  readonly otherRemainingUnits: number;
}

export interface EvalSpCreditGrantInput {
  readonly email: string;
  readonly units: number;
  readonly adjustmentId: string;
  readonly note?: string;
}

export interface EvalSpCreditGrant {
  readonly userId: string;
  readonly email: string;
  readonly adjustmentId: string;
  readonly units: number;
  readonly replayed: boolean;
}

export interface EvalSpCreditGrantRecord {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly adjustmentId: string;
  readonly units: number;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface EvalSpAgentConfig {
  readonly id: string;
  readonly user_id: string;
  readonly name: string;
  readonly [field: string]: unknown;
}

/** Public MCP metadata returned by SP. Connection credentials are never exposed. */
export interface EvalSpMcpServer {
  readonly id: string;
  readonly source: string;
  readonly status: string;
  readonly url: string | null;
  readonly authType: string | null;
}

export interface EvalSpClient {
  verifySession(token: string): Promise<EvalSpUser | null>;
  listAgentConfigs(token: string): Promise<readonly EvalSpAgentConfig[]>;
  listMcpServers(token: string): Promise<readonly EvalSpMcpServer[]>;
  getAgentConfig(token: string, id: string): Promise<EvalSpAgentConfig>;
  createAgentConfig(token: string, input: unknown): Promise<EvalSpAgentConfig>;
  updateAgentConfig(token: string, id: string, input: unknown): Promise<EvalSpAgentConfig>;
  deleteAgentConfig(token: string, id: string): Promise<unknown>;
  requestAgentLibrary(token: string, input: AgentLibraryRequest): Promise<unknown>;
  getCreditBalance(token: string): Promise<EvalSpCreditBalance>;
  /** `adminToken` is the Eval SP RESOURCE_ADMIN_TOKEN. */
  grantCredits(adminToken: string, input: EvalSpCreditGrantInput): Promise<EvalSpCreditGrant>;
  listCreditGrants(adminToken: string, query: { readonly email: string; readonly limit: number }):
    Promise<readonly EvalSpCreditGrantRecord[]>;
}

const sessionSchema = z.object({
  user: z.object({ id: z.string().min(1), role: z.enum(["user", "admin", "super_admin"]), email: z.string().optional() }),
});
const units = z.number().int().nonnegative();
const creditBalanceSchema = z.object({
  creditAccount: z.object({ availableUnits: z.number().int(), topupRemainingUnits: units, otherRemainingUnits: units }),
});
const creditGrantSchema = z.object({
  userId: z.string(), email: z.string(), adjustmentId: z.string(), units: z.number().int().positive(), replayed: z.boolean(),
});
const creditGrantRecordSchema = z.object({
  id: z.string(), userId: z.string(), email: z.string(), adjustmentId: z.string(),
  units: z.number().int(), note: z.string().nullable(), createdAt: z.string(),
});
const agentConfigSchema = z.looseObject({ id: z.string().min(1), user_id: z.string().min(1), name: z.string() });
const mcpServerSchema = z.object({
  id: z.string().min(1), source: z.string().min(1), status: z.string().min(1),
  url: z.string().nullable().default(null), authType: z.string().nullable().default(null),
}).passthrough().transform(({ id, source, status, url, authType }) => ({ id, source, status, url, authType }));
const mcpServerCollectionSchema = z.object({ data: z.array(mcpServerSchema) }).passthrough();

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

  async function request(token: string, path: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
    body?: unknown, options: { signal?: AbortSignal; contentType?: string } = {}): Promise<unknown> {
    if (typeof token !== "string" || token.length === 0) throw new TypeError("Session token is required");
    try {
      const result = await http.request<unknown>(path, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(method === "GET" ? {} : { Origin: writeOrigin }),
          ...(options.contentType === undefined ? {} : { "Content-Type": options.contentType }) },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(body === undefined ? {} : { body }),
      });
      return result.data;
    } catch (error) {
      throwSpClientError(error);
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
    async listMcpServers(token) {
      const collection = read(mcpServerCollectionSchema,
        await request(token, "/api/mcp-servers?source=user&page=1&pageSize=100"));
      return collection.data;
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
    requestAgentLibrary(token, input) {
      const method = input.route.method === "get" ? "GET" : input.route.method === "post" ? "POST"
        : input.route.method === "put" ? "PUT" : input.route.method === "patch" ? "PATCH" : "DELETE";
      return request(token, agentLibraryPath(input), method, input.body, {
        signal: input.signal, ...(input.route.body === "zip" ? { contentType: "application/zip" } : {}),
      });
    },
    async getCreditBalance(token) {
      const { availableUnits, topupRemainingUnits, otherRemainingUnits } =
        read(creditBalanceSchema, await request(token, "/api/account/snapshot")).creditAccount;
      return { availableUnits, topupRemainingUnits, otherRemainingUnits };
    },
    async grantCredits(adminToken, input) {
      return read(creditGrantSchema, await request(adminToken, "/api/admin/credits/grants", "POST", input));
    },
    async listCreditGrants(adminToken, { email, limit }) {
      const query = new URLSearchParams({ email, limit: String(limit) });
      return read(z.object({ grants: z.array(creditGrantRecordSchema) }),
        await request(adminToken, `/api/admin/credits/grants?${query}`)).grants;
    },
  };
}
