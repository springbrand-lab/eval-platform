import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { toast } from "sonner";
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Field, FieldDescription, FieldError, FieldLabel, Input, NativeSelect, NativeSelectOption, Textarea,
} from "@springbrand/site-block";
import { datasetKeys, importDataset, importPromptDataset, type DatasetFormat } from "@/api-sdk/datasets-api";
import { dataKeys } from "@/api-sdk/data-api";
import type { DatasetSnapshot } from "@/api-sdk/types";
import { ErrorBlock } from "@/components/ui/feedback";
import { FileDropzone } from "@/components/ui/file-dropzone";
import { CatalogWriteFeedback } from "@/features/catalog-write-feedback";
import { useInputLimits } from "@/features/input-limits";
import { detectTextImportFormat, textImportAccept, useTextImport } from "@/features/use-text-import";
import { isWriteOutcomeUnknown } from "@/lib/errors";
import { formatBytes } from "@/lib/format";

function useDatasetImport(onClose: () => void) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: datasetKeys.all }),
    queryClient.invalidateQueries({ queryKey: dataKeys.all }),
  ]);
  return {
    onSuccess: async (snapshot: DatasetSnapshot) => {
      toast.success(`已导入「${snapshot.dataset.name}」，共 ${snapshot.data.length} 条用例`);
      await refresh();
      onClose();
      void navigate({ to: "/datasets/$datasetId", params: { datasetId: snapshot.dataset.datasetId } });
    },
    onError: async (error: unknown) => { if (isWriteOutcomeUnknown(error)) await refresh(); },
  };
}

const PROMPT_EXAMPLE = `{"name":"Hello 页面","description":"生成一个最小 HTML 页面","userPrompt":"在工作区根目录创建 index.html，标题为 Hello Eval","evalPrompt":"检查 /index.html 是否存在且标题正确，按评分格式打分"}`;

