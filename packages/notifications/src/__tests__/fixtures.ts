import { and, asc, eq } from "drizzle-orm";
import { createNotificationHandlers, type CreateNotificationHandlersOptions } from "../handlers.js";
import { createNotifications } from "../instance.js";
import { defineAlertKinds, defineAlertRegistry } from "../registry.js";
import type {
  AlertDraft,
  AlertEmailMessage,
  AlertEmailOutcome,
  AlertPerson,
  CreateNotificationsOptions,
  Notifications,
} from "../types.js";
import type { TestDb } from "./pglite.js";

/**
 * The test world: the 2a packages' kinds as their fragments will declare them
 * (structurally, 3.2), a company directory the `people` seam answers from,
 * and an email seam that records what it was handed.
 */

export const estimatorKinds = defineAlertKinds({
  routings: [{ key: "estimates", label: "New estimate requests and quote answers", permission: "estimates.view", order: 1 }],
  kinds: [
    {
      key: "estimator.lead",
      label: "Someone asks for an estimate",
      category: "Estimates",
      audience: { permission: "estimates.view", routing: "estimates" },
      defaultChannel: "email",
      emailBy: "producer",
      order: 1,
    },
    {
      key: "estimator.quote.accepted",
      label: "A customer accepts a quote",
      category: "Estimates",
      audience: { permission: "estimates.view", routing: "estimates" },
      defaultChannel: "email",
      emailBy: "producer",
      order: 2,
    },
  ],
});

export const schedulingKinds = defineAlertKinds({
  routings: [{ key: "visits", label: "Visit requests and customer changes", permission: "schedule.view", order: 2 }],
  kinds: [
    {
      key: "scheduling.visit.requested",
      label: "A customer asks for a visit",
      category: "Visits",
      audience: { permission: "schedule.view", routing: "visits" },
      defaultChannel: "email",
      emailBy: "producer",
      order: 1,
    },
    {
      key: "scheduling.visit.moved",
      label: "A customer moves a visit",
      category: "Visits",
      audience: { permission: "schedule.view", routing: "visits", assigned: { permission: "schedule.route" } },
      defaultChannel: "email",
      emailBy: "producer",
      order: 2,
    },
    {
      key: "scheduling.request.expiring",
      label: "A visit request is about to lapse",
      category: "Visits",
      audience: { permission: "schedule.view", routing: "visits" },
      defaultChannel: "in_app",
      order: 3,
    },
  ],
});

export const invoicingKinds = defineAlertKinds({
  routings: [{ key: "invoices", label: "Invoices opened, paid or overdue", permission: "invoices.view", order: 3 }],
  kinds: [
    {
      key: "invoicing.invoice.paid",
      label: "An invoice is paid in full",
      category: "Invoices",
      audience: { permission: "invoices.view", routing: "invoices" },
      defaultChannel: "email",
    },
  ],
});

export const commsKinds = defineAlertKinds({
  kinds: [
    {
      key: "comms.message.failed",
      label: "An email to a customer didn't go",
      category: "Messages",
      audience: { permission: "comms.view" },
      defaultChannel: "in_app",
      email: false,
    },
  ],
});

export const tenancyKinds = defineAlertKinds({
  kinds: [
    {
      key: "tenancy.member.joined",
      label: "Someone joins the team",
      category: "Team",
      audience: { permission: "members.invite" },
      defaultChannel: "in_app",
    },
  ],
});

export const REGISTRY = defineAlertRegistry([tenancyKinds, schedulingKinds, estimatorKinds, invoicingKinds, commsKinds]);

/** The tenant role templates' permissions, as a create-app project's catalog would grant them. */
export const ROLE_PERMISSIONS = {
  owner: ["alerts.view", "alerts.manage", "estimates.view", "schedule.view", "schedule.route", "invoices.view", "comms.view", "members.invite"],
  admin: ["alerts.view", "alerts.manage", "estimates.view", "schedule.view", "schedule.route", "invoices.view", "comms.view", "members.invite"],
  member: ["alerts.view", "estimates.view", "schedule.view", "invoices.view", "comms.view"],
  viewer: ["alerts.view", "estimates.view", "schedule.view", "invoices.view", "comms.view"],
  crew: ["alerts.view", "schedule.route"],
  // A role a foreign host might have: sees invoices, on no alert list by default.
  bookkeeper: ["alerts.view", "invoices.view"],
} as const satisfies Record<string, readonly string[]>;

