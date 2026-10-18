import type { AgentConfigRef, AgentConfigSnapshot, AgentPurpose, AgentRole, JsonValue } from "@eval-platform/eval-contracts";
import { createId, resolveEvaluationResultsMcp } from "@eval-platform/eval-contracts";
import {
  evaluationResultsMcpCandidates,
  selectedMcpServerIds,
} from "./agent-purpose.js";
import {
  AgentConfigFrozenError,
  AgentConfigPurposeLockedError,
  AgentConfigPurposeMismatchError,
  AgentConfigPurposeUnavailableError,
} from "./db/errors.js";
import type { AgentPurposeRecord, AgentPurposeStore } from "./db/agent-purposes.js";
import type { PostgresProjectStore } from "./db/project-store.js";
import type { EvalSpAgentConfig, EvalSpClient, EvalSpMcpServer } from "./sp/client.js";

/** SP's `createUserAgentConfigInputSchema` bounds the name to 200 characters. */
const AGENT_CONFIG_NAME_CHARS = 200;
const FROZEN_SUFFIX = " (frozen)";
const AGENT_ROLES: readonly AgentRole[] = ["subject", "evaluator"];

/** Every frozen copy's slug starts with this; user-written Agent Configs cannot use it. */
export const FROZEN_SLUG_PREFIX = "eval-frozen-";

/** True when a user-supplied slug falls under the reserved frozen-copy prefix (SP trims and lowercases slugs). */
export function isReservedSlug(slug: unknown): boolean {
  return typeof slug === "string" && slug.trim().toLowerCase().startsWith(FROZEN_SLUG_PREFIX);
}

export interface AgentOption {
  readonly agentConfig: AgentConfigRef;
  readonly name: string;
  /** Existing Subject/Evaluator role contract; one option is still emitted for each requested role. */
  readonly role: AgentRole;
  /** Eval-side immutable purpose. Every selectable config has one persisted record. */
  readonly purpose: AgentPurpose;
}

export interface FrozenCopy {
  readonly userAgentId: string;
  readonly snapshot: AgentConfigSnapshot;
}

function frozenCopyInput(source: EvalSpAgentConfig) {
  return {
    slug: `${FROZEN_SLUG_PREFIX}${createId()}`,
    name: `${source.name.trim().slice(0, AGENT_CONFIG_NAME_CHARS - FROZEN_SUFFIX.length)}${FROZEN_SUFFIX}`,
    description: typeof source.description === "string" ? source.description : null,
    setting: source.setting,
  };
}

