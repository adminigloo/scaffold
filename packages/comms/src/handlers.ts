import { and, count, eq, lt } from "drizzle-orm";
import { z } from "zod";
import {
  CommsHttpError,
  CROSS_SITE_MESSAGE,
  FORBIDDEN_MESSAGE,
  NOT_FOUND_MESSAGE,
  failure,
  isCrossSiteRequest as isCrossSite,
  json,
  readJsonBody,
  safeDecode,
} from "./http.js";
import {
  getTemplate,
  listMessages,
  listTemplates,
  runDueMessages,
  setTemplateActive,
  type CommsDb,
  type CommsSenders,
  type MessageRow,
  type RunDueOptions,
  type TemplateRow,
} from "./index.js";
import type { CommsPermission } from "./permissions.js";
import { templateVariables } from "./render.js";
import { COMMS_ADMIN_ROUTE_PERMISSIONS, type CommsAdminRouteKind } from "./routes.js";
import { commsScheduled, commsTemplates } from "./schema.js";
import type {
  CommsStatusWire,
  MessageStatus,
  MessageWire,
  RunDueWire,
  TemplateWire,
  TemplatesWire,
} from "./wire.js";

/**
 * The HTTP surface the Messages console (`@adminigloo/comms-widget/admin`'s
 * `<MessagesConsole>`) speaks: every route under `{base}/v1/admin/`, one
 * `handle(req)` routed by the path after `/v1/admin/` (Tenancy 2a, D3).
 *
 *   // app/api/app/[tenantId]/messages/[...path]/route.ts
 *   const { handle } = createCommsAdminHandlers({ db, senders, resolveTenant, authorize });
 *   export { handle as GET, handle as POST };
 *
 * Before 2a the console was a tRPC router plus a page copied into each
 * project, so a fix had to be hand-applied to every project. Now it is
 * package code: a fix reaches every project by `npm update`, and the emitted
 * isolation proof drives these routes like every other feature's.
 *
 * EVERY ROUTE ASKS `authorize(req, permission, tenantId)` for exactly one key
 * (COMMS_ADMIN_ROUTE_PERMISSIONS): a `Response` (a host's 401, the company
 * gate's 403) is returned as it is, `false` is 403 forbidden, `true` or
 * `{ userId }` passes.
 *
 * NEVER CROSS-ORIGIN: no CORS headers, ever, and every POST must pass the
 * same-site check.
 */

export type CommsAuthorizeResult = boolean | { userId?: string | number | null } | Response;

/** Is email really leaving, and if not, why (the console's banner). */
export interface CommsDelivery {
  readonly emails: boolean;
  readonly emailsOffReason: string | null;
}

export interface CreateCommsAdminHandlersOptions {
  db: CommsDb;
  senders: CommsSenders;
  /** A fixed tenant (a single business). Pass this or `resolveTenant`. */
  tenantId?: string;
  /** The tenant a request is for (a company id in the path). null → 404. */
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  authorize: (req: Request, permission: CommsPermission, tenantId: string) => CommsAuthorizeResult | Promise<CommsAuthorizeResult>;
  /** Before templates are listed: add this tenant's templates if absent (comms' defaults and every feature's), never over an edit. */
  ensureTemplates?: (tenantId: string) => Promise<void>;
  /** "Send due now" runs through the cron's own hooks. */
  beforeSend?: RunDueOptions["beforeSend"];
  /** Run in a `finally` after "Send due now" (the features' link scrub). */
  afterRun?: () => Promise<void>;
  /** Is email really leaving, and if not, why (the console's banner). Default: emails on when `senders.email` exists. */
  delivery?: (tenantId: string) => CommsDelivery | Promise<CommsDelivery>;
  onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
  now?: () => Date;
}

export interface CommsAdminHandlers {
  handle: (req: Request) => Promise<Response>;
}

interface Matched {
  kind: CommsAdminRouteKind;
  key?: string;
}

/** The route a path names, whatever the method, and the method it takes. */
function route(pathname: string): { matched: Matched; method: "GET" | "POST" } | null {
  const path = pathname.replace(/\/+$/, "");
  const at = path.lastIndexOf("/v1/admin/");
  if (at < 0) return null;
  const parts = path.slice(at + "/v1/admin/".length).split("/").map(safeDecode);
  if (parts.some((part) => part === "")) return null;
  const [head, key, action] = parts;
  switch (head) {
    case "status":
      return parts.length === 1 ? { matched: { kind: "status" }, method: "GET" } : null;
    case "messages":
      return parts.length === 1 ? { matched: { kind: "messages" }, method: "GET" } : null;
    case "run-due":
      return parts.length === 1 ? { matched: { kind: "run-due" }, method: "POST" } : null;
    case "templates":
      if (parts.length === 1) return { matched: { kind: "templates" }, method: "GET" };
      if (parts.length === 2) return { matched: { kind: "template-save", key: key as string }, method: "POST" };
      if (parts.length === 3 && action === "active") {
        return { matched: { kind: "template-active", key: key as string }, method: "POST" };
      }
      return null;
    default:
      return null;
  }
}

