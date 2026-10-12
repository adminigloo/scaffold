/**
 * A generated --estimator project is the estimator's business scenario, wired —
 * and the wiring is only package exports.
 *
 * Estimator 0.3 moved the whole feature onto two HTTP handlers and the widget's
 * components, so what this generator owns is glue: which handler each route
 * mounts, what the routes are given, who hears about each estimate, where a
 * photo is kept and what reads it, what an accepted quote turns into, what the
 * comms cron asks at send time, and which pages exist. Every one of those is a
 * place the scenario breaks with a green build — a public route mounting the
 * staff handler (the price book's costs on the open internet), a notify module
 * nobody calls, a cron that sends follow-ups without a link, a catalog seeded
 * from a public page.
 *
 * The routes reach `@/db` and the rendered modules, so they can't run here;
 * this reads the PLAN as text, the way the capability evidence does. They run
 * for real in a generated project (scripts/verify-generated.mjs) and against
 * the real handlers in e2e/tests/estimator-scenario.spec.ts.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANSWERS,
  IncompatibleAnswersError,
  assertAnswersCompatible,
  capabilitiesFor,
  optionalEnvFor,
  packagesFor,
  type Answers,
} from "../answers.js";
import { collectAnswers, nextSteps } from "../cli.js";
import { COMMS_CRON_DAILY_AT_UTC, planEmit, versionRangeFor, type EmitPlan } from "../emit.js";
import { defaultsOnlyPrompter, type Prompter } from "../prompt.js";

const TEMPLATE_DIR = join(__dirname, "..", "..", "template");

/** The founder's full field-service project: everything the estimator can be glued to. */
const FULL: Partial<Answers> = {
  includeComms: true,
  includeEmail: true,
  includeStorage: true,
  includeAi: true,
  includeScheduling: true,
  includeInvoicing: true,
};

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "summit-ramps", adminShell: "minimal", includeEstimator: true, ...overrides };
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

const PUBLIC_ROUTE = ["app", "api", "estimator", "[...path]", "route.ts"];
const EMBED_ROUTE = ["app", "api", "estimator", "embed", "[...path]", "route.ts"];
const ADMIN_ROUTE = ["app", "api", "admin", "estimator", "[...path]", "route.ts"];
const CRON_ROUTE = ["app", "api", "cron", "estimator", "route.ts"];
const SERVICES = ["src", "server", "estimator-services.ts"];
const NOTIFY = ["src", "server", "estimator-notify.ts"];
const FEATURES = ["src", "server", "estimator-features.ts"];

