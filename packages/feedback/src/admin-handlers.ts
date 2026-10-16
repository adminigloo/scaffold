import { z } from "zod";
import {
  addTicketMessage,
  archiveTerminalTickets,
  archiveTicket,
  assignTicket,
  createCategory,
  createCategorySchema,
  createStatus,
  createStatusSchema,
  deleteCategory,
  deleteStatus,
  DuplicateKeyError,
  ensureFeedbackBoard,
  getTicket,
  issueClientKey,
  listBoardData,
  listCategories,
  listClientKeys,
  listColumnsWithCounts,
  listTicketMessages,
  markTicketRead,
  MAX_BULK_MOVE,
  moveTicket,
  moveTickets,
  reorderCategories,
  reorderStatuses,
  revokeClientKey,
  unarchiveTicket,
  updateCategory,
  updateCategorySchema,
  updateStatus,
  updateStatusSchema,
  type TicketDetail,
} from "./board-data.js";
import { isTenantId, type FeedbackDb, type FeedbackEvent, type FeedbackEventListener } from "./core.js";
import {
  FEEDBACK_ERROR_STATUS,
  FeedbackHttpError,
  INTERNAL_MESSAGE,
  isCrossSiteRequest,
  looksLikeAddress,
  NOT_FOUND_MESSAGE,
  readJson,
  safeDecode,
} from "./http.js";
import type { FeedbackPermission } from "./permissions.js";
import { FEEDBACK_ADMIN_ROUTE_PERMISSIONS, type FeedbackAdminRouteKind } from "./routes.js";

/**
 * The HTTP surface a company's feedback screens speak (0.10.0): every route
 * under `{base}/v1/admin/`, one `handle(req)` routed by path. The board, the
 * ticket panel, the columns, the categories and the website keys.
 *
 *   // app/api/app/[tenantId]/feedback/[...path]/route.ts
 *   const { handle } = createFeedbackAdminHandlers({ db, resolveTenant, authorize });
 *   export { handle as GET, handle as POST };
 *
 * WHOSE BOARD: the company `resolveTenant(req)` names (a companies project:
 * the id in the path), or the fixed `tenantId` (the platform's own board, a
 * single business). EVERY ROUTE ASKS `authorize(req, permission, tenantId)`
 * for exactly one of the package's keys (FEEDBACK_ADMIN_ROUTE_PERMISSIONS):
 * `false` is 403, a `Response` (a host's 401, a "not part of this company"
 * 403) is returned as it is, `true` or `{ userId }` passes.
 *
 * Every read and write below names that company (board-data.ts), so a ticket,
 * column, category or key of another company is "not found" — the same answer
 * as an id that never existed.
 *
 * NEVER CROSS-ORIGIN. No CORS headers, ever, and every POST must pass the
 * same-site check: a staff session cookie must not be usable from another site.
 */

export type FeedbackAuthorizeResult = boolean | { userId?: string | number | null } | Response;

export interface CreateFeedbackAdminHandlersOptions {
  db: FeedbackDb;
  /** The one board these handlers serve (the platform's own "*", or a single business's). */
  tenantId?: string;
  /** The company a request is for (a companies project: the id in the path). null → not found. */
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  /** Your auth: may this request do `permission` on `tenantId`'s board? */
  authorize: (
    req: Request,
    permission: FeedbackPermission,
    tenantId: string,
  ) => FeedbackAuthorizeResult | Promise<FeedbackAuthorizeResult>;
  /**
   * Who the signed-in person is, in words: the name a reporter sees on a
   * reply, and the "archived by" on a card. Derived on the server from who
   * `authorize` said is calling — never a name the browser sends. Never an
   * email address either: one that looks like an address, a throw or null is
   * the business's name (`teamName`).
   */
  staffName?: (userId: string | null, tenantId: string, req: Request) => string | null | Promise<string | null>;
  /** The business's name as its customers know it ("Green Acres"): a reply's sender when there's no person's name. Default "The team". */
  teamName?: (tenantId: string) => string | null | Promise<string | null>;
  /**
   * Told after the team replies to a reporter or moves a ticket — the hook a
   * host hangs the reporter's emails on. Awaited and caught: a broken listener
   * never fails the change it announces.
   */
  onEvent?: FeedbackEventListener;
  /** Told about an unexpected error (the answer is still a plain 500) and a listener that threw. */
  onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
  now?: () => Date;
}

