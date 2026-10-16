import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useId, useState } from "react";
import {
  Button as FormButton, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Field, FieldDescription, FieldError, FieldLabel, Input, Textarea,
} from "@springbrand/site-block";
import { toast } from "sonner";
import { createOutputSchema, listOutputSchemas, outputSchemaKeys } from "@/api-sdk/output-schemas-api";
import type { OutputSchemaRecord } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CopyId } from "@/components/ui/data-display";
import { EmptyState, ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { FileDropzone } from "@/components/ui/file-dropzone";
import { fieldErrors, isWriteOutcomeUnknown } from "@/lib/errors";
import { CatalogWriteFeedback } from "@/features/catalog-write-feedback";
import { textImportAccept, useTextImport } from "@/features/use-text-import";
import { formatBytes } from "@/lib/format";
import { useInputLimits } from "@/features/input-limits";
import { parseStrictJson } from "@eval-platform/eval-dataset";

export const SCORE_CONVENTION = "评估结果按这份 JSON Schema 展示和统计，支持数值、布尔、枚举和 null。";

export const EXAMPLE_SCHEMA = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["score", "reason"],
  properties: {
    score: { type: "number", minimum: 0, maximum: 10 },
    reason: { type: "string" },
  },
  additionalProperties: false,
}, null, 2);

function UploadDialog({ onClose }: { onClose: () => void }) {
  const id = useId();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const draft = useTextImport(EXAMPLE_SCHEMA);
  const content = draft.content;
  const limits = useInputLimits();
  let jsonError: string | undefined;
  try {
    const parsed: unknown = parseStrictJson(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) jsonError = "Schema 需要是一个 JSON 对象";
  } catch (error) {
    jsonError = `JSON 格式错误：${(error as Error).message}`;
  }
  const tooLarge = !!limits.data && new Blob([content]).size > limits.data.outputSchemaBytes;
  const create = useMutation({
    mutationFn: createOutputSchema,
    meta: { silent: true },
    onError: async (error) => { if (isWriteOutcomeUnknown(error)) await queryClient.invalidateQueries({ queryKey: outputSchemaKeys.all }); },
    onSuccess: async (record) => {
      toast.success("已上传评分格式");
      await queryClient.invalidateQueries({ queryKey: outputSchemaKeys.all });
      onClose();
      void navigate({ to: "/output-schemas/$outputSchemaId", params: { outputSchemaId: record.outputSchemaId } });
    },
  });
  const errors = fieldErrors(create.error);
  const valid = !!limits.data && !!name.trim() && !!description.trim() && !jsonError && !tooLarge
    && !draft.reading && !draft.error && !isWriteOutcomeUnknown(create.error);
  return <Dialog open onOpenChange={(next) => { if (!next && !create.isPending) onClose(); }}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-3xl" showCloseButton={!create.isPending}>
      <DialogHeader><DialogTitle>上传评分格式</DialogTitle><DialogDescription>上传一份 draft 2020-12 JSON Schema。</DialogDescription></DialogHeader>
      <form className="flex min-h-0 flex-col gap-4" onSubmit={(event) => {
        event.preventDefault(); if (valid && !create.isPending) create.mutate({ name: name.trim(), description: description.trim(), content });
      }}>
        <fieldset disabled={create.isPending} className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain">
          <Notice>{SCORE_CONVENTION}</Notice>
          <div className="grid gap-4 md:grid-cols-2">
            <Field><FieldLabel htmlFor={id + "-name"}>名称</FieldLabel><Input id={id + "-name"} required value={name} onChange={(event) => setName(event.target.value)} /><FieldError>{errors.name}</FieldError></Field>
            <Field><FieldLabel htmlFor={id + "-description"}>说明</FieldLabel><Input id={id + "-description"} required value={description} onChange={(event) => setDescription(event.target.value)} /><FieldError>{errors.description}</FieldError></Field>
          </div>
          {limits.error && <ErrorBlock error={limits.error} onRetry={() => void limits.refetch()} />}
          <FileDropzone onSelectionStart={draft.startSelection} onRejected={() => draft.setContent("")} disabled={create.isPending} multiple={false} accept={textImportAccept(["json"])} maxBytes={limits.data?.outputSchemaBytes}
            hint={limits.data ? `或直接在下方编辑；上限 ${formatBytes(limits.data.outputSchemaBytes)}` : undefined}
            onFiles={(files, signal) => { const first = files[0]; if (first) void draft.readFile(first.file, signal); }} />
          <Field><FieldLabel htmlFor={id + "-content"}>Schema 内容</FieldLabel>
            <Textarea id={id + "-content"} required className="font-mono" rows={14} value={content} onChange={(event) => draft.setContent(event.target.value)} />
            {draft.reading && <FieldDescription role="status">正在读取文件…</FieldDescription>}
            <FieldError>{draft.error || (draft.reading ? "" : jsonError ?? (tooLarge ? "超过大小上限" : errors.content))}</FieldError>
          </Field>
          <CatalogWriteFeedback error={create.error} />
        </fieldset>
        <DialogFooter><FormButton type="button" variant="outline" disabled={create.isPending} onClick={onClose}>取消</FormButton>
          <FormButton type="submit" loading={create.isPending} disabled={!valid}>上传</FormButton></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function OutputSchemasPage() {
  const navigate = useNavigate();
  const [uploading, setUploading] = useState(false);
  const schemas = useQuery({ queryKey: outputSchemaKeys.list(), queryFn: ({ signal }) => listOutputSchemas(signal) });
  return (
    <Page>
      <PageHeader
        title="评分 Schema"
        crumbs={[{ label: "数据集", to: "/datasets" }]}
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setUploading(true)}>上传评分格式</Button>}
      />
      <Card>
        {schemas.isPending ? <LoadingBlock /> : schemas.error ? <div className="p-4"><ErrorBlock error={schemas.error} /></div> : (
          <DataTable<OutputSchemaRecord>
            rows={schemas.data}
            rowKey={(row) => row.outputSchemaId}
            searchText={(row) => `${row.name} ${row.description}`}
            onRowClick={(row) => void navigate({ to: "/output-schemas/$outputSchemaId", params: { outputSchemaId: row.outputSchemaId } })}
            empty={<EmptyState title="还没有评分格式" description={SCORE_CONVENTION}
              action={<Button variant="primary" onClick={() => setUploading(true)}>上传评分格式</Button>} />}
            columns={[
              { key: "name", header: "名称", cell: (row) => <span className="font-semibold">{row.name}</span>, sortValue: (row) => row.name },
              { key: "description", header: "说明", cell: (row) => <span className="text-text-muted">{row.description}</span> },
              { key: "id", header: "ID", cell: (row) => <CopyId value={row.outputSchemaId} /> },
            ]}
          />
        )}
      </Card>
      {uploading && <UploadDialog onClose={() => setUploading(false)} />}
    </Page>
  );
}