describe("the estimator routes", () => {
  it("mount the package's public handler for customers and the embed, and nothing staff-only", async () => {
    const source = code(file(await plan(FULL), ...PUBLIC_ROUTE));
    expect(source).toContain("createEstimatorHandlers(");
    // The staff handler on the public route would hand the price book's costs
    // and every customer's estimate to anybody.
    expect(source).not.toContain("createEstimatorAdminHandlers(");
    for (const option of [
      "resolveTenant: resolveEstimatorTenant",
      "photoStore: estimatorPhotoStore",
      "takeoff: estimatorTakeoff",
      "onEvent: onEstimatorEvent",
      "emailsEnabled: ESTIMATOR_EMAILS_ENABLED",
      "requesterKey: clientIpKey",
      "rateLimit: estimatorRateLimit",
      "onError: reportEstimatorError",
    ]) {
      expect(source, option).toContain(option);
    }
    for (const verb of ["GET", "POST", "OPTIONS"]) expect(source).toContain(`export const ${verb} = estimator.handle;`);
  });

  it("keep the 0.2 embed's address answering with the same handler", async () => {
    const source = code(file(await plan(), ...EMBED_ROUTE));
    expect(source).toContain('export { GET, OPTIONS, POST } from "../../[...path]/route";');
    // Next reads segment config from the file itself: written, not re-exported.
    expect(source).toContain('export const runtime = "nodejs";');
    expect(source).toContain('export const dynamic = "force-dynamic";');
    expect(source).not.toContain("estimator-seed");
  });

  it("put the staff handler behind this project's sign-in and staff permissions", async () => {
    const p = await plan(FULL);
    const route = code(file(p, ...ADMIN_ROUTE));
    expect(route).toContain("createEstimatorAdminHandlers(");
    for (const option of [
      "resolveTenant: () => ESTIMATOR_TENANT",
      "authorize: authorizeEstimatorStaff",
      "photoStore: estimatorPhotoStore",
      "photoReading: Boolean(estimatorTakeoff)",
      "onEvent: onEstimatorEvent",
      "quoteUrl: (token) => estimatorUrls.quote(token)",
      "delivery: () => estimatorDelivery()",
      "links: estimatorLinkSeams",
      "convertToInvoice: convertEstimateToInvoice",
      "embedBaseUrl: estimatorUrls.embedBase",
    ]) {
      expect(route, option).toContain(option);
    }
    // Never cross-origin: no preflight answered for a staff route.
    expect(route).not.toContain("OPTIONS");

    const server = code(file(p, "src", "server", "estimator.ts"));
    const authorize = server.slice(server.indexOf("export async function authorizeEstimatorStaff"));
    expect(authorize).toContain("await currentPrincipal()");
    expect(authorize).toContain("await loadStaffPermissions({ principal })");
    expect(authorize).toContain("can.can(ESTIMATOR_STAFF_KEYS[permission])");
    expect(authorize).toContain("status: 401");
    // The first-boot setup only once the caller is known to be staff, and
    // before the key check (it is what grants the seeded roles their keys).
    expect(authorize.indexOf("await ensureEstimatorSetup()")).toBeGreaterThan(authorize.indexOf("if (!can) return false"));
    expect(authorize.indexOf("await ensureEstimatorSetup()")).toBeLessThan(authorize.indexOf("can.can("));
  });

  it("run the first-boot setup for customers, write the zone UNSAVED, and never seed a catalog", async () => {
    const server = code(file(await plan(), "src", "server", "estimator.ts"));
    const seam = server.slice(server.indexOf("export async function resolveEstimatorTenant"));
    expect(seam.slice(0, seam.indexOf("return ESTIMATOR_TENANT"))).toContain("await ensureEstimatorSetup()");
    expect(server).toContain("pg_advisory_xact_lock");
    // The zone as a row nobody has saved: the admin keeps asking for the
    // business's name, tax rate and rules (updateEstimatorSettings would stamp
    // saved_at and silence that), and no folder name becomes the business's.
    expect(server).toContain(".insert(estimatorSettings)");
    expect(server).toContain(".onConflictDoNothing({ target: estimatorSettings.tenantId })");
    expect(server).not.toContain("updateEstimatorSettings(");
    expect(server).not.toContain("businessName");
    // ES-V1: nothing on a public page fills the price book.
    for (const seeding of ["loadSampleCatalog(", "createProduct(", "createComponent(", "ensureDemoCatalog"]) {
      expect(server).not.toContain(seeding);
    }
  });

  it("count photo reading on the limiter that fails closed, and the rest on the one that fails open", async () => {
    const server = code(file(await plan(), "src", "server", "estimator.ts"));
    const limit = server.slice(server.indexOf("export async function estimatorRateLimit"));
    expect(limit).toContain("ESTIMATOR_FAIL_CLOSED_BUCKETS.has(bucket) ? failClosedLimiter : limiter");
    expect(limit).toContain("ESTIMATOR_RATE_LIMITS[bucket]");
  });

  it("expire quotes and clear unsent photos on a daily cron that refuses strangers", async () => {
    const p = await plan(FULL);
    const cron = code(file(p, ...CRON_ROUTE));
    expect(cron).toContain("if (!secret || provided !== secret)");
    // Each job to a time budget inside maxDuration (review ADV-5, ADV-7).
    expect(cron).toContain("expireQuotes(db, tenantId, { onEvent: onEstimatorEvent, timeBudgetMs: 20_000 })");
    expect(cron).toContain("purgeOrphanPhotos(db, estimatorPhotoStore, { timeBudgetMs: 20_000 })");
    const vercel = JSON.parse(file(p, "vercel.json")) as { crons: Array<{ path: string; schedule: string }> };
    expect(vercel.crons.map((c) => c.path)).toContain("/api/cron/estimator");
    // Without comms too: an expired quote must stop reading as open whether or
    // not anybody is emailed about it.
    const bare = JSON.parse(file(await plan({ includeComms: false }), "vercel.json")) as { crons: Array<{ path: string }> };
    expect(bare.crons.map((c) => c.path)).toEqual(["/api/cron/estimator"]);
  });
});

