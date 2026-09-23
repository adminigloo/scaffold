import { and, asc, desc, eq, inArray, isNull, max } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import { verifyLicense, type LicenseMode } from "@adminigloo/license";
import {
  feedbackCategories,
  feedbackClientKeys,
  feedbackMessages,
  feedbackStatuses,
  feedbackTickets,
} from "./schema.js";

/**
 * The loosest drizzle handle that can run these queries. Naming the app's
 * concrete type (`NeonDatabase<typeof schema>`) would reject every other
 * driver, every transaction handle, and every test double — the same lesson
 * @adminigloo/observability records on its ErrorReporterDb.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FeedbackDb = PgDatabase<any, any, any>;

export type { FeedbackPriority, FeedbackTicketStatus } from "./schema.js";

// ---------------------------------------------------------------------------
// Client keys — the license artifact
// ---------------------------------------------------------------------------

export const CLIENT_KEY_PREFIX = "aik_";
export const CLIENT_KEY_HEADER = "x-adminigloo-key";

function randomHexToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 20 random bytes as hex behind the prefix; the plaintext exists only in the issuance response. */
export function generateClientKey(): string {
  return randomHexToken(CLIENT_KEY_PREFIX);
}

export async function hashClientKey(key: string): Promise<string> {
  return sha256Hex(key);
}

// ---------------------------------------------------------------------------
// Reporter tokens (0.4.0) — the follow-up capability
// ---------------------------------------------------------------------------

/**
 * `aft_…` — "adminigloo feedback ticket". A DIFFERENT prefix from client keys
 * on purpose: the two secrets have wildly different blast radii (a client key
 * submits for a whole tenant; a ticket token reads one thread), and a prefix
 * is what lets a leaked string in a log be triaged at a glance.
 */
export const REPORTER_TOKEN_PREFIX = "aft_";

/**
 * Issued per ticket at submit, returned exactly once in the submit response,
 * and held only by the reporter's browser. It is a capability, not an
 * account: end users of the buyer's app have no identity here and must not
 * need one — the person most likely to report a sign-in problem is the
 * person who cannot sign in.
 */
export function generateReporterToken(): string {
  return randomHexToken(REPORTER_TOKEN_PREFIX);
}

export async function hashReporterToken(token: string): Promise<string> {
  return sha256Hex(token);
}

export interface IssuedClientKey {
  id: string;
  tenantId: string;
  label: string;
  /** The one and only time the plaintext is available. */
  key: string;
}

export async function issueClientKey(
  db: FeedbackDb,
  input: { tenantId: string; label: string },
): Promise<IssuedClientKey> {
  const key = generateClientKey();
  const keyHash = await hashClientKey(key);
  const rows = await db
    .insert(feedbackClientKeys)
    .values({ tenantId: input.tenantId, label: input.label, keyHash })
    .returning({ id: feedbackClientKeys.id });
  const row = rows[0];
  if (!row) throw new Error("key insert returned no row");
  return { id: row.id, tenantId: input.tenantId, label: input.label, key };
}

export async function revokeClientKey(db: FeedbackDb, keyId: string): Promise<void> {
  await db
    .update(feedbackClientKeys)
    .set({ revokedAt: new Date() })
    .where(eq(feedbackClientKeys.id, keyId));
}

export interface VerifiedClientKey {
  keyId: string;
  tenantId: string;
}

/** null means "present a 401", never "guess a tenant". */
export async function verifyClientKey(db: FeedbackDb, key: string): Promise<VerifiedClientKey | null> {
  if (!key.startsWith(CLIENT_KEY_PREFIX)) return null;
  const keyHash = await hashClientKey(key);
  const rows = await db
    .select({ id: feedbackClientKeys.id, tenantId: feedbackClientKeys.tenantId })
    .from(feedbackClientKeys)
    .where(and(eq(feedbackClientKeys.keyHash, keyHash), isNull(feedbackClientKeys.revokedAt)))
    .limit(1);
  const row = rows[0];
  return row ? { keyId: row.id, tenantId: row.tenantId } : null;
}

// ---------------------------------------------------------------------------
// The wire contract
// ---------------------------------------------------------------------------

/**
 * Host-pinned to our own blob store. A submit that references an arbitrary
 * URL would let one tenant serve attacker-controlled images to whoever
 * triages tickets — the same anti-phishing rule Ask Lou enforces.
 */
const uploadedUrl = z
  .string()
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname.endsWith(".public.blob.vercel-storage.com");
    } catch {
      return false;
    }
  }, "must be a URL on the app's blob store");

const sessionEvent = z.object({
  type: z.string().max(20),
  timestamp: z.number(),
  target: z.string().max(200).optional(),
  value: z.string().max(200).optional(),
});

const capturedError = z.object({
  id: z.string().max(60),
  type: z.string().max(30),
  message: z.string().max(2000),
  stack: z.string().max(8000).optional(),
  timestamp: z.number(),
  url: z.string().max(2000).optional(),
  lineNumber: z.number().optional(),
  columnNumber: z.number().optional(),
});

export const submitPayloadSchema = z.object({
  description: z.string().min(10).max(5000),
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  category: z.string().max(50).optional(),
  screenshotUrl: uploadedUrl.optional(),
  annotatedScreenshotUrl: uploadedUrl.optional(),
  reporter: z
    .object({
      name: z.string().max(120).optional(),
      email: z.string().max(255).optional(),
    })
    .optional(),
  clientMetadata: z.object({
    browser: z.string().max(60),
    os: z.string().max(60),
    viewport: z.object({ width: z.number(), height: z.number() }),
    url: z.string().max(2000),
    pathname: z.string().max(500),
    clickTrail: z.array(sessionEvent).max(50).default([]),
    sessionId: z.string().max(60),
    capturedAt: z.number(),
  }),
  recentErrors: z.array(capturedError).max(20).optional(),
});

export type SubmitPayload = z.infer<typeof submitPayloadSchema>;

/**
 * Thread requests are POST bodies rather than GET query strings, so the
 * ticket token never appears in a URL — request paths land in every hosting
 * provider's access logs, and a capability in a log line is a capability
 * whoever reads logs holds.
 */
export const threadRequestSchema = z.object({
  ticketNumber: z.string().min(1).max(20),
  ticketToken: z.string().min(1).max(100),
});

export const replyRequestSchema = threadRequestSchema.extend({
  body: z.string().min(1).max(5000),
});

