import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface Crumb {
  label: string;
  to?: string;
  params?: Record<string, string>;
}

/** Sticky page bar: breadcrumbs, title and actions above a hairline, as in Langfuse. */
export function PageHeader({ title, description, crumbs, actions, meta, flush, compact = false }: {
  title: ReactNode; description?: ReactNode; crumbs?: readonly Crumb[]; actions?: ReactNode; meta?: ReactNode;
  /** No gap below: the content starts right under the bar (full-bleed views). */
  flush?: boolean;
  compact?: boolean;
}) {
  useEffect(() => {
    if (typeof title === "string") document.title = `${title} · Eval`;
  }, [title]);
  return (
    <header className={cn("sticky top-0 z-20 -mx-4 border-b border-border bg-bg/95 px-4 py-5 backdrop-blur sm:-mx-6 sm:px-6", !flush && (compact ? "mb-3" : "mb-6"), compact && "py-3")}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          {crumbs && crumbs.length > 0 && (
            <nav aria-label="面包屑" className="mb-2 flex flex-wrap items-center gap-1 text-xs text-text-muted">
              {crumbs.map((crumb, index) => (
                <span key={index} className="inline-flex items-center gap-1">
                  {crumb.to
                    ? <Link to={crumb.to} params={crumb.params as never} className="hover:text-text-strong">{crumb.label}</Link>
                    : <span>{crumb.label}</span>}
                  <ChevronRight className="size-3 text-text-faint" />
                </span>
              ))}
            </nav>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2">
            <h1 title={typeof title === "string" ? title : undefined} className={cn("max-w-full truncate font-semibold tracking-tight text-text-strong", compact ? "text-base" : "text-xl sm:text-2xl")}>{title}</h1>
            {meta}
          </div>
          {description && <p className="mt-2 max-w-3xl text-sm leading-relaxed text-text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function Page({ children, narrow = false }: { children: ReactNode; narrow?: boolean }) {
  return <div className={cn("mx-auto w-full px-4 pb-10 sm:px-6", narrow ? "max-w-[1120px]" : "max-w-[1600px]")}>{children}</div>;
}
