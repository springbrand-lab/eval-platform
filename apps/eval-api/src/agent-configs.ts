import type { AgentConfigRef, AgentConfigSnapshot, AgentPurpose, AgentRole, JsonValue } from "@eval-platform/eval-contracts";
import { createId, equalJson, resolveEvaluationResultsMcp } from "@eval-platform/eval-contracts";
import { ImportConflictError, ImportDependencyError } from "./agent-imports/errors.js";
import type { ImportResult, PlannedImportResources, PreparedAgent, SourceAgent } from "./agent-imports/model.js";
import { requireDefinitionEvidence, type DefinitionEvidence } from "./agent-imports/definition-evidence.js";
import { requireCanonicalSourceSetting } from "./agent-imports/semantics.js";
import { checkAgentResult, checkReceipt, type AgentImportTarget } from "./agent-imports/target.js";
import type { ResourceSourceStore } from "./db/agent-import-sources.js";
import {
  evaluationResultsMcpCandidates,
  selectedMcpServerIds,
} from "./agent-purpose.js";
import {
  AgentConfigFrozenError,
  AgentConfigPurposeMismatchError,
  AgentConfigPurposeUnavailableError,
} from "./db/errors.js";
import type { AgentPurposeRecord, AgentPurposeStore } from "./db/agent-purposes.js";
import type { PostgresProjectStore } from "./db/project-store.js";
import type { EvalSpAgentConfig, EvalSpClient, EvalSpMcpServer } from "./sp/client.js";
import { EvalSpApiError } from "./sp/http.js";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { RuntimeAdmissionConflictError, digestJson } from "@eval-platform/eval-runtime";

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
  /** Current Eval purpose. Every selectable config has one persisted record. */
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

function readMcpSelections(config: Readonly<Record<string, unknown>>): {
  readonly setting: Record<string, unknown>;
  readonly selections: readonly unknown[];
} {
  const setting = bodyRecord(config.setting) ?? {};
  return { setting, selections: Array.isArray(setting.mcpServers) ? setting.mcpServers : [] };
}

