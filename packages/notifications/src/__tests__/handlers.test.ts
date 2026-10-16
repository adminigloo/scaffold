import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNotificationHandlers } from "../handlers.js";
import { NOTIFICATIONS_ADMIN_ROUTES } from "../routes.js";
import type { AlertCountWire, AlertListWire, PreferencesWire, RoutingWire } from "../wire.js";
import { Directory, draft, greenAcres, mount, rowsFor, world } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * `createNotificationHandlers` (Tenancy 2b-1, 4.7) on a real Postgres: every
 * route behind its permission, a person required, the same-site check, the
 * reader's permissions narrowing every answer, two companies through every
 * route, and the screens' words (reachable, the email notes, the business
 * email).
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const NOT_ON_A_LIST = "You're not on any alert lists yet. The owner chooses who hears about new work in Alert settings.";

describe("the gate", () => {
  it("every route answers below 300 for the owner (the two refused examples aside), asking its own permission first", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.notify(draft(a, "tenancy.member.joined"));
    const [alert] = await rowsFor(t, a, p.owner.userId);
    const h = mount(w);
    for (const row of NOTIFICATIONS_ADMIN_ROUTES) {
      h.asked.length = 0;
      const path = row.path.replace("v1/admin/", "v1/admin/").replace("{alert}", alert!.id);
      const body = JSON.parse(JSON.stringify(row.body ?? {}).replace("{person}", p.member.userId));
      const res = await h.call(a, path, { method: row.method, body, user: p.owner.userId, ...(row.query ? { query: row.query } : {}) });
      if (row.kind === "preference-set") expect(res.status, row.kind).toBe(400);
      else expect(res.status, `${row.kind}: ${res.text}`).toBeLessThan(300);
      expect(h.asked[0], row.kind).toEqual({ permission: row.permission, tenantId: a, user: p.owner.userId });
      expect(res.headers.get("cache-control"), row.kind).toBe("no-store");
      expect(res.headers.get("access-control-allow-origin"), row.kind).toBeNull();
    }
  });

  it("without the route's permission every route is 403 forbidden with the plain sentence", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const h = mount(w, { authorize: () => false });
    for (const row of NOTIFICATIONS_ADMIN_ROUTES) {
      const res = await h.call(a, row.path.replace("{alert}", "x"), { method: row.method, body: row.body, user: p.owner.userId });
      expect(res.status, row.kind).toBe(403);
      expect(res.body, row.kind).toEqual({ error: { code: "forbidden", message: "You don't have permission to do that." } });
    }
  });

  it("crew get their bell but not Who hears about new work", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const h = mount(w);
    expect((await h.call(a, "v1/admin/count", { user: p.crew.userId })).status).toBe(200);
    expect((await h.call(a, "v1/admin/routing", { user: p.crew.userId })).status).toBe(403);
    expect((await h.call(a, "v1/admin/routing", { method: "POST", body: { key: "visits", mode: "owner", userIds: [], extraEmails: [] }, user: p.crew.userId })).status).toBe(403);
  });

  it("an authorize answer that names no person is refused 403 and reported (3.6)", async () => {
    const w = world(t);
    const a = tenant("a");
    greenAcres(w.directory, a);
    const h = mount(w, { authorize: () => true });
    const res = await h.call(a, "v1/admin/count", { user: "anyone" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden", message: "Sign in again to see your alerts." } });
    expect(h.reported.map((r) => r.route)).toEqual(["authorize"]);
  });

  it("authorize's Response (a host's 401, the company gate's 403) is returned as it is", async () => {
    const w = world(t);
    const a = tenant("a");
    greenAcres(w.directory, a);
    const h = mount(w);
    const res = await h.call(a, "v1/admin/count", { user: "stranger" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden", message: "You're not part of this company." } });
  });

  it("refuses a cross-site POST before any work", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const h = mount(w);
    const variants: Record<string, string>[] = [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "", origin: "https://elsewhere.example" }];
    for (const headers of variants) {
      h.asked.length = 0;
      const req = h.request(a, "v1/admin/read-all", { method: "POST", user: p.owner.userId, headers });
      if (headers["sec-fetch-site"] === "") req.headers.delete("sec-fetch-site");
      const res = await h.handlers.handle(req);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("cross_site");
      expect(h.asked).toEqual([]);
    }
  });

  it("refuses a POST from a sibling site on the same domain: same-site is another origin (review SEC-04)", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const h = mount(w);
    // The app is https://app.test; www.app.test (a CMS, a taken-over
    // subdomain) carries the Lax session cookie and is "same-site".
    const variants: Record<string, string>[] = [
      { "sec-fetch-site": "same-site", origin: "https://www.app.test" },
      { "sec-fetch-site": "", origin: "https://www.app.test" },
      { "sec-fetch-site": "", referer: "https://www.app.test/page" },
      { "sec-fetch-site": "", origin: "http://app.test" },
      { "sec-fetch-site": "", origin: "https://app.test:8443" },
    ];
    for (const headers of variants) {
      const req = h.request(a, "v1/admin/routing", {
        method: "POST",
        user: p.owner.userId,
        headers,
        body: { key: "estimates", mode: "chosen", userIds: [], extraEmails: ["leads@attacker.test"] },
      });
      if (headers["sec-fetch-site"] === "") req.headers.delete("sec-fetch-site");
      const res = await h.handlers.handle(req);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("cross_site");
    }
    expect((await w.alerts.routing(a)).get("estimates")).toBeUndefined();
  });

  it("still takes a POST from this site's own pages: same-origin, none, or an Origin equal to the site's own (also behind a proxy)", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const h = mount(w);
    const variants: Record<string, string>[] = [
      { "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "none" },
      { "sec-fetch-site": "", origin: "https://app.test" },
      { "sec-fetch-site": "", referer: "https://app.test/app/alerts" },
      { "sec-fetch-site": "", origin: "https://greenacres.example", "x-forwarded-host": "greenacres.example", "x-forwarded-proto": "https" },
      { "sec-fetch-site": "", origin: "https://greenacres.example", "x-forwarded-host": "greenacres.example" },
    ];
    for (const headers of variants) {
      const req = h.request(a, "v1/admin/read-all", { method: "POST", user: p.owner.userId, headers });
      if (headers["sec-fetch-site"] === "") req.headers.delete("sec-fetch-site");
      const res = await h.handlers.handle(req);
      expect(res.status, JSON.stringify(headers)).toBe(200);
    }
    const proxied = h.request(a, "v1/admin/read-all", {
      method: "POST",
      user: p.owner.userId,
      headers: { origin: "http://greenacres.example", "x-forwarded-host": "greenacres.example", "x-forwarded-proto": "https" },
    });
    proxied.headers.delete("sec-fetch-site");
    expect((await h.handlers.handle(proxied)).status).toBe(403);
  });

  it("an unknown path is 404, a known one on the wrong method 405 with allow, a body over 16 KB 400", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const h = mount(w);
    expect((await h.call(a, "v1/admin/nope", { user: p.owner.userId })).status).toBe(404);
    expect((await h.call(a, "v1/admin/alerts/x/archive", { method: "POST", user: p.owner.userId })).status).toBe(404);
    const wrong = await h.call(a, "v1/admin/count", { method: "POST", user: p.owner.userId });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET");
    const both = await h.call(a, "v1/admin/preferences", { method: "DELETE", user: p.owner.userId });
    expect(both.headers.get("allow")).toBe("GET, POST");
    const big = await h.call(a, "v1/admin/routing", { method: "POST", user: p.owner.userId, body: JSON.stringify({ key: "x".repeat(17_000) }) });
    expect(big.status).toBe(400);
    expect(big.body).toMatchObject({ error: { code: "invalid", message: "That's too long to save." } });
  });
});

