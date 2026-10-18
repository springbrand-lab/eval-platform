const dateTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const integer = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const statistic = new Intl.NumberFormat("zh-CN", { maximumSignificantDigits: 6 });
const scientific = new Intl.NumberFormat("zh-CN", { notation: "scientific", maximumSignificantDigits: 6 });

/** Preserve small nonzero means/variances; large values stay readable in tables. */
export function formatStatistic(value: number | null | undefined): string {
  if (value === null || value === undefined) return "未获得";
  const magnitude = Math.abs(value);
  return (magnitude > 0 && (magnitude < 0.0001 || magnitude >= 1e12) ? scientific : statistic).format(value);
}

export function formatDateTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "未获得";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateTime.format(date);
}

export function formatNumber(value: number | null | undefined, digits: 0 | 2 = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return (digits === 0 ? integer : decimal).format(value);
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Large counts such as tokens: 337,833 → 337.8K. */
export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return Math.abs(value) < 10_000 ? integer.format(value) : compact.format(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(value === 1 || value === 0 ? 0 : 1)}%`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${formatStatistic(ms)} 毫秒`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes} 分 ${rest} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatMetricBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "未获得";
  return value < 1024 ? `${formatStatistic(value)} B` : formatBytes(value);
}

export function standardDeviation(variance: number | null | undefined): number | null | undefined {
  return variance === null || variance === undefined ? variance : Math.sqrt(Math.max(0, variance));
}

export const OPERATION_LABELS: Readonly<Record<string, string>> = {
  execution: "只执行",
  pipeline: "执行 + 评估",
  evaluation: "只评估",
};
