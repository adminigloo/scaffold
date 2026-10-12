import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SchedulingAdminTransport } from "../admin/client.js";
import type {
  AdminResource,
  AvailabilityResponse,
  CalendarResponse,
  CrewDayResponse,
  SettingsWire,
  VisitSnapshot,
} from "../admin/types.js";
import type { SchedulingTransport } from "../client.js";
import type { ClientError, Result } from "../http.js";
import type { PublicConfig, PublicSlot, PublicVisit, SlotsResponse, WireErrorCode } from "../types.js";

/**
 * Fake transports for the component tests: every call is recorded, every
 * answer is scripted per test, and nothing touches the network. They stand
 * exactly where a host's own transport (tRPC, a server action) would.
 */

export const ok = <T,>(data: T): Result<T> => ({ ok: true, data });
export const fail = (code: WireErrorCode | "network" | "bad_response", message: string = code, extra: Partial<ClientError> = {}): Result<never> => ({
  ok: false,
  error: { code, message, status: code === "network" ? 0 : 409, ...extra },
});

export interface Call {
  method: string;
  args: unknown[];
}

/** A transport whose every method records its call and answers from `handlers` (or `fallback`). */
function recording<T extends object>(handlers: Partial<Record<keyof T, (...args: never[]) => unknown>>, sync: ReadonlyArray<keyof T> = []) {
  const calls: Call[] = [];
  const transport = new Proxy({} as T, {
    get(_target, prop) {
      const handler = handlers[prop as keyof T] as ((...args: unknown[]) => unknown) | undefined;
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        if (sync.includes(prop as keyof T)) return handler ? handler(...args) : null;
        return Promise.resolve(handler ? handler(...args) : fail("internal", `no fake for ${String(prop)}`));
      };
    },
  });
  return { transport, calls, of: (method: string) => calls.filter((c) => c.method === method) };
}

export type PublicHandlers = Partial<{ [K in keyof SchedulingTransport]: (...args: Parameters<SchedulingTransport[K]>) => unknown }>;
export type AdminHandlers = Partial<{ [K in keyof SchedulingAdminTransport]: (...args: Parameters<SchedulingAdminTransport[K]>) => unknown }>;

export function fakePublic(handlers: PublicHandlers) {
  return recording<SchedulingTransport>(
    { icsUrl: (token: string) => `https://acme.test/api/schedule/v1/visit/${token}/ics`, ...handlers } as never,
    ["icsUrl"],
  );
}

export function fakeAdmin(handlers: AdminHandlers) {
  return recording<SchedulingAdminTransport>(handlers as never);
}

// ---------------------------------------------------------------------------
// Fixtures: Acme Windows, Salt Lake City (America/Denver)
// ---------------------------------------------------------------------------

export const CONFIG: PublicConfig = {
  businessName: "Acme Windows",
  timeZone: "America/Denver",
  publicBookingEnabled: true,
  autoConfirm: false,
  services: [
    { key: "estimate", name: "Free estimate", description: "We measure and quote.", durationMinutes: 60 },
    { key: "window-clean", name: "Window clean", description: null, durationMinutes: 120 },
  ],
  minNoticeMinutes: 1440,
  horizonDays: 30,
  requireAddress: true,
  cancelCutoffHours: 24,
  contactEmail: "office@acme.test",
  contactPhone: "(801) 555-0143",
  emailsEnabled: true,
  minFillMs: 0,
};

export const SLOTS: PublicSlot[] = [
  { slotId: "s-mon-0900", date: "2026-11-02", startTime: "09:00", endTime: "10:00", startsAt: "2026-11-02T16:00:00.000Z", endsAt: "2026-11-02T17:00:00.000Z" },
  { slotId: "s-mon-1330", date: "2026-11-02", startTime: "13:30", endTime: "14:30", startsAt: "2026-11-02T20:30:00.000Z", endsAt: "2026-11-02T21:30:00.000Z" },
  { slotId: "s-tue-1000", date: "2026-11-03", startTime: "10:00", endTime: "11:00", startsAt: "2026-11-03T17:00:00.000Z", endsAt: "2026-11-03T18:00:00.000Z" },
];