describe("what 0.3 replaced", () => {
  it("leaves no tRPC estimator router, seed, takeoff stub or hand-built tool behind", async () => {
    const p = await plan(FULL);
    const router = file(p, "src", "server", "routers", "_app.ts");
    expect(router).not.toContain("estimatorRouter");
    for (const gone of [
      ["src", "server", "routers", "estimator.ts"],
      ["src", "server", "estimator-seed.ts"],
      ["src", "server", "estimator-takeoff.ts"],
      ["src", "components", "estimate", "EstimateTool.tsx"],
      ["app", "api", "estimator", "takeoff", "route.ts"],
    ]) {
      expect(p.files.has(join(...gone)), gone.join("/")).toBe(false);
    }
    for (const [path, source] of p.files) {
      expect(source.includes("estimator-seed") || source.includes("runEstimatorTakeoff"), path).toBe(false);
    }
  });
});

describe("the pages", () => {
  it("are the widget's components, on the routes above", async () => {
    const p = await plan(FULL);
    const estimate = file(p, "app", "(site)", "estimate", "page.tsx");
    expect(estimate).toContain('<EstimateTool baseUrl="/api/estimator" bookHref={ESTIMATE_BOOK_VISIT_HREF} />');
    expect(estimate).toContain('from "@adminigloo/estimator-widget"');

    const quote = file(p, "app", "(site)", "quote", "[token]", "page.tsx");
    expect(quote).toContain('<QuoteView baseUrl="/api/estimator" token={token} bookHref={ESTIMATE_BOOK_VISIT_HREF} />');
    expect(code(quote)).toContain("robots: { index: false, follow: false }");
    expect(code(quote)).toContain('referrer: "no-referrer"');

    expect(file(p, "app", "admin", "estimates", "page.tsx")).toContain("<EstimatesQueue");
    expect(file(p, "app", "admin", "estimates", "page.tsx")).toContain("estimateHref={(id) => `/admin/estimates/${encodeURIComponent(id)}`}");
    expect(file(p, "app", "admin", "estimates", "[id]", "page.tsx")).toContain("<EstimateEditor");
    expect(file(p, "app", "admin", "estimator", "page.tsx")).toContain('<PriceBook baseUrl="/api/admin/estimator" />');
    const settings = file(p, "app", "admin", "estimator", "settings", "page.tsx");
    expect(settings).toContain('<EstimatorSettings baseUrl="/api/admin/estimator" />');
    expect(settings).toContain('<EmbedKeys baseUrl="/api/admin/estimator" />');
    // A function prop can't cross from the server to the browser: the two
    // pages that pass one are client pages.
    for (const page of [["app", "admin", "estimates", "page.tsx"], ["app", "admin", "estimates", "[id]", "page.tsx"]]) {
      expect(file(p, ...page).startsWith('"use client";'), page.join("/")).toBe(true);
    }
  });

  it("offer the booking page only where there is one", async () => {
    expect(code(file(await plan(FULL), ...FEATURES))).toContain('ESTIMATE_BOOK_VISIT_HREF: string | undefined = "/book-visit"');
    expect(code(file(await plan({ ...FULL, includeScheduling: false }), ...FEATURES))).toContain(
      "ESTIMATE_BOOK_VISIT_HREF: string | undefined = undefined",
    );
  });

  it("let an estimate's visit link open the calendar on that day", async () => {
    const page = code(file(await plan(FULL), "app", "admin", "schedule", "page.tsx"));
    expect(page).toContain("initialDate={initialDate}");
    expect(page).toContain("/^\\d{4}-\\d{2}-\\d{2}$/");
  });
});

