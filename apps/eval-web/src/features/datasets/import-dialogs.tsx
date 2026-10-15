import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { datasetKeys, importDataset, importPromptDataset, type DatasetFormat } from "@/api-sdk/datasets-api";
import { dataKeys } from "@/api-sdk/data-api";
import type { DatasetSnapshot } from "@/api-sdk/types";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/feedback";
import { FileDropzone } from "@/components/ui/file-dropzone";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { describeError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { DATASET_DOCUMENT_BYTES } from "@/lib/limits";

function useImported(onClose: () => void) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async (snapshot: DatasetSnapshot) => {
    toast.success(`已导入「${snapshot.dataset.name}」，共 ${snapshot.data.length} 条用例`);
    await queryClient.invalidateQueries({ queryKey: datasetKeys.all });
    await queryClient.invalidateQueries({ queryKey: dataKeys.all });
    onClose();
    void navigate({ to: "/datasets/$datasetId", params: { datasetId: snapshot.dataset.datasetId } });
  };
}

const PROMPT_EXAMPLE = `{"name":"Hello 页面","description":"生成一个最小 HTML 页面","userPrompt":"在工作区根目录创建 index.html，标题为 Hello Eval","evalPrompt":"检查 /index.html 是否存在且标题正确，按评分格式打分"}`;

/** A prompt Dataset: every row has name, description, userPrompt and evalPrompt. */
export function PromptImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [format, setFormat] = useState<"json" | "jsonl">("jsonl");
  const [content, setContent] = useState("");
  const done = useImported(onClose);
  const mutation = useMutation({
    mutationFn: () => importPromptDataset({ name: name.trim(), description: description.trim(), format, content }),
    onSuccess: done,
    meta: { silent: true },
  });
  const tooLarge = new Blob([content]).size > DATASET_DOCUMENT_BYTES;
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="导入提示词测试集"
      description="每条用例包含 name、description、userPrompt（给被测 Agent）和 evalPrompt（给评委），可以带其他业务字段。"
      footer={(
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={mutation.isPending} disabled={!name.trim() || !description.trim() || !content.trim() || tooLarge}
            onClick={() => mutation.mutate()}>导入</Button>
        </>
      )}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="测试集名称" required>{(id) => <Input id={id} value={name} onChange={(event) => setName(event.target.value)} />}</Field>
          <Field label="说明" required>{(id) => <Input id={id} value={description} onChange={(event) => setDescription(event.target.value)} />}</Field>
          <Field label="格式">
            {(id) => (
              <Select id={id} value={format} onChange={(event) => setFormat(event.target.value as "json" | "jsonl")}>
                <option value="jsonl">JSONL（每行一条）</option>
                <option value="json">JSON 数组</option>
              </Select>
            )}
          </Field>
        </div>
        <FileDropzone multiple={false} accept=".json,.jsonl" hint={`上限 ${formatBytes(DATASET_DOCUMENT_BYTES)}`} onFiles={(files) => {
          const first = files[0];
          if (!first) return;
          setFormat(first.path.endsWith(".json") ? "json" : "jsonl");
          if (!name) setName(first.path.replace(/^\//u, "").replace(/\.(json|jsonl)$/u, ""));
          void first.file.text().then(setContent);
        }} />
        <Field label="内容" hint={<>示例：<code className="font-mono">{PROMPT_EXAMPLE}</code></>} error={tooLarge ? "超过大小上限" : undefined}>
          {(id) => <Textarea id={id} mono rows={10} value={content} onChange={(event) => setContent(event.target.value)} />}
        </Field>
        {mutation.error && <Notice tone="danger">{describeError(mutation.error)}</Notice>}
      </div>
    </Dialog>
  );
}

/** A whole Dataset document as exported: {dataset, data}. */
export function DocumentImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [format, setFormat] = useState<DatasetFormat>("json");
  const [content, setContent] = useState("");
  const done = useImported(onClose);
  const mutation = useMutation({ mutationFn: () => importDataset(format, content), onSuccess: done, meta: { silent: true } });
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="导入测试集文档"
      description="导入完整的测试集文档（JSON 或 YAML），格式与导出相同：{dataset, data}。"
      footer={(
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={mutation.isPending} disabled={!content.trim()} onClick={() => mutation.mutate()}>导入</Button>
        </>
      )}>
      <div className="flex flex-col gap-4">
        <Field label="格式">
          {(id) => (
            <Select id={id} value={format} onChange={(event) => setFormat(event.target.value as DatasetFormat)}>
              <option value="json">JSON</option>
              <option value="yaml">YAML</option>
            </Select>
          )}
        </Field>
        <FileDropzone multiple={false} accept=".json,.yaml,.yml" onFiles={(files) => {
          const first = files[0];
          if (!first) return;
          setFormat(/\.ya?ml$/u.test(first.path) ? "yaml" : "json");
          void first.file.text().then(setContent);
        }} />
        <Field label="内容">{(id) => <Textarea id={id} mono rows={12} value={content} onChange={(event) => setContent(event.target.value)} />}</Field>
        {mutation.error && <Notice tone="danger">{describeError(mutation.error)}</Notice>}
      </div>
    </Dialog>
  );
}
