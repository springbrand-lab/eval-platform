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
  if (count === 0) return { count: 0, missing: values.length, total: null, min: null, max: null, mean: null, variance: null, median: null };
  const total = finiteSum(available);
  // Center before squaring: E[x²] - E[x]² loses small spreads around large offsets.
  const offsets = available.map((value) => value - available[0]!);
  const meanOffset = finiteSum(offsets) / count;
  const variance = finiteSum(offsets.map((value) => (value - meanOffset) ** 2)) / count;
  const middle = Math.floor(count / 2);
  const median = count % 2 === 0 ? sorted[middle - 1]! / 2 + sorted[middle]! / 2 : sorted[middle]!;
  return { count, missing: values.length - count, total, min: sorted[0]!, max: sorted[count - 1]!, mean: total / count, variance, median };
}

/** Compensated summation keeps small observations when values have different magnitudes. */
function finiteSum(values: readonly number[]): number {
  let total = 0;
  let correction = 0;
  for (const value of values) {
    const next = total + value;
    correction += Math.abs(total) >= Math.abs(value) ? (total - next) + value : (value - next) + total;
    total = next;
  }
  const result = total + correction;
  if (!Number.isFinite(result)) throw new RangeError("Metric aggregate exceeds the finite number range");
  return result;
}
