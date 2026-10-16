import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { inputLimits } from "@/test/input-limits";
import { click, render } from "@/test/render";
import type { ResourceKind } from "@/api-sdk/bundles-api";
import { BundleDetailPage } from "./bundle-detail-page";
import { ResourceDetailPage } from "./resource-detail-page";

const requests = vi.hoisted(() => ({ get: vi.fn(), listResources: vi.fn(), getResource: vi.fn(), listFiles: vi.fn(), getFile: vi.fn() }));
vi.mock("@/api-sdk/bundles-api", async (original) => {
  const actual = await original<typeof import("@/api-sdk/bundles-api")>();
  const catalogs = { material: { ...actual.materialBundles, ...requests }, session: { ...actual.sessionBundles, ...requests } };
  return { ...actual, resourceCatalog: (kind: ResourceKind) => catalogs[kind] };
});
vi.mock("@/api-sdk/input-limits-api", async (original) => ({ ...await original<object>(), getInputLimits: async () => inputLimits }));
const urls = { create: vi.fn(), revoke: vi.fn() };
beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  Object.values(requests).forEach((fn) => fn.mockReset());
  urls.create.mockReset().mockImplementation(() => `blob:resource-${urls.create.mock.calls.length}`); urls.revoke.mockReset();
  vi.stubGlobal("URL", class extends URL { static createObjectURL = urls.create; static revokeObjectURL = urls.revoke; });
  requests.get.mockResolvedValue({ bundleId: "bundle", name: "资源包", description: "说明" });
});
afterEach(() => vi.unstubAllGlobals());
const button = (name: string) => [...document.querySelectorAll("button")].find((element) => element.textContent === name)!;
const blob = (content: string, type = "text/plain") => {
  const value = new Blob([content], { type });
  Object.defineProperty(value, "arrayBuffer", { value: async () => new TextEncoder().encode(content).buffer });
  return value;
};

async function mount(kind: ResourceKind) {
  const root = createRootRoute({ component: Outlet });
  const list = createRoute({ getParentRoute: () => root, path: "/resources/$kind/$bundleId/", component: () => <BundleDetailPage kind={kind} bundleId="bundle" /> });
  const detail = createRoute({ getParentRoute: () => root, path: "/resources/$kind/$bundleId/$resourceId", component: () => {
    const { resourceId, bundleId } = detail.useParams();
    return <ResourceDetailPage key={`${kind}:${bundleId}:${resourceId}`} kind={kind} bundleId={bundleId} resourceId={resourceId} />;
  } });
  const router = createRouter({ routeTree: root.addChildren([list, detail]), history: createMemoryHistory({ initialEntries: [`/resources/${kind}/bundle`] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></TooltipProvider>);
  return { router, ...view, cleanup: async () => { await view.unmount(); client.clear(); } };
}

it.each(["material", "session"] as const)("%s name opens the detail route; only context metadata is editable", async (kind) => {
  const record = { bundleId: "bundle", name: kind === "material" ? "参考素材" : "初始对话", description: "说明",
    ...(kind === "material" ? { materialId: "resource", byteSize: 4 } : { sessionId: "resource", format: "json" }) };
  const path = kind === "material" ? "/docs/readme.txt" : "/context.json";
  const content = kind === "material" ? "素材内部内容" : '{"entries":[]}';
  requests.listResources.mockResolvedValue([record]); requests.getResource.mockResolvedValue(record);
  requests.listFiles.mockResolvedValue([{ path, mediaType: kind === "material" ? "text/plain" : "application/json", byteSize: content.length }]);
  requests.getFile.mockResolvedValue(blob(content));
  const view = await mount(kind);
  try {
    await vi.waitFor(() => expect(document.querySelector(`a[href="/resources/${kind}/bundle/resource"]`)).not.toBeNull());
    const edit = [...document.querySelectorAll("tbody button")].find((item) => item.textContent === "编辑名称与说明");
    if (kind === "session") {
      await click(edit);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(view.router.state.location.pathname).toBe(`/resources/${kind}/bundle`);
      expect(requests.listFiles).not.toHaveBeenCalled();
      await click(button("取消"));
    } else expect(edit).toBeUndefined();
    await click(document.querySelector(`a[href="/resources/${kind}/bundle/resource"]`));
    await vi.waitFor(() => expect(view.router.state.location.pathname).toBe(`/resources/${kind}/bundle/resource`));
    await vi.waitFor(() => expect(document.querySelector('nav[aria-label$="目录"]')).not.toBeNull());
    await vi.waitFor(() => expect(button("Source")).toBeDefined());
    await click(button("Source"));
    expect(document.querySelector("pre")?.textContent).toBe(content);
    expect(requests.getFile).toHaveBeenCalledWith("bundle", "resource", path, expect.any(AbortSignal));
    expect(document.querySelector("a[download]")?.getAttribute("download")).toBe(path.split("/").at(-1));
    expect(document.querySelector("a[download] button")).toBeNull();
  } finally { await view.cleanup(); }
  expect(urls.revoke).toHaveBeenCalledWith("blob:resource-1");
});

it("cancels an unfinished file read on selection change and ignores its late result", async () => {
  const record = { bundleId: "bundle", materialId: "resource", name: "资源", description: "目录", byteSize: 6 };
  requests.listResources.mockResolvedValue([record]); requests.getResource.mockResolvedValue(record);
  requests.listFiles.mockResolvedValue(["/nested/slow.txt", "/fast.txt"].map((path) => ({ path, mediaType: "text/plain", byteSize: 3 })));
  let finish!: (value: Blob) => void;
  const pending = new Promise<Blob>((resolve) => { finish = resolve; });
  requests.getFile.mockImplementation((_bundle, _resource, path) => path === "/nested/slow.txt" ? pending : Promise.resolve(blob("LATEST")));
  const view = await mount("material");
  try {
    await vi.waitFor(() => expect(document.querySelector('a[href="/resources/material/bundle/resource"]')).not.toBeNull());
    await click(document.querySelector('a[href="/resources/material/bundle/resource"]'));
    await vi.waitFor(() => expect(button("slow.txt")).toBeDefined());
    await click(button("slow.txt"));
    await vi.waitFor(() => expect(requests.getFile).toHaveBeenCalledTimes(1));
    const signal = requests.getFile.mock.calls[0][3] as AbortSignal;
    await click(button("fast.txt"));
    expect(signal.aborted).toBe(true);
    await vi.waitFor(() => expect(document.querySelector("pre")?.textContent).toBe("LATEST"));
    await act(async () => finish(blob("STALE")));
    expect(document.querySelector("pre")?.textContent).toBe("LATEST");
    expect(document.querySelector("a[download]")?.getAttribute("download")).toBe("fast.txt");
  } finally { await view.cleanup(); }
});
