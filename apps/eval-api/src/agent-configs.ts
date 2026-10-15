import type { AgentConfigRef, AgentConfigSnapshot, AgentRole, JsonValue } from "@eval-platform/eval-contracts";
import { AgentConfigFrozenError } from "./db/errors.js";
import type { PostgresProjectStore } from "./db/project-store.js";
import type { EvalSpAgentConfig, EvalSpClient } from "./sp/client.js";

const AGENT_ROLES: readonly AgentRole[] = ["subject", "evaluator"];
/** SP's `createUserAgentConfigInputSchema` bounds the name to 200 characters. */
const AGENT_CONFIG_NAME_CHARS = 200;
const FROZEN_SUFFIX = " (frozen)";
/** Every frozen copy's slug starts with this, so even an orphan whose creation response was lost stays hidden. */
const FROZEN_SLUG_PREFIX = "eval-frozen-";

export interface AgentOption {
  readonly agentConfig: AgentConfigRef;
  readonly name: string;
  readonly role: AgentRole;
}

export interface FrozenCopy {
  readonly userAgentId: string;
  readonly snapshot: AgentConfigSnapshot;
}

/**
 * SP create body for an identical copy. A fresh slug is required: SP replays an existing
 * account-scoped slug instead of creating another Agent Config, and copies are never default.
 */
export function frozenCopyInput(source: EvalSpAgentConfig) {
  return {
    slug: `${FROZEN_SLUG_PREFIX}${crypto.randomUUID()}`,
    name: `${source.name.trim().slice(0, AGENT_CONFIG_NAME_CHARS - FROZEN_SUFFIX.length)}${FROZEN_SUFFIX}`,
    description: typeof source.description === "string" ? source.description : null,
    setting: source.setting,
  };
}

/**
 * The user's Agent Configs as seen through Eval: SP stays the host, while frozen Project copies
 * (current or retired) are hidden from lists and refuse edits and deletion.
 */
export function createAgentConfigService(input: {
  readonly ownerUserId: string;
  readonly sessionToken: string;
  readonly sp: EvalSpClient;
  readonly projects: Pick<PostgresProjectStore, "frozenAgentConfigIds">;
}) {
  const { ownerUserId, sessionToken: token, sp, projects } = input;
  async function requireEditable(id: string): Promise<void> {
    if ((await projects.frozenAgentConfigIds([id])).has(id)) throw new AgentConfigFrozenError(id);
  }
  async function list(): Promise<EvalSpAgentConfig[]> {
    const configs = await sp.listAgentConfigs(token);
    const frozen = await projects.frozenAgentConfigIds(configs.map((config) => config.id));
    return configs.filter((config) => !frozen.has(config.id)
      && !(typeof config.slug === "string" && config.slug.startsWith(FROZEN_SLUG_PREFIX)));
  }
  return {
    list,
    get: (id: string) => sp.getAgentConfig(token, id),
    create: (body: unknown) => sp.createAgentConfig(token, body),
    async update(id: string, body: unknown) {
      await requireEditable(id);
      return sp.updateAgentConfig(token, id, body);
    },
    async remove(id: string) {
      await requireEditable(id);
      await sp.deleteAgentConfig(token, id);
    },
    async listAgents(role?: AgentRole): Promise<AgentOption[]> {
      return (await list()).flatMap((config) => (role ? [role] : AGENT_ROLES).map((selectedRole) => ({
        agentConfig: { ownerUserId, userAgentId: config.id }, name: config.name, role: selectedRole,
      })));
    },
    /** Clones a selectable Agent Config into a new SP Agent Config whose body never changes again. */
    async freeze(sourceUserAgentId: string): Promise<FrozenCopy> {
      await requireEditable(sourceUserAgentId);
      const source = await sp.getAgentConfig(token, sourceUserAgentId);
      const copy = await sp.createAgentConfig(token, frozenCopyInput(source));
      // Plan normalization validates the body as plain JSON; the caller discards the copy on failure.
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
