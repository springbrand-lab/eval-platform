import {
  Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow,
} from "@springbrand/site-block";
import type { ResourceStatistics } from "@/api-sdk/types";
import { MetricValue } from "./metric-value";
import { TOKEN_FIELDS } from "./metric-labels";

/** Render server-computed token buckets and their coverage without deriving a second total. */
export function TokenMetrics({ statistics }: { statistics: ResourceStatistics }) {
  const rows = [
    { key: "total", label: "全部模型", tokens: statistics.tokens },
    ...statistics.byModel.map((model) => ({
      key: JSON.stringify([model.provider, model.model]),
      label: `${model.provider ?? "未标识提供方"} / ${model.model ?? "未标识模型"}`,
      tokens: model.tokens,
    })),
  ];
  return <Table aria-label="Token 与缓存">
    <TableCaption>缓存读取、缓存写入、输入和输出分别计数，推理 Token 已包含在输出中。</TableCaption>
    <TableHeader><TableRow>
      <TableHead scope="col">模型</TableHead>
      {TOKEN_FIELDS.map(([key, label]) => <TableHead key={key} scope="col">{label}</TableHead>)}
    </TableRow></TableHeader>
    <TableBody>{rows.map((row) => <TableRow key={row.key}>
      <TableHead scope="row">{row.label}</TableHead>
      {TOKEN_FIELDS.map(([key]) => <TableCell key={key}>
        <MetricValue metric={row.tokens[key]} />
      </TableCell>)}
    </TableRow>)}</TableBody>
  </Table>;
}
