import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TenancyAdminTransport } from "../admin/client.js";
import type { TenancyTransport } from "../client.js";
import type { ClientError, Result } from "../http.js";
import type {
  AdminCompanyDetailWire,
  AdminCompanyRowWire,
  AdminPeopleWire,
  AdminPersonWire,
  ChecklistWire,
  CompanyProfileWire,
  CompanyWire,
  InvitationWire,
  MemberWire,
  SessionWire,
  SettingsSectionWire,
  SettingsWire,
  TeamWire,
  TenancyErrorCode,
} from "../types.js";

/**
 * Fake transports for the component tests: every call is recorded, every
 * answer is scripted per test, and nothing touches the network. They stand
 * exactly where a host's own transport (tRPC, a server action) would.
 */

export const ok = <T,>(data: T): Result<T> => ({ ok: true, data });
export const fail = (code: TenancyErrorCode | "network" | "bad_response", message: string = code, extra: Partial<ClientError> = {}): Result<never> => ({
  ok: false,
  error: { code, message, status: code === "network" ? 0 : 409, ...extra },
});

export interface Call {
  method: string;
  args: unknown[];
}

function recording<T extends object>(handlers: Partial<Record<keyof T, (...args: never[]) => unknown>>) {
  const calls: Call[] = [];
  const transport = new Proxy({} as T, {
    get(_target, prop) {
      const handler = handlers[prop as keyof T] as ((...args: unknown[]) => unknown) | undefined;
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        return Promise.resolve(handler ? handler(...args) : fail("internal", `no fake for ${String(prop)}`));
      };
    },
  });
  return { transport, calls, of: (method: string) => calls.filter((c) => c.method === method) };
}

export type Handlers = Partial<{ [K in keyof TenancyTransport]: (...args: Parameters<TenancyTransport[K]>) => unknown }>;
export type AdminHandlers = Partial<{ [K in keyof TenancyAdminTransport]: (...args: Parameters<TenancyAdminTransport[K]>) => unknown }>;

export function fakeTenancy(handlers: Handlers) {
  return recording<TenancyTransport>(handlers as never);
}

export function fakeAdmin(handlers: AdminHandlers) {
  return recording<TenancyAdminTransport>(handlers as never);
}

// ---------------------------------------------------------------------------
// Fixtures: Summit Window Co., the founder's scenario (contract 13.4)
// ---------------------------------------------------------------------------

export function company(extra: Partial<CompanyWire> = {}): CompanyWire {
  return {
    id: "t-summit",
    name: "Summit Window Co.",
    slug: "summit-window-co",
    kind: "org",
    status: "active",
    logoUrl: null,
    brandColor: null,
    onBrandColor: null,
    publicPath: "/t/summit-window-co",
    createdAt: "2026-10-12T15:00:00.000Z",
    role: "owner",
    isOwner: true,
    ...extra,
  };
}

export function session(extra: Partial<SessionWire> = {}): SessionWire {
  return {
    mode: "companies",
    state: "ready",
    user: { userId: "u-olivia", email: "olivia@summitwindows.test", name: "Olivia" },
    company: company(),
    companies: [
      { id: "t-summit", name: "Summit Window Co.", slug: "summit-window-co", logoUrl: null, role: "owner", status: "active", active: true },
      { id: "t-gig", name: "Sam's Side Gig", slug: "sams-side-gig", logoUrl: null, role: "admin", status: "suspended", active: false },
    ],
    invitations: [],
    formerCompany: null,
    ...extra,
  };
}

export function onboardingSession(extra: Partial<SessionWire> = {}): SessionWire {
  return {
    mode: "companies",
    state: "needs-onboarding",
    user: { userId: "u-olivia", email: "olivia@summitwindows.test", name: "Olivia" },
    company: null,
    companies: [],
    invitations: [],
    formerCompany: null,
    ...extra,
  };
}

export function checklist(extra: Partial<ChecklistWire> = {}): ChecklistWire {
  return {
    items: [
      { key: "company.details", title: "Add your business details", description: "Your time zone, and the email or phone customers can reach you at.", actionLabel: "Add details", href: "/settings/company#details", done: false, dismissed: false },
      { key: "team.invite", title: "Invite your team", description: "Add the people who work with you. Each gets an email with a link to join.", actionLabel: "Invite people", href: "/settings/team", done: false, dismissed: false },
      { key: "company.branding", title: "Add your logo and colour", description: "They show on your public page and in the header your team sees.", actionLabel: "Add branding", href: "/settings/company#branding", done: false, dismissed: false },
    ],
    done: 0,
    total: 3,
    complete: false,
    hidden: false,
    ...extra,
  };
}

