import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";
import { buildTarget, tenancy2b1ScenarioTarget } from "../bundle.mjs";

/**
 * The fixture behind e2e/tests/tenancy-2b1-scenario.spec.ts (Tenancy 2b-1,
 * contract section 16): the Tenancy 2a scenario's REAL companies backend
 * (fixtures/tenancy-2a-scenario-server.ts, whose pieces this reuses; that
 * file is not edited) with ALERTS and FILES in it, wired the way a generated
 * `--tenant-noun Company --estimator --scheduling --invoicing --comms --email
 * --storage --notifications` project wires them (create-app 0.24's emitted
 * src/server/alerts.ts, alerts-routes.ts, files.ts, files-routes.ts, the
 * companies notify modules, company-setup.ts, the invoicing glue and the two
 * cron routes):
 *
 *   - @adminigloo/notifications 0.2's `createNotifications` (the alerts) and
 *     its handlers at /api/app/:id/alerts/*, the producers of every installed
 *     package FIRST in each listener list, the office emails claimed through
 *     `claimEmails` (`officeRecipients`) and handed back on a failure
 *     (`officeSent`), the comms senders' `onFailed`, tenancy's team events;
 *   - @adminigloo/storage 0.2's `createStorage` (the files) over two memory
 *     stores — PRIVATE, and PUBLIC served at /__blob/{key} as a public CDN
 *     would — with a signing key and `stillValid` checking the maker and the
 *     company on every open; its handlers at /api/app/:id/files/* and the
 *     signed links and public files at /api/files/*; the logo store tenancy
 *     uses and the estimator's photo store;
 *
 * on PGlite holding the 2a tables plus notifications' and storage's. The
 * REAL screens (bundle.mjs's `tenancy2b1ScenarioTarget`,
 * fixtures/tenancy-2b1-scenario-host.tsx) are served at 2a's paths plus
 * /app/alerts, /app/alerts/settings, /app/files and
 * /app/schedule/visits/:id/files, with the bell in every company page's
 * header and "Photos and files" under the estimate and invoice editors.
 *
 * What a test owns (2a's doors, plus):
 *
 *   - GET  /__test/outbox            every email as the provider got it, with its comms template;
 *   - GET  /__test/blobs             `{ key, access, size }[]` of both stores (never served to a page);
 *   - GET  /__blob/{key}             the PUBLIC store only;
 *   - POST /__test/clock?at=ISO      the one scenario clock;
 *   - POST /__test/cron/{alerts|files|scheduling|estimator|comms}
 *   - POST /__test/replay-last-event the last scheduling or estimator event, to the listeners again.
 *
 * NEGATIVE CONTROLS (contract 16) live HERE, never in the packages:
 *
 *   - `no-dedupe`: every draft's `dedupeKey` gets a random suffix, so a
 *     replayed event alerts again;
 *   - `no-crew-scope`: `people()` ignores the permission, so everyone in the
 *     company is alerted about everything;
 *   - `private-as-public`: the private slot is the PUBLIC memory store,
 *     wrapped to say "private" (so createStorage's own check doesn't stop
 *     the fixture), so a private file is served at /__blob/{key};
 *   - `link-ignores-maker`: `stillValid` always answers yes, so a removed
 *     maker's copied link keeps opening.
 *
 * Everything server-side is imported from the BUILT packages (dist).
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
export const PLATFORM_NAME = "Igloo Back Office";
export const PLATFORM_FROM = "Igloo Back Office <messages@igloo.test>";
export const PLATFORM_FROM_ADDRESS = "messages@igloo.test";
export const PLATFORM_REPLY_TO = "platform@igloo.test";
/** The signing key for copied links (a project's FILES_LINK_SECRET). */
export const FILE_LINK_SECRET = "e2e-file-link-secret-at-least-thirty-two-characters";

/** One email as the provider would have been handed it. */
export interface SentMail {
  to: string;
  fromName: string | null;
  fromAddress: string;
  replyTo: string | null;
  subject: string;
  text: string;
  /** The comms template it went out as ("estimate_lead_staff", "team_alert"…), from the delivery log. */
  templateKey: string | null;
  at: string;
}

export interface SentInvitation {
  to: string;
  url: string;
}

export interface StoredBlob {
  key: string;
  access: "private" | "public";
  size: number;
}

export type Tenancy2b1Break = "no-dedupe" | "no-crew-scope" | "private-as-public" | "link-ignores-maker";

export interface Tenancy2b1ScenarioServer {
  origin: string;
  /** The outbox with each email's template filled in from the delivery log. */
  outbox: () => Promise<SentMail[]>;
  invitations: SentInvitation[];
  failures: { where: string; error: unknown }[];
  now: () => Date;
  setClock: (at: Date) => void;
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  companyId: (slug: string) => Promise<string | null>;
  blobs: () => StoredBlob[];
  runCron: (name: "scheduling" | "estimator" | "comms" | "alerts" | "files") => Promise<Any>;
  replayLastEvent: () => Promise<{ replayed: string | null }>;
  close: () => Promise<void>;
}

export interface Tenancy2b1ScenarioOptions {
  break?: Tenancy2b1Break;
  /** Where the scenario clock starts. Default: now. */
  start?: Date;
}

/** src/nav.ts's APP_LINKS for a companies project with every feature, files and an admin shell. */
const APP_LINKS: readonly { href: string; label: string; permission?: string; audience?: "staff" }[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/app/schedule", label: "Schedule", permission: "schedule.view" },
  { href: "/app/schedule/today", label: "Today's route", permission: "schedule.route" },
  { href: "/app/estimates", label: "Estimates", permission: "estimator.view" },
  { href: "/app/invoices", label: "Invoices", permission: "invoices.view" },
  { href: "/app/messages", label: "Messages", permission: "comms.view" },
  { href: "/app/files", label: "Files", permission: "files.view" },
  { href: "/settings/team", label: "Team", permission: "members.view" },
  { href: "/settings/company", label: "Settings", permission: "tenant.view" },
  { href: "/admin", label: "Admin", audience: "staff" },
];