describe("the glue, by what else is installed", () => {
  it("emails through comms: the listener on every route, its follow-ups re-checked by the comms cron", async () => {
    const p = await plan(FULL);
    const notify = code(file(p, ...NOTIFY));
    expect(notify).toContain("createEstimatorCommsListener(");
    expect(notify).toContain("quoteUrl: (token) => estimatorUrls.quote(token)");
    expect(notify).toContain("adminEstimateUrl: (estimateId) => estimatorUrls.adminEstimate(estimateId)");
    expect(notify).toContain("bookUrl: (estimate) => estimatorUrls.bookVisit(estimate.id)");
    expect(notify).toContain("senders: commsSenders");
    expect(notify).toContain("const LISTENERS: readonly EstimatorEventListener[] = [estimatorComms.onEvent]");
    expect(notify).toContain("export const ESTIMATOR_EMAILS_ENABLED: boolean = commsEmailConfigured");
    // The follow-up is queued for the comms cron's real hour, from the same
    // constant vercel.json is written from.
    const { hour, minute } = COMMS_CRON_DAILY_AT_UTC;
    expect(notify).toContain(`dailyAtUtc: "${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}"`);
    const hooks = code(file(p, "src", "server", "comms-hooks.ts"));
    expect(hooks).toContain('import { estimatorComms } from "@/server/estimator-notify";');
    expect(hooks).toContain("const PRODUCERS: readonly QueueProducer[] = [schedulingComms, estimatorComms];");
  });

  it("names no booking page in an accepted-quote email when there is none", async () => {
    const notify = code(file(await plan({ ...FULL, includeScheduling: false }), ...NOTIFY));
    expect(notify).not.toContain("bookUrl");
    expect(notify).not.toContain("book-visit");
  });

  it("sends nothing, and promises nothing, without comms", async () => {
    const p = await plan({ ...FULL, includeComms: false });
    const notify = code(file(p, ...NOTIFY));
    expect(notify).toContain("const LISTENERS: readonly EstimatorEventListener[] = [];");
    expect(notify).toContain("export const ESTIMATOR_EMAILS_ENABLED: boolean = false;");
    expect(notify).not.toContain("@adminigloo/estimator/comms");
    expect(p.files.has(join("src", "server", "comms-hooks.ts"))).toBe(false);
  });

  it("keeps the customer's photo through storage, and keeps nothing without it", async () => {
    const services = code(file(await plan(FULL), ...SERVICES));
    expect(services).toContain("storeFile(db, blobStore");
    expect(services).toContain('kind: "estimator.photo"');
    expect(services).toContain("deleteFile(db, blobStore, { id: fileId, tenantId })");
    const bare = code(file(await plan({ ...FULL, includeStorage: false }), ...SERVICES));
    expect(bare).toContain("export const estimatorPhotoStore: EstimatorPhotoStore | undefined = undefined;");
    expect(bare).not.toContain("@adminigloo/storage");
  });

  it("reads a photo with Haiku 4.5 through the app's metered client, and reads nothing without --ai", async () => {
    const p = await plan(FULL);
    const services = code(file(p, ...SERVICES));
    expect(services).toContain("createAnthropicTakeoffRunner(");
    expect(services).toContain("takeoffModelFor(env.ESTIMATOR_TAKEOFF_MODEL)");
    // The rates come from the ONE table the app's ai_usage writer prices from;
    // a model with no price there is not read at all, rather than read unmetered.
    expect(services).toContain("const rate = MODEL_RATES[model];");
    expect(services).toContain("if (!rate)");
    expect(services).toContain("recordAiUsage({");
    expect(services).toContain("userId: null");
    expect(services).toContain("reported: !usage.costEstimated");
    const ai = file(p, "src", "server", "ai.ts");
    expect(ai).toContain('"claude-haiku-4-5": {');
    expect(ai).toContain("readonly userId: string | null;");

    const bare = code(file(await plan({ ...FULL, includeAi: false }), ...SERVICES));
    expect(bare).toContain('export const estimatorTakeoff: CreateEstimatorHandlersOptions["takeoff"] = undefined;');
    expect(bare).not.toContain("@/server/ai");
    expect(bare).not.toContain("@adminigloo/estimator/anthropic");
  });

  it("books the visit with scheduling, and lists the visits booked from an estimate", async () => {
    const services = code(file(await plan(FULL), ...SERVICES));
    expect(services).toContain("bookVisitUrl: (estimate) => estimatorUrls.bookVisit(estimate.id)");
    expect(services).toContain("eq(schedulingBookings.estimateId, estimateId)");
    expect(services).toContain("eq(schedulingBookings.tenantId, SCHEDULING_TENANT)");
    expect(services).toContain("linkedVisit(row, timeZone, estimatorUrls.scheduleAdmin)");
  });

  it("turns an accepted quote into an invoice in one transaction: invoice first, then the claim", async () => {
    const services = code(file(await plan(FULL), ...SERVICES));
    const convert = services.slice(services.indexOf("export const convertEstimateToInvoice"));
    expect(convert).toContain("await getEstimate(db, tenantId, estimateId)");
    expect(convert).toContain("db.transaction(async (tx) =>");
    expect(convert).toContain("invoiceInputFromEstimate(found.estimate, found.items)");
    // Created, THEN claimed, both on `tx`: a failed claim rolls the invoice back.
    expect(convert.indexOf("createInvoice(")).toBeLessThan(convert.indexOf("markEstimateConverted(tx, tenantId, estimateId)"));
    expect(convert).toContain('throw new EstimatorInputError("transition_not_allowed"');
    // Invoicing's own refusals (already invoiced) are the same refusal, never a 500.
    expect(convert).toContain("if (error instanceof InvoicingError)");
    // The handler announces estimate.converted after the commit; the seam must not.
    expect(convert).not.toContain("onEvent");
    expect(services).toContain("invoice: (estimateId) => invoiceForEstimate(estimateId)");
  });

  it("links to nothing it doesn't have", async () => {
    const services = code(file(await plan({ ...FULL, includeScheduling: false, includeInvoicing: false }), ...SERVICES));
    expect(services).toContain('export const estimatorLinkSeams: CreateEstimatorAdminHandlersOptions["links"] = undefined;');
    expect(services).toContain('export const convertEstimateToInvoice: CreateEstimatorAdminHandlersOptions["convertToInvoice"] = undefined;');
    expect(services).not.toContain("@adminigloo/scheduling");
    expect(services).not.toContain("@adminigloo/invoicing");
  });

  it("files invoices under the same business the invoicing router uses", async () => {
    const p = await plan(FULL);
    expect(file(p, "src", "server", "routers", "invoicing.ts")).toContain('const INVOICING_TENANT = "primary";');
    expect(file(p, "src", "server", "estimator-config.ts")).toContain('export const ESTIMATOR_TENANT = "primary";');
    expect(code(file(p, ...SERVICES))).toContain("const INVOICING_TENANT = ESTIMATOR_TENANT;");
  });
});