export type Role = keyof typeof ROLE_PERMISSIONS;

export interface Member {
  userId: string;
  name: string | null;
  email: string | null;
  role: Role;
}

/** Companies and who is in them: what the host's `people` answers from. */
export class Directory {
  readonly companies = new Map<string, Member[]>();
  readonly suspended = new Set<string>();
  readonly asked: { tenantId: string; permission: string }[] = [];
  failPeople = false;

  add(tenantId: string, member: Member): Member {
    const list = this.companies.get(tenantId) ?? [];
    list.push(member);
    this.companies.set(tenantId, list);
    return member;
  }

  remove(tenantId: string, userId: string): void {
    this.companies.set(
      tenantId,
      (this.companies.get(tenantId) ?? []).filter((m) => m.userId !== userId),
    );
  }

  member(tenantId: string, userId: string): Member | undefined {
    return this.companies.get(tenantId)?.find((m) => m.userId === userId);
  }

  permissionsOf(tenantId: string, userId: string): string[] {
    const m = this.member(tenantId, userId);
    return m ? [...ROLE_PERMISSIONS[m.role]] : [];
  }

  /** The `people` seam: active members holding `permission`; a suspended company has none. */
  people = async (tenantId: string, permission: string): Promise<readonly AlertPerson[]> => {
    this.asked.push({ tenantId, permission });
    if (this.failPeople) throw new Error("the member list is down");
    if (this.suspended.has(tenantId)) return [];
    return (this.companies.get(tenantId) ?? [])
      .filter((m) => (ROLE_PERMISSIONS[m.role] as readonly string[]).includes(permission))
      .map((m) => ({ userId: m.userId, name: m.name, email: m.email, isOwner: m.role === "owner" }));
  };
}

/** A company with an owner (Gail), an admin (Ada), a member (Mo), a viewer (Vi) and a crew member (Cam). */
export function greenAcres(directory: Directory, tenantId: string) {
  const short = tenantId.replace(/[^a-z0-9]/gi, "").slice(-6);
  const person = (key: string, name: string, role: Role) =>
    directory.add(tenantId, { userId: `${key}-${short}`, name, email: `${key}-${short}@greenacres.test`, role });
  return {
    owner: person("gail", "Gail Owner", "owner"),
    admin: person("ada", "Ada Admin", "admin"),
    member: person("mo", "Mo Member", "member"),
    viewer: person("vi", "Vi Viewer", "viewer"),
    crew: person("cam", "Cam Crew", "crew"),
  };
}

export interface CapturedEmail extends AlertEmailMessage {}

/** The host's email seam: records each message and answers from `answer` (default: sent). */
export class Mailbox {
  readonly sent: CapturedEmail[] = [];
  answer: (message: AlertEmailMessage) => AlertEmailOutcome | Promise<AlertEmailOutcome> = () => ({ status: "sent" });

  email = async (message: AlertEmailMessage): Promise<AlertEmailOutcome> => {
    this.sent.push(message);
    return this.answer(message);
  };

  to(address: string): CapturedEmail[] {
    return this.sent.filter((m) => m.to.toLowerCase() === address.toLowerCase());
  }
}

export interface World {
  directory: Directory;
  mailbox: Mailbox;
  errors: { error: unknown; context: { tenantId: string | null; kind?: string; step: string } }[];
  alerts: Notifications;
  clock: { now: Date };
}

/** An instance over `t` with the test world; `overrides` replace any option. */
export function world(t: TestDb, overrides: Partial<CreateNotificationsOptions> = {}, directory = new Directory()): World {
  const mailbox = new Mailbox();
  const errors: World["errors"] = [];
  const clock = { now: new Date("2026-10-15T15:00:00.000Z") };
  const alerts = createNotifications({
    db: t.db,
    tables: t.tables,
    registry: REGISTRY,
    people: directory.people,
    email: mailbox.email,
    now: () => clock.now,
    onError: (error, context) => errors.push({ error, context }),
    ...overrides,
  });
  return { directory, mailbox, errors, alerts, clock };
}

