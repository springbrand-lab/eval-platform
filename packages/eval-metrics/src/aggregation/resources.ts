import type { ResourceInput, ResourceStatistics } from "./model.js";
import { aggregateBilling } from "./resource-billing.js";
import { ResourceDiagnostics, readStream, type OwnedSnapshot } from "./resource-facts.js";
import { aggregateTelemetry } from "./resource-telemetry.js";
import { aggregateUsage } from "./resource-usage.js";

function readCollections(inputs: readonly ResourceInput[]): {
  readonly collections: ResourceStatistics["collections"];
  readonly snapshots: readonly OwnedSnapshot[];
} {
  const collections = { collected: 0, pending: 0, failed: 0, unsubmitted: 0, finalized: 0 };
  const snapshots: OwnedSnapshot[] = [];
  for (const { ownerUserId, collection } of inputs) {
    if (!collection) {
      collections.unsubmitted += 1;
    } else if (collection.status === "collected") {
      collections.collected += 1;
      if (collection.snapshot.finalized) collections.finalized += 1;
      snapshots.push({ ownerUserId, snapshot: collection.snapshot });
    } else {
      collections[collection.status] += 1;
    }
  }
  return { collections, snapshots };
}

export function aggregateResources(inputs: readonly ResourceInput[]): ResourceStatistics {
  const { collections, snapshots } = readCollections(inputs);
  const diagnostics = new ResourceDiagnostics();
  const collectionsComplete = snapshots.length > 0 && collections.pending === 0 && collections.failed === 0;
  const usageEvents = readStream(snapshots, "usageEvents", collectionsComplete, diagnostics);
  const telemetryEvents = readStream(snapshots, "telemetryEvents", collectionsComplete, diagnostics);
  const billingSettlements = readStream(snapshots, "billingSettlements", collectionsComplete, diagnostics);
  const usage = aggregateUsage(usageEvents, diagnostics);
  const billing = aggregateBilling(billingSettlements, diagnostics);
  const operations = aggregateTelemetry(telemetryEvents, diagnostics);
  return {
    collections,
    duplicateRecords: {
      usageEvents: usageEvents.duplicates,
      telemetryEvents: telemetryEvents.duplicates,
      billingSettlements: billingSettlements.duplicates,
    },
    overlappingUsageRecords: usage.overlappingUsageRecords,
    tokens: usage.tokens,
    costs: { providerUsd: usage.providerUsd, ...billing },
    ...operations,
    byModel: usage.byModel,
    diagnostics: diagnostics.list(),
  };
}
