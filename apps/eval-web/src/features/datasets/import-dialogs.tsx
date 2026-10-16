import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { parseDatasetDocument, parsePromptDatasetUpload } from "@eval-platform/eval-dataset";
import { createDataset, datasetKeys, importDataset, importDatasetData, importPromptDataset } from "@/api-sdk/datasets-api";
import { dataKeys } from "@/api-sdk/data-api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/form";
import { ErrorBlock } from "@/components/ui/feedback";
import { FileDropzone } from "@/components/ui/file-dropzone";
import { CatalogWriteFeedback } from "@/features/catalog-write-feedback";
import { useInputLimits } from "@/features/input-limits";
import { detectTextImportFormat, textImportAccept, useTextImport } from "@/features/use-text-import";
import { isWriteOutcomeUnknown } from "@/lib/errors";
import { downloadText } from "@/lib/files";

export function DatasetCreateDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () => createDataset({ name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) }),
    meta: { silent: true },
    onError: async (error) => { if (isWriteOutcomeUnknown(error)) await client.invalidateQueries({ queryKey: datasetKeys.all }); },
    onSuccess: async (dataset) => {
      await client.invalidateQueries({ queryKey: datasetKeys.all });
      onClose();
      void navigate({ to: "/datasets/$datasetId", params: { datasetId: dataset.datasetId } });
    },
  });
  const blocked = create.isPending || isWriteOutcomeUnknown(create.error);
  return <Dialog open onClose={() => { if (!create.isPending) onClose(); }} title="新建数据集" size="sm"
    footer={<><Button disabled={create.isPending} onClick={onClose}>取消</Button><Button variant="primary" disabled={blocked || !name.trim()} loading={create.isPending} onClick={() => create.mutate()}>创建数据集</Button></>}>
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">创建后可添加用例、批量导入或选择已有用例。</p>
      <Field label="名称" required>{(id) => <Input id={id} disabled={blocked} value={name} onChange={(event) => setName(event.target.value)} />}</Field>
      <Field label="说明（可选）">{(id) => <Textarea id={id} disabled={blocked} value={description} onChange={(event) => setDescription(event.target.value)} />}</Field>
      <CatalogWriteFeedback error={create.error} />
    </div>
  </Dialog>;
}

const template = [{ name: "页面生成", description: "检查页面交付能力", userPrompt: "创建一个介绍产品的 HTML 页面", evalPrompt: "检查页面内容是否完整、结构是否清晰，并给出理由。" }];

