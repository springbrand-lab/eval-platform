import { useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { hosted, onHostNavigate, reportPath } from "@/lib/host";

/**
 * Inside the main App: Eval's URL and the main App's follow each other. Used by the root route, so
 * Eval keeps listening on every page it can show, the not-found page included: the main App keeps
 * Eval alive between visits and must always be able to move it back.
 */
export function useHostUrlSync() {
  const router = useRouter();
  const href = useRouterState({ select: (state) => state.location.href });
  useEffect(() => { if (hosted) reportPath(href); }, [href]);
  useEffect(() => (hosted ? onHostNavigate((path) => void router.history.replace(path)) : undefined), [router]);
}
