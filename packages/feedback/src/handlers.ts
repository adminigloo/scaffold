import { verifyLicense, type LicenseMode } from "@adminigloo/license";
import {
  createTicket,
  customerCategoryOptions,
  ensureFeedbackBoard,
  findReporterTicket,
  findStatus,
  listTicketMessages,
  verifyClientKey,
  type TicketMessage,
} from "./board-data.js";
import {
  CLIENT_KEY_HEADER,
  DEFAULT_CATEGORIES,
  replyRequestSchema,
  sha256Hex,
  submitPayloadSchema,
  threadRequestSchema,
  type FeedbackCategoryOption,
  type FeedbackDb,
  type FeedbackEvent,
} from "./core.js";
import { TOO_MANY_MESSAGE } from "./limits.js";
import { feedbackMessages } from "./schema.js";
import {
  claimableUploads,
  IMAGE_EXTENSION,
  markUploadsUsed,
  recordUpload,
  sniffImage,
  type FeedbackScreenshotStore,
} from "./uploads.js";

/**
 * Is this company taking NEW feedback right now? Asked once per request,
 * after the company is known (from `resolveTenant` OR a website key) and
 * before any other work. Default: always open. (Tenancy 2a, 3.3.)
 */
export type FeedbackAdmission = { readonly open: true } | { readonly open: false; readonly message: string };

/** The sentence a closed company's widget shows when the host's admission gives none. */
export const FEEDBACK_CLOSED_MESSAGE = "This feedback form isn't taking new reports right now.";

const UPLOAD_KINDS = ["screenshot", "annotated"] as const;
type UploadKind = (typeof UPLOAD_KINDS)[number];

/** Vercel's serverless request-body ceiling is 4.5 MB; stop under it with a clear error. */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024;


/**
 * The widget calls these endpoints from the buyer's origin, so CORS is part
 * of the contract, not middleware someone remembers to add. `*` is correct
 * here: the key (or the company's web address) does the gating, and no
 * cookies are involved.
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": `content-type, ${CLIENT_KEY_HEADER}`,
  "access-control-max-age": "86400",
};

/**
 * The intake's answers. Errors stay `{ error: "<a plain sentence>" }` — the
 * shape every widget since 0.1 reads — with a `code` beside it (0.10.0) for
 * code that wants to branch. Never an object under `error`: a 0.3 widget
 * embedded on somebody's website renders that field as text.
 */
function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS, ...extra },
  });
}
function fail(status: number, code: string, error: string, extra: Record<string, unknown> = {}): Response {
  return json({ error, code, ...extra }, status);
}

