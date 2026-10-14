import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";
import { buildTarget, tenancy2aScenarioTarget } from "../bundle.mjs";

/**
 * The fixture behind e2e/tests/tenancy-2a-scenario.spec.ts (Tenancy 2a, contract
 * section 14): a REAL companies backend with every field-service feature in
 * it — @adminigloo/tenancy 0.5's service, both its HTTP handlers and its route
 * seams; scheduling, the estimator, invoicing and comms (messages) with their
 * private, public and embed handlers and their comms listeners; the
 * permissions package's loaders and deploy seed; @adminigloo/email's real
 * sender over a capturing transport — on a real Postgres (PGlite, from
 * @adminigloo/testing/pglite) holding the auth, tenancy, permissions,
 * observability, scheduling, estimator, invoicing and comms tables. It serves
 * the REAL screens (bundled from the widgets' source by bundle.mjs's
 * `tenancy2aScenarioTarget`, fixtures/tenancy-2a-scenario-host.tsx) at the paths a
 * generated `--tenant-noun Company --estimator --scheduling --invoicing --comms
 * --email` project uses:
 *
 *   /onboarding, /dashboard, /settings/company, /settings/team, /invite/:token
 *   /app → /dashboard;  /app/switch/:slug?next=…           (D2)
 *   /app/schedule, /app/schedule/today, /app/schedule/settings
 *   /app/estimates, /app/estimates/:id, /app/estimates/settings, /app/price-book
 *   /app/invoices, /app/invoices/:id, /app/messages
 *   /t/:slug, /t/:slug/estimate, /t/:slug/quote/:token, /t/:slug/book-visit,
 *   /t/:slug/visit/:token, /t/:slug/invoice/:token           (PublicCompanyGate)
 *   /admin/companies[/:id]                                     (the operator console)
 *   /api/tenancy/*, /api/admin/tenancy/*
 *   /api/app/:id/{schedule|estimator|invoices|messages}/*      (companyAuthorizer)
 *   /api/t/:slug/{schedule|estimator|invoices}/*               (resolvePublicTenant + admitPublic)
 *   /api/estimator/*                                           (the embed: its key only)
 *
 * Every company page carries the header: the switcher and the APP_LINKS the
 * person's role in the ACTIVE company opens (src/components/AuthHeader.tsx's
 * runtime permission filter over the generated list).
 *
 * WIRED THE WAY create-app WIRES IT (contract 11.5, the emitted
 * src/server/company-routes.ts, company-links.ts, company-setup.ts,
 * scheduling.ts, scheduling-notify.ts, estimator.ts, estimator-notify.ts,
 * estimator-services.ts, invoicing.ts, comms.ts, comms-senders.ts,
 * comms-hooks.ts, tenant-settings.ts, setup-checklist.ts,
 * permissions/catalog.ts and roles.ts, and the three cron routes). The
 * generator's own DECISIONS are not copied: the shared overlay modules
 * (overlays/scheduling/src/server/scheduling-config.ts and
 * overlays/estimator/src/server/estimator-config.ts — first settings, delivery
 * banners, the AI ceiling, the visit listing) are compiled from the generator's
 * source and called as they are. What a generated project writes as TEMPLATE
 * TEXT (the company links, the switch route's `next` rule) is rewritten here in
 * a few lines; create-app's tenancy-2a.test.ts transpiles and runs the emitted
 * originals.
 *
 * What a test has to own instead:
 *
 *   - SIGN-IN is a fake identity, no Clerk: `/__test/sign-in?email&name&via`
 *     sets an `e2e-user` cookie (the T1 fixture's, unchanged). Staff bootstrap
 *     is `ava@igloo.test`.
 *   - EMAIL: @adminigloo/email's real `createEmailSender` over a capturing
 *     transport, behind the comms senders the project builds
 *     (`buildCommsSenders(transport)`), so what lands in `outbox` is the From,
 *     Reply-To and text the provider would have been handed — after comms
 *     resolved the company's identity and logged it. `GET /__test/outbox`
 *     returns it. Invitations go to `invitations`.
 *   - THE CLOCK: one scenario clock, every factory's `now`.
 *     `POST /__test/clock?at=ISO` moves it.
 *   - THE CRONS run when the test says: `POST /__test/cron/{scheduling|
 *     estimator|comms}` run what app/api/cron/* run. `?failCompany=<id>` makes
 *     that company's run throw, to prove the others still run (D10).
 *   - No photo store and no photo-reading model (no BLOB token, no AI key):
 *     the estimate page asks the customer to count, as a project with neither
 *     configured does.
 *
 * NEGATIVE CONTROLS live HERE, never in the packages (contract 14):
 *
 *   - `break: "shared-identity"`: the comms senders get no `identity`, so every
 *     company's email goes out under the platform's From name and Reply-To —
 *     the spec's outbox assertion must fail;
 *   - `break: "unscoped-invoice-token"`: the public invoicing handler finds the
 *     company by the TOKEN's invoice instead of the web address in the URL —
 *     the D13 leak — so a Summit invoice opens under Green Acres' address, and
 *     the spec's "isn't available" assertion must fail.
 *
 * Everything server-side is imported from the BUILT packages (dist), so build
 * them first.
 */

const here = dirname(fileURLToPath(import.meta.url));
const e2eRoot = join(here, "..");
const repo = join(e2eRoot, "..");
const packagesDir = join(repo, "packages");
const dist = (name: string, file: string) => pathToFileURL(join(packagesDir, name, "dist", file)).href;

/* eslint-disable @typescript-eslint/no-explicit-any -- the packages are imported by path at runtime */
type Any = any;

export const BOOTSTRAP_ADMIN_EMAIL = "ava@igloo.test";
export const SUPPORT_EMAIL = "help@igloo.test";
/** EMAIL_FROM and EMAIL_REPLY_TO: the PLATFORM's sending identity. A company's email must never show either. */
export const PLATFORM_FROM = "Igloo Back Office <messages@igloo.test>";
export const PLATFORM_FROM_ADDRESS = "messages@igloo.test";
export const PLATFORM_REPLY_TO = "platform@igloo.test";

/** One email as the provider would have been handed it. */
export interface SentMail {
  to: string;
  /** The display name on From ("Green Acres"), or null for a bare address. */
  fromName: string | null;
  fromAddress: string;
  replyTo: string | null;
  subject: string;
  text: string;
  /** The scenario time it was handed to the provider. */
  at: string;
}

export interface SentInvitation {
  to: string;
  url: string;
}

export interface CronReport {
  companies: number;
  ran: { tenantId: string; result: unknown }[];
  failed: { tenantId: string; error: string }[];
  deferred: string[];
}

export interface Tenancy2aScenarioServer {
  origin: string;
  outbox: SentMail[];
  invitations: SentInvitation[];
  /** Anything a handler, listener or setup reported: the scenario must end with none it didn't cause. */
  failures: { where: string; error: unknown }[];
  now: () => Date;
  setClock: (at: Date) => void;
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  /** The company a web address names (current or old), or null. */
  companyId: (slug: string) => Promise<string | null>;
  runCron: (name: "scheduling" | "estimator" | "comms", options?: { failCompany?: string }) => Promise<Any>;
  close: () => Promise<void>;
}

export interface Tenancy2aScenarioOptions {
  break?: "shared-identity" | "unscoped-invoice-token";
  /** Where the scenario clock starts. Default: now. */
  start?: Date;
}

/**
 * src/nav.ts's APP_LINKS for a companies project with every feature and an
 * admin shell (contract 11.11), filtered per request by audience and by the
 * person's permissions in the ACTIVE company.
 */
const APP_LINKS: readonly { href: string; label: string; permission?: string; audience?: "staff" }[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/app/schedule", label: "Schedule", permission: "schedule.view" },
  { href: "/app/schedule/today", label: "Today's route", permission: "schedule.route" },
  { href: "/app/estimates", label: "Estimates", permission: "estimator.view" },
  { href: "/app/invoices", label: "Invoices", permission: "invoices.view" },
  { href: "/app/messages", label: "Messages", permission: "comms.view" },
  { href: "/settings/team", label: "Team", permission: "members.view" },
  { href: "/settings/company", label: "Settings", permission: "tenant.view" },
  { href: "/admin", label: "Admin", audience: "staff" },
];

