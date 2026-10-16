import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { click, render } from "@/test/render";
import { AttachDataDialog } from "./attach-data-dialog";
const state = vi.hoisted(() => ({ attach: vi.fn(), failure: false }));
vi.mock("@/api-sdk/datasets-api", async (original) => ({ ...await original<object>(),
  attachData: state.attach,
  listDatasets: async () => [{ datasetId: "target", name: "Target" }, { datasetId: "other", name: "Other" }],
  listDatasetData: async (id: string) => { if (state.failure) throw new Error("membership unavailable"); return [{ dataId: id === "target" ? "attached" : "shared", userPrompt: "task" }]; },
}));
vi.mock("@/api-sdk/data-api", async (original) => ({ ...await original<object>(), listData: async () => ["attached", "shared", "orphan"].map((id) => ({ dataId: id, name: id, userPrompt: "task" })) }));
beforeEach(() => { state.attach.mockReset(); state.attach.mockResolvedValue(undefined); state.failure = false; });
async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={client}><AttachDataDialog datasetId="target" onClose={vi.fn()} /></QueryClientProvider></TooltipProvider>);
  return { client, close: async () => { await view.unmount(); client.clear(); } };
}
it("finds orphaned cases and adds selected existing identities without copying data", async () => {
  const view = await mount();
  try {
    await vi.waitFor(() => expect(document.querySelector('[aria-label="选择 orphan"]')).not.toBeNull());
    expect(document.querySelector('[aria-label="选择 attached"]')).toBeNull();
    await click(document.querySelector('input[type="checkbox"]'));
    expect(document.querySelector('[aria-label="选择 shared"]')).toBeNull();
    await click(document.querySelector('[aria-label="选择 orphan"]'));
    await click([...document.querySelectorAll('button')].find((button) => button.textContent === "添加 1 条"));
    await vi.waitFor(() => expect(state.attach).toHaveBeenCalledExactlyOnceWith("target", ["orphan"]));
  } finally { await view.close(); }
});
it("does not classify unknown memberships as orphaned cases", async () => {
  state.failure = true;
  const view = await mount();
  try {
    await vi.waitFor(() => expect(document.body.textContent).toContain("membership unavailable"));
    expect(document.querySelector('[aria-label="选择 orphan"]')).toBeNull();
    expect(state.attach).not.toHaveBeenCalled();
  } finally { await view.close(); }
});
