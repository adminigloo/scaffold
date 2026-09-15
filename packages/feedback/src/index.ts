import { and, asc, desc, eq, isNull, max } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
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

  async function authenticate(req: Request): Promise<VerifiedClientKey | Response> {
    const key = req.headers.get(CLIENT_KEY_HEADER);
    if (!key) return json({ error: `missing ${CLIENT_KEY_HEADER} header` }, 401);
    const verified = await verifyClientKey(db, key);
    return verified ?? json({ error: "unknown or revoked key" }, 401);
  }

  async function handleConfig(req: Request): Promise<Response> {
    const auth = await authenticate(req);
    if (auth instanceof Response) return auth;
    return json({ categories });
  }

  async function handleUpload(req: Request): Promise<Response> {
    const auth = await authenticate(req);
    if (auth instanceof Response) return auth;
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

    // The unique index on ticket_number is the arbiter; two concurrent
    // submits can compute the same number, so the loser retries with a fresh one.
    for (let attempt = 0; ; attempt++) {
      const ticketNumber = await nextTicketNumber();
      try {
        await db.insert(feedbackTickets).values({
          tenantId: auth.tenantId,
          ticketNumber,
          title,
          description: payload.description,
          priority: payload.priority,
          category: payload.category,
          status: "open",
          screenshotUrl: payload.screenshotUrl,
          annotatedScreenshotUrl: payload.annotatedScreenshotUrl,
          reporterName: payload.reporter?.name,
          reporterEmail: payload.reporter?.email,
          reporterTokenHash,
          pagePathname: payload.clientMetadata.pathname,
          clientMetadata: payload.clientMetadata,
          recentErrors: payload.recentErrors ?? [],
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

    // The name is whatever the ticket already carries — the token proves
    // "the person who filed this", so the reply is attributed to exactly
    // that, never to a name the request body could invent.
    const message = await addTicketMessage(db, {
      ticketId: ticket.id,
      senderType: "reporter",
      senderName: ticket.reporterName ?? ticket.reporterEmail ?? "Reporter",
      body: parsed.data.body,
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
}

/**
 * Written on first read of an empty feedback_statuses table, so installing
 * the board needs a migration and nothing else — no seed script to know
 * about. Edit the rows afterwards; the board renders whatever is there.
 */
export const DEFAULT_BOARD_STATUSES = [
  { key: "open", label: "Open", color: "#1f6fff", sortOrder: 10 },
  { key: "in_progress", label: "In progress", color: "#ff8a00", sortOrder: 20 },
  { key: "resolved", label: "Resolved", color: "#12b23b", sortOrder: 30 },
  { key: "closed", label: "Closed", color: "#6b7280", sortOrder: 40 },
] as const;

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
    /** A reporter message the team has not opened the ticket since (0.5.0). */
    hasUnreadReporterReply: boolean;
  }>;
}

export async function listBoardData(db: FeedbackDb): Promise<BoardData> {
  let statuses: BoardStatus[] = await db
    .select({
      id: feedbackStatuses.id,
      key: feedbackStatuses.key,
      label: feedbackStatuses.label,
      color: feedbackStatuses.color,
      sortOrder: feedbackStatuses.sortOrder,
    })
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
      .select({
        id: feedbackStatuses.id,
        key: feedbackStatuses.key,
        label: feedbackStatuses.label,
        color: feedbackStatuses.color,
        sortOrder: feedbackStatuses.sortOrder,
      })
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
      lastStaffReadAt: feedbackTickets.lastStaffReadAt,
    })
    .from(feedbackTickets)
    .orderBy(desc(feedbackTickets.createdAt), desc(feedbackTickets.id))
    .limit(300);

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

  return { statuses, tickets };
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

export const createStatusSchema = z.object({
  key: statusKeySchema,
  label: z.string().min(1).max(60),
  color: z.string().max(30).nullish(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
});

/**
 * KEY IS NOT UPDATABLE, and that is the design rather than an omission:
 * tickets reference a status by its key as plain text, so renaming a key
 * would strand every ticket in a column that no longer exists. The label is
 * what people see and it changes freely; the key is an identifier.
 */
export const updateStatusSchema = z.object({
  id: z.string(),
  label: z.string().min(1).max(60).optional(),
  color: z.string().max(30).nullish(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
});

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
    .values({ key: parsed.key, label: parsed.label, color: parsed.color ?? null, sortOrder })
    .returning({
      id: feedbackStatuses.id,
      key: feedbackStatuses.key,
      label: feedbackStatuses.label,
      color: feedbackStatuses.color,
      sortOrder: feedbackStatuses.sortOrder,
    });
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
    .set({ status: input.statusKey })
    .where(eq(feedbackTickets.id, input.ticketId));
  return true;
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
