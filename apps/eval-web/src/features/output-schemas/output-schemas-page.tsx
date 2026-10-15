import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { createOutputSchema, listOutputSchemas, outputSchemaKeys } from "@/api-sdk/output-schemas-api";
import type { OutputSchemaRecord } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CopyId } from "@/components/ui/data-display";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState, ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { FileDropzone } from "@/components/ui/file-dropzone";
import { Field, Input, Textarea } from "@/components/ui/form";
import { fieldErrors } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { OUTPUT_SCHEMA_BYTES } from "@/lib/limits";

export const SCORE_CONVENTION = "评委结果需要是一个 JSON 对象，顶层有数字类型的 score，可以有字符串类型的 reason。";

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

function UploadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState(EXAMPLE_SCHEMA);
  let jsonError: string | undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) jsonError = "Schema 需要是一个 JSON 对象";
  } catch (error) {
    jsonError = `JSON 格式错误：${(error as Error).message}`;
  }
  const tooLarge = new Blob([content]).size > OUTPUT_SCHEMA_BYTES;
  const create = useMutation({
    mutationFn: () => createOutputSchema({ name: name.trim(), description: description.trim(), content }),
    onSuccess: async (record) => {
      toast.success("已上传评分格式");
      await queryClient.invalidateQueries({ queryKey: outputSchemaKeys.all });
      onClose();
      void navigate({ to: "/output-schemas/$outputSchemaId", params: { outputSchemaId: record.outputSchemaId } });
    },
  });
  const errors = fieldErrors(create.error);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="上传评分格式"
      description="draft 2020-12 JSON Schema。上传后正文不能修改，只能改名称和说明。"
      footer={(
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={create.isPending} disabled={!name.trim() || !description.trim() || !!jsonError || tooLarge}
            onClick={() => create.mutate()}>上传</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <Notice>{SCORE_CONVENTION}</Notice>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="名称" required error={errors.name}>{(id) => <Input id={id} value={name} onChange={(event) => setName(event.target.value)} />}</Field>
          <Field label="说明" required error={errors.description}>{(id) => <Input id={id} value={description} onChange={(event) => setDescription(event.target.value)} />}</Field>
        </div>
        <FileDropzone multiple={false} accept=".json,application/json" hint={`或直接在下方编辑；上限 ${formatBytes(OUTPUT_SCHEMA_BYTES)}`}
          onFiles={(files) => { const first = files[0]; if (first) void first.file.text().then(setContent); }} />
        <Field label="Schema 内容" required error={jsonError ?? (tooLarge ? "超过大小上限" : errors.content)}>
          {(id) => <Textarea id={id} mono rows={14} value={content} onChange={(event) => setContent(event.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

export function OutputSchemasPage() {
  const navigate = useNavigate();
  const [uploading, setUploading] = useState(false);
  const schemas = useQuery({ queryKey: outputSchemaKeys.list(), queryFn: ({ signal }) => listOutputSchemas(signal) });
  return (
    <Page>
      <PageHeader
        title="评分格式"
        description="评委结果文件的 JSON Schema。评估计划选定一个评分格式，首个评估 Run 之后锁定。"
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
              { key: "name", header: "名称", cell: (row) => <span className="font-medium">{row.name}</span>, sortValue: (row) => row.name },
              { key: "description", header: "说明", cell: (row) => <span className="text-text-muted">{row.description}</span> },
              { key: "id", header: "ID", cell: (row) => <CopyId value={row.outputSchemaId} /> },
            ]}
          />
        )}
      </Card>
      <UploadDialog open={uploading} onClose={() => setUploading(false)} />
    </Page>
  );
}
