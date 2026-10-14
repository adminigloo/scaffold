import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
// create-app's OWN decisions for a generated --estimator project (type-only
// imports, so this loads without the package): the links the emails carry,
// what the staff screens are told about email, the model that reads a photo,
// and how a visit booked from an estimate is listed on it — from the module
// both modes share — and the staff key each estimator permission maps to,
// from the single-business module (Tenancy 2a moved everything that names the
// one fixed business there; this scenario IS a single business). Used as they
// are, not copied.
import {
  estimatorDeliveryStatus,
  estimatorLinks,
  linkedVisit,
  takeoffModelFor,
} from "../../packages/create-app/overlays/estimator/src/server/estimator-config.ts";
import { ESTIMATOR_STAFF_KEYS } from "../../packages/create-app/overlays/estimator-single/src/server/estimator-staff.ts";

/**
 * The fixture behind e2e/tests/estimator-scenario.spec.ts: a REAL estimator
 * backend — @adminigloo/estimator 0.3's public and staff HTTP handlers and its
 * comms listener — on a real Postgres (PGlite) with the comms, storage,
 * invoicing and scheduling tables, serving the REAL widgets, bundled from
 * @adminigloo/estimator-widget's (and scheduling-widget's) source, at the same
 * paths a generated `--estimator --scheduling --invoicing --comms --email
 * --storage --ai` project uses:
 *
 *   /estimate                    <EstimateTool>        (app/(site)/estimate)
 *   /quote/:token                <QuoteView>           (app/(site)/quote/[token])
 *   /admin/estimates             <EstimatesQueue>      (app/admin/estimates)
 *   /admin/estimates/:id         <EstimateEditor>      (app/admin/estimates/[id])
 *   /admin/estimator             <PriceBook>           (app/admin/estimator)
 *   /book-visit                  <VisitPicker>         (app/(site)/book-visit)
 *   /api/estimator/*             createEstimatorHandlers
 *   /api/admin/estimator/*       createEstimatorAdminHandlers
 *   /api/schedule/*              createSchedulingHandlers
 *
 * WIRED THE WAY create-app WIRES IT (src/server/estimator.ts, the generated
 * estimator-notify.ts, estimator-services.ts and comms-hooks.ts):
 *
 *   - the routes share one `onEvent` that hands every event to the estimator
 *     comms listener, built with the generated options (quote, admin and
 *     booking links from estimator-config's `estimatorLinks`, follow-ups queued
 *     for the comms cron's 14:00 UTC run);
 *   - the photo store is storage's REAL `storeFile` / `deleteFile` over a blob
 *     store held in memory (the generated adapter is Vercel Blob), so a kept
 *     photo is a stored_files row (kind "estimator.photo") and a URL this
 *     server serves;
 *   - `convertToInvoice` is the generated one: getEstimate → invoicing's
 *     invoiceInputFromEstimate → createInvoice → markEstimateConverted, in one
 *     transaction; `links` reads the invoice and the scheduling visits back;
 *   - the comms cron is runDueMessages with the listener's beforeSend, then
 *     redactSent; the estimator cron is expireQuotes + purgeOrphanPhotos.
 *
 * What differs is only what a test has to own:
 *
 *   - EMAIL: the comms sender records each message in `outbox` instead of
 *     calling Resend — the same message a real sender is handed.
 *   - SIGN-IN: `authorize` reads an `e2e-staff` cookie where the app reads the
 *     Clerk session. Nobody → 401. The OWNER holds every estimator staff key;
 *     OFFICE staff hold staff.estimates.view and .manage (prices, no costs).
 *     The permission → key mapping is create-app's ESTIMATOR_STAFF_KEYS.
 *   - THE MODEL: a fake TakeoffModel answering with OBSERVATIONS only (4
 *     risers, 7.5–8.5 in, medium confidence: one more than Pat's door has, so
 *     the customer corrects a GENUINELY wrong count; review EST-R04), counting
 *     calls. Its usage goes to `aiUsage` where the app writes ai_usage.
 *   - THE CLOCK: one scenario clock, handed to both handlers, the listener and
 *     the crons. The browser pages get the same time through Playwright's clock.
 *
 * Everything is imported from the BUILT packages (dist), so the drizzle
 * instance the tables were declared with is the one the handlers query through.
 */

