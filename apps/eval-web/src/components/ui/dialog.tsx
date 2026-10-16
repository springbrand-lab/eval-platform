import { X } from "lucide-react";
import { AlertDialog as AlertPrimitive, Dialog as DialogPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

const overlay = "fixed inset-0 z-50 bg-[var(--overlay)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0";
const content = cn(
  "fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-surface text-text shadow-[var(--shadow)] focus:outline-none",
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
);
const widths = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl" };

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}

export function Dialog({ open, onClose, title, description, children, footer, size = "md" }: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={overlay} />
        <DialogPrimitive.Content className={cn(content, widths[size])}>
          <div className="flex items-start justify-between gap-4 px-5 pb-3 pt-5">
            <div>
              <DialogPrimitive.Title className="text-base font-semibold text-text-strong">{title}</DialogPrimitive.Title>
              {description
                ? <DialogPrimitive.Description className="mt-1 text-[13px] leading-relaxed text-text-muted">{description}</DialogPrimitive.Description>
                : <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close className="-mr-1 rounded-md p-1 text-text-muted hover:bg-surface-muted hover:text-text-strong" aria-label="关闭">
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>
          {children && <div className="overflow-y-auto px-5 pb-4">{children}</div>}
          {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
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
    <AlertPrimitive.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <AlertPrimitive.Portal>
        <AlertPrimitive.Overlay className={overlay} />
        <AlertPrimitive.Content className={cn(content, widths.sm)}>
          <div className="px-5 pb-4 pt-5">
            <AlertPrimitive.Title className="text-base font-semibold text-text-strong">{title}</AlertPrimitive.Title>
            <AlertPrimitive.Description className="mt-2 text-[13px] leading-relaxed text-text-secondary">{description}</AlertPrimitive.Description>
          </div>
          <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
            <AlertPrimitive.Cancel asChild><Button size="sm">取消</Button></AlertPrimitive.Cancel>
            {/* Not AlertPrimitive.Action: it would close before an async confirm can show its loading state. */}
            <Button size="sm" variant={danger ? "danger" : "primary"} loading={loading} onClick={onConfirm}>{confirmLabel}</Button>
          </div>
        </AlertPrimitive.Content>
      </AlertPrimitive.Portal>
    </AlertPrimitive.Root>
  );
}
