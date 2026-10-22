import type { AgentImportCandidate, AgentImportSourceUser, AgentPurpose } from "@eval-platform/eval-contracts";
import { NativeSelect, NativeSelectOption, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@springbrand/site-block";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
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
  const users = useInfiniteQuery({
    queryKey: agentImportKeys.users,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => listAgentImportUsers({
      limit: AGENT_IMPORT_PAGE_SIZE, ...(pageParam !== undefined ? { cursor: pageParam } : {}),
    }, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: !props.disabled,
    retry: false,
  });
  const listedUsers = users.data?.pages.flatMap((page) => page.users) ?? [];
  return <div className="space-y-4">
    <fieldset disabled={props.disabled} className="space-y-2">
      <legend className="mb-2 text-sm font-semibold">1. 选择 dev 用户</legend>
      {users.error && <ErrorBlock error={users.error} onRetry={() => {
        if (!props.disabled && !users.isFetching) void (users.isFetchNextPageError ? users.fetchNextPage() : users.refetch());
      }} />}
      {users.isPending ? <LoadingBlock rows={2} />
        : users.data && <NativeSelect aria-label="选择 dev 用户" name="agent-import-user" className="w-full"
          value={props.sourceUser?.id ?? ""} disabled={props.disabled || listedUsers.length === 0}
          onChange={(event) => {
            const user = listedUsers.find((item) => item.id === event.target.value);
            if (user && !props.disabled) props.onUserChange(user);
          }}>
          <NativeSelectOption value="" disabled>{listedUsers.length === 0 ? "暂无 dev 用户" : "请选择 dev 用户"}</NativeSelectOption>
          {listedUsers.map((user) => <NativeSelectOption key={user.id} value={user.id}>
            {user.name.trim() || "未命名用户"}
          </NativeSelectOption>)}
        </NativeSelect>}
      {users.hasNextPage && <Button size="sm" disabled={props.disabled || users.isFetching} loading={users.isFetchingNextPage}
        onClick={() => void users.fetchNextPage()}>加载更多用户</Button>}
      <p className="text-xs text-text-muted">切换用户将清空尚未提交的选择与检查结果。</p>
      {props.sourceUser && <p className="text-[13px]">已选用户：{props.sourceUser.name.trim() || "未命名用户"}</p>}
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
      : <Notice tone="neutral">请先选择 dev 用户，再搜索和选择该用户的 Agent。</Notice>}
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
  const candidates = page.data?.items ?? [];
  const onPage = candidates.filter((agent) => selected.has(agent.id)).length;
  const all = candidates.length > 0 && onPage === candidates.length;
  const bulkOverLimit = selected.size + candidates.length - onPage > maxAgents;
  function toggle(agent: AgentImportCandidate, checked: boolean) {
    if (disabled || checked && !selected.has(agent.id) && selected.size >= maxAgents) return;
    const next = new Map(selected);
    if (checked) next.set(agent.id, agent);
    else next.delete(agent.id);
    onSelectionChange(next);
  }
  return <section aria-label="选择导入 Agent" className="space-y-3 border-t border-border pt-3">
    <h3 className="text-sm font-semibold">2. 选择 Agent</h3>
    <Input type="search" aria-label="搜索 dev Agent" placeholder="搜索此用户的 Agent 名称或说明" disabled={disabled}
      value={search.q} onChange={(event) => setSearch({ q: event.target.value, cursors: [null] })} />
    <p className="text-xs text-text-muted">每页 20 个，已有 ID 也可选择并覆盖；只检查和导入所选 Agent 的必要依赖并集。</p>
    <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
      <Checkbox label="全选本页 Agent" checked={all ? true : onPage > 0 ? "indeterminate" : false}
        disabled={disabled || page.isFetching || candidates.length === 0 || !all && bulkOverLimit}
        onCheckedChange={(checked) => {
          if (disabled || checked && bulkOverLimit) return;
          const next = new Map(selected);
          for (const agent of candidates) { if (checked) next.set(agent.id, agent); else next.delete(agent.id); }
          onSelectionChange(next);
        }} />
      <span aria-live="polite">已选 {selected.size} / {maxAgents} 个（跨页保留，本页已选 {onPage} 个）</span>
    </div>
    {selected.size >= maxAgents && <p className="text-xs text-warning">已达到本次导入上限，请取消部分选择后再添加。</p>}
    {page.error ? <ErrorBlock error={page.error} onRetry={() => void page.refetch()} />
      : page.isPending ? <LoadingBlock rows={3} />
      : page.data.items.length === 0 ? <Notice tone="neutral">本页没有符合条件的 Agent。可调整搜索或查看其他页。</Notice>
      : <Table aria-label="dev 用户的候选 Agent">
        <TableHeader><TableRow>
          <TableHead className="w-10"><span className="sr-only">选择</span></TableHead>
          <TableHead>Agent</TableHead><TableHead>必要依赖</TableHead><TableHead>Eval 状态</TableHead>
        </TableRow></TableHeader>
        <TableBody>{page.data.items.map((agent) => <TableRow key={agent.id}>
          <TableCell><Checkbox aria-label={`选择 Agent ${agent.name}（${agent.id}）`} checked={selected.has(agent.id)}
            disabled={disabled || !selected.has(agent.id) && selected.size >= maxAgents}
            onCheckedChange={(checked) => toggle(agent, checked)} /></TableCell>
          <TableCell className="min-w-40 whitespace-normal">
            <span className="font-semibold">{agent.name}</span>
            <p className="mt-1 text-xs text-text-muted">{agent.description || "暂无说明"}</p>
            <p className="mt-1 break-all font-mono text-xs text-text-muted">{agent.id} · revision {agent.revision}</p>
          </TableCell>
          <TableCell className="text-xs">Skill {agent.skillCount}<br />参考资料 {agent.referenceCount}</TableCell>
          <TableCell className="text-xs">{agent.exists ? "已存在，导入将覆盖" : "缺失，导入将新增"}</TableCell>
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