export interface FeedbackCategoryOption {
  key: string;
  label: string;
  description?: string;
}

/** Ask Lou's seed list; a platform can override per install via options. */
export const DEFAULT_CATEGORIES: FeedbackCategoryOption[] = [
  { key: "bug", label: "Bug report", description: "Something is broken or behaving wrongly" },
  { key: "feature_request", label: "Feature request", description: "Something the product should do" },
  { key: "question", label: "Question", description: "Something is unclear" },
  { key: "ui_issue", label: "UI/UX issue", description: "Something looks or feels wrong" },
  { key: "performance", label: "Performance", description: "Something is slow" },
  { key: "other", label: "Other", description: "Anything else" },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const UPLOAD_KINDS = ["screenshot", "annotated"] as const;
type UploadKind = (typeof UPLOAD_KINDS)[number];

/** Vercel's serverless request-body ceiling is 4.5 MB; stop under it with a clear error. */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const UPLOAD_CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * The widget calls these endpoints from the buyer's origin, so CORS is part
 * of the contract, not middleware someone remembers to add. `*` is correct
 * here: the key does the gating and no cookies are involved.
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": `content-type, ${CLIENT_KEY_HEADER}`,
  "access-control-max-age": "86400",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

/**
 * What the intake surface can tell the rest of the platform (0.6.0). Two
 * events, because these are the two moments a human should hear about:
 * something new arrived, and somebody outside answered.
 */
export type FeedbackEvent =
  | {
      type: "ticket.created";
      ticketNumber: string;
      title: string;
      tenantId: string;
      priority: string;
    }
  | {
      type: "reporter.replied";
      ticketId: string;
      ticketNumber: string;
      title: string;
      /** The reply text, capped — a notification body, not the thread. */
      excerpt: string;
    };

export interface CreateFeedbackHandlersOptions {
  db: FeedbackDb;
  /**
   * Storage is injected, not imported: pass `@vercel/blob`'s `put` wrapped in
   * three lines. Absent, uploads answer 503 `{skipped: true}` and the widget
   * submits without the image — a missing credential degrades to a documented
   * no-op, it never throws (scaffold rule 4).
   */
  storeFile?: (path: string, file: Blob, contentType: string) => Promise<{ url: string }>;
  categories?: FeedbackCategoryOption[];
  /**
   * Fired after a ticket is created and after a reporter replies — the hook
   * a consuming app hangs its notifications on. AWAITED, so a serverless
   * response cannot end before the listener's write lands; CAUGHT, so a
   * broken listener can never fail the submit it is announcing. Wiring the
   * inbox is the consumer's business — this package refuses to know who
   * "staff" are, the same way it refuses to know a storage vendor.
   */
  onEvent?: (event: FeedbackEvent) => void | Promise<void>;
  /**
   * The AdminIgloo LICENSE gate — proves the BUYER paid AdminIgloo for the
   * feedback feature. Distinct from the `x-adminigloo-key` (aik_) client key
   * above, which authenticates the buyer's own visitors against the buyer's
   * database; this asks whether the buyer holds a license from AdminIgloo.
   *
   * OPTIONAL, AND A NO-OP UNLESS CONFIGURED. Omit it — as every install before
   * this did — and the intake behaves exactly as before. Pass the resolved
   * license env and, with `mode: "enforce"`, an authenticated request without a
   * valid license answers 402 instead of doing the work. `mode: "off"` (the
   * default a consuming app should read from ADMINIGLOO_LICENSE_MODE) allows
   * everything, so wiring this in changes nothing until the day you sell.
   *
   * The app resolves these from its validated env and passes them here, keeping
   * this package's "never read process.env" rule intact.
   */
  license?: {
    readonly key?: string | undefined;
    readonly publicKey?: string | undefined;
    readonly mode?: LicenseMode | undefined;
  };
  /**
   * Throttle the write endpoints (submit, upload, reply). OPTIONAL and a no-op
   * when omitted — so existing installs are unchanged — but strongly recommended
   * for anything sold: the client key authenticates a whole tenant's ANONYMOUS
   * visitors, so without a limit one buggy render loop or one hostile visitor can
   * mint unlimited tickets and, worse, unlimited blob uploads on the buyer's
   * storage bill. Return `{ ok: false }` to answer 429.
   *
   * Injected, not built in, for the same reason `storeFile` is: a packaged
   * serverless handler has no ambient rate-limit store, and the buyer's stack
   * (edge middleware, @adminigloo/observability, Upstash) already has one. Wire
   * it to a per-key/per-IP counter.
   */
  rateLimit?: (
    info: FeedbackRateLimitInfo,
  ) => Promise<FeedbackRateLimitDecision> | FeedbackRateLimitDecision;
}

export interface FeedbackRateLimitInfo {
  readonly action: "submit" | "upload" | "reply";
  readonly tenantId: string;
  readonly keyId: string;
  /** Best-effort client IP from forwarding headers; null if none present. */
  readonly ip: string | null;
}

export interface FeedbackRateLimitDecision {
  readonly ok: boolean;
  /** Seconds until the caller may retry; sent as the Retry-After header. */
  readonly retryAfterSeconds?: number;
}

export interface FeedbackHandlers {
  /**
   * Route by suffix: GET /v1/config, POST /v1/upload, POST /v1/submit,
   * POST /v1/thread, POST /v1/reply, OPTIONS anything.
   */
  handle: (req: Request) => Promise<Response>;
}

export function createFeedbackHandlers(options: CreateFeedbackHandlersOptions): FeedbackHandlers {
  const { db, storeFile } = options;
  const categories = options.categories ?? DEFAULT_CATEGORIES;

  async function emit(event: FeedbackEvent): Promise<void> {
    if (!options.onEvent) return;
    try {
      await options.onEvent(event);
    } catch {
      // A listener that throws must never fail the request it is
      // announcing. The event is best-effort by contract; the ticket is not.
    }
  }

  async function authenticate(req: Request): Promise<VerifiedClientKey | Response> {
    // The AdminIgloo license gate comes first: a 402 for an unlicensed buyer is
    // a different fact from a 401 for an unknown visitor key, and it should not
    // depend on the visitor key being present to be reported. A no-op unless a
    // license is configured with mode "enforce" — see the option's doc.
    if (options.license) {
      const decision = verifyLicense({ feature: "feedback", ...options.license });
      if (!decision.ok) return json({ error: decision.reason }, 402);
    }
    const key = req.headers.get(CLIENT_KEY_HEADER);
    if (!key) return json({ error: `missing ${CLIENT_KEY_HEADER} header` }, 401);
    const verified = await verifyClientKey(db, key);
    return verified ?? json({ error: "unknown or revoked key" }, 401);
  }

  /**
   * Run the injected throttle for a write action. Returns a 429 Response when
   * the caller is over the limit, or null to proceed. A no-op unless `rateLimit`
   * is configured — see the option's doc for why every sold install should be.
   */
  async function enforceRateLimit(
    action: FeedbackRateLimitInfo["action"],
    auth: VerifiedClientKey,
    req: Request,
  ): Promise<Response | null> {
    if (!options.rateLimit) return null;
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      null;
    const decision = await options.rateLimit({ action, tenantId: auth.tenantId, keyId: auth.keyId, ip });
    if (decision.ok) return null;
    const headers: Record<string, string> = { "content-type": "application/json", ...CORS_HEADERS };
    if (decision.retryAfterSeconds != null) {
      headers["retry-after"] = String(Math.max(0, Math.ceil(decision.retryAfterSeconds)));
    }
    return new Response(
      JSON.stringify({ error: "Too many requests. Please slow down and try again shortly." }),
      { status: 429, headers },
    );
  }

  async function handleConfig(req: Request): Promise<Response> {
    const auth = await authenticate(req);
    if (auth instanceof Response) return auth;
    // Configured rows win; an empty table means "the defaults", so an install
    // that never opens the category editor keeps the dropdown it always had
    // (0.7.0 — the same lazy-config contract the board's statuses set).
    const configured = await customerCategoryOptions(db);
    return json({ categories: configured.length > 0 ? configured : categories });
  }

  async function handleUpload(req: Request): Promise<Response> {
    const auth = await authenticate(req);
    if (auth instanceof Response) return auth;
    const throttled = await enforceRateLimit("upload", auth, req);
    if (throttled) return throttled;
    if (!storeFile) return json({ error: "uploads not configured", skipped: true }, 503);

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return json({ error: "expected multipart/form-data" }, 400);
    }
    const file = form.get("file");
    const kind = form.get("kind");
    if (!(file instanceof Blob)) return json({ error: "missing file field" }, 400);
    if (typeof kind !== "string" || !UPLOAD_KINDS.includes(kind as UploadKind)) {
      return json({ error: `kind must be one of: ${UPLOAD_KINDS.join(", ")}` }, 400);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return json({ error: `file exceeds ${MAX_UPLOAD_BYTES} bytes` }, 413);
    }
    const ext = UPLOAD_CONTENT_TYPES[file.type];
    if (!ext) {
      return json({ error: `content type must be one of: ${Object.keys(UPLOAD_CONTENT_TYPES).join(", ")}` }, 415);
    }

    const path = `feedback/${auth.tenantId}/${Date.now()}-${kind}.${ext}`;
    const stored = await storeFile(path, file, file.type);
    return json({ url: stored.url });
  }

  async function nextTicketNumber(): Promise<string> {
    // Lexicographic max works because numbers are zero-padded to a fixed
    // width; the unique index catches the race and the caller retries.
    const rows = await db
      .select({ ticketNumber: feedbackTickets.ticketNumber })
      .from(feedbackTickets)
      .orderBy(desc(feedbackTickets.ticketNumber))
      .limit(1);
    const last = rows[0]?.ticketNumber;
    const n = last ? Number.parseInt(last.slice(3), 10) + 1 : 1;
    return `FB-${String(n).padStart(5, "0")}`;
  }

  async function handleSubmit(req: Request): Promise<Response> {
    const auth = await authenticate(req);
    if (auth instanceof Response) return auth;
    const throttled = await enforceRateLimit("submit", auth, req);
    if (throttled) return throttled;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "expected a JSON body" }, 400);
    }
    const parsed = submitPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return json({ error: "invalid payload", issues: parsed.error.issues }, 400);
    }
    const payload = parsed.data;
    const title = (payload.description.split("\n", 1)[0] ?? "").slice(0, 100);

    // The follow-up capability, minted with the ticket. The plaintext goes
    // out in this response and nowhere else; the row keeps only the hash, the
    // same one-way promise the client keys make.
    const ticketToken = generateReporterToken();
    const reporterTokenHash = await hashReporterToken(ticketToken);
    // The landing column, resolved from the board rather than hardcoded — a
    // buyer may have renamed or removed "open", and a new ticket must reference
    // a column that exists or it lands in no column at all.
    const initialStatus = await resolveInitialStatus();

    // The unique index on ticket_number is the arbiter; two concurrent
    // submits can compute the same number, so the loser retries with a fresh one.
    for (let attempt = 0; ; attempt++) {
      const ticketNumber = await nextTicketNumber();
      try {
        const [inserted] = await db
          .insert(feedbackTickets)
          .values({
            tenantId: auth.tenantId,
            ticketNumber,
            title,
            description: payload.description,
            priority: payload.priority,
            category: payload.category,
            status: initialStatus,
            screenshotUrl: payload.screenshotUrl,
            annotatedScreenshotUrl: payload.annotatedScreenshotUrl,
            reporterName: payload.reporter?.name,
            reporterEmail: payload.reporter?.email,
            reporterTokenHash,
            pagePathname: payload.clientMetadata.pathname,
            clientMetadata: payload.clientMetadata,
            recentErrors: payload.recentErrors ?? [],
          })
          .returning({ id: feedbackTickets.id });
        // Seed the reporter's own words as the first message, so when they open
        // "My reports → thread" they see their submission rather than an empty
        // conversation and assume it never arrived. Best-effort: a ticket that
        // was created must not fail because its opening message did not.
        if (inserted?.id) {
          try {
            await addTicketMessage(db, {
              ticketId: inserted.id,
              senderType: "reporter",
              senderName: payload.reporter?.name ?? payload.reporter?.email ?? "Reporter",
              body: payload.description,
            });
          } catch {
            /* the ticket stands even if seeding its first message did not */
          }
        }
        await emit({
          type: "ticket.created",
          ticketNumber,
          title,
          tenantId: auth.tenantId,
          priority: payload.priority,
        });
        return json({ ticketNumber, ticketToken }, 201);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "23505" && attempt < 3) continue;
        throw error;
      }
    }
  }

  /**
   * The column a new ticket lands in. The first non-terminal status by sort
   * order — the leftmost real column — falling back to the first status, then to
   * "open" when the board has not been seeded yet. Never a hardcoded key that a
   * buyer may have renamed out from under it.
   */
  async function resolveInitialStatus(): Promise<string> {
    const rows = await db
      .select({ key: feedbackStatuses.key, isTerminal: feedbackStatuses.isTerminal })
      .from(feedbackStatuses)
      .orderBy(asc(feedbackStatuses.sortOrder));
    return rows.find((r) => !r.isTerminal)?.key ?? rows[0]?.key ?? "open";
  }

  /**
   * Resolve a {ticketNumber, ticketToken} pair to the ticket it authorises.
   *
   * ONE ANSWER FOR EVERY FAILURE — unknown number, another tenant's ticket, a
   * pre-0.4 ticket with no token, a wrong token — because distinct answers
   * would let anyone holding a client key enumerate which ticket numbers
   * exist and whose they are. 404 with the same body, always.
   */
  async function authorizeReporter(
    auth: VerifiedClientKey,
    input: z.infer<typeof threadRequestSchema>,
  ): Promise<
    | {
        id: string;
        ticketNumber: string;
        title: string;
        status: string;
        reporterName: string | null;
        reporterEmail: string | null;
        createdAt: Date;
      }
    | Response
  > {
    const notFound = () => json({ error: "unknown ticket" }, 404);
    const rows = await db
      .select({
        id: feedbackTickets.id,
        tenantId: feedbackTickets.tenantId,
        ticketNumber: feedbackTickets.ticketNumber,
        title: feedbackTickets.title,
        status: feedbackTickets.status,
        reporterName: feedbackTickets.reporterName,
        reporterEmail: feedbackTickets.reporterEmail,
        reporterTokenHash: feedbackTickets.reporterTokenHash,
        createdAt: feedbackTickets.createdAt,
      })
      .from(feedbackTickets)
      .where(eq(feedbackTickets.ticketNumber, input.ticketNumber))
      .limit(1);
    const ticket = rows[0];
    if (!ticket) return notFound();
    if (ticket.tenantId !== auth.tenantId) return notFound();
    if (!ticket.reporterTokenHash) return notFound();
    if ((await hashReporterToken(input.ticketToken)) !== ticket.reporterTokenHash) {
      return notFound();
    }
    return ticket;
  }

  /** Message rows a reporter may see: the conversation, minus the internal handoffs. */
  function reporterVisible(messages: TicketMessage[]): TicketMessage[] {
    // System messages are staff narration — "Assigned to X" names your
    // colleagues and your workload to someone outside the firm. The reporter
    // sees what was said TO them and BY them, nothing about the kitchen.
    return messages.filter((message) => message.senderType !== "system");
  }

  async function handleThread(req: Request): Promise<Response> {
    const auth = await authenticate(req);
    if (auth instanceof Response) return auth;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "expected a JSON body" }, 400);
    }
    const parsed = threadRequestSchema.safeParse(body);
    if (!parsed.success) {
      return json({ error: "invalid payload", issues: parsed.error.issues }, 400);
    }
    const ticket = await authorizeReporter(auth, parsed.data);
    if (ticket instanceof Response) return ticket;

    // The status LABEL rides along so the widget can say "In progress"
    // without knowing the board's configuration; the raw key would leak an
    // internal vocabulary a client may have customised.
    const statusRows = await db
      .select({ label: feedbackStatuses.label })
      .from(feedbackStatuses)
      .where(eq(feedbackStatuses.key, ticket.status))
      .limit(1);

    const messages = reporterVisible(await listTicketMessages(db, ticket.id));
    return json({
      ticket: {
        ticketNumber: ticket.ticketNumber,
        title: ticket.title,
        status: ticket.status,
        statusLabel: statusRows[0]?.label ?? ticket.status,
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
    const auth = await authenticate(req);
    if (auth instanceof Response) return auth;
    const throttled = await enforceRateLimit("reply", auth, req);
    if (throttled) return throttled;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "expected a JSON body" }, 400);
    }
    const parsed = replyRequestSchema.safeParse(body);
    if (!parsed.success) {
      return json({ error: "invalid payload", issues: parsed.error.issues }, 400);
    }
    const ticket = await authorizeReporter(auth, parsed.data);
    if (ticket instanceof Response) return ticket;

    // A reply to a CLOSED ticket lands in a terminal column nobody watches, and
    // the reporter walks away believing they re-raised the issue. Refuse it
    // plainly instead — the ticket is finished, and a new report is the way back
    // in. (Auto-reopening is a product decision left to the board owner.)
    const [statusRow] = await db
      .select({ isTerminal: feedbackStatuses.isTerminal })
      .from(feedbackStatuses)
      .where(eq(feedbackStatuses.key, ticket.status))
      .limit(1);
    if (statusRow?.isTerminal) {
      return json(
        { error: "This ticket is closed and no longer accepts replies. Submit a new report to raise it again." },
        409,
      );
    }

    // The name is whatever the ticket already carries — the token proves
    // "the person who filed this", so the reply is attributed to exactly
    // that, never to a name the request body could invent.
    const message = await addTicketMessage(db, {
      ticketId: ticket.id,
      senderType: "reporter",
      senderName: ticket.reporterName ?? ticket.reporterEmail ?? "Reporter",
      body: parsed.data.body,
    });
    await emit({
      type: "reporter.replied",
      ticketId: ticket.id,
      ticketNumber: ticket.ticketNumber,
      title: ticket.title,
      excerpt: parsed.data.body.slice(0, 140),
    });
    return json({ message }, 201);
  }

  async function handle(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const pathname = new URL(req.url).pathname;
    if (pathname.endsWith("/v1/config") && req.method === "GET") return handleConfig(req);
    if (pathname.endsWith("/v1/upload") && req.method === "POST") return handleUpload(req);
    if (pathname.endsWith("/v1/submit") && req.method === "POST") return handleSubmit(req);
    if (pathname.endsWith("/v1/thread") && req.method === "POST") return handleThread(req);
    if (pathname.endsWith("/v1/reply") && req.method === "POST") return handleReply(req);
    return json({ error: "not found" }, 404);
  }

  return { handle };
}

