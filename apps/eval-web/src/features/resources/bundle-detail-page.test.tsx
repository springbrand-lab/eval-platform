import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { click, render } from "@/test/render";
import { inputLimits } from "@/test/input-limits";
import { BundleDetailPage } from "./bundle-detail-page";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("@/api-sdk/input-limits-api", async (original) => ({ ...await original<object>(), getInputLimits: async () => inputLimits }));
vi.mock("@/api-sdk/bundles-api", async (original) => {
  const real = await original<typeof import("@/api-sdk/bundles-api")>();
  return { ...real, resourceCatalog: (kind: "material" | "session") => ({
    ...real.resourceCatalog(kind),
    get: async () => ({ bundleId: "bundle", name: "资源包", description: "说明" }),
    listResources: async () => [{ name: "资源条目", description: "说明",
      ...(kind === "material" ? { materialId: "material" } : { sessionId: "session", format: "jsonl" }) }],
  }) };
});

it.each(["material", "session"] as const)("%s offers creation inside a Bundle and only contexts expose editing", async (kind) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={client}><BundleDetailPage kind={kind} bundleId="bundle" /></QueryClientProvider></TooltipProvider>);
  try {
    await vi.waitFor(() => expect(view.container.querySelector("tbody tr")).not.toBeNull());
    const edits = [...view.container.querySelectorAll("tbody button")].filter((button) => button.textContent === "编辑名称与说明");
    expect(edits).toHaveLength(kind === "session" ? 1 : 0);
    const label = kind === "material" ? "素材" : "上下文";
    await click([...view.container.querySelectorAll("button")].find((button) => button.textContent === `新建${label}`));
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
    if (kind === "session") expect(document.querySelector("textarea")).not.toBeNull();
  } finally { await view.unmount(); client.clear(); }
});
