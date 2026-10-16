import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FileUp, Plus, Upload } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Field, FieldLabel, FieldSet, Input, Textarea,
} from "@springbrand/site-block";
import { createDataset, datasetKeys, listDatasets } from "@/api-sdk/datasets-api";
import type { Dataset } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CopyId } from "@/components/ui/data-display";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { CatalogWriteFeedback } from "@/features/catalog-write-feedback";
import { isWriteOutcomeUnknown } from "@/lib/errors";
import { DocumentImportDialog, PromptImportDialog } from "./import-dialogs";

function CreateDialog({ onClose }: { onClose: () => void }) {
  const id = useId();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: createDataset,
    meta: { silent: true },
    onError: async (error) => {
      if (isWriteOutcomeUnknown(error)) await queryClient.invalidateQueries({ queryKey: datasetKeys.all });
    },
    onSuccess: async (dataset) => {
      toast.success("已创建");
      await queryClient.invalidateQueries({ queryKey: datasetKeys.all });
      onClose();
      void navigate({ to: "/datasets/$datasetId", params: { datasetId: dataset.datasetId } });
    },
  });
  const unconfirmed = isWriteOutcomeUnknown(create.error);
  const valid = !!name.trim() && !unconfirmed;
  return <Dialog open onOpenChange={(next) => { if (!next && !create.isPending) onClose(); }}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-md" showCloseButton={!create.isPending}>
      <DialogHeader><DialogTitle>新建测试集</DialogTitle><DialogDescription>填写数据集名称与说明。</DialogDescription></DialogHeader>
      <form className="flex min-h-0 flex-col gap-4" onSubmit={(event) => {
        event.preventDefault();
        if (valid && !create.isPending) create.mutate({ name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) });
      }}>
        <FieldSet disabled={create.isPending || unconfirmed} className="min-w-0 gap-4 overflow-y-auto overscroll-contain">
          <Field><FieldLabel htmlFor={id + "-name"}>名称</FieldLabel><Input id={id + "-name"} required value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field><FieldLabel htmlFor={id + "-description"}>说明</FieldLabel><Textarea id={id + "-description"} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
        </FieldSet>
        <CatalogWriteFeedback error={create.error} />
        <DialogFooter><Button type="button" variant="outline" disabled={create.isPending} onClick={onClose}>取消</Button>
          <Button type="submit" disabled={!valid} loading={create.isPending}>创建</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function DatasetsPage() {
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<"create" | "prompt" | "document" | null>(null);
  const datasets = useQuery({ queryKey: datasetKeys.list(), queryFn: ({ signal }) => listDatasets(signal) });
  return (
    <Page>
      <PageHeader
        title="Prompt 数据集"
        crumbs={[{ label: "数据集", to: "/datasets" }]}
        actions={(
          <>
            <Button variant="outline" onClick={() => setDialog("document")}><FileUp />导入文档</Button>
            <Button variant="outline" onClick={() => setDialog("prompt")}><Upload />导入提示词</Button>
            <Button onClick={() => setDialog("create")}><Plus />新建测试集</Button>
          </>
        )}
      />
      <Card>
        {datasets.isPending ? <LoadingBlock /> : datasets.error ? <div className="p-4"><ErrorBlock error={datasets.error} /></div> : (
          <DataTable<Dataset>
            rows={datasets.data}
            rowKey={(row) => row.datasetId}
            searchText={(row) => `${row.name} ${row.description ?? ""}`}
            onRowClick={(row) => void navigate({ to: "/datasets/$datasetId", params: { datasetId: row.datasetId } })}
            empty={<EmptyState title="还没有测试集"
              action={<Button onClick={() => setDialog("prompt")}>导入提示词</Button>} />}
            columns={[
              { key: "name", header: "名称", cell: (row) => <span className="font-semibold">{row.name}</span>, sortValue: (row) => row.name },
              { key: "description", header: "说明", cell: (row) => <span className="line-clamp-1 text-text-muted">{row.description || "—"}</span> },
              { key: "id", header: "ID", cell: (row) => <CopyId value={row.datasetId} /> },
            ]}
          />
        )}
      </Card>
      {dialog === "create" && <CreateDialog onClose={() => setDialog(null)} />}
      {dialog === "prompt" && <PromptImportDialog onClose={() => setDialog(null)} />}
      {dialog === "document" && <DocumentImportDialog onClose={() => setDialog(null)} />}
    </Page>
  );
}
