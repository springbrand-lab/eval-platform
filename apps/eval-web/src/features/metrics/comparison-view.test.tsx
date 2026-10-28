import { act, useState } from "react";
import { expect, it, vi } from "vitest";
import { render } from "@/test/render";
import { ComparisonViewSwitch, type ComparisonViewMode } from "./comparison-view";

it("switches between exactly two controlled views with one click and reports the selected mode", async () => {
  const changed = vi.fn();
  function Views() {
    const [value, setValue] = useState<ComparisonViewMode>("evaluation");
    return <ComparisonViewSwitch value={value} onChange={(next) => { changed(next); setValue(next); }} />;
  }
  const screen = await render(<Views />);
  const tabs = () => [...screen.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  try {
    expect(screen.container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("对比展示视图");
    expect(tabs().map((tab) => tab.textContent)).toEqual(["评估指标", "执行指标"]);
    expect(tabs().map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(changed).not.toHaveBeenCalled();

    await act(async () => {
      tabs()[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      tabs()[1].click();
    });
    expect(changed.mock.calls).toEqual([["execution"]]);
    expect(tabs().map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true"]);

    await act(async () => {
      tabs()[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      tabs()[0].click();
    });
    expect(changed.mock.calls).toEqual([["execution"], ["evaluation"]]);
    expect(tabs().map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false"]);
  } finally { await screen.unmount(); }
});

it("leaves the selected view under the caller's control", async () => {
  const changed = vi.fn();
  const screen = await render(<ComparisonViewSwitch value="evaluation" onChange={changed} />);
  try {
    const execution = screen.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1];
    await act(async () => { execution.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })); });
    expect(changed).toHaveBeenCalledExactlyOnceWith("execution");
    expect(screen.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("评估指标");
  } finally { await screen.unmount(); }
});

it("supports keyboard activation without changing the view on focus alone", async () => {
  const changed = vi.fn();
  const screen = await render(<ComparisonViewSwitch value="evaluation" onChange={changed} />);
  try {
    const execution = screen.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1];
    await act(async () => { execution.focus(); });
    expect(changed).not.toHaveBeenCalled();
    await act(async () => { execution.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(changed).toHaveBeenCalledExactlyOnceWith("execution");
  } finally { await screen.unmount(); }
});

it("moves focus with arrows, Home and End while requiring Enter or Space to activate either view", async () => {
  const changed = vi.fn();
  function Views() {
    const [value, setValue] = useState<ComparisonViewMode>("evaluation");
    return <ComparisonViewSwitch value={value} onChange={(next) => { changed(next); setValue(next); }} />;
  }
  const screen = await render(<Views />);
  const [evaluation, execution] = screen.container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  const key = async (target: HTMLElement, value: string) => {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  try {
    await act(async () => { evaluation.focus(); });
    await key(evaluation, "ArrowRight");
    expect(document.activeElement).toBe(execution);
    expect(changed).not.toHaveBeenCalled();
    expect(evaluation.getAttribute("aria-selected")).toBe("true");
    await key(execution, " ");
    expect(changed.mock.calls).toEqual([["execution"]]);
    expect(execution.getAttribute("aria-selected")).toBe("true");
    await key(execution, "Home");
    expect(document.activeElement).toBe(evaluation);
    expect(changed).toHaveBeenCalledTimes(1);
    await key(evaluation, "Enter");
    expect(changed.mock.calls).toEqual([["execution"], ["evaluation"]]);
    expect(evaluation.getAttribute("aria-selected")).toBe("true");
    await key(evaluation, "End");
    expect(document.activeElement).toBe(execution);
    await key(execution, "ArrowRight");
    expect(document.activeElement).toBe(evaluation);
    await key(evaluation, "ArrowLeft");
    expect(document.activeElement).toBe(execution);
    expect(changed).toHaveBeenCalledTimes(2);
  } finally { await screen.unmount(); }
});
