import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * The fixture behind e2e/tests/tenancy-scenario.spec.ts (contract 13.8): a
 * REAL companies backend — @adminigloo/tenancy 0.4's service and both HTTP
 * handlers, the permissions package's loaders and seed, on a real Postgres
 * (PGlite, from @adminigloo/testing/pglite) holding the auth, tenancy,
 * permissions and observability tables — serving the REAL screens, bundled from
 * @adminigloo/tenancy-widget's source, at the paths a generated project uses:
 *
 *   /onboarding                  <Onboarding>          (overlays/companies)
 *   /dashboard                   <SetupChecklist>      (overlays/companies)
 *   /settings/company            <CompanySettings>     (overlays/companies)
 *   /settings/team               <TeamManager>         (template)
 *   /invite/:token               <AcceptInvitation>    (template)
 *   /admin/companies[/:id]       <CompaniesConsole> / <CompanyDetail>
 *   /admin/people                <StaffPeople>
 *   /api/tenancy/*               createTenancyHandlers
 *   /api/admin/tenancy/*         createTenancyOperatorHandlers
 *
 * Every company page has the header switcher (<CompanySwitcher session>), in
 * the same flex row create-app's AuthHeader puts it in, so the phone-width
 * checks measure the real thing.
 *
 * WIRED THE WAY create-app WIRES IT (src/server/tenancy.ts,
 * src/server/tenancy-handlers.ts, src/components/CompanyGate.tsx,
 * app/admin/layout.tsx). What a test has to own instead:
 *
 *   - SIGN-IN is a fake identity, no Clerk: `/__test/sign-in?email&name&via`
 *     sets an `e2e-user` cookie. `via=webhook` writes the user row and calls
 *     `provisionUser`, as the Clerk webhook does; `via=page` leaves the row to
 *     the first request, which mirrors it and provisions it, as
 *     `currentPrincipal` does. The cookie's address counts as verified.
 *   - EMAIL: `deliverInvitation` records `{ to, url }` in `outbox`
 *     (`GET /__test/outbox`).
 *   - LOGOS live in memory and are served at `/__test/logos/:key`.
 *   - BOOTSTRAP: `BOOTSTRAP_ADMIN_EMAIL` is `ava@igloo.test`.
 *   - A LOST ANSWER: the first company-create's answer — once for onboarding,
 *     once for "Create another" — is dropped after the company was saved (a
 *     502). By default (`lostAnswer: "retry"`) the connection stays flaky:
 *     the page's check of the session fails once too, and the company is aged
 *     past the server's 10-minute same-name window, so the person's retry is a
 *     real second request that only the form's request key turns into a
 *     replay. With `lostAnswer: "check"` the session answers, and the page
 *     finds the company it just made (review R2 T1BO-01).
 *
 * NEGATIVE CONTROLS live HERE, never in the packages (contract 13.8):
 *
 *   - `break: "fresh-key"` mounts <Onboarding> with a transport that mints a
 *     new request key on every create — the retry after a lost answer (outside
 *     the server's same-name window, see above) then makes a second company,
 *     and the spec's "exactly one" assertion must fail;
 *   - `break: "cached-gate"` renders company pages from the session computed
 *     at sign-in instead of resolving it per request — a removed member then
 *     keeps seeing the company, and the spec's "loses access" assertion must
 *     fail.
 *
 * Everything is imported from the BUILT packages (dist), so build them first.
 */

const here = dirname(fileURLToPath(import.meta.url));
const e2eRoot = join(here, "..");
const repo = join(e2eRoot, "..");
const pkg = (name: string, file: string) => pathToFileURL(join(repo, "packages", name, "dist", file)).href;
const widgetSrc = join(repo, "packages", "tenancy-widget", "src");

/* eslint-disable @typescript-eslint/no-explicit-any -- the packages are imported by path at runtime */
type Any = any;

export const BOOTSTRAP_ADMIN_EMAIL = "ava@igloo.test";
export const SUPPORT_EMAIL = "help@igloo.test";

export interface SentInvitation {
  to: string;
  url: string;
}

export interface TenancyScenarioServer {
  origin: string;
  outbox: SentInvitation[];
  /** Raw SQL against the scenario database. */
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  close: () => Promise<void>;
}

export interface TenancyScenarioOptions {
  break?: "fresh-key" | "cached-gate";
  /** How a lost create answer plays out (see the header). Default "retry". */
  lostAnswer?: "retry" | "check";
}

