import { Upload } from "lucide-react";
import { Button } from "@springbrand/site-block";
import { fromEvent } from "file-selector";
import { useDropzone, type Accept, type DropEvent } from "react-dropzone";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";

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

export function FileDropzone({ onFiles, onSelectionStart, onRejected, onExtractingChange, multiple = true, accept, hint, className, maxBytes, disabled }: {
  onFiles: (files: PickedFile[], signal: AbortSignal) => void;
  /** The draft may cancel a selection, including pending browser file extraction. */
  onSelectionStart?: () => AbortSignal;
  /** A rejected replacement must invalidate any draft based on an older selection. */
  onRejected?: () => void;
  /** Derived from active extractions; forms must wait before committing the selection. */
  onExtractingChange?: (extracting: boolean) => void;
  multiple?: boolean;
  accept?: Accept;
  hint?: string;
  className?: string;
  maxBytes?: number;
  disabled?: boolean;
}) {
  const [error, setError] = useState("");
  type Selection = { event: DropEvent; signal: AbortSignal; failed: boolean };
  const latest = useRef<Selection | null>(null);
  const selections = useRef(new Map<DropEvent, Selection>());
  const endExtraction = useEffectEvent(() => onExtractingChange?.(false));
  useEffect(() => () => {
    latest.current = null;
    selections.current.clear();
    endExtraction();
  }, []);
  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    multiple,
    disabled,
    noClick: true,
    useFsAccessApi: false,
    accept,
    ...(maxBytes !== undefined ? { maxSize: maxBytes } : {}),
    getFilesFromEvent: async (event) => {
      if (!Array.isArray(event) && event.type !== "drop" && event.type !== "change") return fromEvent(event);
      const current = { event, signal: onSelectionStart?.() ?? new AbortController().signal, failed: false };
      latest.current = current;
      selections.current.set(event, current);
      setError("");
      onExtractingChange?.(true);
      try {
        return await fromEvent(event);
      } catch {
        if (selections.current.get(event) === current && (multiple || latest.current === current) && !current.signal.aborted) {
          current.failed = true;
          setError("无法读取所选文件，请重新选择。");
          onRejected?.();
        }
        return [];
      }
    },
    onDrop: (accepted, rejected, event) => {
      const current = selections.current.get(event);
      if (!current) return;
      selections.current.delete(event);
      onExtractingChange?.(multiple ? selections.current.size > 0 : !!latest.current && selections.current.has(latest.current.event));
      if (current.failed || current.signal.aborted || (!multiple && latest.current !== current)) return;
      const rejection = rejected.map(({ file, errors }) => `${file.name}：${errors.some((item) => item.code === "file-too-large") ? `超过 ${formatBytes(maxBytes!)}` : "文件类型或数量不符合要求"}`).join("；");
      setError(rejection || (accepted.length === 0 ? "没有可读取的文件" : ""));
      if (accepted.length === 0) onRejected?.();
      else onFiles(normalizePaths(accepted.map((file) => ({ path: pickedPath(file), file }))), current.signal);
    },
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
      <input {...getInputProps({ disabled })} />
      <Upload className="size-4 text-text-muted" />
      <p className="text-[13px] text-text">
        拖入{multiple ? "文件或文件夹" : "文件"}，或
        <Button type="button" variant="link" className="ml-1 h-auto p-0 font-semibold" disabled={disabled} onClick={open}>选择文件</Button>
      </p>
      {hint && <p className="text-xs text-text-muted">{hint}</p>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  );
}
