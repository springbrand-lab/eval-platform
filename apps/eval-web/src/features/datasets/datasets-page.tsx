import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FileUp, Plus, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { createDataset, datasetKeys, listDatasets } from "@/api-sdk/datasets-api";
import type { Dataset } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CopyId } from "@/components/ui/data-display";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { Field, Input, Textarea } from "@/components/ui/form";
import { DocumentImportDialog, PromptImportDialog } from "./import-dialogs";

function CreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () => createDataset({ name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) }),
    onSuccess: async (dataset) => {
      toast.success("已创建");
      await queryClient.invalidateQueries({ queryKey: datasetKeys.all });
      onClose();
      void navigate({ to: "/datasets/$datasetId", params: { datasetId: dataset.datasetId } });
    },
  });
  return (
    <Dialog open={open} onClose={onClose} size="sm" title="新建测试集"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>创建</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="名称" required>{(id) => <Input id={id} value={name} onChange={(event) => setName(event.target.value)} />}</Field>
        <Field label="说明">{(id) => <Textarea id={id} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

export function DatasetsPage() {
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<"create" | "prompt" | "document" | null>(null);
  const datasets = useQuery({ queryKey: datasetKeys.list(), queryFn: ({ signal }) => listDatasets(signal) });
  return (
    <Page>
      <PageHeader
        title="测试集"
        actions={(
          <>
            <Button icon={<FileUp className="size-4" />} onClick={() => setDialog("document")}>导入文档</Button>
            <Button icon={<Upload className="size-4" />} onClick={() => setDialog("prompt")}>导入提示词</Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setDialog("create")}>新建测试集</Button>
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
              action={<Button variant="primary" onClick={() => setDialog("prompt")}>导入提示词</Button>} />}
            columns={[
              { key: "name", header: "名称", cell: (row) => <span className="font-semibold">{row.name}</span>, sortValue: (row) => row.name },
              { key: "description", header: "说明", cell: (row) => <span className="line-clamp-1 text-text-muted">{row.description || "—"}</span> },
              { key: "id", header: "ID", cell: (row) => <CopyId value={row.datasetId} /> },
            ]}
          />
        )}
      </Card>
      <CreateDialog open={dialog === "create"} onClose={() => setDialog(null)} />
      <PromptImportDialog open={dialog === "prompt"} onClose={() => setDialog(null)} />
      <DocumentImportDialog open={dialog === "document"} onClose={() => setDialog(null)} />
    </Page>
  );
}