/** One mounted dialog owns one prompt import draft. */
export function PromptImportDialog({ onClose }: { onClose: () => void }) {
  const id = useId();
  const limits = useInputLimits();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [format, setFormat] = useState<"json" | "jsonl">("jsonl");
  const draft = useTextImport();
  const callbacks = useDatasetImport(onClose);
  const mutation = useMutation({ mutationFn: importPromptDataset, ...callbacks, meta: { silent: true } });
  const tooLarge = !!limits.data && new Blob([draft.content]).size > limits.data.promptDatasetFileBytes;
  const valid = !!limits.data && !!name.trim() && !!description.trim() && !!draft.content.trim()
    && !draft.reading && !draft.error && !tooLarge && !isWriteOutcomeUnknown(mutation.error);
  return <Dialog open onOpenChange={(next) => { if (!next && !mutation.isPending) onClose(); }}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-3xl" showCloseButton={!mutation.isPending}>
      <DialogHeader><DialogTitle>导入提示词测试集</DialogTitle>
        <DialogDescription>每条用例需要 name、description、userPrompt、evalPrompt，可带其他字段。</DialogDescription></DialogHeader>
      <form className="flex min-h-0 flex-col gap-4" onSubmit={(event) => {
        event.preventDefault();
        if (valid && !mutation.isPending) mutation.mutate({ name: name.trim(), description: description.trim(), format, content: draft.content });
      }}>
        <fieldset disabled={mutation.isPending} className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain">
          <div className="grid gap-4 md:grid-cols-3">
            <Field><FieldLabel htmlFor={id + "-name"}>测试集名称</FieldLabel><Input id={id + "-name"} required value={name} onChange={(event) => setName(event.target.value)} /></Field>
            <Field><FieldLabel htmlFor={id + "-description"}>说明</FieldLabel><Input id={id + "-description"} required value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
            <Field><FieldLabel htmlFor={id + "-format"}>格式</FieldLabel><NativeSelect id={id + "-format"} disabled={draft.reading} value={format} onChange={(event) => setFormat(event.target.value as typeof format)}>
              <NativeSelectOption value="jsonl">JSONL</NativeSelectOption><NativeSelectOption value="json">JSON 数组</NativeSelectOption>
            </NativeSelect></Field>
          </div>
          {limits.error && <ErrorBlock error={limits.error} onRetry={() => void limits.refetch()} />}
          <FileDropzone onSelectionStart={draft.startSelection} onRejected={() => draft.setContent("")} disabled={mutation.isPending} multiple={false} accept={textImportAccept(["json", "jsonl"])} maxBytes={limits.data?.promptDatasetFileBytes}
            hint={limits.data ? `上限 ${formatBytes(limits.data.promptDatasetFileBytes)}` : undefined} onFiles={(files, signal) => {
              const first = files[0];
              if (!first) return;
              const selectedFormat = detectTextImportFormat(first.file, ["json", "jsonl"]);
              if (selectedFormat) setFormat(selectedFormat);
              setName((current) => current || first.path.replace(/^\//u, "").replace(/\.(json|jsonl)$/iu, ""));
              void draft.readFile(first.file, signal);
            }} />
          <Field><FieldLabel htmlFor={id + "-content"}>内容</FieldLabel>
            <Textarea id={id + "-content"} required className="font-mono" rows={10} value={draft.content} onChange={(event) => draft.setContent(event.target.value)} />
            <FieldDescription>示例：<code className="font-mono">{PROMPT_EXAMPLE}</code></FieldDescription>
            {draft.reading && <FieldDescription role="status">正在读取文件…</FieldDescription>}
            <FieldError>{draft.error || (tooLarge ? "超过大小上限" : "")}</FieldError>
          </Field>
          <CatalogWriteFeedback error={mutation.error} />
        </fieldset>
        <DialogFooter><Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>取消</Button>
          <Button type="submit" loading={mutation.isPending} disabled={!valid}>导入</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

/** A whole Dataset document as exported: {dataset, data}. */
export function DocumentImportDialog({ onClose }: { onClose: () => void }) {
  const id = useId();
  const limits = useInputLimits();
  const [format, setFormat] = useState<DatasetFormat>("json");
  const draft = useTextImport();
  const tooLarge = !!limits.data && new Blob([draft.content]).size > limits.data.datasetDocumentBytes;
  const callbacks = useDatasetImport(onClose);
  const mutation = useMutation({
    mutationFn: (input: { format: DatasetFormat; content: string }) => importDataset(input.format, input.content),
    ...callbacks, meta: { silent: true },
  });
  const valid = !!limits.data && !!draft.content.trim() && !draft.reading && !draft.error && !tooLarge && !isWriteOutcomeUnknown(mutation.error);
  return <Dialog open onOpenChange={(next) => { if (!next && !mutation.isPending) onClose(); }}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-3xl" showCloseButton={!mutation.isPending}>
      <DialogHeader><DialogTitle>导入测试集文档</DialogTitle><DialogDescription>与导出格式相同：{'{dataset, data}'}。</DialogDescription></DialogHeader>
      <form className="flex min-h-0 flex-col gap-4" onSubmit={(event) => {
        event.preventDefault(); if (valid && !mutation.isPending) mutation.mutate({ format, content: draft.content });
      }}>
        <fieldset disabled={mutation.isPending} className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain">
          <Field><FieldLabel htmlFor={id + "-format"}>格式</FieldLabel><NativeSelect id={id + "-format"} disabled={draft.reading} value={format} onChange={(event) => setFormat(event.target.value as DatasetFormat)}>
            <NativeSelectOption value="json">JSON</NativeSelectOption><NativeSelectOption value="yaml">YAML</NativeSelectOption>
          </NativeSelect></Field>
          {limits.error && <ErrorBlock error={limits.error} onRetry={() => void limits.refetch()} />}
          <FileDropzone onSelectionStart={draft.startSelection} onRejected={() => draft.setContent("")} disabled={mutation.isPending} multiple={false} accept={textImportAccept(["json", "yaml"])} maxBytes={limits.data?.datasetDocumentBytes} onFiles={(files, signal) => {
            const first = files[0];
            if (!first) return;
            const selectedFormat = detectTextImportFormat(first.file, ["json", "yaml"]);
            if (selectedFormat) setFormat(selectedFormat);
            void draft.readFile(first.file, signal);
          }} />
          <Field><FieldLabel htmlFor={id + "-content"}>内容</FieldLabel>
            <Textarea id={id + "-content"} required className="font-mono" rows={12} value={draft.content} onChange={(event) => draft.setContent(event.target.value)} />
            {draft.reading && <FieldDescription role="status">正在读取文件…</FieldDescription>}
            <FieldError>{draft.error || (tooLarge ? "超过大小上限" : "")}</FieldError>
          </Field>
          <CatalogWriteFeedback error={mutation.error} />
        </fieldset>
        <DialogFooter><Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>取消</Button>
          <Button type="submit" loading={mutation.isPending} disabled={!valid}>导入</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
