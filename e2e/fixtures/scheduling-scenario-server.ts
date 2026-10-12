import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * The fixture behind e2e/tests/scheduling-scenario.spec.ts: a REAL scheduling
 * backend — @adminigloo/scheduling 0.4's two HTTP handlers and its comms
 * listener, on a real Postgres (PGlite) with the comms tables — serving the
 * REAL widgets, bundled from @adminigloo/scheduling-widget's source, at the
 * same paths a generated project uses:
 *
 *   /book-visit                 <VisitPicker>        (app/(site)/book-visit)
 *   /visit/:token               <ManageVisit>        (app/(site)/visit/[token])
 *   /admin/schedule             <ScheduleCalendar>   (app/admin/schedule)
 *   /admin/schedule/today       <CrewDay>            (app/admin/schedule/today)
 *   /admin/schedule/settings    <SchedulingSettings> (app/admin/schedule/settings)
 *   /api/schedule/*             createSchedulingHandlers
 *   /api/admin/schedule/*       createSchedulingAdminHandlers
 *
 * WIRED THE WAY create-app WIRES IT. The routes get one `onEvent` that hands
 * every event to the comms listener (src/server/scheduling-notify.ts); the
 * comms cron is `runDueMessages` with the listener's `beforeSend`, then
 * `redactSent` (src/server/comms-hooks.ts); the expiry cron is
 * `expirePendingRequests` with the same `onEvent` (app/api/cron/scheduling).
 * What differs is only what a test has to own:
 *
 *   - EMAIL: the comms sender records each message in `outbox` instead of
 *     calling Resend — the same `{ to, subject, body, html }` a real sender is
 *     handed, after comms has rendered the templates and logged the send.
 *   - SIGN-IN: `authorize` reads an `e2e-staff` cookie (who is signed in)
 *     where the app reads the Clerk session. Nobody → 401. What they may do
 *     is a ROLE, held in `roles` the way the app holds it in principal_role:
 *     the owner holds every scheduling permission; a crew member holds only
 *     `schedule.route`, and only once the owner has picked them for a crew in
 *     Schedule settings (`onCrewMemberChange`, as create-app's
 *     onSchedulingCrewChange grants the crew role). Somebody with no role is
 *     signed in but not staff → 403.
 *   - THE CLOCK: one scenario clock (`now()`), real time plus an offset the
 *     test moves, handed to both handlers, the listener and both crons. The
 *     browser pages get the same time through Playwright's clock.
 *   - GOOGLE: a fake `fetch` behind the real `createGoogleMapsProvider`
 *     (geocodes the scenario's addresses, answers a 15-minute drive), cached
 *     in the database through `createCachedMapsProvider`, as with a key set.
 *   - THE CRONS run only when the test says, and the test runs them only at
 *     the hours vercel.json schedules them (comms 14:00 UTC, scheduling 13:00
 *     UTC). The listener is told the comms one (`reminderRuns`), exactly as
 *     src/server/scheduling-notify.ts tells it.
 *
 * Everything is imported from the BUILT packages (dist), resolved through the
 * scheduling package's own node_modules, so the drizzle instance the tables
 * were declared with is the one the handlers query through.
 */

const here = dirname(fileURLToPath(import.meta.url));
const e2eRoot = join(here, "..");
const repo = join(e2eRoot, "..");
const schedulingDir = join(repo, "packages", "scheduling");
const commsDir = join(repo, "packages", "comms");
const widgetSrc = join(repo, "packages", "scheduling-widget", "src");

const fileUrl = (path: string) => pathToFileURL(path).href;
const real = (path: string) => realpathSync(path);

/* eslint-disable @typescript-eslint/no-explicit-any -- the packages are imported by path at runtime */
type Any = any;

export interface SentEmail {
  to: string;
  subject: string;
  body: string;
  html: string;
  /** The scenario time it was handed to the sender. */
  at: Date;
}

export interface ScenarioPlace {
  lat: number;
  lng: number;
}

