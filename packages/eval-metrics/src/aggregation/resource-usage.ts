import type { MetricNumber, ModelStatistics, ResourceDiagnostic, TokenStatistics } from "./model.js";
import { record, text } from "../json.js";
import { identity, type FactEntry, type FactStream, type ResourceDiagnostics } from "./resource-facts.js";

const USAGE_KINDS = new Set(["assistant_model", "compaction", "subagent", "chat_title"]);
const TOKEN_BUCKETS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
const USAGE_METRICS = [...TOKEN_BUCKETS, "reasoningTokens", "totalTokens", "providerUsd"] as const;
type UsageMetric = (typeof USAGE_METRICS)[number];

interface UsageStatistics {
  readonly tokens: TokenStatistics;
  readonly providerUsd: MetricNumber;
  readonly byModel: readonly ModelStatistics[];
  /** Usage records already counted through a covering subagent summary. */
  readonly overlappingUsageRecords: number;
}

/** Token and provider-cost totals without double counting usage that a subagent summary already covers. */
export function aggregateUsage(stream: FactStream, diagnostics: ResourceDiagnostics): UsageStatistics {
  const known = selectKnownUsage(stream.entries, diagnostics);
  const summaries = readSubagentSummaries(known.entries, diagnostics);
  const selection = new UsageSelection(
    known.entries,
    summaries,
    stream.complete && known.complete && summaries.complete,
    diagnostics,
  );
  const totalUsage = new Set(selection.entries("totalTokens"));
  const byModel = modelGroups(new Set(USAGE_METRICS.flatMap((metric) => selection.entries(metric))))
    .map((group): ModelStatistics => ({
      provider: group.provider,
      model: group.model,
      usageRecords: group.entries.filter((entry) => totalUsage.has(entry)).length,
      tokens: selection.tokens(new Set(group.entries)),
      providerUsd: selection.total("providerUsd", new Set(group.entries)),
    }))
    .sort((left, right) => identity(left.provider, left.model).localeCompare(identity(right.provider, right.model)));
  return {
    tokens: selection.tokens(),
    providerUsd: selection.total("providerUsd"),
    byModel,
    overlappingUsageRecords: known.entries.length - totalUsage.size - summaries.ambiguous.size,
  };
}

function usageProblem(entry: FactEntry): { readonly kind: ResourceDiagnostic["kind"]; readonly message: string } | undefined {
  const kind = text(entry.fact.kind);
  if (!kind || !USAGE_KINDS.has(kind)) return { kind: "unsupported-record", message: "Unsupported usage kind" };
  if (!text(entry.fact.runId)) return { kind: "missing-identity", message: "Usage has no run identity" };
  if (kind === "subagent" && (!text(entry.fact.subagentRunId) || !text(entry.fact.parentRunId))) {
    return { kind: "missing-identity", message: "Subagent usage has no complete child/parent identity" };
  }
  return undefined;
}

function selectKnownUsage(
  entries: readonly FactEntry[],
  diagnostics: ResourceDiagnostics,
): { readonly entries: readonly FactEntry[]; readonly complete: boolean } {
  let complete = true;
  const known = entries.filter((entry) => {
    const problem = usageProblem(entry);
    if (problem === undefined) return true;
    complete = false;
    diagnostics.report(problem.kind, "usageEvents", entry, problem.message);
    return false;
  });
  return { entries: known, complete };
}

interface SubagentSummaries {
  /** Summary usage keyed by owner and child run. */
  readonly groups: ReadonlyMap<string, readonly FactEntry[]>;
  /** Parent run of each child run with one consistent parent. */
  readonly parentByRun: ReadonlyMap<string, string>;
  /** Summaries that cannot cover any run: repeated or part of a parent cycle. */
  readonly ambiguous: ReadonlySet<FactEntry>;
  readonly complete: boolean;
}

function readSubagentSummaries(known: readonly FactEntry[], diagnostics: ResourceDiagnostics): SubagentSummaries {
  const groups = new Map<string, FactEntry[]>();
  for (const entry of known) {
    if (entry.fact.kind !== "subagent") continue;
    const key = identity(entry.ownerUserId, entry.fact.subagentRunId as string);
    groups.set(key, [...groups.get(key) ?? [], entry]);
  }
  const ambiguous = new Set<FactEntry>();
  const parentByRun = new Map<string, string>();
  const markAmbiguous = (entries: readonly FactEntry[], message: string): void => {
    for (const entry of entries) {
      ambiguous.add(entry);
      diagnostics.report("conflicting-identity", "usageEvents", entry, message);
    }
  };
  for (const [key, entries] of groups) {
    const parents = new Set(entries.map((entry) => entry.fact.parentRunId as string));
    const [first] = entries;
    if (parents.size === 1 && first) parentByRun.set(key, first.fact.parentRunId as string);
    if (entries.length > 1) markAmbiguous(entries, "A child run has multiple distinct usage summaries");
  }
  for (const [key, entries] of groups) {
    const ownerUserId = entries[0]?.ownerUserId ?? "";
    const seen = new Set<string>();
    let current: string | undefined = key;
    while (current && !seen.has(current)) {
      seen.add(current);
      const parent = parentByRun.get(current);
      current = parent ? identity(ownerUserId, parent) : undefined;
    }
    if (current) {
      markAmbiguous(entries, "Subagent parent relationships contain a cycle");
    }
  }
  return { groups, parentByRun, ambiguous, complete: ambiguous.size === 0 };
}

