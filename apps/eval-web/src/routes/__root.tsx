import type { QueryClient } from "@tanstack/react-query";
import { Link, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { EmptyState } from "@/components/ui/feedback";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => (
    <>
      <Outlet />
      <Toaster position="top-center" richColors closeButton />
    </>
  ),
  notFoundComponent: () => (
    <EmptyState title="页面不存在" action={<Link to="/projects" className="text-sm font-medium text-primary hover:underline">返回 Project 列表</Link>} />
  ),
});