export function slotsResponse(slots: PublicSlot[] = SLOTS, extra: Partial<SlotsResponse> = {}): SlotsResponse {
  return { timeZone: "America/Denver", service: "estimate", from: "2026-10-30", to: "2026-11-12", closed: false, slots, ...extra };
}

export function publicVisit(extra: Partial<PublicVisit> = {}): PublicVisit {
  return {
    status: "requested",
    serviceKey: "estimate",
    serviceName: "Free estimate",
    date: "2026-11-02",
    startTime: "09:00",
    endTime: "10:00",
    startsAt: "2026-11-02T16:00:00.000Z",
    endsAt: "2026-11-02T17:00:00.000Z",
    timeZone: "America/Denver",
    durationMinutes: 60,
    customerName: "Jane Doe",
    address: "123 Main St, Salt Lake City, UT 84101",
    businessName: "Acme Windows",
    contactPhone: "(801) 555-0143",
    contactEmail: "office@acme.test",
    canReschedule: true,
    canCancel: true,
    changeDeadline: "2026-11-01T16:00:00.000Z",
    cancelCutoffHours: 24,
    cancelledBy: null,
    googleCalendarUrl: "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Free%20estimate",
    ...extra,
  };
}

export function snapshot(extra: Partial<VisitSnapshot> = {}): VisitSnapshot {
  return {
    id: "v1",
    status: "confirmed",
    nextStatuses: ["in_progress", "completed", "cancelled", "no_show"],
    date: "2026-11-02",
    startTime: "09:00",
    endTime: "10:00",
    startsAt: "2026-11-02T16:00:00.000Z",
    endsAt: "2026-11-02T17:00:00.000Z",
    timeZone: "America/Denver",
    durationMinutes: 60,
    resourceId: "crew-a",
    resourceName: "Crew A",
    serviceKey: "estimate",
    serviceName: "Free estimate",
    title: null,
    customerName: "Jane Doe",
    customerEmail: "jane@example.com",
    customerPhone: "+18015550100",
    address: "123 Main St, Salt Lake City, UT",
    lat: 40.76,
    lng: -111.89,
    notes: null,
    estimateId: null,
    origin: "public",
    sequence: 0,
    pendingExpiresAt: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-10-29T15:00:00.000Z",
    updatedAt: "2026-10-29T15:00:00.000Z",
    ...extra,
  };
}

export function calendar(extra: Partial<CalendarResponse> = {}): CalendarResponse {
  return {
    timeZone: "America/Denver",
    today: "2026-10-29",
    from: "2026-11-02",
    to: "2026-11-02",
    slotStepMinutes: 30,
    resources: [
      { id: "crew-a", name: "Crew A", isActive: true, acceptsPublicBookings: true, maxJobsPerDay: 6 },
      { id: "crew-b", name: "Crew B", isActive: true, acceptsPublicBookings: true, maxJobsPerDay: 6 },
    ],
    windows: [
      { resourceId: "crew-a", date: "2026-11-02", windows: [{ start: "08:00", end: "17:00" }] },
      { resourceId: "crew-b", date: "2026-11-02", windows: [{ start: "08:00", end: "12:00" }, { start: "13:00", end: "17:00" }] },
    ],
    visits: [snapshot()],
    pending: [],
    ...extra,
  };
}

export function settingsWire(extra: Partial<SettingsWire> = {}): SettingsWire {
  return {
    timeZone: "America/Denver",
    businessName: "Acme Windows",
    contactEmail: "office@acme.test",
    contactPhone: "(801) 555-0143",
    staffNotifyEmails: ["office@acme.test"],
    services: [{ key: "estimate", name: "Free estimate", durationMinutes: 60, description: null, requiredSkill: null }],
    slotStepMinutes: 30,
    minNoticeMinutes: 1440,
    horizonDays: 30,
    travelBufferMinutes: 30,
    maxSlotsPerDay: null,
    maxOpenRequestsPerRequester: 3,
    requireAddress: true,
    autoConfirm: false,
    publicBookingEnabled: true,
    pendingExpiryHours: 48,
    reminderLeadHours: 24,
    cancelCutoffHours: 24,
    saved: true,
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...extra,
  };
}

