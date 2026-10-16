import { useCallback, useState } from "react";
import { getWorkspaceFile, observationKeys, type ObservedKind, type WorkspaceTreeNode } from "@/api-sdk/observations-api";
import { EmptyState } from "@/components/ui/feedback";
import { FileTree } from "@/components/files/file-tree";
import { FilePreview } from "@/components/files/file-preview";
import { POLL_MS } from "@/features/runs/use-run-polling";

export function WorkspaceTab({ projectId, kind, id, tree, running }: {
  projectId: string; kind: ObservedKind; id: string; tree: readonly WorkspaceTreeNode[]; running: boolean;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selected = findFile(tree, selectedPath);
  const readFile = useCallback((path: string, signal: AbortSignal) => getWorkspaceFile(projectId, kind, id, path, signal), [projectId, kind, id]);
  if (tree.length === 0) return <EmptyState title="工作区是空的" />;
  return <div className="grid min-h-[60dvh] min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
    <div className="max-h-[65dvh] min-h-0 overflow-y-auto overscroll-contain rounded-[var(--radius-card)] border border-border bg-surface py-2">
      <FileTree label="工作区目录" nodes={tree} selectedPath={selectedPath} onSelect={setSelectedPath} />
    </div>
    {selected ? <FilePreview key={JSON.stringify([projectId, kind, id, selected.path])}
      file={{ name: selected.name, path: selected.path, mediaType: selected.mime, byteSize: selected.size }}
      queryKey={[...observationKeys.part(projectId, kind, id, "file"), selected.path, selected.updatedAt ?? null]}
      readFile={readFile} refetchInterval={running ? POLL_MS : false} />
      : <div className="flex min-h-56 items-center justify-center text-sm text-text-muted">选择左侧的文件查看内容</div>}
  </div>;
}

function findFile(nodes: readonly WorkspaceTreeNode[], path: string | null): WorkspaceTreeNode | null {
  for (const node of nodes) {
    if (node.type !== "directory" && node.path === path) return node;
    const child = node.children && findFile(node.children, path);
    if (child) return child;
  }
  return null;
}