export interface FeedbackAdminHandlers {
  handle: (req: Request) => Promise<Response>;
}

interface Matched {
  kind: FeedbackAdminRouteKind;
  id?: string;
}

/** A row id from the path: bounded, so a made-up one never becomes a giant WHERE. */
function idOf(part: string | undefined): string | null {
  if (part === undefined) return null;
  const decoded = safeDecode(part);
  return decoded.length > 0 && decoded.length <= 200 ? decoded : null;
}

function route(method: string, pathname: string): Matched | null {
  const path = pathname.replace(/\/+$/, "");
  const at = path.lastIndexOf("/v1/admin/");
  if (at < 0) return null;
  const parts = path.slice(at + "/v1/admin/".length).split("/");
  if (parts.some((part) => part === "")) return null;
  const [head, second, third] = parts;
  const get = method === "GET";
  const post = method === "POST";
  const id = idOf(second);
  switch (head) {
    case "board":
      return get && parts.length === 1 ? { kind: "board" } : null;
    case "archive-done":
      return post && parts.length === 1 ? { kind: "archive-done" } : null;
    case "tickets": {
      if (parts.length === 2 && second === "move") return post ? { kind: "move-many" } : null;
      if (!id) return null;
      if (parts.length === 2) return get ? { kind: "ticket-get", id } : null;
      if (parts.length !== 3) return null;
      if (third === "messages") return get ? { kind: "messages", id } : post ? { kind: "reply", id } : null;
      if (!post) return null;
      const kinds: Record<string, FeedbackAdminRouteKind> = {
        assign: "assign",
        move: "move",
        archive: "archive",
        unarchive: "unarchive",
        read: "read",
      };
      const kind = kinds[third as string];
      return kind ? { kind, id } : null;
    }
    case "columns":
      if (parts.length === 1) return get ? { kind: "columns" } : post ? { kind: "column-create" } : null;
      if (!id || !post) return null;
      if (parts.length === 2) return { kind: "column-update", id };
      return parts.length === 3 && third === "delete" ? { kind: "column-delete", id } : null;
    case "columns-order":
      return post && parts.length === 1 ? { kind: "columns-order" } : null;
    case "categories":
      if (parts.length === 1) return get ? { kind: "categories" } : post ? { kind: "category-create" } : null;
      if (!id || !post) return null;
      if (parts.length === 2) return { kind: "category-update", id };
      return parts.length === 3 && third === "delete" ? { kind: "category-delete", id } : null;
    case "categories-order":
      return post && parts.length === 1 ? { kind: "categories-order" } : null;
    case "keys":
      if (parts.length === 1) return get ? { kind: "keys" } : post ? { kind: "key-issue" } : null;
      return post && id && parts.length === 3 && third === "revoke" ? { kind: "key-revoke", id } : null;
    default:
      return null;
  }
}

// --- Bodies ----------------------------------------------------------------------

const replyBody = z.object({ body: z.string().trim().min(1, "Write a reply first.").max(5000, "Keep a reply under 5000 characters.") });
const assignBody = z.object({ assignee: z.string().trim().max(120, "Keep a name under 120 characters.").nullable() });
const moveBody = z.object({ status: z.string().min(1).max(50) });
const moveManyBody = z.object({
  ticketIds: z.array(z.string().min(1).max(200)).min(1).max(MAX_BULK_MOVE, `Move up to ${MAX_BULK_MOVE} tickets at a time.`),
  status: z.string().min(1).max(50),
});
const orderBody = z.object({ ids: z.array(z.string().min(1).max(200)).min(1).max(50) });
const keyBody = z.object({ label: z.string().trim().min(1, "Name the website this key is for.").max(80) });
const empty = z.object({}).passthrough();
// The editors' bodies: the package's schemas without the id (the id is in the path).
const columnPatch = z.object({}).passthrough();

const STALE_COLUMN = "That column isn't on this board any more. Refresh to see the board as it is.";

/** The panel's wire: the card fields plus the report and what was captured with it. */
function ticketWire(ticket: TicketDetail) {
  const { clientMetadata, recentErrors, ...card } = ticket;
  return {
    ...card,
    context: clientMetadata ?? null,
    errors: Array.isArray(recentErrors) ? recentErrors : [],
  };
}

