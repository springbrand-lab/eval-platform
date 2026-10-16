import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Download, File, Folder } from "lucide-react";
import { useEffect, useState } from "react";
import { getWorkspaceFile, observationKeys, type ObservedKind, type WorkspaceTreeNode } from "@/api-sdk/observations-api";
import { Button } from "@springbrand/site-block";
import { CodeBlock } from "@/components/ui/data-display";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { POLL_MS } from "@/features/runs/use-run-polling";

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
        <Button type="button" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)} style={{ paddingLeft: depth * 12 + 8 }}
          className="h-auto w-full justify-start gap-1.5 rounded-none py-1 pr-2 text-left text-[13px]">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <Folder className="size-3.5 text-warning" />
          <span className="truncate">{node.name}</span>
        </Button>
        {open && node.children?.map((child) => <TreeNode key={child.path} node={child} depth={depth + 1} selected={selected} onSelect={onSelect} />)}
      </div>
    );
  }
  return (
    <Button type="button" variant="ghost" aria-pressed={selected === node.path} onClick={() => onSelect(node)} style={{ paddingLeft: depth * 12 + 26 }}
      className={cn("h-auto w-full justify-start gap-1.5 rounded-none py-1 pr-2 text-left text-[13px]", selected === node.path && "bg-accent-soft link")}>
      <File className="size-3.5 shrink-0 text-text-muted" />
      <span className="truncate">{node.name}</span>
    </Button>
  );
}

function FilePreview({ projectId, kind, id, node, running }: { projectId: string; kind: ObservedKind; id: string; node: WorkspaceTreeNode; running: boolean }) {
  const file = useQuery({
    queryKey: [...observationKeys.part(projectId, kind, id, "file"), node.path, node.updatedAt ?? null],
    queryFn: async ({ signal }) => {
      const blob = await getWorkspaceFile(projectId, kind, id, node.path, signal);
      const text = isTextFile(node.path, node.mime ?? blob.type) ? await blob.text() : null;
      return { blob, text };
    },
    staleTime: 0,
    refetchInterval: running ? POLL_MS : false,
  });
  const blob = file.data?.blob;
  const [download, setDownload] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    setDownload({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  const url = download && download.blob === blob ? download.url : null;
  const text = file.data?.text ?? null;
  const type = node.mime ?? blob?.type ?? "";
  const textual = isTextFile(node.path, type);
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
          {html && text !== null && <Button size="sm" variant="outline" onClick={() => setRendered(!rendered)}>{rendered ? "查看源码" : "预览页面"}</Button>}
          {url && <Button asChild size="sm" variant="outline"><a href={url} download={node.name}><Download className="size-3.5" />下载</a></Button>}
        </div>
      </div>
      {file.isPending ? <LoadingBlock rows={6} /> : file.error ? <ErrorBlock error={file.error} onRetry={() => void file.refetch()} /> : (
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

export function WorkspaceTab({ projectId, kind, id, tree, running }: {
  projectId: string; kind: ObservedKind; id: string; tree: readonly WorkspaceTreeNode[]; running: boolean;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selected = findFile(tree, selectedPath);
  if (tree.length === 0) return <EmptyState title="工作区是空的" />;
  return (
    <div className="flex min-h-[60vh] gap-4">
      <div className="w-72 shrink-0 overflow-y-auto rounded-[var(--radius-card)] border border-border bg-surface py-2">
        {tree.map((node) => <TreeNode key={node.path} node={node} depth={0} selected={selectedPath} onSelect={(file) => setSelectedPath(file.path)} />)}
      </div>
      {selected
        ? <FilePreview key={JSON.stringify([projectId, kind, id, selected.path])} projectId={projectId} kind={kind} id={id} node={selected} running={running} />
        : <div className="flex flex-1 items-center justify-center text-sm text-text-muted">选择左侧的文件查看内容</div>}
    </div>
  );
}

function findFile(nodes: readonly WorkspaceTreeNode[], path: string | null): WorkspaceTreeNode | null {
  for (const node of nodes) {
    if (node.type !== "directory" && node.path === path) return node;
    const child = node.children && findFile(node.children, path);
    if (child) return child;
  }
  return null;
}
