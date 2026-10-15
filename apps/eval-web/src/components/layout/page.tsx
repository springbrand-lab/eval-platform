import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useEffect, type ReactNode } from "react";

export interface Crumb {
  label: string;
  to?: string;
  params?: Record<string, string>;
}

export function PageHeader({ title, description, crumbs, actions }: {
  title: ReactNode; description?: ReactNode; crumbs?: readonly Crumb[]; actions?: ReactNode;
}) {
  useEffect(() => {
    if (typeof title === "string") document.title = `${title} · Eval`;
  }, [title]);
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {crumbs && crumbs.length > 0 && (
          <nav aria-label="面包屑" className="mb-1.5 flex flex-wrap items-center gap-1 text-xs text-text-muted">
            {crumbs.map((crumb, index) => (
              <span key={index} className="inline-flex items-center gap-1">
                {crumb.to
                  ? <Link to={crumb.to} params={crumb.params as never} className="hover:text-text">{crumb.label}</Link>
                  : <span>{crumb.label}</span>}
                {index < crumbs.length - 1 && <ChevronRight className="size-3" />}
              </span>
            ))}
          </nav>
        )}
        <h1 className="truncate text-xl font-semibold text-text">{title}</h1>
        {description && <p className="mt-1 text-sm text-text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1440px] px-6 py-6">{children}</div>;
}
