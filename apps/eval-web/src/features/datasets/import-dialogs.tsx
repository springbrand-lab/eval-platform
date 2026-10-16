import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  FieldDescription, FieldError,
  Tabs, TabsContent, TabsList, TabsTrigger,
} from "@springbrand/site-block";
import { createDataset, datasetKeys, importDataset, importPromptDataset, type DatasetFormat } from "@/api-sdk/datasets-api";
import { dataKeys } from "@/api-sdk/data-api";
import type { DatasetSnapshot } from "@/api-sdk/types";
import { ErrorBlock } from "@/components/ui/feedback";
import { FileDropzone } from "@/components/ui/file-dropzone";
import { parseDatasetDocument, parseStrictJson } from "@eval-platform/eval-dataset";
import { CatalogMetadataFields } from "@/features/catalog-metadata-fields";
import { CatalogWriteFeedback } from "@/features/catalog-write-feedback";
import { buildDataInput, createDataDraft, DataDraftFields, type DataDraft } from "./data-draft-fields";
import { useInputLimits } from "@/features/input-limits";
import { detectTextImportFormat, textImportAccept, useTextImport } from "@/features/use-text-import";
import { isWriteOutcomeUnknown } from "@/lib/errors";

function useDatasetImport(onClose: () => void) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: datasetKeys.all }),
    queryClient.invalidateQueries({ queryKey: dataKeys.all }),
  ]);
  return {
    onSuccess: async (snapshot: DatasetSnapshot) => {
      toast.success(`已创建「${snapshot.dataset.name}」，共 ${snapshot.data.length} 条用例`);
      await refresh();
      onClose();
      void navigate({ to: "/datasets/$datasetId", params: { datasetId: snapshot.dataset.datasetId } });
    },
    onError: async (error: unknown) => { if (isWriteOutcomeUnknown(error)) await refresh(); },
  };
}

type CreationMode = "import" | "manual";
type CreationInput =
  | { mode: "empty"; name: string; description: string }
  | { mode: "prompt"; name: string; description: string; format: "json" | "jsonl"; content: string }
  | { mode: "document"; format: DatasetFormat; content: string };

async function createFromInput(input: CreationInput): Promise<DatasetSnapshot> {
  if (input.mode === "empty") return { dataset: await createDataset({ name: input.name, ...(input.description ? { description: input.description } : {}) }), data: [] };
  if (input.mode === "prompt") return importPromptDataset({ name: input.name, description: input.description, format: input.format, content: input.content });
  /** A whole Dataset document as exported: {dataset, data}. */
  return importDataset(input.format, input.content);
}