describe("answers, packages and the CLI", () => {
  it("refuses --estimator --admin none, in plain words, before anything is planned", async () => {
    expect(() => assertAnswersCompatible(answers({ adminShell: "none" }))).toThrow(IncompatibleAnswersError);
    expect(() => assertAnswersCompatible(answers({ adminShell: "none" }))).toThrow(/estimator needs an admin panel/);
    await expect(plan({ adminShell: "none" })).rejects.toThrow(IncompatibleAnswersError);
    await expect(
      collectAnswers({ name: "acme", yes: true, help: false, estimator: true, adminShell: "none" }, defaultsOnlyPrompter()),
    ).rejects.toThrow(IncompatibleAnswersError);
  });

  it("installs the server package and the widget, at the 0.3 / 0.2 lines", () => {
    const installed = packagesFor(answers());
    expect(installed).toContain("@adminigloo/estimator");
    expect(installed).toContain("@adminigloo/estimator-widget");
    expect(versionRangeFor("@adminigloo/estimator")).toBe("^0.3.0");
    expect(versionRangeFor("@adminigloo/estimator-widget")).toBe("^0.2.0");
  });

  it("brings comms, storage and email with the estimator unless each is declined", async () => {
    const brought = await collectAnswers({ name: "acme", yes: true, help: false, estimator: true }, defaultsOnlyPrompter());
    expect(brought).toMatchObject({ includeEstimator: true, includeComms: true, includeStorage: true, includeEmail: true });
    const declined = await collectAnswers(
      { name: "acme", yes: true, help: false, estimator: true, comms: false, storage: false, email: false },
      defaultsOnlyPrompter(),
    );
    expect(declined).toMatchObject({ includeEstimator: true, includeComms: false, includeStorage: false, includeEmail: false });
    // AI is NOT brought: reading a photo spends money, so it is asked for.
    expect(brought.includeAi).toBe(false);
  });

  it("asks again about storage, in words about the estimator, when it was left to a default", async () => {
    const asked: string[] = [];
    const prompter: Prompter = {
      ...defaultsOnlyPrompter(),
      async confirm(question, fallback) {
        asked.push(question);
        return fallback;
      },
    };
    await collectAnswers({ name: "acme", yes: false, help: false, estimator: true, adminShell: "minimal" }, prompter);
    expect(asked).toContain("The estimator keeps each customer's photo with their estimate. Include file storage?");
    expect(asked).toContain("The estimator emails new leads to you and quotes to your customers. Include transactional email?");
  });

  it("tells the owner what to do first, and what is off", () => {
    const steps = nextSteps(answers(FULL), "/out/summit-ramps");
    expect(steps).toContain("Build your price book at /admin/estimator");
    expect(steps).toContain("/admin/estimator/settings");
    expect(steps).toContain("Customers get a price at /estimate.");
    expect(steps).toContain("An accepted quote books the visit at /book-visit in one click.");
    expect(steps).toContain("An accepted quote becomes an invoice in one click.");
    expect(steps).toContain("Claude Haiku 4.5");
    for (const line of steps.split("\n")) expect(line.length, line).toBeLessThanOrEqual(80);

    const bare = nextSteps(answers({ includeComms: false, includeEmail: false }), "/out/summit-ramps");
    expect(bare).toContain("Photo reading is off");
    expect(bare).toContain("pnpm dlx @adminigloo/create-app add ai");
    expect(bare).toContain("This project sends no estimate emails");
    expect(bare).not.toContain("book-visit");
    expect(bare).not.toContain("invoice");
  });

  it("lists the estimator's optional variables, the model only with --ai", () => {
    expect(optionalEnvFor(answers(FULL))).toEqual(expect.arrayContaining(["ESTIMATOR_TIME_ZONE", "ESTIMATOR_TAKEOFF_MODEL", "CRON_SECRET"]));
    const bare = optionalEnvFor(answers());
    expect(bare).toContain("CRON_SECRET");
    expect(bare).not.toContain("ESTIMATOR_TAKEOFF_MODEL");
  });
});