function bodyRecord(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

function createBody(body: unknown): { readonly config: Record<string, unknown>; readonly purpose: AgentPurpose } {
  const input = bodyRecord(body);
  if (!input) throw new TypeError("Agent Config create body is required");
  const config = { ...input };
  const purpose = config.purpose;
  delete config.purpose;
  if (purpose !== "execution" && purpose !== "evaluation") throw new TypeError("Agent Config purpose is required");
  return { config, purpose };
}

function updateBody(body: unknown): { readonly config: unknown; readonly purpose: unknown; readonly hasPurpose: boolean } {
  const input = bodyRecord(body);
  if (!input || !("purpose" in input)) {
    return { config: body, purpose: undefined, hasPurpose: false };
  }
  const config = { ...input };
  const purpose = config.purpose;
  delete config.purpose;
  return { config, purpose, hasPurpose: true };
}

/**
 * SP hosts editable Agent Config bodies; Eval owns the immutable purpose metadata and Project-role checks.
 * A missing purpose record is reconciled once from the public SP MCP catalog. Every
 * successful read then returns the persisted record; an uncertain reconciliation is
 * an unavailable service result rather than an unknown Agent purpose.
 */
export function createAgentConfigService(input: {
  readonly ownerUserId: string;
  readonly sessionToken: string;
  readonly sp: EvalSpClient;
  readonly projects: Pick<PostgresProjectStore, "frozenAgentConfigIds">;
  readonly purposes: AgentPurposeStore;
}) {
  const { ownerUserId, sessionToken: token, sp, projects, purposes } = input;

  function isFrozen(config: EvalSpAgentConfig, recorded: ReadonlySet<string>): boolean {
    return recorded.has(config.id) || isReservedSlug(config.slug);
  }

  async function requireEditable(id: string): Promise<EvalSpAgentConfig> {
    const recorded = await projects.frozenAgentConfigIds([id]);
    if (recorded.has(id)) throw new AgentConfigFrozenError(id);
    const config = await sp.getAgentConfig(token, id);
    if (isReservedSlug(config.slug)) throw new AgentConfigFrozenError(id);
    return config;
  }

  async function list(): Promise<EvalSpAgentConfig[]> {
    const configs = await sp.listAgentConfigs(token);
    const recorded = await projects.frozenAgentConfigIds(configs.map((config) => config.id));
    return configs.filter((config) => !isFrozen(config, recorded));
  }

  interface PurposeCatalog {
    readonly evaluationServerId: string | null;
    readonly availableServerIds: ReadonlySet<string>;
    readonly resultCandidateIds: ReadonlySet<string>;
  }

  async function purposeCatalog(): Promise<PurposeCatalog> {
    let servers: readonly EvalSpMcpServer[];
    try {
      const [userServers, platformServers] = await Promise.all([
        sp.listMcpServers(token, "user"),
        sp.listMcpServers(token, "platform"),
      ]);
      servers = [...userServers, ...platformServers];
    } catch {
      throw new AgentConfigPurposeUnavailableError();
    }
    const resolution = resolveEvaluationResultsMcp(servers);
    if (resolution.kind === "multiple") throw new AgentConfigPurposeUnavailableError();
    return {
      evaluationServerId: resolution.kind === "available" ? resolution.server.id : null,
      availableServerIds: new Set(servers.filter((server) => server.status === "active").map((server) => server.id)),
      resultCandidateIds: new Set(evaluationResultsMcpCandidates(servers).map((server) => server.id)),
    };
  }

  function purposeFromConfig(config: Readonly<Record<string, unknown>>, catalog: PurposeCatalog): AgentPurpose {
    const selected = selectedMcpServerIds(config);
    if (selected.some((id) => !catalog.availableServerIds.has(id))) {
      throw new AgentConfigPurposeUnavailableError(typeof config.id === "string" ? config.id : undefined);
    }
    if (selected.some((id) => catalog.resultCandidateIds.has(id) && id !== catalog.evaluationServerId)) {
      throw new AgentConfigPurposeUnavailableError(typeof config.id === "string" ? config.id : undefined);
    }
    return catalog.evaluationServerId !== null && selected.includes(catalog.evaluationServerId) ? "evaluation" : "execution";
  }

  async function classify(configs: readonly EvalSpAgentConfig[]): Promise<Map<string, AgentPurposeRecord>> {
    const result = new Map<string, AgentPurposeRecord>((await purposes.list(configs.map((config) => config.id))).map((item) => [item.userAgentId, item]));
    const missing = configs.filter((config) => !result.has(config.id));
    if (missing.length === 0) return result;
    const catalog = await purposeCatalog();
    for (const config of missing) {
      const purpose = purposeFromConfig(config, catalog);
      result.set(config.id, await purposes.createIfAbsent({
        userAgentId: config.id,
        purpose,
        evaluationMcpServerId: catalog.evaluationServerId !== null && purpose === "evaluation" ? catalog.evaluationServerId : null,
      }));
    }
    return result;
  }

  async function classifyOne(config: EvalSpAgentConfig): Promise<AgentPurposeRecord> {
    const record = (await classify([config])).get(config.id);
    if (!record) throw new AgentConfigPurposeUnavailableError(config.id);
    return record;
  }

  function assertStoredBinding(config: EvalSpAgentConfig, stored: AgentPurposeRecord): void {
    if (stored.purpose === "evaluation"
      && (!stored.evaluationMcpServerId || !selectedMcpServerIds(config).includes(stored.evaluationMcpServerId))) {
      throw new AgentConfigPurposeLockedError(config.id);
    }
  }

  return {
    list,
    get: (id: string) => sp.getAgentConfig(token, id),
    async create(body: unknown) {
      const { config, purpose } = createBody(body);
      const catalog = await purposeCatalog();
      const actual = purposeFromConfig({ id: "new", setting: config.setting }, catalog);
      const selectedEvaluationMcpServerId = catalog.evaluationServerId !== null
        && selectedMcpServerIds({ setting: config.setting }).includes(catalog.evaluationServerId)
        ? catalog.evaluationServerId : null;
      if (actual !== purpose) throw new AgentConfigPurposeMismatchError("new", purpose, actual);
      const created = await sp.createAgentConfig(token, config);
      try {
        await purposes.createIfAbsent({
          userAgentId: created.id,
          purpose,
          evaluationMcpServerId: purpose === "evaluation" ? selectedEvaluationMcpServerId : null,
        });
      } catch (error) {
        await Promise.allSettled([sp.deleteAgentConfig(token, created.id)]);
        throw error;
      }
      return created;
    },
    async update(id: string, body: unknown) {
      const current = await requireEditable(id);
      const stored = await classifyOne(current);
      assertStoredBinding(current, stored);
      const forwarded = updateBody(body);
      if (forwarded.hasPurpose && forwarded.purpose !== stored.purpose) throw new AgentConfigPurposeLockedError(id);
      const next = forwarded.config && typeof forwarded.config === "object" && !Array.isArray(forwarded.config)
        ? { ...current, ...(forwarded.config as Record<string, unknown>) } : current;
      if (forwarded.config && typeof forwarded.config === "object" && !Array.isArray(forwarded.config) && "setting" in forwarded.config) {
        const nextMcpServerIds = selectedMcpServerIds(next as EvalSpAgentConfig);
        if (stored.purpose === "evaluation") {
          if (!stored.evaluationMcpServerId || !nextMcpServerIds.includes(stored.evaluationMcpServerId)) {
            throw new AgentConfigPurposeLockedError(id);
          }
        } else {
          const catalog = await purposeCatalog();
          const actual = purposeFromConfig(next as EvalSpAgentConfig, catalog);
          if (actual !== "execution") {
            throw new AgentConfigPurposeLockedError(id);
          }
        }
      }
      return sp.updateAgentConfig(token, id, forwarded.config);
    },
    async remove(id: string) {
      await requireEditable(id);
      await sp.deleteAgentConfig(token, id);
      await purposes.remove(id);
    },
    async listAgents(role?: AgentRole, purpose?: AgentPurpose): Promise<AgentOption[]> {
      const configs = await list();
      const records = await classify(configs);
      const roles = role === undefined ? AGENT_ROLES : [role];
      return configs.flatMap((config) => roles.flatMap((selectedRole) => {
        const selectedPurpose = records.get(config.id)?.purpose;
        if (!selectedPurpose) throw new AgentConfigPurposeUnavailableError(config.id);
        return purpose === undefined || selectedPurpose === purpose ? [{
          agentConfig: { ownerUserId, userAgentId: config.id }, name: config.name, role: selectedRole, purpose: selectedPurpose,
        }] : [];
      }));
    },
    /** Clones a selectable Agent Config into a new SP Agent Config whose body never changes again. */
    async freeze(sourceUserAgentId: string, expectedPurpose: AgentPurpose): Promise<FrozenCopy> {
      const source = await requireEditable(sourceUserAgentId);
      const stored = await classifyOne(source);
      assertStoredBinding(source, stored);
      if (stored.purpose !== expectedPurpose) throw new AgentConfigPurposeMismatchError(sourceUserAgentId, expectedPurpose, stored.purpose);
      const copy = await sp.createAgentConfig(token, frozenCopyInput(source));
      return {
        userAgentId: copy.id,
        snapshot: { sourceUserAgentId: source.id, name: source.name, body: source as Readonly<Record<string, JsonValue>> },
      };
    },
    /** Best-effort removal of copies no Project row references; failures leave hidden orphans. */
    async discard(userAgentIds: readonly string[]): Promise<void> {
      await Promise.allSettled(userAgentIds.map((id) => sp.deleteAgentConfig(token, id)));
    },
  };
}

export type AgentConfigService = ReturnType<typeof createAgentConfigService>;