describe("the bell's routes", () => {
  it("count, list, read and read-all answer in the wire's shape, with the links", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.notify([draft(a, "tenancy.member.joined", { title: "Cam joined the team", body: null, href: "/settings/team" }), draft(a, "estimator.lead")]);
    const h = mount(w);
    const user = p.owner.userId;
    expect((await h.call(a, "v1/admin/count", { user })).body).toEqual({ unread: 2, reachable: true } satisfies AlertCountWire);
    const list = (await h.call(a, "v1/admin/alerts", { user })).body as unknown as AlertListWire;
    expect(list.unread).toBe(2);
    expect(list.reachable).toBe(true);
    expect(list.links).toEqual({ inbox: "/app/alerts", settings: "/app/alerts/settings" });
    expect(list.nextCursor).toBeNull();
    const team = list.alerts.find((x) => x.kind === "tenancy.member.joined")!;
    expect(team).toEqual({ id: team.id, kind: "tenancy.member.joined", category: "Team", title: "Cam joined the team", body: null, href: "/settings/team", at: "2026-10-15T15:00:00.000Z", read: false });
    expect((await h.call(a, `v1/admin/alerts/${team.id}/read`, { method: "POST", user })).body).toEqual({ unread: 1, reachable: true });
    expect((await h.call(a, `v1/admin/alerts/${team.id}/read`, { method: "POST", user })).body).toEqual({ unread: 1, reachable: true });
    expect((await h.call(a, "v1/admin/alerts", { user, query: { unread: "1" } })).body).toMatchObject({ alerts: [{ kind: "estimator.lead" }] });
    expect((await h.call(a, "v1/admin/read-all", { method: "POST", user })).body).toEqual({ unread: 0, reachable: true });
  });

  it("another person's or company's alert id is 404 \"That alert isn't here.\"", async () => {
    const directory = new Directory();
    const w = world(t, {}, directory);
    const a = tenant("a");
    const b = tenant("b");
    const p = greenAcres(directory, a);
    const q = greenAcres(directory, b);
    await w.alerts.notify(draft(a, "tenancy.member.joined"));
    const [alert] = await rowsFor(t, a, p.owner.userId);
    const h = mount(w);
    for (const [company, user] of [
      [b, q.owner.userId],
      [a, p.admin.userId],
    ] as const) {
      const res = await h.call(company, `v1/admin/alerts/${alert!.id}/read`, { method: "POST", user });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: "not_found", message: "That alert isn't here." } });
    }
  });

  it("a bad limit or cursor is 400", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const h = mount(w);
    expect((await h.call(a, "v1/admin/alerts", { user: p.owner.userId, query: { limit: "500" } })).status).toBe(400);
    const bad = await h.call(a, "v1/admin/alerts", { user: p.owner.userId, query: { cursor: "nope!" } });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: { code: "invalid", issues: [{ path: ["cursor"] }] } });
  });

  it("the reader's permissions narrow the answer: a demoted member's count and list agree", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.setRouting({ tenantId: a, routing: "estimates", mode: "chosen", userIds: [p.admin.userId], extraEmails: [], by: p.owner.userId });
    await w.alerts.notify([draft(a, "estimator.lead"), draft(a, "scheduling.visit.moved", { assignedUserIds: [p.admin.userId] })]);
    const h = mount(w);
    expect((await h.call(a, "v1/admin/count", { user: p.admin.userId })).body).toMatchObject({ unread: 2 });
    w.directory.member(a, p.admin.userId)!.role = "crew";
    const count = (await h.call(a, "v1/admin/count", { user: p.admin.userId })).body as unknown as AlertCountWire;
    const list = (await h.call(a, "v1/admin/alerts", { user: p.admin.userId })).body as unknown as AlertListWire;
    expect(count.unread).toBe(1);
    expect(list.alerts.map((x) => x.kind)).toEqual(["scheduling.visit.moved"]);
    expect(list.unread).toBe(count.unread);
  });

  it("hrefFor rewrites every listed href; an answer that isn't a path on this site is dropped and reported (review G16)", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.notify([draft(a, "tenancy.member.joined", { href: "/settings/team" }), draft(a, "estimator.lead", { href: "/app/estimates/e1" })]);
    const h = mount(w, { hrefFor: async (_t, href) => (href.startsWith("/settings") ? "//evil.example/x" : `/app/switch/green-acres?next=${encodeURIComponent(href)}`) });
    const list = (await h.call(a, "v1/admin/alerts", { user: p.owner.userId })).body as unknown as AlertListWire;
    const byKind = Object.fromEntries(list.alerts.map((x) => [x.kind, x.href]));
    expect(byKind["estimator.lead"]).toBe("/app/switch/green-acres?next=%2Fapp%2Festimates%2Fe1");
    expect(byKind["tenancy.member.joined"]).toBeNull();
    expect(h.reported.map((r) => r.route)).toContain("list");
  });
});

