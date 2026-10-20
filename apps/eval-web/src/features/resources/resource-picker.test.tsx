import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { click, render } from "@/test/render";
import { MaterialPickerList, ResourcePicker, type PickedResource } from "./resource-picker";

const readFiles = vi.hoisted(() => vi.fn(async (_bundleId: string, _resourceId: string) => []));

vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

vi.mock("@/api-sdk/bundles-api", () => ({ resourceCatalog: (kind: string) => ({
  keys: { files: (bundle: string, id: string) => [kind, bundle, id, "files"], list: () => [kind, "bundles"], resources: (id: string) => [kind, id] },
  listFiles: readFiles,
  list: async () => kind === "material"
    ? [{ bundleId: "a", name: "素材 A", description: "素材包描述" }, { bundleId: "b", name: "素材 B", description: "第二包" }]
    : [{ bundleId: "s", name: "上下文 S", description: "上下文包描述" }],
  listResources: async (bundleId: string) => kind === "material"
    ? [{ bundleId, materialId: `m-${bundleId}`, name: `素材 ${bundleId}`, description: "素材描述" }]
    : [{ bundleId, sessionId: "s-1", name: "上下文一", description: "上下文描述" }, { bundleId, sessionId: "s-2", name: "上下文二", description: "另一条" }],
}) }));

function Form() {
  const [subject, setSubject] = useState<PickedResource[]>([]);
  const [evaluator, setEvaluator] = useState<PickedResource[]>([]);
  const [context, setContext] = useState<PickedResource | null>(null);
  return <>
    <MaterialPickerList label="执行素材" value={subject} onChange={setSubject} />
    <MaterialPickerList label="评估素材" value={evaluator} onChange={setEvaluator} />
    <ResourcePicker kind="session" label="执行初始对话" value={context} onChange={setContext} />
    <output aria-label="当前绑定">{JSON.stringify({ subject, evaluator, context })}</output>
  </>;
}
const settle = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

describe("Data initial-resource choices", () => {
  it.each(["material", "session"] as const)("retains an off-catalog %s binding without reading its deleted catalog files", async (kind) => {
    readFiles.mockClear();
    const onChange = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><ResourcePicker kind={kind} label="已有绑定"
      value={{ bundleId: "deleted", id: "removed" }} onChange={onChange} /></QueryClientProvider>);
    try {
      await vi.waitFor(() => {
        expect(client.isFetching()).toBe(0);
        expect(view.container.textContent).toContain("该资源已从资源库移除，现有绑定仍可使用");
      });
      expect((view.container.querySelector("select") as HTMLSelectElement).value).toBe("deleted/removed");
      expect(readFiles).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    } finally { await view.unmount(); client.clear(); }
  });

  it("selects ordered materials across bundles, excludes duplicates only within one role, and selects one Subject context", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><Form /></QueryClientProvider>);
    try {
      const choose = async (label: string, value: string) => {
        await act(async () => { const input = view.container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement; input.value = value; input.dispatchEvent(new Event("change", { bubbles: true })); });
        await settle();
      };
      const button = (name: string) => [...view.container.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === name || item.textContent === name);
      await click(button("添加执行素材")); await settle();
      await choose("执行素材 1", "a/m-a");
      await click(button("添加执行素材")); await settle();

      expect((view.container.querySelector('select[aria-label="执行素材 2"] option[value="a/m-a"]') as HTMLOptionElement).disabled).toBe(true);
      await choose("执行素材 2", "b/m-b");
      await click(button("上移执行素材 2"));
      await click(button("添加评估素材")); await settle();

      expect((view.container.querySelector('select[aria-label="评估素材 1"] option[value="a/m-a"]') as HTMLOptionElement).disabled).toBe(false);
      await choose("评估素材 1", "a/m-a");
      await choose("执行初始对话", "s/s-1"); await choose("执行初始对话", "s/s-2");
      expect(JSON.parse(view.container.querySelector("output")!.textContent!)).toEqual({
        subject: [{ bundleId: "b", id: "m-b" }, { bundleId: "a", id: "m-a" }],
        evaluator: [{ bundleId: "a", id: "m-a" }], context: { bundleId: "s", id: "s-2" },
      });
      await click(button("移除执行素材 1"));
      await choose("执行初始对话", "__none");
      expect(JSON.parse(view.container.querySelector("output")!.textContent!)).toMatchObject({ subject: [{ bundleId: "a", id: "m-a" }], context: null });
      expect(view.container.querySelector('select[aria-label="评估上下文"]')).toBeNull();
    } finally { await view.unmount(); client.clear(); }
  });
});
