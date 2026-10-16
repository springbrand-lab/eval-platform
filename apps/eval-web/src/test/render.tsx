import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

/** Render into a detached container; returns it with an unmount function. */
export async function render(node: ReactNode): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(node);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

export async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error("Element not found");
  await act(async () => {
    (element as HTMLElement).click();
  });
}

export async function type(input: Element | null | undefined, value: string): Promise<void> {
  if (!input) throw new Error("Input not found");
  await act(async () => {
    const element = input as HTMLInputElement;
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function select(input: Element | null | undefined, value: string): Promise<void> {
  if (!(input instanceof HTMLSelectElement)) throw new Error("Select not found");
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