export interface CreateFeedbackHandlersOptions {
  db: FeedbackDb;
  /**
   * Which company a request is for, from the request itself (0.10.0): the web
   * address in a company's public feedback page's path. Given, a request
   * needs no website key — a company's own feedback page has none to send.
   * A key sent anyway must be THAT company's, or the request is "not found".
   * Absent, every request needs a website key, which names its company (0.9's
   * behaviour). null from it is "not found".
   */
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  /**
   * Is the company taking new feedback? (Tenancy 2a, 3.3; 0.10.0.) A closed
   * company — suspended, or its plan ended — takes NO NEW TICKET (submit and
   * upload answer 409 with the admission's sentence, and config says so),
   * while a reporter can still read their ticket and reply on it: a closed
   * shop still answers the questions it already took. A throw is reported
   * (`onError`) and treated as closed: a new ticket a company can't see is
   * worse than "try again later".
   */
  admit?: (tenantId: string, req: Request) => FeedbackAdmission | Promise<FeedbackAdmission>;
  /**
   * Where screenshots are kept (0.10.0): `put`, and optionally `attach` (the
   * report arrived: put the file on its ticket) and `remove` (nobody sent a
   * report with it). With @adminigloo/storage, its `purposeStore("feedback.screenshot")`
   * keeps them private. A function picks the store per board (a company's
   * private store, the site's own board's public one); undefined for a board
   * means it takes no screenshots. Absent (and no `storeFile`), uploads answer 503
   * `{skipped: true}` and the widget submits without the image.
   */
  screenshots?: FeedbackScreenshotStore | ((tenantId: string) => FeedbackScreenshotStore | undefined);
  /**
   * 0.9's seam, kept: `@vercel/blob`'s `put` wrapped in three lines. Used
   * when `screenshots` isn't given; it can't delete, so the sweep only drops
   * its rows.
   */
  storeFile?: (path: string, file: Blob, contentType: string) => Promise<{ url: string }>;
  /** The dropdown when a company has no category rows of its own. Default: DEFAULT_CATEGORIES. */
  categories?: FeedbackCategoryOption[];
  /**
   * Fired after a ticket is created and after a reporter replies — the hook
   * a host hangs its alerts on. AWAITED, so a serverless response cannot end
   * before the listener's write lands; CAUGHT, so a broken listener can never
   * fail the submit it is announcing.
   */
  onEvent?: (event: FeedbackEvent) => void | Promise<void>;
  /**
   * The AdminIgloo LICENSE gate — proves the BUYER paid AdminIgloo for the
   * feedback feature. Distinct from the website key, which authenticates the
   * buyer's own visitors. OPTIONAL, AND A NO-OP UNLESS CONFIGURED with
   * `mode: "enforce"`, when an unlicensed install answers 402.
   */
  license?: {
    readonly key?: string | undefined;
    readonly publicKey?: string | undefined;
    readonly mode?: LicenseMode | undefined;
  };
  /**
   * Throttle the write endpoints (submit, upload, reply). OPTIONAL and a no-op
   * when omitted, but strongly recommended for anything public: anonymous
   * visitors can otherwise mint unlimited tickets and uploads. Return
   * `{ ok: false }` to answer 429.
   */
  rateLimit?: (info: FeedbackRateLimitInfo) => Promise<FeedbackRateLimitDecision> | FeedbackRateLimitDecision;
  /** Told about an unexpected error (the answer is still a plain 500), and about an admission that threw. */
  onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
}

export interface FeedbackRateLimitInfo {
  readonly action: "submit" | "upload" | "reply";
  readonly tenantId: string;
  /** The website key's id; null on a company's own feedback page, which sends none (0.10.0). */
  readonly keyId: string | null;
  /** Best-effort client IP from forwarding headers; null if none present. */
  readonly ip: string | null;
}

export interface FeedbackRateLimitDecision {
  readonly ok: boolean;
  /** Seconds until the caller may retry; sent as the Retry-After header. */
  readonly retryAfterSeconds?: number;
  /** The sentence the visitor reads (0.10.0). Default: "Too many reports at once…". */
  readonly message?: string;
}

export interface FeedbackHandlers {
  /**
   * Route by suffix: GET /v1/config, POST /v1/upload, POST /v1/submit,
   * POST /v1/thread, POST /v1/reply, OPTIONS anything.
   */
  handle: (req: Request) => Promise<Response>;
}

interface Caller {
  readonly tenantId: string;
  readonly keyId: string | null;
}

/** A plain-words refusal, thrown inside a route and answered by `handle`. */
class Refusal extends Error {
  constructor(readonly response: Response) {
    super("refused");
  }
}

/** Read a JSON body up to a cap, or refuse with a sentence. */
async function readBody(req: Request): Promise<unknown> {
  const text = await req.text().catch(() => "");
  if (text.length > MAX_JSON_BYTES) throw new Refusal(fail(413, "too_large", "That report is too large to send."));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Refusal(fail(400, "invalid", "That report couldn't be read. Please try again."));
  }
  // A NUL character can't be stored in Postgres text (0.11.0): a sentence, not a 500.
  if (text.includes("\\u0000") || text.includes("\u0000")) {
    throw new Refusal(fail(400, "invalid", "That report has a character in it that can't be saved. Type it again without it."));
  }
  return parsed;
}

