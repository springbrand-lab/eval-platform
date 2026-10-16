import type { ResourceStatistics } from "@/api-sdk/types";
import { MetricValue } from "./metric-value";
import { TOKEN_FIELDS } from "./metric-labels";

/** One model label and the server-computed token buckets, without a second total. */
export function TokenMetrics({ statistics }: { statistics: ResourceStatistics }) {
  const modelName = statistics.byModel.map(({ model }) => model ?? "未标识模型").join("、") || "未获得";
  return <section aria-label="Token 与缓存" className="flex min-w-0 flex-col gap-3">
    <div><h3 className="text-sm font-semibold text-text-strong">Token 与缓存</h3>
      <p className="mt-1 text-xs"><span className="text-text-muted">模型</span> <span className="font-medium break-words">{modelName}</span></p></div>
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-lg bg-surface-muted/60 p-4 sm:grid-cols-3 xl:grid-cols-6">
      {TOKEN_FIELDS.map(([key, label]) => <div key={key} className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="mt-2 text-base font-semibold tabular-nums text-text-strong"><MetricValue metric={statistics.tokens[key]} /></dd>
      </div>)}
    </dl>
    <p className="text-xs text-muted-foreground">缓存读取、缓存写入、输入和输出分别计数，推理 Token 已包含在输出中。</p>
  </section>;
}
