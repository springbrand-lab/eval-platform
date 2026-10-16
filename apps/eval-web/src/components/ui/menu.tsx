import { MoreHorizontal } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { ReactNode } from "react";
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

/** "More actions": secondary and destructive actions stay out of the page header. */
export function ActionMenu({ items, label = "更多操作" }: { items: readonly MenuItem[]; label?: string }) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button size="icon" aria-label={label}><MoreHorizontal /></Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-44 rounded-lg border border-border bg-surface p-1 shadow-[var(--shadow)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          {items.map((item, index) => (
            <div key={index}>
              {item.separated && <DropdownMenu.Separator className="my-1 h-px bg-border" />}
              <DropdownMenu.Item
                disabled={item.disabled}
                onSelect={item.onSelect}
                className={cn(
                  "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4",
                  item.danger ? "text-danger data-[highlighted]:bg-danger-soft" : "text-text data-[highlighted]:bg-surface-muted data-[highlighted]:text-text-strong",
                )}
              >
                {item.icon}
                {item.label}
              </DropdownMenu.Item>
            </div>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
