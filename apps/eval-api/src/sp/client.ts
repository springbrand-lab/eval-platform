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

export class EvalSpApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(`Eval SP API returned ${status}`);
    this.name = "EvalSpApiError";
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

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function user(value: unknown): EvalSpUser {
  if (!record(value) || typeof value.id !== "string" || value.id.length === 0
    || (value.role !== "user" && value.role !== "admin" && value.role !== "super_admin")) {
    throw new Error("Eval SP returned an invalid user identity");
  }
  return { id: value.id, role: value.role };
}

function agentConfig(value: unknown): EvalSpAgentConfig {
  if (!record(value) || typeof value.id !== "string" || value.id.length === 0
    || typeof value.user_id !== "string" || value.user_id.length === 0
    || typeof value.name !== "string") {
    throw new Error("Eval SP returned an invalid Agent Config");
  }
  return value as EvalSpAgentConfig;
}

function pathId(value: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("Agent Config ID is required");
  return encodeURIComponent(value);
}

function httpOrigin(value: string, field: string): URL {
  const origin = new URL(value);
  if ((origin.protocol !== "https:" && origin.protocol !== "http:")
    || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
    throw new TypeError(`${field} must be an HTTP origin without a path, query or credentials`);
  }
  return origin;
}

export function createEvalSpClient(input: {
  readonly origin: string;
  readonly writeOrigin: string;
  readonly fetch?: Fetch;
}): EvalSpClient {
  const origin = httpOrigin(input.origin, "Eval SP origin");
  const writeOrigin = httpOrigin(input.writeOrigin, "Eval SP write Origin");
  const fetcher = input.fetch ?? globalThis.fetch;

  async function request(token: string, path: string, method = "GET", body?: unknown): Promise<unknown> {
    if (typeof token !== "string" || token.length === 0) throw new TypeError("Session token is required");
    const response = await fetcher(new URL(path, origin), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method === "GET" ? {} : { Origin: writeOrigin.origin }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      credentials: "omit",
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new EvalSpApiError(response.status, payload);
    if (!record(payload) || payload.success !== true || !("msg" in payload)) {
      throw new Error("Eval SP returned an invalid response envelope");
    }
    return payload.msg;
  }

  return {
    async verifySession(token) {
      let identity: unknown;
      try {
        identity = await request(token, "/api/auth/me");
      } catch (error) {
        if (error instanceof EvalSpApiError && error.status === 401) return null;
        throw error;
      }
      if (!record(identity)) throw new Error("Eval SP returned an invalid session");
      return user(identity.user);
    },
    async listAgentConfigs(token) {
      const configs = await request(token, "/api/user-agent-configs");
      if (!Array.isArray(configs)) throw new Error("Eval SP returned an invalid Agent Config list");
      return configs.map(agentConfig);
    },
    async getAgentConfig(token, id) {
      return agentConfig(await request(token, `/api/user-agent-configs/${pathId(id)}`));
    },
    async createAgentConfig(token, input) {
      return agentConfig(await request(token, "/api/user-agent-configs", "POST", input));
    },
    async updateAgentConfig(token, id, input) {
      return agentConfig(await request(token, `/api/user-agent-configs/${pathId(id)}`, "PATCH", input));
    },
    deleteAgentConfig(token, id) {
      return request(token, `/api/user-agent-configs/${pathId(id)}`, "DELETE");
    },
  };
}
