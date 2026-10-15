import type { QueryClient } from "@tanstack/react-query";
import { Link, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { EmptyState } from "@/components/ui/feedback";
import { useDarkMode } from "@/lib/use-dark";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: function Root() {
    const dark = useDarkMode();
    return (
      <>
        <Outlet />
        <Toaster position="top-center" richColors closeButton theme={dark ? "dark" : "light"} />
      </>
    );
  },
  notFoundComponent: () => (
    <EmptyState title="页面不存在" action={<Link to="/projects" className="text-sm font-semibold text-link hover:underline">返回 Project 列表</Link>} />
  ),
});
