import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import {
  Button as FormButton, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  FieldDescription, FieldError, Tabs, TabsContent, TabsList, TabsTrigger,
} from "@springbrand/site-block";
import { toast } from "sonner";
import { createOutputSchema, listOutputSchemas, outputSchemaKeys } from "@/api-sdk/output-schemas-api";
import type { OutputSchemaRecord } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CodeBlock, CopyId } from "@/components/ui/data-display";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { FileDropzone } from "@/components/ui/file-dropzone";
import { fieldErrors, isWriteOutcomeUnknown } from "@/lib/errors";
import { CatalogWriteFeedback } from "@/features/catalog-write-feedback";
import { CatalogMetadataFields } from "@/features/catalog-metadata-fields";
import { textImportAccept, useTextImport } from "@/features/use-text-import";
import { useInputLimits } from "@/features/input-limits";
import { parseStrictJson } from "@eval-platform/eval-dataset";
import { buildSchemaContent, initialSchemaFields, SchemaBuilder } from "./schema-builder";

export const SCORE_CONVENTION = "评估结果按这份 JSON Schema 展示和统计，支持数值、布尔、枚举和 null。";

function CreateDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [metadata, setMetadata] = useState({ name: "", description: "" });
  const [mode, setMode] = useState("import");
  const [fields, setFields] = useState(initialSchemaFields);
  const [fileName, setFileName] = useState("");
  const draft = useTextImport();
  const built = buildSchemaContent(fields);
  const content = mode === "manual" ? built.content : draft.content;
  const limits = useInputLimits();
  let jsonError: string | undefined;
  try {
    if (content.trim()) {
      const parsed: unknown = parseStrictJson(content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) jsonError = "Schema 需要是一个 JSON 对象";
    }
  } catch (error) {
    jsonError = `JSON 格式错误：${(error as Error).message}`;
  }
  const tooLarge = !!limits.data && new Blob([content]).size > limits.data.outputSchemaBytes;
  const create = useMutation({
    mutationFn: createOutputSchema,
    meta: { silent: true },
    onError: async (error) => { if (isWriteOutcomeUnknown(error)) await queryClient.invalidateQueries({ queryKey: outputSchemaKeys.all }); },
    onSuccess: async (record) => {
      toast.success("已新建评分格式");
      await queryClient.invalidateQueries({ queryKey: outputSchemaKeys.all });
      onClose();
      void navigate({ to: "/output-schemas/$outputSchemaId", params: { outputSchemaId: record.outputSchemaId } });
    },
  });
  const errors = fieldErrors(create.error);
  const blocked = create.isPending || isWriteOutcomeUnknown(create.error);
  const valid = !blocked && !!limits.data && !!metadata.name.trim() && !!metadata.description.trim() && !!content.trim() && !jsonError && !tooLarge
    && (mode === "manual" ? !built.error : !draft.reading && !draft.error);
  return <Dialog open onOpenChange={(next) => { if (!next && !create.isPending) onClose(); }}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-3xl" showCloseButton={!create.isPending}>
      <DialogHeader><DialogTitle>新建评分格式</DialogTitle><DialogDescription>导入已有格式，或直接配置评分字段，用于展示和统计评估结果。</DialogDescription></DialogHeader>
      <Tabs value={mode} className="flex min-h-0 flex-col gap-4" onValueChange={(value) => {
        if (blocked) return;
        setMode(value); if (draft.reading) setFileName("");
        draft.setContent(draft.content); create.reset();
      }}>
      <TabsList className="h-auto w-full flex-wrap">
        <TabsTrigger value="import" disabled={blocked}>导入评分格式</TabsTrigger>
        <TabsTrigger value="manual" disabled={blocked}>手动创建</TabsTrigger>
      </TabsList>
      <TabsContent value={mode} className="flex min-h-0 flex-col">
      <form className="flex min-h-0 flex-col gap-4" onSubmit={(event) => {
        event.preventDefault(); if (valid) create.mutate({ name: metadata.name.trim(), description: metadata.description.trim(), content });
      }}>
        <div className="min-h-0 min-w-0 overflow-y-auto overscroll-contain">
        <fieldset disabled={blocked} className="flex min-w-0 flex-col gap-4">
          <CatalogMetadataFields value={metadata} errors={errors} onChange={(patch) => setMetadata((current) => ({ ...current, ...patch }))} />
          {limits.error && <ErrorBlock error={limits.error} onRetry={() => void limits.refetch()} />}
          {mode === "import" ? <>
          <FileDropzone onSelectionStart={() => { setFileName(""); return draft.startSelection(); }} onRejected={() => { setFileName(""); draft.setContent(""); }}
            disabled={blocked} multiple={false} accept={textImportAccept(["json"])} maxBytes={limits.data?.outputSchemaBytes}
            onFiles={(files, signal) => { const first = files[0]; if (first && !signal.aborted) { setFileName(first.file.name); void draft.readFile(first.file, signal); } }} />
          {fileName && <p className="break-all text-sm text-text-secondary">已选择：{fileName}</p>}
            {draft.reading && <FieldDescription role="status">正在读取文件…</FieldDescription>}
            <FieldError>{draft.error || (draft.reading ? "" : jsonError ?? errors.content)}</FieldError>
          </> : <>
            <SchemaBuilder value={fields} onChange={setFields} />
            <FieldError>{built.error}</FieldError>
            {built.content && <details className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">查看生成的 JSON</summary>
              <div className="min-w-0 border-t border-border p-3"><CodeBlock className="min-w-0 max-w-full [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]" value={built.content} /></div>
            </details>}
          </>}
          {tooLarge && <FieldError>超过大小上限</FieldError>}
          <CatalogWriteFeedback error={create.error} />
        </fieldset>
        </div>
        <DialogFooter className="shrink-0"><FormButton type="button" variant="outline" disabled={create.isPending} onClick={onClose}>取消</FormButton>
          <FormButton type="submit" loading={create.isPending} disabled={!valid}>创建评分格式</FormButton></DialogFooter>
      </form>
      </TabsContent>
      </Tabs>
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
        title="评分格式"
        crumbs={[{ label: "数据集", to: "/datasets" }]}
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setUploading(true)}>新建评分格式</Button>}
      />
      <Card>
        {schemas.isPending ? <LoadingBlock /> : schemas.error ? <div className="p-4"><ErrorBlock error={schemas.error} /></div> : (
          <DataTable<OutputSchemaRecord>
            rows={schemas.data}
            rowKey={(row) => row.outputSchemaId}
            searchText={(row) => `${row.name} ${row.description}`}
            onRowClick={(row) => void navigate({ to: "/output-schemas/$outputSchemaId", params: { outputSchemaId: row.outputSchemaId } })}
            empty={<EmptyState title="还没有评分格式" description={SCORE_CONVENTION}
              action={<Button variant="primary" onClick={() => setUploading(true)}>新建评分格式</Button>} />}
            columns={[
              { key: "name", header: "名称", cell: (row) => <span className="font-semibold">{row.name}</span>, sortValue: (row) => row.name },
              { key: "description", header: "说明", cell: (row) => <span className="text-text-muted">{row.description}</span> },
              { key: "id", header: "ID", cell: (row) => <CopyId value={row.outputSchemaId} /> },
            ]}
          />
        )}
      </Card>
      {uploading && <CreateDialog onClose={() => setUploading(false)} />}
    </Page>
  );
}