describe("reachable (review BO-12)", () => {
  it("false for a member on no list, true for crew holding schedule.route", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const books = w.directory.add(a, { userId: `bk-${a}`, name: "Bea Books", email: `bea@${a}.test`, role: "bookkeeper" });
    const h = mount(w);
    expect((await h.call(a, "v1/admin/count", { user: books.userId })).body).toEqual({ unread: 0, reachable: false });
    const prefs = (await h.call(a, "v1/admin/preferences", { user: books.userId })).body as unknown as PreferencesWire;
    expect(prefs.reachable).toBe(false);
    expect(prefs.choices).toEqual([expect.objectContaining({ kind: "invoicing.invoice.paid", receives: false, routed: { group: "Invoices opened, paid or overdue", onList: false, viaAssigned: false } })]);
    expect((await h.call(a, "v1/admin/count", { user: p.crew.userId })).body).toEqual({ unread: 0, reachable: true });
    // On the list → reachable.
    await w.alerts.setRouting({ tenantId: a, routing: "invoices", mode: "chosen", userIds: [books.userId], extraEmails: [], by: p.owner.userId });
    expect((await h.call(a, "v1/admin/count", { user: books.userId })).body).toEqual({ unread: 0, reachable: true });
    expect(NOT_ON_A_LIST).toMatch(/^You're not on any alert lists yet/);
  });
});