export interface ScenarioServer {
  origin: string;
  tenantId: string;
  /** The scenario's current time. */
  now: () => Date;
  setClock: (at: Date) => void;
  /** Every email the business sent, in order. */
  outbox: SentEmail[];
  /** The packages, for setup and for reading what the database holds. */
  scheduling: Any;
  comms: Any;
  db: Any;
  /** Raw SQL against the scenario database. */
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  /** The comms cron, as create-app's /api/cron/comms runs it. */
  runCommsCron: () => Promise<{ sent: number; skipped: number; failed: number; cancelled: number; expired: number }>;
  /** The expiry cron, as create-app's /api/cron/scheduling runs it. */
  runExpiryCron: () => Promise<{ expired: number }>;
  /** Google calls the fake answered, by API. */
  googleCalls: { geocode: number; distance: number };
  /** Who holds which role (user id → role), as the app's principal_role would say. */
  roles: Map<string, "owner" | "crew">;
  close: () => Promise<void>;
}

/** The people who have signed in, as listSchedulingPeople reads them from the users table. */
export const SCENARIO_PEOPLE = [
  { userId: "owner", name: "Olive Owner", email: "olive@acme.test" },
  { userId: "user_crew_a", name: "Alex Crew", email: "alex@acme.test" },
  { userId: "user_crew_b", name: "Casey Crew", email: "casey@acme.test" },
] as const;

/** The comms cron's hour in vercel.json (COMMS_CRON_DAILY_AT_UTC), handed to the listener as create-app does. */
export const COMMS_CRON_AT_UTC = "14:00";

export interface ScenarioOptions {
  tenantId: string;
  start: Date;
  places: Record<string, ScenarioPlace>;
}

/** Turn the drizzle tables into CREATE TABLE statements (the scheduling suite's own helper, by hand). */
function ddl(drizzleRoot: Any, pgCore: Any, tables: Any[]): string[] {
  const dialect = new pgCore.PgDialect();
  const literal = (value: unknown): string => {
    if (drizzleRoot.is(value, drizzleRoot.SQL)) return dialect.sqlToQuery(value).sql;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
    if (Array.isArray(value) || (value && typeof value === "object")) return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
    throw new Error(`no literal for default ${String(value)}`);
  };
  const out: string[] = [];
  for (const table of tables) {
    const config = pgCore.getTableConfig(table);
    const lines = config.columns.map((column: Any) => {
      let line = `"${column.name}" ${column.getSQLType()}`;
      if (column.primary) line += " PRIMARY KEY";
      else if (column.notNull) line += " NOT NULL";
      if (column.default !== undefined) line += ` DEFAULT ${literal(column.default)}`;
      return line;
    });
    out.push(`CREATE TABLE "${config.name}" (\n  ${lines.join(",\n  ")}\n)`);
    for (const index of config.indexes) {
      const columns = index.config.columns.map((column: Any) => `"${column.name}"`).join(", ");
      const where = index.config.where ? ` WHERE ${dialect.sqlToQuery(index.config.where).sql}` : "";
      out.push(`CREATE ${index.config.unique ? "UNIQUE " : ""}INDEX "${index.config.name}" ON "${config.name}" (${columns})${where}`);
    }
  }
  return out;
}

/** The host page for one widget, the shape a generated page renders. */
const HOST_APP = `
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { VisitPicker, ManageVisit } from ${JSON.stringify(join(widgetSrc, "index.ts").replace(/\\/g, "/"))};
import { ScheduleCalendar, CrewDay, SchedulingSettings } from ${JSON.stringify(join(widgetSrc, "admin", "index.ts").replace(/\\/g, "/"))};

const cfg = window.__page;

function App() {
  if (cfg.mode === "manage") return <ManageVisit baseUrl="/api/schedule" token={cfg.token} bookHref="/book-visit" />;
  if (cfg.mode === "calendar") return <ScheduleCalendar baseUrl="/api/admin/schedule" bookingPageUrl={location.origin + "/book-visit"} pollMs={0} />;
  if (cfg.mode === "crew") return <CrewDay baseUrl="/api/admin/schedule" pollMs={0} />;
  if (cfg.mode === "settings") return <SchedulingSettings baseUrl="/api/admin/schedule" bookingPageUrl={location.origin + "/book-visit"} signInUrl={location.origin + "/sign-in"} />;
  return <VisitPicker baseUrl="/api/schedule" />;
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
`;

async function bundleWidgets(): Promise<string> {
  const result = await build({
    stdin: { contents: HOST_APP, resolveDir: e2eRoot, sourcefile: "scheduling-scenario-host.tsx", loader: "tsx" },
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
    // Development React under StrictMode: effects run twice, as in every buyer's `next dev`.
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    logLevel: "silent",
  });
  return result.outputFiles[0]!.text;
}

