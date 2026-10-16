import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { ActionMenu } from "@/components/ui/menu";
import { useState } from "react";
import { toast } from "sonner";
import { deleteOutputSchema, getOutputSchema, outputSchemaKeys, updateOutputSchema } from "@/api-sdk/output-schemas-api";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { OutputFormatPreview } from "./output-format-picker";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/form";
import { SCORE_CONVENTION } from "./output-schemas-page";

export function OutputSchemaDetailPage({ outputSchemaId }: { outputSchemaId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const record = useQuery({ queryKey: outputSchemaKeys.detail(outputSchemaId), queryFn: ({ signal }) => getOutputSchema(outputSchemaId, signal) });
  const [draft, setDraft] = useState<{ name: string; description: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const save = useMutation({
    mutationFn: () => updateOutputSchema(outputSchemaId, draft!),
    onSuccess: async () => {
      toast.success("已保存");
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: outputSchemaKeys.all });
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteOutputSchema(outputSchemaId),
    onSuccess: async () => {
      toast.success("已删除");
      await queryClient.invalidateQueries({ queryKey: outputSchemaKeys.all });
      void navigate({ to: "/output-schemas" });
    },
  });
  const data = record.data;
  const form = draft ?? (data ? { name: data.name, description: data.description } : null);
  return (
    <Page>
      <PageHeader
        title={data?.name ?? "评估结果格式"}
        crumbs={[{ label: "评估结果格式", to: "/output-schemas" }]}
        actions={<ActionMenu items={[{ label: "删除评估结果格式", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(true) }]} />}
      />
      {record.isPending ? <LoadingBlock /> : record.error ? <ErrorBlock error={record.error} /> : form && (
        <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
          <Card className="self-start">
            <CardHeader title="名称与说明" />
            <CardBody className="flex flex-col gap-4">
              <Field label="名称" required>{(id) => <Input id={id} value={form.name} onChange={(event) => setDraft({ ...form, name: event.target.value })} />}</Field>
              <Field label="说明" required>{(id) => <Input id={id} value={form.description} onChange={(event) => setDraft({ ...form, description: event.target.value })} />}</Field>
              <Button variant="primary" disabled={!draft || !form.name.trim() || !form.description.trim()} loading={save.isPending} onClick={() => save.mutate()}>保存</Button>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="结果字段" />
            <CardBody className="flex flex-col gap-3">
              <Notice>{SCORE_CONVENTION}</Notice>
              <OutputFormatPreview schema={data!.schema} />
            </CardBody>
          </Card>
        </div>
      )}
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={() => remove.mutate()}
        loading={remove.isPending}
        danger
        title="删除评估结果格式"
        description="删除后不再用于新选择，已有项目仍按原引用读取。"
        confirmLabel="删除"
      />
    </Page>
  );
}
