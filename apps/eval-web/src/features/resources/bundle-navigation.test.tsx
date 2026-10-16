import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetAuthForTest } from "@/auth/session";
import { routeTree } from "@/routeTree.gen";
import { click, render } from "@/test/render";
import { inputLimits } from "@/test/input-limits";
import { resourceCatalog } from "@/api-sdk/bundles-api";
import { ResourcePicker } from "./resource-picker";

const transport = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/api-sdk/client", async (original) => ({ ...await original<object>(), api: transport }));

beforeEach(() => {
  resetAuthForTest({ status: "ready", token: "test-token" });
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  transport.get.mockReset();
});
afterEach(() => { resetAuthForTest(); vi.unstubAllGlobals(); });

it.each([
  ["material", false], ["material", true], ["session", false], ["session", true],
] as const)("opens a %s Bundle from its catalog (resource picker cache: %s)", async (kind, fromPicker) => {
  const bundleId = "11111111-1111-4111-8111-111111111111";
  const resourceId = "22222222-2222-4222-8222-222222222222";
  const name = kind === "material" ? "联调示例 · 初始素材" : "联调示例 · 初始上下文";
  const resourceName = kind === "material" ? "页面参考素材" : "页面需求上下文（原生消息）";
  const bundle = { bundleId, name, description: "说明" };
  const record = { bundleId, name: resourceName, description: "资源说明", ...(kind === "material"
    ? { materialId: resourceId, byteSize: 123 } : { sessionId: resourceId, format: "json" }) };
  const base = `/api/${kind}-bundles`;
  const segment = kind === "material" ? "materials" : "sessions";
  transport.get.mockImplementation(async (path: string) => {
    if (path === "/api/input-limits") return inputLimits;
    if (path === base) return [bundle];
    if (path === `${base}/${bundleId}`) return bundle;
    if (path === `${base}/${bundleId}/${segment}`) return [record];
    throw new Error(`Unexpected GET ${path}`);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 10_000 } } });
  const showPicker = async () => {
    const picker = await render(<QueryClientProvider client={queryClient}>
      <ResourcePicker kind={kind} label="初始资源" value={{ bundleId, id: resourceId }} onChange={vi.fn()} />
    </QueryClientProvider>);
    try {
      await vi.waitFor(() => {
        const option = picker.container.querySelector(`select[aria-label="初始资源"] option[value="${resourceId}"]`);
        expect(option?.textContent).toBe(`${resourceName} · 资源说明`);
      });
    } finally { await picker.unmount(); }
  };
  try {
    if (fromPicker) await showPicker();
    const router = createRouter({ routeTree, context: { queryClient }, defaultPendingMs: 0, defaultPendingMinMs: 0,
      history: createMemoryHistory({ initialEntries: [`/resources/${kind}`] }) });
    const view = await render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    try {
      await vi.waitFor(() => expect(view.container.querySelector("tbody tr")?.textContent ?? "").toContain(name), { timeout: 5_000 });
      await click(view.container.querySelector("tbody tr"));
      await vi.waitFor(() => {
        expect(view.container.textContent).not.toContain("Something went wrong!");
        expect(view.container.querySelector("h1")?.textContent).toBe(name);
        expect(view.container.querySelector("tbody tr")?.textContent).toContain(resourceName);
        expect(view.container.querySelector("tbody tr")?.textContent).toContain("资源说明");
      });
      expect(router.state.location.pathname).toBe(`/resources/${kind}/${bundleId}`);
      expect(queryClient.getQueryData(resourceCatalog(kind).keys.resources(bundleId))).toEqual([record]);
    } finally { await view.unmount(); }
    await showPicker();
    expect(queryClient.getQueryData(resourceCatalog(kind).keys.resources(bundleId))).toEqual([record]);
  } finally { queryClient.clear(); }
});