// ---------------------------------------------------------------------------
// The board (0.2.0) — server half. The React component is the `./board` entry.
// ---------------------------------------------------------------------------

export interface BoardStatus {
  id: string;
  key: string;
  label: string;
  color: string | null;
  sortOrder: number;
  isTerminal: boolean;
  wipLimit: number | null;
  agingWarnHours: number | null;
  agingStaleHours: number | null;
  allowAiTransition: boolean;
}

/**
 * Written on first read of an empty feedback_statuses table, so installing
 * the board needs a migration and nothing else — no seed script to know
 * about. Edit the rows afterwards; the board renders whatever is there.
 * Resolved and Closed seed as terminal: they are what "Archive Done" sweeps.
 */
export const DEFAULT_BOARD_STATUSES = [
  { key: "open", label: "Open", color: "#1f6fff", sortOrder: 10 },
  { key: "in_progress", label: "In progress", color: "#ff8a00", sortOrder: 20 },
  { key: "resolved", label: "Resolved", color: "#12b23b", sortOrder: 30, isTerminal: true },
  { key: "closed", label: "Closed", color: "#6b7280", sortOrder: 40, isTerminal: true },
] as const;

const BOARD_STATUS_COLUMNS = {
  id: feedbackStatuses.id,
  key: feedbackStatuses.key,
  label: feedbackStatuses.label,
  color: feedbackStatuses.color,
  sortOrder: feedbackStatuses.sortOrder,
  isTerminal: feedbackStatuses.isTerminal,
  wipLimit: feedbackStatuses.wipLimit,
  agingWarnHours: feedbackStatuses.agingWarnHours,
  agingStaleHours: feedbackStatuses.agingStaleHours,
  allowAiTransition: feedbackStatuses.allowAiTransition,
} as const;

