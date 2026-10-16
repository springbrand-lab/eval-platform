import { ChevronRight, File, Folder } from "lucide-react";
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@springbrand/site-block";
import { cn } from "@/lib/cn";

export interface FileTreeEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "file" | "directory" | "symlink";
  readonly children?: readonly FileTreeEntry[];
}

function Entry({ node, depth, selectedPath, onSelect }: {
  node: FileTreeEntry; depth: number; selectedPath: string | null; onSelect: (path: string) => void;
}) {
  const style = { paddingLeft: depth * 12 + 8 };
  const className = "h-auto w-full justify-start gap-1.5 rounded-none py-2 pr-2 text-left text-[13px]";
  if (node.type === "directory") return <Collapsible defaultOpen={depth === 0}>
    <CollapsibleTrigger asChild>
      <Button type="button" variant="ghost" title={node.path} style={style} className={cn(className, "group")}>
        <ChevronRight aria-hidden className="size-3.5 shrink-0 group-aria-expanded:rotate-90" />
        <Folder aria-hidden className="size-3.5 shrink-0 text-warning" /><span className="truncate">{node.name}</span>
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent>{node.children?.map((child) => <Entry key={`${child.type}:${child.path}`} node={child} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />)}</CollapsibleContent>
  </Collapsible>;
  return <Button type="button" variant="ghost" title={node.path} aria-pressed={selectedPath === node.path}
    onClick={() => onSelect(node.path)} style={{ paddingLeft: depth * 12 + 26 }} className={cn(className, selectedPath === node.path && "bg-accent-soft link")}>
    <File aria-hidden className="size-3.5 shrink-0 text-text-muted" /><span className="truncate">{node.name}</span>
  </Button>;
}

/** A navigation list rather than an ARIA tree: directory disclosure and file buttons retain native keyboard behavior. */
export function FileTree({ nodes, selectedPath, onSelect, label }: {
  nodes: readonly FileTreeEntry[]; selectedPath: string | null; onSelect: (path: string) => void; label: string;
}) {
  return <nav aria-label={label}>{nodes.map((node) => <Entry key={`${node.type}:${node.path}`} node={node} depth={0} selectedPath={selectedPath} onSelect={onSelect} />)}</nav>;
}
