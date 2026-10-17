import type { ResourceStatistics } from "@/api-sdk/types";
import { MetricValue } from "./metric-value";
import { TOKEN_FIELDS } from "./metric-labels";
import { formatPercent } from "@/lib/format";

export function modelName({ byModel }: Pick<ResourceStatistics, "byModel">): string {
  return byModel.map(({ model }) => model ?? "未标识模型").join("、") || "未获得";
}

export function ModelName({ statistics }: { statistics: Pick<ResourceStatistics, "byModel"> }) {
  return <span className="break-words">{modelName(statistics)}</span>;
}

function TurnTokenSummary({ statistics }: { statistics: ResourceStatistics }) {
  return <section aria-label="思考与内容 Token" className="mt-4 rounded-lg border border-border bg-surface-muted/40 p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h4 className="text-xs font-semibold text-text-strong">思考与内容 Token</h4>
      <span className="text-[11px] text-text-muted">同一 generation 可以同时计入两类</span>
    </div>
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {([
        ["思考轮", statistics.trajectory.thinkingTurnTokens],
        ["内容轮", statistics.trajectory.contentTurnTokens],
      ] as const).map(([label, tokens]) => <div key={label} className="rounded-md border border-border bg-surface px-3 py-2.5">
        <div className="text-xs font-medium text-text-secondary">{label}</div>
        <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
          {([["输入", tokens.input], ["输出", tokens.output], ["总计", tokens.total]] as const).map(([name, metric]) => <div key={name}>
            <dt className="text-text-muted">{name}</dt>
            <dd className="mt-0.5 font-semibold tabular-nums text-text-strong"><MetricValue metric={metric} /></dd>
          </div>)}
        </dl>
      </div>)}
    </div>
  </section>;
}

/** The server-computed token buckets and cache hit rate. */
export function TokenMetrics({ statistics }: { statistics: ResourceStatistics }) {
  return <section aria-label="Token 与缓存" className="min-w-0 rounded-xl border border-border bg-surface p-4 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h3 className="text-sm font-semibold text-text-strong">Token 与缓存</h3>
        <p className="mt-1 text-xs text-text-muted">模型 <ModelName statistics={statistics} /> · 查看资源消耗与缓存使用情况。</p></div>
      <span className="rounded-full bg-surface-muted px-2 py-1 text-[11px] text-text-muted">用量</span>
    </div>
    <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
      {TOKEN_FIELDS.map(([key, label]) => <div key={key} className="min-w-0 rounded-lg bg-surface-muted/70 px-3 py-2.5">
        <dt className="text-xs text-text-muted">{label}</dt>
        <dd className="mt-1.5 text-base font-semibold tabular-nums text-text-strong"><MetricValue metric={statistics.tokens[key]} /></dd>
      </div>)}
      <div className="min-w-0 rounded-lg bg-accent-soft/60 px-3 py-2.5" title="缓存读取 Token ÷（输入 Token + 缓存读取 Token）">
        <dt className="text-xs text-text-muted">缓存命中率</dt>
        <dd className="mt-1.5 text-base font-semibold tabular-nums text-text-strong"><MetricValue metric={statistics.cacheHitRate} format={formatPercent} /></dd>
      </div>
    </dl>
    <TurnTokenSummary statistics={statistics} />
    <p className="mt-3 text-xs leading-5 text-text-muted">缓存读取、缓存写入、输入和输出分别计数，推理 Token 已包含在输出中；缓存命中率只使用输入和缓存读取 Token。</p>
  </section>;
}