describe("preferences", () => {
  it("lists the kinds the person holds, in registry order, with their channel, notes and list", async () => {
    const w = world(t, { emailDelivery: () => ({ available: true, offReason: null, offKinds: { "estimator.lead": "New lead (to your office)" } }) });
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.setChoice({ tenantId: a, userId: p.owner.userId, kind: "invoicing.invoice.paid", channel: "in_app" });
    const h = mount(w);
    const prefs = (await h.call(a, "v1/admin/preferences", { user: p.owner.userId })).body as unknown as PreferencesWire;
    expect(prefs.emailAddress).toBe(p.owner.email);
    expect(prefs.emailAvailable).toBe(true);
    expect(prefs.canManageRouting).toBe(true);
    expect(prefs.reachable).toBe(true);
    expect(prefs.links).toEqual({ messages: "/app/messages" });
    expect(prefs.categories).toEqual(["Team", "Visits", "Estimates", "Invoices", "Messages"]);
    const by = Object.fromEntries(prefs.choices.map((c) => [c.kind, c]));
    expect(by["estimator.lead"]).toMatchObject({
      emailOffered: false,
      emailOffInMessages: true,
      emailNote: 'Emails for this are switched off in Messages ("New lead (to your office)"). Turn it back on there.',
      channel: "in_app",
      routed: { group: "New estimate requests and quote answers", onList: true, viaAssigned: false },
      receives: true,
    });
    expect(by["comms.message.failed"]).toMatchObject({ emailOffered: false, emailNote: "This alert is only shown in the app.", emailOffInMessages: false, routed: null });
    expect(by["invoicing.invoice.paid"]).toMatchObject({ channel: "in_app", emailOffered: true, emailNote: null });
    expect(by["scheduling.visit.moved"]).toMatchObject({ channel: "email", routed: { onList: true, viaAssigned: true } });
  });

  it("says where each kind's emails go: the business email for the owner while a list is on The owner, else the person's own (review BO-1)", async () => {
    const w = world(t, { ownerEmail: () => "office@greenacres.test" });
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const h = mount(w);
    const owner = (await h.call(a, "v1/admin/preferences", { user: p.owner.userId })).body as unknown as PreferencesWire;
    const by = Object.fromEntries(owner.choices.map((c) => [c.kind, c]));
    expect(owner.emailAddress).toBe(p.owner.email);
    expect(by["estimator.lead"]?.emailTo).toBe("office@greenacres.test");
    expect(by["invoicing.invoice.paid"]?.emailTo).toBe("office@greenacres.test");
    expect(by["tenancy.member.joined"]?.emailTo).toBe(p.owner.email);
    // The owner on a list of people chosen by name gets their own copy at their own address.
    await w.alerts.setRouting({ tenantId: a, routing: "estimates", mode: "chosen", userIds: [p.owner.userId, p.member.userId], extraEmails: [], by: p.owner.userId });
    const chosen = (await h.call(a, "v1/admin/preferences", { user: p.owner.userId })).body as unknown as PreferencesWire;
    expect(chosen.choices.find((c) => c.kind === "estimator.lead")?.emailTo).toBe(p.owner.email);
    const member = (await h.call(a, "v1/admin/preferences", { user: p.member.userId })).body as unknown as PreferencesWire;
    expect(member.choices.find((c) => c.kind === "estimator.lead")?.emailTo).toBe(p.member.email);
    // An owner with no sign-in address still gets the business copies: email is offered for those.
    w.directory.member(a, p.owner.userId)!.email = null;
    const noOwn = (await h.call(a, "v1/admin/preferences", { user: p.owner.userId })).body as unknown as PreferencesWire;
    expect(noOwn.choices.find((c) => c.kind === "invoicing.invoice.paid")).toMatchObject({ emailTo: "office@greenacres.test", emailOffered: true, emailNote: null });
    expect(noOwn.choices.find((c) => c.kind === "tenancy.member.joined")).toMatchObject({ emailTo: null, emailOffered: false, emailNote: "There's no email address on your account." });
  });

  it("says why email isn't offered: no email on the site, no address on the account", async () => {
    const w1 = world(t, { email: undefined });
    const a = tenant("a");
    const p = greenAcres(w1.directory, a);
    const prefs1 = (await mount(w1).call(a, "v1/admin/preferences", { user: p.owner.userId })).body as unknown as PreferencesWire;
    expect(prefs1).toMatchObject({ emailAvailable: false, emailOffReason: "This site doesn't send email yet, so alerts stay in the app." });
    expect(prefs1.choices.every((c) => !c.emailOffered)).toBe(true);
    expect(prefs1.choices.find((c) => c.kind === "estimator.lead")?.emailNote).toBe("This site doesn't send email yet, so alerts stay in the app.");

    const w2 = world(t);
    const b = tenant("b");
    const q = greenAcres(w2.directory, b);
    w2.directory.member(b, q.member.userId)!.email = null;
    const prefs2 = (await mount(w2).call(b, "v1/admin/preferences", { user: q.member.userId })).body as unknown as PreferencesWire;
    expect(prefs2.emailAddress).toBeNull();
    expect(prefs2.canManageRouting).toBe(false);
    expect(prefs2.choices.find((c) => c.kind === "invoicing.invoice.paid")?.emailNote).toBe("There's no email address on your account.");
    // A routed kind they aren't on: listed, no radios.
    expect(prefs2.choices.find((c) => c.kind === "estimator.lead")).toMatchObject({ receives: false, routed: { onList: false } });
  });

  it("preference-set saves a choice and answers the new preferences; refuses an unknown kind and an email that can't go", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const h = mount(w);
    const saved = await h.call(a, "v1/admin/preferences", { method: "POST", user: p.owner.userId, body: { kind: "tenancy.member.joined", channel: "email" } });
    expect(saved.status).toBe(200);
    expect((saved.body as unknown as PreferencesWire).choices.find((c) => c.kind === "tenancy.member.joined")?.channel).toBe("email");
    expect((await w.alerts.choices({ tenantId: a, userId: p.owner.userId })).get("tenancy.member.joined")).toBe("email");
    const unknown = await h.call(a, "v1/admin/preferences", { method: "POST", user: p.owner.userId, body: { kind: "unknown.kind", channel: "in_app" } });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ error: { code: "invalid", issues: [{ path: ["kind"] }] } });
    const never = await h.call(a, "v1/admin/preferences", { method: "POST", user: p.owner.userId, body: { kind: "comms.message.failed", channel: "email" } });
    expect(never.status).toBe(400);
    expect(never.body).toMatchObject({ error: { code: "invalid", issues: [{ path: ["channel"], message: "This alert is only shown in the app." }] } });
    const shape = await h.call(a, "v1/admin/preferences", { method: "POST", user: p.owner.userId, body: { kind: "tenancy.member.joined", channel: "sms" } });
    expect(shape.status).toBe(400);
    // A kind the person can't get isn't theirs to set.
    const notMine = await h.call(a, "v1/admin/preferences", { method: "POST", user: p.crew.userId, body: { kind: "estimator.lead", channel: "in_app" } });
    expect(notMine.status).toBe(400);
  });
});

