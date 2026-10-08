import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AudienceError,
  createAudience,
  createDrizzleAudienceStore,
  type AudienceStore,
  type AudienceUser,
  type BackfillAdapter,
  type CreateDrizzleAudienceOptions,
  type RowsSource,
} from "../index.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The instance over the real Drizzle store, on PGlite: intake marks, links in
 * both modes, preview → apply → remove round trips that restore the numbers
 * EXACTLY, idempotency, the breakdown adding up, and the counted fragment
 * working inside an app's own raw SQL.
 *
 * Each test gets its own tenant and its own app sessions table, so the shared
 * database never leaks numbers between tests.
 */

const SECRET = "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
/** Request headers with no privacy opt-out: a link may be written. */
const OPEN = {} as const;
const DAY = 86_400_000;
const NOW = new Date("2026-10-08T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

interface User extends AudienceUser {
  role?: "staff" | "analytics" | "customer";
}

let tdb: TestDb;
beforeAll(async () => {
  tdb = await createTestDb();
});
afterAll(async () => {
  await tdb?.close();
});

let tableCounter = 0;
/** A fresh app sessions table (Riddler Go's shape), seeded: [visitor, daysAgo][]. */
async function sessionsTable(rows: Array<[string, number]> = []): Promise<RowsSource> {
  tableCounter += 1;
  const table = `app_sessions_${tableCounter}`;
  await tdb.client.exec(`CREATE TABLE ${table} (id text PRIMARY KEY, visitor_id text NOT NULL, created_at timestamptz NOT NULL)`);
  await addSessions(table, rows);
  return { table, visitor: "visitor_id", time: "created_at", id: "id" };
}

let sessionCounter = 0;
async function addSessions(table: string, rows: Array<[string, number]>): Promise<void> {
  for (const [visitor, ago] of rows) {
    sessionCounter += 1;
    await tdb.client.query(`INSERT INTO ${table} (id, visitor_id, created_at) VALUES ($1, $2, $3)`, [
      `s${sessionCounter}`,
      visitor,
      daysAgo(ago).toISOString(),
    ]);
  }
}

function make(options: Partial<CreateDrizzleAudienceOptions<User>> & { users?: User[] } = {}) {
  const { users = [], ...rest } = options;
  const errors: unknown[] = [];
  const annotations: string[] = [];
  const audience = createAudience<User>({
    store: createDrizzleAudienceStore({ db: tdb.db, tables: tdb.tables }),
    secret: SECRET,
    tenantId: tenant(),
    isInternal: (user) => (user.role === "staff" || user.role === "analytics" ? `platform role: ${user.role}` : false),
    listUsers: () => users,
    getUser: async (id) => users.find((user) => user.id === id) ?? null,
    now: () => NOW,
    onError: (error) => errors.push(error),
    annotate: ({ label }) => {
      annotations.push(label);
    },
    ...rest,
  });
  return { audience, errors, annotations };
}

async function counted(audience: ReturnType<typeof make>["audience"], rows: RowsSource, includeInternal = false): Promise<number> {
  const result = await tdb.db.execute(
    sql`SELECT count(*)::int AS n FROM ${sql.raw(rows.table)} s WHERE ${audience.countedVisitorSql("s.visitor_id", {
      time: "s.created_at",
      session: "s.id",
      includeInternal,
    })}`,
  );
  return Number((result as unknown as { rows: Array<{ n: number }> }).rows[0]!.n);
}

async function allRows(tenantId: string) {
  const out: Record<string, unknown[]> = {};
  for (const [name, table] of Object.entries({ rules: "aig_audience_rules", marks: "aig_audience_marks", links: "aig_audience_links", runs: "aig_audience_runs" })) {
    out[name] = (await tdb.client.query(`SELECT * FROM ${table} WHERE tenant_id = $1`, [tenantId])).rows;
  }
  return out;
}

describe("intake: observe() marks internal visitors as they arrive", () => {
  it("a staff user is marked (visitor and user); a customer is not; a second beacon writes nothing new", async () => {
    const staff: User = { id: "u_staff", email: "sam@riddlergo.com", role: "staff" };
    const customer: User = { id: "u_cust", email: "pat@gmail.com", role: "customer" };
    const { audience, errors } = make({ users: [staff, customer] });

    expect(await audience.observe({ visitorId: "v_staff", user: staff, host: "riddlergo.com", userAgent: CHROME })).toBe("role");
    expect(await audience.observe({ visitorId: "v_cust", user: customer, host: "riddlergo.com", userAgent: CHROME })).toBeNull();
    expect(await audience.observe({ visitorId: "v_staff", user: staff, host: "riddlergo.com", userAgent: CHROME })).toBe("role");

    const marks = (await allRows(audience.tenantId)).marks as Array<Record<string, unknown>>;
    expect(marks.map((m) => [m.subject_kind, m.subject_id, m.reason, m.source, m.rule_id]).sort()).toEqual([
      ["user", "u_staff", "role", "ingest", null],
      ["visitor", "v_staff", "role", "ingest", null],
    ]);
    expect(errors).toEqual([]);
  });

  it("the defaults work with no configuration: test sign-ups, automation, the smoke header, local hosts, the app's flag", async () => {
    const { audience } = make({ isInternal: undefined });
    const ok = { host: "riddlergo.com", userAgent: CHROME };
    expect(await audience.observe({ visitorId: "v1", email: "dallin+clerk_test@example.com", ...ok })).toBe("domain");
    expect(await audience.observe({ visitorId: "v2", email: "qa+clerk_test@gmail.com", ...ok })).toBe("pattern");
    expect(await audience.observe({ visitorId: "v3", host: "riddlergo.com", userAgent: "Mozilla/5.0 HeadlessChrome/129.0" })).toBe("automation");
    expect(await audience.observe({ visitorId: "v4", ...ok, headers: { "x-aig-audience": audience.testHeader!.value } })).toBe("automation");
    expect(await audience.observe({ visitorId: "v5", url: "http://localhost:3000/pricing", userAgent: CHROME })).toBe("non_production");
    expect(await audience.observe({ visitorId: "v6", ...ok, nonProduction: true })).toBe("non_production");
    expect(await audience.observe({ visitorId: "v7", ...ok, webdriver: true })).toBe("automation");
    expect(await audience.observe({ visitorId: "v8", host: "riddlergo.com", userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" })).toBe("bot");
    expect(await audience.observe({ visitorId: "v9", ...ok, headers: { "x-aig-audience": "nope" } })).toBeNull();
    // The old public value is not the secret: anyone could send it.
    expect(await audience.observe({ visitorId: "v10", ...ok, headers: { "x-aig-audience": "test" } })).toBeNull();
  });

  it("a secret smoke-test value replaces the default one", async () => {
    const { audience } = make({ testHeader: { value: "s3cret-smoke" } });
    expect(await audience.observe({ visitorId: "v1", host: "x.io", userAgent: CHROME, headers: { "x-aig-audience": "test" } })).toBeNull();
    expect(await audience.observe({ visitorId: "v2", host: "x.io", userAgent: CHROME, headers: { "x-aig-audience": "s3cret-smoke" } })).toBe("automation");
  });

  it("a network rule is checked in memory: the IP is stored nowhere, and there is no column to store it in", async () => {
    const { audience } = make();
    const { rule } = await audience.addRule({ kind: "network", value: "203.0.113.0/24", reasonLabel: "Office" }, { by: "dallin" });
    expect(await audience.observe({ visitorId: "v_office", host: "x.io", userAgent: CHROME, ip: "203.0.113.42" })).toBe("network");
    expect(await audience.observe({ visitorId: "v_home", host: "x.io", userAgent: CHROME, headers: { "x-forwarded-for": "203.0.113.43, 10.0.0.1" } })).toBe("network");
    expect(await audience.observe({ visitorId: "v_other", host: "x.io", userAgent: CHROME, ip: "198.51.100.7" })).toBeNull();
    const dump = JSON.stringify(await allRows(audience.tenantId));
    expect(dump).not.toContain("203.0.113.42");
    expect(dump).not.toContain("203.0.113.43");
    expect(dump).not.toContain("198.51.100.7");
    const columns = (
      await tdb.client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name LIKE 'aig_audience_%'`,
      )
    ).rows.map((row) => row.column_name);
    expect(columns.filter((name) => /(^|_)(ip|addr|address|user_agent|ua|host)(_|$)/.test(name))).toEqual([]);
    // The intake mark belongs to the rule, so removing the rule takes it away.
    const marks = (await allRows(audience.tenantId)).marks as Array<Record<string, unknown>>;
    expect(marks.filter((m) => m.subject_id === "v_office").map((m) => m.rule_id)).toEqual([rule.id]);
  });

  it("never throws: a broken store degrades to the defaults and reports the failure", async () => {
    const broken = new Proxy({} as AudienceStore, {
      get: (_, prop) => (prop === "marksTable" ? undefined : async () => {
        throw new Error("database down");
      }),
    });
    const errors: unknown[] = [];
    const audience = createAudience({ store: broken, secret: SECRET, onError: (error) => errors.push(error) });
    expect(await audience.observe({ visitorId: "v", host: "x.io", userAgent: "HeadlessChrome" })).toBe("automation");
    expect(await audience.observe({ visitorId: "v", host: "x.io", userAgent: CHROME })).toBeNull();
    expect(await audience.classifyActor({ userId: "u" })).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it("classifyActor: an internal org's server event marks the visitor; the app still writes its event", async () => {
    const { audience } = make();
    await audience.addRule({ kind: "org", value: "org_staff" }, { by: "dallin" });
    expect(await audience.classifyActor({ orgId: "org_staff", visitorId: "v_pub" })).toMatchObject({ reason: "org" });
    expect(await audience.classifyActor({ orgId: "org_customer", visitorId: "v_cust" })).toBeNull();
    expect(await audience.classifyActor({ userId: "u_staff", visitorId: "v_s" })).toBeNull();
    const marks = (await allRows(audience.tenantId)).marks as Array<Record<string, unknown>>;
    expect(marks.filter((m) => m.subject_kind === "visitor").map((m) => m.subject_id).sort()).toEqual(["v_pub"]);
  });

  it("classifyActor looks a user up by id when the app provides getUser", async () => {
    const staff: User = { id: "u_s", email: "s@x.io", role: "staff" };
    const { audience } = make({ users: [staff] });
    expect(await audience.classifyActor({ userId: "u_s", visitorId: "v_s" })).toMatchObject({ reason: "role", detail: "platform role: staff" });
  });
});

describe("links", () => {
  const customer: User = { id: "user_customer_42", email: "pat@gmail.com", role: "customer" };
  const staff: User = { id: "user_staff_7", email: "sam@riddlergo.com", role: "staff" };

  it("pseudonymous: every signed-in visitor is linked — by an HMAC, never the user id", async () => {
    const { audience } = make({ link: "pseudonymous", users: [customer, staff] });
    await audience.observe({ visitorId: "v_c", user: customer, host: "x.io", userAgent: CHROME, headers: OPEN });
    await audience.observe({ visitorId: "v_s", user: staff, host: "x.io", userAgent: CHROME, headers: OPEN });
    await audience.observe({ visitorId: "v_anon", host: "x.io", userAgent: CHROME, headers: OPEN });
    const links = (await allRows(audience.tenantId)).links as Array<Record<string, unknown>>;
    expect(links.map((l) => l.visitor_id).sort()).toEqual(["v_c", "v_s"]);
    const dump = JSON.stringify(links);
    expect(dump).not.toContain("user_customer_42");
    expect(dump).not.toContain("user_staff_7");
    expect(dump).not.toContain("pat@gmail.com");
    expect(links.find((l) => l.visitor_id === "v_c")!.user_key).toBe(audience.userKey(customer.id));
  });

  it("internal-only: only internal people are linked", async () => {
    const { audience } = make({ link: "internal-only", users: [customer, staff] });
    await audience.observe({ visitorId: "v_c", user: customer, host: "x.io", userAgent: CHROME, headers: OPEN });
    await audience.observe({ visitorId: "v_s", user: staff, host: "x.io", userAgent: CHROME, headers: OPEN });
    const links = (await allRows(audience.tenantId)).links as Array<Record<string, unknown>>;
    expect(links.map((l) => l.visitor_id)).toEqual(["v_s"]);
  });

  it("a browser sending Global Privacy Control or Do Not Track is never linked", async () => {
    const { audience } = make({ link: "pseudonymous", users: [customer] });
    await audience.observe({ visitorId: "v_gpc", user: customer, host: "x.io", userAgent: CHROME, headers: { "sec-gpc": "1" } });
    await audience.observe({ visitorId: "v_dnt", user: customer, host: "x.io", userAgent: CHROME, headers: new Headers({ dnt: "1" }) });
    expect((await allRows(audience.tenantId)).links).toEqual([]);
  });
});

describe("cleaning history: preview → apply → remove", () => {
  it("a person named later: preview writes nothing, apply cleans their anonymous past exactly, remove restores it exactly", async () => {
    const rachel: User = { id: "u_rachel", email: "Rachel.Smith@gmail.com", role: "customer" };
    const pat: User = { id: "u_pat", email: "pat@gmail.com", role: "customer" };
    const rows = await sessionsTable([
      ["v_rachel_laptop", 120],
      ["v_rachel_laptop", 60],
      ["v_rachel_laptop", 10],
      ["v_rachel_phone", 5],
      ["v_rachel_phone", 1],
      ["v_pat", 50],
      ["v_pat", 2],
      ["v_anon", 3],
    ]);
    const { audience, annotations } = make({ link: "pseudonymous", users: [rachel, pat], sessions: rows });
    // Rachel signed in once on each device (as a customer — not internal then).
    expect(await audience.observe({ visitorId: "v_rachel_laptop", user: rachel, host: "x.io", userAgent: CHROME, headers: OPEN })).toBeNull();
    expect(await audience.observe({ visitorId: "v_rachel_phone", user: rachel, host: "x.io", userAgent: CHROME, headers: OPEN })).toBeNull();
    await audience.observe({ visitorId: "v_pat", user: pat, host: "x.io", userAgent: CHROME, headers: OPEN });
    const before = await counted(audience, rows);
    expect(before).toBe(8);
    const tablesBefore = await allRows(audience.tenantId);

    // Preview: typed with dots and a +tag, still Rachel.
    const preview = await audience.preview({ kind: "email", value: "  rachelsmith+riddler@gmail.com " });
    expect(preview.subjects).toEqual({ users: 1, visitors: 2, orgs: 0, events: 0, orders: 0 });
    expect(preview.retroactive).toBe(true);
    expect(preview.windows.map((w) => [w.key, w.before.sessions, w.excluded.sessions, w.after.sessions])).toEqual([
      ["30d", 5, 3, 2],
      ["90d", 7, 4, 3],
      ["all", 8, 5, 3],
    ]);
    expect(preview.windows[2]!.earliest?.toISOString()).toBe(daysAgo(120).toISOString());
    expect(await allRows(audience.tenantId)).toEqual(tablesBefore);
    expect(await counted(audience, rows)).toBe(8);

    // Add + apply.
    const { rule, applied } = await audience.addRule({ kind: "email", value: "rachelsmith+riddler@gmail.com", reasonLabel: "Rachel (client)" }, { by: "dallin@adminigloo.com" });
    expect(rule.value).toBe("rachelsmith+riddler@gmail.com");
    expect(applied).toMatchObject({ subjectsChanged: 3, sessionsAffected: 5 });
    expect(applied!.from!.toISOString()).toBe(daysAgo(120).toISOString());
    expect(applied!.annotation).toBe(`Internal rule added (person (email) r***@gmail.com): 5 sessions excluded back to ${daysAgo(120).toISOString().slice(0, 10)}`);
    expect(annotations).toEqual([applied!.annotation]);
    expect(await counted(audience, rows)).toBe(3);
    expect(await counted(audience, rows, true)).toBe(8);
    expect(await audience.excludedBreakdown({})).toEqual({ total: 5, byReason: { email: 5 }, unit: "sessions" });

    // Idempotent: applying again changes nothing.
    const again = await audience.apply(rule.id, { by: "dallin" });
    expect(again).toMatchObject({ subjectsChanged: 0, sessionsAffected: 0, run: null });
    expect(annotations).toEqual([applied!.annotation]);
    expect(await counted(audience, rows)).toBe(3);

    // Remove: exactly back.
    const removed = await audience.remove(rule.id, { by: "dallin" });
    expect(removed).toMatchObject({ marksCleared: 3, sessionsRestored: 5 });
    expect(removed.annotation).toContain("5 sessions counted again");
    expect(await counted(audience, rows)).toBe(before);
    expect(await audience.excludedBreakdown({})).toEqual({ total: 0, byReason: {}, unit: "sessions" });

    // Nothing was deleted: the rule is disabled and its marks are cleared, all still there.
    const after = await allRows(audience.tenantId);
    const marks = after.marks as Array<Record<string, unknown>>;
    expect(marks).toHaveLength(3);
    expect(marks.every((m) => m.cleared_at !== null && m.cleared_by === "dallin")).toBe(true);
    expect((after.rules as Array<Record<string, unknown>>)[0]!.disabled_at).not.toBeNull();
    const runs = await audience.runs();
    expect(runs.map((r) => r.action)).toEqual(["remove", "apply"]);
    expect((await audience.rules()).length).toBe(0);
    expect((await audience.rules({ includeDisabled: true })).length).toBe(1);

    // A retried remove is a no-op: no second run row.
    expect(await audience.remove(rule.id, { by: "dallin" })).toMatchObject({ marksCleared: 0, run: null });
    expect((await audience.runs()).length).toBe(2);

    // And it can be added again after removal.
    const readded = await audience.addRule({ kind: "email", value: "rachelsmith@gmail.com" }, { by: "dallin" });
    expect(readded.applied).toMatchObject({ sessionsAffected: 5 });
    expect(await counted(audience, rows)).toBe(3);
  });

  it("internal-only link mode: a person named later reaches only devices linked while internal — and preview says so", async () => {
    const rachel: User = { id: "u_rachel", email: "rachel@gmail.com", role: "customer" };
    const rows = await sessionsTable([["v_rachel", 10]]);
    const { audience } = make({ link: "internal-only", users: [rachel], sessions: rows });
    await audience.observe({ visitorId: "v_rachel", user: rachel, host: "x.io", userAgent: CHROME });
    const preview = await audience.preview({ kind: "email", value: "rachel@gmail.com" });
    expect(preview.subjects).toMatchObject({ users: 1, visitors: 0 });
    expect(preview.limits.join(" ")).toMatch(/internal-only/);
    // Once she is internal, her device is linked and marked as she browses.
    const { rule } = await audience.addRule({ kind: "email", value: "rachel@gmail.com" }, { by: "d" });
    expect(await audience.observe({ visitorId: "v_rachel", user: rachel, host: "x.io", userAgent: CHROME })).toBe("email");
    expect(await counted(audience, rows)).toBe(0);
    // The intake mark carries the rule, so removing the rule restores the visit.
    await audience.remove(rule.id, { by: "d" });
    expect(await counted(audience, rows)).toBe(1);
  });

  it("removing one rule leaves another that covers the same person standing", async () => {
    const sam: User = { id: "u_sam", email: "sam@riddlergo.com", role: "customer" };
    const rows = await sessionsTable([["v_sam", 3], ["v_sam", 2], ["v_x", 1]]);
    const { audience } = make({ link: "pseudonymous", users: [sam], sessions: rows });
    await audience.observe({ visitorId: "v_sam", user: sam, host: "x.io", userAgent: CHROME, headers: OPEN });
    const domain = await audience.addRule({ kind: "email_domain", value: "riddlergo.com" }, { by: "d" });
    const person = await audience.addRule({ kind: "email", value: "sam@riddlergo.com" }, { by: "d" });
    expect(person.applied).toMatchObject({ sessionsAffected: 0, subjectsChanged: 2 });
    expect(await counted(audience, rows)).toBe(1);
    // Precedence: the person rule (email) outranks the domain rule.
    expect(await audience.excludedBreakdown()).toEqual({ total: 2, byReason: { email: 2 }, unit: "sessions" });
    const removed = await audience.remove(person.rule.id, { by: "d" });
    expect(removed.sessionsRestored).toBe(0);
    expect(await counted(audience, rows)).toBe(1);
    expect(await audience.excludedBreakdown()).toEqual({ total: 2, byReason: { domain: 2 }, unit: "sessions" });
    await audience.remove(domain.rule.id, { by: "d" });
    expect(await counted(audience, rows)).toBe(3);
  });

  it("re-applies remaining rules to subjects that lost a mark (a rule never applied still catches them)", async () => {
    const sam: User = { id: "u_sam", email: "sam@riddlergo.com" };
    const rows = await sessionsTable([["v_sam", 3]]);
    const { audience } = make({ link: "pseudonymous", users: [sam], sessions: rows });
    await audience.observe({ visitorId: "v_sam", user: sam, host: "x.io", userAgent: CHROME, headers: OPEN });
    const person = await audience.addRule({ kind: "email", value: "sam@riddlergo.com" }, { by: "d" });
    await audience.addRule({ kind: "email_domain", value: "riddlergo.com" }, { by: "d", apply: false });
    expect(await counted(audience, rows)).toBe(0);
    await audience.remove(person.rule.id, { by: "d" });
    expect(await counted(audience, rows)).toBe(0);
    expect(await audience.excludedBreakdown()).toMatchObject({ byReason: { domain: 1 } });
  });

  it("appliesFrom: rows before the date stay counted — in the fragment, the preview and the breakdown", async () => {
    const rows = await sessionsTable([["v_dev", 40], ["v_dev", 20], ["v_dev", 5]]);
    const { audience } = make({ sessions: rows });
    const preview = await audience.preview({ kind: "visitor", value: "v_dev", appliesFrom: daysAgo(30).toISOString() });
    expect(preview.windows.find((w) => w.key === "all")!.excluded.sessions).toBe(2);
    const { applied } = await audience.addRule({ kind: "visitor", value: "v_dev", appliesFrom: daysAgo(30) }, { by: "d" });
    expect(applied!.sessionsAffected).toBe(2);
    expect(await counted(audience, rows)).toBe(1);
    expect(await audience.excludedBreakdown()).toMatchObject({ total: 2 });
  });

  it("rules that cannot reach back say so, and apply leaves history alone", async () => {
    const rows = await sessionsTable([["v1", 1]]);
    const { audience } = make({ sessions: rows });
    for (const [kind, value] of [["network", "10.0.0.0/8"], ["host", "riddlergo.com"], ["user_agent", "mymonitor"]] as const) {
      const preview = await audience.preview({ kind, value });
      expect(preview.retroactive).toBe(false);
      expect(preview.limits.join(" ")).toMatch(/new visits only/);
      const { applied } = await audience.addRule({ kind, value }, { by: "d" });
      expect(applied!.annotation).toMatch(/applies to new visits only$/);
      expect(applied!.subjectsChanged).toBe(0);
    }
    expect(await counted(audience, rows)).toBe(1);
  });

  it("org, event and order rules mark those subjects for countedSubjectSql (platform counts)", async () => {
    const { audience } = make();
    await tdb.client.exec(`INSERT INTO app_orgs (id, name) VALUES ('org_staff_${audience.tenantId}', 'Staff'), ('org_cust_${audience.tenantId}', 'Customer')`);
    const before = await tdb.db.execute(
      sql`SELECT count(*)::int AS n FROM app_orgs o WHERE o.id LIKE ${`%${audience.tenantId}`} AND ${audience.countedSubjectSql("org", "o.id")}`,
    );
    expect((before as unknown as { rows: Array<{ n: number }> }).rows[0]!.n).toBe(2);
    const { applied } = await audience.addRule({ kind: "org", value: `org_staff_${audience.tenantId}` }, { by: "d" });
    expect(applied!.subjects).toMatchObject({ orgs: 1 });
    const after = await tdb.db.execute(
      sql`SELECT count(*)::int AS n FROM app_orgs o WHERE o.id LIKE ${`%${audience.tenantId}`} AND ${audience.countedSubjectSql("org", "o.id")}`,
    );
    expect((after as unknown as { rows: Array<{ n: number }> }).rows[0]!.n).toBe(1);
    await audience.addRule({ kind: "event", value: "evt_test" }, { by: "d" });
    await audience.addRule({ kind: "order", value: "ord_test" }, { by: "d" });
    const kinds = ((await allRows(audience.tenantId)).marks as Array<Record<string, unknown>>).map((m) => `${m.subject_kind}:${m.reason}`).sort();
    expect(kinds).toEqual(["event:event", "order:order", "org:org"]);
  });

  it("refuses a duplicate active rule and an invalid value, with words for the form", async () => {
    const { audience } = make();
    await audience.addRule({ kind: "email_domain", value: "riddlergo.com" }, { by: "d" });
    await expect(audience.addRule({ kind: "email_domain", value: "@RiddlerGo.com" }, { by: "d" })).rejects.toMatchObject({ code: "duplicate_rule", status: 409 });
    await expect(audience.addRule({ kind: "email", value: "not an email" }, { by: "d" })).rejects.toMatchObject({ code: "invalid_rule", status: 400 });
    await expect(audience.preview({ kind: "network", value: "999.1.1.1" })).rejects.toBeInstanceOf(AudienceError);
    const preview = await audience.preview({ kind: "email_domain", value: "riddlergo.com" });
    expect(preview.duplicateOf).not.toBeNull();
    await expect(audience.apply("nope")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("the breakdown adds up", () => {
  it("one reason per session by precedence; the parts sum to the total, and the total is exactly what the fragment leaves out", async () => {
    const staff: User = { id: "u_staff", email: "sam@riddlergo.com", role: "staff" };
    const rows = await sessionsTable([
      ["v_staff", 1],
      ["v_staff", 2],
      ["v_bot", 1],
      ["v_test", 1],
      ["v_test", 3],
      ["v_test", 4],
      ["v_both", 1],
      ["v_cust", 1],
      ["v_cust", 9],
      ["v_old", 400],
    ]);
    const { audience } = make({ users: [staff], sessions: rows });
    await audience.observe({ visitorId: "v_staff", user: staff, host: "x.io", userAgent: CHROME });
    await audience.observe({ visitorId: "v_bot", host: "x.io", userAgent: "Googlebot/2.1 (+http://www.google.com/bot.html)" });
    await audience.observe({ visitorId: "v_test", email: "q+clerk_test@gmail.com", host: "x.io", userAgent: CHROME });
    // v_both: staff AND automation — counted once, as automation (it outranks role).
    await audience.observe({ visitorId: "v_both", user: staff, host: "x.io", userAgent: "HeadlessChrome/129" });
    await audience.mark({ subjectKind: "visitor", subjectId: "v_old", by: "d" });

    const all = await audience.excludedBreakdown();
    expect(all).toEqual({ total: 8, byReason: { bot: 1, automation: 1, role: 2, pattern: 3, manual: 1 }, unit: "sessions" });
    const sum = Object.values(all.byReason).reduce((a, b) => a + (b ?? 0), 0);
    expect(sum).toBe(all.total);
    // …and the total is exactly what the anti-join leaves out of the app's own query.
    expect((await counted(audience, rows, true)) - (await counted(audience, rows))).toBe(all.total);

    const lastWeek = await audience.excludedBreakdown({ from: daysAgo(3.5), to: NOW });
    expect(lastWeek).toEqual({ total: 6, byReason: { bot: 1, automation: 1, role: 2, pattern: 2 }, unit: "sessions" });
  });

  it("without a sessions source it says what is missing", async () => {
    const { audience } = make();
    await expect(audience.excludedBreakdown()).rejects.toMatchObject({ code: "not_configured" });
  });
});

describe("by hand, devices, backfill, maintenance", () => {
  it("mark and unmark one subject; a session mark leaves out just that visit", async () => {
    const rows = await sessionsTable([["v1", 1], ["v1", 2]]);
    const { audience } = make({ sessions: rows });
    expect(await counted(audience, rows)).toBe(2);
    const sessionId = ((await tdb.client.query<{ id: string }>(`SELECT id FROM ${rows.table} ORDER BY created_at LIMIT 1`)).rows[0]!).id;
    await audience.mark({ subjectKind: "session", subjectId: sessionId, by: "d" });
    expect(await counted(audience, rows)).toBe(1);
    expect(await audience.excludedBreakdown()).toEqual({ total: 1, byReason: { manual: 1 }, unit: "sessions" });
    await audience.mark({ subjectKind: "visitor", subjectId: "v1", by: "d" });
    expect(await counted(audience, rows)).toBe(0);
    expect((await audience.mark({ subjectKind: "visitor", subjectId: "v1", by: "d" })).subjectsChanged).toBe(0);
    await audience.unmark({ subjectKind: "visitor", subjectId: "v1", by: "d" });
    await audience.unmark({ subjectKind: "session", subjectId: sessionId, by: "d" });
    expect(await counted(audience, rows)).toBe(2);
  });

  it("marking a user by hand reaches their linked devices", async () => {
    const pat: User = { id: "u_pat", email: "pat@x.io" };
    const rows = await sessionsTable([["v_pat", 1]]);
    const { audience } = make({ link: "pseudonymous", users: [pat], sessions: rows });
    await audience.observe({ visitorId: "v_pat", user: pat, host: "x.io", userAgent: CHROME, headers: OPEN });
    expect((await audience.mark({ subjectKind: "user", subjectId: "u_pat", by: "d" })).subjectsChanged).toBe(2);
    expect(await counted(audience, rows)).toBe(0);
    await audience.unmark({ subjectKind: "user", subjectId: "u_pat", by: "d" });
    expect(await counted(audience, rows)).toBe(1);
  });

  it("Mark this browser and device links create one visitor rule, idempotently", async () => {
    const rows = await sessionsTable([["v_phone", 30], ["v_phone", 1]]);
    const { audience } = make({ sessions: rows });
    const first = await audience.markVisitor({ visitorId: "v_phone", by: "rachel" });
    expect(first.applied).toMatchObject({ sessionsAffected: 2 });
    const second = await audience.markVisitor({ visitorId: "v_phone", by: "rachel" });
    expect(second.rule.id).toBe(first.rule.id);
    expect(second.applied).toBeNull();
    expect(await counted(audience, rows)).toBe(0);

    const link = audience.createDeviceLink({ by: "dallin@adminigloo.com", baseUrl: "https://riddlergo.com/" });
    expect(link.url).toBe(`https://riddlergo.com/?internal=${link.token}`);
    const redeemed = await audience.redeemDeviceLink(link.token, { visitorId: "v_tablet" });
    expect(redeemed.rule).toMatchObject({ kind: "visitor", value: "v_tablet", createdBy: "dallin@adminigloo.com" });
    await expect(audience.redeemDeviceLink(`${link.token}x`, { visitorId: "v_x" })).rejects.toMatchObject({ code: "invalid_token" });
    await expect(audience.markVisitor({ visitorId: "  ", by: "x" })).rejects.toMatchObject({ code: "invalid_rule" });
  });

  it("backfill: the app's joins, the package's verdict — dry run writes nothing, the real run is idempotent", async () => {
    const staff: User = { id: "u_staff", email: "sam@riddlergo.com", role: "staff" };
    const buyer: User = { id: "u_buyer", email: "buyer@gmail.com", role: "customer" };
    const rows = await sessionsTable([["v_staff_old", 200], ["v_staff_old", 100], ["v_buyer", 50]]);
    const { audience } = make({ users: [staff, buyer], sessions: rows });
    // Riddler Go's shape: checkout events → orders → the buyer; the visitor is the event's.
    const events = [
      { visitorId: "v_staff_old", purchasedBy: "u_staff" },
      { visitorId: "v_buyer", purchasedBy: "u_buyer" },
      { visitorId: "v_test_order", purchasedBy: "nobody" },
    ];
    const adapter: BackfillAdapter<User> = {
      name: "checkout_completed → orders.purchased_by",
      async *candidates() {
        for (const event of events) {
          if (event.purchasedBy === "nobody") yield { subjectKind: "visitor", subjectId: event.visitorId, reason: "order" };
          else yield { subjectKind: "visitor", subjectId: event.visitorId, actor: { userId: event.purchasedBy } };
        }
      },
    };
    const before = await allRows(audience.tenantId);
    const dry = await audience.backfill(adapter, { by: "d", dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, candidates: 3, internal: 2, byReason: { role: 1, order: 1 }, subjectsChanged: 2, sessionsAffected: 2, run: null });
    expect(await allRows(audience.tenantId)).toEqual(before);
    const real = await audience.backfill(adapter, { by: "d" });
    expect(real).toMatchObject({ subjectsChanged: 2, sessionsAffected: 2 });
    expect(real.run?.summary).toBe(`Backfill (checkout_completed → orders.purchased_by): 2 sessions excluded back to ${daysAgo(200).toISOString().slice(0, 10)}`);
    expect(await counted(audience, rows)).toBe(1);
    expect(await audience.backfill(adapter, { by: "d" })).toMatchObject({ subjectsChanged: 0, sessionsAffected: 0 });
  });

  it("maintain: the code rule's people and their devices are marked; a second run changes nothing", async () => {
    const staff: User = { id: "u_staff", email: "sam@x.io", role: "analytics" };
    const rows = await sessionsTable([["v_staff", 10]]);
    const { audience } = make({ link: "pseudonymous", users: [staff], sessions: rows, isInternal: () => false });
    // Linked while NOT internal yet (the callback said no at the time).
    await audience.observe({ visitorId: "v_staff", user: staff, host: "x.io", userAgent: CHROME, headers: OPEN });
    expect(await counted(audience, rows)).toBe(1);
    const later = createAudience<User>({
      store: createDrizzleAudienceStore({ db: tdb.db, tables: tdb.tables }),
      secret: SECRET,
      tenantId: audience.tenantId,
      link: "pseudonymous",
      isInternal: (user) => (user.role === "analytics" ? "analytics role" : false),
      listUsers: () => [staff],
      sessions: rows,
      now: () => NOW,
    });
    const first = await later.maintain();
    expect(first).toMatchObject({ roleUsers: 1, subjectsChanged: 2 });
    expect(await counted(later, rows)).toBe(0);
    expect(await later.maintain()).toMatchObject({ subjectsChanged: 0, run: null });
  });
});

describe("permissions, licensing, isolation", () => {
  it("viewModel masks emails for the analytics role, on the server", async () => {
    const { audience } = make();
    await audience.addRule({ kind: "email", value: "rachel@gmail.com", reasonLabel: "Client" }, { by: "dallin@adminigloo.com" });
    const staffView = await audience.viewModel({ canSeeEmails: true });
    expect(staffView.rules[0]!.value).toBe("rachel@gmail.com");
    const analystView = await audience.viewModel({ canSeeEmails: false });
    expect(analystView.masked).toBe(true);
    const dump = JSON.stringify(analystView);
    expect(dump).not.toContain("rachel@gmail.com");
    expect(dump).not.toContain("dallin@adminigloo.com");
    expect(analystView.rules[0]!.value).toMatch(/^r\*\*\*@gmail\.com · [0-9a-f]{4}$/);
  });

  it("the license gate guards the cleaning work only — never intake, never removal", async () => {
    const { audience: open } = make();
    const { rule } = await open.addRule({ kind: "email_domain", value: "riddlergo.com" }, { by: "d" });
    const gated = createAudience({
      store: createDrizzleAudienceStore({ db: tdb.db, tables: tdb.tables }),
      secret: SECRET,
      tenantId: open.tenantId,
      license: { mode: "enforce" },
      onError: () => {},
    });
    await expect(gated.preview({ kind: "email", value: "a@b.co" })).rejects.toMatchObject({ code: "unlicensed", status: 402 });
    await expect(gated.addRule({ kind: "email", value: "a@b.co" })).rejects.toMatchObject({ code: "unlicensed" });
    await expect(gated.apply(rule.id)).rejects.toMatchObject({ code: "unlicensed" });
    await expect(gated.mark({ subjectKind: "order", subjectId: "o1" })).rejects.toMatchObject({ code: "unlicensed" });
    await expect(gated.backfill({ name: "x", candidates: () => [] })).rejects.toMatchObject({ code: "unlicensed" });
    expect(await gated.observe({ visitorId: "v", email: "x@riddlergo.com", host: "x.io", userAgent: CHROME })).toBe("domain");
    await expect(gated.remove(rule.id, { by: "d" })).resolves.toMatchObject({ rule: { id: rule.id } });
  });

  it("tenants never see each other's rules or marks", async () => {
    const rows = await sessionsTable([["v_shared", 1]]);
    const a = make({ sessions: rows }).audience;
    const b = make({ sessions: rows }).audience;
    await a.addRule({ kind: "visitor", value: "v_shared" }, { by: "d" });
    expect(await counted(a, rows)).toBe(0);
    expect(await counted(b, rows)).toBe(1);
    expect(await b.rules()).toEqual([]);
    expect(await b.observe({ visitorId: "v_shared", host: "x.io", userAgent: CHROME })).toBeNull();
  });

  it("a second table set under another prefix works end to end, beside the default one", async () => {
    const other = await createTestDb("rg_aud_");
    try {
      const rows: RowsSource = { table: "app_sessions", visitor: "visitor_id", time: "created_at" };
      await other.client.exec(`INSERT INTO app_sessions VALUES ('s1', 'v1', now()), ('s2', 'v2', now())`);
      const audience = createAudience({ store: createDrizzleAudienceStore({ db: other.db, tables: other.tables }), secret: SECRET, sessions: rows });
      expect(audience.marksTable).toBe("rg_aud_marks");
      await audience.addRule({ kind: "visitor", value: "v1" }, { by: "d" });
      const result = await other.db.execute(sql`SELECT count(*)::int AS n FROM app_sessions s WHERE ${audience.countedVisitorSql("s.visitor_id", { time: "s.created_at", session: "s.id" })}`);
      expect((result as unknown as { rows: Array<{ n: number }> }).rows[0]!.n).toBe(1);
      const names = (await other.client.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE tablename LIKE 'rg_aud_%' ORDER BY 1`)).rows;
      expect(names.map((row) => row.tablename)).toEqual(["rg_aud_links", "rg_aud_marks", "rg_aud_rules", "rg_aud_runs"]);
    } finally {
      await other.close();
    }
  });

  it("a rows filter scopes the app's table (a sessions table shared by environments)", async () => {
    await tdb.client.exec(`CREATE TABLE env_sessions (id text PRIMARY KEY, tenant_id text NOT NULL, visitor_id text NOT NULL, created_at timestamptz NOT NULL)`);
    const at = daysAgo(1).toISOString();
    await tdb.client.query(`INSERT INTO env_sessions VALUES ('a', 'site', 'v1', $1), ('b', 'site:preview', 'v1', $1), ('c', 'site', 'v2', $1)`, [at]);
    const rows: RowsSource = { table: "env_sessions", visitor: "visitor_id", time: "created_at", where: { tenant_id: "site" } };
    const { audience } = make({ sessions: rows });
    const preview = await audience.preview({ kind: "visitor", value: "v1" });
    expect(preview.windows.find((w) => w.key === "all")).toMatchObject({ before: { sessions: 2 }, excluded: { sessions: 1 }, after: { sessions: 1 } });
  });

  it("refuses a short secret", () => {
    expect(() => createAudience({ store: createDrizzleAudienceStore({ db: tdb.db }), secret: "short" })).toThrow(/at least 32/);
  });
});

// ---------------------------------------------------------------------------
// Review regressions. Each test below fails on the code before its fix.
// ---------------------------------------------------------------------------

/** The newest session row of an app table — the visit `observe` is called for. */
async function latestSession(rows: RowsSource): Promise<string> {
  return (await tdb.client.query<{ id: string }>(`SELECT id FROM ${rows.table} ORDER BY created_at DESC LIMIT 1`)).rows[0]!.id;
}

async function activeMarksOfRule(tenantId: string, ruleId: string): Promise<unknown[]> {
  return (await tdb.client.query(`SELECT * FROM aig_audience_marks WHERE tenant_id = $1 AND rule_id = $2 AND cleared_at IS NULL`, [tenantId, ruleId])).rows;
}

describe("review: a removed rule stays removed on every instance", () => {
  it("an instance still caching a removed rule cannot write marks for it (remove restores the counts exactly)", async () => {
    const s1: User = { id: "u_s1", email: "a@riddlergo.com" };
    const s2: User = { id: "u_s2", email: "b@riddlergo.com" };
    const rows = await sessionsTable([["v_s1", 2], ["v_s2", 1], ["v_s2", 3]]);
    const a = make({ users: [s1, s2], sessions: rows }).audience;
    const b = make({ users: [s1, s2], sessions: rows, tenantId: a.tenantId }).audience; // another lambda
    const { rule } = await a.addRule({ kind: "email_domain", value: "riddlergo.com" }, { by: "d" });
    expect(await b.observe({ visitorId: "v_s1", user: s1, host: "x.io", userAgent: CHROME })).toBe("domain"); // b caches the rule
    await a.remove(rule.id, { by: "d" });
    // b has not seen the removal yet: it still classifies with the rule…
    expect(await b.observe({ visitorId: "v_s2", user: s2, host: "x.io", userAgent: CHROME })).toBe("domain");
    // …but the store refuses a mark that names a disabled rule.
    expect(await activeMarksOfRule(a.tenantId, rule.id)).toEqual([]);
    expect(await counted(a, rows)).toBe(3);
  });

  it("maintain clears active marks of a removed rule (left by a store that does not refuse them)", async () => {
    const rows = await sessionsTable([["v_x", 1]]);
    const { audience } = make({ sessions: rows });
    const { rule } = await audience.addRule({ kind: "visitor", value: "v_other" }, { by: "d" });
    await audience.remove(rule.id, { by: "d" });
    await tdb.client.query(
      `INSERT INTO aig_audience_marks (id, tenant_id, subject_kind, subject_id, reason, rule_id, source, marked_at) VALUES ($1, $2, 'visitor', 'v_x', 'device', $3, 'ingest', now())`,
      [`orphan-${audience.tenantId}`, audience.tenantId, rule.id],
    );
    expect(await counted(audience, rows)).toBe(0);
    const result = await audience.maintain();
    expect(result.orphansCleared).toBe(1);
    expect(result.run?.summary).toMatch(/1 marks of removed rules cleared/);
    expect(await counted(audience, rows)).toBe(1);
  });

  it("a rules load that lands after invalidate() does not put the stale list back in the cache", async () => {
    const staff: User = { id: "u_st", email: "st@riddlergo.com" };
    const base = createDrizzleAudienceStore({ db: tdb.db, tables: tdb.tables });
    const writer = make({ users: [staff] }).audience;
    const { rule } = await writer.addRule({ kind: "email_domain", value: "riddlergo.com" }, { by: "d" });
    let release: (() => void) | null = null;
    let loads = 0;
    const slow: AudienceStore = {
      ...base,
      async listRules(tenantId, options) {
        loads += 1;
        const rules = await base.listRules(tenantId, options);
        if (loads === 1) await new Promise<void>((resolve) => (release = resolve));
        return rules;
      },
    };
    const reader = make({ store: slow, users: [staff], tenantId: writer.tenantId }).audience;
    const first = reader.observe({ visitorId: "v1", user: staff, host: "x.io", userAgent: CHROME });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    await writer.remove(rule.id, { by: "d" });
    reader.invalidate(); // told about the change while its load was in flight
    (release as () => void)();
    expect(await first).toBe("domain"); // the in-flight answer is what it is
    expect(await reader.observe({ visitorId: "v2", user: staff, host: "x.io", userAgent: CHROME })).toBeNull();
    expect(loads).toBe(2);
  });
});

describe("review: a visit-only fact marks the visit, not the device", () => {
  it("a customer's one visit from the office network leaves the rest of their history counted", async () => {
    const rows = await sessionsTable([["v_cust", 30], ["v_cust", 10], ["v_cust", 0.01]]);
    const sessionId = await latestSession(rows);
    const { audience } = make({ sessions: rows });
    await audience.addRule({ kind: "network", value: "203.0.113.0/24" }, { by: "d" });
    expect(await audience.observe({ visitorId: "v_cust", sessionId, host: "x.io", userAgent: CHROME, ip: "203.0.113.9" })).toBe("network");
    expect(await counted(audience, rows)).toBe(2);
    expect(await audience.excludedBreakdown()).toEqual({ total: 1, byReason: { network: 1 }, unit: "sessions" });
  });

  it("the same for automation, the smoke-test header and a non-production host", async () => {
    const rows = await sessionsTable([["v1", 5], ["v1", 0.01], ["v2", 5], ["v2", 0.01], ["v3", 5], ["v3", 0.01]]);
    const latest = (await tdb.client.query<{ id: string; visitor_id: string }>(`SELECT DISTINCT ON (visitor_id) id, visitor_id FROM ${rows.table} ORDER BY visitor_id, created_at DESC`)).rows;
    const sid = (visitor: string) => latest.find((row) => row.visitor_id === visitor)!.id;
    const { audience } = make({ sessions: rows });
    expect(await audience.observe({ visitorId: "v1", sessionId: sid("v1"), host: "x.io", userAgent: "HeadlessChrome/129" })).toBe("automation");
    expect(await audience.observe({ visitorId: "v2", sessionId: sid("v2"), host: "x.io", userAgent: CHROME, headers: { "x-aig-audience": audience.testHeader!.value } })).toBe("automation");
    expect(await audience.observe({ visitorId: "v3", sessionId: sid("v3"), host: "my-app-git-x.vercel.app", userAgent: CHROME })).toBe("non_production");
    expect(await counted(audience, rows)).toBe(3);
  });

  it("a mistyped production-host rule excludes real visits — and removing it counts them again", async () => {
    const rows = await sessionsTable([["v_c", 2], ["v_c", 0.01], ["v_d", 1]]);
    const sessionId = await latestSession(rows);
    const { audience } = make({ sessions: rows });
    const { rule } = await audience.addRule({ kind: "host", value: "www.riddlergo.com" }, { by: "d" }); // the apex was forgotten
    expect(await audience.observe({ visitorId: "v_c", sessionId, host: "riddlergo.com", userAgent: CHROME })).toBe("non_production");
    // Without a session id the fallback marks the device — still owned by the rule.
    expect(await audience.observe({ visitorId: "v_d", host: "riddlergo.com", userAgent: CHROME })).toBe("non_production");
    expect(await counted(audience, rows)).toBe(1);
    const removed = await audience.remove(rule.id, { by: "d" });
    expect(removed.marksCleared).toBe(2);
    expect(removed.sessionsRestored).toBe(2);
    expect(await counted(audience, rows)).toBe(3);
  });

  it("acting on a test event marks that visit only, never the actor's device", async () => {
    const rows = await sessionsTable([["v_c", 5], ["v_c", 0.01]]);
    const sessionId = await latestSession(rows);
    const { audience } = make({ sessions: rows });
    await audience.addRule({ kind: "event", value: "evt_test" }, { by: "d" });
    expect(await audience.classifyActor({ eventId: "evt_test", visitorId: "v_c" })).toMatchObject({ reason: "event" });
    expect(await counted(audience, rows)).toBe(2);
    await audience.classifyActor({ eventId: "evt_test", visitorId: "v_c", sessionId });
    expect(await counted(audience, rows)).toBe(1);
  });

  it("a session mark the sessions source cannot see is reported once", async () => {
    const rows = await sessionsTable([["v1", 1]]);
    const { audience, errors } = make({ sessions: { table: rows.table, visitor: "visitor_id", time: "created_at" } });
    await audience.observe({ visitorId: "v1", sessionId: "s-x", host: "x.io", userAgent: "HeadlessChrome" });
    await audience.observe({ visitorId: "v1", sessionId: "s-y", host: "x.io", userAgent: "HeadlessChrome" });
    expect(errors.map(String).filter((e) => e.includes("sessions.id"))).toHaveLength(1);
  });
});

describe("review: org rules reach members in history, as they do at intake", () => {
  it("an org rule marks its members' devices, so its annotation and the reports agree", async () => {
    const member: User = { id: "u_m", email: "m@x.io", orgIds: ["org_demo"] };
    const outsider: User = { id: "u_o", email: "o@x.io", orgIds: ["org_cust"] };
    const rows = await sessionsTable([["v_m", 20], ["v_m", 2], ["v_o", 1]]);
    const { audience } = make({ users: [member, outsider], sessions: rows, link: "pseudonymous" });
    await audience.observe({ visitorId: "v_m", user: member, host: "x.io", userAgent: CHROME, headers: OPEN });
    await audience.observe({ visitorId: "v_o", user: outsider, host: "x.io", userAgent: CHROME, headers: OPEN });
    const preview = await audience.preview({ kind: "org", value: "org_demo" });
    expect(preview.subjects).toMatchObject({ users: 1, visitors: 1, orgs: 1 });
    const { rule, applied } = await audience.addRule({ kind: "org", value: "org_demo" }, { by: "d" });
    expect(applied!.sessionsAffected).toBe(2);
    expect(applied!.annotation).toMatch(/2 sessions excluded/);
    expect(await counted(audience, rows)).toBe(1);
    await audience.remove(rule.id, { by: "d" });
    expect(await counted(audience, rows)).toBe(3);
  });

  it("an event or order rule says plainly that session counts do not change", async () => {
    const { audience } = make({ sessions: await sessionsTable([["v1", 1]]) });
    const { applied } = await audience.addRule({ kind: "order", value: "ord_test" }, { by: "d" });
    expect(applied!.annotation).toMatch(/left out of order counts; session counts unchanged$/);
    expect((await audience.preview({ kind: "event", value: "evt_1" })).limits.join(" ")).toMatch(/Session counts do not change/);
  });
});

describe("review: wrongly excluded people can be restored", () => {
  it("unmark with every source clears intake, backfill and maintenance marks — a demoted staffer counts again", async () => {
    const pat: User = { id: "u_pat", email: "pat@x.io", role: "staff" };
    const rows = await sessionsTable([["v_pat", 3]]);
    const { audience } = make({ users: [pat], sessions: rows, link: "pseudonymous" });
    await audience.observe({ visitorId: "v_pat", user: pat, host: "x.io", userAgent: CHROME, headers: OPEN });
    await audience.maintain();
    expect(await counted(audience, rows)).toBe(0);
    pat.role = "customer";
    // By default unmark undoes hand marks only.
    expect((await audience.unmark({ subjectKind: "user", subjectId: "u_pat", by: "d" })).subjectsChanged).toBe(0);
    const restored = await audience.unmark({ subjectKind: "user", subjectId: "u_pat", by: "d", sources: "all" });
    expect(restored.subjectsChanged).toBe(2);
    expect(restored.run.summary).toBe("Unmarked by hand: user (every reason)");
    expect(await counted(audience, rows)).toBe(1);
    expect(await audience.observe({ visitorId: "v_pat", user: pat, host: "x.io", userAgent: CHROME, headers: OPEN })).toBeNull();
    expect(await counted(audience, rows)).toBe(1);
  });

  it("maintain({ pruneRoleMarks: true }) unmarks people the code rule no longer names; it is off by default", async () => {
    const sam: User = { id: "u_sam", email: "sam@x.io", role: "staff" };
    const ana: User = { id: "u_ana", email: "ana@x.io", role: "analytics" };
    const rows = await sessionsTable([["v_sam", 3], ["v_ana", 2]]);
    const { audience } = make({ users: [sam, ana], sessions: rows, link: "pseudonymous" });
    await audience.observe({ visitorId: "v_sam", user: sam, host: "x.io", userAgent: CHROME, headers: OPEN });
    await audience.observe({ visitorId: "v_ana", user: ana, host: "x.io", userAgent: CHROME, headers: OPEN });
    sam.role = "customer";
    expect(await audience.maintain()).toMatchObject({ roleMarksCleared: 0 });
    expect(await counted(audience, rows)).toBe(0);
    const pruned = await audience.maintain({ pruneRoleMarks: true });
    expect(pruned.roleMarksCleared).toBe(2); // Sam's user mark and his device's
    expect(await counted(audience, rows)).toBe(1); // Ana is still on staff
  });
});

describe("review: privacy", () => {
  it("classifyActor writes a link only when the call says the browser did not opt out", async () => {
    const customer: User = { id: "u_c", email: "c@x.io" };
    const { audience } = make({ link: "pseudonymous", users: [customer] });
    await audience.classifyActor({ userId: "u_c", visitorId: "v_unknown" });
    await audience.classifyActor({ userId: "u_c", visitorId: "v_gpc", headers: { "sec-gpc": "1" } });
    await audience.classifyActor({ userId: "u_c", visitorId: "v_flag", privacyOptOut: true });
    await audience.classifyActor({ userId: "u_c", visitorId: "v_ok", headers: OPEN });
    await audience.classifyActor({ userId: "u_c", visitorId: "v_ok2", privacyOptOut: false });
    const links = (await allRows(audience.tenantId)).links as Array<Record<string, unknown>>;
    expect(links.map((link) => link.visitor_id).sort()).toEqual(["v_ok", "v_ok2"]);
  });

  it("device links: the maker is not in the URL, a link marks at most maxDevices browsers, and redeeming adds no chart note", async () => {
    const rows = await sessionsTable([["v1", 1]]);
    const { audience, annotations } = make({ sessions: rows });
    const link = audience.createDeviceLink({ by: "jane.staff@riddlergo.com", baseUrl: "https://riddlergo.com/", maxDevices: 2 });
    expect(link.url).not.toContain(Buffer.from("jane.staff@riddlergo.com").toString("base64url"));
    const first = await audience.redeemDeviceLink(link.token, { visitorId: "v1" });
    expect(first.rule).toMatchObject({ kind: "visitor", createdBy: "jane.staff@riddlergo.com", note: `device link ${link.linkId}` });
    expect((await audience.redeemDeviceLink(link.token, { visitorId: "v1" })).rule.id).toBe(first.rule.id); // same browser: no-op
    await audience.redeemDeviceLink(link.token, { visitorId: "v2" });
    await expect(audience.redeemDeviceLink(link.token, { visitorId: "v3" })).rejects.toMatchObject({ code: "invalid_token" });
    expect(annotations).toEqual([]);
    expect((await audience.runs()).filter((run) => run.action === "apply")).toHaveLength(2);
    expect(await counted(audience, rows)).toBe(0);
  });

  it("annotations (read by analysts and the digest) carry no free-text label, no readable pattern and no home IP", async () => {
    const { audience, annotations } = make();
    await audience.addRule({ kind: "email_pattern", value: "rachel.smith", reasonLabel: "Rachel Smith's husband" }, { by: "d" });
    await audience.addRule({ kind: "network", value: "73.12.34.56", reasonLabel: "Sam's home" }, { by: "d" });
    const text = annotations.join(" | ");
    for (const secret of ["husband", "Rachel Smith", "rachel.smith", "73.12.34.56", "Sam's home"]) expect(text).not.toContain(secret);
    expect(text).toContain("email pattern rac•••");
    expect(text).toContain("network (ip range) 73.12.•••/32");
    const runs = await audience.runs();
    expect(JSON.stringify(runs)).not.toContain("husband");
  });

  it("after rotating AUDIENCE_SECRET, a person rule still reaches devices linked under the old one", async () => {
    const pat: User = { id: "u_pat", email: "pat@gmail.com" };
    const rows = await sessionsTable([["v_old", 5]]);
    const before = make({ link: "pseudonymous", users: [pat], sessions: rows }).audience;
    await before.observe({ visitorId: "v_old", user: pat, host: "x.io", userAgent: CHROME, headers: OPEN });
    const NEW = "rotated-secret-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789";
    const forgetful = make({ link: "pseudonymous", users: [pat], sessions: rows, tenantId: before.tenantId, secret: NEW }).audience;
    expect((await forgetful.preview({ kind: "email", value: "pat@gmail.com" })).subjects.visitors).toBe(0);
    const rotated = make({ link: "pseudonymous", users: [pat], sessions: rows, tenantId: before.tenantId, secret: NEW, previousSecrets: [SECRET] }).audience;
    const { applied } = await rotated.addRule({ kind: "email", value: "pat@gmail.com" }, { by: "d" });
    expect(applied!.sessionsAffected).toBe(1);
    expect(await counted(rotated, rows)).toBe(0);
  });

  it("junk ids from a cookie are refused, not written: a 500-character visitor id marks nothing", async () => {
    const { audience } = make({ isInternal: undefined });
    expect(await audience.observe({ visitorId: "v".repeat(500), host: "x.io", userAgent: "HeadlessChrome" })).toBe("automation");
    expect((await allRows(audience.tenantId)).marks).toEqual([]);
    await expect(audience.mark({ subjectKind: "visitor", subjectId: "v".repeat(500) })).rejects.toMatchObject({ code: "invalid_rule" });
  });

  it("with rotating (cookieless) visitor ids, Mark this browser and device links refuse, and preview says how far a person rule reaches", async () => {
    const { audience } = make({ visitorIds: "rotating" });
    await expect(audience.markVisitor({ visitorId: "k1", by: "d" })).rejects.toMatchObject({ code: "not_configured" });
    expect(() => audience.createDeviceLink({ by: "d" })).toThrow(/change every day/);
    expect((await audience.preview({ kind: "email", value: "a@b.co" })).limits.join(" ")).toMatch(/rotate daily/);
  });
});

describe("review: retries, races and counts that must agree", () => {
  it("a retried or double-clicked apply writes no second run row and no second annotation", async () => {
    const rows = await sessionsTable([["v1", 1]]);
    const { audience, annotations } = make({ sessions: rows });
    const { rule } = await audience.addRule({ kind: "visitor", value: "v1" }, { by: "d" });
    const again = await audience.apply(rule.id, { by: "d" });
    expect(again.run).toBeNull();
    expect(again.annotation).toMatch(/^Already applied/);
    expect(annotations).toHaveLength(1);
    expect(await audience.runs()).toHaveLength(1);
  });

  it("two admins adding the same rule at once: the second gets duplicate_rule, not a database error", async () => {
    const base = createDrizzleAudienceStore({ db: tdb.db, tables: tdb.tables });
    const tenantId = tenant();
    const first = make({ tenantId }).audience;
    // The check before the insert sees nothing, exactly as in a race.
    const racing = make({ tenantId, store: { ...base, listRules: async () => [] } }).audience;
    await first.addRule({ kind: "email_domain", value: "riddlergo.com" }, { by: "a" });
    await expect(racing.addRule({ kind: "email_domain", value: "riddlergo.com" }, { by: "b" })).rejects.toMatchObject({ code: "duplicate_rule", status: 409 });
  });

  it("two tabs pressing Mark this browser at once: both get the one rule", async () => {
    const base = createDrizzleAudienceStore({ db: tdb.db, tables: tdb.tables });
    const tenantId = tenant();
    const first = make({ tenantId }).audience;
    let calls = 0;
    const racing = make({
      tenantId,
      store: {
        ...base,
        listRules: async (t, o) => {
          calls += 1;
          return calls <= 2 ? [] : base.listRules(t, o);
        },
      },
    }).audience;
    const a = await first.markVisitor({ visitorId: "v_tab", by: "a" });
    const b = await racing.markVisitor({ visitorId: "v_tab", by: "b" });
    expect(b.rule.id).toBe(a.rule.id);
  });

  it("a remove that failed after clearing is finished by a retry: the remaining rules are re-applied", async () => {
    const sam: User = { id: "u_sam", email: "sam@riddlergo.com" };
    const rows = await sessionsTable([["v_sam", 3]]);
    const base = createDrizzleAudienceStore({ db: tdb.db, tables: tdb.tables });
    let fail = false;
    const flaky: AudienceStore = {
      ...base,
      async insertMarks(marks) {
        if (fail) throw new Error("connection reset");
        return base.insertMarks(marks);
      },
    };
    const { audience } = make({ store: flaky, link: "pseudonymous", users: [sam], sessions: rows });
    await audience.observe({ visitorId: "v_sam", user: sam, host: "x.io", userAgent: CHROME, headers: OPEN });
    const person = await audience.addRule({ kind: "email", value: "sam@riddlergo.com" }, { by: "d" });
    await audience.addRule({ kind: "email_domain", value: "riddlergo.com" }, { by: "d", apply: false });
    fail = true;
    await expect(audience.remove(person.rule.id, { by: "d" })).rejects.toThrow(/connection reset/);
    fail = false;
    expect(await counted(audience, rows)).toBe(1); // half done: counted though the domain rule names Sam
    const retry = await audience.remove(person.rule.id, { by: "d" });
    expect(retry.run).toBeNull();
    expect(await counted(audience, rows)).toBe(0);
  });

  it("backfill: the dry run and the real run count the same thing — subjects newly excluded, not mark rows", async () => {
    const sam: User = { id: "u_sam", email: "sam@riddlergo.com" };
    const rows = await sessionsTable([["v_a", 5], ["v_b", 4]]);
    const { audience } = make({ users: [sam], sessions: rows, isInternal: undefined });
    await audience.addRule({ kind: "email_domain", value: "riddlergo.com" }, { by: "d", apply: false });
    await audience.addRule({ kind: "email_pattern", value: "sam@" }, { by: "d", apply: false });
    await audience.mark({ subjectKind: "visitor", subjectId: "v_b", by: "d" });
    const adapter: BackfillAdapter<User> = {
      name: "events → buyer",
      candidates: () => [
        { subjectKind: "visitor", subjectId: "v_a", actor: { userId: "u_sam" } },
        { subjectKind: "visitor", subjectId: "v_b", actor: { userId: "u_sam" } },
      ],
    };
    const dry = await audience.backfill(adapter, { dryRun: true });
    const real = await audience.backfill(adapter, { by: "d" });
    expect(dry).toMatchObject({ subjectsChanged: 1, marksWritten: 0, sessionsAffected: 1 });
    expect(real).toMatchObject({ subjectsChanged: 1, sessionsAffected: 1 });
    expect(real.run!.subjectsChanged).toBe(1);
    expect(real.marksWritten).toBe(4); // two rules × two visitors
  });

  it("numeric user ids (Road Rally) are matched, not skipped", async () => {
    const rows = await sessionsTable([["v_42", 1]]);
    const user: User = { id: 42, email: "q@riddlerroadrally.com" };
    const { audience } = make({ users: [user], sessions: rows, link: "pseudonymous" });
    await audience.observe({ visitorId: "v_42", user, host: "x.io", userAgent: CHROME, headers: OPEN });
    const preview = await audience.preview({ kind: "email_domain", value: "riddlerroadrally.com" });
    expect(preview.subjects).toMatchObject({ users: 1, visitors: 1 });
    expect(await audience.observe({ visitorId: "v_42", userId: 42, user, host: "x.io", userAgent: CHROME })).toBeNull();
    await audience.addRule({ kind: "user", value: "42" }, { by: "d" });
    expect(await counted(audience, rows)).toBe(0);
  });
});
