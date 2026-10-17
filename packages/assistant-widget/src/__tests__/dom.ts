import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AssistantTransport, Result } from "../client.js";

/**
 * A tiny DOM harness (React's act + createRoot, no testing library) and a fake
 * transport. COPIED in shape from @adminigloo/notifications-widget's.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const ok = <T,>(data: T): Result<T> => ({ ok: true, data });
export const fail = (code: string, message: string, status = 400): Result<never> => ({ ok: false, code, message, status });

/** An SSE body from events. */
export function sse(events: unknown[], options: { hold?: Promise<void> } = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const [i, event] of events.entries()) {
        if (i === events.length - 1 && options.hold) await options.hold;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

export interface FakeCalls {
  chat: Array<{ message: string; conversationId: string | null }>;
  decide: Array<{ actionId: string; decision: string; edits?: Record<string, string> }>;
}

export function fakeTransport(overrides: Partial<AssistantTransport> = {}): { transport: AssistantTransport; calls: FakeCalls } {
  const calls: FakeCalls = { chat: [], decide: [] };
  const transport: AssistantTransport = {
    hasHistory: true,
    status: async () =>
      ok({ configured: true, notConfiguredMessage: null, starters: ["Which invoices are overdue?"], freeStarters: [], allowance: null, canManage: false }),
    chat: async (message, conversationId) => {
      calls.chat.push({ message, conversationId });
      return sse([
        { v: 1, type: "start", conversationId: "c1" },
        { v: 1, type: "text", delta: "Hello" },
        { v: 1, type: "done", meta: { conversationId: "c1", messageId: "m1", status: "complete", steps: 1 } },
      ]);
    },
    decide: async (actionId, decision, edits) => {
      calls.decide.push({ actionId, decision, ...(edits && Object.keys(edits).length > 0 ? { edits } : {}) });
      return ok({ status: decision === "confirm" ? "confirmed" : "declined", done: decision === "confirm", message: decision === "confirm" ? "Saved the answer." : "Nothing was changed." });
    },
    conversations: async () => ok([]),
    conversation: async () => fail("not_found", "That conversation isn't here.", 404),
    ...overrides,
  };
  // Record chat calls made through an override too.
  if (overrides.chat) {
    const inner = overrides.chat;
    transport.chat = (message, conversationId, signal) => {
      calls.chat.push({ message, conversationId });
      return inner(message, conversationId, signal);
    };
  }
  if (overrides.decide) {
    const inner = overrides.decide;
    transport.decide = (actionId, decision, edits) => {
      calls.decide.push({ actionId, decision, ...(edits && Object.keys(edits).length > 0 ? { edits } : {}) });
      return inner(actionId, decision, edits);
    };
  }
  return { transport, calls };
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

export async function settle(rounds = 8): Promise<void> {
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

export async function key(target: EventTarget, name: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

/** Set a controlled field's value the way a person typing does. */
export async function type(element: Element | null | undefined, value: string): Promise<void> {
  if (!element) throw new Error("type: no element");
  const field = element as HTMLInputElement | HTMLTextAreaElement;
  const proto = Object.getPrototypeOf(field) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function button(container: ParentNode, name: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name,
    ) ?? null
  );
}
