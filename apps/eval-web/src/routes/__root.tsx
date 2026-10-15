import type { QueryClient } from "@tanstack/react-query";
import { Link, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { EmptyState } from "@/components/ui/feedback";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDarkMode } from "@/lib/use-dark";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: function Root() {
    const dark = useDarkMode();
    return (
      <TooltipProvider delayDuration={300}>
        <Outlet />
        <Toaster position="top-center" richColors closeButton theme={dark ? "dark" : "light"} />
      </TooltipProvider>
    );
  },
  notFoundComponent: () => (
    <EmptyState title="页面不存在" action={<Link to="/projects" className="text-sm link font-semibold">返回 Project 列表</Link>} />
  ),
});
