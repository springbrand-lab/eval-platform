import { Upload } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { cn } from "@/lib/cn";

export interface PickedFile {
  /** Path relative to the dropped or chosen folder, starting with "/". */
  readonly path: string;
  readonly file: File;
}

async function readEntry(entry: FileSystemEntry, prefix: string, out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ path: `${prefix}/${entry.name}`, file });
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    for (const child of batch) await readEntry(child, `${prefix}/${entry.name}`, out);
  }
}

/** Strip one shared top-level folder so a dropped folder's contents land at the material root. */
export function normalizePaths(files: PickedFile[]): PickedFile[] {
  const firstSegments = new Set(files.map((item) => item.path.split("/")[1]));
  const allNested = files.every((item) => item.path.split("/").length > 2);
  if (firstSegments.size !== 1 || !allNested) return files;
  return files.map((item) => ({ ...item, path: `/${item.path.split("/").slice(2).join("/")}` }));
}

export function FileDropzone({ onFiles, multiple = true, directory = false, accept, hint, className }: {
  onFiles: (files: PickedFile[]) => void;
  multiple?: boolean;
  directory?: boolean;
  accept?: string;
  hint?: string;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const items = [...event.dataTransfer.items];
    const entries = items.map((item) => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => !!entry);
    const out: PickedFile[] = [];
    if (entries.length > 0) {
      for (const entry of entries) await readEntry(entry, "", out);
    } else {
      for (const file of event.dataTransfer.files) out.push({ path: `/${file.name}`, file });
    }
    onFiles(normalizePaths(out));
  };
  return (
    <div
      onDragOver={(event) => { event.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => void handleDrop(event)}
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border border-dashed px-6 py-8 text-center",
        over ? "border-primary bg-primary-soft" : "border-border bg-surface-muted/50",
        className,
      )}
    >
      <Upload className="size-6 text-text-muted" />
      <p className="text-sm text-text">
        拖入{directory ? "文件或文件夹" : "文件"}，或
        <button type="button" className="ml-1 font-medium text-primary hover:underline" onClick={() => input.current?.click()}>选择文件</button>
      </p>
      {hint && <p className="text-xs text-text-muted">{hint}</p>}
      <input
        ref={input}
        type="file"
        hidden
        multiple={multiple}
        accept={accept}
        {...(directory ? { webkitdirectory: "" } : {})}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])].map((file) => ({
            path: `/${(file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name}`,
            file,
          }));
          onFiles(normalizePaths(files));
          event.target.value = "";
        }}
      />
    </div>
  );
}