let drafts = 0;
/** A draft of `kind` for `tenantId`, with a fresh dedupe key unless one is given. */
export function draft(tenantId: string, kind: string, extra: Partial<AlertDraft> = {}): AlertDraft {
  drafts += 1;
  return {
    tenantId,
    kind,
    title: `Pat Rivera asked for an estimate (${drafts})`,
    body: "Front walk, 3 steps.\nCall after 5.",
    href: `/app/estimates/est-${drafts}`,
    dedupeKey: `${kind}:fact-${drafts}`,
    subject: { type: "estimator.estimate", id: `est-${drafts}` },
    actorUserId: null,
    ...extra,
  };
}

/** Every alert row of a company, oldest first, in the package's own words. */
export async function rowsOf(t: TestDb, tenantId: string) {
  const A = t.tables.alerts;
  return (await t.db
    .select()
    .from(A)
    .where(eq(A.tenantId, tenantId))
    .orderBy(asc(A.createdAt), asc(A.id))) as (typeof A.$inferSelect)[];
}

/** One person's rows in a company. */
export async function rowsFor(t: TestDb, tenantId: string, recipientId: string) {
  const A = t.tables.alerts;
  return (await t.db
    .select()
    .from(A)
    .where(and(eq(A.tenantId, tenantId), eq(A.recipientId, recipientId)))
    .orderBy(asc(A.createdAt), asc(A.id))) as (typeof A.$inferSelect)[];
}

/**
 * The handlers mounted the way create-app mounts them: the company in the
 * path (`/api/app/{company}/alerts/…`), the person in a header the fake
 * session reads, `authorize` answering from the directory (a non-member gets
 * the company gate's own 403 Response, as 2a's seams do).
 */
export function mount(w: World, options: Partial<CreateNotificationHandlersOptions> = {}) {
  const asked: { permission: string; tenantId: string; user: string | null }[] = [];
  const reported: { tenantId: string | null; route: string; error: unknown }[] = [];
  const handlers = createNotificationHandlers({
    notifications: w.alerts,
    resolveTenant: (req) => /\/api\/app\/([^/]+)\/alerts\//.exec(new URL(req.url).pathname)?.[1] ?? null,
    authorize: (req, permission, tenantId) => {
      const user = req.headers.get("x-user");
      asked.push({ permission, tenantId, user });
      if (!user || !w.directory.member(tenantId, user)) {
        return new Response(JSON.stringify({ error: { code: "forbidden", message: "You're not part of this company." } }), { status: 403 });
      }
      return w.directory.permissionsOf(tenantId, user).includes(permission) ? { userId: user } : false;
    },
    links: { inbox: "/app/alerts", settings: "/app/alerts/settings", messages: "/app/messages" },
    onError: (error, context) => reported.push({ ...context, error }),
    ...options,
  });
  const request = (
    tenantId: string,
    path: string,
    init: { method?: string; body?: unknown; user?: string | null; headers?: Record<string, string>; query?: Record<string, string> } = {},
  ) => {
    const query = init.query ? `?${new URLSearchParams(init.query)}` : "";
    const method = init.method ?? "GET";
    return new Request(`https://app.test/api/app/${tenantId}/alerts/${path}${query}`, {
      method,
      headers: {
        "sec-fetch-site": "same-origin",
        ...(init.user ? { "x-user": init.user } : {}),
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      ...(method === "POST" ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body ?? {}) } : {}),
    });
  };
  const call = async (tenantId: string, path: string, init: Parameters<typeof request>[2] = {}) => {
    const res = await handlers.handle(request(tenantId, path, init));
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  };
  return { handlers, request, call, asked, reported };
}

/** A reader as the handlers would build it from the directory. */
export function readerOf(directory: Directory, tenantId: string, userId: string) {
  return { tenantId, userId, permissions: directory.permissionsOf(tenantId, userId) };
}