/** Selects, per metric, the usage records not already covered by an ancestor subagent summary. */
class UsageSelection {
  readonly #values = new Map<FactEntry, Map<UsageMetric, number | null>>();
  readonly #selected = new Map<UsageMetric, readonly FactEntry[]>();

  constructor(
    private readonly known: readonly FactEntry[],
    private readonly summaries: SubagentSummaries,
    private readonly complete: boolean,
    private readonly diagnostics: ResourceDiagnostics,
  ) {}

  entries(metric: UsageMetric): readonly FactEntry[] {
    const cached = this.#selected.get(metric);
    if (cached) return cached;
    const selected = this.known.filter((entry) => !this.summaries.ambiguous.has(entry) && !this.#covered(entry, metric));
    this.#selected.set(metric, selected);
    return selected;
  }

  total(metric: UsageMetric, group?: ReadonlySet<FactEntry>): MetricNumber {
    const entries = this.entries(metric).filter((entry) => group === undefined || group.has(entry));
    return this.diagnostics.sum(entries, this.complete, "usageEvents", metric, metric !== "providerUsd", (entry) => this.#value(entry, metric));
  }

  tokens(group?: ReadonlySet<FactEntry>): TokenStatistics {
    return {
      input: this.total("inputTokens", group),
      output: this.total("outputTokens", group),
      cacheRead: this.total("cacheReadTokens", group),
      cacheWrite: this.total("cacheWriteTokens", group),
      reasoning: this.total("reasoningTokens", group),
      total: this.total("totalTokens", group),
    };
  }

  #covered(entry: FactEntry, metric: UsageMetric): boolean {
    const seen = new Set<string>();
    let current = text(entry.fact.kind === "subagent" ? entry.fact.parentRunId : entry.fact.runId);
    while (current && !seen.has(current)) {
      const key = identity(entry.ownerUserId, current);
      if (this.#summaryCovers(key, metric)) return true;
      seen.add(current);
      current = this.summaries.parentByRun.get(key);
    }
    return false;
  }

  #summaryCovers(runKey: string, metric: UsageMetric): boolean {
    const summaries = this.summaries.groups.get(runKey);
    const summary = summaries?.length === 1 ? summaries[0] : undefined;
    return summary !== undefined && !this.summaries.ambiguous.has(summary) && this.#value(summary, metric) !== null;
  }

  #value(entry: FactEntry, metric: UsageMetric): number | null {
    const values = this.#values.get(entry) ?? new Map<UsageMetric, number | null>();
    this.#values.set(entry, values);
    const cached = values.get(metric);
    if (cached !== undefined) return cached;
    const value = readUsageMetric(entry, metric, this.diagnostics);
    values.set(metric, value);
    return value;
  }
}

function readUsageMetric(entry: FactEntry, metric: UsageMetric, diagnostics: ResourceDiagnostics): number | null {
  if (metric === "providerUsd") {
    return diagnostics.number(entry, "usageEvents", record(entry.fact.providerCostUsd)?.total, "providerCostUsd.total", false);
  }
  const metrics = record(entry.fact.metrics);
  if (metric !== "totalTokens" || metrics?.totalTokens !== undefined) {
    return diagnostics.number(entry, "usageEvents", metrics?.[metric], metric, true);
  }
  const buckets = TOKEN_BUCKETS.map((field) => diagnostics.number(entry, "usageEvents", metrics?.[field], field, true));
  if (buckets.some((bucket) => bucket === null)) return null;
  const total = buckets.reduce<number>((previous, bucket) => previous + (bucket ?? 0), 0);
  if (Number.isSafeInteger(total)) return total;
  diagnostics.report("invalid-value", "usageEvents", entry, "Total token buckets exceed the safe integer range");
  return null;
}

interface ModelGroup {
  readonly provider: string | null;
  readonly model: string | null;
  readonly entries: FactEntry[];
}

function modelGroups(entries: ReadonlySet<FactEntry>): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const entry of entries) {
    const metadata = record(entry.fact.providerMetadata);
    const provider = text(metadata?.provider) ?? null;
    const model = text(metadata?.model) ?? null;
    const key = identity(provider, model);
    const group = groups.get(key) ?? { provider, model, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}
