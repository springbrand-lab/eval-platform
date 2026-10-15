import { useQuery } from "@tanstack/react-query";
import { bundleKeys, listBundles, listMaterials, listSessions } from "@/api-sdk/bundles-api";
import { Select } from "@/components/ui/form";

export type ResourceKind = "material" | "session";
export interface PickedResource { bundleId: string; id: string }

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
      <Select aria-label="Bundle" disabled={disabled} value={bundleId} onChange={(event) => {
        const next = event.target.value;
        onChange(next ? { bundleId: next, id: "" } : null);
      }}>
        <option value="">不绑定</option>
        {bundles.data?.map((bundle) => <option key={bundle.bundleId} value={bundle.bundleId}>{bundle.name}</option>)}
      </Select>
      <Select aria-label={kind === "material" ? "素材" : "初始会话"} disabled={disabled || !bundleId} value={value?.id ?? ""}
        onChange={(event) => onChange({ bundleId, id: event.target.value })}>
        <option value="">{bundleId ? "请选择" : "先选择 Bundle"}</option>
        {items.data?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </Select>
    </div>
  );
}
