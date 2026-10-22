import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { AgentImportPicker } from "./agent-import-picker";
import { AgentImportTask } from "./agent-import-task";
import { agentImportUserName } from "./agent-import-state";
import { useAgentImport } from "./use-agent-import";

/** Always mounted by AgentsPage so closing the overlay cannot cancel or replace its captured task. */
export function AgentImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const flow = useAgentImport(open);
  const [confirming, setConfirming] = useState<"apply" | "retry" | null>(null);
  useEffect(() => setConfirming(null), [flow.session?.id]);
  const showWriteError = flow.writeError && (flow.writeError.phase === "preview" || !flow.task.data || flow.task.data.status === "ready");
  const userName = agentImportUserName(flow.sourceUser);
  const canCheck = !flow.restoring && !!flow.config.data?.enabled && !flow.config.error && !!flow.me.data && !flow.me.error && !!flow.sourceUser
    && flow.selected.size > 0 && flow.selected.size <= flow.config.data.maxAgents;

  return <>
    <Dialog open={open} onClose={onClose} title="从 dev 导入" size="lg"
      description="从 dev 导入 Agent 与必要依赖，保留原 ID；Eval 中同 ID 的已有内容会被覆盖，不删除资源。"
      footer={<>
        <Button onClick={onClose}>{flow.readOnly ? "收起" : "关闭"}</Button>
        {flow.session && flow.canReset && <Button onClick={flow.restart}>重新选择</Button>}
        {!flow.session && !flow.restoring && flow.config.data?.enabled && <Button variant="primary" disabled={!canCheck || !!flow.posting}
          loading={flow.posting === "preview"} onClick={() => void flow.check()}>
          {flow.writeError?.phase === "preview" ? "使用原请求重试检查" : "检查所选依赖"}
        </Button>}
        {flow.session && !flow.readOnly && flow.task.data?.status === "ready" && flow.matches && <Button
          variant="primary" disabled={!flow.canApply} loading={flow.posting === "apply"} onClick={() => setConfirming("apply")}>
          确认导入 {flow.readyCount} 个 Agent
        </Button>}
        {flow.readOnly && flow.writeError?.phase === "apply" && flow.writeError.unknown && flow.canApply && <Button
          variant="primary" onClick={() => setConfirming("retry")}>使用原请求重试确认</Button>}
      </>}>
      {open && <div className="space-y-4">
        {flow.config.error && <ErrorBlock error={flow.config.error} onRetry={() => void flow.config.refetch()} />}
        {flow.me.error && <ErrorBlock error={flow.me.error} onRetry={() => void flow.me.refetch()} />}
        {flow.pointerNotice && <Notice tone="warning">{flow.pointerNotice}</Notice>}
        {flow.restoring && <p role="status" className="text-[13px] text-text-muted">正在确认 Eval 账号并只读恢复任务定位信息…</p>}
        {!flow.session && !flow.taskId && flow.config.isPending ? <LoadingBlock rows={2} />
          : !flow.session && !flow.taskId && !flow.restoring && flow.config.data?.enabled === false ? <Notice tone="neutral">
            当前环境尚未启用 dev 导入，请联系管理员配置已授权的只读来源。普通 Agent 的新建、列表和编辑不受影响。
          </Notice>
          : <>
            <Notice tone="neutral">来源凭据仅由服务端管理。先选择用户和 Agent，再检查、复核并确认后台导入；关闭弹窗不取消已提交任务。</Notice>
            {flow.session && flow.config.data?.enabled === false && <Notice tone="neutral">当前环境已停用 dev 导入。原任务仍可只读查看，不能发起新的确认请求。</Notice>}
            {flow.session?.restored && <Notice tone="neutral">已从服务端恢复原任务，只读查看范围与结果，不会重新检查或确认导入。未提交的检查如需继续，请显式重新选择并检查；此前确认响应不明时请先核验原任务。</Notice>}
            {flow.config.data?.enabled && !flow.readOnly && !flow.restoring && <AgentImportPicker
              sourceUser={flow.sourceUser} purpose={flow.purpose} selected={flow.selected}
              maxAgents={flow.config.data.maxAgents} disabled={!!flow.posting}
              onUserChange={flow.chooseUser} onPurposeChange={flow.choosePurpose} onSelectionChange={flow.chooseAgents} />}
            {flow.taskId && <>
              {flow.task.error && <ErrorBlock error={flow.task.error} onRetry={() => void flow.task.refetch()} />}
              {!flow.task.data && !flow.task.error && <LoadingBlock rows={3} />}
              {flow.session && flow.task.data && !flow.matches && <Notice tone="danger">检查结果与当前用户、用途或所选 Agent 不一致，已阻止确认。请重新检查，不能跨用户使用旧预览。</Notice>}
              {flow.session && flow.task.data && flow.matches && <AgentImportTask task={flow.task.data} userName={userName} expired={flow.expired} restored={flow.session.restored} />}
              <Button size="sm" disabled={flow.task.isFetching} onClick={() => void flow.task.refetch()}>刷新任务状态</Button>
              {flow.readOnly && <p className="text-xs text-text-muted">任务范围已固定，当前只读查询原任务；关闭或重开不会再次发送导入请求。</p>}
            </>}
            {showWriteError && flow.writeError && <div className="space-y-2">
              <ErrorBlock error={flow.writeError.error} />
              {flow.writeError.unknown && <Notice tone="warning">
                {flow.writeError.phase === "preview"
                  ? "检查请求的响应未确认，不会自动重发。手动重试沿用原选择和原幂等键。"
                  : "导入提交的响应未确认，写入可能已生效。正在只读查询原任务；若需手动重试确认，只能沿用原任务与原幂等键，不能重新选择用户或 Agent。"}
              </Notice>}
            </div>}
          </>}
      </div>}
    </Dialog>
    <ConfirmDialog open={open && confirming !== null} onClose={() => { if (!flow.posting) setConfirming(null); }}
      title={confirming === "retry" ? "使用原请求重试确认" : "确认后台导入"}
      description={<>
        本次 dev 用户：{userName}。将以{flow.purpose === "execution" ? "执行 Agent" : "评估 Agent"}用途导入 {flow.readyCount} 个 Agent 和必要依赖，保留原 ID。同 ID 的 Agent、Skill、参考资料会被覆盖，冲突项不导入，不删除资源。关闭窗口不会取消后台任务。
        {confirming === "retry" && <span className="mt-2 block">上次响应未确认。本次仅重试同一任务的原确认请求与原幂等键，不创建新任务。</span>}
      </>}
      confirmLabel={confirming === "retry" ? "重试原确认请求" : "开始后台导入"}
      loading={flow.posting === "apply"} disabled={!flow.canApply}
      onConfirm={() => { void flow.apply().then(() => setConfirming(null)); }} />
  </>;
}
