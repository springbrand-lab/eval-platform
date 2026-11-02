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
  const toolBills: FactEntry[] = [];
  const unclassifiedBills: FactEntry[] = [];
  let complete = stream.complete;
  for (const entry of stream.entries) {
    const status = text(entry.fact.status) ?? "";
    const source = text(entry.fact.source);
    if (text(entry.fact.executionId)) {
      if (ACTION_SETTLED_STATUSES.has(status)) {
        if (source === "action") actionBills.push(entry);
        else if (source === "tool") toolBills.push(entry);
        else {
          // Preserve historical observed totals, but without a source never
          // assert that this debit belonged to an SP Action.
          unclassifiedBills.push(entry);
          complete = false;
          diagnostics.report("unsupported-record", "billingSettlements", entry, "Unclassified ledger charge source");
        }
        continue;
      }
      complete = false;
      if (status !== "running") {
        diagnostics.report("unsupported-record", "billingSettlements", entry, "Unsupported Action settlement status");
      }
    } else if ((source === undefined || source === "model") && MODEL_SETTLED_STATUSES.has(status)) {
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
    integer = true,
  ): MetricNumber => diagnostics.sum(
    entries, complete, "billingSettlements", field, integer,
    (entry) => diagnostics.number(entry, "billingSettlements", read(entry.fact), field, integer),
  );
  return {
    modelDebitedUnits: units(modelBills, "debitedUnits", (fact) => fact.debitedUnits),
    actionChargedUnits: units(actionBills, "chargedCredits", (fact) => fact.chargedCredits, false),
    chargedUnits: units(
      [...modelBills, ...actionBills, ...toolBills, ...unclassifiedBills],
      "chargedUnits",
      (fact) => text(fact.executionId) ? fact.chargedCredits : fact.debitedUnits, false,
    ),
    ratedUnits: units(modelBills, "ratedUnits", (fact) => fact.ratedUnits),
    shortfallUnits: units(modelBills, "shortfallUnits", (fact) => fact.shortfallUnits),
    platformOwnedUnits: units(modelBills, "platformOwnedUnits", (fact) => record(fact.platformOwned)?.units),
  };
}
