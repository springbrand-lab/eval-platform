import type { ResourceStatistics } from "@/api-sdk/types";
import { MetricValue } from "./metric-value";
import { TOKEN_FIELDS } from "./metric-labels";
import { formatPercent } from "@/lib/format";

/** The server-computed token buckets, with cache hit rate derived from input and cache-read tokens. */
export function TokenMetrics({ statistics }: { statistics: ResourceStatistics }) {
  const inputTokens = statistics.tokens.input.value;
  const cacheReadTokens = statistics.tokens.cacheRead.value;
  const cacheHitRate = inputTokens === null || cacheReadTokens === null || inputTokens + cacheReadTokens === 0
    ? null
    : cacheReadTokens / (inputTokens + cacheReadTokens);
  return <section aria-label="Token 与缓存" className="min-w-0 rounded-xl border border-border bg-surface p-4 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h3 className="text-sm font-semibold text-text-strong">Token 与缓存</h3>
        <p className="mt-1 text-xs text-text-muted">查看模型资源消耗与缓存使用情况。</p></div>
      <span className="rounded-full bg-surface-muted px-2 py-1 text-[11px] text-text-muted">用量</span>
    </div>
    <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
      {TOKEN_FIELDS.map(([key, label]) => <div key={key} className="min-w-0 rounded-lg bg-surface-muted/70 px-3 py-2.5">
        <dt className="text-xs text-text-muted">{label}</dt>
        <dd className="mt-1.5 text-base font-semibold tabular-nums text-text-strong"><MetricValue metric={statistics.tokens[key]} /></dd>
      </div>)}
      <div className="min-w-0 rounded-lg bg-accent-soft/60 px-3 py-2.5" title="缓存读取 Token ÷（输入 Token + 缓存读取 Token）">
        <dt className="text-xs text-text-muted">缓存命中率</dt>
        <dd className="mt-1.5 text-base font-semibold tabular-nums text-text-strong">{cacheHitRate === null ? "未获得" : formatPercent(cacheHitRate)}</dd>
      </div>
    </dl>
    <p className="mt-3 text-xs leading-5 text-text-muted">缓存读取、缓存写入、输入和输出分别计数，推理 Token 已包含在输出中；缓存命中率只使用输入和缓存读取 Token。</p>
  </section>;
}