describe("the rest of the project knows the estimator is there", () => {
  it("declares its environment, the model only with --ai", async () => {
    const env = file(await plan(FULL), "src", "env.ts");
    expect(env).toContain("ESTIMATOR_TIME_ZONE: z");
    expect(env).toContain("ESTIMATOR_TAKEOFF_MODEL: z.string().min(1).max(120).optional()");
    expect(env).toContain("CRON_SECRET: z.string().min(1).optional()");
    const bare = file(await plan(), "src", "env.ts");
    expect(bare).not.toContain("ESTIMATOR_TAKEOFF_MODEL");
    expect(bare).toContain("CRON_SECRET: z.string().min(1).optional()");
  });

  it("declares one staff key per job, costs separate", async () => {
    const catalog = file(await plan(), "src", "permissions", "catalog.ts");
    for (const key of ["staff.estimates.view", "staff.estimates.manage", "staff.estimates.costs", "staff.estimates.pricebook", "staff.estimates.settings"]) {
      expect(catalog, key).toContain(`"${key}": {`);
    }
  });

  it("puts /estimate in the public nav, the sitemap and llms.txt, and keeps /quote/ out of every index", async () => {
    const p = await plan();
    expect(file(p, "src", "nav.ts")).toContain('{ href: "/estimate", label: "Get an estimate" }');
    expect(file(p, "app", "sitemap.ts")).toContain('"/estimate"');
    expect(file(p, "app", "llms.txt", "route.ts")).toContain("/estimate");
    expect(file(p, "app", "robots.ts")).toContain('"/quote/"');
    const nav = file(p, "src", "components", "admin", "AdminNav.tsx");
    expect(nav).toContain("/admin/estimates");
    expect(nav).toContain("/admin/estimator/settings");
    expect(nav).toContain("staff.estimates.view");
    expect(nav).toContain("staff.estimates.settings");
  });

  it("claims what each feature set really has", () => {
    const full = capabilitiesFor(answers(FULL));
    for (const key of [
      "estimator.pricing",
      "estimator.embed",
      "estimator.quotes",
      "estimator.builder",
      "estimator.photos",
      "estimator.photo-reading",
      "estimator.followups",
      "estimator.book-visit",
      "estimator.invoicing",
    ]) {
      expect(full, key).toContain(key);
    }
    const bare = capabilitiesFor(answers());
    expect(bare).toEqual(expect.arrayContaining(["estimator.pricing", "estimator.embed", "estimator.quotes", "estimator.builder"]));
    for (const key of ["estimator.photos", "estimator.photo-reading", "estimator.followups", "estimator.book-visit", "estimator.invoicing"]) {
      expect(bare, key).not.toContain(key);
    }
  });
});