export function createFeedbackHandlers(options: CreateFeedbackHandlersOptions): FeedbackHandlers {
  const { db } = options;
  // The store, either seam (0.10.0's `screenshots`, or 0.9's `storeFile`).
  const legacyStore: FeedbackScreenshotStore | undefined =
    options.storeFile
      ? {
          put: async (input) => {
            const folder = (await sha256Hex(`feedback:${input.tenantId}`)).slice(0, 16);
            const blob = new Blob([input.bytes as Uint8Array<ArrayBuffer>], { type: input.contentType });
            return { url: (await options.storeFile!(`feedback/${folder}/${input.filename}`, blob, input.contentType)).url, fileId: null };
          },
        }
      : undefined;
  const storeFor = (tenantId: string): FeedbackScreenshotStore | undefined =>
    typeof options.screenshots === "function" ? options.screenshots(tenantId) : (options.screenshots ?? legacyStore);
  const fallbackCategories = options.categories ?? DEFAULT_CATEGORIES;
  const report = (error: unknown, tenantId: string | null, route: string) => {
    try {
      options.onError?.(error, { tenantId, route });
    } catch {
      /* a broken reporter must not turn an answer into a crash */
    }
  };

  async function emit(event: FeedbackEvent): Promise<void> {
    if (!options.onEvent) return;
    try {
      await options.onEvent(event);
    } catch (error) {
      // A listener that throws must never fail the request it is announcing.
      report(error, event.tenantId, `event:${event.type}`);
    }
  }

  /**
   * Who is this request for? The license gate first (a 402 is a different
   * fact from an unknown visitor); then the company — from the request
   * (`resolveTenant`) when the host gives one, with any key sent required to
   * be that company's; else from the website key, which is then required.
   *
   * ONE "NOT FOUND" for a key under the wrong company and for an unknown web
   * address: telling them apart would confirm which keys exist.
   */
  async function identify(req: Request): Promise<Caller> {
    if (options.license) {
      const decision = verifyLicense({ feature: "feedback", ...options.license });
      if (!decision.ok) throw new Refusal(fail(402, "unlicensed", "This feedback form isn't switched on for this site."));
    }
    const key = req.headers.get(CLIENT_KEY_HEADER);
    if (options.resolveTenant) {
      const tenantId = await options.resolveTenant(req);
      if (!tenantId) throw new Refusal(fail(404, "not_found", "This feedback form isn't here."));
      if (key) {
        const verified = await verifyClientKey(db, key);
        // A key names its company; under another company's address it names
        // nothing here (2a review: the address decides, never the key).
        if (!verified || verified.tenantId !== tenantId) {
          throw new Refusal(fail(404, "not_found", "This feedback form isn't here."));
        }
        return { tenantId, keyId: verified.keyId };
      }
      return { tenantId, keyId: null };
    }
    if (!key) throw new Refusal(fail(401, "key_missing", "This feedback form is missing its website key."));
    const verified = await verifyClientKey(db, key);
    if (!verified) throw new Refusal(fail(401, "key_unknown", "This feedback form's website key isn't recognised, or was switched off."));
    return { tenantId: verified.tenantId, keyId: verified.keyId };
  }

  async function admission(caller: Caller, req: Request): Promise<FeedbackAdmission> {
    if (!options.admit) return { open: true };
    try {
      return await options.admit(caller.tenantId, req);
    } catch (error) {
      report(error, caller.tenantId, "admit");
      return { open: false, message: FEEDBACK_CLOSED_MESSAGE };
    }
  }

  async function requireOpen(caller: Caller, req: Request): Promise<void> {
    const admitted = await admission(caller, req);
    if (!admitted.open) throw new Refusal(fail(409, "feedback_closed", admitted.message || FEEDBACK_CLOSED_MESSAGE));
  }

  async function throttle(action: FeedbackRateLimitInfo["action"], caller: Caller, req: Request): Promise<void> {
    if (!options.rateLimit) return;
    // The caller as the NEAREST proxy saw it: the LAST X-Forwarded-For entry
    // (on Vercel, the caller) — scheduling's and the estimator's rule (0.10.0;
    // 0.9 took the first entry, which is whatever the caller chose to send).
    const forwarded = (req.headers.get("x-forwarded-for") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const ip = forwarded.at(-1) ?? req.headers.get("x-real-ip") ?? null;
    const decision = await options.rateLimit({ action, tenantId: caller.tenantId, keyId: caller.keyId, ip });
    if (decision.ok) return;
    const extra: Record<string, string> = {};
    if (decision.retryAfterSeconds != null) extra["retry-after"] = String(Math.max(0, Math.ceil(decision.retryAfterSeconds)));
    throw new Refusal(json({ error: decision.message || TOO_MANY_MESSAGE, code: "rate_limited" }, 429, extra));
  }

  async function handleConfig(req: Request): Promise<Response> {
    const caller = await identify(req);
    await ensureFeedbackBoard(db, caller.tenantId);
    const admitted = await admission(caller, req);
    // Configured rows win; a company with none offers the built-in list, so
    // the dropdown is never empty.
    const configured = await customerCategoryOptions(db, caller.tenantId);
    return json({
      categories: configured.length > 0 ? configured : fallbackCategories,
      // A closed company says so up front (0.10.0), so the widget can explain
      // before someone writes a whole report. Reading and replying still work.
      closed: admitted.open ? null : admitted.message || FEEDBACK_CLOSED_MESSAGE,
    });
  }

  async function handleUpload(req: Request): Promise<Response> {
    const caller = await identify(req);
    await requireOpen(caller, req);
    // A company's own feedback PAGE (no key) takes no screenshots (0.10.0):
    // its form sends none, so an upload there is somebody storing files on
    // the company's account. Only a website key's form (an app's button)
    // takes pictures.
    if (caller.keyId === null) {
      return fail(403, "uploads_off", "This feedback form doesn't take screenshots. Send the report without one.");
    }
    await throttle("upload", caller, req);
    const screenshots = storeFor(caller.tenantId);
    if (!screenshots) return json({ error: "Screenshots can't be kept here yet, so the report goes without one.", code: "uploads_off", skipped: true }, 503);

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail(400, "invalid", "That screenshot couldn't be read.");
    }
    const file = form.get("file");
    const kind = form.get("kind");
    if (!(file instanceof Blob)) return fail(400, "invalid", "There's no screenshot in that upload.");
    if (typeof kind !== "string" || !UPLOAD_KINDS.includes(kind as UploadKind)) {
      return fail(400, "invalid", "That upload isn't a screenshot this form takes.");
    }
    if (file.size > MAX_UPLOAD_BYTES) return fail(413, "too_large", "That screenshot is too large to send.");
    // THE BYTES DECIDE (0.10.0), never the type the browser declared: an HTML
    // page sent as "image/png" is refused, and what is kept is stored under
    // the type it really is.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniffImage(bytes);
    if (!type) return fail(415, "invalid", "Screenshots must be JPEG, PNG or WebP images.");

    // No company id in a stored name (2b-1 D10's rule): random, unguessable,
    // and nothing in it says whose it is.
    const name = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
    const stored = await screenshots.put({ tenantId: caller.tenantId, bytes, contentType: type, filename: `${name}-${kind}.${IMAGE_EXTENSION[type]}` });
    // Remembered, so only a report on THIS board can use it, and the sweep
    // deletes it if none does.
    await recordUpload(db, {
      tenantId: caller.tenantId,
      url: stored.url,
      fileId: stored.fileId ?? null,
      kind,
      contentType: type,
      sizeBytes: bytes.length,
    });
    return json({ url: stored.url });
  }

  async function handleSubmit(req: Request): Promise<Response> {
    const caller = await identify(req);
    await requireOpen(caller, req);
    await throttle("submit", caller, req);
    const parsed = submitPayloadSchema.safeParse(await readBody(req));
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const tooShort = first?.path[0] === "description";
      return fail(400, "invalid", tooShort ? "Please describe what happened in at least 10 characters." : "That report is missing something. Please try again.");
    }
    // The honeypot (0.10.0): a field the form keeps off screen. A person
    // never fills it.
    if (typeof parsed.data.website === "string" && parsed.data.website.trim() !== "") {
      return fail(400, "spam_suspected", "That report looked like it was sent automatically, so it wasn't sent. If you're a person, please try again.");
    }
    // Only a category this board OFFERS (0.10.0): one kept for the team's own
    // sorting can't be chosen from outside, and an unknown one is none.
    const offered = await customerCategoryOptions(db, caller.tenantId);
    const allowed = new Set((offered.length > 0 ? offered : fallbackCategories).map((option) => option.key));
    const category = parsed.data.category && allowed.has(parsed.data.category) ? parsed.data.category : undefined;
    // Only screenshots THIS board's upload route stored (0.10.0, review L1):
    // an address on another store, another company's picture, or one already
    // on a report is dropped — the report still arrives, without it.
    const claim = await claimableUploads(
      db,
      caller.tenantId,
      [parsed.data.screenshotUrl ?? "", parsed.data.annotatedScreenshotUrl ?? ""],
    );
    const keep = (url: string | undefined) => (url && claim.has(url) ? url : undefined);
    const payload = {
      ...parsed.data,
      category,
      screenshotUrl: keep(parsed.data.screenshotUrl),
      annotatedScreenshotUrl: keep(parsed.data.annotatedScreenshotUrl),
      website: undefined,
    };
    // How it arrived (0.11.0, the board's "From" filter): with a website key
    // it is the feedback button; without one, the company's own feedback page.
    const created = await createTicket(db, { tenantId: caller.tenantId, payload, source: caller.keyId ? "widget" : "page" });
    const used = [payload.screenshotUrl, payload.annotatedScreenshotUrl].flatMap((url) => (url ? [claim.get(url)!] : []));
    await markUploadsUsed(db, caller.tenantId, used.map((upload) => upload.id), created.id);
    // A private file goes on its ticket: from now on the ticket's
    // permissions decide who opens it. Best-effort: the report stands.
    const screenshots = storeFor(caller.tenantId);
    for (const upload of used) {
      if (!upload.fileId || !screenshots?.attach) continue;
      try {
        await screenshots.attach({ tenantId: caller.tenantId, fileId: upload.fileId, ticketId: created.id });
      } catch (error) {
        report(error, caller.tenantId, "attach-screenshot");
      }
    }
    await emit({
      type: "ticket.created",
      tenantId: caller.tenantId,
      ticketId: created.id,
      ticketNumber: created.ticketNumber,
      title: created.title,
      priority: parsed.data.priority,
      category: category ?? null,
      reporterName: parsed.data.reporter?.name?.trim() || null,
      reporterEmail: parsed.data.reporter?.email?.trim() || null,
    });
    return json({ ticketNumber: created.ticketNumber, ticketToken: created.ticketToken }, 201);
  }

  /** Message rows a reporter may see: the conversation, minus the board's own notes. */
  function reporterVisible(messages: TicketMessage[]): TicketMessage[] {
    // System messages are staff narration — "Assigned to X" names the team's
    // people and workload to someone outside the business.
    return messages.filter((message) => message.senderType !== "system");
  }

  const unknownTicket = () => new Refusal(fail(404, "not_found", "That ticket isn't available any more."));

  async function handleThread(req: Request): Promise<Response> {
    const caller = await identify(req);
    const parsed = threadRequestSchema.safeParse(await readBody(req));
    if (!parsed.success) return fail(400, "invalid", "That ticket couldn't be found.");
    const ticket = await findReporterTicket(db, caller.tenantId, parsed.data);
    if (!ticket) throw unknownTicket();
    // The status LABEL rides along so the widget can say "In progress"
    // without knowing the board; the raw key is the company's vocabulary.
    const status = await findStatus(db, caller.tenantId, ticket.status);
    const messages = reporterVisible(await listTicketMessages(db, caller.tenantId, ticket.id));
    return json({
      ticket: {
        ticketNumber: ticket.ticketNumber,
        title: ticket.title,
        status: ticket.status,
        statusLabel: status?.label ?? ticket.status,
        createdAt: ticket.createdAt,
      },
      messages: messages.map((message) => ({
        id: message.id,
        senderType: message.senderType,
        senderName: message.senderName,
        body: message.body,
        createdAt: message.createdAt,
      })),
    });
  }

  async function handleReply(req: Request): Promise<Response> {
    const caller = await identify(req);
    await throttle("reply", caller, req);
    const parsed = replyRequestSchema.safeParse(await readBody(req));
    if (!parsed.success) return fail(400, "invalid", "Please write a reply first.");
    const ticket = await findReporterTicket(db, caller.tenantId, parsed.data);
    if (!ticket) throw unknownTicket();

    // A reply to a FINISHED ticket lands in a column nobody watches, and the
    // reporter walks away believing they re-raised it. Refuse it plainly
    // instead — a new report is the way back in.
    const status = await findStatus(db, caller.tenantId, ticket.status);
    if (status?.isTerminal) {
      return fail(409, "ticket_closed", "This ticket is closed and no longer takes replies. Send a new report to raise it again.");
    }

    // The name is whatever the ticket already carries — the token proves
    // "the person who filed this", never a name the request could invent.
    const rows = await db
      .insert(feedbackMessages)
      .values({
        ticketId: ticket.id,
        senderType: "reporter",
        senderName: ticket.reporterName ?? ticket.reporterEmail ?? "Reporter",
        body: parsed.data.body,
      })
      .returning({
        id: feedbackMessages.id,
        senderType: feedbackMessages.senderType,
        senderName: feedbackMessages.senderName,
        body: feedbackMessages.body,
        createdAt: feedbackMessages.createdAt,
      });
    const message = rows[0];
    if (!message) throw new Error("reply insert returned no row");
    await emit({
      type: "reporter.replied",
      tenantId: caller.tenantId,
      ticketId: ticket.id,
      ticketNumber: ticket.ticketNumber,
      title: ticket.title,
      messageId: message.id,
      excerpt: parsed.data.body.slice(0, 140),
      reporterName: ticket.reporterName,
    });
    return json({ message }, 201);
  }

  async function handle(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    const pathname = new URL(req.url).pathname.replace(/\/+$/, "");
    const route =
      pathname.endsWith("/v1/config") && req.method === "GET"
        ? { name: "config", run: handleConfig }
        : pathname.endsWith("/v1/upload") && req.method === "POST"
          ? { name: "upload", run: handleUpload }
          : pathname.endsWith("/v1/submit") && req.method === "POST"
            ? { name: "submit", run: handleSubmit }
            : pathname.endsWith("/v1/thread") && req.method === "POST"
              ? { name: "thread", run: handleThread }
              : pathname.endsWith("/v1/reply") && req.method === "POST"
                ? { name: "reply", run: handleReply }
                : null;
    if (!route) return fail(404, "not_found", "This feedback form isn't here.");
    try {
      return await route.run(req);
    } catch (error) {
      if (error instanceof Refusal) return error.response;
      report(error, null, route.name);
      return fail(500, "internal", "Something went wrong sending that. Please try again.");
    }
  }

  return { handle };
}
