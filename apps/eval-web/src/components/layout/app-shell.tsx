import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Bot, Coins, Database, FileJson2, FlaskConical, FolderArchive, Moon, PanelLeftClose, PanelLeftOpen, Sun,
} from "lucide-react";
import { useState, type ComponentType } from "react";
import { isEmbedded } from "@/auth/session";
import { cn } from "@/lib/cn";
import { readThemePreference, saveThemePreference, type ThemePreference } from "@/lib/theme";

interface NavItem { to: string; label: string; icon: ComponentType<{ className?: string }> }

export const NAV_GROUPS: readonly { label: string; items: readonly NavItem[] }[] = [
  { label: "评测", items: [{ to: "/projects", label: "Project", icon: FlaskConical }] },
  {
    label: "数据",
    items: [
      { to: "/datasets", label: "测试集", icon: Database },
      { to: "/resources", label: "初始资源", icon: FolderArchive },
      { to: "/output-schemas", label: "评分格式", icon: FileJson2 },
    ],
  },
  { label: "配置", items: [{ to: "/agents", label: "Agent", icon: Bot }] },
  { label: "账户", items: [{ to: "/credits", label: "积分", icon: Coins }] },
];

const NEXT_THEME: Record<ThemePreference, ThemePreference> = { system: "light", light: "dark", dark: "system" };
const THEME_LABEL: Record<ThemePreference, string> = { system: "跟随系统", light: "浅色", dark: "深色" };

export function AppShell() {
  const embedded = isEmbedded();
  const [collapsed, setCollapsed] = useState(embedded);
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <div className="flex h-full">
      <aside
        className={cn(
          "flex shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-150",
          collapsed ? "w-16" : "w-[220px]",
        )}
      >
        <div className={cn("flex h-14 items-center border-b border-border px-4", collapsed && "justify-center px-0")}>
          {!embedded && !collapsed && (
            <span className="flex items-center gap-2 text-[15px] font-semibold">
              <img src="/favicon.svg" alt="" className="size-6" />
              Eval 评测
            </span>
          )}
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "展开导航" : "收起导航"}
            className={cn("rounded p-1.5 text-text-muted hover:bg-surface-muted", !collapsed && "ml-auto")}
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          </button>
        </div>
        <nav aria-label="主导航" className="flex-1 overflow-y-auto px-2 py-3">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mb-4">
              {!collapsed && <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">{group.label}</p>}
              {group.items.map((item) => {
                const active = pathname === item.to || pathname.startsWith(`${item.to}/`);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    title={collapsed ? item.label : undefined}
                    className={cn(
                      "mb-0.5 flex h-9 items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 text-sm",
                      active ? "bg-primary-soft font-medium text-primary" : "text-text-muted hover:bg-surface-muted hover:text-text",
                      collapsed && "justify-center px-0",
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    {!collapsed && item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={() => {
              const next = NEXT_THEME[theme];
              setTheme(next);
              saveThemePreference(next);
            }}
            className={cn("flex h-9 w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 text-sm text-text-muted hover:bg-surface-muted", collapsed && "justify-center px-0")}
            title={`主题：${THEME_LABEL[theme]}`}
          >
            {theme === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}
            {!collapsed && `主题：${THEME_LABEL[theme]}`}
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
