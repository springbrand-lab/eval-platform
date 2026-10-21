import type { AgentImportTaskView } from "@eval-platform/eval-contracts";
import { Progress, ProgressLabel, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@springbrand/site-block";
import { Notice } from "@/components/ui/feedback";
import { formatBytes, formatDateTime } from "@/lib/format";

const STATUS_LABELS: Record<AgentImportTaskView["status"], string> = {
  checking: "正在检查所选 Agent 与必要依赖",
  ready: "检查完成，请复核后确认导入",
  queued: "已提交，等待后台导入",
  importing: "后台导入中",
  completed: "导入完成",
  completed_with_errors: "导入结束，部分 Agent 未成功",
  failed: "导入任务失败",
  outcome_unknown: "导入结果待核验",
};
const AGENT_LABELS: Record<AgentImportTaskView["agents"][number]["status"], string> = {
  pending: "待处理", ready: "可新增", created: "已新增", skipped: "已跳过",
  conflict: "冲突，未覆盖", failed: "失败", outcome_unknown: "结果待核验",
};
const STAGE_LABELS: Readonly<Record<string, string>> = {
  checking: "检查依赖", preparing: "准备文件", preparing_files: "准备文件",
  skills: "导入 Skill", references: "导入参考资料", agents: "导入 Agent",
  finalizing: "记录用途与回执", queued: "等待处理", importing: "导入资源", completed: "处理结束",
  receipts: "核验回执与本地收尾", finished: "处理结束",
};

export function AgentImportTask({ task, userName, expired, restored = false }: {
  task: AgentImportTaskView; userName: string; expired: boolean; restored?: boolean;
}) {
  const ready = task.agents.filter((agent) => agent.status === "ready").length;
  const unknown = task.agents.filter((agent) => agent.status === "outcome_unknown").length;
  const recovering = task.status === "importing" && (task.progress.stage === "receipts" || unknown > 0);
  const issues = task.summary.failed > 0 || task.summary.conflicts > 0 || unknown > 0;
  const value = task.progress.total > 0 ? Math.min(100, task.progress.completed / task.progress.total * 100) : null;
  return <section aria-label="导入检查与结果" className="space-y-3 border-t border-border pt-4">
    <div>
      <h3 className="text-sm font-semibold" role="status">{task.status === "ready" && restored ? "已恢复检查结果（只读）"
        : task.status === "completed" && issues ? "任务已结束，仍有项目需处理"
          : recovering ? "后台核验回执与本地收尾中" : STATUS_LABELS[task.status]}</h3>
      <p className="mt-1 text-[13px] text-text-muted">本次 dev 用户：{userName} · 用途：{task.purpose === "execution" ? "执行 Agent" : "评估 Agent"}</p>
      <p className="mt-1 break-all font-mono text-xs text-text-muted">任务 ID：{task.id}</p>
    </div>
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]" aria-label="导入数量">
      <span>所选 Agent {task.agents.length}</span>
      <span>可新增 {ready}</span><span>已新增 {task.summary.created}</span>
      <span>已跳过 {task.summary.skipped}</span><span>冲突 {task.summary.conflicts}</span>
      <span>失败 {task.summary.failed}</span><span>结果待核验 {unknown}</span>
    </div>
    <Progress value={value} aria-label="导入任务进度">
      <ProgressLabel>{STAGE_LABELS[task.progress.stage] ?? task.progress.stage ?? STATUS_LABELS[task.status]}</ProgressLabel>
      <span className="ml-auto text-xs tabular-nums text-text-muted">{task.progress.completed} / {task.progress.total}</span>
    </Progress>
    <p className="text-xs text-text-muted">已读取 {formatBytes(task.progress.bytesRead)} / {formatBytes(task.progress.totalBytes)}</p>
    {task.status === "ready" && <Notice tone={issues ? "warning" : "info"}>
      仅导入通过检查的 {ready} 个 Agent 及其必要依赖并集，保留原 ID。已有、冲突和失败项不覆盖。
      {task.expiresAt && <p className="mt-1">检查有效期至 {formatDateTime(task.expiresAt)}。</p>}
      {expired && <p className="mt-1 font-semibold">检查已过期，请重新选择并检查，不能继续确认。</p>}
    </Notice>}
    {task.status === "completed_with_errors" && <Notice tone="warning">部分导入未成功，已新增的 Agent 和资源会保留。请逐项查看失败与冲突，不会自动重试或删除。</Notice>}
    {task.status === "failed" && <Notice tone="danger">任务失败，导入未完成；已经创建的资源会保留。请查看错误并核验结果，不能将失败视为同步成功。</Notice>}
    {recovering && <Notice tone="info">
      后台仍在自动恢复：沿用原任务、原 ID 和原幂等键核验回执并完成 Eval 记录。页面只读查询，无需重新确认；不会覆盖或删除已有资源。
    </Notice>}
    {task.status === "outcome_unknown" && <Notice tone="warning">
      部分写入可能已经生效，但回执核验或本地收尾尚未完成。后台自动恢复已停止，不会自动继续、覆盖或删除；可刷新任务状态查看核验结果。请保留任务 ID，联系管理员核验，不要重新发起相同导入。
    </Notice>}
    {task.error && <p role="alert" className="whitespace-pre-wrap break-words text-[13px] text-danger">{task.error}</p>}
    <Table aria-label="逐 Agent 导入结果">
      <TableHeader><TableRow><TableHead>Agent</TableHead><TableHead>必要依赖</TableHead><TableHead>结果与原因</TableHead></TableRow></TableHeader>
      <TableBody>{task.agents.map((agent) => <TableRow key={agent.id}>
        <TableCell className="min-w-40 whitespace-normal"><span className="font-semibold">{agent.name}</span>
          <p className="mt-1 break-all font-mono text-xs text-text-muted">{agent.id}</p></TableCell>
        <TableCell className="text-xs">Skill {agent.skillCount}<br />参考资料 {agent.referenceCount}</TableCell>
        <TableCell className="max-w-sm whitespace-normal text-[13px]">
          <span className={["failed", "conflict"].includes(agent.status) ? "text-danger" : agent.status === "outcome_unknown" ? "text-warning" : ""}>{AGENT_LABELS[agent.status]}</span>
          {agent.message && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-text-muted">{agent.message}</p>}
        </TableCell>
      </TableRow>)}</TableBody>
    </Table>
    <p className="text-xs text-text-muted">每行依赖数量可能重叠，不合计为去重资源数；服务端只处理所选 Agent 的必要依赖并集。</p>
  </section>;
}
