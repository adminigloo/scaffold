import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";

/**
 * The loosest drizzle handle that can run these queries. Naming the app's
 * concrete type (`NeonDatabase<typeof schema>`) would reject every other
 * driver, every transaction handle, and every test double — the same lesson
 * @adminigloo/observability records on its ErrorReporterDb.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FeedbackDb = PgDatabase<any, any, any>;

// ---------------------------------------------------------------------------
// Client keys — the website key (the license artifact)
// ---------------------------------------------------------------------------

export const CLIENT_KEY_PREFIX = "aik_";
export const CLIENT_KEY_HEADER = "x-adminigloo-key";

export function randomHexToken(prefix: string, bytes = 20): string {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  return prefix + Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
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
 * submits for a whole company; a ticket token reads one thread), and a prefix
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

// ---------------------------------------------------------------------------
// The wire contract
// ---------------------------------------------------------------------------

/**
 * A screenshot's address, as THIS board's upload route handed it back. The
 * shape is all the schema checks; the intake then keeps it only if it is one
 * of this board's own uploads (feedback_uploads), so a report can never point
 * at an address someone typed — another store, another company's picture, a
 * page made to look like one (0.10.0; 0.9 accepted any Vercel Blob store).
 */
const uploadedUrl = z.string().min(1).max(500);

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
  /**
   * A field a person never sees (0.10.0): the form renders it off screen, so
   * only something filling in every field it finds puts a value here. A
   * report with one is refused — scheduling's booking form's rule.
   */
  website: z.string().max(500).optional(),
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

/** Ask Lou's seed list; the first rows of every company's dropdown. */
export const DEFAULT_CATEGORIES: FeedbackCategoryOption[] = [
  { key: "bug", label: "Bug report", description: "Something is broken or behaving wrongly" },
  { key: "feature_request", label: "Feature request", description: "Something the product should do" },
  { key: "question", label: "Question", description: "Something is unclear" },
  { key: "ui_issue", label: "UI/UX issue", description: "Something looks or feels wrong" },
  { key: "performance", label: "Performance", description: "Something is slow" },
  { key: "other", label: "Other", description: "Anything else" },
];

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * What the feedback board can tell the rest of the platform. Every event names
 * the company (`tenantId`) whose board it happened on.
 *
 *   ticket.created     a reporter sent something new        (intake)
 *   reporter.replied   a reporter answered on their ticket  (intake)
 *   staff.replied      the team answered a reporter          (staff handlers)
 *   ticket.moved       the team moved a ticket to a column   (staff handlers)
 *
 * The first two are what the team hears about (alerts); the last two are what
 * the REPORTER hears about (the reporter emails). Fields added in 0.10.0 are
 * additions: 0.6's listeners keep compiling.
 */
export type FeedbackEvent =
  | {
      type: "ticket.created";
      tenantId: string;
      ticketId: string;
      ticketNumber: string;
      title: string;
      priority: string;
      category: string | null;
      reporterName: string | null;
      reporterEmail: string | null;
    }
  | {
      type: "reporter.replied";
      tenantId: string;
      ticketId: string;
      ticketNumber: string;
      title: string;
      /** The reply's own id: what makes "one alert per reply" a fact, not a delivery. */
      messageId: string;
      /** The reply text, capped — a notification body, not the thread. */
      excerpt: string;
      reporterName: string | null;
    }
  | {
      type: "staff.replied";
      tenantId: string;
      ticketId: string;
      ticketNumber: string;
      title: string;
      messageId: string;
      /** The whole reply, up to 5000 characters: it is the email's body. */
      body: string;
      /** Who on the team wrote it (display name). */
      staffName: string;
      userId: string | null;
      reporterName: string | null;
      reporterEmail: string | null;
    }
  | {
      type: "ticket.moved";
      tenantId: string;
      ticketId: string;
      ticketNumber: string;
      title: string;
      fromStatus: string;
      toStatus: string;
      /** What the new column is called on this company's board ("In progress"). */
      toLabel: string;
      /** The new column is a finished one ("Resolved", "Closed"). */
      toTerminal: boolean;
      userId: string | null;
      reporterName: string | null;
      reporterEmail: string | null;
    };

export type FeedbackEventListener = (event: FeedbackEvent) => void | Promise<void>;

/** Is this a usable company id? Bounded, so a made-up one can't become a giant WHERE. */
export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}