const here = dirname(fileURLToPath(import.meta.url));
const e2eRoot = join(here, "..");
const repo = join(e2eRoot, "..");
const pkg = (name: string) => realpathSync(join(repo, "packages", name));
const estimatorDir = pkg("estimator");
const fileUrl = (path: string) => pathToFileURL(path).href;
const src = (path: string) => path.replace(/\\/g, "/");

/* eslint-disable @typescript-eslint/no-explicit-any -- the packages are imported by path at runtime */
type Any = any;

export interface SentEmail {
  to: string;
  subject: string;
  body: string;
  html: string;
  at: Date;
}

export interface AiUsageRow {
  tenantId: string;
  operation: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  outcome: string;
}

export interface EstimatorScenario {
  origin: string;
  tenantId: string;
  now: () => Date;
  setClock: (at: Date) => void;
  outbox: SentEmail[];
  /** Every model call the photo reading made. */
  modelCalls: Array<{ prompt: string; image: { base64: string; mediaType: string }; maxTokens: number }>;
  /** What the app would write to ai_usage, one row per reading. */
  aiUsage: AiUsageRow[];
  /** Every event the handlers emitted, in order. */
  events: Array<{ type: string; estimateId: string }>;
  /** Anything the listener or a handler reported: the scenario must end with none. */
  failures: Array<{ where: string; error: unknown }>;
  /** Calls to the generated convertToInvoice. */
  convertCalls: () => number;
  estimator: Any;
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  /** /api/cron/comms, as create-app's route runs it. */
  runCommsCron: () => Promise<{ sent: number; skipped: number; failed: number }>;
  /** /api/cron/estimator, as create-app's route runs it. */
  runEstimatorCron: () => Promise<{ expired: number; announced: number; photosDeleted: number }>;
  close: () => Promise<void>;
}

/**
 * The observation the fake model reports for each photo it is sent: what it
 * SAW, nothing it worked out. FOUR risers, where Pat's door is three up (two
 * steps and the porch): the model counted one too many, and Pat corrects it.
 * The scenario used to have Pat lower a RIGHT count (3, the porch included) to
 * 2 and called that a correction — the miscount the review found the copy
 * invited (EST-R04).
 */
export const PORCH_OBSERVATION = { seen: true, risers: 4, riserHeightIn: { low: 7.5, high: 8.5 }, confidence: "medium" } as const;

/** Turn the drizzle tables into CREATE TABLE statements (the packages' own pglite helper, by hand). */
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

const widgetIndex = src(join(repo, "packages", "estimator-widget", "src", "index.ts"));
const widgetAdmin = src(join(repo, "packages", "estimator-widget", "src", "admin", "index.ts"));
const schedulingWidget = src(join(repo, "packages", "scheduling-widget", "src", "index.ts"));

/** The host page for one widget, the shape a generated page renders. */
const HOST_APP = `
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EstimateTool, QuoteView } from ${JSON.stringify(widgetIndex)};
import { EmbedKeys, EstimateEditor, EstimatesQueue, EstimatorSettings, PriceBook } from ${JSON.stringify(widgetAdmin)};
import { VisitPicker } from ${JSON.stringify(schedulingWidget)};

const cfg = window.__page;

function App() {
  switch (cfg.mode) {
    case "quote":
      return <QuoteView baseUrl="/api/estimator" token={cfg.token} bookHref="/book-visit" />;
    case "estimates":
      return <EstimatesQueue baseUrl="/api/admin/estimator" estimateHref={(id) => "/admin/estimates/" + encodeURIComponent(id)} />;
    case "estimate-admin":
      return <EstimateEditor baseUrl="/api/admin/estimator" estimateId={cfg.id} backHref="/admin/estimates" />;
    case "pricebook":
      return <PriceBook baseUrl="/api/admin/estimator" />;
    case "settings":
      return <><EstimatorSettings baseUrl="/api/admin/estimator" /><EmbedKeys baseUrl="/api/admin/estimator" /></>;
    case "book":
      return <VisitPicker baseUrl="/api/schedule" estimateId={cfg.estimate || undefined} />;
    default:
      return <EstimateTool baseUrl="/api/estimator" bookHref="/book-visit" />;
  }
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
`;

