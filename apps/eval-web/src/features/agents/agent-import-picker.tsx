import type { AgentImportCandidate, AgentImportSourceUser, AgentPurpose } from "@eval-platform/eval-contracts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@springbrand/site-block";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { listAgentImportCandidates, listAgentImportUsers } from "@/api-sdk/agent-imports-api";
import { Button } from "@/components/ui/button";
import { Checkbox, Input } from "@/components/ui/form";
import { ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { AGENT_IMPORT_PAGE_SIZE, agentImportKeys } from "./agent-import-state";

interface PickerProps {
  sourceUser: AgentImportSourceUser | null;
  purpose: AgentPurpose;
  selected: ReadonlyMap<string, AgentImportCandidate>;
  maxAgents: number;
  disabled: boolean;
  onUserChange: (user: AgentImportSourceUser) => void;
  onPurposeChange: (purpose: AgentPurpose) => void;
  onSelectionChange: (selected: ReadonlyMap<string, AgentImportCandidate>) => void;
}

export function AgentImportPicker(props: PickerProps) {
  const [q, setQ] = useState("");
  const search = q.trim();
  const users = useQuery({
    queryKey: agentImportKeys.users(search),
    queryFn: ({ signal }) => listAgentImportUsers(search, AGENT_IMPORT_PAGE_SIZE, signal),
    enabled: search.length > 0 && !props.disabled,
    retry: false,
  });
  return <div className="space-y-4">
    <fieldset disabled={props.disabled} className="space-y-2">
      <legend className="mb-2 text-sm font-semibold">1. 选择 dev 用户</legend>
      <Input type="search" aria-label="搜索已授权 dev 用户" placeholder="搜索已授权用户的名称或邮箱" maxLength={200}
        value={q} onChange={(event) => setQ(event.target.value)} />
      {!search ? <p className="text-[13px] text-text-muted">请先输入 dev 用户的名称或邮箱进行搜索。</p>
        : users.error ? <ErrorBlock error={users.error} onRetry={() => void users.refetch()} />
        : users.isPending ? <LoadingBlock rows={2} />
        : <div role="radiogroup" aria-label="选择 dev 用户" className="max-h-36 space-y-1 overflow-y-auto">
          {users.data.users.map((user) => <label key={user.id}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-[13px] has-[:checked]:border-primary has-[:checked]:bg-primary/5">
            <input type="radio" name="agent-import-user" value={user.id} checked={props.sourceUser?.id === user.id}
              className="size-4 accent-primary" onChange={() => props.onUserChange(user)} />
            <span className="min-w-0 break-words">{user.name || user.email || user.id}
              {user.name && user.email && <span className="ml-2 text-text-muted">{user.email}</span>}</span>
          </label>)}
          {users.data.users.length === 0 && <p className="text-[13px] text-text-muted">未找到已授权用户，请调整搜索；不会读取未授权用户。</p>}
        </div>}
      <p className="text-xs text-text-muted">最多显示 20 位已授权用户，可搜索缩小范围。切换用户将清空尚未提交的选择与检查结果。</p>
      {props.sourceUser && <p className="text-[13px]">已选用户：{props.sourceUser.name || props.sourceUser.email || props.sourceUser.id}</p>}
    </fieldset>
    <fieldset disabled={props.disabled} className="flex flex-wrap items-center gap-4 border-t border-border pt-3">
      <legend className="text-sm font-semibold">导入后的用途</legend>
      {(["execution", "evaluation"] as const).map((purpose) => <label key={purpose} className="flex items-center gap-2 text-[13px]">
        <input type="radio" name="agent-import-purpose" value={purpose} checked={props.purpose === purpose}
          className="size-4 accent-primary" onChange={() => props.onPurposeChange(purpose)} />
        {purpose === "execution" ? "执行 Agent" : "评估 Agent"}
      </label>)}
      <p className="w-full text-xs text-text-muted">用途独立于 dev 来源；评估 Agent 使用 Eval 的评估结果 MCP。</p>
    </fieldset>
    {props.sourceUser
      ? <AgentImportCandidates key={props.sourceUser.id} {...props} sourceUser={props.sourceUser} />
      : <Notice tone="neutral">请先选择已授权的 dev 用户，再搜索和选择该用户的缺失 Agent。</Notice>}
  </div>;
}

function AgentImportCandidates({
  sourceUser, selected, maxAgents, disabled, onSelectionChange,
}: PickerProps & { sourceUser: AgentImportSourceUser }) {
  const [search, setSearch] = useState({ q: "", cursors: [null] as (string | null)[] });
  const cursor = search.cursors.at(-1)!;
  const page = useQuery({
    queryKey: agentImportKeys.candidates(sourceUser.id, search.q, cursor),
    queryFn: ({ signal }) => listAgentImportCandidates(sourceUser.id, {
      q: search.q, ...(cursor !== null ? { cursor } : {}), limit: AGENT_IMPORT_PAGE_SIZE,
    }, signal),
    retry: false,
  });
  const missing = (page.data?.items ?? []).filter((agent) => !agent.exists);
  const onPage = missing.filter((agent) => selected.has(agent.id)).length;
  const all = missing.length > 0 && onPage === missing.length;
  const bulkOverLimit = selected.size + missing.length - onPage > maxAgents;
  function toggle(agent: AgentImportCandidate, checked: boolean) {
    if (disabled || agent.exists || checked && !selected.has(agent.id) && selected.size >= maxAgents) return;
    const next = new Map(selected);
    if (checked) next.set(agent.id, agent);
    else next.delete(agent.id);
    onSelectionChange(next);
  }
  return <section aria-label="选择缺失 Agent" className="space-y-3 border-t border-border pt-3">
    <h3 className="text-sm font-semibold">2. 选择 Agent</h3>
    <Input type="search" aria-label="搜索 dev Agent" placeholder="搜索此用户的 Agent 名称或说明" disabled={disabled}
      value={search.q} onChange={(event) => setSearch({ q: event.target.value, cursors: [null] })} />
    <p className="text-xs text-text-muted">每页 20 个，仅查询 Eval 缺失的 Agent；只检查和导入所选 Agent 的必要依赖并集。</p>
    <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
      <Checkbox label="全选本页缺失 Agent" checked={all ? true : onPage > 0 ? "indeterminate" : false}
        disabled={disabled || page.isFetching || missing.length === 0 || !all && bulkOverLimit}
        onCheckedChange={(checked) => {
          if (disabled || checked && bulkOverLimit) return;
          const next = new Map(selected);
          for (const agent of missing) { if (checked) next.set(agent.id, agent); else next.delete(agent.id); }
          onSelectionChange(next);
        }} />
      <span aria-live="polite">已选 {selected.size} / {maxAgents} 个（跨页保留，本页已选 {onPage} 个）</span>
    </div>
    {selected.size >= maxAgents && <p className="text-xs text-warning">已达到本次导入上限，请取消部分选择后再添加。</p>}
    {page.error ? <ErrorBlock error={page.error} onRetry={() => void page.refetch()} />
      : page.isPending ? <LoadingBlock rows={3} />
      : page.data.items.length === 0 ? <Notice tone="neutral">本页没有符合条件的缺失 Agent。可调整搜索或查看其他页；不代表整个用户已同步。</Notice>
      : <Table aria-label="dev 用户的候选 Agent">
        <TableHeader><TableRow>
          <TableHead className="w-10"><span className="sr-only">选择</span></TableHead>
          <TableHead>Agent</TableHead><TableHead>必要依赖</TableHead><TableHead>Eval 状态</TableHead>
        </TableRow></TableHeader>
        <TableBody>{page.data.items.map((agent) => <TableRow key={agent.id}>
          <TableCell><Checkbox aria-label={`选择 Agent ${agent.name}（${agent.id}）`} checked={selected.has(agent.id)}
            disabled={disabled || agent.exists || !selected.has(agent.id) && selected.size >= maxAgents}
            onCheckedChange={(checked) => toggle(agent, checked)} /></TableCell>
          <TableCell className="min-w-40 whitespace-normal">
            <span className="font-semibold">{agent.name}</span>
            <p className="mt-1 text-xs text-text-muted">{agent.description || "暂无说明"}</p>
            <p className="mt-1 break-all font-mono text-xs text-text-muted">{agent.id} · revision {agent.revision}</p>
          </TableCell>
          <TableCell className="text-xs">Skill {agent.skillCount}<br />参考资料 {agent.referenceCount}</TableCell>
          <TableCell className="text-xs">{agent.exists ? "已存在，不导入" : "缺失，可选择"}</TableCell>
        </TableRow>)}</TableBody>
      </Table>}
    <nav aria-label="候选 Agent 分页" className="flex items-center justify-end gap-3">
      <Button size="sm" disabled={disabled || page.isFetching || search.cursors.length === 1}
        onClick={() => setSearch((current) => ({ ...current, cursors: current.cursors.slice(0, -1) }))}>上一页</Button>
      <span className="text-xs text-text-muted">第 {search.cursors.length} 页 · 每页 20 个</span>
      <Button size="sm" disabled={disabled || page.isFetching || !!page.error || !page.data?.nextCursor}
        onClick={() => { if (page.data?.nextCursor) setSearch((current) => ({ ...current, cursors: [...current.cursors, page.data.nextCursor] })); }}>下一页</Button>
    </nav>
    {selected.size > 0 && <details className="rounded-lg border border-border px-3 py-2 text-[13px]">
      <summary className="cursor-pointer font-semibold">查看跨页已选 Agent（{selected.size} 个）</summary>
      <ul className="mt-2 max-h-40 space-y-2 overflow-y-auto">{[...selected.values()].map((agent) => <li key={agent.id} className="flex items-start justify-between gap-2">
        <span>{agent.name}<span className="mt-0.5 block break-all font-mono text-xs text-text-muted">{agent.id}</span></span>
        <Button size="xs" variant="ghost" disabled={disabled} aria-label={`移除选择 ${agent.name}`}
          onClick={() => { const next = new Map(selected); next.delete(agent.id); onSelectionChange(next); }}>移除</Button>
      </li>)}</ul>
      <Button size="xs" variant="ghost" disabled={disabled} className="mt-2" onClick={() => onSelectionChange(new Map())}>清空选择</Button>
    </details>}
  </section>;
}