export function member(extra: Partial<MemberWire> = {}): MemberWire {
  return {
    userId: "u-sam",
    name: "Sam Lee",
    email: "sam@summitwindows.test",
    roleKey: "member",
    roleName: "Member",
    isOwner: false,
    isYou: false,
    status: "active",
    joinedAt: "2026-10-12T16:00:00.000Z",
    actions: { roles: ["admin", "viewer"], remove: true, transferTo: true },
    ...extra,
  };
}

export function team(extra: Partial<TeamWire> = {}): TeamWire {
  return {
    company: { id: "t-summit", name: "Summit Window Co.", kind: "org" },
    you: { userId: "u-olivia", roleKey: "owner", isOwner: true, canInvite: true, canLeave: false, leaveBlocked: "You own this company. Hand ownership to someone else before you leave.", canTransfer: true },
    members: [
      member({ userId: "u-olivia", name: "Olivia", email: "olivia@summitwindows.test", roleKey: "owner", roleName: "Owner", isOwner: true, isYou: true, actions: { roles: [], remove: false, transferTo: false } }),
      member(),
    ],
    roles: [
      { key: "owner", name: "Owner", description: "Runs the company.", rank: 40 },
      { key: "admin", name: "Admin", description: "Manages the team and settings.", rank: 30 },
      { key: "member", name: "Member", description: "Does the day-to-day work.", rank: 20 },
      { key: "viewer", name: "Viewer", description: "Can look, not change.", rank: 10 },
    ],
    invitableRoles: ["admin", "member", "viewer"],
    seats: null,
    ...extra,
  };
}

export function invitation(extra: Partial<InvitationWire> = {}): InvitationWire {
  return {
    id: "inv-1",
    email: "rae@summitwindows.test",
    roleKey: "member",
    roleName: "Member",
    state: "pending",
    expiresAt: "2026-10-19T15:00:00.000Z",
    createdAt: "2026-10-12T15:00:00.000Z",
    canResend: true,
    canRevoke: true,
    wrongAccount: null,
    ...extra,
  };
}

export function profile(extra: Partial<CompanyWire> = {}, can: string[] = ["tenant.view", "tenant.edit"]): CompanyProfileWire {
  return { company: company(extra), can, logoUploads: true };
}

export function companySection(extra: Partial<SettingsSectionWire> = {}): SettingsSectionWire {
  return {
    key: "company",
    label: "Business details",
    description: null,
    canEdit: true,
    values: { timeZone: null, contactEmail: null, contactPhone: null, addressLine1: null, city: null, region: null },
    fields: [
      { key: "timeZone", label: "Time zone", help: "Dates and times your customers see use this.", kind: "timezone", options: null, placeholder: null, autoComplete: null, width: "full", required: false, min: null, max: null, step: null },
      { key: "contactEmail", label: "Email customers can reach you at", help: null, kind: "email", options: null, placeholder: null, autoComplete: "email", width: "full", required: false, min: null, max: null, step: null },
      { key: "contactPhone", label: "Phone customers can call", help: null, kind: "tel", options: null, placeholder: null, autoComplete: "tel", width: "full", required: false, min: null, max: null, step: null },
      { key: "addressLine1", label: "Street address", help: null, kind: "text", options: null, placeholder: null, autoComplete: "address-line1", width: "full", required: false, min: null, max: null, step: null },
      { key: "city", label: "City", help: null, kind: "text", options: null, placeholder: null, autoComplete: "address-level2", width: "half", required: false, min: null, max: null, step: null },
      { key: "region", label: "State", help: null, kind: "text", options: null, placeholder: null, autoComplete: "address-level1", width: "half", required: false, min: null, max: null, step: null },
    ],
    ...extra,
  };
}

export function settings(sections: SettingsSectionWire[] = [companySection()]): SettingsWire {
  return { sections };
}

export function adminRow(extra: Partial<AdminCompanyRowWire> = {}): AdminCompanyRowWire {
  return {
    id: "t-summit",
    name: "Summit Window Co.",
    slug: "summit-window-co",
    kind: "org",
    status: "active",
    createdAt: "2026-10-12T15:00:00.000Z",
    members: 2,
    owner: { userId: "u-olivia", email: "olivia@summitwindows.test", name: "Olivia" },
    ...extra,
  };
}

