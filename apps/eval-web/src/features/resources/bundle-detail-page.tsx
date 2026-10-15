import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { ActionMenu } from "@/components/ui/menu";
import { useState } from "react";
import { toast } from "sonner";
import {
  bundleKeys, createMaterial, createSession, deleteBundle, deleteMaterial, deleteSession, getBundle, listMaterials,
  listSessions, updateBundle,
} from "@/api-sdk/bundles-api";
import type { MaterialRecord, SessionRecord } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CopyId } from "@/components/ui/data-display";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { FileDropzone, type PickedFile } from "@/components/ui/file-dropzone";
import { Field, Textarea } from "@/components/ui/form";
import { Tabs } from "@/components/ui/data-display";
import { fileToBase64, guessMediaType } from "@/lib/files";
import { formatBytes } from "@/lib/format";
import { MATERIAL_FILE_BYTES, MATERIAL_TOTAL_BYTES, SP_MATERIAL_MAX_FILES, SP_SESSION_CONTENT_CHARS } from "@/lib/limits";
import { MetadataDialog } from "./metadata-dialog";

export function checkMaterialFiles(files: readonly { path: string; size: number }[]): string | null {
  if (files.length === 0) return "请至少选择一个文件";
  if (files.length > SP_MATERIAL_MAX_FILES) return `最多 ${SP_MATERIAL_MAX_FILES} 个文件`;
  const big = files.find((file) => file.size > MATERIAL_FILE_BYTES);
  if (big) return `${big.path} 超过单个文件上限 ${formatBytes(MATERIAL_FILE_BYTES)}`;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MATERIAL_TOTAL_BYTES) return `总大小 ${formatBytes(total)} 超过上限 ${formatBytes(MATERIAL_TOTAL_BYTES)}`;
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) return `文件路径重复：${file.path}`;
    paths.add(file.path);
  }
  return null;
}

