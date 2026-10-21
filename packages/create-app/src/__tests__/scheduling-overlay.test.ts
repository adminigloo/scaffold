/**
 * A generated --scheduling project is the business scenario, wired — and the
 * wiring is only package exports.
 *
 * Scheduling 0.4 moved the whole feature onto two HTTP handlers and five
 * widgets, so what this generator owns is glue: which handler each route
 * mounts, what the routes are given, who hears about each visit, what the
 * comms cron asks at send time, and which pages exist. Every one of those is
 * a place the scenario breaks with a green build — a public route mounting
 * the staff handler, a notify module nobody calls, a cron that drains
 * reminders without putting the customer's link in them, a comms sender left
 * as `{}` in a project that installed the mail package (MN-04).
 *
 * The routes reach `@/db` and the rendered modules, so they can't run here;
 * this reads the PLAN as text, the way the capability evidence does. They run
 * for real in a generated project (scripts/verify-generated.mjs) and against
 * the real handlers in e2e/tests/scheduling-scenario.spec.ts.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, capabilitiesFor, packagesFor, type Answers } from "../answers.js";
import { CAPABILITY_EVIDENCE } from "../capabilities.js";
import { planEmit, type EmitPlan } from "../emit.js";

const TEMPLATE_DIR = join(__dirname, "..", "..", "template");

function answers(overrides: Partial<Answers> = {}): Answers {
  // A SINGLE BUSINESS (--tenant-noun none): the mode whose scheduling this
  // file describes — the fixed business, the staff ladder, /book-visit and
  // /admin/schedule. A companies project's scheduling (each company's own,
  // under /app and /t/{web address}) is tenancy-2a.test.ts's subject.
  return { ...DEFAULT_ANSWERS, projectName: "acme-windows", tenantNoun: "none", includeScheduling: true, ...overrides };
}

const plan = (overrides: Partial<Answers> = {}) => planEmit(TEMPLATE_DIR, "/out", answers(overrides));

function file(p: EmitPlan, ...segments: string[]): string {
  const contents = p.files.get(join(...segments));
  if (contents === undefined) throw new Error(`the plan has no ${segments.join("/")}`);
  return contents;
}

/** Source with comments removed, so a check can't be satisfied by prose. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const PUBLIC_ROUTE = ["app", "api", "schedule", "[...path]", "route.ts"];
const ADMIN_ROUTE = ["app", "api", "admin", "schedule", "[...path]", "route.ts"];
const CRON_ROUTE = ["app", "api", "cron", "scheduling", "route.ts"];

describe("the two scheduling routes", () => {
  it("mount the package's public handler for customers, and nothing staff-only", async () => {
    const source = code(file(await plan(), ...PUBLIC_ROUTE));
    expect(source).toContain("createSchedulingHandlers(");
    // 0.2's public route returned the previous customer's street address from
    // the staff finder; the staff handler would put the calendar on the open
    // internet. Neither may be called from here.
    expect(source).not.toContain("findAvailableSlots(");
    expect(source).not.toContain("createSchedulingAdminHandlers(");
    for (const option of [
      "resolveTenant: resolveSchedulingTenant",
      "onEvent: onSchedulingEvent",
      "emailsEnabled: SCHEDULING_EMAILS_ENABLED",
      "rateLimit: schedulingRateLimit",
      "maps: schedulingMaps",
    ]) {
      expect(source, option).toContain(option);
    }
    for (const verb of ["GET", "POST", "OPTIONS"]) expect(source).toContain(`export const ${verb} = schedule.handle;`);
  });

  it("put the staff handler behind this project's sign-in and staff permissions", async () => {
    const p = await plan();
    const route = code(file(p, ...ADMIN_ROUTE));
    expect(route).toContain("createSchedulingAdminHandlers(");
    expect(route).toContain("authorize: authorizeSchedulingStaff");
    expect(route).toContain("onEvent: onSchedulingEvent");
    expect(route).not.toContain("OPTIONS");

    const server = code(file(p, "src", "server", "scheduling.ts"));
    const authorize = server.slice(server.indexOf("export async function authorizeSchedulingStaff"));
    // The ladder the admin shell climbs: a principal, then staff permissions
    // from OUR tables, then the key. A 401 for nobody, `false` (403) for the rest.
    expect(authorize).toContain("await currentPrincipal()");
    expect(authorize).toContain("await loadStaffPermissions({ principal })");
    expect(authorize).toContain("can.can(SCHEDULING_STAFF_KEYS[permission])");
    expect(authorize).toContain("status: 401");
  });

  it("run the first-boot setup on first use, so no deploy step has to remember it — and never for a stranger", async () => {
    const p = await plan();
    const server = code(file(p, "src", "server", "scheduling.ts"));
    // Customers: in the public handler's tenant seam.
    const seam = server.slice(server.indexOf("export async function resolveSchedulingTenant"));
    expect(seam.slice(0, seam.indexOf("return SCHEDULING_TENANT"))).toContain("await ensureSchedulingSetup()");
    // Staff: only once the caller is known to be staff. The staff handler
    // resolves its tenant BEFORE it authorizes, so setup in that seam would
    // put database work in front of a signed-out caller's 401.
    expect(code(file(p, ...ADMIN_ROUTE))).toContain("resolveTenant: () => SCHEDULING_TENANT");
    const authorize = server.slice(server.indexOf("export async function authorizeSchedulingStaff"));
    // After the caller is known to hold a staff role (`if (!can) return
    // false`), before the key check: the setup can grant crew access, so the
    // permissions are read again after it.
    expect(authorize.indexOf("await ensureSchedulingSetup()")).toBeGreaterThan(authorize.indexOf("if (!can) return false"));
    expect(authorize.indexOf("await ensureSchedulingSetup()")).toBeLessThan(authorize.indexOf("can.can("));
    // Settings only when never saved; a crew only for a business that never had one.
    expect(server).toContain("if (!settings.saved)");
    expect(server).toContain("includeInactive: true");
    expect(server).toContain("backfillVisitInstants(");
  });

  it("choose Google when GOOGLE_MAPS_API_KEY is set and the keyless estimate when not — a configuration check, not a feature flag", async () => {
    const server = code(file(await plan(), "src", "server", "scheduling.ts"));
    expect(server).toContain("env.GOOGLE_MAPS_API_KEY");
    expect(server).toContain("createGoogleMapsProvider(");
    expect(server).toContain("createHaversineMapsProvider()");
  });
});

describe("the pages", () => {
  it("are the package's widgets, mounted on the routes above", async () => {
    const p = await plan({ adminShell: "minimal" });
    expect(code(file(p, "app", "(site)", "book-visit", "page.tsx"))).toMatch(/<VisitPicker\s+baseUrl="\/api\/schedule"/);
    expect(file(p, "app", "(site)", "visit", "[token]", "page.tsx")).toContain(
      '<ManageVisit baseUrl="/api/schedule" token={token} bookHref="/book-visit" />',
    );
    // Tenancy 2b-1: the calendar opens a visit from an alert's link
    // (initialVisitId) and both pages link a visit's photos and files.
    expect(code(file(p, "app", "admin", "schedule", "page.tsx"))).toMatch(/<ScheduleCalendar\s+baseUrl="\/api\/admin\/schedule"/);
    expect(code(file(p, "app", "admin", "schedule", "page.tsx"))).toContain("visitFilesHref={VISIT_FILES_HREF}");
    expect(file(p, "app", "admin", "schedule", "today", "page.tsx")).toContain(
      '<CrewDay baseUrl="/api/admin/schedule" filesHref={VISIT_FILES_HREF} />',
    );
    expect(file(p, "app", "admin", "schedule", "settings", "page.tsx")).toContain(
      '<SchedulingSettings baseUrl="/api/admin/schedule"',
    );
  });

  it("keep the manage page out of every index and every Referer", async () => {
    const p = await plan();
    const page = file(p, "app", "(site)", "visit", "[token]", "page.tsx");
    expect(page).toContain("robots: { index: false, follow: false }");
    expect(page).toContain('referrer: "no-referrer"');
    expect(file(p, "app", "robots.ts")).toContain('"/visit/"');
  });

  it("put the booking page in the public nav and the sitemap, and the manage page in neither", async () => {
    const p = await plan();
    const nav = code(file(p, "src", "nav.ts"));
    expect(nav).toContain('href: "/book-visit"');
    expect(nav).not.toContain('"/visit');
    const sitemap = code(file(p, "app", "sitemap.ts"));
    expect(sitemap).toContain('"/book-visit"');
    expect(sitemap).not.toContain('"/visit');
  });

  it("list the calendar, today's route and settings in the sidebar", async () => {
    const sidebar = file(await plan({ adminShell: "minimal" }), "src", "components", "admin", "AdminNav.tsx");
    for (const href of ["/admin/schedule", "/admin/schedule/today", "/admin/schedule/settings"]) {
      expect(sidebar).toContain(`href: "${href}"`);
    }
    // Without a shell there is no project to plan: --scheduling --admin none
    // is refused (review-create-app.test.ts), because nobody could answer a
    // single booking request.
  });

  it("leaves nothing of the retired tRPC router behind", async () => {
    const p = await plan({ includeComms: true, includeEmail: true, adminShell: "full" });
    for (const [path, contents] of p.files) {
      expect(contents, path).not.toContain("schedulingRouter");
      expect(contents, path).not.toContain("api.scheduling.");
      expect(contents, path).not.toContain("scheduling-policy");
      expect(contents, path).not.toContain("scheduling-seed");
    }
    expect(p.files.has(join("src", "server", "routers", "scheduling.ts"))).toBe(false);
  });
});

describe("who hears about each visit", () => {
  it("with --comms --email: the comms listener, the Resend sender, and the truth about whether mail leaves", async () => {
    const p = await plan({ includeComms: true, includeEmail: true, adminShell: "minimal" });
    const notify = code(file(p, "src", "server", "scheduling-notify.ts"));
    expect(notify).toContain('from "@adminigloo/scheduling/comms"');
    expect(notify).toContain("createSchedulingCommsListener(");
    expect(notify).toContain("[schedulingComms.onEvent]");
    expect(notify).toContain("SCHEDULING_EMAILS_ENABLED: boolean = commsEmailConfigured");
    expect(notify).toContain("adminUrl: schedulingUrls.admin");

    // MN-04: the sender is wired, not described in a comment.
    const senders = code(file(p, "src", "server", "comms-senders.ts"));
    expect(senders).toContain("createEmailSender(");
    expect(senders).toContain("email: (message) =>");
    expect(senders).toContain("commsEmailConfigured: boolean = mailer.configured");
  });

  it("with --comms and no --email: the listener runs, logs every send as skipped, and the page promises no email", async () => {
    const p = await plan({ includeComms: true, includeEmail: false });
    const senders = code(file(p, "src", "server", "comms-senders.ts"));
    expect(senders).toContain("commsSenders: CommsSenders = {}");
    expect(senders).toContain("commsEmailConfigured: boolean = false");
    expect(senders).not.toContain("@adminigloo/email");
    expect(code(file(p, "src", "server", "scheduling-notify.ts"))).toContain("createSchedulingCommsListener(");
  });

  it("without --comms: an empty list and no email promised — never an `if` about comms", async () => {
    const p = await plan({ includeComms: false });
    const notify = code(file(p, "src", "server", "scheduling-notify.ts"));
    expect(notify).toContain("LISTENERS: readonly SchedulingEventListener[] = []");
    expect(notify).toContain("SCHEDULING_EMAILS_ENABLED: boolean = false");
    // Nothing of the comms package: the staff banner is told, as a fact, that
    // it isn't installed (`commsInstalled: false`) — no runtime check.
    expect(notify).not.toContain("@adminigloo/comms");
    expect(notify).not.toContain("scheduling/comms");
    expect(notify).not.toContain("createSchedulingCommsListener");
    expect(notify).toContain("commsInstalled: false");
    expect(p.files.has(join("src", "server", "comms-hooks.ts"))).toBe(false);
    expect(p.files.has(join("src", "server", "comms-senders.ts"))).toBe(false);
  });

  it("links the staff calendar from office emails — there always is one", async () => {
    const notify = file(await plan({ includeComms: true, adminShell: "minimal" }), "src", "server", "scheduling-notify.ts");
    expect(code(notify)).toContain("adminUrl: schedulingUrls.admin");
  });
});

describe("the crons", () => {
  it("drain reminders through the scheduling hook, and scrub the links after", async () => {
    const p = await plan({ includeComms: true, includeEmail: true });
    const hooks = code(file(p, "src", "server", "comms-hooks.ts"));
    expect(hooks).toContain("PRODUCERS: readonly QueueProducer[] = [schedulingComms]");
    const cron = code(file(p, "app", "api", "cron", "comms", "route.ts"));
    expect(cron).toContain("beforeSend: commsBeforeSend");
    expect(cron.indexOf("await afterCommsRun()")).toBeGreaterThan(cron.indexOf("runDueMessages("));
    // The console's "send due now" goes through the same hooks — the comms
    // package's handler runs them (Tenancy 2a, D3: the tRPC router is retired).
    const console = code(file(p, "src", "server", "comms.ts"));
    expect(console).toContain("beforeSend: commsBeforeSend");
    expect(console).toContain("afterRun: afterCommsRun");
    expect(p.files.has(join("src", "server", "routers", "comms.ts"))).toBe(false);
  });

  it("consult nothing extra in a comms project without scheduling", async () => {
    const p = await plan({ includeScheduling: false, includeComms: true });
    const hooks = code(file(p, "src", "server", "comms-hooks.ts"));
    expect(hooks).toContain("PRODUCERS: readonly QueueProducer[] = []");
    expect(hooks).not.toContain("scheduling");
  });

  it("schedule the expiry sweep, behind the same secret, with or without comms", async () => {
    for (const includeComms of [true, false]) {
      const p = await plan({ includeComms });
      const vercel = JSON.parse(file(p, "vercel.json")) as { crons: Array<{ path: string }> };
      expect(vercel.crons.map((c) => c.path)).toContain("/api/cron/scheduling");
      const cron = code(file(p, ...CRON_ROUTE));
      expect(cron).toContain("expirePendingRequests(");
      expect(cron).toContain("onEvent: onSchedulingEvent");
      expect(cron).toContain("env.CRON_SECRET");
      expect(file(p, "src", "env.ts")).toContain("CRON_SECRET: z.string().min(1).optional()");
    }
  });
});

describe("what the project installs and declares", () => {
  it("installs the widget with the server package, at the 0.6 / 0.3 lines (Tenancy 2b-1)", async () => {
    const pkgs = packagesFor(answers());
    expect(pkgs).toContain("@adminigloo/scheduling");
    expect(pkgs).toContain("@adminigloo/scheduling-widget");
    const manifest = JSON.parse(file(await plan(), "package.json")) as { dependencies: Record<string, string> };
    // The release lines: scheduling 0.7 (forgetTenant, past records' dates), scheduling-widget 0.5 (polish 3: <ScheduleCalendarActions>).
    expect(manifest.dependencies["@adminigloo/scheduling"]).toMatch(/^\^0\.7\.\d+$/);
    expect(manifest.dependencies["@adminigloo/scheduling-widget"]).toMatch(/^\^0\.5\.\d+$/);
  });

  it("declares the maps key and the starting zone as optional, and validates the zone at boot", async () => {
    const p = await plan();
    const env = file(p, "src", "env.ts");
    expect(env).toContain("GOOGLE_MAPS_API_KEY: z.string().min(1).optional()");
    expect(env).toContain("GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY");
    expect(env).toContain("SCHEDULING_TIME_ZONE: process.env.SCHEDULING_TIME_ZONE");
    expect(env).toContain('new Intl.DateTimeFormat("en-US", { timeZone: zone })');
    const example = file(p, ".env.example");
    expect(example).toContain("GOOGLE_MAPS_API_KEY=");
    expect(example).toContain("CRON_SECRET=");
  });

  it("claims the reminders only where comms can send them", () => {
    expect(capabilitiesFor(answers({ includeComms: true }))).toContain("scheduling.reminders");
    expect(capabilitiesFor(answers({ includeComms: false }))).not.toContain("scheduling.reminders");
    expect(capabilitiesFor(answers({ adminShell: "minimal" }))).toEqual(
      expect.arrayContaining(["scheduling.booking", "scheduling.calendar", "scheduling.route"]),
    );
  });
});

describe("the scheduling.booking evidence", () => {
  it("accepts the generated public route — and refuses one that reaches the staff side", async () => {
    const evidence = CAPABILITY_EVIDENCE.find((row) => row.capability === "scheduling.booking");
    if (!evidence) throw new Error("no scheduling.booking evidence");
    const p = await plan();
    expect(evidence.provenBy(p)).toBe(true);

    const withRoute = (route: string): EmitPlan => {
      const files = new Map(p.files);
      files.set(join(...PUBLIC_ROUTE), route);
      return { ...p, files };
    };
    const real = file(p, ...PUBLIC_ROUTE);
    expect(evidence.provenBy(withRoute(`${real}\nfindAvailableSlots(db, input, maps);`))).toBe(false);
    expect(evidence.provenBy(withRoute(`${real}\ncreateSchedulingAdminHandlers({ db });`))).toBe(false);
    expect(evidence.provenBy(withRoute(real.replace("createSchedulingHandlers(", "createHandlers(")))).toBe(false);
  });
});