const PUBLIC_COMPANY_PAGES = [
  { path: "/estimate", label: "Get an instant estimate" },
  { path: "/book-visit", label: "Book a visit" },
];

/** The emitted src/server/alerts.ts's ALERT_HREFS (companies). */
const ALERT_HREFS = {
  team: "/settings/team",
  visit: "/app/schedule?date={date}&visit={id}",
  crewDay: "/app/schedule/today",
  estimate: "/app/estimates/{id}",
  invoice: "/app/invoices/{id}",
  messages: "/app/messages",
  files: "/app/files",
} as const;
/** src/server/visit-files.ts. */
const VISIT_FILES_HREF = "/app/schedule/visits/{id}/files";

/** The emitted src/server/company-links.ts, in a few lines (as the 2a fixture). */
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

/** The emitted safeSwitchNext (2a D2, plus 2b-1's two settings pages). */
const SWITCH_SETTINGS_PAGES = new Set(["/settings/company", "/settings/team"]);
function safeSwitchNext(value: string | null): string {
  if (typeof value !== "string") return "/dashboard";
  if (value === "/dashboard") return value;
  if (/[\\\u0000-\u001f]/.test(value)) return "/dashboard";
  const settings = SWITCH_SETTINGS_PAGES.has(value.split(/[?#]/)[0] ?? "");
  if (!value.startsWith("/app/") && !settings) return "/dashboard";
  const parsed = new URL(value, "http://this.site");
  if (parsed.host !== "this.site") return "/dashboard";
  if (!parsed.pathname.startsWith("/app/") && !SWITCH_SETTINGS_PAGES.has(parsed.pathname)) return "/dashboard";
  if (parsed.pathname.startsWith("/app/switch/")) return "/dashboard";
  return `${parsed.pathname}${parsed.search}`;
}

/** The 2a fixture's overlay compiler: the generator's shared modules, from its source, over the BUILT packages. */
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

const NOINDEX = '<meta name="robots" content="noindex, nofollow">';
const TOKEN_PAGE = `${NOINDEX}<meta name="referrer" content="no-referrer">`;

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

/** The emitted src/server/invoicing.ts's dueDateFor (as the 2a fixture). */
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

function parseFrom(from: string): { name: string | null; address: string } {
  const named = /^\s*"?(.*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (named) return { name: named[1]!.replace(/\\"/g, '"').trim() || null, address: named[2]!.trim() };
  return { name: null, address: from.trim() };
}

export async function startTenancy2b1ScenarioServer(options: Tenancy2b1ScenarioOptions = {}): Promise<Tenancy2b1ScenarioServer> {
  const scratch = mkdtempSync(join(tmpdir(), "aig-e2e-2b1-"));
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
    notificationsPkg,
    notificationsSchema,
    storagePkg,
    storageSchema,
    storageTesting,
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
    import(dist("notifications", "index.js")),
    import(dist("notifications", "schema.js")),
    import(dist("storage", "index.js")),
    import(dist("storage", "schema.js")),
    import(dist("storage", "testing.js")),
  ]);
  const drizzleDir = realpathSync(join(packagesDir, "scheduling", "node_modules", "drizzle-orm"));
  const { and, asc, eq, inArray, sql }: Any = await import(pathToFileURL(join(drizzleDir, "index.js")).href);
  const schedulingConfig = await loadOverlayModule("scheduling/src/server/scheduling-config.ts", scratch);
  const estimatorConfig = await loadOverlayModule("estimator/src/server/estimator-config.ts", scratch);

  // --- the clock ------------------------------------------------------------------
  let offsetMs = options.start ? options.start.getTime() - Date.now() : 0;
  const now = () => new Date(Date.now() + offsetMs);
  const setClock = (at: Date) => {
    offsetMs = at.getTime() - Date.now();
  };

  // --- the database: src/db/schema.ts's `schema` (2a's, plus alerts' and files') ----
  const schema = {
    ...authSchema.authSchema,
    ...tenancySchema.tenancySchema,
    ...permissionsSchema.permissionsSchema,
    auditLog: observabilitySchema.auditLog,
    ...schedulingSchema,
    ...estimatorSchema,
    ...invoicingSchema,
    ...commsSchema,
    ...notificationsSchema,
    ...storageSchema,
  };
  const testDb = await pglite.createPgliteDb({ schema, logQueries: false });
  const db = testDb.db;
  const client = testDb.client;
  const query = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> =>
    (await client.query(text, params)).rows as T[];

  let handleRequest: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.writeHead(503);
    res.end();
  };
  const server: Server = createServer((req, res) => handleRequest(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const failures: Tenancy2b1ScenarioServer["failures"] = [];
  const report = (where: string) => (error: unknown) => void failures.push({ where, error });

  // --- src/permissions/roles.ts and catalog.ts --------------------------------------
  const TENANT_ROLES = tenancyRoot.defineTenantRoles([scheduling.SCHEDULING_CREW_ROLE]);
  const fragments = [
    tenancyRoot.tenancyPermissions,
    scheduling.schedulingPermissions,
    estimator.estimatorPermissions,
    invoicing.invoicingPermissions,
    comms.commsPermissions,
    notificationsPkg.notificationsPermissions,
    storagePkg.storagePermissions,
  ];
  const tenantCatalog = permissionsRoot.definePermissions("tenant", Object.assign({}, ...fragments), { contributedBy: fragments });
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
  await permissionsServer.seedPermissionCatalog(db, {
    staff: { catalog: staffCatalog, templates: permissionsRoot.STAFF_ROLE_TEMPLATES },
    tenant: { catalog: tenantCatalog, templates: TENANT_ROLES.templates },
  });

  const tenantSettings = tenancyRoot.defineTenantSettings([tenancyRoot.companySettings, tenancyRoot.defineSettingsFragment(invoicing.invoicingSettingsFragment)]);
  const setupChecklist = tenancyRoot.defineSetupChecklist([
    ...tenancyServer.tenancyChecklistItems({ companySettings: "/settings/company", team: "/settings/team" }),
    ...scheduling.schedulingChecklistItems({ booking: "/app/schedule/settings#booking", crews: "/app/schedule/settings#crews" }),
    ...estimator.estimatorChecklistItems({ priceBook: "/app/price-book", settings: "/app/estimates/settings", embed: "/app/estimates/settings#embed" }),
    ...invoicing.invoicingChecklistItems({ details: "/settings/company#invoicing" }),
  ]);

  // Late-bound (13.10's import chains, here in one scope): tenancy reaches the
  // files' logo store and the alerts reach tenancy, all inside functions.
  // eslint-disable-next-line prefer-const
  let files: Any;
  // eslint-disable-next-line prefer-const
  let alerts: Any;

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
  /** src/server/tenancy-logo.ts: the files' logo store (the company's ONE public file). */
  const logoStore = {
    put: (input: Any) => files.logoStore().put(input),
    delete: (key: string, context?: Any) => files.logoStore().delete(key, context),
  };
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

  // --- the fake identity provider (the 2a fixture's) --------------------------------
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
  const principal = async (req: Request) => principalFor(cookieOf(req, "e2e-user"));

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
  const companyAuthorizer = async (req: Request, permission: string, tenantId: string) => {
    const verdict = await companyRoutes.authorize(req, permission, tenantId);
    if (verdict === false || verdict instanceof Response) return verdict;
    await ensureCompanySetup(tenantId);
    return verdict;
  };
  const resolvePublicTenant = async (req: Request): Promise<string | null> => {
    const tenantId = await publicCompanies.resolveTenant(req);
    if (tenantId === null) return null;
    await ensureCompanySetup(tenantId);
    return tenantId;
  };
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
  const outbox: Omit<SentMail, "templateKey">[] = [];
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
  const companyIdentity = async (tenantId: string) => {
    const profile = await tenancy.companyProfile(tenantId);
    return profile ? { name: profile.name, replyTo: profile.replyTo } : null;
  };
  const commsSenders = {
    identity: companyIdentity,
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
    // Tenancy 2b-1 (12.1): a customer's email that failed for good becomes an alert.
    onFailed: (failure: Any) => alertOnCommsFailure(failure),
  };

  // --- src/server/alerts.ts ------------------------------------------------------------
  const ALERT_REGISTRY = notificationsPkg.defineAlertRegistry([
    tenancyRoot.tenancyAlertKinds,
    scheduling.schedulingAlertKinds,
    estimator.estimatorAlertKinds,
    invoicing.invoicingAlertKinds,
    comms.commsAlertKinds,
    storagePkg.storageAlertKinds,
  ]);
  /** Who may get an alert: the company's ACTIVE members holding the kind's permission now (D4). */
  const alertPeople = async (tenantId: string, permission: string) => {
    const profile = await tenancy.companyProfile(tenantId);
    if (!profile || profile.kind !== "org" || profile.status !== "active") return [];
    // NEGATIVE CONTROL `no-crew-scope`: every member, whatever the permission.
    const people = await tenancy.listMemberPeople(tenantId, options.break === "no-crew-scope" ? {} : { holding: permission });
    return people.map((person: Any) => ({ userId: person.userId, name: person.name, email: person.email, isOwner: person.roleKey === "owner" }));
  };
  const businessEmail = async (tenantId: string) => (await tenancy.companyProfile(tenantId))?.inbox[0] ?? null;
  const teamTemplateAdded = new Set<string>();
  async function ensureTeamAlertTemplate(tenantId: string): Promise<void> {
    if (teamTemplateAdded.has(tenantId)) return;
    await db
      .insert(comms.commsTemplates)
      .values({
        tenantId,
        key: notificationsPkg.TEAM_ALERT_EMAIL_TEMPLATE.key,
        channel: "email",
        subject: notificationsPkg.TEAM_ALERT_EMAIL_TEMPLATE.subject,
        body: notificationsPkg.TEAM_ALERT_EMAIL_TEMPLATE.body,
      })
      .onConflictDoNothing({ target: [comms.commsTemplates.tenantId, comms.commsTemplates.key] });
    teamTemplateAdded.add(tenantId);
  }
  async function sendAlertEmail(message: Any) {
    await ensureTeamAlertTemplate(message.tenantId);
    const profile = await tenancy.companyProfile(message.tenantId);
    if (!profile) return { status: "skipped", reason: "The company is no longer here." };
    const links = companyLinksFor(profile.slug, origin);
    const open = message.href ? links.app(message.href) : null;
    const { message: logged, retryable } = await comms.deliverNow(
      db,
      {
        tenantId: message.tenantId,
        to: message.to,
        templateKey: notificationsPkg.TEAM_ALERT_EMAIL_TEMPLATE.key,
        vars: {
          title: message.title,
          body: message.body ?? "",
          linkLine: open ? `Open it: ${open}` : "",
          settingsLine: message.addressOnly
            ? `You get this because ${profile.name} added this address.`
            : `Change which alerts you get by email: ${links.app("/app/alerts/settings")}`,
          businessName: profile.name,
        },
        idempotencyKey: message.idempotencyKey,
        replyTo: message.replyTo,
      },
      commsSenders,
    );
    if (logged.status === "sent") return { status: "sent" };
    if (logged.status === "skipped") return { status: "skipped", reason: logged.error ?? "Not sent." };
    return { status: "failed", error: logged.error ?? "The email didn't go.", retryable };
  }
  const PRODUCER_TEMPLATES: Record<string, string> = {
    "estimator.lead": "estimate_lead_staff",
    "estimator.quote.accepted": "quote_staff_notice",
    "estimator.quote.declined": "quote_staff_notice",
    "estimator.quote.expired": "quote_staff_notice",
    "scheduling.visit.requested": "visit_staff_notice",
    "scheduling.visit.moved": "visit_staff_notice",
    "scheduling.visit.cancelled": "visit_staff_notice",
    "scheduling.request.expired": "visit_staff_notice",
  };
  const alertEmailTemplate = (kind: string) => PRODUCER_TEMPLATES[kind] ?? notificationsPkg.TEAM_ALERT_EMAIL_TEMPLATE.key;
  async function alertEmailDelivery(tenantId: string) {
    const offKinds: Record<string, string> = {};
    const templates = [...new Set(ALERT_REGISTRY.kinds.map((kind: Any) => alertEmailTemplate(kind.key)))];
    const off = await db
      .select({ key: comms.commsTemplates.key })
      .from(comms.commsTemplates)
      .where(and(eq(comms.commsTemplates.tenantId, tenantId), eq(comms.commsTemplates.isActive, false), inArray(comms.commsTemplates.key, templates)));
    const offKeys = new Set(off.map((row: Any) => row.key));
    for (const kind of ALERT_REGISTRY.kinds) {
      const template = alertEmailTemplate(kind.key);
      if (offKeys.has(template)) offKinds[kind.key] = comms.templateLabel(template);
    }
    return { available: mailer.configured, offReason: mailer.configured ? null : "This site doesn't send email yet, so alerts stay in the app.", offKinds };
  }
  alerts = notificationsPkg.createNotifications({
    db,
    tables: notificationsSchema.notificationTables,
    registry: ALERT_REGISTRY,
    people: alertPeople,
    ownerEmail: businessEmail,
    email: sendAlertEmail,
    emailIdempotent: true,
    emailDelivery: alertEmailDelivery,
    now,
    onError: (error: unknown, context: Any) => failures.push({ where: `alerts:${context?.step ?? "step"}`, error }),
  });
  /** NEGATIVE CONTROL `no-dedupe`: every draft is new, so a replayed event alerts again. */
  const notify = (drafts: Any) => {
    if (options.break !== "no-dedupe") return alerts.notify(drafts);
    const list = (Array.isArray(drafts) ? drafts : [drafts]).map((draft: Any) => ({
      ...draft,
      dedupeKey: `${draft.dedupeKey}:${Math.random().toString(36).slice(2, 10)}`.slice(0, 200),
    }));
    return alerts.notify(list);
  };
  const reportAlertsError = (step: string) => (error: unknown) => failures.push({ where: `alerts:${step}`, error });

  async function alertOnTenancyEvent(event: Any): Promise<void> {
    try {
      await notify(tenancyRoot.tenancyAlertsFor(event, { teamHref: ALERT_HREFS.team }));
      if (event.type === "member.removed" || event.type === "member.left") {
        await alerts.forget({ tenantId: event.tenantId, userId: event.userId });
      } else if (event.type === "member.role.changed") {
        const held: string[] = [];
        for (const permission of ALERT_REGISTRY.permissions) {
          const people = await tenancy.listMemberPeople(event.tenantId, { holding: permission });
          if (people.some((person: Any) => person.userId === event.userId)) held.push(permission);
        }
        await alerts.prune({ tenantId: event.tenantId, userId: event.userId, permissions: held });
      }
    } catch (error) {
      reportAlertsError("tenancy-event")(error);
    }
  }
  async function alertOnSchedulingEvent(event: Any): Promise<void> {
    try {
      // `now`: the scenario's clock decides which day is "today" for the crew's link.
      await notify(
        await scheduling.schedulingAlertsFor(db, event, { hrefs: { visit: ALERT_HREFS.visit, crewDay: ALERT_HREFS.crewDay, visitFiles: VISIT_FILES_HREF }, now: now() }),
      );
    } catch (error) {
      reportAlertsError("scheduling-event")(error);
    }
  }
  async function alertOnEstimatorEvent(event: Any): Promise<void> {
    try {
      await notify(estimator.estimatorAlertsFor(event, { hrefs: { estimate: ALERT_HREFS.estimate } }));
    } catch (error) {
      reportAlertsError("estimator-event")(error);
    }
  }
  async function alertOnInvoicingEvent(event: Any): Promise<void> {
    try {
      await notify(invoicing.invoicingAlertsFor(event, { hrefs: { invoice: ALERT_HREFS.invoice } }));
    } catch (error) {
      reportAlertsError("invoicing-event")(error);
    }
  }
  // A suspended company hears nothing, quietly (the generated guard): no claim,
  // no email, nothing reported.
  const officeRecipientsFor = async (notice: Any) => {
    const profile = await tenancy.companyProfile(notice.tenantId);
    if (!profile || profile.kind !== "org" || profile.status !== "active") return [];
    return alerts.claimEmails({ tenantId: notice.tenantId, kind: notice.kind, dedupeKey: notice.dedupeKey, assignedUserIds: notice.assignedUserIds });
  };
  const officeSentFor = async (notice: Any, result: Any) => {
    if (result.status !== "failed" || !result.retryable) return;
    await alerts.releaseClaim({ tenantId: notice.tenantId, kind: notice.kind, dedupeKey: notice.dedupeKey, to: result.to });
  };
  const CUSTOMER_TEMPLATE_KEYS = new Set<string>([
    ...schedulingComms.SCHEDULING_EMAIL_TEMPLATES.filter((t: Any) => t.audience === "customer").map((t: Any) => t.key),
    ...estimatorComms.ESTIMATOR_EMAIL_TEMPLATES.filter((t: Any) => t.audience === "customer").map((t: Any) => t.key),
    ...invoicingComms.INVOICE_EMAIL_TEMPLATES.map((t: Any) => t.key),
  ]);
  async function alertOnCommsFailure(failure: Any): Promise<void> {
    try {
      const draft = comms.commsFailureAlert(failure, { href: ALERT_HREFS.messages, customerTemplateKeys: CUSTOMER_TEMPLATE_KEYS });
      if (draft) await notify(draft);
    } catch (error) {
      reportAlertsError("comms-failure")(error);
    }
  }
  async function alertOnStorageUsage(event: Any): Promise<void> {
    try {
      // FILES_MORE_ROOM (review BO-6): the platform's name and where to write.
      const draft = storagePkg.storageUsageAlert(event, { href: ALERT_HREFS.files, now: now(), platformName: PLATFORM_NAME, supportEmail: SUPPORT_EMAIL });
      if (draft) await notify(draft);
    } catch (error) {
      reportAlertsError("storage-usage")(error);
    }
  }

  // --- src/server/files.ts --------------------------------------------------------------
  const privateMemory = storageTesting.createMemoryBlobStore({ access: "private" });
  const publicMemory = storageTesting.createMemoryBlobStore({ access: "public", publicBaseUrl: `${origin}/__blob` });
  // NEGATIVE CONTROL `private-as-public`: the private slot IS the public store,
  // saying "private" (and answering no address), so its files sit at /__blob/{key}.
  const privateSlot =
    options.break === "private-as-public"
      ? {
          ...publicMemory,
          access: "private",
          put: async (key: string, bytes: Uint8Array, putOptions: Any) => {
            await publicMemory.put(key, bytes, putOptions);
            return { url: null };
          },
        }
      : privateMemory;
  // The generated check (review SEC-03): the company is active, the maker is
  // still a member, AND may still open this file with what they hold now.
  const memberStillValid = async ({ tenantId, userId, mayView }: Any) => {
    const profile = await tenancy.companyProfile(tenantId);
    if (profile?.status !== "active") return false;
    if ((await tenancy.membership({ userId, tenantId })) !== "member") return false;
    return mayView((permission: string) => tenancy.hasPermission({ userId, tenantId, permission }));
  };
  files = storagePkg.createStorage({
    db,
    tables: storageSchema.storageTables,
    stores: { private: privateSlot, public: publicMemory },
    purposes: [...storagePkg.STORAGE_BUILT_IN_PURPOSES, estimator.estimatorPhotoPurpose, estimator.estimatorStaffPhotoPurpose],
    records: [
      ...scheduling.schedulingFileRecords(db, { visitHref: ALERT_HREFS.visit }),
      ...estimator.estimatorFileRecords(db, { estimateHref: ALERT_HREFS.estimate }),
      ...invoicing.invoicingFileRecords(db, { invoiceHref: ALERT_HREFS.invoice }),
    ],
    allowanceBytes: () => 5120 * 1024 * 1024,
    signing: {
      secret: FILE_LINK_SECRET,
      // NEGATIVE CONTROL `link-ignores-maker`: every link stays good.
      stillValid: options.break === "link-ignores-maker" ? async () => true : memberStillValid,
    },
    onUsage: (event: Any) => alertOnStorageUsage(event),
    urls: {
      content: (tenantId: string, fileId: string) => `/api/app/${encodeURIComponent(tenantId)}/files/v1/admin/files/${encodeURIComponent(fileId)}/content`,
      publicBase: `${origin}/api/files`,
    },
    now,
    onError: (error: unknown, context: Any) => failures.push({ where: `files:${context?.step ?? "step"}`, error }),
  });
  const estimatorPhotoStore = files.purposeStore("estimator.photo");
  const FILES_MOVE_TO_PRIVATE = ["library.file", "estimator.photo"];

  // --- src/server/scheduling-notify.ts (companies, with alerts) ----------------------------
  const REMINDER_RUNS = { dailyAtUtc: "14:00" } as const;
  const schedulingListener = schedulingComms.createSchedulingCommsListener({
    db,
    senders: commsSenders,
    company: (tenantId: string) => tenancy.companyProfile(tenantId),
    manageUrl: async (token: string, tenantId: string) => (await companyLinks(tenantId)).manageVisit(token),
    bookUrl: async (tenantId: string) => (await companyLinks(tenantId)).bookVisit(),
    adminUrl: async (tenantId: string) => (await companyLinks(tenantId)).app("/app/schedule"),
    // Read ONLY when the claim below throws (review BO-02).
    staffEmails: async (tenantId: string) => (await tenancy.companyProfile(tenantId))?.inbox ?? [],
    officeRecipients: (notice: Any) => officeRecipientsFor(notice),
    officeSent: (notice: Any, result: Any) => officeSentFor(notice, result),
    reminderRuns: REMINDER_RUNS,
    now,
    onError: (error: unknown, context: { step: string }) => void failures.push({ where: `scheduling-comms:${context.step}`, error }),
  });
  /** The last event handed to the listeners, for /__test/replay-last-event (a retried delivery). */
  let lastEvent: { kind: "scheduling" | "estimator"; event: Any } | null = null;
  const SCHEDULING_LISTENERS = [(event: Any) => alertOnSchedulingEvent(event), (event: Any) => schedulingListener.onEvent(event)];
  const onSchedulingEvent = async (event: Any) => {
    lastEvent = { kind: "scheduling", event };
    for (const listener of SCHEDULING_LISTENERS) {
      try {
        await listener(event);
      } catch (error) {
        failures.push({ where: "scheduling:listener", error });
      }
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
    alertsHref: "/app/alerts/settings",
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
        await scheduling.updateSchedulingSettings(tx, tenantId, schedulingConfig.firstSchedulingSettings({ timeZone: profile.timeZone ?? undefined, businessName: profile.name }));
      }
    });
    await schedulingListener.ensureTemplates(tenantId);
  }
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
    onEvent: (event: Any) => alertOnInvoicingEvent(event),
    onError: report("invoicing:admin"),
    now,
  });
  const invoicingPublic = invoicing.createInvoicingHandlers({
    db,
    resolveTenant: resolvePublicTenant,
    admit: admitPublic,
    business: invoicingBusiness,
    onEvent: (event: Any) => alertOnInvoicingEvent(event),
    onError: report("invoicing:public"),
    now,
  });
  const setupInvoicingFor = (tenantId: string) => invoicingListener.ensureTemplates(tenantId);
  async function overdueInvoiceAlerts(tenantId: string, at: Date) {
    const business = invoicing.resolveInvoicingBusiness(await invoicingBusiness(tenantId));
    const format = { currency: business.currency, locale: business.locale, timeZone: business.timeZone };
    const due = await invoicing.listOverdueInvoices(db, tenantId, { now: at, timeZone: business.timeZone });
    return due.map((invoice: Any) => invoicing.invoicingOverdueAlert(tenantId, invoice, { hrefs: { invoice: ALERT_HREFS.invoice }, format }));
  }

  // --- src/server/estimator-notify.ts, estimator-services.ts and estimator.ts ---------
  const estimatorListener = estimatorComms.createEstimatorCommsListener({
    db,
    senders: commsSenders,
    company: (tenantId: string) => tenancy.companyProfile(tenantId),
    quoteUrl: async (token: string, tenantId: string) => (await companyLinks(tenantId)).quote(token),
    adminEstimateUrl: async (estimateId: string, tenantId: string) => (await companyLinks(tenantId)).app(`/app/estimates/${encodeURIComponent(estimateId)}`),
    bookUrl: async (estimate: { id: string }, tenantId: string) => (await companyLinks(tenantId)).bookVisit(estimate.id),
    staffEmails: async (tenantId: string) => (await tenancy.companyProfile(tenantId))?.inbox ?? [],
    officeRecipients: (notice: Any) => officeRecipientsFor(notice),
    officeSent: (notice: Any, result: Any) => officeSentFor(notice, result),
    followUpRuns: { dailyAtUtc: "14:00" },
    now,
    onError: (error: unknown, context: { step: string }) => void failures.push({ where: `estimator-comms:${context.step}`, error }),
  });
  const ESTIMATOR_LISTENERS = [(event: Any) => alertOnEstimatorEvent(event), (event: Any) => estimatorListener.onEvent(event)];
  const onEstimatorEvent = async (event: Any) => {
    lastEvent = { kind: "estimator", event };
    for (const listener of ESTIMATOR_LISTENERS) {
      try {
        await listener(event);
      } catch (error) {
        failures.push({ where: "estimator:listener", error });
      }
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
    const [row] = await db.select({ id: t.id, number: t.invoiceNumber, status: t.status }).from(t).where(and(eq(t.tenantId, tenantId), eq(t.estimateId, estimateId))).limit(1);
    return row ? { id: row.id, number: row.number, status: row.status, url: `/app/invoices/${encodeURIComponent(row.id)}` } : null;
  };
  const convertEstimateToInvoice = async (input: { tenantId: string; estimateId: string; userId: string | null }) => {
    const found = await estimator.getEstimate(db, input.tenantId, input.estimateId);
    if (!found) throw new estimator.EstimatorInputError("transition_not_allowed", "This estimate can't be invoiced.");
    const business = await invoicingBusiness(input.tenantId);
    const dueDate = business ? dueDateFor(business, now()) : null;
    try {
      return await db.transaction(async (tx: Any) => {
        const invoice = await invoicing.createInvoice(tx, { tenantId: input.tenantId, ...invoicing.invoiceInputFromEstimate(found.estimate, found.items), dueDate }, input.userId ?? undefined);
        const claimed = await estimator.markEstimateConverted(tx, input.tenantId, input.estimateId);
        if (!claimed) throw new estimator.EstimatorInputError("transition_not_allowed", "Only an accepted quote can become an invoice, and only once.");
        return { id: invoice.id, number: invoice.invoiceNumber, status: "draft", url: `/app/invoices/${encodeURIComponent(invoice.id)}` };
      });
    } catch (error) {
      if (error instanceof invoicing.InvoicingError) throw new estimator.EstimatorInputError("transition_not_allowed", (error as Error).message);
      throw error;
    }
  };
  const estimatorDelivery = () => estimatorConfig.estimatorDeliveryStatus({ commsInstalled: true, emailConfigured: mailer.configured, cronSecretSet: true, audience: "company" });
  const estimatorShared = {
    db,
    company: estimatorCompany,
    aiBudgetCeilingCents: estimatorConfig.ESTIMATOR_AI_CEILING_CENTS,
    onEvent: onEstimatorEvent,
    // Tenancy 2b-1: the customer's photo is one of the company's private files.
    photoStore: estimatorPhotoStore,
    now,
  };
  const estimatorPublicShared = { ...estimatorShared, aiSiteBudgetCents: estimatorConfig.ESTIMATOR_AI_SITE_CEILING_CENTS };
  const estimatorAdmin = estimator.createEstimatorAdminHandlers({
    ...estimatorShared,
    // Staff's own photos apart from customers' (review SEC-02).
    staffPhotoStore: files.purposeStore("estimator.staff-photo"),
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
    invoiceAccess: (req: Request, need: "view" | "manage", tenantId: string) => companyAuthorizer(req, need === "manage" ? "invoices.manage" : "invoices.view", tenantId),
    embedBaseUrl: `${origin}/api/estimator`,
    alertsHref: "/app/alerts/settings",
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

  // --- src/server/alerts-routes.ts and files-routes.ts ---------------------------------
  const slugs = new Map<string, string | null>();
  const alertsAdmin = notificationsPkg.createNotificationHandlers({
    notifications: alerts,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer,
    links: { inbox: "/app/alerts", settings: "/app/alerts/settings", messages: "/app/messages" },
    // Through the switch route (review G16), so an alert of Green Acres opens in Green Acres.
    hrefFor: async (tenantId: string, href: string) => {
      if (!slugs.has(tenantId)) slugs.set(tenantId, (await tenancy.companyProfile(tenantId))?.slug ?? null);
      const slug = slugs.get(tenantId);
      return slug ? `/app/switch/${encodeURIComponent(slug)}?${new URLSearchParams({ next: href }).toString()}` : href;
    },
    onError: report("alerts:route"),
    now,
  });
  const filesAdmin = storagePkg.createStorageHandlers({
    storage: files,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer,
    names: async (tenantId: string, userIds: readonly string[]) => {
      const wanted = new Set(userIds);
      const out = new Map<string, string>();
      for (const person of await tenancy.listMemberPeople(tenantId)) {
        if (wanted.has(person.userId)) out.set(person.userId, person.name ?? person.email ?? "Someone");
      }
      return out;
    },
    companyName: async (tenantId: string) => (await tenancy.companyProfile(tenantId))?.name ?? null,
    logoSettings: "company settings",
    rateLimit: () => true,
    onError: report("files:route"),
    now,
  });
  const fileLinks = storagePkg.createStorageLinkHandlers({ storage: files, onError: report("files:link") });

  // --- src/server/company-setup.ts --------------------------------------------------------
  const SETUPS: readonly { name: string; run: (tenantId: string) => Promise<unknown> }[] = [
    { name: "scheduling", run: setupSchedulingFor },
    { name: "estimator", run: setupEstimatorFor },
    { name: "invoicing", run: setupInvoicingFor },
    { name: "alerts", run: (tenantId) => ensureTeamAlertTemplate(tenantId) },
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
    // Tenancy 2b-1: the team's alerts, and the housekeeping after a removal.
    await alertOnTenancyEvent(event);
  };
  async function linkNewCrewMember(tenantId: string, userId: string): Promise<void> {
    const person = (await tenancy.listMemberPeople(tenantId)).find((p: Any) => p.userId === userId);
    if (!person || person.roleKey !== scheduling.SCHEDULING_CREW_ROLE.key) return;
    const crews = await scheduling.listResources(db, tenantId);
    if (crews.some((crew: Any) => crew.userId !== null && String(crew.userId) === userId)) return;
    if (crews.length !== 1 || crews[0].userId !== null) return;
    await scheduling.updateResource(db, tenantId, crews[0].id, { userId });
  }

  // --- app/api/cron/* ---------------------------------------------------------------------
  async function runCron(name: "scheduling" | "estimator" | "comms" | "alerts" | "files"): Promise<Any> {
    if (name === "scheduling") {
      return tenancyServer.runForEachCompany(
        tenancy,
        async (tenantId: string) => {
          await syncSchedulingCompany(tenantId);
          return (await scheduling.expirePendingRequests(db, tenantId, { onEvent: onSchedulingEvent, now: now() })).expired;
        },
        { timeBudgetMs: 45_000, now },
      );
    }
    if (name === "estimator") {
      const quotes = await tenancyServer.runForEachCompany(
        tenancy,
        async (tenantId: string) => estimator.expireQuotes(db, tenantId, { onEvent: onEstimatorEvent, now: now(), timeBudgetMs: 5_000 }),
        { timeBudgetMs: 35_000, now },
      );
      const photos = await estimator.purgeOrphanPhotos(db, estimatorPhotoStore, { now: now(), timeBudgetMs: 15_000 });
      return { ...quotes, photosDeleted: photos.deleted, photosNotDeleted: photos.failed };
    }
    if (name === "alerts") {
      // app/api/cron/alerts/route.ts: the clock's alerts for every active company,
      // the waiting emails (companies taking turns), then the clean-up.
      const sweeps = await tenancyServer.runForEachCompany(
        tenancy,
        async (tenantId: string) => {
          const at = now();
          const drafts: Any[] = [];
          for (const request of await scheduling.listExpiringRequests(db, tenantId, { now: at })) {
            drafts.push(scheduling.schedulingExpiringAlert(tenantId, request, { hrefs: { visit: ALERT_HREFS.visit } }));
          }
          drafts.push(...(await overdueInvoiceAlerts(tenantId, at)));
          const report = await notify(drafts);
          return { alerted: report.alerted };
        },
        { timeBudgetMs: 30_000, now },
      );
      const emails = await alerts.deliverPendingEmails({ tenantIds: await tenancy.activeCompanyIds(), limit: 1000, timeBudgetMs: 15_000 });
      const cleanup = await alerts.cleanup({ timeBudgetMs: 5_000 });
      return { sweeps, emails, cleanup };
    }
    if (name === "files") {
      const purged = await files.purgeDeleted({ timeBudgetMs: 30_000 });
      const moved: Any[] = [];
      for (const purpose of FILES_MOVE_TO_PRIVATE) moved.push({ purpose, ...(await files.moveToPrivate({ purpose, timeBudgetMs: 10_000 })) });
      const privateStore = await files.checkPrivateStore();
      return { purged, moved, privateStore };
    }
    try {
      const tenantIds = await tenancy.activeCompanyIds();
      return await comms.runDueMessages(db, commsSenders, { tenantIds, timeBudgetMs: 45_000, beforeSend: commsBeforeSend, now: now() });
    } finally {
      await afterCommsRun();
    }
  }

  async function replayLastEvent(): Promise<{ replayed: string | null }> {
    if (!lastEvent) return { replayed: null };
    const { kind, event } = lastEvent;
    if (kind === "scheduling") await onSchedulingEvent(event);
    else await onEstimatorEvent(event);
    return { replayed: `${kind}:${event.type}` };
  }

  /** The outbox, each email's comms template read back from the delivery log (to + subject). */
  async function outboxWithKeys(): Promise<SentMail[]> {
    const rows = await query<{ to_address: string; subject: string | null; template_key: string | null }>(
      "select to_address, subject, template_key from comms_messages where status = 'sent' order by created_at, id",
    );
    const used = new Set<number>();
    return outbox.map((mail) => {
      const index = rows.findIndex((row, i) => !used.has(i) && row.to_address === mail.to && row.subject === mail.subject);
      if (index >= 0) used.add(index);
      return { ...mail, templateKey: index >= 0 ? rows[index]!.template_key : null };
    });
  }

  /** Both stores as they are. Under `private-as-public` the private files ARE in the public store, so they show as public. */
  function blobs(): StoredBlob[] {
    const list: StoredBlob[] = [];
    if (options.break !== "private-as-public") {
      for (const [key, value] of privateMemory.objects) list.push({ key, access: "private", size: value.bytes.byteLength });
    }
    for (const [key, value] of publicMemory.objects) list.push({ key, access: "public", size: value.bytes.byteLength });
    return list;
  }

  // --- the pages ------------------------------------------------------------------------
  const widgets = await buildTarget(tenancy2b1ScenarioTarget, { write: false });

  type Gate = { redirect: string } | { html: string } | { cfg: Record<string, unknown>; company: Any; who: { userId: string; email: string } };

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
    const links = APP_LINKS.filter((link) => (link.audience !== "staff" || isStaff) && (link.permission === undefined || can.includes(link.permission))).map(({ href, label }) => ({ href, label }));
    const base = { session: wire, company, can, email: who.email, links };
    if (permission !== undefined && !can.includes(permission)) {
      return { html: page({ ...base, mode: "no-access" }, "You don't have access to this page") };
    }
    return { cfg: base, company, who };
  }

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

  const APP_PAGES: { pattern: RegExp; mode: string; permission?: string; title: string; props?: (m: RegExpExecArray, url: URL, company: Any) => Record<string, unknown> }[] = [
    {
      pattern: /^\/app\/schedule$/,
      mode: "schedule",
      permission: "schedule.view",
      title: "Schedule",
      props: (_m, url, company) => ({
        bookingPageUrl: companyLinksFor(company.slug, origin).bookVisit(),
        initialDate: /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date") ?? "") ? url.searchParams.get("date") : undefined,
        initialVisitId: /^[A-Za-z0-9_-]{1,128}$/.test(url.searchParams.get("visit") ?? "") ? url.searchParams.get("visit") : undefined,
        visitFilesHref: VISIT_FILES_HREF,
      }),
    },
    { pattern: /^\/app\/schedule\/today$/, mode: "today", permission: "schedule.route", title: "Today's route", props: () => ({ filesHref: VISIT_FILES_HREF }) },
    // The visit's own photos and files: the record's permissions decide (no gate key).
    { pattern: /^\/app\/schedule\/visits\/([^/]+)\/files$/, mode: "visit-files", title: "Photos and files", props: (m) => ({ visitId: decodeURIComponent(m[1]!) }) },
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
    { pattern: /^\/app\/alerts$/, mode: "alerts", permission: "alerts.view", title: "Alerts" },
    { pattern: /^\/app\/alerts\/settings$/, mode: "alert-settings", permission: "alerts.view", title: "Alert settings" },
    { pattern: /^\/app\/files$/, mode: "files", permission: "files.view", title: "Files", props: () => ({ platformName: PLATFORM_NAME, supportEmail: SUPPORT_EMAIL }) },
  ];

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
        const privateApi = /^\/api\/app\/[^/]+\/(schedule|estimator|invoices|messages|alerts|files)\//.exec(path);
        if (privateApi) {
          const handler = { schedule: schedulingAdmin, estimator: estimatorAdmin, invoices: invoicingAdmin, messages: commsAdmin, alerts: alertsAdmin, files: filesAdmin }[
            privateApi[1] as "schedule"
          ];
          const response = await handler.handle(await toRequest(rawReq, origin));
          // tenancy's handlers wait for their listeners (2b-1); a feature route
          // that changed the team or a company leaves nothing in flight either.
          await tenancy.settleEvents?.();
          return await send(res, response);
        }
        const publicApi = /^\/api\/t\/[^/]+\/(schedule|estimator|invoices)\//.exec(path);
        if (publicApi) {
          const handler = { schedule: schedulingPublic, estimator: estimatorPublic, invoices: invoicingPublic }[publicApi[1] as "schedule"];
          return await send(res, await handler.handle(await toRequest(rawReq, origin)));
        }
        if (path.startsWith("/api/estimator/")) return await send(res, await estimatorEmbed.handle(await toRequest(rawReq, origin)));
        // Signed links and public files, for anyone (app/api/files/[...path]/route.ts).
        if (path.startsWith("/api/files/")) return await send(res, await fileLinks.handle(await toRequest(rawReq, origin)));

        // --- the test's own doors ------------------------------------------------------
        if (path === "/widgets.js") {
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
          return res.end(widgets);
        }
        // The PUBLIC store, as its CDN would serve it. Never the private one.
        if (path.startsWith("/__blob/")) {
          const key = decodeURIComponent(path.slice("/__blob/".length));
          const found = publicMemory.objects.get(key);
          if (!found) {
            res.writeHead(404, { "content-type": "text/plain" });
            return res.end("not found");
          }
          res.writeHead(200, { "content-type": found.contentType, "cache-control": "public, max-age=31536000" });
          return res.end(Buffer.from(found.bytes));
        }
        if (path === "/__test/blobs") return json(blobs());
        if (path === "/__test/outbox") return json(await outboxWithKeys());
        if (path === "/__test/clock" && rawReq.method === "POST") {
          const at = new Date(url.searchParams.get("at") ?? "");
          if (Number.isNaN(at.getTime())) return json({ error: "at must be an ISO time" }, 400);
          setClock(at);
          return json({ now: now().toISOString() });
        }
        const cron = /^\/__test\/cron\/(scheduling|estimator|comms|alerts|files)$/.exec(path);
        if (cron && rawReq.method === "POST") return json(await runCron(cron[1] as "scheduling"));
        if (path === "/__test/replay-last-event" && rawReq.method === "POST") return json(await replayLastEvent());
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
          const cards = t1.mode === "dashboard" ? (verdict.cfg.links as { href: string; label: string }[]).filter((l) => l.href !== "/dashboard" && l.href !== "/admin") : undefined;
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
          const title = publicPage.title ? `${publicPage.title} · ${company.name}` : company.name;
          return html(page({ mode: publicPage.mode, publicCompany: company, ...(publicPage.props?.(m, url) ?? {}) }, title, publicPage.meta));
        }

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
    outbox: outboxWithKeys,
    invitations,
    failures,
    now,
    setClock,
    query,
    companyId: async (slug: string) => (await tenancy.resolvePublicCompany(slug))?.company.id ?? null,
    blobs,
    runCron,
    replayLastEvent,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await testDb.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  } satisfies Tenancy2b1ScenarioServer;
}