export function resource(extra: Partial<AdminResource> = {}): AdminResource {
  return {
    id: "crew-a",
    name: "Crew A",
    userId: null,
    homeBaseAddress: "1 Depot Rd",
    homeBaseLat: null,
    homeBaseLng: null,
    skills: [],
    workStartTime: "08:00",
    workEndTime: "17:00",
    maxJobsPerDay: 6,
    hoursConfigured: false,
    acceptsPublicBookings: true,
    isActive: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...extra,
  };
}

export function availability(extra: Partial<AvailabilityResponse> = {}): AvailabilityResponse {
  const monFri = [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startTime: "08:00", endTime: "17:00" }));
  return { resourceId: "crew-a", hoursConfigured: false, weekly: [], effectiveWeekly: monFri, timeOff: [], specialHours: [], ...extra };
}

export function crewDay(extra: Partial<CrewDayResponse> = {}): CrewDayResponse {
  const first = snapshot({ id: "v1", startTime: "09:00", endTime: "10:00" });
  const second = snapshot({ id: "v2", startTime: "11:00", endTime: "12:00", customerName: "Sam Lee", address: "9 Oak Ave", startsAt: "2026-11-02T18:00:00.000Z" });
  return {
    timeZone: "America/Denver",
    date: "2026-11-02",
    today: "2026-11-02",
    resource: { id: "crew-a", name: "Crew A", homeBaseAddress: "1 Depot Rd" },
    windows: [{ start: "08:00", end: "17:00" }],
    stops: [
      {
        order: 1,
        visit: first,
        driveFromPrevious: { minutes: 18, miles: 9.24, from: "home_base", estimated: false },
        directionsUrl: "https://www.google.com/maps/dir/?api=1&destination=123%20Main%20St&travelmode=driving",
        telUrl: "tel:+18015550100",
      },
      {
        order: 2,
        visit: second,
        driveFromPrevious: { minutes: 12, miles: 4, from: "previous_stop", estimated: false },
        directionsUrl: "https://www.google.com/maps/dir/?api=1&destination=9%20Oak%20Ave&travelmode=driving",
        telUrl: null,
      },
    ],
    totals: { visits: 2, driveMinutes: 30, distanceMiles: 13.2, estimated: false },
    routeUrl: "https://www.google.com/maps/dir/?api=1&origin=1%20Depot%20Rd&destination=9%20Oak%20Ave&travelmode=driving",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// A tiny DOM harness: React's act + createRoot, no testing library
// ---------------------------------------------------------------------------

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

export async function choose(element: Element | null | undefined, value: string): Promise<void> {
  if (!element) throw new Error("choose: no element");
  const select = element as HTMLSelectElement;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
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

export async function key(element: Element | null | undefined, keyName: string, init: KeyboardEventInit = {}): Promise<void> {
  if (!element) throw new Error("key: no element");
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

/** The first button whose text (or aria-label) includes `text`. */
export function button(container: ParentNode, text: string): HTMLButtonElement | null {
  const all = [...container.querySelectorAll<HTMLButtonElement>("button")];
  return (
    all.find((b) => (b.textContent ?? "").trim() === text) ??
    all.find((b) => (b.textContent ?? "").includes(text) || (b.getAttribute("aria-label") ?? "").includes(text)) ??
    null
  );
}

/** The text a person reads, whitespace collapsed (Intl's narrow spaces too). */
export function text(element: Element | null | undefined): string {
  return (element?.textContent ?? "").replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
}

export function labelled(container: ParentNode, label: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null {
  const labels = [...container.querySelectorAll("label")];
  const match = labels.find((l) => text(l).startsWith(label));
  const id = match?.getAttribute("for");
  return id ? (container.querySelector(`[id="${id}"]`) as HTMLInputElement | null) : null;
}