/** One mounted dialog owns one file selection and its validated preview. */
export function DatasetImportDialog({ datasetId, onClose }: { datasetId?: string; onClose: () => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const limits = useInputLimits();
  const draft = useTextImport();
  const [format, setFormat] = useState<"json" | "jsonl" | "yaml">("json");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const edited = useRef({ name: false, description: false });
  const formats = datasetId ? ["json", "jsonl"] as const : ["json", "jsonl", "yaml"] as const;
  const list = format === "jsonl" || (format === "json" && draft.content.trimStart().startsWith("["));
  const parsed = useMemo(() => {
    if (!draft.content || draft.reading) return null;
    try {
      if (datasetId && !list) throw new Error("请选择 JSON 数组或 JSONL 用例列表；完整数据集请从数据集列表导入。");
      const document = list ? parsePromptDatasetUpload({ name: "preview", description: "preview", format: format as "json" | "jsonl", content: draft.content })
        : parseDatasetDocument(draft.content, format === "yaml" ? "yaml" : "json");
      return { document, error: null };
    } catch (error) { return { document: null, error: (error as Error).message }; }
  }, [draft.content, draft.reading, format, list, datasetId]);
  useEffect(() => {
    if (parsed?.document && !list) {
      if (!edited.current.name) setName(parsed.document.dataset.name);
      if (!edited.current.description) setDescription(parsed.document.dataset.description ?? "");
    }
  }, [parsed, list]);
  const content = parsed?.document && !list ? JSON.stringify({ ...parsed.document, dataset: { ...parsed.document.dataset, name: name.trim(), description: description.trim() || undefined } }) : draft.content;
  const maxBytes = list ? limits.data?.promptDatasetFileBytes : limits.data?.datasetDocumentBytes;
  const tooLarge = maxBytes !== undefined && Math.max(new Blob([content]).size, new Blob([draft.content]).size) > maxBytes;
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: datasetKeys.all }), client.invalidateQueries({ queryKey: dataKeys.all })]);
  const upload = useMutation({
    mutationFn: async () => {
      if (datasetId) { await importDatasetData(datasetId, { format: format as "json" | "jsonl", content }); return datasetId; }
      const result = list ? await importPromptDataset({ name: name.trim(), description: description.trim(), format: format as "json" | "jsonl", content }) : await importDataset("json", content);
      return result.dataset.datasetId;
    },
    meta: { silent: true },
    onError: async (error) => { if (isWriteOutcomeUnknown(error)) await refresh(); },
    onSuccess: async (id) => { await refresh(); toast.success("导入完成"); onClose(); void navigate({ to: "/datasets/$datasetId", params: { datasetId: id } }); },
  });
  const blocked = upload.isPending || isWriteOutcomeUnknown(upload.error);
  const valid = !!parsed?.document && !!limits.data && !tooLarge && !draft.reading && !draft.error && (datasetId || (name.trim() && (!list || description.trim())));
  return <Dialog open onClose={() => { if (!upload.isPending) onClose(); }} title={datasetId ? "批量导入用例" : "导入数据集"}
    footer={<><Button disabled={upload.isPending} onClick={onClose}>取消</Button><Button variant="primary" loading={upload.isPending} disabled={blocked || !valid} onClick={() => upload.mutate()}>确认导入</Button></>}>
    <fieldset disabled={blocked} className="flex min-w-0 flex-col gap-4">
      <p className="text-sm text-text-muted">用例列表包含名称、说明、执行任务和评估要求。导入列表不接受资源引用，导入后可为用例添加素材和初始对话。{!datasetId && "也可导入完整数据集 JSON / YAML，保留原有身份和资源引用。"}</p>
      <Button onClick={() => downloadText("cases.json", JSON.stringify(template, null, 2), "application/json")}>下载用例模板</Button>
      {!datasetId && <><Field label="名称" required>{(id) => <Input id={id} value={name} onChange={(e) => { edited.current.name = true; setName(e.target.value); }} />}</Field>
        <Field label="说明" required={list}>{(id) => <Input id={id} value={description} onChange={(e) => { edited.current.description = true; setDescription(e.target.value); }} />}</Field></>}
      <FileDropzone disabled={blocked} multiple={false} accept={textImportAccept(formats)} maxBytes={limits.data ? Math.max(limits.data.promptDatasetFileBytes, limits.data.datasetDocumentBytes) : undefined}
        onSelectionStart={draft.startSelection} onRejected={() => draft.setContent("")} onFiles={(files, signal) => {
          const file = files[0]?.file; if (!file || signal.aborted) return;
          const selected = detectTextImportFormat(file, formats); if (!selected) return;
          setFormat(selected); void draft.readFile(file, signal);
        }} />
      {draft.reading && <p role="status">正在读取文件…</p>}
      {(draft.error || parsed?.error || tooLarge) && <p role="alert" className="text-sm text-danger">{draft.error || parsed?.error || "超过大小上限"}</p>}
      {parsed?.document && <section aria-label="导入预览" className="rounded-lg border border-border p-3"><p className="mb-2 font-medium">将{datasetId ? "追加" : "导入"} {parsed.document.data.length} 条用例</p><ul className="max-h-48 overflow-auto text-sm">{parsed.document.data.map((row, index) => <li key={index} className="border-t border-border py-2">{String(row.name ?? `用例 ${index + 1}`)}：{row.userPrompt.slice(0, 100)}</li>)}</ul></section>}
      {limits.error && <ErrorBlock error={limits.error} onRetry={() => void limits.refetch()} />}
      <CatalogWriteFeedback error={upload.error} />
    </fieldset>
  </Dialog>;
}
