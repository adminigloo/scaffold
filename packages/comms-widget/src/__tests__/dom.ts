import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CommsTransport } from "../client.js";
import type { ClientError, Result } from "../http.js";
import type { CommsStatusWire, MessageWire, TemplateWire } from "../types.js";

/**
 * A tiny DOM harness (React's act + createRoot, no testing library) and fake
 * transports. COPIED from @adminigloo/scheduling-widget's test fakes.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const ok = <T,>(data: T): Result<T> => ({ ok: true, data });
export const fail = (code: ClientError["code"], message: string = code, extra: Partial<ClientError> = {}): Result<never> => ({
  ok: false,
  error: { code, message, status: code === "network" ? 0 : 400, ...extra },
});

export interface Call {
  method: string;
  args: unknown[];
}

export type Handlers = Partial<{ [K in keyof CommsTransport]: (...args: Parameters<CommsTransport[K]>) => unknown }>;

/** A transport whose every method records its call and answers from `handlers`. */
export function fakeTransport(handlers: Handlers) {
  const calls: Call[] = [];
  const transport = new Proxy({} as CommsTransport, {
    get(_target, prop) {
      const handler = handlers[prop as keyof CommsTransport] as ((...args: unknown[]) => unknown) | undefined;
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        return Promise.resolve(handler ? handler(...args) : fail("internal", `no fake for ${String(prop)}`));
      };
    },
  });
  return { transport, calls, of: (method: string) => calls.filter((c) => c.method === method) };
}

export function template(extra: Partial<TemplateWire> = {}): TemplateWire {
  return {
    key: "visit_reminder",
    channel: "email",
    subject: "See you {{date}}",
    body: "Hi {{name}}, see you {{date}}.",
    active: true,
    updatedAt: "2026-10-01T12:00:00.000Z",
    variables: ["date", "name"],
    ...extra,
  };
}

export function message(extra: Partial<MessageWire> = {}): MessageWire {
  return {
    id: "m1",
    at: "2026-10-12T15:00:00.000Z",
    channel: "email",
    to: "pat@example.com",
    templateKey: "visit_reminder",
    subject: "See you Tue",
    status: "sent",
    note: null,
    blanks: [],
    fromName: "Green Acres",
    replyTo: "gail@greenacres.test",
    ...extra,
  };
}

export function status(extra: Partial<CommsStatusWire> = {}): CommsStatusWire {
  return {
    emails: true,
    emailsOffReason: null,
    fromName: "Green Acres",
    replyTo: "gail@greenacres.test",
    scheduled: { pending: 0, behind: 0, late: 0 },
    ...extra,
  };
}

export interface Mounted {
  container: HTMLElement;
  root: Root;
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
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Let every resolved promise and the renders it causes run. */
export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
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
  return (element?.textContent ?? "").replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
}

export function labelled(container: ParentNode, label: string): HTMLInputElement | HTMLTextAreaElement | null {
  const labels = [...container.querySelectorAll("label")];
  const match = labels.find((l) => text(l).startsWith(label));
  const id = match?.getAttribute("for");
  return id ? (container.querySelector(`[id="${id}"]`) as HTMLInputElement | null) : null;
}
