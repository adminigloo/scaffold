import { authSchema } from "@adminigloo/auth/schema";
import { definePermissions, STAFF_ROLE_TEMPLATES, type BootstrapPolicy } from "@adminigloo/permissions";
import { permissionsSchema } from "@adminigloo/permissions/schema";
import { assignRoleTemplate, seedPermissionCatalog } from "@adminigloo/permissions/server";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import { tenancyPermissions, TENANCY_STAFF_PERMISSION_KEYS } from "../permissions.js";
import { tenancySchema } from "../schema.js";
import { TENANT_ROLE_TEMPLATES } from "../templates.js";
import {
  createTenancyHandlers,
  createTenancyOperatorHandlers,
  createTenancyService,
  type CreateTenancyServiceOptions,
  type LogoStore,
  type TenancyAuditEvent,
  type TenancyService,
} from "../server.js";
import { createTestDb, type TestDb } from "./pglite.js";

/**
 * The shared fixture for the ./server suites: a real Postgres (PGlite) holding
 * auth's `users`, the tenancy tables and the permissions tables, the catalogs
 * 13.2 names, and a service with an in-memory audit sink.
 *
 * Not a suite.
 */

export const tenantCatalog = definePermissions("tenant", { ...tenancyPermissions });
export const staffCatalog = definePermissions(
  "staff",
  Object.fromEntries(
    TENANCY_STAFF_PERMISSION_KEYS.map((key) => [
      key,
      {
        label: key,
        defaultFor:
          key === "staff.tenants.view" || key === "staff.people.view"
            ? ["admin", "cs_lead", "cs_agent"]
            : key === "staff.roles.view"
              ? ["admin", "cs_lead"]
              : ["admin"],
      },
    ]),
  ),
);

export interface Harness {
  readonly t: TestDb;
  readonly db: TestDb["db"];
  readonly tenancy: TenancyService;
  readonly audit: TenancyAuditEvent[];
  readonly logos: FakeLogos;
  readonly clock: { now: Date };
  seed(): Promise<void>;
  /** A user row as the webhook or the page mirror writes it (verified email), then provisioned. */
  user(email: string, opts?: { name?: string; provision?: boolean }): Promise<string>;
  /** A company owned by `ownerId`, with members at the given roles. */
  company(ownerId: string, name: string, members?: Record<string, "admin" | "member" | "viewer">): Promise<string>;
  /** Give someone a staff role directly (a system act). */
  staff(userId: string, key: "admin" | "cs_lead" | "cs_agent"): Promise<void>;
  close(): Promise<void>;
}

export interface FakeLogos extends LogoStore {
  readonly stored: Map<string, { bytes: Uint8Array; contentType: string }>;
  readonly deleted: string[];
  readonly puts: string[];
  failNextPut?: boolean;
}

export function fakeLogos(): FakeLogos {
  const stored = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const deleted: string[] = [];
  const puts: string[] = [];
  const store: FakeLogos = {
    stored,
    deleted,
    puts,
    async put(input) {
      puts.push(input.pathname);
      stored.set(input.pathname, { bytes: input.bytes, contentType: input.contentType });
      return { url: `https://blob.test/${input.pathname}`, key: input.pathname };
    },
    async delete(key) {
      deleted.push(key);
      stored.delete(key);
    },
  };
  return store;
}

let counter = 0;

