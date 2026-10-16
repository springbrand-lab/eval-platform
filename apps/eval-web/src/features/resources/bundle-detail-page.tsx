import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { ActionMenu } from "@/components/ui/menu";
import { useId, useState } from "react";
import type { EvalInputLimits } from "@eval-platform/eval-contracts";
import { toast } from "sonner";
import {
  materialBundles, sessionBundles, resourceCatalog, type ResourceKind,
} from "@/api-sdk/bundles-api";
import type { MaterialRecord, SessionRecord } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CopyId } from "@/components/ui/data-display";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { FileDropzone, type PickedFile } from "@/components/ui/file-dropzone";
import { Button as DuneButton, Field, FieldDescription, FieldError, FieldLabel, NativeSelect, NativeSelectOption, Textarea } from "@springbrand/site-block";
import { fileToBase64, guessMediaType } from "@/lib/files";
import { formatBytes } from "@/lib/format";
import { useInputLimits } from "@/features/input-limits";
import { detectTextImportFormat, textImportAccept, useTextImport } from "@/features/use-text-import";
import { MetadataDialog } from "./metadata-dialog";
import { isWriteOutcomeUnknown } from "@/lib/errors";
import { CatalogWriteFeedback } from "@/features/catalog-write-feedback";

export function checkMaterialFiles(files: readonly { path: string; size: number }[], limits: EvalInputLimits): string | null {
  if (files.length === 0) return "请至少选择一个文件";
  if (files.length > limits.materialMaxFiles) return `最多 ${limits.materialMaxFiles} 个文件`;
  const big = files.find((file) => file.size > limits.materialFileBytes);
  if (big) return `${big.path} 超过单个文件上限 ${formatBytes(limits.materialFileBytes)}`;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > limits.materialTotalBytes) return `总大小 ${formatBytes(total)} 超过上限 ${formatBytes(limits.materialTotalBytes)}`;
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) return `文件路径重复：${file.path}`;
    paths.add(file.path);
  }
  return null;
}