export interface BoardData {
  statuses: BoardStatus[];
  tickets: Array<{
    id: string;
    ticketNumber: string;
    title: string;
    priority: string;
    category: string | null;
    status: string;
    tenantId: string;
    assignee: string | null;
    reporterName: string | null;
    reporterEmail: string | null;
    pagePathname: string | null;
    screenshotUrl: string | null;
    annotatedScreenshotUrl: string | null;
    createdAt: Date;
    /** When the ticket last changed column; null means never moved (age from createdAt). */
    statusChangedAt: Date | null;
    archivedAt: Date | null;
    archivedBy: string | null;
    /** A reporter message the team has not opened the ticket since (0.5.0). */
    hasUnreadReporterReply: boolean;
  }>;
  /**
   * How many un-archived tickets sit in terminal columns right now — the
   * number on the "Archive Done (N)" button, counted in the database rather
   * than from the capped page of tickets above.
   */
  archivableCount: number;
}

export async function listBoardData(
  db: FeedbackDb,
  options: { includeArchived?: boolean } = {},
): Promise<BoardData> {
  let statuses: BoardStatus[] = await db
    .select(BOARD_STATUS_COLUMNS)
    .from(feedbackStatuses)
    .orderBy(asc(feedbackStatuses.sortOrder));

  if (statuses.length === 0) {
    // Two concurrent first reads race this insert; the unique index on key
    // makes the loser a no-op instead of a duplicate column.
    for (const status of DEFAULT_BOARD_STATUSES) {
      try {
        await db.insert(feedbackStatuses).values(status);
      } catch (error) {
        if ((error as { code?: string }).code !== "23505") throw error;
      }
    }
    statuses = await db
      .select(BOARD_STATUS_COLUMNS)
      .from(feedbackStatuses)
      .orderBy(asc(feedbackStatuses.sortOrder));
  }

  const rows = await db
    .select({
      id: feedbackTickets.id,
      ticketNumber: feedbackTickets.ticketNumber,
      title: feedbackTickets.title,
      priority: feedbackTickets.priority,
      category: feedbackTickets.category,
      status: feedbackTickets.status,
      tenantId: feedbackTickets.tenantId,
      assignee: feedbackTickets.assignee,
      reporterName: feedbackTickets.reporterName,
      reporterEmail: feedbackTickets.reporterEmail,
      pagePathname: feedbackTickets.pagePathname,
      screenshotUrl: feedbackTickets.screenshotUrl,
      annotatedScreenshotUrl: feedbackTickets.annotatedScreenshotUrl,
      createdAt: feedbackTickets.createdAt,
      statusChangedAt: feedbackTickets.statusChangedAt,
      archivedAt: feedbackTickets.archivedAt,
      archivedBy: feedbackTickets.archivedBy,
      lastStaffReadAt: feedbackTickets.lastStaffReadAt,
    })
    .from(feedbackTickets)
    // Archived tickets leave the board by default; the eye toggle brings them
    // back greyed rather than moving them anywhere. Same rows, one predicate.
    .where(options.includeArchived ? undefined : isNull(feedbackTickets.archivedAt))
    .orderBy(desc(feedbackTickets.createdAt), desc(feedbackTickets.id))
    .limit(300);

  const terminalKeys = statuses.filter((s) => s.isTerminal).map((s) => s.key);
  const archivable =
    terminalKeys.length === 0
      ? []
      : await db
          .select({ id: feedbackTickets.id })
          .from(feedbackTickets)
          .where(
            and(
              inArray(feedbackTickets.status, terminalKeys),
              isNull(feedbackTickets.archivedAt),
            ),
          );

  // One grouped query for the whole board, not one per ticket: the latest
  // reporter message per ticket, compared against when the team last opened
  // it. Unread is a property the LIST needs, so it is computed where the
  // list is built rather than by three-hundred round trips from a client.
  const latestReplies: Array<{ ticketId: string; latest: Date | string | null }> = await db
    .select({
      ticketId: feedbackMessages.ticketId,
      latest: max(feedbackMessages.createdAt),
    })
    .from(feedbackMessages)
    .where(eq(feedbackMessages.senderType, "reporter"))
    .groupBy(feedbackMessages.ticketId);
  const latestReplyByTicket = new Map(
    latestReplies.map((row) => [
      row.ticketId,
      row.latest === null ? null : new Date(row.latest),
    ]),
  );

  const tickets = rows.map(({ lastStaffReadAt, ...ticket }) => {
    const latest = latestReplyByTicket.get(ticket.id) ?? null;
    return {
      ...ticket,
      hasUnreadReporterReply:
        latest !== null && (lastStaffReadAt === null || latest > lastStaffReadAt),
    };
  });

  return { statuses, tickets, archivableCount: archivable.length };
}