/** src/tenancy.ts's PUBLIC_COMPANY_PAGES with both public features. */
const PUBLIC_COMPANY_PAGES = [
  { path: "/estimate", label: "Get an instant estimate" },
  { path: "/book-visit", label: "Book a visit" },
];

/**
 * The emitted src/server/company-links.ts, in a few lines: a company's links
 * on this deployment, from its CURRENT web address. A token goes into one
 * encoded path segment and nowhere else.
 */
function companyLinksFor(slug: string, base: string) {
  const at = (path: string) => new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
  const home = `t/${encodeURIComponent(slug)}`;
  return {
    home: at(home),
    estimate: at(`${home}/estimate`),
    bookVisit: (estimateId?: string) => at(`${home}/book-visit${estimateId ? `?estimate=${encodeURIComponent(estimateId)}` : ""}`),
    manageVisit: (token: string) => at(`${home}/visit/${encodeURIComponent(token)}`),
    quote: (token: string) => at(`${home}/quote/${encodeURIComponent(token)}`),
    invoice: (token: string) => at(`${home}/invoice/${encodeURIComponent(token)}`),
    app: (path: string) => {
      const url = new URL(`app/switch/${encodeURIComponent(slug)}`, base.endsWith("/") ? base : `${base}/`);
      url.searchParams.set("next", path);
      return url.toString();
    },
  };
}

/** The emitted safeSwitchNext (D2): /app/… or /dashboard, never anywhere else. */
function safeSwitchNext(value: string | null): string {
  if (typeof value !== "string") return "/dashboard";
  if (value === "/dashboard") return value;
  if (!value.startsWith("/app/") || /[\\\u0000-\u001f]/.test(value)) return "/dashboard";
  const parsed = new URL(value, "http://this.site");
  if (parsed.host !== "this.site" || !parsed.pathname.startsWith("/app/")) return "/dashboard";
  if (parsed.pathname.startsWith("/app/switch/")) return "/dashboard";
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * Compile one of the generator's shared overlay modules (TypeScript with
 * `__SCOPE__/…` imports, as create-app copies it into a project) into a module
 * this process can import: `__SCOPE__/<pkg>` resolves to that package's BUILT
 * dist, kept external, so the module calls the same package instance the
 * handlers use.
 */
async function loadOverlayModule(relative: string, scratch: string): Promise<Any> {
  const scope: Plugin = {
    name: "adminigloo-scope",
    setup(b) {
      b.onResolve({ filter: /^__SCOPE__\// }, (args) => {
        const name = args.path.slice("__SCOPE__/".length).split("/")[0]!;
        return { path: dist(name, "index.js"), external: true };
      });
    },
  };
  const entry = join(packagesDir, "create-app", "overlays", relative);
  const result = await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", write: false, plugins: [scope], logLevel: "silent" });
  const file = join(scratch, relative.replace(/[\\/]/g, "_").replace(/\.ts$/, ".mjs"));
  writeFileSync(file, result.outputFiles[0]!.text);
  return import(pathToFileURL(file).href);
}

/** The page CSS: create-app's header row (flex, wrapping) and thumb-sized links. */
const PAGE_CSS = `
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,sans-serif;color:#111;background:#fff}
a{color:#0b5394}
.e2e-header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 16px;padding:8px 16px;border-bottom:1px solid #ddd}
.e2e-brand{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#444;text-decoration:none;display:inline-flex;align-items:center;min-height:44px}
.e2e-nav{display:flex;flex-wrap:wrap;gap:0 4px;min-width:0}
.e2e-nav a{display:inline-flex;align-items:center;min-height:44px;padding:0 8px;text-decoration:none}
.e2e-right{display:flex;align-items:center;gap:12px;min-width:0;max-width:100%}
.e2e-avatar{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:#333;color:#fff;font-size:12px;flex:none}
main{padding:16px;max-width:960px;margin:0 auto}
main.e2e-wide{max-width:1280px}
.e2e-title{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px}
.e2e-title a,.e2e-subnav a{display:inline-flex;align-items:center;min-height:44px}
.e2e-subnav{display:flex;gap:8px;align-items:center}
h1{font-size:20px}
.e2e-cards{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));margin-top:24px}
.e2e-cards a{display:flex;align-items:center;min-height:44px;padding:8px 16px;border:1px solid #ccc;border-radius:6px;text-decoration:none;color:#111}
.e2e-gap{margin-top:32px}
.e2e-public{max-width:672px}
.e2e-public-body{margin-top:24px}
.e2e-notice{border:1px solid #b45309;border-radius:6px;padding:12px 16px;background:#fffbeb}
.e2e-note{color:#444;font-size:14px}
`;

function page(cfg: Record<string, unknown>, title: string, meta = ""): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title.replace(/</g, "&lt;")}</title>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">${meta}<style>${PAGE_CSS}</style></head>` +
    `<body><div id="root"></div>` +
    `<script>window.__page=${JSON.stringify(cfg).replace(/</g, "\\u003c")}</script><script src="/widgets.js"></script></body></html>`
  );
}

/** Token pages and every /t/ page: out of search (D17); token pages send no referrer. */
const NOINDEX = '<meta name="robots" content="noindex, nofollow">';
const TOKEN_PAGE = `${NOINDEX}<meta name="referrer" content="no-referrer">`;

/** The fake identity provider's sign-in page: what Clerk's card does, in a form. */
function signInPage(next: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in</title>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${PAGE_CSS}</style></head><body><main>` +
    `<h1>Sign in</h1><form method="get" action="/__test/sign-in">` +
    `<input type="hidden" name="next" value="${next.replace(/"/g, "&quot;")}"><input type="hidden" name="via" value="page">` +
    `<p><label>Email <input name="email" type="email" required></label></p>` +
    `<p><label>Name <input name="name" type="text"></label></p>` +
    `<p><button type="submit">Continue</button></p></form></main></body></html>`
  );
}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? "GET";
  return new Request(new URL(req.url ?? "/", origin), {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
  });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

function cookieOf(req: Request, name: string): string | null {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.get("cookie") ?? "");
  return match ? decodeURIComponent(match[1]!) : null;
}

/**
 * The emitted src/server/invoicing.ts's dueDateFor: the END of the day, in the
 * company's zone, its "due after N days" from today there.
 */
function dueDateFor(business: { dueDays: number; timeZone: string | null }, at: Date): Date {
  const zone = business.timeZone ?? "UTC";
  const wall = (instant: Date) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(instant);
    const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
    return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour") % 24, minute: part("minute"), second: part("second") };
  };
  const today = wall(at);
  const due = new Date(Date.UTC(today.year, today.month - 1, today.day + business.dueDays));
  const wanted = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate(), 23, 59, 59, 999);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const seen = wall(new Date(guess));
    const drift = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second, 999) - wanted;
    if (drift === 0) break;
    guess -= drift;
  }
  return new Date(guess);
}

/** `"Green Acres" <messages@igloo.test>` → its name and address. */
function parseFrom(from: string): { name: string | null; address: string } {
  const named = /^\s*"?(.*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (named) return { name: named[1]!.replace(/\\"/g, '"').trim() || null, address: named[2]!.trim() };
  return { name: null, address: from.trim() };
}

