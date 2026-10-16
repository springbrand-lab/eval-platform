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
export function PageHeader({ title, description, crumbs, actions, meta, flush }: {
  title: ReactNode; description?: ReactNode; crumbs?: readonly Crumb[]; actions?: ReactNode; meta?: ReactNode;
  /** No gap below: the content starts right under the bar (full-bleed views). */
  flush?: boolean;
}) {
  useEffect(() => {
    if (typeof title === "string") document.title = `${title} · Eval`;
  }, [title]);
  return (
    <header className={cn("sticky top-0 z-20 -mx-6 border-b border-border bg-bg/90 px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-bg/75", !flush && "mb-5")}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          {crumbs && crumbs.length > 0 && (
            <nav aria-label="面包屑" className="mb-0.5 flex flex-wrap items-center gap-1 text-xs text-text-muted">
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
          <div className="flex min-w-0 items-center gap-2.5">
            <h1 className="truncate text-lg font-semibold tracking-tight text-text-strong">{title}</h1>
            {meta}
          </div>
          {description && <p className="mt-0.5 max-w-3xl text-[13px] text-text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1600px] px-6 pb-10">{children}</div>;
}
