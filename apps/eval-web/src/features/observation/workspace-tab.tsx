import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Download, File, Folder } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getWorkspaceFile, observationKeys, type ObservedKind, type WorkspaceTreeNode } from "@/api-sdk/observations-api";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/data-display";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";

const TEXT_TYPES = /^(text\/|application\/(json|javascript|xml|yaml|x-ndjson|x-yaml|toml))/u;
const TEXT_EXTENSIONS = /\.(txt|md|json|jsonl|js|mjs|ts|tsx|jsx|css|html?|xml|ya?ml|csv|py|sh|toml|ini|log|svg)$/iu;

export function isTextFile(path: string, type: string): boolean {
  return TEXT_TYPES.test(type) || TEXT_EXTENSIONS.test(path);
}

function TreeNode({ node, depth, selected, onSelect }: {
  node: WorkspaceTreeNode; depth: number; selected: string | null; onSelect: (node: WorkspaceTreeNode) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  if (node.type === "directory") {
    return (
      <div>
        <button type="button" onClick={() => setOpen(!open)} style={{ paddingLeft: depth * 12 + 8 }}
          className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[13px] hover:bg-surface-muted">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <Folder className="size-3.5 text-warning" />
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children?.map((child) => <TreeNode key={child.path} node={child} depth={depth + 1} selected={selected} onSelect={onSelect} />)}
      </div>
    );
  }
  return (
    <button type="button" onClick={() => onSelect(node)} style={{ paddingLeft: depth * 12 + 26 }}
      className={cn("flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[13px] hover:bg-surface-muted", selected === node.path && "bg-accent-soft text-link")}>
      <File className="size-3.5 shrink-0 text-text-muted" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

function FilePreview({ projectId, kind, id, node }: { projectId: string; kind: ObservedKind; id: string; node: WorkspaceTreeNode }) {
  const file = useQuery({
    queryKey: [...observationKeys.part(projectId, kind, id, "file"), node.path, node.updatedAt ?? ""],
    queryFn: ({ signal }) => getWorkspaceFile(projectId, kind, id, node.path, signal),
    staleTime: Infinity,
  });
  const [text, setText] = useState<string | null>(null);
  const url = useMemo(() => (file.data ? URL.createObjectURL(file.data) : null), [file.data]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const type = node.mime ?? file.data?.type ?? "";
  const textual = isTextFile(node.path, type);
  useEffect(() => {
    setText(null);
    if (file.data && textual) void file.data.text().then(setText);
  }, [file.data, textual]);
  const [rendered, setRendered] = useState(false);
  const html = /\.html?$/iu.test(node.path);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[13px]">{node.path}</p>
          <p className="text-xs text-text-muted">{type || "未知类型"}{node.size !== undefined && ` · ${formatBytes(node.size)}`}</p>
        </div>
        <div className="flex gap-2">
          {html && text !== null && <Button size="sm" onClick={() => setRendered(!rendered)}>{rendered ? "查看源码" : "预览页面"}</Button>}
          {url && <a href={url} download={node.name}><Button size="sm" icon={<Download className="size-3.5" />}>下载</Button></a>}
        </div>
      </div>
      {file.isPending ? <LoadingBlock rows={6} /> : file.error ? <ErrorBlock error={file.error} /> : (
        html && rendered && text !== null
          // No scripts, forms or same-origin access: a static look at the page only.
          ? <iframe title={node.path} sandbox="" srcDoc={text} className="h-[60vh] w-full rounded-[var(--radius-control)] border border-border bg-white" />
          : textual && text !== null ? <CodeBlock value={text} maxHeight="60vh" />
          : type.startsWith("image/") && url ? <img src={url} alt={node.name} className="max-h-[60vh] max-w-full self-start rounded border border-border" />
          : <p className="text-sm text-text-muted">这个文件不能在页面中预览，请下载查看。</p>
      )}
    </div>
  );
}

export function WorkspaceTab({ projectId, kind, id, tree }: {
  projectId: string; kind: ObservedKind; id: string; tree: readonly WorkspaceTreeNode[];
}) {
  const [selected, setSelected] = useState<WorkspaceTreeNode | null>(null);
  if (tree.length === 0) return <EmptyState title="工作区是空的" />;
  return (
    <div className="flex min-h-[60vh] gap-4">
      <div className="w-72 shrink-0 overflow-y-auto rounded-[var(--radius-card)] border border-border bg-surface py-2">
        {tree.map((node) => <TreeNode key={node.path} node={node} depth={0} selected={selected?.path ?? null} onSelect={setSelected} />)}
      </div>
      {selected
        ? <FilePreview key={selected.path} projectId={projectId} kind={kind} id={id} node={selected} />
        : <div className="flex flex-1 items-center justify-center text-sm text-text-muted">选择左侧的文件查看内容</div>}
    </div>
  );
}
