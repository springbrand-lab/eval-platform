import { isNotFound, rootRouteId, useRouter, useRouterState, type AnyRouteMatch } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { hosted, onHostNavigate, reportPath } from "@/lib/host";

/** A not-found page: no route below the root matched the path, or a route's loader threw `notFound()`. */
function showsNotFound(matches: readonly AnyRouteMatch[]): boolean {
  return matches.at(-1)?.routeId === rootRouteId || matches.some((match) => match.status === "notFound" || isNotFound(match.error));
}

/**
 * Inside the main App: Eval's URL and the main App's follow each other. Used by the root route, so
 * Eval keeps listening on every page it can show, the not-found page included: the main App keeps
 * Eval alive between visits and must always be able to move it back.
 *
 * Only pages Eval can show are reported, once loaded: the main App puts the path in its own URL and
 * loads Eval there again after a reload, so a path that leads nowhere must stay out of it.
 */
export function useHostUrlSync() {
  const router = useRouter();
  const shown = useRouterState({
    select: (state) => (state.status === "idle" && !showsNotFound(state.matches) ? state.location.href : null),
  });
  // `shown` is null while a page loads; reloading the same page reports nothing new.
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!hosted || shown === null || shown === reported.current) return;
    reported.current = shown;
    reportPath(shown);
  }, [shown]);
  useEffect(() => (hosted ? onHostNavigate((path) => void router.history.replace(path)) : undefined), [router]);
}