/** The host page: one widget per page, with server-computed props, as the emitted pages render them. */
const HOST_APP = `
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  AcceptInvitation, CompanySettings, CompanySuspended, CompanySwitcher, Onboarding, SetupChecklist, TeamManager,
  createTenancyClient, mintRequestKey,
} from ${JSON.stringify(join(widgetSrc, "index.ts").replace(/\\/g, "/"))};
import { CompaniesConsole, CompanyDetail, StaffPeople } from ${JSON.stringify(join(widgetSrc, "admin", "index.ts").replace(/\\/g, "/"))};

const cfg = window.__page;
const API = "/api/tenancy";
const ADMIN_API = "/api/admin/tenancy";

// The fresh-key negative control: a transport that forgets the form's request
// key and mints a new one on every create.
function freshKeyTransport() {
  const base = createTenancyClient({ baseUrl: API });
  return { ...base, createCompany: (body) => base.createCompany({ ...body, requestKey: mintRequestKey() }) };
}

function Header() {
  if (!cfg.session) return null;
  return (
    <header className="e2e-header">
      <a href="/" className="e2e-brand">Igloo Back Office</a>
      <div className="e2e-right">
        <CompanySwitcher session={cfg.session} baseUrl={API} reloadHref="/dashboard" />
        <details className="e2e-menu"><summary>Menu</summary><a href="/settings/team">Team</a></details>
        <span className="e2e-avatar" aria-hidden="true">{(cfg.email || "?").slice(0, 1).toUpperCase()}</span>
      </div>
    </header>
  );
}

function Body() {
  switch (cfg.mode) {
    case "onboarding":
      return <Onboarding initialSession={cfg.session} purpose={cfg.another ? "additional" : "onboarding"}
        {...(cfg.freshKey ? { transport: freshKeyTransport() } : { baseUrl: API })}
        publicUrlPrefix={location.origin + "/t/"} afterHref="/dashboard" staffConsoleHref={cfg.staffConsoleHref} />;
    case "dashboard":
      return <><h1>{cfg.company.name}</h1><SetupChecklist baseUrl={API} tenantId={cfg.company.id} /></>;
    case "team":
      return <><h1>Team</h1><TeamManager baseUrl={API} tenantId={cfg.company.id} afterLeaveHref="/dashboard" /></>;
    case "settings":
      return <><h1>Company settings</h1><CompanySettings baseUrl={API} tenantId={cfg.company.id} publicUrlPrefix={location.origin + "/t/"} /></>;
    case "suspended":
      return <CompanySuspended companyName={cfg.companyName} companies={cfg.companies} baseUrl={API} supportEmail={cfg.supportEmail} />;
    case "invite":
      return <AcceptInvitation baseUrl={API} token={cfg.token} signedInAs={cfg.email} afterHref="/dashboard" signOutHref="/__test/sign-out" />;
    case "admin-companies":
      return <><h1>Companies</h1><CompaniesConsole baseUrl={ADMIN_API} detailHref="/admin/companies/{id}" defaultKind="org" /></>;
    case "admin-company":
      return <CompanyDetail baseUrl={ADMIN_API} tenantId={cfg.tenantId} backHref="/admin/companies" />;
    case "admin-people":
      return <><h1>People</h1><StaffPeople baseUrl={ADMIN_API} /></>;
    default:
      return <p>{cfg.text}</p>;
  }
}

createRoot(document.getElementById("root")).render(<StrictMode><Header /><main><Body /></main></StrictMode>);
`;

/** create-app's header row: flex, wrapping, space-between, 24px gutters; the right cluster shrinks. */
const PAGE_CSS = `
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,sans-serif}
.e2e-header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 24px;padding:12px 24px;border-bottom:1px solid #ddd}
.e2e-brand{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#555;text-decoration:none}
.e2e-right{display:flex;align-items:center;gap:12px;min-width:0;max-width:100%}
.e2e-menu summary{display:flex;align-items:center;min-height:44px;padding:0 12px;border:1px solid #ccc;border-radius:4px;cursor:pointer;list-style:none}
.e2e-menu a{display:flex;min-height:44px;align-items:center;padding:0 12px}
.e2e-avatar{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:#333;color:#fff;font-size:12px;flex:none}
main{padding:16px 24px;max-width:960px;margin:0 auto}
h1{font-size:20px}
`;