function MaterialUpload({ bundleId, open, onClose }: { bundleId: string; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [files, setFiles] = useState<PickedFile[]>([]);
  const problem = checkMaterialFiles(files.map((item) => ({ path: item.path, size: item.file.size })));
  const create = useMutation({
    mutationFn: async (metadata: { name: string; description: string }) => createMaterial(bundleId, {
      ...metadata,
      files: await Promise.all(files.map(async (item) => ({
        path: item.path, mediaType: item.file.type || guessMediaType(item.path), contentBase64: await fileToBase64(item.file),
      }))),
    }),
    onSuccess: async () => {
      toast.success("素材已上传");
      await queryClient.invalidateQueries({ queryKey: bundleKeys.materials(bundleId) });
      setFiles([]);
      onClose();
    },
  });
  return (
    <MetadataDialog open={open} onClose={onClose} title="上传素材" submitLabel="上传" loading={create.isPending}
      extraValid={!problem} onSubmit={(value) => create.mutate(value)}>
      <FileDropzone onFiles={(picked) => setFiles((current) => [...current, ...picked])}
        hint={`保留文件夹内的相对路径 · 单个 ≤ ${formatBytes(MATERIAL_FILE_BYTES)} · 合计 ≤ ${formatBytes(MATERIAL_TOTAL_BYTES)}`} />
      {files.length > 0 && (
        <div className="max-h-56 overflow-y-auto rounded-[var(--radius-control)] border border-border">
          {files.map((item, index) => (
            <div key={`${item.path}-${index}`} className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[13px] last:border-b-0">
              <span className="truncate font-mono">{item.path}</span>
              <span className="flex items-center gap-2 text-text-muted">
                {formatBytes(item.file.size)}
                <button type="button" aria-label="移除" onClick={() => setFiles(files.filter((_, at) => at !== index))}><X className="size-3.5" /></button>
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
  const queryClient = useQueryClient();
  const [format, setFormat] = useState<"json" | "jsonl">("jsonl");
  const [content, setContent] = useState("");
  const tooLong = content.length > SP_SESSION_CONTENT_CHARS;
  const create = useMutation({
    mutationFn: (metadata: { name: string; description: string }) => createSession(bundleId, { ...metadata, format, content }),
    onSuccess: async () => {
      toast.success("初始会话已上传");
      await queryClient.invalidateQueries({ queryKey: bundleKeys.sessions(bundleId) });
      setContent("");
      onClose();
    },
  });
  return (
    <MetadataDialog open={open} onClose={onClose} title="上传初始会话" submitLabel="上传" loading={create.isPending}
      extraValid={content.trim().length > 0 && !tooLong} onSubmit={(value) => create.mutate(value)}>
      <Field label="格式" hint={<>每项 <code className="font-mono">{"{id, message: {role, …}, createdAt}"}</code>，首条为 user 消息；JSON 为 <code className="font-mono">{"{entries: [...]}"}</code></>}>
        {() => <Tabs<"json" | "jsonl"> value={format} onChange={setFormat} tabs={[{ value: "jsonl", label: "JSONL" }, { value: "json", label: "JSON" }]} />}
      </Field>
      <FileDropzone multiple={false} accept=".json,.jsonl" onFiles={(picked) => {
        const first = picked[0];
        if (!first) return;
        if (first.path.endsWith(".json")) setFormat("json");
        if (first.path.endsWith(".jsonl")) setFormat("jsonl");
        void first.file.text().then(setContent);
      }} />
      <Field label="内容" error={tooLong ? `超过 ${SP_SESSION_CONTENT_CHARS} 个字符` : undefined}>
        {(id) => <Textarea id={id} mono rows={10} value={content} onChange={(event) => setContent(event.target.value)} />}
      </Field>
    </MetadataDialog>
  );
}

type Pending = { kind: "material"; record: MaterialRecord } | { kind: "session"; record: SessionRecord } | { kind: "bundle" };

export function BundleDetailPage({ bundleId }: { bundleId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const bundle = useQuery({ queryKey: bundleKeys.detail(bundleId), queryFn: ({ signal }) => getBundle(bundleId, signal) });
  const materials = useQuery({ queryKey: bundleKeys.materials(bundleId), queryFn: ({ signal }) => listMaterials(bundleId, signal) });
  const sessions = useQuery({ queryKey: bundleKeys.sessions(bundleId), queryFn: ({ signal }) => listSessions(bundleId, signal) });
  const [editing, setEditing] = useState(false);
  const [uploadingMaterial, setUploadingMaterial] = useState(false);
  const [uploadingSession, setUploadingSession] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const update = useMutation({
    mutationFn: (value: { name: string; description: string }) => updateBundle(bundleId, value),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: bundleKeys.all });
    },
  });
  const remove = useMutation({
    mutationFn: async (target: Pending) => {
      if (target.kind === "bundle") await deleteBundle(bundleId);
      else if (target.kind === "material") await deleteMaterial(bundleId, target.record.materialId);
      else await deleteSession(bundleId, target.record.sessionId);
      return target;
    },
    onSuccess: async (target) => {
      toast.success("已删除");
      setPending(null);
      await queryClient.invalidateQueries({ queryKey: bundleKeys.all });
      if (target.kind === "bundle") void navigate({ to: "/resources" });
    },
  });
  const deleteText = pending?.kind === "bundle"
    ? "会同时删除其中的全部素材和初始会话。仍被用例引用时不能删除。"
    : "仍被用例引用时不能删除。";
  return (
    <Page>
      <PageHeader
        title={bundle.data?.name ?? "Bundle"}
        description={bundle.data?.description}
        crumbs={[{ label: "初始资源", to: "/resources" }]}
        actions={(
          <>
            <Button icon={<Pencil />} onClick={() => setEditing(true)}>编辑</Button>
            <ActionMenu items={[{ label: "删除 Bundle", icon: <Trash2 />, danger: true, onSelect: () => setPending({ kind: "bundle" }) }]} />
          </>
        )}
      />
      {bundle.error && <ErrorBlock error={bundle.error} />}
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="素材"
            actions={<Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setUploadingMaterial(true)}>上传素材</Button>} />
          {materials.isPending ? <LoadingBlock rows={2} /> : materials.error ? <div className="p-4"><ErrorBlock error={materials.error} /></div> : (
            <DataTable<MaterialRecord>
              rows={materials.data}
              rowKey={(row) => row.materialId}
              empty={<EmptyState title="还没有素材" />}
              columns={[
                { key: "name", header: "名称", cell: (row) => <span className="font-semibold">{row.name}</span> },
                { key: "description", header: "说明", cell: (row) => <span className="text-text-muted">{row.description}</span> },
                { key: "id", header: "ID", cell: (row) => <CopyId value={row.materialId} /> },
                { key: "actions", header: "", align: "right", cell: (row) => (
                  <Button size="sm" variant="ghost" aria-label="删除素材" onClick={() => setPending({ kind: "material", record: row })}><Trash2 className="size-4" /></Button>
                ) },
              ]}
            />
          )}
        </Card>
        <Card>
          <CardHeader title="初始会话"
            actions={<Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setUploadingSession(true)}>上传初始会话</Button>} />
          {sessions.isPending ? <LoadingBlock rows={2} /> : sessions.error ? <div className="p-4"><ErrorBlock error={sessions.error} /></div> : (
            <DataTable<SessionRecord>
              rows={sessions.data}
              rowKey={(row) => row.sessionId}
              empty={<EmptyState title="还没有初始会话" />}
              columns={[
                { key: "name", header: "名称", cell: (row) => <span className="font-semibold">{row.name}</span> },
                { key: "format", header: "格式", cell: (row) => row.format.toUpperCase() },
                { key: "description", header: "说明", cell: (row) => <span className="text-text-muted">{row.description}</span> },
                { key: "id", header: "ID", cell: (row) => <CopyId value={row.sessionId} /> },
                { key: "actions", header: "", align: "right", cell: (row) => (
                  <Button size="sm" variant="ghost" aria-label="删除初始会话" onClick={() => setPending({ kind: "session", record: row })}><Trash2 className="size-4" /></Button>
                ) },
              ]}
            />
          )}
        </Card>
      </div>
      <MetadataDialog open={editing} onClose={() => setEditing(false)} title="编辑 Bundle" initial={bundle.data}
        loading={update.isPending} onSubmit={(value) => update.mutate(value)} />
      <MaterialUpload bundleId={bundleId} open={uploadingMaterial} onClose={() => setUploadingMaterial(false)} />
      <SessionUpload bundleId={bundleId} open={uploadingSession} onClose={() => setUploadingSession(false)} />
      <ConfirmDialog open={!!pending} onClose={() => setPending(null)} onConfirm={() => pending && remove.mutate(pending)}
        loading={remove.isPending} danger confirmLabel="删除" title="确认删除" description={deleteText} />
    </Page>
  );
}