export async function startTenancy2aScenarioServer(options: Tenancy2aScenarioOptions = {}): Promise<Tenancy2aScenarioServer> {
  const scratch = mkdtempSync(join(tmpdir(), "aig-e2e-"));
  const [
    tenancyServer,
    tenancyRoot,
    tenancySchema,
    authSchema,
    permissionsRoot,
    permissionsServer,
    permissionsSchema,
    observability,
    observabilitySchema,
    pglite,
    scheduling,
    schedulingComms,
    schedulingSchema,
    estimator,
    estimatorComms,
    estimatorSchema,
    invoicing,
    invoicingComms,
    invoicingSchema,
    comms,
    commsSchema,
    email,
  ]: Any[] = await Promise.all([
    import(dist("tenancy", "server.js")),
    import(dist("tenancy", "index.js")),
    import(dist("tenancy", "schema.js")),
    import(dist("auth", "schema.js")),
    import(dist("permissions", "index.js")),
    import(dist("permissions", "server.js")),
    import(dist("permissions", "schema.js")),
    import(dist("observability", "index.js")),
    import(dist("observability", "schema.js")),
    import(dist("testing", "pglite.js")),
    import(dist("scheduling", "index.js")),
    import(dist("scheduling", "comms.js")),
    import(dist("scheduling", "schema.js")),
    import(dist("estimator", "index.js")),
    import(dist("estimator", "comms.js")),
    import(dist("estimator", "schema.js")),
    import(dist("invoicing", "index.js")),
    import(dist("invoicing", "comms.js")),
    import(dist("invoicing", "schema.js")),
    import(dist("comms", "index.js")),
    import(dist("comms", "schema.js")),
    import(dist("email", "index.js")),
  ]);
  // The drizzle every package was built against (one pnpm store entry), for
  // the few queries the generated glue writes itself.
  const drizzleDir = realpathSync(join(packagesDir, "scheduling", "node_modules", "drizzle-orm"));
  const { and, asc, eq, sql }: Any = await import(pathToFileURL(join(drizzleDir, "index.js")).href);
  // The generator's own decisions, from its source.
  const schedulingConfig = await loadOverlayModule("scheduling/src/server/scheduling-config.ts", scratch);
  const estimatorConfig = await loadOverlayModule("estimator/src/server/estimator-config.ts", scratch);

  // --- the clock ------------------------------------------------------------------
  let offsetMs = options.start ? options.start.getTime() - Date.now() : 0;
  const now = () => new Date(Date.now() + offsetMs);
  const setClock = (at: Date) => {
    offsetMs = at.getTime() - Date.now();
  };

  // --- the database: src/db/schema.ts's `schema`, as PGlite ------------------------
  const schema = {
    ...authSchema.authSchema,
    ...tenancySchema.tenancySchema,
    ...permissionsSchema.permissionsSchema,
    auditLog: observabilitySchema.auditLog,
    ...schedulingSchema,
    ...estimatorSchema,
    ...invoicingSchema,
    ...commsSchema,
  };
  const testDb = await pglite.createPgliteDb({ schema, logQueries: false });
  const db = testDb.db;
  const client = testDb.client;
  const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await client.query(sql, params)).rows as T[];

  // LISTEN FIRST, so every link and embed address below is built on the real
  // origin (the app's NEXT_PUBLIC_APP_URL). Nothing is served until the
  // handlers exist: requests before then are answered 503.
  let handleRequest: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.writeHead(503);
    res.end();
  };
  const server: Server = createServer((req, res) => handleRequest(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const failures: Tenancy2aScenarioServer["failures"] = [];
  const report = (where: string) => (error: unknown) => void failures.push({ where, error });

  // --- src/permissions/roles.ts and catalog.ts --------------------------------------
  // Tenancy's four roles plus CREW, which scheduling adds (D9).
  const TENANT_ROLES = tenancyRoot.defineTenantRoles([scheduling.SCHEDULING_CREW_ROLE]);
  const tenantCatalog = permissionsRoot.definePermissions(
    "tenant",
    {
      ...tenancyRoot.tenancyPermissions,
      ...scheduling.schedulingPermissions,
      ...estimator.estimatorPermissions,
      ...invoicing.invoicingPermissions,
      ...comms.commsPermissions,
    },
    {
      contributedBy: [
        tenancyRoot.tenancyPermissions,
        scheduling.schedulingPermissions,
        estimator.estimatorPermissions,
        invoicing.invoicingPermissions,
        comms.commsPermissions,
      ],
    },
  );
  // The staff catalog: tenancy's operator keys with the generated defaults.
  // A companies project has no feature STAFF keys (D12): the platform runs no
  // schedule of its own.
  const staffCatalog = permissionsRoot.definePermissions(
    "staff",
    Object.fromEntries(
      tenancyRoot.TENANCY_STAFF_PERMISSION_KEYS.map((key: string) => [
        key,
        {
          label: key,
          defaultFor:
            key === "staff.tenants.view"
              ? ["admin", "cs_lead", "cs_agent"]
              : key === "staff.people.view" || key === "staff.roles.view"
                ? ["admin", "cs_lead"]
                : ["admin"],
          ...(key === "staff.roles.manage" ? { sealed: true } : {}),
        },
      ]),
    ),
  );
  // The deploy seed (src/permissions/seed.ts): TENANT_ROLES' templates, crew included.
  await permissionsServer.seedPermissionCatalog(db, {
    staff: { catalog: staffCatalog, templates: permissionsRoot.STAFF_ROLE_TEMPLATES },
    tenant: { catalog: tenantCatalog, templates: TENANT_ROLES.templates },
  });

  // --- src/server/tenant-settings.ts and setup-checklist.ts ----------------------------
  const tenantSettings = tenancyRoot.defineTenantSettings([
    tenancyRoot.companySettings,
    tenancyRoot.defineSettingsFragment(invoicing.invoicingSettingsFragment),
  ]);
  const setupChecklist = tenancyRoot.defineSetupChecklist([
    ...tenancyServer.tenancyChecklistItems({ companySettings: "/settings/company", team: "/settings/team" }),
    ...scheduling.schedulingChecklistItems({ booking: "/app/schedule/settings#booking", crews: "/app/schedule/settings#crews" }),
    ...estimator.estimatorChecklistItems({ priceBook: "/app/price-book", settings: "/app/estimates/settings", embed: "/app/estimates/settings#embed" }),
    ...invoicing.invoicingChecklistItems({ details: "/settings/company#invoicing" }),
  ]);

  // --- src/server/tenancy.ts --------------------------------------------------------
  const auditRegistry = observability.defineAuditedActions(tenancyRoot.tenancyAuditedActions);
  const auditSink = async (tx: Any, event: Any) => {
    await tx.insert(observabilitySchema.auditLog).values(
      observability.auditEntry(auditRegistry, {
        action: event.action,
        actor: event.actorUserId ? { userId: event.actorUserId } : null,
        scope: event.scope,
        tenantId: event.tenantId,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        request: event.request,
        metadata: { ...event.metadata },
      }),
    );
  };
  const logos = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const logoStore = {
    put: async ({ pathname, bytes, contentType }: { pathname: string; bytes: Uint8Array; contentType: string }) => {
      logos.set(pathname, { bytes, contentType });
      return { url: `${origin}/__test/logos/${encodeURIComponent(pathname)}`, key: pathname };
    },
    delete: async (key: string) => {
      logos.delete(key);
    },
  };
  // Declared before the service: tenancy's onEvent reaches it after each commit.
  let onCompanyEvent: (event: Any) => Promise<void> = async () => {};
  const tenancy = tenancyServer.createTenancyService({
    db,
    mode: "companies",
    tenantCatalog,
    noun: { singular: "company", plural: "companies" },
    settings: tenantSettings,
    checklist: setupChecklist,
    bootstrap: { mode: "email", email: BOOTSTRAP_ADMIN_EMAIL },
    logos: logoStore,
    reservedSlugs: ["igloo-back-office", "igloo"],
    audit: auditSink,
    roles: TENANT_ROLES,
    onEvent: (event: Any) => onCompanyEvent(event),
    onEventError: report("tenancy:onEvent"),
    now,
  });
  const loaders = permissionsServer.createDrizzlePermissionLoaders(db, { membership: tenancyServer.tenancyMembershipGate });

  // --- the fake identity provider (the T1 fixture's) ------------------------------
  const names = new Map<string, string>();
  async function webhookCreates(emailAddress: string, name: string): Promise<void> {
    const [row] = await db
      .insert(authSchema.users)
      .values({ externalId: `ext_${emailAddress}`, email: emailAddress, displayName: name || null })
      .onConflictDoNothing()
      .returning();
    if (row) await tenancy.provisionUser({ userId: row.id, email: emailAddress });
  }
  async function principalFor(emailAddress: string | null): Promise<{ userId: string; email: string } | null> {
    if (!emailAddress) return null;
    let rows = await query<{ id: string; provisioned_at: unknown; deleted_at: unknown }>(
      "select id, provisioned_at, deleted_at from users where external_id = $1",
      [`ext_${emailAddress}`],
    );
    if (rows.length === 0) {
      await db
        .insert(authSchema.users)
        .values({ externalId: `ext_${emailAddress}`, email: emailAddress, displayName: names.get(emailAddress) ?? null })
        .onConflictDoNothing();
      rows = await query("select id, provisioned_at, deleted_at from users where external_id = $1", [`ext_${emailAddress}`]);
    }
    const row = rows[0];
    if (!row || row.deleted_at) return null;
    if (row.provisioned_at === null) await tenancy.provisionUser({ userId: row.id, email: emailAddress });
    return { userId: row.id, email: emailAddress };
  }
  /** src/server/tenancy-handlers.ts's requestPrincipal: who is signed in on this request. */
  const principal = async (req: Request) => principalFor(cookieOf(req, "e2e-user"));

  // --- src/server/tenancy-handlers.ts -------------------------------------------------
  const invitations: SentInvitation[] = [];
  const tenancyHandlers = tenancyServer.createTenancyHandlers({
    tenancy,
    principal,
    verifiedEmails: async (req: Request) => {
      const who = cookieOf(req, "e2e-user");
      return who ? [who] : [];
    },
    invitationUrl: (token: string) => `${origin}/invite/${encodeURIComponent(token)}`,
    deliverInvitation: async (input: { to: string; url: string }) => {
      invitations.push({ to: input.to, url: input.url });
      return { status: "sent" };
    },
    onError: report("tenancy:route"),
  });
  const operatorHandlers = tenancyServer.createTenancyOperatorHandlers({
    tenancy,
    principal,
    recentAudit: async ({ tenantId, limit }: { tenantId: string; limit: number }) => {
      const rows = await query<{ created_at: string; action: string; is_sensitive: boolean; metadata: unknown; actor: string | null }>(
        `select a.created_at, a.action, a.is_sensitive, a.metadata, coalesce(u.display_name, u.email) as actor
           from audit_log a left join users u on u.id = a.actor_user_id
          where a.tenant_id = $1 order by a.created_at desc limit $2`,
        [tenantId, limit],
      );
      return rows.map((row) => ({
        at: new Date(row.created_at).toISOString(),
        action: row.action,
        label: auditRegistry.has(row.action) ? auditRegistry.get(row.action).label : row.action,
        actor: row.actor ?? null,
        sensitive: row.is_sensitive,
        detail: tenancyRoot.describeTenancyAuditEntry(row.action, row.metadata),
      }));
    },
    onError: report("operator:route"),
  });

  // --- src/server/company-routes.ts ---------------------------------------------------
  const companyRoutes = tenancyServer.createCompanyRouteSeams({ tenancy, principal });
  const publicCompanies = tenancyServer.createPublicCompanySeams({ tenancy });
  /** The private handlers' authorize: the seam, then — only once it passed — the company's first-time setup (D11). */
  const companyAuthorizer = async (req: Request, permission: string, tenantId: string) => {
    const verdict = await companyRoutes.authorize(req, permission, tenantId);
    if (verdict === false || verdict instanceof Response) return verdict;
    await ensureCompanySetup(tenantId);
    return verdict;
  };
  /** The public handlers' resolveTenant: the web address in the path, then setup for a real company. */
  const resolvePublicTenant = async (req: Request): Promise<string | null> => {
    const tenantId = await publicCompanies.resolveTenant(req);
    if (tenantId === null) return null;
    await ensureCompanySetup(tenantId);
    return tenantId;
  };
  /** The public handlers' admit (web-address AND embed-key paths): setup for a real company, then "is it taking requests?". */
  const admitPublic = async (tenantId: string, req: Request) => {
    await ensureCompanySetup(tenantId);
    return publicCompanies.admit(tenantId, req);
  };
  const companyLinks = async (tenantId: string) => {
    const profile = await tenancy.companyProfile(tenantId);
    if (!profile) throw new Error(`There is no company ${tenantId} to build links for (unknown or deleted).`);
    return companyLinksFor(profile.slug, origin);
  };

  // --- src/server/comms-senders.ts ----------------------------------------------------
  const outbox: SentMail[] = [];
  const transport = async (message: { from: string; to: string; replyTo: string | null; subject: string; text: string | null }) => {
    const from = parseFrom(message.from);
    outbox.push({
      to: message.to,
      fromName: from.name,
      fromAddress: from.address,
      replyTo: message.replyTo,
      subject: message.subject,
      text: message.text ?? "",
      at: now().toISOString(),
    });
    return { id: `e2e_${outbox.length}` };
  };
  const mailer = email.createEmailSender({ from: PLATFORM_FROM, replyTo: PLATFORM_REPLY_TO, send: transport });
  /** WHO A COMPANY'S MESSAGES COME FROM (D8): its name, its reply-to. */
  const companyIdentity = async (tenantId: string) => {
    const profile = await tenancy.companyProfile(tenantId);
    return profile ? { name: profile.name, replyTo: profile.replyTo } : null;
  };
  const commsSenders = {
    // NEGATIVE CONTROL `shared-identity`: no identity seam, so comms hands the
    // sender no name and no reply-to and every company's email goes out as
    // the platform.
    ...(options.break === "shared-identity" ? {} : { identity: companyIdentity }),
    email: (message: Any) =>
      mailer.send({
        to: message.to,
        subject: message.subject,
        text: message.body,
        html: message.html,
        template: "comms",
        tenantId: message.tenantId,
        fromName: message.fromName,
        replyTo: message.replyTo,
      }),
  };

  // --- src/server/scheduling-notify.ts ------------------------------------------------
  const REMINDER_RUNS = { dailyAtUtc: "14:00" } as const;
  const schedulingListener = schedulingComms.createSchedulingCommsListener({
    db,
    senders: commsSenders,
    company: (tenantId: string) => tenancy.companyProfile(tenantId),
    manageUrl: async (token: string, tenantId: string) => (await companyLinks(tenantId)).manageVisit(token),
    bookUrl: async (tenantId: string) => (await companyLinks(tenantId)).bookVisit(),
    adminUrl: async (tenantId: string) => (await companyLinks(tenantId)).app("/app/schedule"),
    // D8: the company's own inbox — never BOOTSTRAP_ADMIN_EMAIL.
    staffEmails: async (tenantId: string) => (await tenancy.companyProfile(tenantId))?.inbox ?? [],
    reminderRuns: REMINDER_RUNS,
    now,
    onError: (error: unknown, context: { step: string }) => void failures.push({ where: `scheduling-comms:${context.step}`, error }),
  });
  const onSchedulingEvent = async (event: Any) => {
    try {
      await schedulingListener.onEvent(event);
    } catch (error) {
      failures.push({ where: "scheduling:listener", error });
    }
  };
  const schedulingDelivery = async (tenantId: string) =>
    schedulingConfig.schedulingDeliveryStatus({
      commsInstalled: true,
      emailConfigured: mailer.configured,
      cronSecretSet: true,
      reminderRuns: REMINDER_RUNS,
      failedLastWeek: 0,
      overdueReminders: 0,
      overdueSince: null,
      timeZone: (await scheduling.getSchedulingSettings(db, tenantId)).timeZone,
      audience: "company",
    });

  // --- src/server/scheduling.ts -------------------------------------------------------
  const schedulingCompany = (tenantId: string) => tenancy.companyProfile(tenantId);
  const maps = scheduling.createHaversineMapsProvider();
  const schedulingAdmin = scheduling.createSchedulingAdminHandlers({
    db,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer,
    company: schedulingCompany,
    companySettingsHref: "/settings/company#details",
    maps,
    onEvent: onSchedulingEvent,
    delivery: (tenantId: string) => schedulingDelivery(tenantId),
    listPeople: async (_req: Request, tenantId: string) =>
      (await tenancy.listMemberPeople(tenantId)).map((person: Any) => ({ userId: person.userId, name: person.name, email: person.email, roleKey: person.roleKey })),
    settingsHref: "/app/schedule/settings",
    onError: report("scheduling:admin"),
    now,
  });
  const schedulingPublic = scheduling.createSchedulingHandlers({
    db,
    resolveTenant: resolvePublicTenant,
    admit: admitPublic,
    company: schedulingCompany,
    manageUrl: async (token: string, tenantId: string) => (await companyLinks(tenantId)).manageVisit(token),
    maps,
    onEvent: onSchedulingEvent,
    emailsEnabled: mailer.configured,
    requesterKey: scheduling.clientIpKey,
    onError: report("scheduling:public"),
    now,
  });
  async function setupSchedulingFor(tenantId: string): Promise<void> {
    const profile = await tenancy.companyProfile(tenantId);
    if (!profile) return;
    await db.transaction(async (tx: Any) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`scheduling-setup:${tenantId}`}))`);
      const settings = await scheduling.getSchedulingSettings(tx, tenantId);
      if (!settings.saved) {
        await scheduling.updateSchedulingSettings(
          tx,
          tenantId,
          schedulingConfig.firstSchedulingSettings({ timeZone: profile.timeZone ?? undefined, businessName: profile.name }),
        );
      }
    });
    await schedulingListener.ensureTemplates(tenantId);
  }
  /** Scheduling's zone, converged on the company's (D5). */
  const syncSchedulingCompany = async (tenantId: string) => {
    await scheduling.resolveSchedulingSettings(db, tenantId, { company: schedulingCompany, onEvent: onSchedulingEvent, onError: report("scheduling:sync") });
  };

  // --- src/server/invoicing.ts --------------------------------------------------------
  const invoicingBusiness = async (tenantId: string) => {
    const profile = await tenancy.companyProfile(tenantId);
    if (!profile) return null;
    return {
      name: profile.name,
      timeZone: profile.timeZone,
      contactEmail: profile.contactEmail,
      contactPhone: profile.contactPhone,
      logoUrl: profile.logoUrl,
      brandColor: profile.brandColor,
      ...invoicing.readInvoicingDetails(profile.settings.invoicing),
    };
  };
  const invoicingListener = invoicingComms.createInvoicingComms({
    db,
    senders: commsSenders,
    invoiceUrl: async (token: string, tenantId: string) => (await companyLinks(tenantId)).invoice(token),
    business: invoicingBusiness,
    onError: (error: unknown, context: { step: string }) => void failures.push({ where: `invoicing-comms:${context.step}`, error }),
  });
  const invoicingAdmin = invoicing.createInvoicingAdminHandlers({
    db,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer,
    business: invoicingBusiness,
    invoiceUrl: async (token: string, tenantId: string) => (await companyLinks(tenantId)).invoice(token),
    sendInvoiceEmail: (input: Any) => invoicingListener.sendInvoice(input),
    delivery: () => ({ emails: true, emailsOffReason: null }),
    detailsHref: "/settings/company#invoicing",
    onError: report("invoicing:admin"),
    now,
  });
  /**
   * NEGATIVE CONTROL `unscoped-invoice-token`: the company is the one the
   * TOKEN's invoice belongs to, whatever web address the URL names — exactly
   * the read D13 forbids — so a Summit invoice opens under Green Acres'.
   */
  const tokenOwner = async (req: Request): Promise<string | null> => {
    const match = /\/v1\/invoice\/([^/]+)/.exec(new URL(req.url).pathname);
    if (match) {
      const [row] = await query<{ tenant_id: string }>("select tenant_id from invoices where view_token = $1", [decodeURIComponent(match[1]!)]);
      if (row) return row.tenant_id;
    }
    return resolvePublicTenant(req);
  };
  const invoicingPublic = invoicing.createInvoicingHandlers({
    db,
    resolveTenant: options.break === "unscoped-invoice-token" ? tokenOwner : resolvePublicTenant,
    admit: admitPublic,
    business: invoicingBusiness,
    onError: report("invoicing:public"),
    now,
  });
  const setupInvoicingFor = (tenantId: string) => invoicingListener.ensureTemplates(tenantId);

  // --- src/server/estimator-notify.ts, estimator-services.ts and estimator.ts ---------
  const estimatorListener = estimatorComms.createEstimatorCommsListener({
    db,
    senders: commsSenders,
    company: (tenantId: string) => tenancy.companyProfile(tenantId),
    quoteUrl: async (token: string, tenantId: string) => (await companyLinks(tenantId)).quote(token),
    adminEstimateUrl: async (estimateId: string, tenantId: string) => (await companyLinks(tenantId)).app(`/app/estimates/${encodeURIComponent(estimateId)}`),
    bookUrl: async (estimate: { id: string }, tenantId: string) => (await companyLinks(tenantId)).bookVisit(estimate.id),
    staffEmails: async (tenantId: string) => (await tenancy.companyProfile(tenantId))?.inbox ?? [],
    followUpRuns: { dailyAtUtc: "14:00" },
    now,
    onError: (error: unknown, context: { step: string }) => void failures.push({ where: `estimator-comms:${context.step}`, error }),
  });
  const onEstimatorEvent = async (event: Any) => {
    try {
      await estimatorListener.onEvent(event);
    } catch (error) {
      failures.push({ where: "estimator:listener", error });
    }
  };
  const estimatorCompany = (tenantId: string) => tenancy.companyProfile(tenantId);
  const visitsForEstimate = async (estimateId: string, tenantId: string) => {
    const b = scheduling.schedulingBookings;
    const rows = await db
      .select({ id: b.id, status: b.status, startsAt: b.startsAt, scheduledDate: b.scheduledDate, startTime: b.startTime })
      .from(b)
      .where(and(eq(b.tenantId, tenantId), eq(b.estimateId, estimateId)))
      .orderBy(asc(b.scheduledDate), asc(b.startTime))
      .limit(20);
    if (rows.length === 0) return [];
    const { timeZone } = await scheduling.getSchedulingSettings(db, tenantId);
    return rows.map((row: Any) => estimatorConfig.linkedVisit(row, timeZone, `${origin}/app/schedule`));
  };
  const invoiceForEstimate = async (estimateId: string, tenantId: string) => {
    const t = invoicingSchema.invoices;
    const [row] = await db
      .select({ id: t.id, number: t.invoiceNumber, status: t.status })
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.estimateId, estimateId)))
      .limit(1);
    return row ? { id: row.id, number: row.number, status: row.status, url: `/app/invoices/${encodeURIComponent(row.id)}` } : null;
  };
  /** "Make an invoice": the SAME company's invoice, due after its own "due after N days" (estimator-services.ts). */
  const convertEstimateToInvoice = async (input: { tenantId: string; estimateId: string; userId: string | null }) => {
    const found = await estimator.getEstimate(db, input.tenantId, input.estimateId);
    if (!found) throw new estimator.EstimatorInputError("transition_not_allowed", "This estimate can't be invoiced.");
    const business = await invoicingBusiness(input.tenantId);
    const dueDate = business ? dueDateFor(business, now()) : null;
    try {
      return await db.transaction(async (tx: Any) => {
        const invoice = await invoicing.createInvoice(
          tx,
          { tenantId: input.tenantId, ...invoicing.invoiceInputFromEstimate(found.estimate, found.items), dueDate },
          input.userId ?? undefined,
        );
        const claimed = await estimator.markEstimateConverted(tx, input.tenantId, input.estimateId);
        if (!claimed) throw new estimator.EstimatorInputError("transition_not_allowed", "Only an accepted quote can become an invoice, and only once.");
        return { id: invoice.id, number: invoice.invoiceNumber, status: "draft", url: `/app/invoices/${encodeURIComponent(invoice.id)}` };
      });
    } catch (error) {
      if (error instanceof invoicing.InvoicingError) throw new estimator.EstimatorInputError("transition_not_allowed", (error as Error).message);
      throw error;
    }
  };
  const estimatorDelivery = () =>
    estimatorConfig.estimatorDeliveryStatus({ commsInstalled: true, emailConfigured: mailer.configured, cronSecretSet: true, audience: "company" });
  const estimatorShared = {
    db,
    company: estimatorCompany,
    aiBudgetCeilingCents: estimatorConfig.ESTIMATOR_AI_CEILING_CENTS,
    onEvent: onEstimatorEvent,
    now,
  };
  const estimatorPublicShared = { ...estimatorShared, aiSiteBudgetCents: estimatorConfig.ESTIMATOR_AI_SITE_CEILING_CENTS };
  const estimatorAdmin = estimator.createEstimatorAdminHandlers({
    ...estimatorShared,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer,
    companySettingsHref: "/settings/company#details",
    photoReading: false,
    photoReadingOff: "no_key",
    siteNotices: "company",
    quoteUrl: async (token: string, tenantId: string) => (await companyLinks(tenantId)).quote(token),
    delivery: () => estimatorDelivery(),
    links: {
      bookVisitUrl: async (estimate: { id: string }, tenantId: string) => (await companyLinks(tenantId)).bookVisit(estimate.id),
      visits: (estimateId: string, tenantId: string) => visitsForEstimate(estimateId, tenantId),
      invoice: (estimateId: string, tenantId: string) => invoiceForEstimate(estimateId, tenantId),
    },
    convertToInvoice: convertEstimateToInvoice,
    // "Turn into an invoice" asks invoices.manage too (review SEC-2A-02).
    invoiceAccess: (req: Request, need: "view" | "manage", tenantId: string) =>
      companyAuthorizer(req, need === "manage" ? "invoices.manage" : "invoices.view", tenantId),
    // The address the embed snippet points another website at.
    embedBaseUrl: `${origin}/api/estimator`,
    onError: report("estimator:admin"),
  });
  const estimatorPublic = estimator.createEstimatorHandlers({
    ...estimatorPublicShared,
    resolveTenant: resolvePublicTenant,
    admit: admitPublic,
    emailsEnabled: mailer.configured,
    requesterKey: estimator.clientIpKey,
    onError: report("estimator:public"),
  });
  const estimatorEmbed = estimator.createEstimatorHandlers({
    ...estimatorPublicShared,
    admit: admitPublic,
    emailsEnabled: mailer.configured,
    requesterKey: estimator.clientIpKey,
    onError: report("estimator:embed"),
  });
  async function setupEstimatorFor(tenantId: string): Promise<void> {
    const profile = await tenancy.companyProfile(tenantId);
    if (!profile) return;
    await db.transaction(async (tx: Any) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`estimator-setup:${tenantId}`}))`);
      await tx
        .insert(estimator.estimatorSettings)
        .values({ tenantId, timeZone: estimatorConfig.firstEstimatorTimeZone([profile.timeZone]) })
        .onConflictDoNothing({ target: estimator.estimatorSettings.tenantId });
    });
    await estimatorListener.ensureTemplates(tenantId);
  }

  // --- src/server/comms-hooks.ts and comms.ts ---------------------------------------------
  const producers = [schedulingListener, estimatorListener, { beforeSend: async () => null, redactSent: () => invoicingListener.redactSent() }];
  const commsBeforeSend = async (row: Any) => {
    for (const producer of producers) {
      const decision = await producer.beforeSend(row);
      if (decision !== null) return decision;
    }
    return "send";
  };
  const afterCommsRun = async () => {
    for (const producer of producers) {
      try {
        await producer.redactSent();
      } catch (error) {
        failures.push({ where: "comms:redact", error });
      }
    }
  };
  const commsAdmin = comms.createCommsAdminHandlers({
    db,
    senders: commsSenders,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer,
    ensureTemplates: (tenantId: string) => ensureCompanySetup(tenantId),
    beforeSend: commsBeforeSend,
    afterRun: afterCommsRun,
    delivery: () => ({ emails: true, emailsOffReason: null }),
    onError: report("comms:admin"),
    now,
  });

  // --- src/server/company-setup.ts --------------------------------------------------------
  const SETUPS: readonly { name: string; run: (tenantId: string) => Promise<unknown> }[] = [
    { name: "scheduling", run: setupSchedulingFor },
    { name: "estimator", run: setupEstimatorFor },
    { name: "invoicing", run: setupInvoicingFor },
    // No comms entry (review T2A-BO-08): its starter templates are sent by nothing.
  ];
  const done = new Map<string, Promise<void>>();
  function ensureCompanySetup(tenantId: string): Promise<void> {
    const known = done.get(tenantId);
    if (known) return known;
    const pending = (async () => {
      const profile = await tenancy.companyProfile(tenantId);
      if (!profile || profile.kind !== "org") return false;
      for (const setup of SETUPS) await setup.run(tenantId);
      return true;
    })().then(
      (real) => {
        if (!real) done.delete(tenantId);
      },
      (error: unknown) => {
        done.delete(tenantId);
        throw error;
      },
    );
    done.set(tenantId, pending);
    return pending;
  }
  onCompanyEvent = async (event: Any) => {
    try {
      if (event.type === "company.created") await ensureCompanySetup(event.tenantId);
      if (event.type === "company.settings.updated" && event.section === "company" && event.changed.includes("timeZone")) {
        await syncSchedulingCompany(event.tenantId);
      }
      if (event.type === "member.joined" || event.type === "member.role.changed") await linkNewCrewMember(event.tenantId, event.userId);
    } catch (error) {
      failures.push({ where: `company-setup:${event.type}`, error });
    }
  };

  /** src/server/scheduling.ts's linkNewCrewMember: one free crew → the new crew member opens it. */
  async function linkNewCrewMember(tenantId: string, userId: string): Promise<void> {
    const person = (await tenancy.listMemberPeople(tenantId)).find((p: Any) => p.userId === userId);
    if (!person || person.roleKey !== scheduling.SCHEDULING_CREW_ROLE.key) return;
    const crews = await scheduling.listResources(db, tenantId);
    if (crews.some((crew: Any) => crew.userId !== null && String(crew.userId) === userId)) return;
    if (crews.length !== 1 || crews[0].userId !== null) return;
    await scheduling.updateResource(db, tenantId, crews[0].id, { userId });
  }

  // --- app/api/cron/* ---------------------------------------------------------------------
  async function runCron(name: "scheduling" | "estimator" | "comms", cronOptions: { failCompany?: string } = {}): Promise<Any> {
    const broken = (tenantId: string) => {
      if (cronOptions.failCompany && tenantId === cronOptions.failCompany) throw new Error("this company's run broke on purpose");
    };
    if (name === "scheduling") {
      return tenancyServer.runForEachCompany(
        tenancy,
        async (tenantId: string) => {
          broken(tenantId);
          await syncSchedulingCompany(tenantId);
          return (await scheduling.expirePendingRequests(db, tenantId, { onEvent: onSchedulingEvent, now: now() })).expired;
        },
        { timeBudgetMs: 45_000, now },
      );
    }
    if (name === "estimator") {
      const quotes = await tenancyServer.runForEachCompany(
        tenancy,
        async (tenantId: string) => {
          broken(tenantId);
          return estimator.expireQuotes(db, tenantId, { onEvent: onEstimatorEvent, now: now(), timeBudgetMs: 5_000 });
        },
        { timeBudgetMs: 35_000, now },
      );
      const photos = await estimator.purgeOrphanPhotos(db, undefined, { now: now(), timeBudgetMs: 15_000 });
      return { ...quotes, photosDeleted: photos.deleted, photosNotDeleted: photos.failed };
    }
    try {
      const tenantIds = (await tenancy.activeCompanyIds()).filter((id: string) => id !== cronOptions.failCompany);
      return await comms.runDueMessages(db, commsSenders, { tenantIds, timeBudgetMs: 45_000, beforeSend: commsBeforeSend, now: now() });
    } finally {
      await afterCommsRun();
    }
  }

  // --- the pages ------------------------------------------------------------------------
  const widgets = await buildTarget(tenancy2aScenarioTarget, { write: false });

  type Gate = { redirect: string } | { html: string } | { cfg: Record<string, unknown>; company: Any; who: { userId: string; email: string } };

  /** src/components/CompanyGate.tsx, as a function of the request, plus the header the layout draws. */
  async function gate(req: Request, path: string, permission?: string): Promise<Gate> {
    const who = await principal(req);
    if (!who) return { redirect: `/sign-in?redirect_url=${encodeURIComponent(path)}` };
    const session = await tenancy.resolveSession({ userId: who.userId });
    const isStaff = (await loaders.loadStaffPermissions({ principal: who })) !== null;
    if (session.state === "needs-onboarding") return { redirect: isStaff ? "/admin/companies" : "/onboarding" };
    const wire = tenancyServer.sessionToWire(session);
    if (session.state === "suspended") {
      return {
        html: page(
          { mode: "suspended", session: wire, email: who.email, links: [], companyName: session.company.name, companies: wire.companies, supportEmail: SUPPORT_EMAIL },
          `${session.company.name} is suspended`,
        ),
      };
    }
    const company = tenancyServer.companyToWire(session.company);
    const can: string[] = (await loaders.loadTenantPermissions({ principal: who, tenantId: company.id }))?.toArray() ?? [];
    // A RUNTIME PERMISSION FILTER OVER A GENERATED LIST (AuthHeader.tsx).
    const links = APP_LINKS.filter(
      (link) => (link.audience !== "staff" || isStaff) && (link.permission === undefined || can.includes(link.permission)),
    ).map(({ href, label }) => ({ href, label }));
    const base = { session: wire, company, can, email: who.email, links };
    if (permission !== undefined && !can.includes(permission)) {
      return { html: page({ ...base, mode: "no-access" }, "You don't have access to this page") };
    }
    return { cfg: base, company, who };
  }

  /** The admin layout: staff only, healing the first administrator on the way in. */
  async function staffGate(req: Request, path: string): Promise<{ redirect: string } | { html: string } | null> {
    const who = await principal(req);
    if (!who) return { redirect: `/sign-in?redirect_url=${encodeURIComponent(path)}` };
    let can = await loaders.loadStaffPermissions({ principal: who });
    if (!can) {
      const healed = await tenancy.ensureBootstrapAdmin({ userId: who.userId, email: who.email });
      if (healed.granted) can = await loaders.loadStaffPermissions({ principal: who });
    }
    if (!can) return { html: page({ mode: "text", text: "You do not have access to the admin panel." }, "Admin") };
    return null;
  }

  /** The company area's pages (overlays/<feature>-companies), each with its gate permission (11.3). */
  const APP_PAGES: { pattern: RegExp; mode: string; permission: string; title: string; props?: (m: RegExpExecArray, url: URL, company: Any) => Record<string, unknown> }[] = [
    {
      pattern: /^\/app\/schedule$/,
      mode: "schedule",
      permission: "schedule.view",
      title: "Schedule",
      props: (_m, url, company) => ({
        bookingPageUrl: companyLinksFor(company.slug, origin).bookVisit(),
        initialDate: /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date") ?? "") ? url.searchParams.get("date") : undefined,
      }),
    },
    { pattern: /^\/app\/schedule\/today$/, mode: "today", permission: "schedule.route", title: "Today's route" },
    {
      pattern: /^\/app\/schedule\/settings$/,
      mode: "schedule-settings",
      permission: "schedule.view",
      title: "Schedule settings",
      props: (_m, _url, company) => ({ bookingPageUrl: companyLinksFor(company.slug, origin).bookVisit() }),
    },
    { pattern: /^\/app\/estimates$/, mode: "estimates", permission: "estimator.view", title: "Estimates" },
    { pattern: /^\/app\/estimates\/settings$/, mode: "estimate-settings", permission: "estimator.view", title: "Estimate settings" },
    { pattern: /^\/app\/estimates\/([^/]+)$/, mode: "estimate", permission: "estimator.view", title: "Estimate", props: (m) => ({ estimateId: decodeURIComponent(m[1]!) }) },
    { pattern: /^\/app\/price-book$/, mode: "price-book", permission: "estimator.view", title: "Price book" },
    { pattern: /^\/app\/invoices$/, mode: "invoices", permission: "invoices.view", title: "Invoices" },
    { pattern: /^\/app\/invoices\/([^/]+)$/, mode: "invoice", permission: "invoices.view", title: "Invoice", props: (m) => ({ invoiceId: decodeURIComponent(m[1]!) }) },
    { pattern: /^\/app\/messages$/, mode: "messages", permission: "comms.view", title: "Messages" },
  ];

  /** Each company's public pages (11.3), inside PublicCompanyGate. */
  const PUBLIC_PAGES: { pattern: RegExp; mode: string; title: string; meta: string; props?: (m: RegExpExecArray, url: URL) => Record<string, unknown> }[] = [
    { pattern: /^\/t\/([^/]+)$/, mode: "public-home", title: "", meta: NOINDEX, props: () => ({ publicPages: PUBLIC_COMPANY_PAGES }) },
    { pattern: /^\/t\/([^/]+)\/estimate$/, mode: "public-estimate", title: "Instant estimate", meta: NOINDEX },
    { pattern: /^\/t\/([^/]+)\/quote\/([^/]+)$/, mode: "public-quote", title: "Your quote", meta: TOKEN_PAGE, props: (m) => ({ token: decodeURIComponent(m[2]!) }) },
    {
      pattern: /^\/t\/([^/]+)\/book-visit$/,
      mode: "public-book",
      title: "Book a visit",
      meta: NOINDEX,
      props: (_m, url) => ({ service: url.searchParams.get("service") || null, estimate: url.searchParams.get("estimate") || null }),
    },
    { pattern: /^\/t\/([^/]+)\/visit\/([^/]+)$/, mode: "public-visit", title: "Your visit", meta: TOKEN_PAGE, props: (m) => ({ token: decodeURIComponent(m[2]!) }) },
    {
      pattern: /^\/t\/([^/]+)\/invoice\/([^/]+)$/,
      mode: "public-invoice",
      title: "Your invoice",
      meta: TOKEN_PAGE,
      props: (m, url) => ({ token: decodeURIComponent(m[2]!), preview: url.searchParams.get("preview") === "1" }),
    },
  ];

  handleRequest = (rawReq, res) => {
    void (async () => {
      const url = new URL(rawReq.url ?? "/", origin);
      const path = url.pathname;
      const redirect = (to: string, status = 302) => {
        res.writeHead(status, { location: to, "cache-control": "no-store" });
        res.end();
      };
      const html = (body: string, status = 200) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(body);
      };
      const json = (body: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      try {
        // --- the APIs -----------------------------------------------------------------
        if (path.startsWith("/api/admin/tenancy/")) return await send(res, await operatorHandlers.handle(await toRequest(rawReq, origin)));
        if (path.startsWith("/api/tenancy/")) return await send(res, await tenancyHandlers.handle(await toRequest(rawReq, origin)));
        const privateApi = /^\/api\/app\/[^/]+\/(schedule|estimator|invoices|messages)\//.exec(path);
        if (privateApi) {
          const handler = { schedule: schedulingAdmin, estimator: estimatorAdmin, invoices: invoicingAdmin, messages: commsAdmin }[privateApi[1] as "schedule"];
          return await send(res, await handler.handle(await toRequest(rawReq, origin)));
        }
        const publicApi = /^\/api\/t\/[^/]+\/(schedule|estimator|invoices)\//.exec(path);
        if (publicApi) {
          const handler = { schedule: schedulingPublic, estimator: estimatorPublic, invoices: invoicingPublic }[publicApi[1] as "schedule"];
          return await send(res, await handler.handle(await toRequest(rawReq, origin)));
        }
        if (path.startsWith("/api/estimator/")) return await send(res, await estimatorEmbed.handle(await toRequest(rawReq, origin)));

        // --- the test's own doors ------------------------------------------------------
        if (path === "/widgets.js") {
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
          return res.end(widgets);
        }
        if (path.startsWith("/__test/logos/")) {
          const logo = logos.get(decodeURIComponent(path.slice("/__test/logos/".length)));
          if (!logo) {
            res.writeHead(404);
            return res.end();
          }
          res.writeHead(200, { "content-type": logo.contentType });
          return res.end(Buffer.from(logo.bytes));
        }
        if (path === "/__test/outbox") return json(outbox);
        if (path === "/__test/clock" && rawReq.method === "POST") {
          const at = new Date(url.searchParams.get("at") ?? "");
          if (Number.isNaN(at.getTime())) return json({ error: "at must be an ISO time" }, 400);
          setClock(at);
          return json({ now: now().toISOString() });
        }
        const cron = /^\/__test\/cron\/(scheduling|estimator|comms)$/.exec(path);
        if (cron && rawReq.method === "POST") {
          return json(await runCron(cron[1] as "scheduling", { failCompany: url.searchParams.get("failCompany") ?? undefined }));
        }
        if (path === "/__test/sign-in") {
          const who = (url.searchParams.get("email") ?? "").trim().toLowerCase();
          const name = url.searchParams.get("name") ?? "";
          const next = url.searchParams.get("next") || "/dashboard";
          names.set(who, name);
          if (url.searchParams.get("via") === "webhook") await webhookCreates(who, name);
          res.writeHead(302, {
            location: next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard",
            "set-cookie": `e2e-user=${encodeURIComponent(who)}; Path=/; HttpOnly; SameSite=Lax`,
          });
          return res.end();
        }
        if (path === "/__test/sign-out") {
          res.writeHead(302, { location: "/sign-in", "set-cookie": "e2e-user=; Path=/; Max-Age=0" });
          return res.end();
        }
        if (path === "/sign-in" || path === "/sign-up") return html(signInPage(url.searchParams.get("redirect_url") ?? "/dashboard"));

        const req = await toRequest(rawReq, origin);

        // --- Tenancy 1's pages -----------------------------------------------------------
        if (path === "/onboarding") {
          const who = await principal(req);
          if (!who) return redirect(`/sign-up?redirect_url=${encodeURIComponent("/onboarding")}`);
          const another = url.searchParams.has("another");
          const session = await tenancy.resolveSession({ userId: who.userId, verifiedEmails: [who.email] });
          if (session.state !== "needs-onboarding" && !another) return redirect("/dashboard");
          const isStaff = (await loaders.loadStaffPermissions({ principal: who })) !== null;
          return html(
            page(
              { mode: "onboarding", session: tenancyServer.sessionToWire(session), email: who.email, another, staffConsoleHref: isStaff ? "/admin/companies" : null },
              "Set up your company",
            ),
          );
        }
        const invite = /^\/invite\/([^/]+)$/.exec(path);
        if (invite) {
          const who = await principal(req);
          if (!who) return redirect(`/sign-up?redirect_url=${encodeURIComponent(path)}`);
          return html(page({ mode: "invite", token: decodeURIComponent(invite[1]!), email: who.email }, "Accept your invitation"));
        }
        if (path === "/app" || path === "/app/") return redirect("/dashboard");

        // D2: an email's private link switches the reader's company first.
        const switching = /^\/app\/switch\/([^/]+)$/.exec(path);
        if (switching) {
          const next = safeSwitchNext(url.searchParams.get("next"));
          const who = await principal(req);
          if (!who) return redirect(`/sign-in?redirect_url=${encodeURIComponent(`${path}${url.search}`)}`);
          const found = await tenancy.resolvePublicCompany(decodeURIComponent(switching[1]!));
          if (found) {
            try {
              await tenancy.setActiveCompany({ userId: who.userId, tenantId: found.company.id });
            } catch (error) {
              if (!(error instanceof tenancyServer.TenancyError && (error as Any).code === "not_found")) throw error;
            }
          }
          return redirect(next);
        }

        const companyPages: Record<string, { mode: string; permission?: string; title: string }> = {
          "/dashboard": { mode: "dashboard", title: "Dashboard" },
          "/settings/team": { mode: "team", permission: "members.view", title: "Team" },
          "/settings/company": { mode: "settings", permission: "tenant.view", title: "Company settings" },
        };
        const t1 = companyPages[path];
        if (t1) {
          const verdict = await gate(req, path, t1.permission);
          if ("redirect" in verdict) return redirect(verdict.redirect);
          if ("html" in verdict) return html(verdict.html);
          const cards =
            t1.mode === "dashboard"
              ? (verdict.cfg.links as { href: string; label: string }[]).filter((l) => l.href !== "/dashboard" && l.href !== "/admin")
              : undefined;
          return html(page({ ...verdict.cfg, mode: t1.mode, cards }, t1.mode === "dashboard" ? verdict.company.name : t1.title));
        }
        for (const appPage of APP_PAGES) {
          const m = appPage.pattern.exec(path);
          if (!m) continue;
          const verdict = await gate(req, `${path}${url.search}`, appPage.permission);
          if ("redirect" in verdict) return redirect(verdict.redirect);
          if ("html" in verdict) return html(verdict.html);
          return html(page({ ...verdict.cfg, mode: appPage.mode, ...(appPage.props?.(m, url, verdict.company) ?? {}) }, appPage.title));
        }

        // --- each company's public pages: PublicCompanyGate -------------------------------
        for (const publicPage of PUBLIC_PAGES) {
          const m = publicPage.pattern.exec(path);
          if (!m) continue;
          const found = await tenancy.resolvePublicCompany(decodeURIComponent(m[1]!));
          if (!found) {
            res.writeHead(404, { "content-type": "text/plain" });
            return res.end("not found");
          }
          const company = tenancyServer.publicCompanyToWire(found);
          if (found.retiredSlug !== null) return redirect(`${company.publicPath}${path.slice(`/t/${m[1]}`.length)}${url.search}`, 308);
          // The tab title is the COMPANY's, as the generated pages' publicCompanyMetadata
          // sets it (review T2A-BO-01): "Instant estimate · Green Acres", never this site's.
          const title = publicPage.title ? `${publicPage.title} · ${company.name}` : company.name;
          return html(page({ mode: publicPage.mode, publicCompany: company, ...(publicPage.props?.(m, url) ?? {}) }, title, publicPage.meta));
        }

        // --- the operator console ---------------------------------------------------------
        if (path === "/admin" || path === "/admin/companies" || path.startsWith("/admin/companies/")) {
          const refused = await staffGate(req, path);
          if (refused) return "redirect" in refused ? redirect(refused.redirect) : html(refused.html);
          if (path === "/admin" || path === "/admin/companies") return html(page({ mode: "admin-companies" }, "Companies"));
          return html(page({ mode: "admin-company", tenantId: decodeURIComponent(path.slice("/admin/companies/".length)) }, "Company"));
        }

        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      } catch (error) {
        failures.push({ where: `fixture:${path}`, error });
        console.error(error);
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("fixture error");
      }
    })();
  };

  return {
    get origin() {
      return origin;
    },
    outbox,
    invitations,
    failures,
    now,
    setClock,
    query,
    companyId: async (slug: string) => (await tenancy.resolvePublicCompany(slug))?.company.id ?? null,
    runCron,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await testDb.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  } satisfies Tenancy2aScenarioServer;
}