// ---------------------------------------------------------------------------
// Status administration (0.5.0) — the board's columns become editable.
// ---------------------------------------------------------------------------

/** Stable machine names only: the ticket rows reference these as plain text. */
export const statusKeySchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z][a-z0-9_]*$/, "lowercase letters, digits and underscores");

/**
 * Warn must come before stale when both are set — an amber that fires after
 * the red is a config that looks fine and behaves backwards, refused here
 * once for every surface that edits a column.
 */
function agingOrdered(input: {
  agingWarnHours?: number | null | undefined;
  agingStaleHours?: number | null | undefined;
}): boolean {
  if (input.agingWarnHours == null || input.agingStaleHours == null) return true;
  return input.agingWarnHours < input.agingStaleHours;
}

const AGING_MESSAGE = "agingWarnHours must be less than agingStaleHours";

export const createStatusSchema = z
  .object({
    key: statusKeySchema,
    label: z.string().min(1).max(60),
    color: z.string().max(30).nullish(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    isTerminal: z.boolean().optional(),
    wipLimit: z.number().int().min(1).max(9999).nullish(),
    agingWarnHours: z.number().int().min(1).max(8760).nullish(),
    agingStaleHours: z.number().int().min(1).max(8760).nullish(),
    allowAiTransition: z.boolean().optional(),
  })
  .refine(agingOrdered, { message: AGING_MESSAGE });

/**
 * KEY IS NOT UPDATABLE, and that is the design rather than an omission:
 * tickets reference a status by its key as plain text, so renaming a key
 * would strand every ticket in a column that no longer exists. The label is
 * what people see and it changes freely; the key is an identifier.
 */
export const updateStatusSchema = z
  .object({
    id: z.string(),
    label: z.string().min(1).max(60).optional(),
    color: z.string().max(30).nullish(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    isTerminal: z.boolean().optional(),
    wipLimit: z.number().int().min(1).max(9999).nullish(),
    agingWarnHours: z.number().int().min(1).max(8760).nullish(),
    agingStaleHours: z.number().int().min(1).max(8760).nullish(),
    allowAiTransition: z.boolean().optional(),
  })
  .refine(agingOrdered, { message: AGING_MESSAGE });

export async function createStatus(
  db: FeedbackDb,
  input: z.infer<typeof createStatusSchema>,
): Promise<BoardStatus> {
  const parsed = createStatusSchema.parse(input);
  const sortOrder =
    parsed.sortOrder ??
    // Default to the end of the board: the person adding a column almost
    // always means "after the ones I have", and 10-spacing leaves room to
    // reorder without renumbering everything.
    (await db
      .select({ sortOrder: feedbackStatuses.sortOrder })
      .from(feedbackStatuses)
      .orderBy(desc(feedbackStatuses.sortOrder))
      .limit(1)
      .then((rows: Array<{ sortOrder: number }>) => (rows[0]?.sortOrder ?? 0) + 10));
  const rows = await db
    .insert(feedbackStatuses)
    .values({
      key: parsed.key,
      label: parsed.label,
      color: parsed.color ?? null,
      sortOrder,
      isTerminal: parsed.isTerminal ?? false,
      wipLimit: parsed.wipLimit ?? null,
      agingWarnHours: parsed.agingWarnHours ?? null,
      agingStaleHours: parsed.agingStaleHours ?? null,
      allowAiTransition: parsed.allowAiTransition ?? false,
    })
    .returning(BOARD_STATUS_COLUMNS);
  const row = rows[0];
  if (!row) throw new Error("status insert returned no row");
  return row;
}

export async function updateStatus(
  db: FeedbackDb,
  input: z.infer<typeof updateStatusSchema>,
): Promise<void> {
  const parsed = updateStatusSchema.parse(input);
  const patch: Record<string, unknown> = {};
  if (parsed.label !== undefined) patch["label"] = parsed.label;
  if (parsed.color !== undefined) patch["color"] = parsed.color;
  if (parsed.sortOrder !== undefined) patch["sortOrder"] = parsed.sortOrder;
  if (parsed.isTerminal !== undefined) patch["isTerminal"] = parsed.isTerminal;
  if (parsed.wipLimit !== undefined) patch["wipLimit"] = parsed.wipLimit;
  if (parsed.agingWarnHours !== undefined) patch["agingWarnHours"] = parsed.agingWarnHours;
  if (parsed.agingStaleHours !== undefined) patch["agingStaleHours"] = parsed.agingStaleHours;
  if (parsed.allowAiTransition !== undefined) {
    patch["allowAiTransition"] = parsed.allowAiTransition;
  }
  if (Object.keys(patch).length === 0) return;
  await db.update(feedbackStatuses).set(patch).where(eq(feedbackStatuses.id, parsed.id));
}

export type DeleteStatusResult =
  | { deleted: true }
  | { deleted: false; reason: "unknown" | "occupied"; ticketCount?: number };

/**
 * Refuses to delete a column that holds tickets, and says how many — the
 * alternative is tickets whose status points at nothing, which vanish from
 * every column of the board while still existing in the queue. Move them
 * first; the refusal message is the instruction.
 */
export async function deleteStatus(
  db: FeedbackDb,
  statusId: string,
): Promise<DeleteStatusResult> {
  const rows = await db
    .select({ id: feedbackStatuses.id, key: feedbackStatuses.key })
    .from(feedbackStatuses)
    .where(eq(feedbackStatuses.id, statusId))
    .limit(1);
  const status = rows[0];
  if (!status) return { deleted: false, reason: "unknown" };

  const occupants = await db
    .select({ id: feedbackTickets.id })
    .from(feedbackTickets)
    .where(eq(feedbackTickets.status, status.key));
  if (occupants.length > 0) {
    return { deleted: false, reason: "occupied", ticketCount: occupants.length };
  }

  await db.delete(feedbackStatuses).where(eq(feedbackStatuses.id, statusId));
  return { deleted: true };
}

/** The full column order, as ids. Renumbers in tens so gaps stay available. */
export async function reorderStatuses(
  db: FeedbackDb,
  orderedIds: readonly string[],
): Promise<void> {
  for (const [index, id] of orderedIds.entries()) {
    await db
      .update(feedbackStatuses)
      .set({ sortOrder: (index + 1) * 10 })
      .where(eq(feedbackStatuses.id, id));
  }
}

/**
 * Stamp the ticket as seen by the team. Called when the workspace panel
 * opens; what it clears is the unread mark `listBoardData` computes.
 */
export async function markTicketRead(db: FeedbackDb, ticketId: string): Promise<void> {
  await db
    .update(feedbackTickets)
    .set({ lastStaffReadAt: new Date() })
    .where(eq(feedbackTickets.id, ticketId));
}

/**
 * The one board mutation. Returns false for an unknown status key instead of
 * writing it — a drop target that does not exist is a stale client, and a
 * silently invented status would vanish from every column.
 */
export async function moveTicket(
  db: FeedbackDb,
  input: { ticketId: string; statusKey: string },
): Promise<boolean> {
  const status = await db
    .select({ key: feedbackStatuses.key })
    .from(feedbackStatuses)
    .where(eq(feedbackStatuses.key, input.statusKey))
    .limit(1);
  if (status.length === 0) return false;
  await db
    .update(feedbackTickets)
    // The aging clock: every card ages from the moment it entered its
    // column, so a fresh move resets the dot rather than inheriting it.
    .set({ status: input.statusKey, statusChangedAt: new Date() })
    .where(eq(feedbackTickets.id, input.ticketId));
  return true;
}

/**
 * The same move, for a selection (0.7.0). One statement, not a loop of
 * `moveTicket`s: thirty tickets moving is one board event, and thirty
 * separate updates is thirty chances for a refresh to catch it half-done.
 * Unknown ids are skipped by the WHERE; the count reported is what changed.
 */
export async function moveTickets(
  db: FeedbackDb,
  input: { ticketIds: readonly string[]; statusKey: string },
): Promise<{ moved: number } | { moved: 0; reason: "unknown-status" }> {
  if (input.ticketIds.length === 0) return { moved: 0 };
  if (input.ticketIds.length > 200) {
    throw new Error("moveTickets caps at 200 ids per call");
  }
  const status = await db
    .select({ key: feedbackStatuses.key })
    .from(feedbackStatuses)
    .where(eq(feedbackStatuses.key, input.statusKey))
    .limit(1);
  if (status.length === 0) return { moved: 0, reason: "unknown-status" };
  const rows: Array<{ id: string }> = await db
    .update(feedbackTickets)
    .set({ status: input.statusKey, statusChangedAt: new Date() })
    .where(inArray(feedbackTickets.id, [...input.ticketIds]))
    .returning({ id: feedbackTickets.id });
  return { moved: rows.length };
}

// ---------------------------------------------------------------------------
// Archive (0.7.0) — the Done column stays readable in month three.
// ---------------------------------------------------------------------------

/**
 * Soft, reversible, and scoped in the WHERE: archiving an already-archived
 * ticket changes nothing, so a double-click cannot overwrite who archived it
 * first. `archivedBy` is display text, like `assignee`.
 */
export async function archiveTicket(
  db: FeedbackDb,
  input: { ticketId: string; archivedBy: string },
): Promise<boolean> {
  const rows: Array<{ id: string }> = await db
    .update(feedbackTickets)
    .set({ archivedAt: new Date(), archivedBy: input.archivedBy })
    .where(and(eq(feedbackTickets.id, input.ticketId), isNull(feedbackTickets.archivedAt)))
    .returning({ id: feedbackTickets.id });
  return rows.length > 0;
}

export async function unarchiveTicket(db: FeedbackDb, ticketId: string): Promise<boolean> {
  const rows: Array<{ id: string }> = await db
    .update(feedbackTickets)
    .set({ archivedAt: null, archivedBy: null })
    .where(eq(feedbackTickets.id, ticketId))
    .returning({ id: feedbackTickets.id });
  return rows.length > 0;
}

/**
 * "Archive Done (N)": every un-archived ticket sitting in a terminal column,
 * in one statement. Terminal is the flag on the status row, not a name — a
 * client who renamed "closed" to "shipped" gets the same sweep.
 */
export async function archiveTerminalTickets(
  db: FeedbackDb,
  input: { archivedBy: string },
): Promise<{ archived: number }> {
  const terminal: Array<{ key: string }> = await db
    .select({ key: feedbackStatuses.key })
    .from(feedbackStatuses)
    .where(eq(feedbackStatuses.isTerminal, true));
  if (terminal.length === 0) return { archived: 0 };
  const rows: Array<{ id: string }> = await db
    .update(feedbackTickets)
    .set({ archivedAt: new Date(), archivedBy: input.archivedBy })
    .where(
      and(
        inArray(
          feedbackTickets.status,
          terminal.map((row) => row.key),
        ),
        isNull(feedbackTickets.archivedAt),
      ),
    )
    .returning({ id: feedbackTickets.id });
  return { archived: rows.length };
}

// ---------------------------------------------------------------------------
// Category administration (0.7.0) — the widget's dropdown becomes rows,
// on exactly the shape the status editor set: rows are the options, the
// ticket's plain-text `category` points at `key`, delete refuses while
// occupied, and the key itself is immutable because tickets reference it.
// ---------------------------------------------------------------------------

export interface CategoryRow {
  id: string;
  key: string;
  label: string;
  description: string | null;
  sortOrder: number;
  showToCustomer: boolean;
}

const CATEGORY_COLUMNS = {
  id: feedbackCategories.id,
  key: feedbackCategories.key,
  label: feedbackCategories.label,
  description: feedbackCategories.description,
  sortOrder: feedbackCategories.sortOrder,
  showToCustomer: feedbackCategories.showToCustomer,
} as const;

/** Every category, customer-visible or not — the admin editor's read. */
export async function listCategories(db: FeedbackDb): Promise<CategoryRow[]> {
  return db
    .select(CATEGORY_COLUMNS)
    .from(feedbackCategories)
    .orderBy(asc(feedbackCategories.sortOrder), asc(feedbackCategories.key));
}

/**
 * What the widget's dropdown offers, in option shape. Empty when the table
 * is empty — the caller (the /v1/config handler) falls back to the built-in
 * list then, so an install that never configures categories keeps the
 * defaults instead of losing the dropdown.
 */
export async function customerCategoryOptions(db: FeedbackDb): Promise<FeedbackCategoryOption[]> {
  const rows = await db
    .select(CATEGORY_COLUMNS)
    .from(feedbackCategories)
    .where(eq(feedbackCategories.showToCustomer, true))
    .orderBy(asc(feedbackCategories.sortOrder), asc(feedbackCategories.key));
  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    ...(row.description === null ? {} : { description: row.description }),
  }));
}

