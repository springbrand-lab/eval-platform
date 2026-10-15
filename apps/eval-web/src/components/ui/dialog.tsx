import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}

const widths = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl" };

/** Native <dialog>: focus trapping, Escape and the backdrop come from the browser. */
export function Dialog({ open, onClose, title, description, children, footer, size = "md" }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === ref.current) onClose(); }}
      className={cn(
        "m-auto w-[calc(100%-2rem)] rounded-xl border border-border bg-surface p-0 text-text shadow-[var(--shadow)] backdrop:bg-[var(--overlay)] backdrop:backdrop-blur-[1px]",
        widths[size],
      )}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
            <div>
              <h2 className="text-base font-semibold text-text-strong">{title}</h2>
              {description && <p className="mt-1 text-[13px] leading-relaxed text-text-muted">{description}</p>}
            </div>
            <button type="button" aria-label="关闭" onClick={onClose} className="-mr-1 rounded-md p-1 text-text-muted hover:bg-surface-muted hover:text-text-strong">
              <X className="size-4" />
            </button>
          </div>
          {children && <div className="overflow-y-auto px-5 pb-4">{children}</div>}
          {footer && <div className="flex justify-end gap-2 border-t border-border bg-surface-muted/40 px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel = "确认", danger, loading }: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={(
        <>
          <Button size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" variant={danger ? "danger" : "primary"} loading={loading} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      )}
    >
      <div className="text-[13px] leading-relaxed text-text-secondary">{description}</div>
    </Dialog>
  );
}
