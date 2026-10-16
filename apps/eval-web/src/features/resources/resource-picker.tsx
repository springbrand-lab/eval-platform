import { useQuery } from "@tanstack/react-query";
import { bundleKeys, listBundles, listMaterials, listSessions } from "@/api-sdk/bundles-api";
import { Select } from "@/components/ui/form";
import { Button } from "@/components/ui/button";

export type ResourceKind = "material" | "session";
const NONE = "__none";
export interface PickedResource { bundleId: string; id: string }

/** Each row can choose another bundle; order is the immutable Data reference order. */
export function MaterialPickerList({ value, onChange }: { value: PickedResource[]; onChange: (value: PickedResource[]) => void }) {
  return <div className="flex flex-col gap-2">
    {value.map((item, index) => <div key={index} className="flex items-start gap-2">
      <div className="min-w-0 flex-1"><ResourcePicker kind="material" value={item} onChange={(next) => onChange(next
        ? value.map((current, at) => at === index ? next : current) : value.filter((_, at) => at !== index))} /></div>
      <Button onClick={() => onChange(value.filter((_, at) => at !== index))} aria-label={`移除素材 ${index + 1}`}>移除</Button>
    </div>)}
    <Button onClick={() => onChange([...value, { bundleId: "", id: "" }])}>添加素材</Button>
  </div>;
}

/** Choose a Bundle, then one Material or Session in it; an empty Bundle choice clears the binding. */
export function ResourcePicker({ kind, value, onChange, disabled }: {
  kind: ResourceKind;
  value: PickedResource | null;
  onChange: (value: PickedResource | null) => void;
  disabled?: boolean;
}) {
  const bundles = useQuery({ queryKey: bundleKeys.list(), queryFn: ({ signal }) => listBundles(signal) });
  const bundleId = value?.bundleId ?? "";
  const items = useQuery({
    queryKey: kind === "material" ? bundleKeys.materials(bundleId) : bundleKeys.sessions(bundleId),
    queryFn: async ({ signal }) => kind === "material"
      ? (await listMaterials(bundleId, signal)).map((item) => ({ id: item.materialId, name: item.name }))
      : (await listSessions(bundleId, signal)).map((item) => ({ id: item.sessionId, name: `${item.name}（${item.format.toUpperCase()}）` })),
    enabled: !!bundleId,
  });
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Select aria-label="Bundle" disabled={disabled} value={bundleId || NONE} placeholder="不绑定"
        onValueChange={(next) => onChange(next === NONE ? null : { bundleId: next, id: "" })}
        options={[{ value: NONE, label: "不绑定" }, ...(bundles.data ?? []).map((bundle) => ({ value: bundle.bundleId, label: bundle.name }))]} />
      <Select aria-label={kind === "material" ? "素材" : "初始会话"} disabled={disabled || !bundleId} value={value?.id ?? ""}
        placeholder={bundleId ? "请选择" : "先选择 Bundle"}
        onValueChange={(next) => onChange({ bundleId, id: next })}
        options={(items.data ?? []).map((item) => ({ value: item.id, label: item.name }))} />
    </div>
  );
}
