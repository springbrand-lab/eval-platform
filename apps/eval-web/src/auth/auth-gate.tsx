import { ExternalLink, Lock, LogIn } from "lucide-react";
import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/feedback";
import { requestToken, TAKT_ORIGIN } from "./session";
import { useAuth } from "./use-auth";

function Message({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-[var(--radius-card)] border border-border bg-surface p-8 text-center">
        <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-accent-soft text-link">{icon}</div>
        <h1 className="text-base font-semibold">{title}</h1>
        <div className="mt-2 text-sm text-text-muted">{children}</div>
      </div>
    </div>
  );
}

/** Renders children only with a takt token; otherwise explains what the user must do. */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  switch (auth.status) {
    case "ready":
      return <>{children}</>;
    case "waiting":
      return <div className="flex h-full items-center justify-center gap-2 text-sm text-text-muted"><Spinner />正在从 takt 获取登录信息…</div>;
    case "standalone":
      return (
        <Message icon={<ExternalLink className="size-5" />} title="请从 takt 打开 Eval">
          Eval 与 takt 共用登录，需要在 takt 中打开。
          <a href={`${TAKT_ORIGIN}/dashboard/eval`} className="mt-3 block font-semibold text-link hover:underline">前往 takt 的 Eval 页面</a>
        </Message>
      );
    case "unauthorized":
      return (
        <Message icon={<LogIn className="size-5" />} title="登录已失效">
          请在 takt 中重新登录后再打开 Eval。
          <button type="button" onClick={() => requestToken()} className="mt-3 block w-full font-semibold text-link hover:underline">已重新登录，重试</button>
        </Message>
      );
    case "forbidden":
      return (
        <Message icon={<Lock className="size-5" />} title="没有 Eval 访问权限">
          请联系管理员在 takt 的权限管理中为你开通 Eval 菜单。
        </Message>
      );
  }
}
