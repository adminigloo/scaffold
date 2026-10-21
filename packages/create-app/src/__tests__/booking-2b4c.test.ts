/**
 * TENANCY 2b-4c, AS THE GENERATOR WRITES IT (create-app 0.32): book a call
 * (--booking) per company. Read from the PLAN as text; the generated
 * project's own suite (the isolation proof on PGlite) runs the routes.
 *
 *   - companies mode: /app/calls over the company seams, the booking page at
 *     /t/{web address}/book through the public gate, hosts that are the
 *     company's own people, the plan's "people taking calls", the proof;
 *   - single business: /admin/calls on staff keys, /book;
 *   - with --email the emails go out as the company; without, none is promised.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertAnswersCompatible, capabilitiesFor, DEFAULT_ANSWERS, packagesFor, type Answers } from "../answers.js";
import { packageVersions, planEmit, type EmitPlan } from "../emit.js";
import { FEATURE_ENTITIES, featureSuiteNames } from "../feature-proofs-emit.js";
import { upgradeNotesFor } from "../upgrade-notes.js";
import { TEMPLATE_DIR } from "./configurations.js";

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "igloo-calls", includeBooking: true, ...overrides };
}

const cache = new Map<string, Promise<EmitPlan>>();
function plan(overrides: Partial<Answers> = {}): Promise<EmitPlan> {
  const key = JSON.stringify(answers(overrides));
  let found = cache.get(key);
  if (!found) {
    found = planEmit(TEMPLATE_DIR, "/out", answers(overrides));
    cache.set(key, found);
  }
  return found;
}

function file(p: EmitPlan, ...segments: string[]): string {
  const contents = p.files.get(join(...segments));
  if (contents === undefined) throw new Error(`the plan has no ${segments.join("/")}`);
  return contents;
}
const has = (p: EmitPlan, ...segments: string[]) => p.files.has(join(...segments));
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const COMPANIES: Partial<Answers> = { tenantNoun: "Company", businessModel: "subscription", includeEmail: true };

describe("companies mode", () => {
  it("each company's calls and booking page, through the company seams", async () => {
    const p = await plan(COMPANIES);
    const glue = code(file(p, "src", "server", "booking.ts"));
    expect(glue).toContain("resolveTenant: companyRoutes.resolveTenant");
    expect(glue).toContain("authorize: companyAuthorizer(overrides)");
    expect(glue).toContain("member: teamMember");
    expect(glue).toContain("bookingHostLimit(tenantId)");
    expect(glue).toContain("admit: admitPublic");
    expect(glue).toContain("admitExisting: (tenantId, req) => sentLinks.admit(tenantId, req)");
    // The links a company sent stay open while its plan is closed: that gate asks no plan.
    expect(glue).toContain("createPublicCompanySeams({ tenancy })");
    // Review H3: the platform's emails — "{company} via {site}", the owner's verified address only.
    expect(glue).toContain("platformBookingEmails(event, {");
    expect(glue).toContain("businessName: profile.name");
    expect(glue).toContain("appName: SITE_NAME");
    expect(glue).toContain("replyTo: await ownerAddress(event.tenantId)");
    expect(glue).toContain('person.roleKey === "owner"');
    expect(glue).not.toContain("profile.replyTo");
    expect(glue).not.toMatch(/EMAIL_REPLY_TO/);
    expect(glue).toContain("TRIAL_EMAIL_POLICY = { limit: 20");
    // Review H1: a host whose person left is off; "Add a person" picks from the team.
    expect(glue).toContain("hostMembers: stillMembers");
    expect(glue).toContain("listMembers: teamOf");
    // Review H2/L2: an IPv6 caller by its /64.
    expect(glue).toContain("return last ? networkKeyOf(last) : null;");
    // Review L3/L4: a failed reminder is released; no send starts unless it fits before 50 s.
    expect(glue).toContain("else await releaseReminder(ctx, due.booking.id);");
    expect(glue).toContain("deadline - EMAIL_SEND_MS - CRON_MARGIN_MS");
    expect(file(p, "app", "api", "app", "[tenantId]", "calls", "[...path]", "route.ts")).toContain("buildBookingAdminHandlers()");
    expect(file(p, "app", "api", "t", "[slug]", "calls", "[...path]", "route.ts")).toContain("buildBookingPublicHandlers()");
    expect(file(p, "app", "(site)", "app", "calls", "page.tsx")).toContain('permission="booking.calls.view"');
    expect(file(p, "app", "(company)", "t", "[slug]", "book", "page.tsx")).toContain("<PublicCompanyGate");
    expect(file(p, "app", "(company)", "t", "[slug]", "book", "manage", "[token]", "page.tsx")).toContain("noReferrer: true");
    expect(file(p, "src", "tenancy.ts")).toContain('{ path: "/book", label: "Book a call" }');
    expect(has(p, "app", "admin", "calls", "page.tsx")).toBe(false);
    expect(has(p, "app", "(site)", "book", "page.tsx")).toBe(false);
  });

  it("company keys, the plan's people taking calls, the cron, the proof", async () => {
    const p = await plan(COMPANIES);
    expect(file(p, "src", "permissions", "catalog.ts")).toContain("bookingCompanyPermissions");
    expect(file(p, "src", "plans.ts")).toContain('booking_hosts: { kind: "quota"');
    expect(file(p, "src", "server", "plan-gate.ts")).toContain('planLimit(tenantId, "booking_hosts")');
    expect(JSON.parse(file(p, "vercel.json")).crons).toContainEqual({ path: "/api/cron/booking", schedule: "0 13 * * *" });
    expect(file(p, "src", "server", "booking.ts")).toContain("const CRON_BUDGET_MS = 50_000;");
    expect(featureSuiteNames(answers(COMPANIES))).toContain("booking");
    const proof = file(p, "src", "server", "__tests__", "feature-isolation.test.ts");
    expect(proof).toContain("BOOKING_ADMIN_ROUTES");
    expect(proof).toContain("BOOKING_PUBLIC_ROUTES");
    const rows = file(p, "src", "test", "company-rows.ts");
    for (const entity of FEATURE_ENTITIES["booking"]!) expect(rows).toContain(`rows${entity.includes("-") ? `["${entity}"]` : `.${entity}`} =`);
    expect(capabilitiesFor(answers(COMPANIES))).toContain("booking.companies");
  });

  it("without email, nothing is promised and nothing is sent", async () => {
    const glue = file(await plan({ ...COMPANIES, includeEmail: false }), "src", "server", "booking.ts");
    expect(glue).toContain("export const bookingEmailsConfigured: boolean = false;");
    expect(code(glue)).not.toContain("onEvent");
  });
});

describe("one business", () => {
  it("/admin/calls on staff keys, /book in the sitemap, /book/manage kept out", async () => {
    const p = await plan({ tenantNoun: "none" });
    const glue = code(file(p, "src", "server", "booking.ts"));
    expect(glue).toContain('export const BOOKING_TENANT = "primary";');
    expect(glue).toContain("authorizeStaffFor(BOOKING_STAFF_KEYS");
    expect(file(p, "app", "admin", "calls", "page.tsx")).toContain('can?.can("booking.calls.view")');
    expect(has(p, "app", "(site)", "book", "page.tsx")).toBe(true);
    expect(has(p, "app", "(site)", "book", "manage", "[token]", "page.tsx")).toBe(true);
    expect(file(p, "src", "permissions", "catalog.ts")).toContain("bookingPermissions");
    expect(has(p, "src", "server", "staff-access.ts")).toBe(true);
    expect(capabilitiesFor(answers({ tenantNoun: "none" }))).toContain("booking.calls");
  });

  it("refuses --booking with no admin panel, only for one business", () => {
    expect(() => assertAnswersCompatible(answers({ tenantNoun: "none", adminShell: "none" }))).toThrow(/admin panel/);
    expect(() => assertAnswersCompatible(answers({ tenantNoun: "Company", adminShell: "none" }))).not.toThrow();
  });
});

describe("packages, versions and the upgrade notes", () => {
  it("installs both halves at 0.2, and tells a 0.31 project what to do", () => {
    expect(packagesFor(answers())).toEqual(expect.arrayContaining(["@adminigloo/booking", "@adminigloo/booking-widget"]));
    const versions = packageVersions();
    // The release lines (booking 0.3 adds forgetTenant).
    expect(versions["booking"]).toMatch(/^0\.3\.\d+$/);
    expect(versions["booking-widget"]).toMatch(/^0\.3\.\d+$/);
    expect(upgradeNotesFor(answers(COMPANIES), "0.31.0").join("\n")).toContain("upgrade-0.1-to-0.2.sql");
    // Nothing more about booking for a 0.32 project (a later release's notes, e.g. 0.34's store, aren't this test's).
    expect(upgradeNotesFor(answers(COMPANIES), "0.32.0").filter((note) => /booking|calls/i.test(note))).toEqual([]);
  });
});
