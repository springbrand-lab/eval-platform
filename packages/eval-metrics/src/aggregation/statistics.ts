import type { AgentResourceCompleteness } from "@eval-platform/eval-contracts";
import type { NumericSummary } from "./model.js";

/** The one coverage rule: complete when proven complete, partial when something is available, otherwise unavailable. */
export function coverage(complete: boolean, available: boolean): AgentResourceCompleteness {
  return complete ? "complete" : available ? "partial" : "unavailable";
}

export function summarizeNumbers(values: readonly (number | null)[]): NumericSummary {
  const available = values.filter((value): value is number => value !== null && Number.isFinite(value));
  const sorted = available.toSorted((left, right) => left - right);
  const count = sorted.length;
  if (count === 0) return { count: 0, missing: values.length, total: null, min: null, max: null, mean: null, median: null };
  const total = available.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total)) throw new RangeError("Metric aggregate exceeds the finite number range");
  const middle = Math.floor(count / 2);
  const median = count % 2 === 0 ? sorted[middle - 1]! / 2 + sorted[middle]! / 2 : sorted[middle]!;
  return { count, missing: values.length - count, total, min: sorted[0]!, max: sorted[count - 1]!, mean: total / count, median };
}