const templateBodySchema = z.object({
  subject: z.string().max(300, "Keep the subject under 300 characters.").nullable().optional(),
  body: z.string().min(1, "Write the message.").max(20_000, "Keep the message under 20,000 characters."),
});
const activeBodySchema = z.object({ active: z.boolean() });
const limitSchema = z.coerce.number().int().min(1).max(200);

/** A pending row this far past its sendAt means the daily job isn't running. */
const LATE_AFTER_MS = 26 * 60 * 60 * 1000;
/** A pending row this far past its sendAt missed the run it was queued for. */
const BEHIND_AFTER_MS = 60 * 60 * 1000;

const MESSAGE_STATUSES: readonly MessageStatus[] = ["sent", "skipped", "failed", "cancelled", "expired"];

function templateToWire(row: TemplateRow): TemplateWire {
  // First-seen order across the subject then the body, each name once.
  const variables: string[] = [];
  for (const name of [...templateVariables(row.subject ?? ""), ...templateVariables(row.body)]) {
    if (!variables.includes(name)) variables.push(name);
  }
  return {
    key: row.key,
    channel: row.channel === "sms" ? "sms" : "email",
    subject: row.subject ?? null,
    body: row.body,
    active: row.isActive,
    updatedAt: row.updatedAt.toISOString(),
    variables,
  };
}

function messageToWire(row: MessageRow): MessageWire {
  const status = (MESSAGE_STATUSES as readonly string[]).includes(row.status) ? (row.status as MessageStatus) : "failed";
  return {
    id: row.id,
    at: row.createdAt.toISOString(),
    channel: row.channel === "sms" ? "sms" : "email",
    to: row.toAddress,
    templateKey: row.templateKey ?? null,
    subject: row.subject ?? null,
    status,
    note: status === "sent" ? null : (row.error ?? null),
    blanks: row.missingVars ?? [],
    fromName: row.fromName ?? null,
    replyTo: row.replyTo ?? null,
  };
}