function MaterialUpload({ bundleId, open, onClose }: { bundleId: string; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const limits = useInputLimits();
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [extracting, setExtracting] = useState(false);
  const problem = limits.data ? checkMaterialFiles(files.map((item) => ({ path: item.path, size: item.file.size })), limits.data) : "正在读取上传上限";
  const create = useMutation({
    mutationFn: async (metadata: { name: string; description: string }) => materialBundles.createResource(bundleId, {
      ...metadata,
      files: await Promise.all(files.map(async (item) => ({
        path: item.path, mediaType: item.file.type || guessMediaType(item.path), contentBase64: await fileToBase64(item.file),
      }))),
    }),
    meta: { silent: true },
    onError: async (error) => { if (isWriteOutcomeUnknown(error)) await queryClient.invalidateQueries({ queryKey: materialBundles.keys.all }); },
    onSuccess: async () => {
      toast.success("素材已上传");
      await queryClient.invalidateQueries({ queryKey: materialBundles.keys.resources(bundleId) });
      setFiles([]);
      onClose();
    },
  });
  return (
    <MetadataDialog open={open} onClose={onClose} title="新建素材" submitLabel="创建" loading={create.isPending}
      extraValid={!problem && !extracting && !isWriteOutcomeUnknown(create.error)} onSubmit={(value) => create.mutate(value)}>
      <CatalogWriteFeedback error={create.error} />
      {limits.error && <ErrorBlock error={limits.error} onRetry={() => void limits.refetch()} />}
      <FileDropzone disabled={create.isPending} onExtractingChange={setExtracting} onFiles={(picked) => setFiles((current) => [...current, ...picked])}
        hint={limits.data ? `单个 ≤ ${formatBytes(limits.data.materialFileBytes)} · 合计 ≤ ${formatBytes(limits.data.materialTotalBytes)}` : undefined} />
      {files.length > 0 && (
        <div className="max-h-56 overflow-y-auto rounded-[var(--radius-control)] border border-border">
          {files.map((item, index) => (
            <div key={`${item.path}-${index}`} className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[13px] last:border-b-0">
              <span className="truncate font-mono">{item.path}</span>
              <span className="flex items-center gap-2 text-text-muted">
                {formatBytes(item.file.size)}
                <DuneButton type="button" variant="ghost" size="icon-xs" disabled={create.isPending} aria-label="移除" onClick={() => setFiles(files.filter((_, at) => at !== index))}><X className="size-3.5" /></DuneButton>
              </span>
            </div>
          ))}
        </div>
      )}
      {files.length > 0 && problem && <p className="text-xs text-danger">{problem}</p>}
    </MetadataDialog>
  );
}

function SessionUpload({ bundleId, open, onClose }: { bundleId: string; open: boolean; onClose: () => void }) {
  const id = useId();
  const queryClient = useQueryClient();
  const limits = useInputLimits();
  const [format, setFormat] = useState<"json" | "jsonl">("jsonl");
  const draft = useTextImport();
  const content = draft.content;
  const tooLong = !!limits.data && content.length > limits.data.sessionContentChars;
  const create = useMutation({
    mutationFn: (metadata: { name: string; description: string }) => sessionBundles.createResource(bundleId, { ...metadata, format, content }),
    meta: { silent: true },
    onError: async (error) => { if (isWriteOutcomeUnknown(error)) await queryClient.invalidateQueries({ queryKey: sessionBundles.keys.all }); },
    onSuccess: async () => {
      toast.success("初始上下文已上传");
      await queryClient.invalidateQueries({ queryKey: sessionBundles.keys.resources(bundleId) });
      onClose();
    },
  });
  return (
    <MetadataDialog open={open} onClose={onClose} title="新建上下文" submitLabel="创建" loading={create.isPending}
      extraValid={!!limits.data && content.trim().length > 0 && !draft.reading && !draft.error && !tooLong && !isWriteOutcomeUnknown(create.error)} onSubmit={(value) => create.mutate(value)}>
      <CatalogWriteFeedback error={create.error} />
      {limits.error && <ErrorBlock error={limits.error} onRetry={() => void limits.refetch()} />}
      <Field><FieldLabel htmlFor={id + "-format"}>格式</FieldLabel>
        <NativeSelect id={id + "-format"} disabled={create.isPending || draft.reading} value={format} onChange={(event) => setFormat(event.target.value as typeof format)}>
          <NativeSelectOption value="jsonl">JSONL</NativeSelectOption><NativeSelectOption value="json">JSON</NativeSelectOption>
        </NativeSelect>
        <FieldDescription>每项 <code className="font-mono">{"{id, message: {role, …}, createdAt}"}</code>，首条为 user 消息；JSON 为 <code className="font-mono">{"{entries: [...]}"}</code></FieldDescription>
      </Field>
      <FileDropzone onSelectionStart={draft.startSelection} onRejected={() => draft.setContent("")} disabled={create.isPending} multiple={false} accept={textImportAccept(["json", "jsonl"])} onFiles={(picked, signal) => {
        const first = picked[0];
        if (!first) return;
        const selectedFormat = detectTextImportFormat(first.file, ["json", "jsonl"]);
        if (selectedFormat) setFormat(selectedFormat);
        void draft.readFile(first.file, signal);
      }} />
      <Field><FieldLabel htmlFor={id + "-content"}>内容</FieldLabel>
        <Textarea id={id + "-content"} disabled={create.isPending} className="font-mono" rows={10} value={content} onChange={(event) => draft.setContent(event.target.value)} />
        {draft.reading && <FieldDescription role="status">正在读取文件…</FieldDescription>}
        <FieldError>{draft.error || (tooLong ? `超过 ${limits.data!.sessionContentChars} 个字符` : "")}</FieldError>
      </Field>
    </MetadataDialog>
  );
}

type ResourceRecord = MaterialRecord | SessionRecord;
const idOf = (record: ResourceRecord) => "materialId" in record ? record.materialId : record.sessionId;

export function BundleDetailPage({ kind, bundleId }: { kind: ResourceKind; bundleId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const limits = useInputLimits();
  const catalog = resourceCatalog(kind);
  const label = kind === "material" ? "素材" : "上下文";
  const bundle = useQuery({ queryKey: catalog.keys.detail(bundleId), queryFn: ({ signal }) => catalog.get(bundleId, signal) });
  const items = useQuery({ queryKey: catalog.keys.resources(bundleId), queryFn: async ({ signal }): Promise<ResourceRecord[]> => catalog.listResources(bundleId, signal) });
  const [editing, setEditing] = useState<{ record?: ResourceRecord } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [zip, setZip] = useState<File | null>(null);
  const [extractingZip, setExtractingZip] = useState(false);
  const [pending, setPending] = useState<{ record?: ResourceRecord } | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: catalog.keys.all });
  const update = useMutation({
    mutationFn: (value: { name: string; description: string }) => editing?.record
      ? catalog.updateResource(bundleId, idOf(editing.record), value) : catalog.update(bundleId, value),
    meta: { silent: true },
    onSuccess: async () => { setEditing(null); await invalidate(); toast.success("已保存"); },
  });
  const remove = useMutation({
    mutationFn: async () => {
      if (pending?.record) await catalog.deleteResource(bundleId, idOf(pending.record));
      else await catalog.delete(bundleId);
      return !pending?.record;
    },
    meta: { silent: true },
    onSuccess: async (whole) => {
      setPending(null); await invalidate(); toast.success("已删除");
      if (whole) void navigate({ to: "/resources/$kind", params: { kind } });
    },
  });
  const importZip = useMutation({
    mutationFn: () => catalog.importZip(bundleId, zip!),
    meta: { silent: true },
    onError: async (error) => { if (isWriteOutcomeUnknown(error)) await invalidate(); },
    onSuccess: async ({ imported }) => {
      await invalidate(); setImporting(false); setZip(null); toast.success(`已导入 ${imported.length} 条${label}`);
    },
  });
  if (!bundle.data) return <Page>{bundle.error ? <ErrorBlock error={bundle.error} onRetry={() => void bundle.refetch()} /> : <LoadingBlock />}</Page>;
  return <Page>
    <PageHeader title={bundle.data.name} description={bundle.data.description}
      crumbs={[{ label: "数据集", to: "/datasets" }, { label: `初始${label}`, to: "/resources/$kind", params: { kind } }]}
      actions={<><Button icon={<Pencil />} onClick={() => { update.reset(); setEditing({}); }}>编辑名称与说明</Button>
        <ActionMenu items={[{ label: "删除包", icon: <Trash2 />, danger: true, onSelect: () => { remove.reset(); setPending({}); } }]} /></>} />
    {bundle.error && <ErrorBlock error={bundle.error} onRetry={() => void bundle.refetch()} />}
    <Card>
      <CardHeader title={`${label}（${items.data?.length ?? 0}）`}
        description={kind === "material" ? "新建时上传文件或文件夹，创建后素材不可编辑。" : "新建时可上传文件或手动填写上下文；已有条目可编辑名称与说明。"} actions={<>
        <Button size="sm" onClick={() => { importZip.reset(); setImporting(true); }}>导入 ZIP</Button>
        <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setUploading(true)}>新建{label}</Button>
      </>} />
      {items.isPending ? <LoadingBlock /> : items.error ? <ErrorBlock error={items.error} /> : <DataTable<ResourceRecord>
        rows={items.data} rowKey={idOf} empty={<EmptyState title={`还没有${label}`} />}
        columns={[
          { key: "name", header: "名称", cell: (row) => <Link to="/resources/$kind/$bundleId/$resourceId"
            params={{ kind, bundleId, resourceId: idOf(row) }} className="link font-semibold">{row.name}</Link> },
          { key: "description", header: "说明", cell: (row) => row.description },
          { key: "format", header: "格式", cell: (row) => "format" in row ? row.format.toUpperCase() : "素材文件" },
          { key: "id", header: "ID", cell: (row) => <CopyId value={idOf(row)} /> },
          { key: "actions", header: "操作", cell: (row) => <div className="flex gap-2">
            {kind === "session" && <Button size="sm" onClick={() => { update.reset(); setEditing({ record: row }); }}>编辑名称与说明</Button>}
            <Button size="sm" variant="outline-danger" onClick={() => { remove.reset(); setPending({ record: row }); }}>删除</Button>
          </div> },
        ]} />}
    </Card>
    <MetadataDialog open={!!editing} onClose={() => { if (!update.isPending) setEditing(null); }} title={`编辑${editing?.record ? label : "包"}`}
      initial={editing?.record ?? bundle.data} loading={update.isPending} onSubmit={(value) => update.mutate(value)}>
      {update.error && <ErrorBlock error={update.error} />}
    </MetadataDialog>
    {uploading && (kind === "material" ? <MaterialUpload bundleId={bundleId} open onClose={() => setUploading(false)} />
      : <SessionUpload bundleId={bundleId} open onClose={() => setUploading(false)} />)}
    <Dialog open={importing} onClose={() => { if (!importZip.isPending) { setImporting(false); setZip(null); } }} title={`导入${label} ZIP`}
      footer={<><Button disabled={importZip.isPending} onClick={() => { setImporting(false); setZip(null); }}>取消</Button>
        <Button variant="primary" loading={importZip.isPending} disabled={!zip || extractingZip || !limits.data || zip.size > limits.data.zipArchiveBytes || isWriteOutcomeUnknown(importZip.error)} onClick={() => importZip.mutate()}>导入</Button></>}>
      <p className="mb-3 text-sm text-text-muted">导入条目使用包的说明。{kind === "session" ? "导入后可逐条编辑名称与说明。" : "素材创建后不可编辑。"}</p>
      {limits.error && <ErrorBlock error={limits.error} onRetry={() => void limits.refetch()} />}
      <FileDropzone disabled={importZip.isPending} onExtractingChange={setExtractingZip} multiple={false} accept={{ "application/zip": [".zip"] }} onRejected={() => setZip(null)} maxBytes={limits.data?.zipArchiveBytes} onFiles={(files) => setZip(files[0]?.file ?? null)} />
      {zip && <p className="mt-2 text-sm">{zip.name}</p>}
      <CatalogWriteFeedback error={importZip.error} />
    </Dialog>
    <ConfirmDialog open={!!pending} onClose={() => { if (!remove.isPending) setPending(null); }} onConfirm={() => remove.mutate()}
      loading={remove.isPending} danger confirmLabel="删除" title={`删除${pending?.record ? label : "包"}`}
      description={<>{pending?.record ? "删除后不再用于新选择。" : `将删除这个包及其中的${label}。`}已有项目的引用仍可读取。仍有样本绑定时，请先解除绑定。{remove.error && <ErrorBlock error={remove.error} />}</>} />
  </Page>;
}