export function createFeedbackAdminHandlers(options: CreateFeedbackAdminHandlersOptions): FeedbackAdminHandlers {
  if (!options.tenantId && !options.resolveTenant) {
    throw new Error("createFeedbackAdminHandlers: pass tenantId or resolveTenant");
  }
  if (typeof options.authorize !== "function") {
    throw new Error("createFeedbackAdminHandlers: pass authorize (your permission check)");
  }
  const db = options.db;
  const clock = () => options.now?.() ?? new Date();
  const report = (error: unknown, tenantId: string | null, where: string) => {
    try {
      options.onError?.(error, { tenantId, route: where });
    } catch {
      /* a broken reporter must not turn an answer into a crash */
    }
  };
  /** Each company's board gets its defaults once per process (and race-safely in the database). */
  const prepared = new Map<string, Promise<unknown>>();
  function prepare(tenantId: string): Promise<unknown> {
    let pending = prepared.get(tenantId);
    if (!pending) {
      pending = ensureFeedbackBoard(db, tenantId).catch((error: unknown) => {
        prepared.delete(tenantId);
        throw error;
      });
      prepared.set(tenantId, pending);
    }
    return pending;
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
    });
  }
  function failure(error: unknown): Response {
    if (error instanceof FeedbackHttpError) {
      return json(
        { error: { code: error.code, message: error.message, ...(error.issues ? { issues: error.issues } : {}) } },
        FEEDBACK_ERROR_STATUS[error.code],
      );
    }
    if (error instanceof DuplicateKeyError) {
      return json({ error: { code: "conflict", message: error.message } }, 409);
    }
    if (error instanceof z.ZodError) {
      return json({ error: { code: "invalid", message: error.issues[0]?.message ?? "Check the form and try again." } }, 400);
    }
    return json({ error: { code: "internal", message: INTERNAL_MESSAGE } }, 500);
  }
  const notFound = () => new FeedbackHttpError("not_found", NOT_FOUND_MESSAGE);

  async function emit(event: FeedbackEvent): Promise<void> {
    if (!options.onEvent) return;
    try {
      await options.onEvent(event);
    } catch (error) {
      report(error, event.tenantId, `event:${event.type}`);
    }
  }

  /** The business's own name, for a reply with no person's name to put on it. */
  async function teamNameOf(tenantId: string): Promise<string> {
    if (!options.teamName) return "The team";
    try {
      const name = (await options.teamName(tenantId))?.trim();
      return name && !looksLikeAddress(name) ? name.slice(0, 120) : "The team";
    } catch (error) {
      report(error, tenantId, "team-name");
      return "The team";
    }
  }

  /**
   * The name a reporter sees on a reply. NEVER AN EMAIL ADDRESS (0.10.0): a
   * reply's sender name is shown to the public, and someone on the team with
   * no display name would otherwise hand their sign-in address to every
   * customer they answer. An answer that looks like one is the business's
   * name instead ("Green Acres").
   */
  async function nameOf(userId: string | null, tenantId: string, req: Request): Promise<string> {
    if (!options.staffName) return teamNameOf(tenantId);
    try {
      const name = (await options.staffName(userId, tenantId, req))?.trim();
      return name && !looksLikeAddress(name) ? name.slice(0, 120) : teamNameOf(tenantId);
    } catch (error) {
      report(error, tenantId, "staff-name");
      return teamNameOf(tenantId);
    }
  }

  async function dispatch(req: Request, matched: Matched, tenantId: string, userId: string | null): Promise<Response> {
    const ticketId = matched.id ?? "";
    switch (matched.kind) {
      case "board": {
        const archived = new URL(req.url).searchParams.get("archived");
        return json(await listBoardData(db, tenantId, { includeArchived: archived === "1" || archived === "true" }));
      }
      case "ticket-get": {
        const ticket = await getTicket(db, tenantId, ticketId);
        if (!ticket) throw notFound();
        return json({ ticket: ticketWire(ticket) });
      }
      case "messages": {
        const ticket = await getTicket(db, tenantId, ticketId);
        if (!ticket) throw notFound();
        return json({ messages: await listTicketMessages(db, tenantId, ticket.id) });
      }
      case "reply": {
        const body = await readJson(req, replyBody);
        const ticket = await getTicket(db, tenantId, ticketId);
        if (!ticket) throw notFound();
        const staffName = await nameOf(userId, tenantId, req);
        const message = await addTicketMessage(db, tenantId, {
          ticketId: ticket.id,
          senderType: "staff",
          senderName: staffName,
          body: body.body,
        });
        if (!message) throw notFound();
        // Answering IS reading: the reporter's message being replied to isn't unread any more.
        await markTicketRead(db, tenantId, ticket.id, clock());
        await emit({
          type: "staff.replied",
          tenantId,
          ticketId: ticket.id,
          ticketNumber: ticket.ticketNumber,
          title: ticket.title,
          messageId: message.id,
          body: message.body,
          staffName,
          userId,
          reporterName: ticket.reporterName,
          reporterEmail: ticket.reporterEmail,
        });
        return json({ message }, 201);
      }
      case "assign": {
        const body = await readJson(req, assignBody);
        const done = await assignTicket(db, tenantId, {
          ticketId,
          assignee: body.assignee,
          actorName: await nameOf(userId, tenantId, req),
        });
        if (!done) throw notFound();
        return json({ ok: true });
      }
      case "move": {
        const body = await readJson(req, moveBody);
        const ticket = await getTicket(db, tenantId, ticketId);
        if (!ticket) throw notFound();
        const result = await moveTicket(db, tenantId, { ticketId: ticket.id, statusKey: body.status }, clock());
        if (!result.moved) {
          if (result.reason === "not-found") throw notFound();
          if (result.reason === "unknown-status") throw new FeedbackHttpError("invalid", STALE_COLUMN);
          return json({ moved: false });
        }
        await emit({
          type: "ticket.moved",
          tenantId,
          ticketId: ticket.id,
          ticketNumber: ticket.ticketNumber,
          title: ticket.title,
          fromStatus: result.from,
          toStatus: result.to.key,
          toLabel: result.to.label,
          toTerminal: result.to.isTerminal,
          userId,
          reporterName: ticket.reporterName,
          reporterEmail: ticket.reporterEmail,
        });
        return json({ moved: true });
      }
      case "move-many": {
        const body = await readJson(req, moveManyBody);
        const result = await moveTickets(db, tenantId, { ticketIds: body.ticketIds, statusKey: body.status }, clock());
        if ("reason" in result) throw new FeedbackHttpError("invalid", STALE_COLUMN);
        // The board puts back only the cards that didn't land (BulkMoveResult).
        // The answer names the ones that DID — this board's own tickets — and
        // the browser works out the rest: echoing an id that isn't this
        // board's would hand another company's id back in an answer.
        for (const moved of result.tickets) {
          const ticket = await getTicket(db, tenantId, moved.id);
          if (!ticket) continue;
          await emit({
            type: "ticket.moved",
            tenantId,
            ticketId: ticket.id,
            ticketNumber: ticket.ticketNumber,
            title: ticket.title,
            fromStatus: moved.from,
            toStatus: result.to.key,
            toLabel: result.to.label,
            toTerminal: result.to.isTerminal,
            userId,
            reporterName: ticket.reporterName,
            reporterEmail: ticket.reporterEmail,
          });
        }
        return json({ moved: result.moved, landed: result.found });
      }
      case "archive": {
        await readJson(req, empty);
        const ticket = await getTicket(db, tenantId, ticketId);
        if (!ticket) throw notFound();
        const archived = await archiveTicket(db, tenantId, { ticketId: ticket.id, archivedBy: await nameOf(userId, tenantId, req) }, clock());
        return json({ archived });
      }
      case "unarchive": {
        await readJson(req, empty);
        const done = await unarchiveTicket(db, tenantId, ticketId);
        if (!done) throw notFound();
        return json({ unarchived: true });
      }
      case "archive-done": {
        await readJson(req, empty);
        return json(await archiveTerminalTickets(db, tenantId, { archivedBy: await nameOf(userId, tenantId, req) }, clock()));
      }
      case "read": {
        await readJson(req, empty);
        const done = await markTicketRead(db, tenantId, ticketId, clock());
        if (!done) throw notFound();
        return json({ ok: true });
      }
      case "columns":
        return json({ columns: await listColumnsWithCounts(db, tenantId) });
      case "column-create": {
        const body = await readJson(req, createStatusSchema);
        return json({ column: await createStatus(db, tenantId, body) }, 201);
      }
      case "column-update": {
        const patch = await readJson(req, columnPatch);
        const parsed = updateStatusSchema.safeParse({ ...patch, id: ticketId });
        if (!parsed.success) throw new FeedbackHttpError("invalid", parsed.error.issues[0]?.message ?? "Check the form and try again.");
        if (!(await updateStatus(db, tenantId, parsed.data))) throw notFound();
        return json({ ok: true });
      }
      case "column-delete": {
        await readJson(req, empty);
        const result = await deleteStatus(db, tenantId, ticketId);
        if (result.deleted) return json({ deleted: true });
        if (result.reason === "unknown") throw notFound();
        const n = result.ticketCount ?? 0;
        throw new FeedbackHttpError("conflict", `This column holds ${n} ticket${n === 1 ? "" : "s"}. Move ${n === 1 ? "it" : "them"} to another column first.`);
      }
      case "columns-order": {
        const body = await readJson(req, orderBody);
        await reorderStatuses(db, tenantId, body.ids);
        return json({ ok: true });
      }
      case "categories":
        return json({ categories: await listCategories(db, tenantId) });
      case "category-create": {
        const body = await readJson(req, createCategorySchema);
        return json({ category: await createCategory(db, tenantId, body) }, 201);
      }
      case "category-update": {
        const patch = await readJson(req, columnPatch);
        const parsed = updateCategorySchema.safeParse({ ...patch, id: ticketId });
        if (!parsed.success) throw new FeedbackHttpError("invalid", parsed.error.issues[0]?.message ?? "Check the form and try again.");
        if (!(await updateCategory(db, tenantId, parsed.data))) throw notFound();
        return json({ ok: true });
      }
      case "category-delete": {
        await readJson(req, empty);
        const result = await deleteCategory(db, tenantId, ticketId);
        if (result.deleted) return json({ deleted: true });
        if (result.reason === "unknown") throw notFound();
        const n = result.ticketCount ?? 0;
        throw new FeedbackHttpError(
          "conflict",
          `${n} ticket${n === 1 ? " is" : "s are"} filed under this category. Hide it from customers instead, so it stays on ${n === 1 ? "that ticket" : "those tickets"}.`,
        );
      }
      case "categories-order": {
        const body = await readJson(req, orderBody);
        await reorderCategories(db, tenantId, body.ids);
        return json({ ok: true });
      }
      case "keys":
        return json({ keys: await listClientKeys(db, tenantId) });
      case "key-issue": {
        const body = await readJson(req, keyBody);
        const issued = await issueClientKey(db, { tenantId, label: body.label });
        // The key itself is in this answer and NOWHERE ELSE, ever: only its
        // hash is kept. The screen says so.
        return json({ key: { id: issued.id, label: issued.label, createdAt: clock(), revokedAt: null, secret: issued.key } }, 201);
      }
      case "key-revoke": {
        await readJson(req, empty);
        if (!(await revokeClientKey(db, tenantId, ticketId, clock()))) throw notFound();
        return json({ ok: true });
      }
    }
  }

  async function handle(req: Request): Promise<Response> {
    // No CORS headers, ever: the staff API is same-origin only.
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    if (req.method === "POST" && isCrossSiteRequest(req)) {
      return failure(new FeedbackHttpError("forbidden", "This request came from another site, so it was refused."));
    }
    const matched = route(req.method, new URL(req.url).pathname);
    if (!matched) return failure(notFound());
    let resolved: string | null = null;
    try {
      const tenantId = options.resolveTenant ? await options.resolveTenant(req) : (options.tenantId ?? null);
      resolved = tenantId;
      if (!isTenantId(tenantId)) return failure(notFound());
      const verdict = await options.authorize(req, FEEDBACK_ADMIN_ROUTE_PERMISSIONS[matched.kind], tenantId);
      if (verdict instanceof Response) return verdict;
      if (verdict === false || verdict === null || verdict === undefined) {
        return failure(new FeedbackHttpError("forbidden", "You don't have permission to do that."));
      }
      const raw = typeof verdict === "object" ? (verdict.userId ?? null) : null;
      const userId = raw === null ? null : String(raw);
      // Only after authorize passed: an anonymous request with a made-up
      // company id never writes a row (2a D11).
      await prepare(tenantId);
      return await dispatch(req, matched, tenantId, userId);
    } catch (error) {
      if (!(error instanceof FeedbackHttpError) && !(error instanceof DuplicateKeyError) && !(error instanceof z.ZodError)) {
        report(error, resolved, matched.kind);
      }
      return failure(error);
    }
  }

  return { handle };
}
