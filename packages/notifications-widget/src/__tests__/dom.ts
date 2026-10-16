import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AlertsTransport } from "../client.js";
import type { ClientError, Result } from "../http.js";
import type { AlertChoiceWire, AlertListWire, AlertWire, PreferencesWire, RoutingGroupWire } from "../types.js";

/**
 * A tiny DOM harness (React's act + createRoot, no testing library) and fake
 * transports. COPIED from @adminigloo/comms-widget's test fakes.
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

export type Handlers = Partial<{ [K in keyof AlertsTransport]: (...args: Parameters<AlertsTransport[K]>) => unknown }>;

/** A transport whose every method records its call and answers from `handlers`. */
export function fakeTransport(handlers: Handlers) {
  const calls: Call[] = [];
  const transport = new Proxy({} as AlertsTransport, {
    get(_target, prop) {
      const handler = handlers[prop as keyof AlertsTransport] as ((...args: unknown[]) => unknown) | undefined;
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        return Promise.resolve(handler ? handler(...args) : fail("internal", `no fake for ${String(prop)}`));
      };
    },
  });
  return { transport, calls, of: (method: string) => calls.filter((c) => c.method === method), handlers };
}

let ids = 0;
export function alert(extra: Partial<AlertWire> = {}): AlertWire {
  ids += 1;
  return {
    id: `a${ids}`,
    kind: "estimator.lead",
    category: "Estimates",
    title: `Pat Rivera asked for an estimate (${ids})`,
    body: "Front walk, 3 steps.\nCall after 5.",
    href: `/app/estimates/e${ids}`,
    at: new Date(Date.now() - 3 * 60_000).toISOString(),
    read: false,
    ...extra,
  };
}

export function listOf(alerts: AlertWire[], extra: Partial<AlertListWire> = {}): AlertListWire {
  return {
    alerts,
    nextCursor: null,
    unread: alerts.filter((a) => !a.read).length,
    reachable: true,
    links: { inbox: "/app/alerts", settings: "/app/alerts/settings" },
    ...extra,
  };
}

export function choice(extra: Partial<AlertChoiceWire> = {}): AlertChoiceWire {
  return {
    kind: "estimator.lead",
    label: "Someone asks for an estimate",
    description: null,
    category: "Estimates",
    channel: "email",
    emailOffered: true,
    emailNote: null,
    emailOffInMessages: false,
    routed: { group: "New estimate requests and quote answers", onList: true, viaAssigned: false },
    receives: true,
    emailTo: "gail@greenacres.test",
    ...extra,
  };
}

export function prefs(extra: Partial<PreferencesWire> = {}): PreferencesWire {
  return {
    emailAddress: "gail@greenacres.test",
    emailAvailable: true,
    emailOffReason: null,
    categories: ["Estimates", "Team"],
    choices: [choice(), choice({ kind: "tenancy.member.joined", label: "Someone joins the team", category: "Team", channel: "in_app", routed: null })],
    canManageRouting: false,
    reachable: true,
    links: { messages: "/app/messages" },
    ...extra,
  };
}

export function group(extra: Partial<RoutingGroupWire> = {}): RoutingGroupWire {
  return {
    key: "estimates",
    label: "New estimate requests and quote answers",
    description: null,
    covers: ["Someone asks for an estimate", "A customer accepts a quote"],
    mode: "owner",
    userIds: [],
    extraEmails: [],
    candidates: [
      { userId: "u-gail", name: "Gail Owner", email: "gail@greenacres.test", isOwner: true },
      { userId: "u-mo", name: "Mo Member", email: "mo@greenacres.test", isOwner: false },
    ],
    ownerEmail: "gail@greenacres.test",
    ownerEmailIsBusiness: false,
    emailNote: null,
    ownerInAppOnly: [],
    ownerIsYou: true,
    ...extra,
  };
}

/**
 * A BroadcastChannel stand-in, installed on globalThis: delivers each post to
 * every OTHER open channel of the same name (the platform's rule), at once.
 */
export class FakeBroadcastChannel {
  static open: FakeBroadcastChannel[] = [];
  static posts: { name: string; data: unknown }[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) {
    FakeBroadcastChannel.open.push(this);
  }
  postMessage(data: unknown) {
    FakeBroadcastChannel.posts.push({ name: this.name, data });
    for (const other of FakeBroadcastChannel.open) if (other !== this && other.name === this.name) other.onmessage?.({ data });
  }
  close() {
    FakeBroadcastChannel.open = FakeBroadcastChannel.open.filter((c) => c !== this);
  }
  static install() {
    FakeBroadcastChannel.open = [];
    FakeBroadcastChannel.posts = [];
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeBroadcastChannel;
  }
}

export interface Mounted {
  container: HTMLElement;
  root: Root;
  unmount: () => Promise<void>;
}

/** Render into a fresh container. Pass `settled: false` under fake timers (settle() waits on a real setTimeout). */
export async function mount(element: ReactElement, options: { settled?: boolean } = {}): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  if (options.settled !== false) await settle();
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

export async function key(target: EventTarget, name: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
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

/** The radio or checkbox inside the label whose text starts with `label`. */
export function choiceInput(container: ParentNode, label: string): HTMLInputElement | null {
  const labels = [...container.querySelectorAll("label")];
  return (labels.find((l) => text(l).startsWith(label))?.querySelector("input") as HTMLInputElement | null) ?? null;
}
