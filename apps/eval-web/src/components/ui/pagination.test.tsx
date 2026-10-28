import { useState } from "react";
import { expect, it, vi } from "vitest";
import { click, render, type } from "@/test/render";
import { TablePagination, useTablePagination } from "./pagination";

function Pages({ initialCount = 45 }: { initialCount?: number }) {
  const [count, setCount] = useState(initialCount);
  const [scope, setScope] = useState("");
  const pagination = useTablePagination(Array.from({ length: count }, (_, index) => index), scope);
  return <>
    <input aria-label="范围" value={scope} onChange={(event) => setScope(event.target.value)} />
    <button onClick={() => setCount(21)}>缩减</button>
    <button onClick={() => setCount(45)}>扩展</button>
    <div>{pagination.items.map((item) => <span key={item} data-item={item}>{item}</span>)}</div>
    <TablePagination {...pagination} />
  </>;
}

it.each([0, 1, 20, 21, 40, 41])("keeps pagination boundaries valid for %i records", async (count) => {
  const view = await render(<Pages initialCount={count} />);
  try {
    const navigation = view.container.querySelector("nav")!;
    const buttons = navigation.querySelectorAll("button");
    expect(view.container.querySelectorAll("[data-item]")).toHaveLength(Math.min(count, 20));
    expect(navigation.textContent).toContain("每页 20 条");
    expect(buttons[0]).toHaveProperty("disabled", true);
    expect(buttons[1]).toHaveProperty("disabled", count <= 20);
    if (count > 20) {
      await click(buttons[1]);
      expect(view.container.querySelector("[data-item]")?.getAttribute("data-item")).toBe("20");
    }
  } finally { await view.unmount(); }
});

it("clamps a shrinking result set, retains that page on growth, and resets a changed scope", async () => {
  const view = await render(<Pages />);
  const button = (label: string) => [...view.container.querySelectorAll("button")].find((item) => item.textContent === label);
  const first = () => view.container.querySelector("[data-item]")?.getAttribute("data-item");
  try {
    await click(button("下一页")); await click(button("下一页"));
    expect(first()).toBe("40");
    await click(button("缩减"));
    expect(first()).toBe("20");
    await click(button("扩展"));
    expect(first()).toBe("20");
    await type(view.container.querySelector("input"), "changed");
    expect(first()).toBe("0");
    await type(view.container.querySelector("input"), "");
    expect(first()).toBe("0");
  } finally { await view.unmount(); }
});

it("supports cursor paging without inventing a total and disables navigation during reads", async () => {
  const change = vi.fn();
  function Cursor() {
    const [disabled, setDisabled] = useState(false);
    return <><button onClick={() => setDisabled(true)}>读取中</button>
      <TablePagination pageIndex={1} hasNextPage disabled={disabled} onPageChange={change} /></>;
  }
  const view = await render(<Cursor />);
  try {
    const navigation = view.container.querySelector("nav")!;
    expect(navigation.textContent).not.toContain("共");
    await click(navigation.querySelectorAll("button")[0]);
    await click(navigation.querySelectorAll("button")[1]);
    expect(change.mock.calls).toEqual([[0], [2]]);
    await click(view.container.querySelector("button"));
    expect([...navigation.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  } finally { await view.unmount(); }
});

it("synchronizes a clamped controlled page with its external state so growth cannot revive the old page", async () => {
  const change = vi.fn();
  function ControlledPages() {
    const [count, setCount] = useState(45);
    const [pageIndex, setPageIndex] = useState(2);
    const pagination = useTablePagination(Array.from({ length: count }, (_, index) => index), "", {
      pageIndex,
      onPageChange: (index: number, replace?: boolean) => { change(index, replace); setPageIndex(index); },
    });
    return <>
      <button onClick={() => setCount(21)}>缩减</button><button onClick={() => setCount(45)}>扩展</button>
      <output aria-label="外部页码">{pageIndex + 1}</output>
      <div>{pagination.items.map((item) => <span key={item} data-item={item}>{item}</span>)}</div>
      <TablePagination {...pagination} />
    </>;
  }
  const view = await render(<ControlledPages />);
  const button = (label: string) => [...view.container.querySelectorAll("button")].find((item) => item.textContent === label);
  const first = () => view.container.querySelector("[data-item]")?.textContent;
  try {
    expect(first()).toBe("40");
    await click(button("缩减"));
    expect(first()).toBe("20");
    expect(view.container.querySelector('[aria-label="外部页码"]')?.textContent).toBe("2");
    expect(change.mock.calls).toEqual([[1, true]]);
    await click(button("扩展"));
    expect(first()).toBe("20");
    expect(view.container.querySelector('[aria-label="外部页码"]')?.textContent).toBe("2");
    await click(button("下一页"));
    expect(first()).toBe("40");
    expect(change.mock.calls).toEqual([[1, true], [2, undefined]]);
  } finally { await view.unmount(); }
});
