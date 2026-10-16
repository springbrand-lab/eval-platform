import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface", className)} {...props} />;
}

export function CardHeader({ title, description, actions, className }: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string;
}) {
  return (
    <div className={cn("flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4", className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-text-strong">{title}</h2>
        {description && <p className="mt-1 text-[13px] leading-relaxed text-text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5", className)} {...props} />;
}

/** Two-column label/value list for detail panels. */
export function DescriptionList({ items, className }: {
  items: readonly { label: ReactNode; value: ReactNode }[]; className?: string;
}) {
  return (
    <dl className={cn("grid grid-cols-[minmax(88px,max-content)_1fr] gap-x-6 gap-y-2 text-[13px]", className)}>
      {items.map((item, index) => (
        <div key={index} className="contents">
          <dt className="text-text-muted">{item.label}</dt>
          <dd className="min-w-0 break-words text-text-strong">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A labelled section heading inside a card or page. */
export function SectionLabel({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">{children}</p>
      {actions}
    </div>
  );
}
