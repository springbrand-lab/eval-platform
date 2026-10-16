import { useId } from "react";
import { Button, Checkbox, Field, FieldLabel, Input, NativeSelect, NativeSelectOption } from "@springbrand/site-block";
import { Plus, X } from "lucide-react";

export interface SchemaField {
  id: number;
  key: string;
  title: string;
  description: string;
  type: "number" | "integer" | "string" | "boolean";
  required: boolean;
  minimum: string;
  maximum: string;
}

export function initialSchemaFields(): SchemaField[] {
  return [
    { id: 1, key: "score", title: "评分", description: "", type: "number", required: true, minimum: "0", maximum: "10" },
    { id: 2, key: "reason", title: "评估说明", description: "", type: "string", required: true, minimum: "", maximum: "" },
  ];
}

export function buildSchemaContent(fields: readonly SchemaField[]): { content: string; error?: string } {
  const keys = new Set<string>();
  const properties: [string, Record<string, unknown>][] = [];
  const example: Record<string, unknown> = {};
  for (const [index, field] of fields.entries()) {
    const key = field.key.trim();
    if (!key) return { content: "", error: `字段 ${index + 1}：请填写标识` };
    if (keys.has(key)) return { content: "", error: `字段标识重复：${key}` };
    keys.add(key);
    const schema: Record<string, unknown> = { type: field.type };
    if (field.title.trim()) schema.title = field.title.trim();
    if (field.description.trim()) schema.description = field.description.trim();
    if (field.type === "number" || field.type === "integer") {
      const minimum = field.minimum.trim() ? Number(field.minimum) : undefined;
      const maximum = field.maximum.trim() ? Number(field.maximum) : undefined;
      if ([minimum, maximum].some((value) => value !== undefined && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))))) {
        return { content: "", error: `${key}：范围必须是可精确表示的有限数值` };
      }
      if (minimum !== undefined && maximum !== undefined && minimum > maximum) return { content: "", error: `${key}：下限不能大于上限` };
      if (minimum !== undefined) schema.minimum = minimum;
      if (maximum !== undefined) schema.maximum = maximum;
    }
    if (field.type === "integer" && typeof schema.minimum === "number" && typeof schema.maximum === "number" && Math.ceil(schema.minimum) > Math.floor(schema.maximum)) return { content: "", error: `${key}：范围内没有可用整数` };
    example[key] = field.type === "string" ? "示例说明" : field.type === "boolean" ? true : field.type === "integer"
      ? Math.ceil(Number(schema.minimum ?? Math.min(0, Math.floor(Number(schema.maximum ?? 0)))))
      : Number(schema.minimum ?? Math.min(0, Number(schema.maximum ?? 0)));
    properties.push([key, schema]);
  }
  if (!fields.length) return { content: "", error: "请至少添加一个结果字段" };
  return { content: JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: Object.fromEntries(properties),
    required: fields.filter((field) => field.required).map((field) => field.key.trim()),
    additionalProperties: false,
    examples: [example],
  }, null, 2) };
}

export function SchemaBuilder({ value, onChange }: { value: readonly SchemaField[]; onChange: (value: SchemaField[]) => void }) {
  const id = useId();
  const update = (key: number, patch: Partial<SchemaField>) => onChange(value.map((field) => field.id === key ? { ...field, ...patch } : field));
  return <section aria-label="结果字段" className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="text-sm font-semibold">结果字段</h3><p className="mt-1 text-xs text-text-muted">标识用于结果 JSON，显示名称用于实验报表。</p></div>
      <Button type="button" variant="outline" onClick={() => onChange([...value, {
        id: Math.max(0, ...value.map((field) => field.id)) + 1, key: "", title: "", description: "",
        type: "number", required: true, minimum: "", maximum: "",
      }])}><Plus />添加字段</Button>
    </div>
    {value.map((field, index) => <div key={field.id} className="min-w-0 rounded-lg border border-border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="min-w-0 truncate text-sm font-medium">字段 {index + 1}{field.title && ` · ${field.title}`}</h4>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`移除字段 ${index + 1}`} onClick={() => onChange(value.filter((item) => item.id !== field.id))}><X /></Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field><FieldLabel htmlFor={`${id}-${field.id}-key`}>标识</FieldLabel>
          <Input id={`${id}-${field.id}-key`} aria-label={`字段 ${index + 1} 标识`} required value={field.key} placeholder="例如 accuracy" onChange={(event) => update(field.id, { key: event.target.value })} /></Field>
        <Field><FieldLabel htmlFor={`${id}-${field.id}-title`}>显示名称</FieldLabel>
          <Input id={`${id}-${field.id}-title`} value={field.title} placeholder="例如 准确性" onChange={(event) => update(field.id, { title: event.target.value })} /></Field>
        <Field><FieldLabel htmlFor={`${id}-${field.id}-type`}>类型</FieldLabel>
          <NativeSelect id={`${id}-${field.id}-type`} aria-label={`字段 ${index + 1} 类型`} value={field.type} onChange={(event) => update(field.id, { type: event.target.value as SchemaField["type"] })}>
            <NativeSelectOption value="number">数值</NativeSelectOption><NativeSelectOption value="integer">整数</NativeSelectOption>
            <NativeSelectOption value="string">文本</NativeSelectOption><NativeSelectOption value="boolean">是 / 否</NativeSelectOption>
          </NativeSelect></Field>
        <Field className="sm:col-span-3"><FieldLabel htmlFor={`${id}-${field.id}-description`}>说明（可选）</FieldLabel>
          <Input id={`${id}-${field.id}-description`} value={field.description} placeholder="说明这个字段表示什么" onChange={(event) => update(field.id, { description: event.target.value })} /></Field>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-4">
        <label className="flex h-8 items-center gap-2 text-sm"><Checkbox checked={field.required} onCheckedChange={(checked) => update(field.id, { required: checked === true })} />必填</label>
        {(field.type === "number" || field.type === "integer") && <>
          <Field className="w-32"><FieldLabel htmlFor={`${id}-${field.id}-min`}>下限</FieldLabel><Input id={`${id}-${field.id}-min`} aria-label={`字段 ${index + 1} 下限`} type="number" step="any" value={field.minimum} onChange={(event) => update(field.id, { minimum: event.target.value })} /></Field>
          <Field className="w-32"><FieldLabel htmlFor={`${id}-${field.id}-max`}>上限</FieldLabel><Input id={`${id}-${field.id}-max`} aria-label={`字段 ${index + 1} 上限`} type="number" step="any" value={field.maximum} onChange={(event) => update(field.id, { maximum: event.target.value })} /></Field>
        </>}
      </div>
    </div>)}
  </section>;
}
