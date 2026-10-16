import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { BundleRecord } from "@/api-sdk/types";
import { Dialog } from "@/components/ui/dialog";
import { MaterialUpload, SessionUpload } from "./bundle-detail-page";
import { MetadataDialog } from "./metadata-dialog";
import { CatalogWriteFeedback } from "@/features/catalog-write-feedback";
import { isWriteOutcomeUnknown } from "@/lib/errors";
import { useQueries, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  kind: ResourceKind; value: PickedResource | null; onChange: (value: PickedResource | null) => void;
  disabled?: boolean; label: string; excluded?: readonly PickedResource[];
}) {
  const catalog = resourceCatalog(kind);
  const [creating, setCreating] = useState(false);
  const bundles = useQuery({ queryKey: catalog.keys.list(), queryFn: ({ signal }) => catalog.list(signal) });
  const lists = useQueries({ queries: (bundles.data ?? []).map((bundle) => ({
    queryKey: catalog.keys.resources(bundle.bundleId),
    queryFn: async ({ signal }: { signal: AbortSignal }) => (await catalog.listResources(bundle.bundleId, signal)).map((item) => ({
      bundleId: bundle.bundleId, id: "materialId" in item ? item.materialId : item.sessionId, name: item.name, description: item.description,
    })),
  })) });
  const rows = lists.flatMap((query) => query.data ?? []);
  const selected = rows.find((item) => item.bundleId === value?.bundleId && item.id === value.id);
  const loading = bundles.isPending || lists.some((query) => query.isPending);
  const error = bundles.error || lists.find((query) => query.error)?.error;
  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap gap-2">
      <NativeSelect aria-label={label} className="min-w-0 flex-1" disabled={disabled || loading} value={value?.id ? `${value.bundleId}/${value.id}` : NONE}
        onChange={(event) => { const row = rows.find((item) => `${item.bundleId}/${item.id}` === event.target.value); onChange(row ? { bundleId: row.bundleId, id: row.id } : null); }}>
        <NativeSelectOption value={NONE}>{loading ? "加载资源…" : "不添加"}</NativeSelectOption>
        {value?.id && !selected && <NativeSelectOption value={`${value.bundleId}/${value.id}`}>当前绑定（目录中不可选）</NativeSelectOption>}
        {(bundles.data ?? []).map((bundle) => <optgroup key={bundle.bundleId} label={bundle.name}>
          {rows.filter((row) => row.bundleId === bundle.bundleId).map((row) => <NativeSelectOption key={row.id} value={`${row.bundleId}/${row.id}`} disabled={excluded.some((item) => item.bundleId === row.bundleId && item.id === row.id)}>{row.name}</NativeSelectOption>)}
        </optgroup>)}
      </NativeSelect>
      <Button type="button" variant="outline" disabled={disabled} onClick={() => setCreating(true)}>{kind === "material" ? "上传新素材" : "导入初始对话"}</Button>
    </div>
    {selected && <p className="text-xs text-text-muted">{selected.description} <Link className="link" to="/resources/$kind/$bundleId/$resourceId" params={{ kind, bundleId: selected.bundleId, resourceId: selected.id }} target="_blank" rel="noreferrer">查看文件与内容（新标签页）</Link></p>}
    {value?.id && <ResourceFiles kind={kind} value={value} />}
    {error && <ErrorBlock error={error} onRetry={() => { void bundles.refetch(); lists.forEach((query) => { void query.refetch(); }); }} />}
    {!loading && !error && !rows.length && <p className="text-xs text-text-muted">还没有可选资源，可直接在这里创建。</p>}
    {creating && <InlineResourceCreate kind={kind} bundles={bundles.data ?? []} onClose={() => setCreating(false)} onCreated={onChange} />}
  </div>;
}

function ResourceFiles({ kind, value }: { kind: ResourceKind; value: PickedResource }) {
  const catalog = resourceCatalog(kind);
  const files = useQuery({ queryKey: catalog.keys.files(value.bundleId, value.id), queryFn: ({ signal }) => catalog.listFiles(value.bundleId, value.id, signal) });
  return files.error ? <ErrorBlock error={files.error} onRetry={() => void files.refetch()} /> : files.data ? <details className="text-xs text-text-muted"><summary className="cursor-pointer">文件概览 · {files.data.length} 个文件</summary><ul className="max-h-32 overflow-auto pl-3">{files.data.map((file) => <li key={file.path}>{file.path}</li>)}</ul></details> : null;
}

function InlineResourceCreate({ kind, bundles, onClose, onCreated }: { kind: ResourceKind; bundles: readonly BundleRecord[]; onClose: () => void; onCreated: (value: PickedResource) => void }) {
  const catalog = resourceCatalog(kind);
  const client = useQueryClient();
  const [bundleId, setBundleId] = useState(bundles[0]?.bundleId ?? "");
  const [upload, setUpload] = useState(false);
  const [newGroup, setNewGroup] = useState(!bundles.length);
  const create = useMutation({ mutationFn: (metadata: { name: string; description: string }) => catalog.create(metadata), meta: { silent: true },
    onError: async (error) => { if (isWriteOutcomeUnknown(error)) await client.invalidateQueries({ queryKey: catalog.keys.all }); },
    onSuccess: async ({ bundle }) => { await client.invalidateQueries({ queryKey: catalog.keys.all }); setBundleId(bundle.bundleId); setUpload(true); } });
  if (upload) {
    const props = { bundleId, open: true, onClose, onCreated: (id: string) => onCreated({ bundleId, id }) };
    return kind === "material" ? <MaterialUpload {...props} /> : <SessionUpload {...props} />;
  }
  if (newGroup) return <MetadataDialog open onClose={onClose} title="创建资源分组" submitLabel="创建分组并继续" loading={create.isPending} extraValid={!isWriteOutcomeUnknown(create.error)} onSubmit={(metadata) => create.mutate(metadata)}>
    <p className="text-sm text-text-muted">为新资源选择一个存放位置。分组会保留在素材或对话目录中，之后可继续添加其他资源。</p>
    <CatalogWriteFeedback error={create.error} />
  </MetadataDialog>;
  return <Dialog open onClose={onClose} title={kind === "material" ? "上传新素材" : "导入初始对话"} footer={<><Button variant="outline" onClick={() => setNewGroup(true)}>新建分组</Button><Button disabled={!bundleId} onClick={() => setUpload(true)}>继续</Button></>}>
    <p className="mb-3 text-sm text-text-muted">选择资源在素材或对话目录中的存放分组；创建完成后自动绑定到当前用例。</p>
    <NativeSelect aria-label="资源分组" value={bundleId} onChange={(event) => setBundleId(event.target.value)}>{bundles.map((bundle) => <NativeSelectOption key={bundle.bundleId} value={bundle.bundleId}>{bundle.name}</NativeSelectOption>)}</NativeSelect>
  </Dialog>;
}