describe("routing", () => {
  it("answers each group with its people, what it covers, and where the owner's copies go (review BO-01)", async () => {
    const w = world(t, { ownerEmail: () => "office@greenacres.test" });
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const h = mount(w);
    const routing = (await h.call(a, "v1/admin/routing", { user: p.owner.userId })).body as unknown as RoutingWire;
    expect(routing.groups.map((g) => g.key)).toEqual(["estimates", "visits", "invoices"]);
    const estimates = routing.groups[0]!;
    expect(estimates).toMatchObject({
      label: "New estimate requests and quote answers",
      covers: ["Someone asks for an estimate", "A customer accepts a quote"],
      mode: "owner",
      userIds: [],
      extraEmails: [],
      ownerEmail: "office@greenacres.test",
      ownerEmailIsBusiness: true,
      emailNote: null,
    });
    expect(estimates.candidates.map((c) => c.userId).sort()).toEqual([p.admin.userId, p.member.userId, p.owner.userId, p.viewer.userId].sort());
    expect(estimates.candidates.find((c) => c.isOwner)).toMatchObject({ userId: p.owner.userId, name: "Gail Owner" });

    const own = world(t, { ownerEmail: () => null });
    const b = tenant("b");
    const q = greenAcres(own.directory, b);
    const plain = (await mount(own).call(b, "v1/admin/routing", { user: q.owner.userId })).body as unknown as RoutingWire;
    expect(plain.groups[0]).toMatchObject({ ownerEmail: q.owner.email, ownerEmailIsBusiness: false });
  });

  it("says when the group's emails are switched off in Messages (review BO-11)", async () => {
    const w = world(t, { emailDelivery: () => ({ available: true, offReason: null, offKinds: { "estimator.lead": "New lead (to your office)" } }) });
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const routing = (await mount(w).call(a, "v1/admin/routing", { user: p.owner.userId })).body as unknown as RoutingWire;
    expect(routing.groups[0]?.emailNote).toBe('Emails for this are switched off in Messages ("New lead (to your office)"). Turn it back on there.');
    expect(routing.groups[1]?.emailNote).toBeNull();
  });

  it("names the kinds the owner's own 'In the app' choice keeps out of the business mailbox, and whose choice it is (review BO-1)", async () => {
    const w = world(t, { ownerEmail: () => "office@greenacres.test" });
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const h = mount(w);
    const before = (await h.call(a, "v1/admin/routing", { user: p.owner.userId })).body as unknown as RoutingWire;
    expect(before.groups[0]).toMatchObject({ key: "estimates", ownerInAppOnly: [], ownerIsYou: true });
    // A kind that defaults to "In the app" sends nothing until the owner picks email.
    expect(before.groups[1]).toMatchObject({ key: "visits", ownerInAppOnly: ["A visit request is about to lapse"] });
    await w.alerts.setChoice({ tenantId: a, userId: p.owner.userId, kind: "estimator.lead", channel: "in_app" });
    const mine = (await h.call(a, "v1/admin/routing", { user: p.owner.userId })).body as unknown as RoutingWire;
    expect(mine.groups[0]).toMatchObject({ ownerEmail: "office@greenacres.test", ownerEmailIsBusiness: true, ownerInAppOnly: ["Someone asks for an estimate"], ownerIsYou: true });
    // The admin, who may also manage the lists, reads it as the owner's choice.
    const theirs = (await h.call(a, "v1/admin/routing", { user: p.admin.userId })).body as unknown as RoutingWire;
    expect(theirs.groups[0]).toMatchObject({ ownerInAppOnly: ["Someone asks for an estimate"], ownerIsYou: false });
    // What really happens: no office email for that lead (contract step 2).
    await w.alerts.notify(draft(a, "estimator.lead", { dedupeKey: "estimator.lead:bo1" }));
    expect(await w.alerts.claimEmails({ tenantId: a, kind: "estimator.lead", dedupeKey: "estimator.lead:bo1" })).toEqual([]);
  });

  it("tells the audit seam about each saved list, and names an outside address that starts getting the emails (review SEC-04)", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const events: unknown[] = [];
    const h = mount(w, { audit: (event) => void events.push(event) });
    const post = (body: unknown) => h.call(a, "v1/admin/routing", { method: "POST", user: p.owner.userId, body });
    expect((await post({ key: "estimates", mode: "chosen", userIds: [p.member.userId], extraEmails: ["Leads@Outside.test"] })).status).toBe(200);
    expect(events).toEqual([
      {
        action: "alerts.routing.address-added",
        actorUserId: p.owner.userId,
        tenantId: a,
        resourceType: "alerts_routing",
        resourceId: "estimates",
        metadata: {
          group: "New estimate requests and quote answers",
          mode: "chosen",
          people: 1,
          addresses: ["leads@outside.test"],
          addedAddresses: ["leads@outside.test"],
          removedAddresses: [],
        },
      },
    ]);
    events.length = 0;
    expect((await post({ key: "estimates", mode: "owner", userIds: [], extraEmails: ["leads@outside.test"] })).status).toBe(200);
    expect(events).toMatchObject([{ action: "alerts.routing.changed", metadata: { mode: "owner", addedAddresses: [], removedAddresses: ["leads@outside.test"] } }]);
    // A failing audit seam is reported; the list is saved all the same.
    const failing = mount(w, {
      audit: () => {
        throw new Error("audit log down");
      },
    });
    const saved = await failing.call(a, "v1/admin/routing", { method: "POST", user: p.owner.userId, body: { key: "visits", mode: "owner", userIds: [], extraEmails: [] } });
    expect(saved.status).toBe(200);
    expect(failing.reported.map((r) => r.route)).toContain("routing-set");
  });

  it("routing-set saves and answers; a stranger's id is a 400 whose issue never names it", async () => {
    const directory = new Directory();
    const w = world(t, {}, directory);
    const a = tenant("a");
    const b = tenant("b");
    const p = greenAcres(directory, a);
    const q = greenAcres(directory, b);
    const h = mount(w);
    const saved = await h.call(a, "v1/admin/routing", {
      method: "POST",
      user: p.owner.userId,
      body: { key: "visits", mode: "chosen", userIds: [p.member.userId], extraEmails: ["Dispatch@GreenAcres.test"] },
    });
    expect(saved.status).toBe(200);
    expect((saved.body as unknown as RoutingWire).groups[1]).toMatchObject({ mode: "chosen", userIds: [p.member.userId], extraEmails: ["dispatch@greenacres.test"] });
    // B's owner names A's member.
    const stranger = await h.call(b, "v1/admin/routing", { method: "POST", user: q.owner.userId, body: { key: "visits", mode: "chosen", userIds: [p.member.userId], extraEmails: [] } });
    expect(stranger.status).toBe(400);
    expect(stranger.body).toEqual({ error: { code: "invalid", message: "Pick people from your company.", issues: [{ path: ["userIds"], message: "Pick people from your company." }] } });
    expect(stranger.text).not.toContain(p.member.userId);
    // And B's routing never shows A's people or addresses.
    const theirs = await h.call(b, "v1/admin/routing", { user: q.owner.userId });
    expect(theirs.text).not.toContain(p.member.userId);
    expect(theirs.text).not.toContain("dispatch@greenacres.test");
  });

  it("refuses more than 5 addresses, a bad address, and an unknown group", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const h = mount(w);
    const post = (body: unknown) => h.call(a, "v1/admin/routing", { method: "POST", user: p.owner.userId, body });
    expect((await post({ key: "visits", mode: "chosen", userIds: [], extraEmails: ["a@x.test", "b@x.test", "c@x.test", "d@x.test", "e@x.test", "f@x.test"] })).body).toMatchObject({
      error: { issues: [{ path: ["extraEmails"], message: "Add at most 5 addresses." }] },
    });
    expect((await post({ key: "visits", mode: "chosen", userIds: [], extraEmails: ["not an address"] })).body).toMatchObject({
      error: { issues: [{ path: ["extraEmails", 0], message: "That doesn't look like an email address." }] },
    });
    expect((await post({ key: "nope", mode: "owner", userIds: [], extraEmails: [] })).status).toBe(400);
  });
});