export function createCommsAdminHandlers(options: CreateCommsAdminHandlersOptions): CommsAdminHandlers {
  if (!options.tenantId && !options.resolveTenant) {
    throw new Error("createCommsAdminHandlers: pass tenantId or resolveTenant");
  }
  if (typeof options.authorize !== "function") {
    throw new Error("createCommsAdminHandlers: pass authorize (your permission check)");
  }
  const clock = () => options.now?.() ?? new Date();
  const notFound = () => new CommsHttpError("not_found", NOT_FOUND_MESSAGE);
  const report = (error: unknown, tenantId: string | null, kind: string) => {
    try {
      options.onError?.(error, { tenantId, route: kind });
    } catch {
      /* a broken reporter must not turn a handled answer into a crash */
    }
  };

  async function status(tenantId: string): Promise<CommsStatusWire> {
    const delivery: CommsDelivery = options.delivery
      ? await options.delivery(tenantId)
      : options.senders.email
        ? { emails: true, emailsOffReason: null }
        : {
            emails: false,
            emailsOffReason: "This site doesn't send email yet, so messages are recorded here but not sent.",
          };
    // Who customers see the emails from. A throw is reported and shown as
    // "the site's defaults" (both null): the banner is a status line, and a
    // broken lookup must not take the whole console down with it.
    let fromName: string | null = null;
    let replyTo: string | null = null;
    try {
      const identity = await options.senders.identity?.(tenantId);
      fromName = typeof identity?.name === "string" && identity.name.trim() !== "" ? identity.name.trim() : null;
      replyTo = typeof identity?.replyTo === "string" && identity.replyTo.trim() !== "" ? identity.replyTo.trim() : null;
    } catch (error) {
      report(error, tenantId, "status");
    }
    const now = clock();
    const pendingFor = and(eq(commsScheduled.tenantId, tenantId), eq(commsScheduled.status, "pending"));
    const [pending] = (await options.db.select({ n: count() }).from(commsScheduled).where(pendingFor)) as { n: number }[];
    const [late] = (await options.db
      .select({ n: count() })
      .from(commsScheduled)
      .where(and(pendingFor, lt(commsScheduled.sendAt, new Date(now.getTime() - LATE_AFTER_MS))))) as { n: number }[];
    // Due over an hour ago and still pending: it MISSED a run (review
    // SEC-2A-01). Every reminder is queued for a run time, so on a working
    // schedule nothing waits past its run for long; a count here means the
    // job ran out of time before reaching it, and the owner should hear it.
    const [behind] = (await options.db
      .select({ n: count() })
      .from(commsScheduled)
      .where(and(pendingFor, lt(commsScheduled.sendAt, new Date(now.getTime() - BEHIND_AFTER_MS))))) as { n: number }[];
    const lateCount = Number(late?.n ?? 0);
    return {
      emails: delivery.emails,
      emailsOffReason: delivery.emails ? null : (delivery.emailsOffReason ?? null),
      fromName,
      replyTo,
      // `behind` excludes the late ones, so the console never says both about one message.
      scheduled: { pending: Number(pending?.n ?? 0), behind: Math.max(0, Number(behind?.n ?? 0) - lateCount), late: lateCount },
    };
  }

  async function dispatch(req: Request, matched: Matched, tenantId: string): Promise<Response> {
    const db = options.db;
    switch (matched.kind) {
      case "status":
        return json(await status(tenantId));
      case "templates": {
        if (options.ensureTemplates) {
          // A failed backfill is reported and the list still shows what the
          // company has: the console is how an owner SEES what is wrong.
          try {
            await options.ensureTemplates(tenantId);
          } catch (error) {
            report(error, tenantId, "templates");
          }
        }
        const body: TemplatesWire = { templates: (await listTemplates(db, tenantId)).map(templateToWire) };
        return json(body);
      }
      case "template-save": {
        const key = matched.key ?? "";
        const body = templateBodySchema.parse(await readJsonBody(req));
        const existing = await getTemplate(db, tenantId, key);
        if (!existing) throw notFound();
        const email = existing.channel !== "sms";
        const subject = email ? (body.subject ?? "").trim() : null;
        if (email && !subject) {
          throw new CommsHttpError("invalid", "An email needs a subject.", [
            { path: ["subject"], message: "An email needs a subject." },
          ]);
        }
        // An UPDATE of this tenant's own row, never an upsert: the console
        // edits what the company has; it doesn't create keys nobody sends.
        // The channel and the on/off switch are left as they are.
        const [row] = (await db
          .update(commsTemplates)
          .set({ subject, body: body.body, updatedAt: clock() })
          .where(and(eq(commsTemplates.tenantId, tenantId), eq(commsTemplates.key, key)))
          .returning()) as TemplateRow[];
        if (!row) throw notFound();
        return json({ template: templateToWire(row) });
      }
      case "template-active": {
        const key = matched.key ?? "";
        const body = activeBodySchema.parse(await readJsonBody(req));
        if (!(await setTemplateActive(db, tenantId, key, body.active))) throw notFound();
        const row = await getTemplate(db, tenantId, key);
        if (!row) throw notFound();
        return json({ template: templateToWire(row) });
      }
      case "messages": {
        const raw = new URL(req.url).searchParams.get("limit");
        const limit = raw === null || raw === "" ? 100 : limitSchema.safeParse(raw);
        if (typeof limit !== "number" && !limit.success) {
          throw new CommsHttpError("invalid", "Some details need another look.", [
            { path: ["limit"], message: "Ask for 1 to 200 messages." },
          ]);
        }
        const rows = await listMessages(db, tenantId, typeof limit === "number" ? limit : limit.data);
        return json({ messages: rows.map(messageToWire) });
      }
      case "run-due": {
        await readJsonBody(req);
        try {
          // Only THIS company's due rows (D10): an owner's button never sends
          // another company's reminders, whatever is due across the site.
          const result = await runDueMessages(db, options.senders, {
            now: clock(),
            tenantIds: [tenantId],
            timeBudgetMs: 20_000,
            ...(options.beforeSend ? { beforeSend: options.beforeSend } : {}),
          });
          const body: RunDueWire = {
            sent: result.sent,
            skipped: result.skipped,
            failed: result.failed,
            retrying: result.retrying,
            cancelled: result.cancelled,
            expired: result.expired,
            stoppedEarly: result.stoppedEarly,
          };
          return json(body);
        } finally {
          if (options.afterRun) {
            try {
              await options.afterRun();
            } catch (error) {
              report(error, tenantId, "run-due");
            }
          }
        }
      }
    }
  }

  async function handle(req: Request): Promise<Response> {
    // No CORS headers, ever: the staff API is same-origin only.
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    const found = route(new URL(req.url).pathname);
    if (!found) return failure(notFound());
    if (req.method !== found.method) {
      return json(
        { error: { code: "invalid", message: `Use ${found.method} for this address.` } },
        405,
        { allow: found.method },
      );
    }
    if (req.method === "POST" && isCrossSite(req)) {
      return failure(new CommsHttpError("cross_site", CROSS_SITE_MESSAGE));
    }
    let tenantId: string | null = null;
    try {
      tenantId = options.resolveTenant ? await options.resolveTenant(req) : (options.tenantId ?? null);
      if (!tenantId) return failure(notFound());
      const verdict = await options.authorize(req, COMMS_ADMIN_ROUTE_PERMISSIONS[found.matched.kind], tenantId);
      if (verdict instanceof Response) return verdict;
      if (verdict === false || verdict === null || verdict === undefined) {
        return failure(new CommsHttpError("forbidden", FORBIDDEN_MESSAGE));
      }
      return await dispatch(req, found.matched, tenantId);
    } catch (error) {
      if (!(error instanceof CommsHttpError) && !(error instanceof z.ZodError)) report(error, tenantId, found.matched.kind);
      return failure(error);
    }
  }

  return { handle };
}

