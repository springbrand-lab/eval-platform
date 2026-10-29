import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Bot, ChartNoAxesColumn, Coins, Database, FolderArchive, FileJson2, MessagesSquare, FlaskConical, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Sun,
} from "lucide-react";
import { useState, type ComponentType } from "react";
import { isEmbedded } from "@/auth/session";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { readThemePreference, saveThemePreference, type ThemePreference } from "@/lib/theme";

interface NavItem { to: string; label: string; icon: ComponentType<{ className?: string }>; paths?: readonly string[] }

export const NAV_GROUPS: readonly { label: string; items: readonly NavItem[] }[] = [
  {
    label: "工作空间",
    items: [
      { to: "/dashboard", label: "数据看板", icon: ChartNoAxesColumn },
      { to: "/projects", label: "项目管理", icon: FlaskConical },
      { to: "/datasets", label: "数据集", icon: Database, paths: ["/data"] },
      { to: "/agents", label: "Agent 管理", icon: Bot },
    ],
  },
  { label: "资源", items: [
    { to: "/resources/material", label: "输入素材", icon: FolderArchive },
    { to: "/resources/session", label: "初始对话", icon: MessagesSquare },
    { to: "/output-schemas", label: "评估结果格式", icon: FileJson2 },
  ] },
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
      <aside className={cn("flex shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-150", collapsed ? "w-14" : "w-14 md:w-56")}>
        <div className={cn("flex h-14 items-center gap-2 px-3", collapsed && "justify-center px-0")}>
          {!collapsed && (
            <span className="hidden min-w-0 items-center gap-2.5 pl-1 text-base font-semibold tracking-tight text-text-strong md:flex">
              <img src="/favicon.svg" alt="" className="size-5" />
              {embedded ? "Eval" : "Eval 评测"}
            </span>
          )}
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "展开导航" : "收起导航"}
            className={cn("rounded-md p-1.5 text-text-muted hover:bg-surface-muted hover:text-text-strong", !collapsed && "md:ml-auto")}
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          </button>
        </div>
        <nav aria-label="主导航" className="flex-1 overflow-y-auto px-2 pb-3">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mt-3 first:mt-1">
              {!collapsed && <p className="mb-2 hidden px-2 text-xs font-medium text-text-faint md:block">{group.label}</p>}
              {group.items.map((item) => {
                const active = [item.to, ...item.paths ?? []].some((path) => pathname === path || pathname.startsWith(`${path}/`));
                const Icon = item.icon;
                return (
                  <Tooltip key={item.to} content={item.label} side="right">
                  <Link
                    to={item.to}
                    aria-label={item.label}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "mb-1 flex h-10 items-center gap-2.5 rounded-lg px-2 text-sm transition-colors",
                      active ? "bg-surface-muted font-semibold text-text-strong ring-1 ring-border" : "text-text-secondary hover:bg-surface-muted/70 hover:text-text-strong",
                      collapsed && "justify-center px-0",
                      !collapsed && "justify-center md:justify-start",
                    )}
                  >
                    <Icon className={cn("size-4 shrink-0", active ? "text-text-strong" : "text-text-muted")} />
                    {!collapsed && <span className="hidden md:inline">{item.label}</span>}
                  </Link>
                  </Tooltip>
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
            <div role="radiogroup" aria-label="主题" className="grid grid-cols-1 rounded-md bg-surface-muted p-0.5 md:grid-cols-3">
              {THEMES.map((item) => {
                const Icon = item.icon;
                return (
                  <Tooltip key={item.value} content={item.label}>
                  <button
                    type="button"
                    role="radio"
                    aria-label={item.label}
                    aria-checked={theme === item.value}
                    onClick={() => choose(item.value)}
                    className={cn(
                      "flex h-8 items-center justify-center rounded-[5px] transition-colors",
                      theme === item.value ? "bg-surface text-text-strong shadow-sm" : "text-text-muted hover:text-text-strong",
                    )}
                  >
                    <Icon className="size-3.5" />
                  </button>
                  </Tooltip>
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