async function bundleWidgets(): Promise<string> {
  const result = await build({
    stdin: { contents: HOST_APP, resolveDir: e2eRoot, sourcefile: "estimator-scenario-host.tsx", loader: "tsx" },
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

/** The staff roles, as the app's principal_role would hold them, and the staff keys each holds. */
const ROLE_KEYS: Record<string, readonly string[]> = {
  owner: Object.values(ESTIMATOR_STAFF_KEYS),
  office: ["staff.estimates.view", "staff.estimates.manage"],
};

export async function startEstimatorScenario(options: { tenantId: string; start: Date }): Promise<EstimatorScenario> {
  const drizzleDir = realpathSync(join(estimatorDir, "node_modules", "drizzle-orm"));
  const pgliteDir = realpathSync(join(estimatorDir, "node_modules", "@electric-sql", "pglite"));
  const estimator: Any = await import(fileUrl(join(estimatorDir, "dist", "index.js")));
  const estimatorComms: Any = await import(fileUrl(join(estimatorDir, "dist", "comms.js")));
  const comms: Any = await import(fileUrl(join(pkg("comms"), "dist", "index.js")));
  const commsSchema: Any = await import(fileUrl(join(pkg("comms"), "dist", "schema.js")));
  const storage: Any = await import(fileUrl(join(pkg("storage"), "dist", "index.js")));
  const storageSchema: Any = await import(fileUrl(join(pkg("storage"), "dist", "schema.js")));
  const invoicing: Any = await import(fileUrl(join(pkg("invoicing"), "dist", "index.js")));
  const invoicingSchema: Any = await import(fileUrl(join(pkg("invoicing"), "dist", "schema.js")));
  const scheduling: Any = await import(fileUrl(join(pkg("scheduling"), "dist", "index.js")));
  const drizzleRoot: Any = await import(fileUrl(join(drizzleDir, "index.js")));
  const pgCore: Any = await import(fileUrl(join(drizzleDir, "pg-core", "index.js")));
  const { drizzle }: Any = await import(fileUrl(join(drizzleDir, "pglite", "index.js")));
  const { PGlite }: Any = await import(fileUrl(join(pgliteDir, "dist", "index.js")));
  const { and, asc, eq } = drizzleRoot;

  // --- the database ---------------------------------------------------------------
  const client = new PGlite();
  const tables = [
    estimator.estimatorSettings,
    estimator.estimatorProducts,
    estimator.estimatorComponents,
    estimator.estimatorProductComponents,
    estimator.estimatorOptions,
    estimator.estimatorOptionValues,
    estimator.estimatorEstimates,
    estimator.estimatorEstimateItems,
    estimator.estimatorClientKeys,
    estimator.estimatorQuoteTokens,
    estimator.estimatorPhotos,
    estimator.estimatorTakeoffs,
    commsSchema.commsTemplates,
    commsSchema.commsMessages,
    commsSchema.commsScheduled,
    storageSchema.storedFiles,
    invoicingSchema.invoices,
    invoicingSchema.invoiceItems,
    invoicingSchema.invoicePayments,
    scheduling.schedulingResources,
    scheduling.schedulingAvailability,
    scheduling.schedulingBookings,
    scheduling.schedulingDriveCache,
    scheduling.schedulingSettings,
    scheduling.schedulingVisitTokens,
  ];
  for (const statement of ddl(drizzleRoot, pgCore, tables)) await client.exec(statement);
  const db = drizzle(client);

  // --- the clock ------------------------------------------------------------------
  let offsetMs = options.start.getTime() - Date.now();
  const now = () => new Date(Date.now() + offsetMs);
  const setClock = (at: Date) => {
    offsetMs = at.getTime() - Date.now();
  };

  const tenantId = options.tenantId;
  let origin = "";
  // Built from the server's address once it listens, like the app's APP_URL.
  const urls = () => estimatorLinks(origin);
  const failures: EstimatorScenario["failures"] = [];

  // --- email, captured at the sender -------------------------------------------------
  const outbox: SentEmail[] = [];
  const senders = {
    email: async (message: { to: string; subject: string; body: string; html: string }) => {
      outbox.push({ to: message.to, subject: message.subject, body: message.body, html: message.html, at: now() });
      return { id: `e2e_${outbox.length}` };
    },
  };

  // --- src/server/estimator-notify.ts (with --comms --email --scheduling) ------------
  const listener = estimatorComms.createEstimatorCommsListener({
    db,
    senders,
    quoteUrl: (token: string) => urls().quote(token),
    adminEstimateUrl: (estimateId: string) => urls().adminEstimate(estimateId),
    bookUrl: (estimate: { id: string }) => urls().bookVisit(estimate.id),
    staffEmails: [],
    followUpRuns: { dailyAtUtc: "14:00" },
    now,
    onError: (error: unknown, context: { step: string }) => void failures.push({ where: `comms:${context.step}`, error }),
  });
  const events: EstimatorScenario["events"] = [];
  // LISTENERS, each contained: the generated onEstimatorEvent.
  const onEvent = async (event: { type: string; estimateId: string }) => {
    events.push({ type: event.type, estimateId: event.estimateId });
    try {
      await listener.onEvent(event);
    } catch (error) {
      failures.push({ where: "listener", error });
    }
  };

  // --- src/server/estimator-services.ts ---------------------------------------------
  // Photos: storage's storeFile/deleteFile, over a blob store held in memory.
  const blobs = new Map<string, { bytes: Buffer; contentType: string }>();
  const blobStore = {
    put: async (pathname: string, body: Uint8Array, opts: { contentType: string }) => {
      blobs.set(pathname, { bytes: Buffer.from(body), contentType: opts.contentType });
      return { url: `${origin}/blob/${pathname}`, pathname };
    },
    delete: async (pathname: string) => {
      blobs.delete(pathname);
    },
  };
  const photoStore = {
    put: async (input: { tenantId: string; bytes: Uint8Array; contentType: string; filename: string }) => {
      const row = await storage.storeFile(db, blobStore, {
        tenantId: input.tenantId,
        ownerId: "estimator",
        kind: "estimator.photo",
        filename: input.filename,
        contentType: input.contentType,
        sizeBytes: input.bytes.byteLength,
        body: input.bytes,
      });
      return { fileId: row.id, url: row.url };
    },
    delete: async (input: { tenantId: string; fileId: string }) => {
      await storage.deleteFile(db, blobStore, { id: input.fileId, tenantId: input.tenantId });
    },
  };

  // Reading: what the generated runner would be (Haiku 4.5 unless the variable
  // names another), with the model faked — it answers OBSERVATIONS only.
  const modelCalls: EstimatorScenario["modelCalls"] = [];
  const modelId = takeoffModelFor(undefined);
  const model = {
    model: modelId,
    rates: estimator.TAKEOFF_MODEL_RATES[modelId],
    async read(request: { prompt: string; image: { base64: string; mediaType: string }; maxTokens: number }) {
      modelCalls.push({ prompt: request.prompt, image: request.image, maxTokens: request.maxTokens });
      return { output: { ...PORCH_OBSERVATION }, inputTokens: 830, outputTokens: 38, stopReason: "end_turn" };
    },
  };
  const aiUsage: AiUsageRow[] = [];
  const takeoff = {
    model,
    recordUsage: (usage: AiUsageRow) => {
      aiUsage.push({
        tenantId: usage.tenantId,
        operation: usage.operation,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costMicros: usage.costMicros,
        outcome: usage.outcome,
      });
    },
  };

  // The visits booked from an estimate, and the invoice it became.
  const visitsForEstimate = async (estimateId: string) => {
    const rows = await db
      .select({
        id: scheduling.schedulingBookings.id,
        status: scheduling.schedulingBookings.status,
        startsAt: scheduling.schedulingBookings.startsAt,
        scheduledDate: scheduling.schedulingBookings.scheduledDate,
        startTime: scheduling.schedulingBookings.startTime,
      })
      .from(scheduling.schedulingBookings)
      .where(and(eq(scheduling.schedulingBookings.tenantId, tenantId), eq(scheduling.schedulingBookings.estimateId, estimateId)))
      .orderBy(asc(scheduling.schedulingBookings.scheduledDate), asc(scheduling.schedulingBookings.startTime))
      .limit(20);
    if (rows.length === 0) return [];
    const { timeZone } = await scheduling.getSchedulingSettings(db, tenantId);
    return rows.map((row: Any) => linkedVisit(row, timeZone, urls().scheduleAdmin));
  };
  const invoicePreviewPath = (token: string) => `/invoice/${encodeURIComponent(token)}?preview=1`;
  const invoiceForEstimate = async (estimateId: string) => {
    const t = invoicingSchema.invoices;
    const [row] = await db
      .select({ id: t.id, number: t.invoiceNumber, status: t.status, viewToken: t.viewToken })
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.estimateId, estimateId)))
      .limit(1);
    return row ? { id: row.id, number: row.number, status: row.status, url: invoicePreviewPath(row.viewToken) } : null;
  };
  let convertCalls = 0;
  const convertToInvoice = async (input: { tenantId: string; estimateId: string; userId: string | null }) => {
    convertCalls += 1;
    const found = await estimator.getEstimate(db, input.tenantId, input.estimateId);
    if (!found) throw new estimator.EstimatorInputError("transition_not_allowed", "This estimate can't be invoiced.");
    try {
      return await db.transaction(async (tx: Any) => {
        const invoice = await invoicing.createInvoice(
          tx,
          { tenantId, ...invoicing.invoiceInputFromEstimate(found.estimate, found.items) },
          input.userId ?? undefined,
        );
        const claimed = await estimator.markEstimateConverted(tx, input.tenantId, input.estimateId);
        if (!claimed) {
          throw new estimator.EstimatorInputError("transition_not_allowed", "Only an accepted quote can become an invoice, and only once.");
        }
        return { id: invoice.id, number: invoice.invoiceNumber, status: "draft", url: invoicePreviewPath(invoice.viewToken) };
      });
    } catch (error) {
      if (error instanceof invoicing.InvoicingError) throw new estimator.EstimatorInputError("transition_not_allowed", (error as Error).message);
      throw error;
    }
  };

  // --- the routes ---------------------------------------------------------------------
  const publicApi = estimator.createEstimatorHandlers({
    db,
    resolveTenant: async () => tenantId,
    photoStore,
    takeoff,
    onEvent,
    emailsEnabled: true,
    requesterKey: estimator.clientIpKey,
    rateLimit: () => true,
    onError: (error: unknown, context: { route: string }) => void failures.push({ where: `public:${context.route}`, error }),
    now,
  });
  const adminApi = estimator.createEstimatorAdminHandlers({
    db,
    resolveTenant: () => tenantId,
    // create-app's authorizeEstimatorStaff: a principal (the cookie), their
    // role from OUR records, then the staff key the permission maps to.
    authorize: (req: Request, permission: keyof typeof ESTIMATOR_STAFF_KEYS) => {
      const who = /(?:^|;\s*)e2e-staff=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
      if (!who) {
        return Response.json({ error: { code: "unauthorized", message: "Sign in to see estimates." } }, { status: 401 });
      }
      const keys = ROLE_KEYS[decodeURIComponent(who)];
      if (!keys) return false;
      if (!keys.includes(ESTIMATOR_STAFF_KEYS[permission])) return false;
      return { userId: decodeURIComponent(who) };
    },
    photoStore,
    photoReading: true,
    onEvent,
    quoteUrl: (token: string) => urls().quote(token),
    delivery: () => estimatorDeliveryStatus({ commsInstalled: true, emailConfigured: true, cronSecretSet: true }),
    links: {
      bookVisitUrl: (estimate: { id: string }) => urls().bookVisit(estimate.id),
      visits: (estimateId: string) => visitsForEstimate(estimateId),
      invoice: (estimateId: string) => invoiceForEstimate(estimateId),
    },
    convertToInvoice,
    onError: (error: unknown, context: { route: string }) => void failures.push({ where: `admin:${context.route}`, error }),
    now,
  });
  const scheduleApi = scheduling.createSchedulingHandlers({
    db,
    resolveTenant: async () => tenantId,
    manageUrl: (token: string) => `${origin}/visit/${encodeURIComponent(token)}`,
    maps: scheduling.createHaversineMapsProvider(),
    emailsEnabled: false,
    requesterKey: scheduling.clientIpKey,
    now,
  });

  // --- scheduling, set up by its owner (the booking page the accepted quote opens) ----
  await scheduling.updateSchedulingSettings(db, tenantId, {
    timeZone: "America/Denver",
    businessName: "Summit Ramps",
    contactPhone: "(801) 555-0143",
    requireAddress: true,
    publicBookingEnabled: true,
    services: [{ key: "install", name: "Ramp install", durationMinutes: 120 }],
  });
  await scheduling.createResource(db, { tenantId, name: "Install crew" });

  const widgets = await bundleWidgets();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", origin);
      const path = url.pathname;
      try {
        if (path.startsWith("/api/admin/estimator/")) return await send(res, await adminApi.handle(await toRequest(req, origin)));
        if (path.startsWith("/api/estimator/")) return await send(res, await publicApi.handle(await toRequest(req, origin)));
        if (path.startsWith("/api/schedule/")) return await send(res, await scheduleApi.handle(await toRequest(req, origin)));
        if (path === "/widgets.js") {
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
          return res.end(widgets);
        }
        if (path.startsWith("/blob/")) {
          const blob = blobs.get(decodeURIComponent(path.slice("/blob/".length)));
          if (!blob) {
            res.writeHead(404);
            return res.end();
          }
          res.writeHead(200, { "content-type": blob.contentType });
          return res.end(blob.bytes);
        }
        const html = (body: string) => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(body);
        };
        if (path === "/estimate") return html(page("estimate", {}, "Instant estimate"));
        const quote = /^\/quote\/([^/]+)$/.exec(path);
        if (quote) {
          return html(
            page("quote", { token: decodeURIComponent(quote[1]!) }, "Your quote", '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">'),
          );
        }
        if (path === "/admin/estimates") return html(page("estimates", {}, "Estimates"));
        const one = /^\/admin\/estimates\/([^/]+)$/.exec(path);
        if (one) return html(page("estimate-admin", { id: decodeURIComponent(one[1]!) }, "Estimate"));
        if (path === "/admin/estimator") return html(page("pricebook", {}, "Price book"));
        if (path === "/admin/estimator/settings") return html(page("settings", {}, "Estimate settings"));
        if (path === "/book-visit") return html(page("book", { estimate: url.searchParams.get("estimate") }, "Book a visit"));
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      } catch (error) {
        failures.push({ where: `fixture:${path}`, error });
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
    tenantId,
    now,
    setClock,
    outbox,
    modelCalls,
    aiUsage,
    events,
    failures,
    convertCalls: () => convertCalls,
    estimator,
    query: async (sql, params) => (await client.query(sql, params)).rows,
    runCommsCron: async () => {
      // app/api/cron/comms: runDueMessages with commsBeforeSend (the
      // estimator producer), then afterCommsRun (redactSent), in a finally.
      try {
        return await comms.runDueMessages(db, senders, {
          now: now(),
          beforeSend: async (row: unknown) => (await listener.beforeSend(row)) ?? "send",
        });
      } finally {
        await listener.redactSent();
      }
    },
    runEstimatorCron: async () => {
      // app/api/cron/estimator.
      const expired = await estimator.expireQuotes(db, tenantId, { onEvent, now: now(), timeBudgetMs: 20_000 });
      const photos = await estimator.purgeOrphanPhotos(db, photoStore, { now: now(), timeBudgetMs: 20_000 });
      return { expired: expired.expired, announced: expired.announced, photosDeleted: photos.deleted };
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await client.close();
    },
  } satisfies EstimatorScenario;
}