function withMcpSelections(
  config: Readonly<Record<string, unknown>>,
  setting: Readonly<Record<string, unknown>>,
  selections: readonly unknown[],
): Record<string, unknown> {
  return { ...config, setting: { ...setting, mcpServers: selections } };
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
 * SP hosts editable Agent Config bodies; Eval owns the current purpose metadata and Project-role checks.
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
  readonly sources?: ResourceSourceStore;
  readonly imports?: AgentImportTarget;
}) {
  const { ownerUserId, sessionToken: token, sp, projects, purposes } = input;

  function isFrozen(config: EvalSpAgentConfig, recorded: ReadonlySet<string>): boolean {
    return recorded.has(config.id) || isReservedSlug(config.slug);
  }

  async function requireNotPendingImport(id: string): Promise<void> {
    if ((await input.sources?.pendingAgentIds([id]))?.has(id)) throw new AgentConfigPurposeUnavailableError(id);
  }

  async function requireEditable(id: string): Promise<EvalSpAgentConfig> {
    await requireNotPendingImport(id);
    const recorded = await projects.frozenAgentConfigIds([id]);
    if (recorded.has(id)) throw new AgentConfigFrozenError(id);
    const config = await sp.getAgentConfig(token, id);
    if (isReservedSlug(config.slug)) throw new AgentConfigFrozenError(id);
    return config;
  }

  async function list(): Promise<EvalSpAgentConfig[]> {
    const configs = await sp.listAgentConfigs(token);
    const recorded = await projects.frozenAgentConfigIds(configs.map((config) => config.id));
    const pending = await input.sources?.pendingAgentIds(configs.map((config) => config.id)) ?? new Set<string>();
    return configs.filter((config) => !isFrozen(config, recorded) && !pending.has(config.id));
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
      result.set(config.id, await purposes.ensure({
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

  function normalizePurposeConfig(
    config: Readonly<Record<string, unknown>>,
    purpose: AgentPurpose,
    catalog: PurposeCatalog,
    recordedEvaluationMcpServerId?: string | null,
  ): { readonly config: Record<string, unknown>; readonly evaluationMcpServerId: string | null } {
    const { setting, selections } = readMcpSelections(config);
    const managedEvaluationMcpIds = new Set(catalog.resultCandidateIds);
    if (recordedEvaluationMcpServerId) managedEvaluationMcpIds.add(recordedEvaluationMcpServerId);
    if (purpose === "evaluation") {
      const evaluationMcpServerId = catalog.evaluationServerId;
      if (!evaluationMcpServerId || !catalog.availableServerIds.has(evaluationMcpServerId)) {
        throw new AgentConfigPurposeUnavailableError(typeof config.id === "string" ? config.id : undefined);
      }
      const mcpServers = [
        ...selections.filter((selection) => {
          if (bodyRecord(selection) && "kind" in bodyRecord(selection)!) return true;
          const id = bodyRecord(selection)?.serverId;
          return typeof id !== "string" || !managedEvaluationMcpIds.has(id);
        }),
        { serverId: evaluationMcpServerId },
      ];
      return { config: withMcpSelections(config, setting, mcpServers), evaluationMcpServerId };
    }
    const mcpServers = selections.filter((selection) => {
      if (bodyRecord(selection) && "kind" in bodyRecord(selection)!) return true;
      const id = bodyRecord(selection)?.serverId;
      return typeof id !== "string" || !managedEvaluationMcpIds.has(id);
    });
    return { config: withMcpSelections(config, setting, mcpServers), evaluationMcpServerId: null };
  }

  function removeEvaluationMcp(
    config: Readonly<Record<string, unknown>>,
    evaluationMcpServerId: string,
  ): { readonly config: Record<string, unknown>; readonly evaluationMcpServerId: null } {
    const { setting, selections } = readMcpSelections(config);
    const mcpServers = selections.filter((selection) => {
      const record = bodyRecord(selection);
      return record && "kind" in record || record?.serverId !== evaluationMcpServerId;
    });
    return { config: withMcpSelections(config, setting, mcpServers), evaluationMcpServerId: null };
  }

  /** SP may fill in these optional saved-setting defaults. Never compare a replay using only its POST receipt. */
  function savedSetting(setting: unknown): Record<string, unknown> | null {
    const fields = bodyRecord(setting);
    return fields && {
      ...fields,
      presetId: fields.presetId ?? null,
      referenceFileIds: fields.referenceFileIds ?? [],
      connectorIds: fields.connectorIds ?? [],
      extensionIds: fields.extensionIds ?? [],
    };
  }

  async function verifiedReplay(
    receipt: EvalSpAgentConfig, expected: Record<string, unknown>, purpose: AgentPurpose,
    evaluationMcpServerId: string | null,
  ): Promise<EvalSpAgentConfig> {
    // SP GET can return a deleted Agent. An active, owned list entry AND a fresh body are required.
    if (!(await list()).some((item) => item.id === receipt.id && item.user_id === ownerUserId)) {
      throw new HttpError("EVAL_SP_CONFLICT", "Agent creation key no longer names an active owned Agent");
    }
    const current = await sp.getAgentConfig(token, receipt.id);
    const recorded = await purposes.get(receipt.id);
    if (current.id !== receipt.id || current.user_id !== ownerUserId || current.is_default === true
      || current.slug !== expected.slug
      || current.name !== expected.name || (current.description ?? null) !== (expected.description ?? null)
      || !equalJson(savedSetting(current.setting), savedSetting(expected.setting))
      || recorded?.purpose !== purpose || recorded.evaluationMcpServerId !== evaluationMcpServerId) {
      throw new HttpError("EVAL_SP_CONFLICT", "Agent creation key conflicts with the current Agent or purpose");
    }
    return current;
  }

  return {
    list,
    async get(id: string) {
      await requireNotPendingImport(id);
      return sp.getAgentConfig(token, id);
    },
    async create(body: unknown, options?: { readonly verifyReplay: true }) {
      const { config, purpose } = createBody(body);
      const catalog = await purposeCatalog();
      const normalized = normalizePurposeConfig(config, purpose, catalog);
      const actual = purposeFromConfig({ ...normalized.config, id: "new" }, catalog);
      if (actual !== purpose) throw new AgentConfigPurposeMismatchError("new", purpose, actual);
      // The management entry requires SP's affirmative insertion/replay receipt before it can
      // distinguish a new Agent from an existing slug. Ordinary HTTP still supports older SPs.
      if (options && !sp.createAgentConfigOutcome) throw new HttpError("EVAL_SP_UNAVAILABLE", "Agent insertion receipt is required");
      const outcome = sp.createAgentConfigOutcome
        ? await sp.createAgentConfigOutcome(token, normalized.config) : null;
      const created = outcome?.config ?? await sp.createAgentConfig(token, normalized.config);
      if (options) {
        if (outcome?.created === false) {
          return verifiedReplay(created, normalized.config, purpose, normalized.evaluationMcpServerId);
        }
        if (outcome?.created !== true) throw new HttpError("EVAL_SP_UNAVAILABLE", "Agent insertion could not be confirmed");
        if (created.user_id !== ownerUserId || created.slug !== normalized.config.slug) {
          throw new HttpError("EVAL_SP_CONFLICT", "SP returned a different Agent");
        }
      }
      try {
        await purposes.upsert({
          userAgentId: created.id,
          purpose,
          evaluationMcpServerId: normalized.evaluationMcpServerId,
        });
        if (input.sources && outcome?.created === true && created.user_id === ownerUserId) {
          await input.sources.recordNative(created.id);
        }
      } catch (error) {
        // A slug replay (false), missing header or legacy SP call may refer to a pre-existing
        // Agent. Only a proven insertion owned by this account may ever be compensated.
        if (outcome?.created === true && created.user_id === ownerUserId) {
          await Promise.allSettled([sp.deleteAgentConfig(token, created.id)]);
        }
        throw error;
      }
      return created;
    },
    /** Freeze target normalization in preview, using the same purpose/MCP and frozen-copy rules. */
    async prepareImport(
      source: SourceAgent, purpose: AgentPurpose, dependencies: readonly DefinitionEvidence[] = [],
      plannedResources: PlannedImportResources = { skills: [], references: [] },
    ): Promise<PreparedAgent> {
      if (!input.imports) throw new ImportDependencyError("Agent imports are disabled");
      if (isReservedSlug(source.slug) || source.slug === "default"
        || (await projects.frozenAgentConfigIds([source.id])).has(source.id)) throw new AgentConfigFrozenError(source.id);
      requireCanonicalSourceSetting(source.setting);
      const config = { id: source.id, slug: `import-${source.id}`, name: source.name,
        description: source.description, setting: source.setting };
      const proofs = requireDefinitionEvidence(source.setting, dependencies);
      const catalog = await purposeCatalog();
      const normalized = normalizePurposeConfig(config, purpose, catalog);
      const actual = purposeFromConfig(normalized.config, catalog);
      if (actual !== purpose) throw new AgentConfigPurposeMismatchError(source.id, purpose, actual);
      await input.imports.validateSelections(normalized.config.setting as Record<string, unknown>, proofs, plannedResources);
      return { purpose, evaluationMcpServerId: normalized.evaluationMcpServerId, dependencies: proofs,
        config: { ...config, setting: normalized.config.setting as Record<string, unknown> } };
    },
    /** Overwrite receipt flow. Local failures retain the remote result; never use normal create's DELETE compensation. */
    async import(prepared: PreparedAgent, importKey: string, onReceipt: (result: ImportResult) => Promise<void>, recovered?: ImportResult): Promise<ImportResult> {
      if (!input.imports) throw new ImportDependencyError("Agent imports are disabled");
      const id = prepared.config.id;
      if (isReservedSlug(prepared.config.slug) || prepared.config.slug === "default"
        || (await projects.frozenAgentConfigIds([id])).has(id)) throw new AgentConfigFrozenError(id);
      requireCanonicalSourceSetting(prepared.config.setting);
      // Dependencies must exist now, including during receipt recovery; no future-resource facts are supplied.
      await input.imports.validateSelections(prepared.config.setting, prepared.dependencies);
      if (!recovered) {
        const catalog = await purposeCatalog();
        const normalized = normalizePurposeConfig(prepared.config, prepared.purpose, catalog);
        if (!equalJson(normalized.config, prepared.config) || normalized.evaluationMcpServerId !== prepared.evaluationMcpServerId) {
          throw new ImportConflictError("Target purpose prerequisites changed; preview again");
        }
        const actual = purposeFromConfig(prepared.config, catalog);
        if (actual !== prepared.purpose) throw new AgentConfigPurposeMismatchError(id, prepared.purpose, actual);
      }
      const result = recovered ?? await input.imports.importAgent(prepared, importKey);
      checkReceipt(result, "agent", id, importKey);
      // A cached/replayed receipt proves historical insertion, never the current body or current existence.
      const current = await input.imports.agent(id);
      if (!current) throw new ImportConflictError("The imported Agent no longer exists; import cannot recreate it");
      checkAgentResult({ ...result, resource: current }, prepared, ownerUserId);
      // SP GET retains archived bodies and its public DTO has no tombstone. Use the existing active-list fact too.
      if (!(await input.imports.listAgents()).some((agent) => agent.id === id && agent.user_id === ownerUserId)) {
        throw new ImportConflictError("The imported Agent is no longer active; import cannot revive it");
      }
      await onReceipt(result); // durable creation proof precedes purpose/source finalization
      await purposes.upsert({ userAgentId: id, purpose: prepared.purpose, evaluationMcpServerId: prepared.evaluationMcpServerId });
      return result;
    },
    async update(id: string, body: unknown) {
      const current = await requireEditable(id);
      const stored = await classifyOne(current);
      const forwarded = updateBody(body);
      const requestedPurpose = forwarded.hasPurpose ? forwarded.purpose : stored.purpose;
      if (requestedPurpose !== "execution" && requestedPurpose !== "evaluation") {
        throw new TypeError("Agent Config purpose must be execution or evaluation");
      }
      const configBody = bodyRecord(forwarded.config);
      const settingChanged = configBody !== null && "setting" in configBody;
      const purposeChanged = requestedPurpose !== stored.purpose;
      const shouldNormalize = settingChanged || purposeChanged;
      let spUpdateBody: unknown = forwarded.config;
      let nextPurpose = stored.purpose;
      let nextEvaluationMcpServerId = stored.evaluationMcpServerId;
      if (shouldNormalize) {
        const next = { ...current, ...(configBody ?? {}) };
        const normalized = requestedPurpose === "execution" && stored.purpose === "evaluation" && stored.evaluationMcpServerId
          ? removeEvaluationMcp(next, stored.evaluationMcpServerId)
          : normalizePurposeConfig(next, requestedPurpose, await purposeCatalog(), stored.evaluationMcpServerId);
        const normalizedInput = { ...(configBody ?? {}), setting: normalized.config.setting };
        spUpdateBody = normalizedInput;
        nextPurpose = requestedPurpose;
        nextEvaluationMcpServerId = normalized.evaluationMcpServerId;
      } else if (forwarded.hasPurpose) {
        nextPurpose = requestedPurpose;
        nextEvaluationMcpServerId = requestedPurpose === "evaluation" ? stored.evaluationMcpServerId : null;
      }
      const updated = await sp.updateAgentConfig(token, id, spUpdateBody);
      if (nextPurpose !== stored.purpose || nextEvaluationMcpServerId !== stored.evaluationMcpServerId) {
        try {
          await purposes.upsert({
            userAgentId: id,
            purpose: nextPurpose,
            evaluationMcpServerId: nextEvaluationMcpServerId,
          });
        } catch (error) {
          const revision = bodyRecord(updated)?.revision;
          await Promise.allSettled([sp.updateAgentConfig(token, id, {
            ...(typeof revision === "number" ? { revision } : {}),
            name: current.name,
            description: typeof current.description === "string" ? current.description : null,
            setting: current.setting,
          })]);
          throw error;
        }
      }
      return updated;
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
    async freeze(sourceUserAgentId: string, expectedPurpose: AgentPurpose, expectedDigest?: string): Promise<FrozenCopy> {
      // requireEditable shares the pending-import fence with get/update/remove, before any target I/O.
      const source = await requireEditable(sourceUserAgentId);
      // SP retains archived configs for old Chats; only the active list proves new selectability.
      const active = await sp.listAgentConfigs(token);
      if (!active.some((config) => config.id === sourceUserAgentId && config.user_id === ownerUserId)) {
        throw new EvalSpApiError(404, null);
      }
      const stored = await classifyOne(source);
      if (stored.purpose !== expectedPurpose) throw new AgentConfigPurposeMismatchError(sourceUserAgentId, expectedPurpose, stored.purpose);
      if (expectedDigest !== undefined && await digestJson(source) !== expectedDigest) {
        throw new RuntimeAdmissionConflictError("plan-changed", "Approved Agent Config changed before it was frozen");
      }
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
