import { describe, expect, it, vi } from "vitest";
import { click, render, type } from "@/test/render";
import { StatusBadge } from "./badge";
import { DataTable } from "./data-table";

describe("StatusBadge", () => {
  it("shows the status as text, not colour alone", async () => {
    const view = await render(<StatusBadge status="failed" />);
    expect(view.container.textContent).toBe("失败");
    await view.unmount();
  });
});

describe("DataTable", () => {
  const rows = [{ id: "a", name: "Beta", score: 2 }, { id: "b", name: "Alpha", score: 9 }, { id: "c", name: "Gamma", score: 5 }];
  const columns = [
    { key: "name", header: "名称", cell: (row: typeof rows[number]) => row.name, sortValue: (row: typeof rows[number]) => row.name },
    { key: "score", header: "分数", cell: (row: typeof rows[number]) => String(row.score), sortValue: (row: typeof rows[number]) => row.score },
  ];
  const names = (container: HTMLElement) => [...container.querySelectorAll("tbody tr")].map((row) => row.querySelectorAll("td")[1]?.textContent ?? row.textContent);

  it("filters, sorts and selects rows", async () => {
    const onSelectedChange = vi.fn();
    const view = await render(
      <DataTable rows={rows} columns={columns} rowKey={(row) => row.id} searchText={(row) => row.name}
        selectable selected={new Set()} onSelectedChange={onSelectedChange} />,
    );
    const sortBy = (label: string) => [...view.container.querySelectorAll("thead button")].find((button) => button.textContent === label);
    await click(sortBy("分数"));
    expect(names(view.container)).toEqual(["2", "5", "9"].map((score) => rows.find((row) => String(row.score) === score)!.name));
    await click(sortBy("分数"));
    expect(names(view.container)[0]).toBe("Alpha");
    await type(view.container.querySelector("input[aria-label='搜索']"), "gam");
    expect(names(view.container)).toEqual(["Gamma"]);
    await click(view.container.querySelector("[aria-label='全选']"));
    expect(onSelectedChange).toHaveBeenCalledWith(new Set(["c"]));
    await view.unmount();
  });

  it("virtualizes long lists instead of rendering every row", async () => {
    const many = Array.from({ length: 500 }, (_, index) => ({ id: String(index), name: `n${index}`, score: index }));
    const view = await render(<DataTable rows={many} columns={columns} rowKey={(row) => row.id} />);
    expect(view.container.querySelectorAll("tbody tr").length).toBeLessThan(100);
    await view.unmount();
  });
});
