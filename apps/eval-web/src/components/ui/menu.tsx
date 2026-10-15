import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

export interface MenuItem {
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Draws a separator above this item. */
  separated?: boolean;
}

/** A "more actions" menu: secondary and destructive actions stay out of the page header. */
export function ActionMenu({ items, label = "更多操作", trigger }: { items: readonly MenuItem[]; label?: string; trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={root} className="relative">
      {trigger ? <span onClick={() => setOpen(!open)}>{trigger}</span> : (
        <Button size="icon" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          <MoreHorizontal />
        </Button>
      )}
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1 min-w-44 rounded-lg border border-border bg-surface p-1 shadow-[var(--shadow)]">
          {items.map((item, index) => (
            <div key={index}>
              {item.separated && <div className="my-1 h-px bg-border" />}
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => { setOpen(false); item.onSelect(); }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] disabled:opacity-50 [&_svg]:size-4",
                  item.danger ? "text-danger hover:bg-danger-soft" : "text-text hover:bg-surface-muted hover:text-text-strong",
                )}
              >
                {item.icon}
                {item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
