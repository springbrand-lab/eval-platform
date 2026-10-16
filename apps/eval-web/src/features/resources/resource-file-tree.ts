import type { InitialResourceFile } from "@eval-platform/eval-contracts";
import type { FileTreeEntry } from "@/components/files/file-tree";

/** The manifest is authoritative; directory entries are derived without changing stored file paths. */
export function resourceFileTree(files: readonly InitialResourceFile[]): readonly FileTreeEntry[] {
  const roots: FileTreeEntry[] = [];
  const directories = new Map<string, FileTreeEntry & { children: FileTreeEntry[] }>();
  for (const file of files) {
    const parts = file.path.slice(1).split("/");
    let children = roots;
    let path = "";
    for (const name of parts.slice(0, -1)) {
      path += `/${name}`;
      let directory = directories.get(path);
      if (!directory) {
        directory = { name, path, type: "directory", children: [] };
        directories.set(path, directory);
        children.push(directory);
      }
      children = directory.children;
    }
    children.push({ name: parts.at(-1)!, path: file.path, type: "file" });
  }
  const sort = (nodes: FileTreeEntry[]) => nodes.sort((a, b) =>
    Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  directories.forEach((directory) => sort(directory.children));
  return sort(roots);
}
