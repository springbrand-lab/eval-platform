import { useQuery } from "@tanstack/react-query";
import { Lock, LogIn, UserX } from "lucide-react";
import type { ReactNode } from "react";
import { api } from "@/api-sdk/client";
import { Spinner } from "@/components/ui/feedback";
import { expectedPrincipalId, signIn, signOutAndIn } from "./session";
import { useAuth } from "./use-auth";

function Message({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-[var(--radius-card)] border border-border bg-surface p-8 text-center">
        <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-accent-soft link">{icon}</div>
        <h1 className="text-base font-semibold">{title}</h1>
        <div className="mt-2 text-sm text-text-muted">{children}</div>
      </div>
    </div>
  );
}

const FAILURES: Readonly<Record<string, string>> = {
  not_permitted: "你还没有 Eval 的使用权限，请联系管理员在权限管理中开通。",
  access_denied: "你不在本公司的组织里，或账号已停用。",
  expired: "登录已过期，请重新登录。",
  iam_unavailable: "登录服务暂时不可用，请稍后再试。",
};

/** When takt says who should be here, Eval shows its data only to that same person. */
function SamePerson({ expected, children }: { expected: string; children: ReactNode }) {
  const me = useQuery({ queryKey: ["auth", "me"], queryFn: ({ signal }) => api.get<{ id: string; name: string }>("/api/auth/me", { signal }) });
  if (me.isPending) return <div className="flex h-full items-center justify-center gap-2 text-sm text-text-muted"><Spinner />正在确认登录账号…</div>;
  if (me.isError) return <>{children}</>;
  if (me.data.id === expected) return <>{children}</>;
  return (
    <Message icon={<UserX className="size-5" />} title="登录账号和 takt 不一致">
      Eval 当前登录的是「{me.data.name}」，和 takt 里的账号不是同一个人。请在同一个账号下使用；需要切换时，先在 IAM 换成正确的账号再重新登录。
      <button type="button" onClick={() => void signOutAndIn()} className="mt-3 block w-full link font-semibold">退出 Eval 并重新登录</button>
    </Message>
  );
}

/** Renders children while signed in; otherwise explains what the user must do. */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  switch (auth.status) {
    case "ready":
      return expectedPrincipalId ? <SamePerson expected={expectedPrincipalId}>{children}</SamePerson> : <>{children}</>;
    case "signing-in":
      return <div className="flex h-full items-center justify-center gap-2 text-sm text-text-muted"><Spinner />正在跳转到登录…</div>;
    case "failed":
      return (
        <Message icon={<LogIn className="size-5" />} title="登录没有成功">
          {FAILURES[auth.reason] ?? "登录没有完成，请重试。"}
          <button type="button" onClick={() => signIn()} className="mt-3 block w-full link font-semibold">重新登录</button>
        </Message>
      );
    case "forbidden":
      return (
        <Message icon={<Lock className="size-5" />} title="没有 Eval 访问权限">
          请联系管理员在权限管理中为你开通 Eval。
        </Message>
      );
  }
}
