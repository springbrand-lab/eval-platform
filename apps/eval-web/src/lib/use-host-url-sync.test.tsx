import { act } from "react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, notFound, Outlet, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "@/test/render";

beforeEach(() => { vi.stubGlobal("scrollTo", vi.fn()); });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete (window as unknown as Record<string, unknown>).__POWERED_BY_WUJIE__;
  delete (window as unknown as Record<string, unknown>).$wujie;
});

/** Eval inside the main App: the hook in a root route like Eval's, at `path`. */
async function hostedEval(path: string) {
  const reported: string[] = [];
  const handlers = new Map<string, (path: string) => void>();
  Object.assign(window, {
    __POWERED_BY_WUJIE__: true,
    $wujie: {
      props: { theme: () => "light", accessToken: async () => null, navigate: (next: string) => reported.push(next), openCommandMenu: () => undefined },
      bus: { $on: (event: string, fn: (path: string) => void) => handlers.set(event, fn), $off: (event: string) => handlers.delete(event) },
    },
  });
  const { useHostUrlSync } = await import("./use-host-url-sync");
  const root = createRootRoute({
    component: function Root() { useHostUrlSync(); return <Outlet />; },
    notFoundComponent: () => <p>页面不存在</p>,
  });
  const projects = createRoute({ getParentRoute: () => root, path: "/projects", component: () => <p>projects</p> });
  const project = createRoute({
    getParentRoute: () => root,
    path: "/projects/$projectId",
    loader: ({ params }) => { if (params.projectId === "gone") throw notFound(); },
    component: () => <p>project</p>,
  });
  const router = createRouter({ routeTree: root.addChildren([projects, project]), history: createMemoryHistory({ initialEntries: [path] }) });
  const view = await render(<RouterProvider router={router} />);
  await act(async () => { await router.load(); });
  /** The main App moves Eval, as a menu click does. */
  const hostMoves = async (next: string) => {
    const go = handlers.get("springbrand:navigate:eval");
    if (!go) throw new Error("Eval is not listening to the main App");
    await act(async () => { go(next); await router.load(); });
  };
  return { router, view, reported, hostMoves };
}

it("reports the pages Eval shows, never a path that leads nowhere, and still follows the main App from there", async () => {
  const { router, view, reported, hostMoves } = await hostedEval("/projects");
  expect(reported).toEqual(["/projects"]);

  await hostMoves("/objects/companies");
  expect(view.container.textContent).toBe("页面不存在");
  await hostMoves("/projects/gone");
  expect(view.container.textContent).toBe("页面不存在");
  expect(reported).toEqual(["/projects"]);

  await hostMoves("/projects/a");
  expect(router.state.location.pathname).toBe("/projects/a");
  expect(view.container.textContent).toBe("project");
  expect(reported).toEqual(["/projects", "/projects/a"]);
  await view.unmount();
});

it("does not report a not-found page Eval was opened at", async () => {
  const { view, reported, hostMoves } = await hostedEval("/objects/companies");
  expect(view.container.textContent).toBe("页面不存在");
  expect(reported).toEqual([]);
  await hostMoves("/projects");
  expect(reported).toEqual(["/projects"]);
  await view.unmount();
});