export function adminDetail(extra: Partial<AdminCompanyDetailWire> = {}, company: Partial<AdminCompanyDetailWire["company"]> = {}): AdminCompanyDetailWire {
  return {
    company: {
      ...adminRow(),
      publicPath: "/t/summit-window-co",
      logoUrl: null,
      brandColor: "#0f766e",
      createdBy: { userId: "u-olivia", email: "olivia@summitwindows.test", name: "Olivia" },
      ownerDeleted: false,
      suspendedAt: null,
      suspendedReason: null,
      suspendedBy: null,
      timeZone: "America/Denver",
      contactEmail: "office@summitwindows.test",
      contactPhone: "(801) 555-0143",
      ...company,
    },
    members: [
      { userId: "u-olivia", name: "Olivia", email: "olivia@summitwindows.test", roleKey: "owner", roleName: "Owner", isOwner: true, status: "active", joinedAt: "2026-10-12T15:00:00.000Z" },
      { userId: "u-sam", name: "Sam Lee", email: "sam@summitwindows.test", roleKey: "member", roleName: "Member", isOwner: false, status: "active", joinedAt: "2026-10-12T16:00:00.000Z" },
    ],
    pendingInvitations: 1,
    invitations: [{ email: "rae@summitwindows.test", roleName: "Member", invitedBy: "Olivia", expiresAt: "2026-10-19T15:00:00.000Z" }],
    retiredAddresses: [],
    activity: [
      { at: "2026-10-12T15:00:00.000Z", action: "company.created", label: "Created a company", actor: "Olivia", sensitive: false, detail: null },
      { at: "2026-10-12T17:00:00.000Z", action: "company.ownership.transferred", label: "Handed ownership of the company to someone else", actor: "Olivia", sensitive: true, detail: "Sam Lee" },
    ],
    can: { suspend: true, assignOwner: true, releaseAddresses: true },
    ...extra,
  };
}

export function person(extra: Partial<AdminPersonWire> = {}): AdminPersonWire {
  return {
    userId: "u-olivia",
    email: "olivia@summitwindows.test",
    name: "Olivia",
    createdAt: "2026-10-12T15:00:00.000Z",
    companies: 1,
    staffRole: null,
    isYou: false,
    canChange: true,
    ...extra,
  };
}

export function people(extra: Partial<AdminPeopleWire> = {}): AdminPeopleWire {
  return {
    people: [
      person({ userId: "u-ava", email: "ava@igloo.test", name: "Ava", staffRole: { key: "admin", name: "Administrator", rank: 30 }, isYou: true, canChange: false }),
      person(),
    ],
    total: 2,
    page: 1,
    pageSize: 25,
    roles: [
      { key: "admin", name: "Administrator", rank: 30, assignable: false },
      { key: "cs_lead", name: "Customer service lead", rank: 20, assignable: true },
      { key: "cs_agent", name: "Customer service agent", rank: 10, assignable: true },
    ],
    you: { userId: "u-ava", roleKey: "admin" },
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
      await act(async () => root.render(next));
      await settle();
    },
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

/** Advance real time by `ms` inside act (debounces are real timers here). */
export async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  await settle();
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

export async function check(element: Element | null | undefined, checked: boolean): Promise<void> {
  if (!element) throw new Error("check: no element");
  const input = element as HTMLInputElement;
  if (input.checked !== checked) await click(input);
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

/** The first button whose text (or aria-label) is, or includes, `text`. */
export function button(container: ParentNode, text: string): HTMLButtonElement | null {
  const all = [...container.querySelectorAll<HTMLButtonElement>("button")];
  return (
    all.find((b) => clean(b.textContent) === text) ??
    all.find((b) => clean(b.textContent).includes(text) || (b.getAttribute("aria-label") ?? "").includes(text)) ??
    null
  );
}

export function link(container: ParentNode, text: string): HTMLAnchorElement | null {
  return [...container.querySelectorAll<HTMLAnchorElement>("a")].find((a) => clean(a.textContent).includes(text)) ?? null;
}

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
}

/** The text a person reads, whitespace collapsed (Intl's narrow spaces too). */
export function text(element: Element | null | undefined): string {
  return clean(element?.textContent);
}

/** What a screen reader says for an element: its text without the aria-hidden parts. */
export function spoken(element: Element | null | undefined): string {
  if (!element) return "";
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return clean(copy.textContent);
}

/** The control a <label> whose text starts with `label` points at. */
export function labelled(container: ParentNode, label: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null {
  const labels = [...container.querySelectorAll("label")];
  const match = labels.find((l) => text(l).startsWith(label));
  const id = match?.getAttribute("for");
  if (id) return container.querySelector(`[id="${id}"]`) as HTMLInputElement | null;
  return (match?.querySelector("input, select, textarea") as HTMLInputElement | null) ?? null;
}

/** The dialog on screen, if any. */
export function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}
