import { useCallback, useState } from "react";
import { fileFormatFor } from "@springbrand/file-renderers/format";
import { getWorkspaceFile, observationKeys, type ObservedKind, type WorkspaceTreeNode } from "@/api-sdk/observations-api";
import { EmptyState } from "@/components/ui/feedback";
import { FileTree } from "@/components/files/file-tree";
import { FilePreview } from "@/components/files/file-preview";
import { POLL_MS } from "@/features/runs/use-run-polling";

export function WorkspaceTab({ projectId, kind, id, tree, running, initialPath = null, compact = false }: {
  projectId: string; kind: ObservedKind; id: string; tree: readonly WorkspaceTreeNode[]; running: boolean;
  initialPath?: string | null; compact?: boolean;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(initialPath);
  const selected = findFile(tree, selectedPath);
  const readFile = useCallback((path: string, signal: AbortSignal) => getWorkspaceFile(projectId, kind, id, path, signal), [projectId, kind, id]);
  if (tree.length === 0) return <EmptyState title="工作区是空的" />;
  return <div className="@container min-w-0">
    <div className={`grid min-w-0 grid-cols-1 items-start ${compact ? "gap-3 @min-[560px]:grid-cols-[13rem_minmax(0,1fr)]" : "min-h-[60dvh] gap-4 @min-[880px]:grid-cols-[18rem_minmax(0,1fr)]"}`}>
      <div className={`min-h-0 overflow-y-auto overscroll-contain rounded-[var(--radius-card)] border border-border bg-surface py-2 ${compact ? "max-h-56 @min-[560px]:max-h-[calc(100dvh-18rem)]" : "max-h-[65dvh]"}`}>
        <FileTree label="工作区目录" nodes={tree} selectedPath={selected?.path ?? null} onSelect={setSelectedPath} />
      </div>
      {selected ? <FilePreview compact={compact} key={JSON.stringify([projectId, kind, id, selected.path])}
        file={{ name: selected.name, path: selected.path, mediaType: selected.mime, byteSize: selected.size }}
        queryKey={[...observationKeys.part(projectId, kind, id, "file"), selected.path, selected.updatedAt ?? null]}
        readFile={readFile} refetchInterval={running ? POLL_MS : false} />
        : <div className="flex min-h-56 items-center justify-center text-sm text-text-muted">选择左侧的文件查看内容</div>}
    </div>
  </div>;
}

const AUTO_PREVIEW_FORMATS = new Set<string>(["csv", "docx", "drawio", "excalidraw", "glb", "html", "image", "markdown", "media", "mermaid", "pdf", "ppt", "svg", "toml", "xlsx", "yaml"]);

/** SP Chat's first Workspace selection: the most recently updated previewable file, ties broken by path. */
export function defaultPreviewPath(nodes: readonly WorkspaceTreeNode[]): string | null {
  let latest: WorkspaceTreeNode | null = null;
  const visit = (items: readonly WorkspaceTreeNode[]) => {
    for (const node of items) {
      if (node.type === "directory") { visit(node.children ?? []); continue; }
      if (node.type !== "file" || typeof node.updatedAt !== "number" || !Number.isFinite(node.updatedAt) || node.name.toLowerCase() === "404.html") continue;
      if (!AUTO_PREVIEW_FORMATS.has(fileFormatFor({ name: node.name, mimeType: node.mime ?? "" }))) continue;
      if (!latest || node.updatedAt > latest.updatedAt! || (node.updatedAt === latest.updatedAt && node.path < latest.path)) latest = node;
    }
  };
  visit(nodes);
  return (latest as WorkspaceTreeNode | null)?.path ?? null;
}

export function findFile(nodes: readonly WorkspaceTreeNode[], path: string | null): WorkspaceTreeNode | null {
  for (const node of nodes) {
    if (node.type !== "directory" && node.path === path) return node;
    const child = node.children && findFile(node.children, path);
    if (child) return child;
  }
  return null;
}
