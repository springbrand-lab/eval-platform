import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { creditKeys, getCreditBalance, grantCredits, listCreditGrants } from "@/api-sdk/credits-api";
import type { CreditGrantRecord } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { MetricCard } from "@/components/ui/data-display";
import { Dialog } from "@/components/ui/dialog";
import { ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { Field, Input, Textarea } from "@/components/ui/form";
import { formatDateTime, formatNumber } from "@/lib/format";
import { newIdempotencyKey } from "@/lib/files";

function GrantDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [units, setUnits] = useState("1000");
  const [note, setNote] = useState("");
  // One key per dialog opening: a retried submit grants once.
  const [key, setKey] = useState(() => newIdempotencyKey("grant"));
  const amount = Number(units);
  const valid = Number.isSafeInteger(amount) && amount > 0;
  const mutation = useMutation({
    mutationFn: () => grantCredits({ units: amount, idempotencyKey: key, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: async (grant) => {
      toast.success(grant.replayed ? "这笔积分之前已经加过" : `已加 ${formatNumber(grant.units)} 积分`);
      await queryClient.invalidateQueries({ queryKey: ["credits"] });
      setKey(newIdempotencyKey("grant"));
      setNote("");
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="加积分"
      description="加到 Eval SP 服务账号，只能增加。"
      size="sm"
      footer={(
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!valid} loading={mutation.isPending} onClick={() => mutation.mutate()}>确认加积分</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <Field label="积分数量" required error={units && !valid ? "请输入正整数" : undefined}>
          {(id) => <Input id={id} inputMode="numeric" value={units} onChange={(event) => setUnits(event.target.value.trim())} />}
        </Field>
        <Field label="备注" hint="会和操作人一起记录在加积分记录中">
          {(id) => <Textarea id={id} rows={3} maxLength={400} value={note} onChange={(event) => setNote(event.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

export function CreditsPage() {
  const [granting, setGranting] = useState(false);
  const balance = useQuery({ queryKey: creditKeys.balance(), queryFn: ({ signal }) => getCreditBalance(signal) });
  const grants = useQuery({ queryKey: creditKeys.grants(), queryFn: ({ signal }) => listCreditGrants(100, signal) });
  return (
    <Page>
      <PageHeader
        title="积分"
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setGranting(true)}>加积分</Button>}
      />
      {balance.error ? <ErrorBlock error={balance.error} onRetry={() => void balance.refetch()} /> : (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <MetricCard label="可用积分" value={balance.data ? formatNumber(balance.data.availableUnits) : "…"}
            tone={balance.data && balance.data.availableUnits <= 0 ? "danger" : undefined}
            hint={balance.data && balance.data.availableUnits <= 0 ? "积分不足时 Agent 无法运行" : undefined} />
          <MetricCard label="充值剩余" value={balance.data ? formatNumber(balance.data.topupRemainingUnits) : "…"} />
          <MetricCard label="其他剩余（含手动添加）" value={balance.data ? formatNumber(balance.data.otherRemainingUnits) : "…"} />
        </div>
      )}
      <Card>
        <CardHeader title="加积分记录" actions={<span className="text-xs text-text-muted">最近 100 条</span>} />
        {grants.isPending ? <LoadingBlock /> : grants.error ? <div className="p-4"><ErrorBlock error={grants.error} /></div> : (
          <DataTable<CreditGrantRecord>
            rows={grants.data}
            rowKey={(row) => row.id}
            columns={[
              { key: "createdAt", header: "时间", cell: (row) => formatDateTime(row.createdAt), sortValue: (row) => row.createdAt },
              { key: "units", header: "积分", align: "right", cell: (row) => `+${formatNumber(row.units)}`, sortValue: (row) => row.units },
              { key: "note", header: "备注", cell: (row) => row.note ?? <span className="text-text-muted">—</span> },
              { key: "adjustmentId", header: "调整 ID", cell: (row) => <span className="font-mono text-xs text-text-muted">{row.adjustmentId}</span> },
            ]}
          />
        )}
      </Card>
      <GrantDialog open={granting} onClose={() => setGranting(false)} />
    </Page>
  );
}
