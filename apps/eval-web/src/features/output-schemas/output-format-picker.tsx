import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, NativeSelect } from "@springbrand/site-block";
import { getOutputSchema, listOutputSchemas, outputSchemaKeys } from "@/api-sdk/output-schemas-api";
import { ErrorBlock } from "@/components/ui/feedback";
import { CodeBlock } from "@/components/ui/data-display";
import { OutputSchemaCreateDialog, SCORE_CONVENTION } from "./output-schemas-page";

export function OutputFormatPicker({ id, value, onChange, disabled }: { id: string; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const [creating, setCreating] = useState(false);
  const formats = useQuery({ queryKey: outputSchemaKeys.list(), queryFn: ({ signal }) => listOutputSchemas(signal) });
  const selected = useQuery({ queryKey: outputSchemaKeys.detail(value), queryFn: ({ signal }) => getOutputSchema(value, signal), enabled: !!value });
  return <div className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap gap-2"><NativeSelect id={id} required disabled={disabled || formats.isPending} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="" disabled>请选择评估结果格式</option>
      {value && !formats.data?.some((format) => format.outputSchemaId === value) && <option value={value} disabled>当前格式（不可用于新选择）</option>}
      {(formats.data ?? []).map((format) => <option key={format.outputSchemaId} value={format.outputSchemaId}>{format.name}</option>)}
    </NativeSelect><Button type="button" variant="outline" disabled={disabled} onClick={() => setCreating(true)}>新建格式</Button></div>
    <p className="text-xs text-text-muted">{SCORE_CONVENTION}</p>
    {formats.error && <ErrorBlock error={formats.error} onRetry={() => void formats.refetch()} />}
    {selected.error && <ErrorBlock error={selected.error} onRetry={() => void selected.refetch()} />}
    {selected.data && <OutputFormatPreview schema={selected.data.schema} />}
    {creating && <OutputSchemaCreateDialog onClose={() => setCreating(false)} onCreated={(record) => onChange(record.outputSchemaId)} />}
  </div>;
}

export function OutputFormatPreview({ schema }: { schema: unknown }) {
  const root = schema && typeof schema === "object" && !Array.isArray(schema) ? schema as Record<string, unknown> : {};
  const properties = root.properties && typeof root.properties === "object" && !Array.isArray(root.properties) ? root.properties as Record<string, unknown> : {};
  const required = Array.isArray(root.required) ? root.required : [];
  const fields = Object.entries(properties).map(([name, raw]) => ({ name, spec: raw && typeof raw === "object" ? raw as Record<string, unknown> : {} }));
  const example = root.examples && Array.isArray(root.examples) ? root.examples[0] : undefined;
  return <div className="min-w-0 space-y-3 text-sm">
    {fields.length ? <ul className="divide-y divide-border rounded-lg border border-border px-3">{fields.map(({ name, spec }) => <li key={name} className="py-2"><strong>{name}</strong> · {String(spec.type ?? "复合类型")} · {required.includes(name) ? "必填" : "可选"}{typeof spec.description === "string" && <p className="text-text-muted">{spec.description}</p>}</li>)}</ul> : <p>此格式使用复杂约束，请展开技术定义查看。</p>}
    {example !== undefined ? <details><summary className="cursor-pointer">结果示例</summary><CodeBlock value={JSON.stringify(example, null, 2)} /></details> : <p className="text-xs text-text-muted">结果示意：分数、结论、理由等字段由所选格式决定；此格式未提供可验证的完整示例。</p>}
    <details><summary className="cursor-pointer text-text-muted">高级 · JSON Schema 定义</summary><CodeBlock value={JSON.stringify(schema, null, 2)} /></details>
  </div>;
}
