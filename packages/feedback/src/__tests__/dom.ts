import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * A tiny DOM harness (React's act + createRoot, no testing library).
 * COPIED from @adminigloo/comms-widget's test helpers.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  container: HTMLElement;
  root: Root;
  rerender: (element: ReactElement) => Promise<void>;
  unmount: () => Promise<void>;
}

export async function mount(element: ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await settle();
  return {
    container,
    root,
    rerender: async (next) => {
      await act(async () => {
        root.render(next);
      });
      await settle();
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Let every resolved promise and the renders it causes run. */
export async function settle(rounds = 6, ms = 0): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
}

export async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error("click: no element");
  await act(async () => {
    (element as HTMLElement).click();
  });
  await settle();
}

/** Set a controlled input's value the way a person typing does. */
export async function type(element: Element | null | undefined, value: string): Promise<void> {
  if (!element) throw new Error("type: no element");
  const input = element as HTMLInputElement;
  const proto = Object.getPrototypeOf(input) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setter ? setter.call(input, value) : (input.value = value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export async function choose(select: Element | null | undefined, value: string): Promise<void> {
  if (!select) throw new Error("choose: no select");
  await act(async () => {
    (select as HTMLSelectElement).value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

export async function key(element: Element | null | undefined, keyName: string): Promise<void> {
  if (!element) throw new Error("key: no element");
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true }));
  });
  await settle();
}

export async function submit(form: Element | null | undefined): Promise<void> {
  if (!form) throw new Error("submit: no form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

/** The first button whose text (or aria-label) matches `label`. */
export function button(container: ParentNode, label: string): HTMLButtonElement | null {
  const all = [...container.querySelectorAll<HTMLButtonElement>("button")];
  return (
    all.find((b) => (b.textContent ?? "").trim() === label) ??
    all.find((b) => (b.getAttribute("aria-label") ?? "") === label) ??
    all.find((b) => (b.textContent ?? "").includes(label) || (b.getAttribute("aria-label") ?? "").includes(label)) ??
    null
  );
}

/** The text a person reads, whitespace collapsed. */
export function text(element: Element | null | undefined): string {
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The control inside the <label> whose text starts with `label`. */
export function field<T extends Element = HTMLInputElement>(container: ParentNode, label: string): T | null {
  const labels = [...container.querySelectorAll("label")];
  const match = labels.find((l) => text(l).startsWith(label));
  if (!match) return null;
  const id = match.getAttribute("for");
  if (id) return container.querySelector(`[id="${id}"]`) as T | null;
  return match.querySelector("input, select, textarea") as T | null;
}

export interface Call {
  method: string;
  args: unknown[];
}

/** An object whose every method records its call and answers from `handlers` (or resolves undefined). */
export function fake<T extends object>(handlers: Partial<Record<keyof T, (...args: never[]) => unknown>>) {
  const calls: Call[] = [];
  const target = new Proxy({} as T, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      const handler = handlers[prop as keyof T] as ((...args: unknown[]) => unknown) | undefined;
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        try {
          return Promise.resolve(handler ? handler(...args) : undefined);
        } catch (error) {
          return Promise.reject(error);
        }
      };
    },
  });
  return { target, calls, of: (method: string) => calls.filter((c) => c.method === method) };
}
