import type { JsonValue } from "@eval-platform/eval-contracts";
import type { CostStatistics, MetricNumber } from "./model.js";
import { record, text, type JsonRecord } from "../json.js";
import type { FactEntry, FactStream, ResourceDiagnostics } from "./resource-facts.js";

const ACTION_SETTLED_STATUSES = new Set(["succeeded", "failed", "outcome_unknown"]);
const MODEL_SETTLED_STATUSES = new Set(["settled", "platform_owned", "anomaly"]);

/** Settled platform charges for model requests and Actions; provider cost comes from usage. */
export function aggregateBilling(
  stream: FactStream,
  diagnostics: ResourceDiagnostics,
): Omit<CostStatistics, "providerUsd"> {
  const modelBills: FactEntry[] = [];
  const actionBills: FactEntry[] = [];
  let complete = stream.complete;
  for (const entry of stream.entries) {
    const status = text(entry.fact.status) ?? "";
    if (text(entry.fact.executionId)) {
      if (ACTION_SETTLED_STATUSES.has(status)) {
        actionBills.push(entry);
        continue;
      }
      complete = false;
      if (status !== "running") {
        diagnostics.report("unsupported-record", "billingSettlements", entry, "Unsupported Action settlement status");
      }
    } else if (MODEL_SETTLED_STATUSES.has(status)) {
      modelBills.push(entry);
    } else {
      complete = false;
      diagnostics.report("unsupported-record", "billingSettlements", entry, "Unsupported settlement record");
    }
  }
  const units = (
    entries: readonly FactEntry[],
    field: string,
    read: (fact: JsonRecord) => JsonValue | undefined,
  ): MetricNumber => diagnostics.sum(
    entries, complete, "billingSettlements", field, true,
    (entry) => diagnostics.number(entry, "billingSettlements", read(entry.fact), field, true),
  );
  return {
    modelDebitedUnits: units(modelBills, "debitedUnits", (fact) => fact.debitedUnits),
    actionChargedUnits: units(actionBills, "chargedCredits", (fact) => fact.chargedCredits),
    chargedUnits: units(
      [...modelBills, ...actionBills],
      "chargedUnits",
      (fact) => text(fact.executionId) ? fact.chargedCredits : fact.debitedUnits,
    ),
    ratedUnits: units(modelBills, "ratedUnits", (fact) => fact.ratedUnits),
    shortfallUnits: units(modelBills, "shortfallUnits", (fact) => fact.shortfallUnits),
    platformOwnedUnits: units(modelBills, "platformOwnedUnits", (fact) => record(fact.platformOwned)?.units),
  };
}