function page(mode: string, extra: Record<string, unknown>, title: string, meta = ""): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">${meta}</head>` +
    `<body style="margin:0;padding:16px;font-family:system-ui"><div id="root"></div>` +
    `<script>window.__page=${JSON.stringify({ mode, ...extra })}</script><script src="/widgets.js"></script></body></html>`
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

export async function startScenarioServer(options: ScenarioOptions): Promise<ScenarioServer> {
  const drizzleDir = real(join(schedulingDir, "node_modules", "drizzle-orm"));
  const pgliteDir = real(join(schedulingDir, "node_modules", "@electric-sql", "pglite"));
  const scheduling: Any = await import(fileUrl(join(schedulingDir, "dist", "index.js")));
  const schedulingComms: Any = await import(fileUrl(join(schedulingDir, "dist", "comms.js")));
  const comms: Any = await import(fileUrl(join(real(commsDir), "dist", "index.js")));
  const commsSchema: Any = await import(fileUrl(join(real(commsDir), "dist", "schema.js")));
  const drizzleRoot: Any = await import(fileUrl(join(drizzleDir, "index.js")));
  const pgCore: Any = await import(fileUrl(join(drizzleDir, "pg-core", "index.js")));
  const { drizzle }: Any = await import(fileUrl(join(drizzleDir, "pglite", "index.js")));
  const { PGlite }: Any = await import(fileUrl(join(pgliteDir, "dist", "index.js")));

  // --- the database -------------------------------------------------------------
  const client = new PGlite();
  const tables = [
    scheduling.schedulingResources,
    scheduling.schedulingAvailability,
    scheduling.schedulingBookings,
    scheduling.schedulingDriveCache,
    scheduling.schedulingSettings,
    scheduling.schedulingVisitTokens,
    commsSchema.commsTemplates,
    commsSchema.commsMessages,
    commsSchema.commsScheduled,
  ];
  for (const statement of ddl(drizzleRoot, pgCore, tables)) await client.exec(statement);
  const db = drizzle(client);

  // --- the clock ----------------------------------------------------------------
  let offsetMs = options.start.getTime() - Date.now();
  const now = () => new Date(Date.now() + offsetMs);
  const setClock = (at: Date) => {
    offsetMs = at.getTime() - Date.now();
  };

  // --- Google, faked at the fetch -------------------------------------------------
  const googleCalls = { geocode: 0, distance: 0 };
  const googleFetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/geocode/json")) {
      googleCalls.geocode += 1;
      const place = options.places[url.searchParams.get("address") ?? ""];
      return Response.json(place ? { status: "OK", results: [{ geometry: { location: place } }] } : { status: "ZERO_RESULTS", results: [] });
    }
    googleCalls.distance += 1;
    return Response.json({ status: "OK", rows: [{ elements: [{ status: "OK", duration: { value: 15 * 60 }, distance: { value: 8851 } }] }] });
  }) as typeof fetch;
  const maps = scheduling.createCachedMapsProvider(
    scheduling.createGoogleMapsProvider({ apiKey: "e2e-google-key", fetch: googleFetch }),
    db,
  );

  // --- email, captured at the sender ----------------------------------------------
  const outbox: SentEmail[] = [];
  let sent = 0;
  const senders = {
    email: async (message: { to: string; subject: string; body: string; html: string }) => {
      outbox.push({ to: message.to, subject: message.subject, body: message.body, html: message.html, at: now() });
      sent += 1;
      return { id: `e2e_${sent}` };
    },
  };

  // --- the server (its origin is known once it listens) --------------------------
  let origin = "";
  // The listener reads bookUrl/adminUrl per message, so they are filled in
  // once the server knows its own address (below), like the app's APP_URL.
  const listenerOptions: Record<string, unknown> = {
    db,
    senders,
    manageUrl: (token: string) => `${origin}/visit/${encodeURIComponent(token)}`,
    now,
    // The cron's hour, as create-app writes REMINDER_RUNS from vercel.json's.
    reminderRuns: { dailyAtUtc: COMMS_CRON_AT_UTC },
    onError: (error: unknown, context: unknown) => console.error("scheduling comms step failed", context, error),
  };
  const listener = schedulingComms.createSchedulingCommsListener(listenerOptions);
  // Every listener in turn, each contained: src/server/scheduling-notify.ts.
  const onEvent = async (event: unknown) => {
    try {
      await listener.onEvent(event);
    } catch (error) {
      console.error("a scheduling listener failed", error);
    }
  };

  const tenantId = options.tenantId;
  const publicApi = scheduling.createSchedulingHandlers({
    db,
    resolveTenant: async () => tenantId,
    manageUrl: (token: string) => `${origin}/visit/${encodeURIComponent(token)}`,
    maps,
    onEvent,
    emailsEnabled: true,
    requesterKey: scheduling.clientIpKey,
    now,
  });
  // The staff role each person holds. The owner from the start; crew members
  // only once the owner picks them for a crew (onCrewMemberChange, below).
  const roles = new Map<string, "owner" | "crew">([["owner", "owner"]]);
  const adminApi = scheduling.createSchedulingAdminHandlers({
    db,
    resolveTenant: async () => tenantId,
    // create-app's authorizeSchedulingStaff: a principal, their role from OUR
    // records, then the key the permission maps to. The crew role holds only
    // the route.
    authorize: (req: Request, permission: string) => {
      const who = /(?:^|;\s*)e2e-staff=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
      if (!who) {
        return Response.json({ error: { code: "forbidden", message: "Sign in to see the schedule." } }, { status: 401 });
      }
      const userId = decodeURIComponent(who);
      const role = roles.get(userId);
      if (!role) return false;
      if (role === "crew" && permission !== "schedule.route") return false;
      return { userId };
    },
    maps,
    onEvent,
    now,
    // The deployment's truth for the staff banner: a working sender, and the
    // comms cron once a day at vercel.json's hour.
    delivery: () => ({ customerEmails: true, reminders: true, reminderRuns: { dailyAtUtc: COMMS_CRON_AT_UTC }, problems: [] }),
    listPeople: () => SCENARIO_PEOPLE.map((person) => ({ ...person })),
    // create-app's onSchedulingCrewChange + crewAccessChange: somebody with no
    // role gets the crew role; it goes when no crew names them any more;
    // nobody who already holds a role is ever demoted.
    onCrewMemberChange: async (change: { tenantId: string; userId: string | null; previousUserId: string | null }) => {
      if (change.userId && !roles.has(change.userId)) roles.set(change.userId, "crew");
      const previous = change.previousUserId;
      if (previous && previous !== change.userId && roles.get(previous) === "crew") {
        const [still] = await client.query(
          "select count(*)::int as n from scheduling_resources where tenant_id = $1 and user_id = $2 and is_active",
          [change.tenantId, previous],
        ).then((r: Any) => r.rows);
        if (!still || Number(still.n) === 0) roles.delete(previous);
      }
    },
  });

  const widgets = await bundleWidgets();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", origin);
      const path = url.pathname;
      try {
        if (path.startsWith("/api/admin/schedule/")) return await send(res, await adminApi.handle(await toRequest(req, origin)));
        if (path.startsWith("/api/schedule/")) return await send(res, await publicApi.handle(await toRequest(req, origin)));
        if (path === "/widgets.js") {
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
          return res.end(widgets);
        }
        const html = (body: string) => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(body);
        };
        if (path === "/book-visit") return html(page("picker", {}, "Book a visit"));
        const manage = /^\/visit\/([^/]+)$/.exec(path);
        if (manage) {
          return html(
            page("manage", { token: decodeURIComponent(manage[1]!) }, "Your visit", '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">'),
          );
        }
        if (path === "/admin/schedule") return html(page("calendar", {}, "Schedule"));
        if (path === "/admin/schedule/today") return html(page("crew", {}, "Today's route"));
        if (path === "/admin/schedule/settings") return html(page("settings", {}, "Schedule settings"));
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
  listenerOptions.bookUrl = `${origin}/book-visit`;
  listenerOptions.adminUrl = `${origin}/admin/schedule`;

  return {
    get origin() {
      return origin;
    },
    tenantId,
    now,
    setClock,
    outbox,
    scheduling,
    comms,
    db,
    query: async (sql, params) => (await client.query(sql, params)).rows,
    runCommsCron: async () => {
      // app/api/cron/comms: runDueMessages with commsBeforeSend, then afterCommsRun.
      const result = await comms.runDueMessages(db, senders, {
        now: now(),
        beforeSend: async (row: unknown) => (await listener.beforeSend(row)) ?? "send",
      });
      await listener.redactSent();
      return result;
    },
    runExpiryCron: async () => {
      // app/api/cron/scheduling.
      const result = await scheduling.expirePendingRequests(db, tenantId, { now: now(), onEvent });
      return { expired: result.expired };
    },
    googleCalls,
    roles,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await client.close();
    },
  } satisfies ScenarioServer;
}
