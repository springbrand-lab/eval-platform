import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { click, render } from "@/test/render";
import { inputLimits } from "@/test/input-limits";
import { BundleDetailPage } from "./bundle-detail-page";

const removals = vi.hoisted(() => ({ bundle: vi.fn(async () => {}), resource: vi.fn(async () => {}) }));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("@/api-sdk/input-limits-api", async (original) => ({ ...await original<object>(), getInputLimits: async () => inputLimits }));
vi.mock("@/api-sdk/bundles-api", async (original) => {
  const real = await original<typeof import("@/api-sdk/bundles-api")>();
  return { ...real, resourceCatalog: (kind: "material" | "session") => ({
    ...real.resourceCatalog(kind),
    get: async () => ({ bundleId: "bundle", name: "资源包", description: "说明" }),
    delete: removals.bundle,
    deleteResource: removals.resource,
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
    const label = kind === "material" ? "素材" : "对话";
    await click([...view.container.querySelectorAll("button")].find((button) => button.textContent === `新建${label}`));
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
    if (kind === "session") expect(document.querySelector("textarea")).not.toBeNull();
  } finally { await view.unmount(); client.clear(); }
});

it.each([
  ["material", "resource"], ["session", "resource"], ["material", "bundle"], ["session", "bundle"],
] as const)("%s %s deletion confirms retained references without requiring unbinding", async (kind, target) => {
  removals.bundle.mockClear();
  removals.resource.mockClear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={client}><BundleDetailPage kind={kind} bundleId="bundle" /></QueryClientProvider></TooltipProvider>);
  try {
    await vi.waitFor(() => expect(view.container.querySelector("tbody tr")).not.toBeNull());
    if (target === "bundle") {
      await act(async () => {
        view.container.querySelector('button[aria-label="更多操作"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await click([...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === "删除包"));
    } else {
      await click([...view.container.querySelectorAll("tbody button")].find((button) => button.textContent === "删除"));
    }
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("已绑定的用例和已有项目仍可读取");
    expect(dialog.textContent).not.toContain("解除绑定");
    expect(removals.bundle).not.toHaveBeenCalled();
    expect(removals.resource).not.toHaveBeenCalled();
    await click([...dialog.querySelectorAll("button")].find((button) => button.textContent === "删除"));
    await vi.waitFor(() => {
      if (target === "bundle") expect(removals.bundle).toHaveBeenCalledWith("bundle");
      else expect(removals.resource).toHaveBeenCalledWith("bundle", kind);
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    });
  } finally { await view.unmount(); client.clear(); }
});
