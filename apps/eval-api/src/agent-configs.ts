import type { AgentConfigRef, AgentConfigSnapshot, AgentPurpose, AgentRole, JsonValue } from "@eval-platform/eval-contracts";
import { createId } from "@eval-platform/eval-contracts";
import {
  evaluationMcpServerId,
  evaluationResultsMcpServers,
  purposeOfAgent,
  selectedMcpServerIds,
} from "./agent-purpose.js";
import {
  AgentConfigFrozenError,
  AgentConfigPurposeLockedError,
  AgentConfigPurposeMismatchError,
} from "./db/errors.js";
import type { AgentPurposeRecord, AgentPurposeStore } from "./db/agent-purposes.js";
import type { PostgresProjectStore } from "./db/project-store.js";
import type { EvalSpAgentConfig, EvalSpClient } from "./sp/client.js";

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
  /** Eval-side immutable purpose; null means a legacy config could not be classified during this read. */
  readonly purpose: AgentPurpose | null;
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
 * Legacy configs are classified once when first read, then never reclassified from mutable MCP metadata.
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

  async function classify(configs: readonly EvalSpAgentConfig[], required: boolean): Promise<Map<string, AgentPurposeRecord | null>> {
    const result = new Map<string, AgentPurposeRecord | null>((await purposes.list(configs.map((config) => config.id))).map((item) => [item.userAgentId, item]));
    const missing = configs.filter((config) => !result.has(config.id));
    if (missing.length === 0) return result;
    let servers;
    try {
      servers = await sp.listMcpServers(token);
    } catch (error) {
      if (required) throw error;
      for (const config of missing) result.set(config.id, null);
      return result;
    }
    const evaluationServerIds = new Set(evaluationResultsMcpServers(servers).map((server) => server.id));
    for (const config of missing) {
      const purpose = purposeOfAgent(config, evaluationServerIds);
      result.set(config.id, await purposes.createIfAbsent({
        userAgentId: config.id,
        purpose,
        evaluationMcpServerId: evaluationMcpServerId(config, evaluationServerIds),
      }));
    }
    return result;
  }

  async function classifyOne(config: EvalSpAgentConfig, required = true): Promise<AgentPurposeRecord | null> {
    return (await classify([config], required)).get(config.id) ?? null;
  }

  async function evaluationServerIds(): Promise<ReadonlySet<string>> {
    const servers = await sp.listMcpServers(token);
    return new Set(evaluationResultsMcpServers(servers).map((server) => server.id));
  }

  return {
    list,
    get: (id: string) => sp.getAgentConfig(token, id),
    async create(body: unknown) {
      const { config, purpose } = createBody(body);
      const ids = await evaluationServerIds();
      const selectedEvaluationMcpServerId = evaluationMcpServerId({ setting: config.setting }, ids);
      const actual: AgentPurpose = selectedEvaluationMcpServerId === null ? "execution" : "evaluation";
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
      if (!stored) throw new Error(`Agent purpose ${id} is unavailable`);
      const forwarded = updateBody(body);
      if (forwarded.hasPurpose && forwarded.purpose !== stored.purpose) throw new AgentConfigPurposeLockedError(id);
      const next = forwarded.config && typeof forwarded.config === "object" && !Array.isArray(forwarded.config)
        ? { ...current, ...(forwarded.config as Record<string, unknown>) } : current;
      if (forwarded.config && typeof forwarded.config === "object" && !Array.isArray(forwarded.config) && "setting" in forwarded.config) {
        const currentMcpServerIds = new Set(selectedMcpServerIds(current));
        const nextMcpServerIds = selectedMcpServerIds(next as EvalSpAgentConfig);
        if (stored.purpose === "evaluation") {
          if (!stored.evaluationMcpServerId || !nextMcpServerIds.includes(stored.evaluationMcpServerId)) {
            throw new AgentConfigPurposeLockedError(id);
          }
        } else {
          const evaluationIds = await evaluationServerIds();
          if (nextMcpServerIds.some((serverId) => evaluationIds.has(serverId) && !currentMcpServerIds.has(serverId))) {
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
      const records = await classify(configs, false);
      const roles = role === undefined ? AGENT_ROLES : [role];
      return configs.flatMap((config) => roles.flatMap((selectedRole) => {
        const selectedPurpose = records.get(config.id)?.purpose ?? null;
        return purpose === undefined || selectedPurpose === purpose ? [{
          agentConfig: { ownerUserId, userAgentId: config.id }, name: config.name, role: selectedRole, purpose: selectedPurpose,
        }] : [];
      }));
    },
    /** Clones a selectable Agent Config into a new SP Agent Config whose body never changes again. */
    async freeze(sourceUserAgentId: string, expectedPurpose: AgentPurpose): Promise<FrozenCopy> {
      const source = await requireEditable(sourceUserAgentId);
      const stored = await classifyOne(source);
      if (!stored) throw new Error(`Agent purpose ${sourceUserAgentId} is unavailable`);
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
