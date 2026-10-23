import type { AgentResourceCollection } from "@eval-platform/eval-contracts";
import type { ResourceStatistics } from "./model.js";
import { aggregateBilling } from "./resource-billing.js";
import { ResourceDiagnostics, readStream, type OwnedSnapshot } from "./resource-facts.js";
import { aggregateTelemetry } from "./resource-telemetry.js";
import { aggregateUsage, cacheHitRate, type ModelGroupKey } from "./resource-usage.js";
import { coverage } from "./statistics.js";

export interface ResourceInput {
  readonly ownerUserId: string;
  readonly collection: AgentResourceCollection | undefined;
  /** The Attempt reached SP, so a missing collection is a gap rather than nothing to collect. */
  readonly submitted?: boolean;
  /** Whether this Attempt can still emit telemetry. Raw aggregation callers default to true. */
  readonly canEmitTelemetry?: boolean;
}

function readCollections(inputs: readonly ResourceInput[]): {
  readonly collections: ResourceStatistics["collections"];
  readonly snapshots: readonly OwnedSnapshot[];
} {
  const collections = { collected: 0, pending: 0, failed: 0, uncollected: 0, unsubmitted: 0, finalized: 0 };
  const snapshots: OwnedSnapshot[] = [];
  for (const input of inputs) {
    const { ownerUserId, collection, submitted } = input;
    if (!collection) {
      collections[submitted ? "uncollected" : "unsubmitted"] += 1;
    } else if (collection.status === "collected") {
      collections.collected += 1;
      if (collection.snapshot.finalized) collections.finalized += 1;
      snapshots.push({ ownerUserId, canEmitTelemetry: input.canEmitTelemetry ?? true, snapshot: collection.snapshot });
    } else {
      collections[collection.status] += 1;
    }
  }
  return { collections, snapshots };
}

/** Requested domains let the interpreter prove unused groups without inferring absence from numeric totals. */
export interface ResourceGroups {
  readonly models: readonly ModelGroupKey[];
  readonly tools: readonly (string | null)[];
}

export function aggregateResources(inputs: readonly ResourceInput[], groups: ResourceGroups = { models: [], tools: [] }): ResourceStatistics {
  const { collections, snapshots } = readCollections(inputs);
  const diagnostics = new ResourceDiagnostics();
  const collectionsComplete = snapshots.length > 0 && collections.pending === 0 && collections.failed === 0
    && collections.uncollected === 0;
  const usageEvents = readStream(snapshots, "usageEvents", collectionsComplete, diagnostics);
  const telemetryEvents = readStream(snapshots, "telemetryEvents", collectionsComplete, diagnostics);
  const billingSettlements = readStream(snapshots, "billingSettlements", collectionsComplete, diagnostics);
  const billing = aggregateBilling(billingSettlements, diagnostics);
  const { modelRequests, trajectory, nativeUsage } = aggregateTelemetry(telemetryEvents, diagnostics, groups.tools);
  const usage = aggregateUsage({
    entries: [...usageEvents.entries, ...nativeUsage.entries],
    complete: usageEvents.complete && nativeUsage.complete,
    duplicates: usageEvents.duplicates,
  }, diagnostics, groups.models);
  const issues = diagnostics.list();
  const streamsComplete = usageEvents.complete && telemetryEvents.complete && billingSettlements.complete;
  return {
    coverage: coverage(streamsComplete && issues.length === 0, snapshots.length > 0),
    collections,
    duplicateRecords: {
      usageEvents: usageEvents.duplicates,
      telemetryEvents: telemetryEvents.duplicates,
      billingSettlements: billingSettlements.duplicates,
    },
    overlappingUsageRecords: usage.overlappingUsageRecords,
    tokens: usage.tokens,
    cacheHitRate: cacheHitRate(usage.tokens),
    costs: { providerUsd: usage.providerUsd, ...billing },
    modelRequests,
    trajectory: { ...trajectory, diagnostics: issues.filter((issue) => issue.stream === "telemetryEvents") },
    byModel: usage.byModel,
    diagnostics: issues,
  };
}
