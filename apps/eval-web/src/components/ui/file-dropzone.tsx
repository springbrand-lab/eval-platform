import { Upload } from "lucide-react";
import { useDropzone } from "react-dropzone";
import { cn } from "@/lib/cn";

export interface PickedFile {
  /** Path relative to the dropped or chosen folder, starting with "/". */
  readonly path: string;
  readonly file: File;
}

/** Strip one shared top-level folder so a dropped folder's contents land at the material root. */
export function normalizePaths(files: PickedFile[]): PickedFile[] {
  const firstSegments = new Set(files.map((item) => item.path.split("/")[1]));
  const allNested = files.every((item) => item.path.split("/").length > 2);
  if (firstSegments.size !== 1 || !allNested) return files;
  return files.map((item) => ({ ...item, path: `/${item.path.split("/").slice(2).join("/")}` }));
}

/** react-dropzone keeps a dropped folder's relative path on `file.path` (e.g. "./site/index.html"). */
export function pickedPath(file: File & { path?: string; relativePath?: string }): string {
  const raw = file.relativePath || file.path || file.webkitRelativePath || file.name;
  return `/${raw.replace(/^\.?\/+/u, "")}`;
}

export function FileDropzone({ onFiles, multiple = true, accept, hint, className }: {
  onFiles: (files: PickedFile[]) => void;
  multiple?: boolean;
  /** File extensions such as ".json,.jsonl"; omitted accepts anything. */
  accept?: string;
  hint?: string;
  className?: string;
}) {
  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    multiple,
    noClick: true,
    ...(accept ? { accept: { "application/octet-stream": accept.split(",").map((item) => item.trim()) } } : {}),
    onDrop: (accepted) => onFiles(normalizePaths(accepted.map((file) => ({ path: pickedPath(file), file })))),
  });
  return (
    <div
      {...getRootProps()}
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 rounded-[var(--radius-card)] border border-dashed px-6 py-6 text-center transition-colors",
        isDragActive ? "border-text-strong bg-surface-muted" : "border-border-strong bg-surface-muted/40",
        className,
      )}
    >
      <input {...getInputProps()} />
      <Upload className="size-4 text-text-muted" />
      <p className="text-[13px] text-text">
        拖入{multiple ? "文件或文件夹" : "文件"}，或
        <button type="button" className="link ml-1 font-semibold" onClick={open}>选择文件</button>
      </p>
      {hint && <p className="text-xs text-text-muted">{hint}</p>}
    </div>
  );
}