describe("two companies through every route", () => {
  it("B gets 404 or nothing of A", async () => {
    const directory = new Directory();
    const w = world(t, {}, directory);
    const a = tenant("a");
    const b = tenant("b");
    const p = greenAcres(directory, a);
    const q = greenAcres(directory, b);
    await w.alerts.setRouting({ tenantId: a, routing: "estimates", mode: "chosen", userIds: [p.member.userId], extraEmails: ["office@alpha.test"], by: p.owner.userId });
    await w.alerts.setChoice({ tenantId: a, userId: p.owner.userId, kind: "tenancy.member.joined", channel: "email" });
    await w.alerts.notify([draft(a, "tenancy.member.joined", { title: "Alpha secret title", body: "Alpha secret body" }), draft(a, "estimator.lead", { title: "Alpha lead" })]);
    const [alert] = await rowsFor(t, a, p.owner.userId);
    const aStrings = [alert!.id, "Alpha secret", "Alpha lead", p.member.userId, p.owner.userId, "office@alpha.test", p.owner.email!];
    const h = mount(w);
    for (const row of NOTIFICATIONS_ADMIN_ROUTES) {
      const path = row.path.replace("{alert}", alert!.id);
      const body = JSON.parse(JSON.stringify(row.body ?? {}).replace("{person}", p.member.userId));
      const res = await h.call(b, path, { method: row.method, body, user: q.owner.userId });
      if (row.path.includes("{alert}")) expect(res.status, row.kind).toBe(404);
      for (const secret of aStrings) expect(res.text, `${row.kind} leaked ${secret}`).not.toContain(secret);
    }
    // A is untouched by B's posts.
    expect((await rowsFor(t, a, p.owner.userId)).every((r) => r.readAt === null)).toBe(true);
    expect((await w.alerts.routing(a)).get("estimates")?.userIds).toEqual([p.member.userId]);
  });
});

describe("construction", () => {
  it("refuses a missing tenant source, authorize, or an instance it didn't make", () => {
    const w = world(t);
    expect(() => createNotificationHandlers({ notifications: w.alerts, authorize: () => true })).toThrow(/tenantId or resolveTenant/);
    expect(() => createNotificationHandlers({ notifications: w.alerts, tenantId: "x" } as never)).toThrow(/authorize/);
    expect(() => createNotificationHandlers({ notifications: Object.fromEntries(Object.entries(w.alerts)) as never, tenantId: "x", authorize: () => true })).toThrow(/createNotifications/);
  });
});