/** One mounted dialog owns one prompt import draft. */
export function DatasetCreateDialog({ onClose }: { onClose: () => void }) {
  const limits = useInputLimits();
  const [metadata, setMetadata] = useState({ name: "", description: "" });
  const edited = useRef({ name: false, description: false });
  const [mode, setMode] = useState<CreationMode>("import");
  const [format, setFormat] = useState<"json" | "jsonl" | "yaml">("jsonl");
  const [fileName, setFileName] = useState("");
  const [cases, setCases] = useState<{ key: number; draft: DataDraft }[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const nextKey = useRef(0);
  const draft = useTextImport();
  const callbacks = useDatasetImport(onClose);
  const mutation = useMutation({ mutationFn: createFromInput, ...callbacks, meta: { silent: true } });
  const blocked = mutation.isPending || isWriteOutcomeUnknown(mutation.error);
  const formats = ["json", "jsonl", "yaml"] as const;
  const listImport = format === "jsonl" || (format === "json" && draft.content.trimStart().startsWith("["));
  const imported = useMemo(() => {
    if (!draft.content || draft.reading) return {};
    try {
      if (format === "jsonl" || (format === "json" && draft.content.trimStart().startsWith("["))) {
        const rows: unknown = format === "jsonl" ? draft.content.split(/\r?\n/u).filter((line) => line.trim()).map(parseStrictJson) : parseStrictJson(draft.content);
        return Array.isArray(rows) && rows.length ? {} : { error: "文件中没有可导入的用例" };
      }
      return { document: parseDatasetDocument(draft.content, format === "yaml" ? "yaml" : "json") };
    } catch (error) { return { error: error instanceof Error ? error.message : "文件内容格式不正确" }; }
  }, [draft.content, draft.reading, format]);
  useEffect(() => {
    if (!imported.document) return;
    const dataset = imported.document.dataset;
    setMetadata((current) => ({
      name: edited.current.name ? current.name : dataset.name,
      description: edited.current.description ? current.description : dataset.description ?? "",
    }));
  }, [imported.document]);
  const labels = { name: metadata.name.trim(), description: metadata.description.trim() };
  const inputs = cases.map((item) => buildDataInput(item.draft));
  const invalid = inputs.findIndex((input) => typeof input === "string");
  const manualContent = invalid < 0 ? JSON.stringify({ dataset: labels, data: inputs }) : "";
  const documentContent = imported.document ? JSON.stringify({ ...imported.document, dataset: { ...imported.document.dataset, ...labels } }) : "";
  const content = mode === "manual" ? manualContent : listImport ? draft.content : documentContent;
  const active = cases.find((item) => item.key === selected) ?? cases[0];
  const maxBytes = mode === "import" && listImport ? limits.data?.promptDatasetFileBytes : limits.data?.datasetDocumentBytes;
  const fileMaxBytes = limits.data ? Math.max(limits.data.promptDatasetFileBytes, limits.data.datasetDocumentBytes) : undefined;
  const tooLarge = maxBytes !== undefined && Math.max(new Blob([content]).size, mode === "import" ? new Blob([draft.content]).size : 0) > maxBytes;
  const valid = !blocked && !!limits.data && !!labels.name && !!labels.description && !tooLarge && (mode === "manual" ? invalid < 0
    : !!draft.content.trim() && !draft.reading && !draft.error && !imported.error);
  return <Dialog open onOpenChange={(next) => { if (!next && !mutation.isPending) onClose(); }}>
    <DialogContent className={`flex max-h-[calc(100dvh-2rem)] flex-col ${mode === "manual" && cases.length ? "sm:max-w-5xl" : "sm:max-w-3xl"}`} showCloseButton={!mutation.isPending}>
      <DialogHeader><DialogTitle>新建数据集</DialogTitle>
        <DialogDescription>导入已有数据，或手动创建。用例可以现在添加，也可以稍后补充。</DialogDescription></DialogHeader>
      <Tabs value={mode} className="flex min-h-0 flex-col gap-4" onValueChange={(value) => {
        if (blocked) return;
        setMode(value as CreationMode);
        if (draft.reading) setFileName("");
        draft.setContent(draft.content); mutation.reset();
      }}>
        <TabsList className="h-auto w-full flex-wrap">
          <TabsTrigger value="import" disabled={blocked}>导入数据集</TabsTrigger>
          <TabsTrigger value="manual" disabled={blocked}>手动创建</TabsTrigger>
        </TabsList>
      <TabsContent value={mode} className="flex min-h-0 flex-col">
      <form className="flex min-h-0 flex-col gap-4" onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        mutation.mutate(mode === "manual"
          ? cases.length ? { mode: "document", format: "json", content: manualContent } : { mode: "empty", ...labels }
          : listImport ? { mode: "prompt", ...labels, format: format === "json" ? "json" : "jsonl", content: draft.content }
            : { mode: "document", format: "json", content: documentContent });
      }}>
        <div className="min-h-0 min-w-0 overflow-y-auto overscroll-contain">
        <fieldset disabled={blocked} className="flex min-w-0 flex-col gap-4">
          <CatalogMetadataFields value={metadata} onChange={(patch) => {
            if ("name" in patch) edited.current.name = true;
            if ("description" in patch) edited.current.description = true;
            setMetadata((current) => ({ ...current, ...patch }));
          }} />
          {limits.error && <ErrorBlock error={limits.error} onRetry={() => void limits.refetch()} />}
          {mode === "manual" ? <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <div><h3 className="text-sm font-semibold">用例 · {cases.length}</h3>
                <p className="mt-1 text-xs text-text-muted">可选。沿用详情页的编辑与资源绑定；创建时一起保存。</p></div>
              <Button type="button" variant="outline" onClick={() => {
                const key = ++nextKey.current;
                setCases((current) => [...current, { key, draft: createDataDraft() }]); setSelected(key);
              }}><Plus />添加用例</Button>
            </div>
            {!active ? <p className="rounded-lg bg-surface-muted p-4 text-sm text-text-muted">将创建空数据集，之后可以进入数据集添加用例。</p> : <div className="grid min-w-0 gap-4 md:grid-cols-[200px_minmax(0,1fr)]">
              <nav aria-label="用例列表" className="flex flex-col gap-2">
                {cases.map((item, index) => <div key={item.key} className="flex min-w-0 items-start gap-1">
                  <Button type="button" variant={active.key === item.key ? "secondary" : "ghost"}
                    aria-label={`编辑用例 ${index + 1}`} aria-pressed={active.key === item.key}
                    className="h-auto min-w-0 flex-1 justify-start px-3 py-2.5 text-left" onClick={() => setSelected(item.key)}>
                    <span className="min-w-0"><span className="block truncate">{index + 1}. {item.draft.name.trim() || "未命名用例"}</span>
                      <span className={`mt-1 block text-xs font-normal ${typeof inputs[index] === "string" ? "text-warning" : "text-text-muted"}`}>{typeof inputs[index] === "string" ? "待完善" : "已填写"}</span></span>
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`移除用例 ${index + 1}`}
                    onClick={() => setCases((current) => current.filter((entry) => entry.key !== item.key))}><X /></Button>
                </div>)}
              </nav>
              <section aria-label="用例编辑" className="flex min-w-0 flex-col gap-4">
                <DataDraftFields key={active.key} draft={active.draft} onChange={(update) => setCases((current) => current.map((item) =>
                  item.key === active.key ? { ...item, draft: typeof update === "function" ? update(item.draft) : update } : item))} />
              </section>
            </div>}
            {invalid >= 0 && <FieldError>用例 {invalid + 1}：{inputs[invalid] as string}</FieldError>}
            {tooLarge && <FieldError>数据集超过大小上限，请减少本次创建的用例。</FieldError>}
          </> : <>
          <FileDropzone onSelectionStart={() => { setFileName(""); return draft.startSelection(); }}
            onRejected={() => { setFileName(""); draft.setContent(""); }} disabled={blocked} multiple={false} accept={textImportAccept(formats)} maxBytes={fileMaxBytes}
            onFiles={(files, signal) => {
              const first = files[0];
              if (!first || signal.aborted) return;
              const selectedFormat = detectTextImportFormat(first.file, formats);
              if (!selectedFormat) { setFileName(""); draft.setContent(""); return; }
              setFormat(selectedFormat); setFileName(first.file.name);
              if (!edited.current.name) setMetadata((current) => ({ ...current, name: first.path.replace(/^\//u, "").replace(/\.(json|jsonl|ya?ml)$/iu, "") }));
              void draft.readFile(first.file, signal);
            }} />
          {fileName && <p className="break-all text-sm text-text-secondary">已选择：{fileName}</p>}
          {draft.reading && <FieldDescription role="status">正在读取文件…</FieldDescription>}
          <FieldError>{draft.error || imported.error || (tooLarge ? "超过大小上限" : "")}</FieldError>
          </>}
          <CatalogWriteFeedback error={mutation.error} />
        </fieldset>
        </div>
        <DialogFooter className="shrink-0"><Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>取消</Button>
          <Button type="submit" loading={mutation.isPending} disabled={!valid}>创建数据集</Button></DialogFooter>
      </form>
      </TabsContent>
      </Tabs>
    </DialogContent>
  </Dialog>;
}