async function bundleWidgets(): Promise<string> {
  const result = await build({
    stdin: { contents: HOST_APP, resolveDir: e2eRoot, sourcefile: "tenancy-scenario-host.tsx", loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    alias: {
      react: join(e2eRoot, "node_modules", "react"),
      "react-dom": join(e2eRoot, "node_modules", "react-dom"),
    },
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    logLevel: "silent",
  });
  return result.outputFiles[0]!.text;
}

function page(cfg: Record<string, unknown>, title: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${PAGE_CSS}</style></head>` +
    `<body><div id="root"></div>` +
    `<script>window.__page=${JSON.stringify(cfg).replace(/</g, "\\u003c")}</script><script src="/widgets.js"></script></body></html>`
  );
}

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

function cookieOf(req: { headers: { cookie?: string | undefined } } | Request, name: string): string | null {
  const raw = req instanceof Request ? req.headers.get("cookie") : req.headers.cookie;
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(raw ?? "");
  return match ? decodeURIComponent(match[1]!) : null;
}

export async function startTenancyScenarioServer(options: TenancyScenarioOptions = {}): Promise<TenancyScenarioServer> {
  const tenancyServer: Any = await import(pkg("tenancy", "server.js"));
  const tenancyRoot: Any = await import(pkg("tenancy", "index.js"));
  const tenancySchema: Any = await import(pkg("tenancy", "schema.js"));
  const authSchema: Any = await import(pkg("auth", "schema.js"));
  const permissionsRoot: Any = await import(pkg("permissions", "index.js"));
  const permissionsServer: Any = await import(pkg("permissions", "server.js"));
  const permissionsSchema: Any = await import(pkg("permissions", "schema.js"));
  const observability: Any = await import(pkg("observability", "index.js"));
  const observabilitySchema: Any = await import(pkg("observability", "schema.js"));
  const { createPgliteDb }: Any = await import(pkg("testing", "pglite.js"));

  // --- the database -------------------------------------------------------------
  const schema = {
    ...authSchema.authSchema,
    ...tenancySchema.tenancySchema,
    ...permissionsSchema.permissionsSchema,
    auditLog: observabilitySchema.auditLog,
  };
  const testDb = await createPgliteDb({ schema, logQueries: false });
  const db = testDb.db;
  const client = testDb.client;

  // --- the catalogs, as the generated src/permissions/catalog.ts declares them ---
  const tenantCatalog = permissionsRoot.definePermissions("tenant", { ...tenancyRoot.tenancyPermissions });
  const staffCatalog = permissionsRoot.definePermissions(
    "staff",
    Object.fromEntries(
      tenancyRoot.TENANCY_STAFF_PERMISSION_KEYS.map((key: string) => [
        key,
        {
          label: key,
          // Exactly the generated catalog's defaults (review R2 T1BO-05: this
          // gave cs_agent staff.people.view, which no generated project does).
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
  // The deploy seed (pnpm db:seed:deploy).
  await permissionsServer.seedPermissionCatalog(db, {
    staff: { catalog: staffCatalog, templates: permissionsRoot.STAFF_ROLE_TEMPLATES },
    tenant: { catalog: tenantCatalog, templates: tenancyRoot.TENANT_ROLE_TEMPLATES },
  });

  // --- the seams ------------------------------------------------------------------
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
  let origin = "";
  const logoStore = {
    put: async ({ pathname, bytes, contentType }: { pathname: string; bytes: Uint8Array; contentType: string }) => {
      logos.set(pathname, { bytes, contentType });
      return { url: `${origin}/__test/logos/${encodeURIComponent(pathname)}`, key: pathname };
    },
    delete: async (key: string) => {
      logos.delete(key);
    },
  };

  const tenancy = tenancyServer.createTenancyService({
    db,
    mode: "companies",
    tenantCatalog,
    noun: { singular: "company", plural: "companies" },
    settings: tenancyRoot.defineTenantSettings([tenancyRoot.companySettings]),
    checklist: tenancyRoot.defineSetupChecklist([...tenancyServer.tenancyChecklistItems()]),
    bootstrap: { mode: "email", email: BOOTSTRAP_ADMIN_EMAIL },
    logos: logoStore,
    reservedSlugs: ["igloo-back-office", "igloo"],
    audit: auditSink,
    onEventError: (error: unknown) => console.error("tenancy event listener failed", error),
  });
  const loaders = permissionsServer.createDrizzlePermissionLoaders(db, { membership: tenancyServer.tenancyMembershipGate });

  // --- the fake identity provider ------------------------------------------------
  const names = new Map<string, string>();
  const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await client.query(sql, params)).rows as T[];

  /** The webhook's write: the row, then provisioning. */
  async function webhookCreates(email: string, name: string): Promise<void> {
    const [row] = await db
      .insert(authSchema.users)
      .values({ externalId: `ext_${email}`, email, displayName: name || null })
      .onConflictDoNothing()
      .returning();
    if (row) await tenancy.provisionUser({ userId: row.id, email });
  }

  /** currentPrincipal: find the row, mirror it if missing, provision it if unstamped. */
  async function principalFor(email: string | null): Promise<{ userId: string; email: string } | null> {
    if (!email) return null;
    let rows = await query<{ id: string; provisioned_at: unknown; deleted_at: unknown }>(
      "select id, provisioned_at, deleted_at from users where external_id = $1",
      [`ext_${email}`],
    );
    if (rows.length === 0) {
      await db
        .insert(authSchema.users)
        .values({ externalId: `ext_${email}`, email, displayName: names.get(email) ?? null })
        .onConflictDoNothing();
      rows = await query("select id, provisioned_at, deleted_at from users where external_id = $1", [`ext_${email}`]);
    }
    const row = rows[0];
    if (!row || row.deleted_at) return null;
    if (row.provisioned_at === null) await tenancy.provisionUser({ userId: row.id, email });
    return { userId: row.id, email };
  }

  const principal = async (req: Request) => principalFor(cookieOf(req, "e2e-user"));
  const verifiedEmails = async (req: Request) => {
    const email = cookieOf(req, "e2e-user");
    return email ? [email] : [];
  };

  // --- the handlers, as src/server/tenancy-handlers.ts builds them ---------------
  const outbox: SentInvitation[] = [];
  const handlers = tenancyServer.createTenancyHandlers({
    tenancy,
    principal,
    verifiedEmails,
    invitationUrl: (token: string) => `${origin}/invite/${encodeURIComponent(token)}`,
    deliverInvitation: async (input: { to: string; url: string }) => {
      outbox.push({ to: input.to, url: input.url });
      return { status: "sent" };
    },
    onError: (error: unknown) => console.error("tenancy route failed", error),
  });
  const operator = tenancyServer.createTenancyOperatorHandlers({
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
    onError: (error: unknown) => console.error("operator route failed", error),
  });

  const lostAnswers = new Set<string>();
  /** After a lost answer in "retry" mode: the next session check fails too. */
  let flakySessions = 0;

  // The cached-gate negative control: the session as it was at sign-in.
  const cachedSessions = new Map<string, Any>();

  const widgets = await bundleWidgets();

  /** CompanyGate (src/components/CompanyGate.tsx), as a function of the request. */
  async function gate(req: Request, path: string): Promise<{ redirect: string } | { html: string } | { session: Any; company: Any; who: { userId: string; email: string } }> {
    const who = await principal(req);
    if (!who) return { redirect: `/sign-in?redirect_url=${encodeURIComponent(path)}` };
    let session: Any;
    if (options.break === "cached-gate" && cachedSessions.has(who.email)) session = cachedSessions.get(who.email);
    else {
      session = await tenancy.resolveSession({ userId: who.userId });
      if (options.break === "cached-gate") cachedSessions.set(who.email, session);
    }
    if (session.state === "needs-onboarding") {
      const isStaff = (await loaders.loadStaffPermissions({ principal: who })) !== null;
      return { redirect: isStaff ? "/admin/companies" : "/onboarding" };
    }
    const wire = tenancyServer.sessionToWire(session);
    if (session.state === "suspended") {
      return {
        html: page(
          { mode: "suspended", session: wire, email: who.email, companyName: session.company.name, companies: wire.companies, supportEmail: SUPPORT_EMAIL },
          `${session.company.name} is suspended`,
        ),
      };
    }
    return { session: wire, company: wire.company, who };
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

  const server: Server = createServer((rawReq, res) => {
    void (async () => {
      const url = new URL(rawReq.url ?? "/", origin);
      const path = url.pathname;
      const redirect = (to: string) => {
        res.writeHead(302, { location: to, "cache-control": "no-store" });
        res.end();
      };
      const html = (body: string) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(body);
      };
      try {
        if (path.startsWith("/api/admin/tenancy/")) return await send(res, await operator.handle(await toRequest(rawReq, origin)));
        if (path.startsWith("/api/tenancy/")) {
          const apiReq = await toRequest(rawReq, origin);
          const creating = rawReq.method === "POST" && path === "/api/tenancy/v1/companies";
          const purpose = creating
            ? String(((await apiReq.clone().json().catch(() => ({}))) as { purpose?: unknown }).purpose ?? "onboarding")
            : "";
          const answer = await handlers.handle(apiReq);
          // THE FIRST CREATE'S ANSWER IS LOST on the way back — after the
          // company was saved — the way a dropped mobile connection loses it:
          // once for onboarding, once for "Create another". The person presses
          // again; the form's request key must make that a replay of the same
          // company, never a second one.
          if (creating && answer.ok && !lostAnswers.has(purpose)) {
            lostAnswers.add(purpose);
            if ((options.lostAnswer ?? "retry") === "retry") {
              // Still flaky, and the retry comes later than the server's
              // same-name window: only the request key can make it a replay.
              const made = (await answer.clone().json()) as { company?: { id?: string } };
              if (made.company?.id) await query("update tenants set created_at = now() - interval '1 hour' where id = $1", [made.company.id]);
              flakySessions += 1;
            }
            res.writeHead(502, { "content-type": "text/plain" });
            return res.end("bad gateway");
          }
          if (rawReq.method === "GET" && path === "/api/tenancy/v1/session" && flakySessions > 0) {
            flakySessions -= 1;
            res.writeHead(502, { "content-type": "text/plain" });
            return res.end("bad gateway");
          }
          return await send(res, answer);
        }
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
        if (path === "/__test/outbox") {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify(outbox));
        }
        if (path === "/__test/sign-in") {
          const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
          const name = url.searchParams.get("name") ?? "";
          const next = url.searchParams.get("next") || "/dashboard";
          names.set(email, name);
          if (url.searchParams.get("via") === "webhook") await webhookCreates(email, name);
          res.writeHead(302, {
            location: next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard",
            "set-cookie": `e2e-user=${encodeURIComponent(email)}; Path=/; HttpOnly; SameSite=Lax`,
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
              {
                mode: "onboarding",
                session: tenancyServer.sessionToWire(session),
                email: who.email,
                another,
                freshKey: options.break === "fresh-key",
                staffConsoleHref: isStaff ? "/admin/companies" : null,
              },
              "Set up your company",
            ),
          );
        }

        const invite = /^\/invite\/([^/]+)$/.exec(path);
        if (invite) {
          const who = await principal(req);
          const token = decodeURIComponent(invite[1]!);
          if (!who) {
            const back = encodeURIComponent(path);
            return html(
              // The generated page's words (app/(site)/invite/[token]/page.tsx),
              // kept in step by hand: this fixture can't render a Next page.
              `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>You've been invited</title>` +
                `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${PAGE_CSS}</style></head><body><main>` +
                `<h1>You've been invited</h1><p>Create an account or sign in to see your invitation.</p>` +
                `<p>Use the email address the invitation was sent to. You can come back to this link from your email at any time.</p>` +
                `<p><a href="/sign-up?redirect_url=${back}">Create an account</a> · <a href="/sign-in?redirect_url=${back}">I already have one</a></p>` +
                `</main></body></html>`,
            );
          }
          return html(page({ mode: "invite", token, email: who.email }, "Accept your invitation"));
        }

        const companyPages: Record<string, string> = { "/dashboard": "dashboard", "/settings/team": "team", "/settings/company": "settings" };
        if (companyPages[path]) {
          const verdict = await gate(req, path);
          if ("redirect" in verdict) return redirect(verdict.redirect);
          if ("html" in verdict) return html(verdict.html);
          return html(page({ mode: companyPages[path], session: verdict.session, company: verdict.company, email: verdict.who.email }, verdict.company.name));
        }

        if (path === "/admin/companies" || path.startsWith("/admin/companies/") || path === "/admin/people") {
          const refused = await staffGate(req, path);
          if (refused) return "redirect" in refused ? redirect(refused.redirect) : html(refused.html);
          if (path === "/admin/companies") return html(page({ mode: "admin-companies" }, "Companies"));
          if (path === "/admin/people") return html(page({ mode: "admin-people" }, "People"));
          return html(page({ mode: "admin-company", tenantId: decodeURIComponent(path.slice("/admin/companies/".length)) }, "Company"));
        }

        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      } catch (error) {
        console.error(error);
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("fixture error");
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    get origin() {
      return origin;
    },
    outbox,
    query,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await testDb.close();
    },
  } satisfies TenancyScenarioServer;
}
