import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Bot, Coins, Database, FileJson2, FlaskConical, FolderArchive, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Sun,
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

const THEMES: readonly { value: ThemePreference; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
];

export function AppShell() {
  const embedded = isEmbedded();
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const choose = (next: ThemePreference) => {
    setTheme(next);
    saveThemePreference(next);
  };

  return (
    <div className="flex h-full bg-bg">
      <aside className={cn("flex shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-150", collapsed ? "w-14" : "w-56")}>
        <div className={cn("flex h-14 items-center gap-2 px-3", collapsed && "justify-center px-0")}>
          {!collapsed && (
            <span className="flex min-w-0 items-center gap-2 pl-1 text-sm font-semibold text-text-strong">
              <img src="/favicon.svg" alt="" className="size-5" />
              {embedded ? "Eval" : "Eval 评测"}
            </span>
          )}
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "展开导航" : "收起导航"}
            className={cn("rounded-md p-1.5 text-text-muted hover:bg-surface-muted hover:text-text-strong", !collapsed && "ml-auto")}
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          </button>
        </div>
        <nav aria-label="主导航" className="flex-1 overflow-y-auto px-2 pb-3">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mt-3 first:mt-1">
              {!collapsed && <p className="mb-1 px-2 text-[11px] font-semibold text-text-faint">{group.label}</p>}
              {group.items.map((item) => {
                const active = pathname === item.to || pathname.startsWith(`${item.to}/`);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    title={collapsed ? item.label : undefined}
                    className={cn(
                      "mb-px flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors",
                      active ? "bg-surface-muted font-semibold text-text-strong" : "text-text-secondary hover:bg-surface-muted/70 hover:text-text-strong",
                      collapsed && "justify-center px-0",
                    )}
                  >
                    <Icon className={cn("size-4 shrink-0", active ? "text-text-strong" : "text-text-muted")} />
                    {!collapsed && item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="border-t border-border p-2">
          {collapsed ? (
            <button
              type="button"
              title="切换主题"
              onClick={() => choose(theme === "dark" ? "light" : "dark")}
              className="flex h-8 w-full items-center justify-center rounded-md text-text-muted hover:bg-surface-muted hover:text-text-strong"
            >
              {theme === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}
            </button>
          ) : (
            <div role="radiogroup" aria-label="主题" className="flex rounded-md bg-surface-muted p-0.5">
              {THEMES.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.value}
                    type="button"
                    role="radio"
                    aria-checked={theme === item.value}
                    title={item.label}
                    onClick={() => choose(item.value)}
                    className={cn(
                      "flex h-7 flex-1 items-center justify-center rounded-[5px] transition-colors",
                      theme === item.value ? "bg-surface text-text-strong shadow-sm" : "text-text-muted hover:text-text-strong",
                    )}
                  >
                    <Icon className="size-3.5" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
