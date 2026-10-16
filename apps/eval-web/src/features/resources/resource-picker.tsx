import { useQuery } from "@tanstack/react-query";
import { resourceCatalog, type ResourceKind } from "@/api-sdk/bundles-api";
import { Button, NativeSelect, NativeSelectOption } from "@springbrand/site-block";
import { ErrorBlock } from "@/components/ui/feedback";

const NONE = "__none";
export interface PickedResource { bundleId: string; id: string }

/** Each row can choose another bundle; order is part of the frozen Data. */
export function MaterialPickerList({ value, onChange, label }: {
  value: PickedResource[]; onChange: (value: PickedResource[]) => void; label: string;
}) {
  return <div className="flex flex-col gap-2">
    {value.map((item, index) => <div key={index} className="flex items-start gap-2">
      <div className="min-w-0 flex-1"><ResourcePicker kind="material" label={`${label} ${index + 1}`} value={item} excluded={value.filter((_, at) => at !== index)} onChange={(next) => onChange(next
        ? value.map((current, at) => at === index ? next : current) : value.filter((_, at) => at !== index))} /></div>
      <Button type="button" variant="outline" disabled={index === 0} onClick={() => { const next = [...value]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; onChange(next); }} aria-label={`上移${label} ${index + 1}`}>上移</Button>
      <Button type="button" variant="outline" onClick={() => onChange(value.filter((_, at) => at !== index))} aria-label={`移除${label} ${index + 1}`}>移除</Button>
    </div>)}
    <Button type="button" variant="outline" onClick={() => onChange([...value, { bundleId: "", id: "" }])}>添加{label}</Button>
  </div>;
}

export function ResourcePicker({ kind, value, onChange, disabled, label, excluded = [] }: {
  kind: ResourceKind;
  value: PickedResource | null;
  onChange: (value: PickedResource | null) => void;
  disabled?: boolean;
  label: string;
  excluded?: readonly PickedResource[];
}) {
  const catalog = resourceCatalog(kind);
  const bundles = useQuery({ queryKey: catalog.keys.list(), queryFn: ({ signal }) => catalog.list(signal) });
  const bundleId = value?.bundleId ?? "";
  const items = useQuery({
    queryKey: catalog.keys.resources(bundleId),
    queryFn: async ({ signal }) => await catalog.listResources(bundleId, signal),
    select: (resources) => resources.map((item) => ({
      id: "materialId" in item ? item.materialId : item.sessionId,
      name: `${item.name} · ${item.description}`,
    })),
    enabled: !!bundleId,
  });
  const bundleOptions = (bundles.data ?? []).map((bundle) => ({ value: bundle.bundleId, label: `${bundle.name} · ${bundle.description}` }));
  if (bundleId && !bundleOptions.some((item) => item.value === bundleId)) bundleOptions.push({ value: bundleId, label: `当前绑定包 ${bundleId}` });
  const itemOptions = (items.data ?? []).map((item) => ({ value: item.id, label: item.name }));
  if (value?.id && !itemOptions.some((item) => item.value === value.id)) itemOptions.push({ value: value.id, label: `当前绑定 ${value.id}` });
  return <div className="flex flex-col gap-2">
    <div className="grid gap-2 sm:grid-cols-2">
      <NativeSelect aria-label={`${label}包`} disabled={disabled || bundles.isPending} value={bundleId || NONE}
        onChange={(event) => onChange(event.target.value === NONE ? null : { bundleId: event.target.value, id: "" })}>
        <NativeSelectOption value={NONE}>不绑定</NativeSelectOption>
        {bundleOptions.map((option) => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}
      </NativeSelect>
      <NativeSelect aria-label={label} disabled={disabled || !bundleId || items.isPending} value={value?.id ?? ""}
        onChange={(event) => onChange({ bundleId, id: event.target.value })}>
        <NativeSelectOption value="" disabled>{bundleId ? "请选择条目" : "先选择包"}</NativeSelectOption>
        {itemOptions.map((option) => <NativeSelectOption key={option.value} value={option.value} disabled={excluded.some((item) => item.bundleId === bundleId && item.id === option.value)}>{option.label}</NativeSelectOption>)}
      </NativeSelect>
    </div>
    {(bundles.error || items.error) && <ErrorBlock error={bundles.error ?? items.error} />}
  </div>;
}