export async function harness(
  options: Partial<
    Pick<CreateTenancyServiceOptions, "mode" | "seats" | "invitations" | "onEvent" | "onEventError" | "reservedSlugs" | "checklist" | "settings" | "companiesPerAccount">
  > & {
    readonly bootstrap?: BootstrapPolicy;
    readonly seed?: boolean;
    readonly logos?: boolean;
    readonly audit?: CreateTenancyServiceOptions["audit"];
  } = {},
): Promise<Harness> {
  const t = await createTestDb({ ...authSchema, ...tenancySchema, ...permissionsSchema });
  const audit: TenancyAuditEvent[] = [];
  const logos = fakeLogos();
  const clock = { now: new Date("2026-10-12T15:00:00.000Z") };
  let closed = false;
  const tenancy = createTenancyService({
    db: t.db,
    mode: options.mode ?? "companies",
    tenantCatalog,
    bootstrap: options.bootstrap ?? { mode: "off" },
    noun: { singular: "company", plural: "companies" },
    ...(options.seats ? { seats: options.seats } : {}),
    ...(options.invitations ? { invitations: options.invitations } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.onEventError ? { onEventError: options.onEventError } : {}),
    ...(options.reservedSlugs ? { reservedSlugs: options.reservedSlugs } : {}),
    ...(options.checklist ? { checklist: options.checklist } : {}),
    ...(options.settings ? { settings: options.settings } : {}),
    ...(options.companiesPerAccount !== undefined ? { companiesPerAccount: options.companiesPerAccount } : {}),
    ...(options.logos === false ? {} : { logos }),
    audit:
      options.audit ??
      (async (_tx, event) => {
        audit.push(event);
      }),
    now: () => clock.now,
  });
  const h: Harness = {
    t,
    db: t.db,
    tenancy,
    audit,
    logos,
    clock,
    async seed() {
      await seedPermissionCatalog(t.db, {
        staff: { catalog: staffCatalog, templates: STAFF_ROLE_TEMPLATES },
        tenant: { catalog: tenantCatalog, templates: TENANT_ROLE_TEMPLATES },
      });
    },
    async user(email, opts = {}) {
      counter += 1;
      const id = `u_${email.split("@")[0]}_${counter}`;
      await t.db.execute(sql`insert into users (id, identity_provider, external_id, email, display_name)
        values (${id}, 'clerk', ${`user_${id}`}, ${email.toLowerCase()}, ${opts.name ?? null})`);
      if (opts.provision !== false) await tenancy.provisionUser({ userId: id, email: email.toLowerCase() });
      return id;
    },
    async company(ownerId, name, members = {}) {
      counter += 1;
      const out = await tenancy.createCompany({ userId: ownerId, name, requestKey: `key-${counter}-${ownerId.replace(/[^A-Za-z0-9-]/g, "")}`, purpose: "additional" });
      for (const [userId, role] of Object.entries(members)) {
        await t.db.execute(sql`insert into tenant_members (tenant_id, user_id, status) values (${out.company.id}, ${userId}, 'active')`);
        await assignRoleTemplate(t.db, { scope: "tenant", tenantId: out.company.id, principalId: userId, templateKey: role, actor: { system: "test" } });
      }
      return out.company.id;
    },
    async staff(userId, key) {
      await assignRoleTemplate(t.db, { scope: "staff", principalId: userId, templateKey: key, actor: { system: "test" } });
    },
    // Idempotent: an afterEach may close a harness a test already closed.
    close: async () => {
      if (closed) return;
      closed = true;
      await t.close();
    },
  };
  if (options.seed !== false) await h.seed();
  return h;
}

/** D4: owner_user_id is the single holder of the owner template, after every mutation. */
export async function assertOwnerInvariant(db: TestDb["db"], tenantId: string): Promise<void> {
  const owner = await db.execute(sql`select owner_user_id from tenants where id = ${tenantId}`);
  const holders = await db.execute(sql`
    select pr.principal_id from principal_role pr join role_template rt on rt.id = pr.template_id
    where pr.scope = 'tenant' and pr.tenant_id = ${tenantId} and rt.key = 'owner'`);
  const ownerId = (owner.rows[0] as { owner_user_id: string | null } | undefined)?.owner_user_id ?? null;
  expect(holders.rows.map((r: unknown) => (r as { principal_id: string }).principal_id)).toEqual(ownerId ? [ownerId] : []);
}

/** Run a service call and return the TenancyError code it threw, or "ok". */
export async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && (error as { name?: string }).name === "TenancyError") return code;
    throw error;
  }
}

/** Handlers wired to the harness with a fake principal per request (the `x-test-user` header). */
export function handlersFor(h: Harness, extra: Partial<Parameters<typeof createTenancyHandlers>[0]> = {}) {
  const emailOf = async (userId: string) => {
    const r = await h.db.execute(sql`select email from users where id = ${userId}`);
    return ((r.rows[0] as { email?: string | null } | undefined)?.email ?? null) as string | null;
  };
  const principal = async (req: Request) => {
    const userId = req.headers.get("x-test-user");
    return userId ? { userId, email: await emailOf(userId) } : null;
  };
  const company = createTenancyHandlers({
    tenancy: h.tenancy,
    principal,
    verifiedEmails: async (req) => {
      const userId = req.headers.get("x-test-user");
      const email = userId ? await emailOf(userId) : null;
      return email ? [email] : [];
    },
    invitationUrl: (token) => `https://app.test/invite/${token}`,
    ...extra,
  });
  const operator = createTenancyOperatorHandlers({ tenancy: h.tenancy, principal });
  return { company, operator };
}

/** A request as a same-origin browser would send it. */
export function call(
  handlers: { handle(req: Request): Promise<Response> },
  userId: string | null,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      ...(userId ? { "x-test-user": userId } : {}),
      ...(method === "POST" ? { "content-type": "application/json", "sec-fetch-site": "same-origin" } : {}),
      ...headers,
    },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  };
  return handlers.handle(new Request(`https://app.test/api/tenancy/${path}`, init));
}

export async function jsonOf<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