export const createCategorySchema = z.object({
  key: statusKeySchema,
  label: z.string().min(1).max(60),
  description: z.string().max(200).nullish(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  showToCustomer: z.boolean().optional(),
});

/** Key immutable, same rationale as updateStatusSchema one section up. */
export const updateCategorySchema = z.object({
  id: z.string(),
  label: z.string().min(1).max(60).optional(),
  description: z.string().max(200).nullish(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  showToCustomer: z.boolean().optional(),
});

export async function createCategory(
  db: FeedbackDb,
  input: z.infer<typeof createCategorySchema>,
): Promise<CategoryRow> {
  const parsed = createCategorySchema.parse(input);
  const sortOrder =
    parsed.sortOrder ??
    (await db
      .select({ sortOrder: feedbackCategories.sortOrder })
      .from(feedbackCategories)
      .orderBy(desc(feedbackCategories.sortOrder))
      .limit(1)
      .then((rows: Array<{ sortOrder: number }>) => (rows[0]?.sortOrder ?? 0) + 10));
  const rows = await db
    .insert(feedbackCategories)
    .values({
      key: parsed.key,
      label: parsed.label,
      description: parsed.description ?? null,
      sortOrder,
      showToCustomer: parsed.showToCustomer ?? true,
    })
    .returning(CATEGORY_COLUMNS);
  const row = rows[0];
  if (!row) throw new Error("category insert returned no row");
  return row;
}

export async function updateCategory(
  db: FeedbackDb,
  input: z.infer<typeof updateCategorySchema>,
): Promise<void> {
  const parsed = updateCategorySchema.parse(input);
  const patch: Record<string, unknown> = {};
  if (parsed.label !== undefined) patch["label"] = parsed.label;
  if (parsed.description !== undefined) patch["description"] = parsed.description;
  if (parsed.sortOrder !== undefined) patch["sortOrder"] = parsed.sortOrder;
  if (parsed.showToCustomer !== undefined) patch["showToCustomer"] = parsed.showToCustomer;
  if (Object.keys(patch).length === 0) return;
  await db.update(feedbackCategories).set(patch).where(eq(feedbackCategories.id, parsed.id));
}

export type DeleteCategoryResult =
  | { deleted: true }
  | { deleted: false; reason: "unknown" | "occupied"; ticketCount?: number };

/**
 * Refused while tickets carry the key — a deleted category would leave them
 * labelled with a word no editor can explain. Hide it from the widget with
 * showToCustomer instead; delete when its history is gone.
 */
export async function deleteCategory(
  db: FeedbackDb,
  categoryId: string,
): Promise<DeleteCategoryResult> {
  const rows = await db
    .select({ id: feedbackCategories.id, key: feedbackCategories.key })
    .from(feedbackCategories)
    .where(eq(feedbackCategories.id, categoryId))
    .limit(1);
  const category = rows[0];
  if (!category) return { deleted: false, reason: "unknown" };

  const occupants = await db
    .select({ id: feedbackTickets.id })
    .from(feedbackTickets)
    .where(eq(feedbackTickets.category, category.key));
  if (occupants.length > 0) {
    return { deleted: false, reason: "occupied", ticketCount: occupants.length };
  }

  await db.delete(feedbackCategories).where(eq(feedbackCategories.id, categoryId));
  return { deleted: true };
}

/** The full option order, as ids. Renumbers in tens so gaps stay available. */
export async function reorderCategories(
  db: FeedbackDb,
  orderedIds: readonly string[],
): Promise<void> {
  for (const [index, id] of orderedIds.entries()) {
    await db
      .update(feedbackCategories)
      .set({ sortOrder: (index + 1) * 10 })
      .where(eq(feedbackCategories.id, id));
  }
}

// ---------------------------------------------------------------------------
// The ticket workspace (0.3.0) — conversation and assignment.
// ---------------------------------------------------------------------------

export interface TicketMessage {
  id: string;
  ticketId: string;
  senderType: "staff" | "reporter" | "system";
  senderName: string;
  body: string;
  createdAt: Date;
}

/** The full conversation on one ticket, oldest first. */
export async function listTicketMessages(
  db: FeedbackDb,
  ticketId: string,
): Promise<TicketMessage[]> {
  return db
    .select({
      id: feedbackMessages.id,
      ticketId: feedbackMessages.ticketId,
      senderType: feedbackMessages.senderType,
      senderName: feedbackMessages.senderName,
      body: feedbackMessages.body,
      createdAt: feedbackMessages.createdAt,
    })
    .from(feedbackMessages)
    .where(eq(feedbackMessages.ticketId, ticketId))
    .orderBy(asc(feedbackMessages.createdAt), asc(feedbackMessages.id));
}

export const addMessageSchema = z.object({
  ticketId: z.string(),
  senderType: z.enum(["staff", "reporter", "system"]),
  senderName: z.string().min(1).max(120),
  body: z.string().min(1).max(5000),
});

export async function addTicketMessage(
  db: FeedbackDb,
  input: z.infer<typeof addMessageSchema>,
): Promise<TicketMessage> {
  const rows = await db
    .insert(feedbackMessages)
    .values(input)
    .returning({
      id: feedbackMessages.id,
      ticketId: feedbackMessages.ticketId,
      senderType: feedbackMessages.senderType,
      senderName: feedbackMessages.senderName,
      body: feedbackMessages.body,
      createdAt: feedbackMessages.createdAt,
    });
  const row = rows[0];
  if (!row) throw new Error("message insert returned no row");
  return row;
}

/**
 * Null assignee unassigns. A "system" message records the handoff in the
 * conversation itself, so the thread reads as the ticket's history without
 * joining an audit table.
 */
export async function assignTicket(
  db: FeedbackDb,
  input: { ticketId: string; assignee: string | null; actorName: string },
): Promise<void> {
  await db
    .update(feedbackTickets)
    .set({ assignee: input.assignee })
    .where(eq(feedbackTickets.id, input.ticketId));
  await addTicketMessage(db, {
    ticketId: input.ticketId,
    senderType: "system",
    senderName: input.actorName,
    body: input.assignee ? `Assigned to ${input.assignee}` : "Unassigned",
  });
}
