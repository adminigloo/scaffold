import { and, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { clampGlance } from "./glance.js";
import { defaultLayout, normalizeLayout, type DashboardLayout } from "./layout.js";
import { dashboardLayouts } from "./schema.js";
import {
  checkWidgets,
  toCatalogCard,
  type BoardResponse,
  type DashboardWidget,
  type GlanceResult,
  type GlancesResponse,
} from "./widget.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DashboardDb = PgDatabase<any, any, any>;

/** Who is looking, as the app's own sign-in and permission rules decided. */
export interface DashboardViewer {
  readonly userId: string;
  readonly can: (permission: string) => boolean;
}

export interface DashboardHandlersOptions {
  readonly db: DashboardDb;
  /** Which dashboard these routes serve. Default "admin". */
  readonly board?: string;
  /** Every card this app offers; each person sees the ones they may open. */
  readonly widgets: readonly DashboardWidget[];
  /**
   * The app's gate: a viewer, or the Response to send instead (401 signed
   * out, 403 not staff). Asked on every request; nothing here trusts a
   * session claim or a value from the browser about who someone is.
   */
  readonly authorize: (req: Request) => Promise<DashboardViewer | Response>;
  /** Told about anything that went wrong, with which card. Never shown to the viewer. */
  readonly onError?: (error: unknown, context: { readonly route: string; readonly widget?: string }) => void;
  /** The clock. A test pins it. */
  readonly now?: () => Date;
  /** How long one card may take before it's reported as too slow. Default 10 s. */
  readonly glanceTimeoutMs?: number;
}

/** The most bytes a saved layout may be: forty cards fit in a fraction of it. */
const MAX_BODY_BYTES = 32 * 1024;
/** The most cards one request may load. */
const MAX_GLANCES_PER_REQUEST = 40;

const NO_STORE = { "cache-control": "no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function fail(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

/** Postgres "undefined_table": the migration that adds dashboard_layouts hasn't run. */
function isMissingTable(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 4; depth++) {
    if ((e as { code?: unknown }).code === "42P01") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A change sent from another site is refused. The browser always says where a
 * write came from; a same-site request with no Origin (a server, a test) is
 * let through to the sign-in check like any other.
 */
function crossSite(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(req.url).host;
  } catch {
    return true;
  }
}

/**
 * The dashboard's routes, for one catch-all route in the app
 * (app/api/admin/dashboard/[...path]/route.ts):
 *
 *   GET    …/v1/board              the cards on offer to this person, and their layout
 *   PUT    …/v1/layout             save their layout   { layout }
 *   DELETE …/v1/layout             back to the default dashboard
 *   GET    …/v1/glances?keys=a,b   what those cards show now
 *
 * Every request asks `authorize` first. A card someone may not open is not
 * offered, can't be saved onto their layout, and its glance never runs for
 * them: the permission is checked before the query, not after it.
 */
export function createDashboardHandlers(options: DashboardHandlersOptions): {
  readonly handle: (req: Request) => Promise<Response>;
} {
  checkWidgets(options.widgets);
  const board = options.board ?? "admin";
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.glanceTimeoutMs ?? 10_000;
  const report = (error: unknown, context: { route: string; widget?: string }) => {
    try {
      options.onError?.(error, context);
    } catch {
      // A broken reporter must not turn a handled error into a crash.
    }
  };

  const allowedFor = (viewer: DashboardViewer) => options.widgets.filter((w) => viewer.can(w.permission));

  async function readRow(userId: string): Promise<{ layout: unknown } | null> {
    const rows = await options.db
      .select({ layout: dashboardLayouts.layout })
      .from(dashboardLayouts)
      .where(and(eq(dashboardLayouts.board, board), eq(dashboardLayouts.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async function getBoard(viewer: DashboardViewer): Promise<Response> {
    const allowed = allowedFor(viewer);
    let row: { layout: unknown } | null = null;
    let storage: BoardResponse["storage"] = "ok";
    try {
      row = await readRow(viewer.userId);
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      storage = "unavailable";
    }
    const body: BoardResponse = {
      catalog: allowed.map(toCatalogCard),
      layout: row ? normalizeLayout(row.layout, allowed) : defaultLayout(allowed),
      saved: row !== null,
      storage,
    };
    return json(body);
  }

  async function putLayout(req: Request, viewer: DashboardViewer): Promise<Response> {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return fail(413, "too_large", "That layout is too large to save.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail(400, "bad_request", "That wasn't a layout.");
    }
    const sent = (parsed as { layout?: unknown } | null)?.layout;
    if (!sent || typeof sent !== "object") return fail(400, "bad_request", "That wasn't a layout.");
    // Normalised against what THIS person may open: a card they can't see
    // is dropped here, whatever the browser sent.
    const layout: DashboardLayout = normalizeLayout(sent, allowedFor(viewer));
    try {
      await options.db
        .insert(dashboardLayouts)
        .values({ board, userId: viewer.userId, layout, updatedAt: now() })
        .onConflictDoUpdate({
          target: [dashboardLayouts.board, dashboardLayouts.userId],
          set: { layout, updatedAt: now() },
        });
    } catch (error) {
      if (isMissingTable(error)) {
        return fail(503, "storage_unavailable", "Your layout can't be saved until the database is updated.");
      }
      throw error;
    }
    return json({ layout });
  }

  async function deleteLayout(viewer: DashboardViewer): Promise<Response> {
    try {
      await options.db
        .delete(dashboardLayouts)
        .where(and(eq(dashboardLayouts.board, board), eq(dashboardLayouts.userId, viewer.userId)));
    } catch (error) {
      if (!isMissingTable(error)) throw error;
    }
    return json({ layout: defaultLayout(allowedFor(viewer)) });
  }

  async function runGlance(widget: DashboardWidget, viewer: DashboardViewer, at: Date): Promise<GlanceResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const glance = await Promise.race([
        widget.glance({ userId: viewer.userId, now: at, can: viewer.can }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new GlanceTimeout()), timeoutMs);
        }),
      ]);
      return { key: widget.key, glance: clampGlance(glance), at: at.toISOString() };
    } catch (error) {
      if (error instanceof GlanceTimeout) {
        report(error, { route: "glances", widget: widget.key });
        return { key: widget.key, error: "This card took too long to load.", at: at.toISOString() };
      }
      if (isMissingTable(error)) {
        return { key: widget.key, error: "This part of the site isn't set up in the database yet.", at: at.toISOString() };
      }
      report(error, { route: "glances", widget: widget.key });
      return { key: widget.key, error: "This card couldn't load.", at: at.toISOString() };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function getGlances(url: URL, viewer: DashboardViewer): Promise<Response> {
    const keys = [...new Set((url.searchParams.get("keys") ?? "").split(",").map((k) => k.trim()).filter(Boolean))];
    if (keys.length === 0) return fail(400, "bad_request", "Name the cards to load.");
    if (keys.length > MAX_GLANCES_PER_REQUEST) return fail(400, "bad_request", "Too many cards in one request.");
    const allowed = new Map(allowedFor(viewer).map((w) => [w.key, w]));
    const at = now();
    // In parallel, each with its own timeout and its own failure: one slow or
    // broken feature costs its own card, never the whole dashboard.
    const results = await Promise.all(
      keys.map((key): Promise<GlanceResult> => {
        const widget = allowed.get(key);
        // Unknown and not-allowed read the same, so the answer can't be used
        // to learn which cards exist.
        if (!widget) return Promise.resolve({ key, error: "This card isn't available to you.", at: at.toISOString() });
        return runGlance(widget, viewer, at);
      }),
    );
    const body: GlancesResponse = { results };
    return json(body);
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const marker = url.pathname.indexOf("/v1/");
    const route = marker >= 0 ? url.pathname.slice(marker + 4).replace(/\/+$/, "") : "";
    const method = req.method.toUpperCase();

    if (method !== "GET" && crossSite(req)) return fail(403, "forbidden", "That change came from another site.");

    let viewer: DashboardViewer | Response;
    try {
      viewer = await options.authorize(req);
    } catch (error) {
      report(error, { route: "authorize" });
      return fail(500, "internal", "Something went wrong. Try again.");
    }
    if (viewer instanceof Response) return viewer;

    try {
      if (route === "board" && method === "GET") return await getBoard(viewer);
      if (route === "layout" && method === "PUT") return await putLayout(req, viewer);
      if (route === "layout" && method === "DELETE") return await deleteLayout(viewer);
      if (route === "glances" && method === "GET") return await getGlances(url, viewer);
      if (["board", "layout", "glances"].includes(route)) return fail(405, "method_not_allowed", "Not allowed.");
      return fail(404, "not_found", "Not found.");
    } catch (error) {
      report(error, { route });
      return fail(500, "internal", "Something went wrong. Try again.");
    }
  }

  return { handle };
}

class GlanceTimeout extends Error {
  readonly name = "GlanceTimeout";
  constructor() {
    super("A dashboard card took too long to load.");
  }
}
