import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { dataKeys, listData } from "@/api-sdk/data-api";
import { attachData, datasetKeys } from "@/api-sdk/datasets-api";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { useDatasetCatalog } from "./use-dataset-catalog";
import { dataTitle } from "./dataset-detail-page";

export function AttachDataDialog({ datasetId, onClose }: { datasetId: string; onClose: () => void }) {
  const client = useQueryClient();
  const catalog = useDatasetCatalog();
  const all = useQuery({ queryKey: dataKeys.list(), queryFn: ({ signal }) => listData(undefined, signal) });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [unassigned, setUnassigned] = useState(false);
  const attach = useMutation({ mutationFn: () => attachData(datasetId, [...selected]), meta: { silent: true },
    onSuccess: async () => { await client.invalidateQueries({ queryKey: datasetKeys.all }); onClose(); } });
  const rows = (all.data ?? []).filter((row) => {
    const refs = catalog.references(row.dataId);
    return !refs.some((item) => item.datasetId === datasetId) && (!unassigned || refs.length === 0);
  });
  const error = all.error || catalog.error;
  return <Dialog open onClose={() => { if (!attach.isPending) onClose(); }} title="添加已有用例"
    footer={<><Button disabled={attach.isPending} onClick={onClose}>取消</Button><Button variant="primary" disabled={!selected.size || !!error || catalog.pending || all.isPending} loading={attach.isPending} onClick={() => attach.mutate()}>添加 {selected.size} 条</Button></>}>
    <p className="mb-3 text-sm text-text-muted">关联同一份用例，后续修改会影响所有引用它的数据集。已有项目不受影响。</p>
    <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={unassigned} disabled={attach.isPending} onChange={(e) => setUnassigned(e.target.checked)} />仅显示未归入数据集的用例（包括已移出的用例）</label>
    {error ? <ErrorBlock error={error} /> : catalog.pending || all.isPending ? <LoadingBlock /> : <fieldset disabled={attach.isPending}><DataTable rows={rows} rowKey={(row) => row.dataId} rowLabel={dataTitle} selectable selected={selected} onSelectedChange={setSelected} searchText={(row) => `${dataTitle(row)} ${row.userPrompt}`}
      columns={[{ key: "name", header: "用例", cell: dataTitle }, { key: "refs", header: "所属数据集", cell: (row) => catalog.references(row.dataId).map((item) => item.name).join("、") || "未归入数据集" }]} /></fieldset>}
    {attach.error && <ErrorBlock error={attach.error} />}
  </Dialog>;
}
