import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-[var(--radius-card)] border border-border bg-surface", className)} {...props} />;
}

export function CardHeader({ title, description, actions, className }: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4 border-b border-border px-4 py-3", className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4", className)} {...props} />;
}

/** Two-column label/value list for detail panels. */
export function DescriptionList({ items, className }: {
  items: readonly { label: ReactNode; value: ReactNode }[]; className?: string;
}) {
  return (
    <dl className={cn("grid grid-cols-[minmax(96px,max-content)_1fr] gap-x-6 gap-y-2.5 text-sm", className)}>
      {items.map((item, index) => (
        <div key={index} className="contents">
          <dt className="text-text-muted">{item.label}</dt>
          <dd className="min-w-0 break-words text-text">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
