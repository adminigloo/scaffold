import { and, asc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { emitEvents, derivedOf, optionLabels } from "./events.js";
import { getEstimate, getEstimateRow, lockEstimate, QUOTE_REQUEST_NOTE, sendWarningsFor, type EstimatorWriteOptions } from "./estimates.js";
import { estimatorEstimateItems, estimatorEstimates, estimatorQuoteTokens } from "./schema.js";
import { estimatorReady, getEstimatorSettings, SETTINGS_INCOMPLETE_MESSAGE, type EstimatorSettings } from "./settings.js";
import { generateToken, hashToken, looksLikeToken } from "./tokens.js";
import { EstimatorInputError, type EstimateItemRow, type EstimateRow, type EstimatorDb } from "./types.js";
import type { PublicQuote, PublicQuoteStatus } from "./wire.js";

/**
 * Quotes (section 6.8 of the 0.3 contract): staff send a formal quote, the
 * customer opens it by a link (no account), accepts or declines it with a
 * note, and an unanswered one expires.
 *
 * THE LINK IS THE KEY. Each email mints its own token (tokens.ts); only the
 * hash is stored, several per estimate. Every link to the CURRENT version
 * works; a link from before the quote was sent again does not (review ADV-2).
 * No event carries a token: whoever sends an email mints one (`issueQuoteToken`).
 *
 * EVERY ANSWER IS ONE CONDITIONAL UPDATE (`… WHERE status IN ('sent',
 * 'viewed') AND valid_until > now AND quote_sequence = <the version the
 * customer saw> RETURNING`), so a double tap accepts once, an accept racing a
 * decline answers one of them, nothing is accepted after it expired, and
 * nobody accepts a price they were never shown.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const e = estimatorEstimates;

// --- Tokens ------------------------------------------------------------------------

/**
 * Store a fresh token's hash for an estimate (on whatever handle — a
 * transaction, say) and return the plaintext. The token carries the quote's
 * version (`quote_sequence`) it was minted for; pass it when you have the row,
 * else it is read.
 */
export async function insertQuoteToken(db: EstimatorDb, tenantId: string, estimateId: string, quoteSequence?: number): Promise<string> {
  let sequence = quoteSequence;
  if (sequence === undefined) {
    const [row] = (await db
      .select({ quoteSequence: e.quoteSequence })
      .from(e)
      .where(and(eq(e.tenantId, tenantId), eq(e.id, estimateId)))
      .limit(1)) as Array<{ quoteSequence: number }>;
    sequence = row?.quoteSequence ?? 0;
  }
  const token = generateToken();
  await db.insert(estimatorQuoteTokens).values({ tenantId, estimateId, tokenHash: await hashToken(token), quoteSequence: sequence });
  return token;
}

/** A fresh token for ONE message (or one "copy the link"); null when the estimate isn't this tenant's. */
export async function issueQuoteToken(db: EstimatorDb, tenantId: string, estimateId: string): Promise<string | null> {
  const [row] = (await db
    .select({ id: e.id, quoteSequence: e.quoteSequence })
    .from(e)
    .where(and(eq(e.tenantId, tenantId), eq(e.id, estimateId)))
    .limit(1)) as Array<{ id: string; quoteSequence: number }>;
  if (!row) return null;
  return insertQuoteToken(db, tenantId, row.id, row.quoteSequence);
}

/**
 * The estimate a token opens, for this tenant, or null. Shape first (anything
 * that isn't base64url of a sane length costs nothing), then the hash, then
 * `(tenant, hash)`, then the estimate by `(tenant, id)`. Every miss —
 * malformed, unknown, another tenant's token, a deleted estimate — is the same
 * null.
 *
 * A LINK FROM AN EARLIER SEND IS DEAD (review ADV-2). Once a quote is sent
 * again (after a revision, say, or to a corrected email address), only links
 * minted for the newest version open it: a link that went to the wrong person,
 * or an old tab, can no longer view, accept or decline the new version. A
 * resend keeps the version, so its links and the earlier ones all work. A
 * token from before tokens were versioned (null) keeps working.
 */
export async function openEstimateByToken(db: EstimatorDb, tenantId: string, token: unknown): Promise<EstimateRow | null> {
  if (!looksLikeToken(token)) return null;
  const tokenHash = await hashToken(token);
  const [found] = (await db
    .select({ estimateId: estimatorQuoteTokens.estimateId, quoteSequence: estimatorQuoteTokens.quoteSequence })
    .from(estimatorQuoteTokens)
    .where(and(eq(estimatorQuoteTokens.tenantId, tenantId), eq(estimatorQuoteTokens.tokenHash, tokenHash)))
    .limit(1)) as Array<{ estimateId: string; quoteSequence: number | null }>;
  if (!found) return null;
  const row = await getEstimateRow(db, tenantId, found.estimateId);
  if (!row) return null;
  if (found.quoteSequence !== null && found.quoteSequence < row.quoteSequence) return null;
  return row;
}

// --- Words -------------------------------------------------------------------------

function shortDate(instant: Date, settings: Pick<EstimatorSettings, "locale" | "timeZone">): string {
  try {
    return new Intl.DateTimeFormat(settings.locale, { month: "short", day: "numeric", year: "numeric", timeZone: settings.timeZone }).format(instant);
  } catch {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(instant);
  }
}

/** "Call us at (801) 555-0143" / "Email us at …" / "Get in touch with us", for a sentence that continues. */
function reachUs(settings: Pick<EstimatorSettings, "contactPhone" | "contactEmail">): string {
  const phone = settings.contactPhone?.trim();
  const email = settings.contactEmail?.trim();
  if (phone) return `Call us at ${phone}`;
  if (email) return `Email us at ${email}`;
  return "Get in touch with us";
}

function expiredRefusal(row: Pick<EstimateRow, "validUntil" | "expiredAt">, settings: EstimatorSettings): EstimatorInputError {
  const when = row.validUntil ?? row.expiredAt;
  const date = when ? ` on ${shortDate(when, settings)}` : "";
  return new EstimatorInputError("quote_expired", `This quote expired${date}. ${reachUs(settings)} for an updated one.`);
}

function answeredRefusal(answered: "accepted" | "declined", settings: EstimatorSettings): EstimatorInputError {
  return new EstimatorInputError(
    "already_answered",
    answered === "declined"
      ? `You've already declined this quote. ${reachUs(settings)} if you've changed your mind.`
      : `You've already accepted this quote. ${reachUs(settings)} if you need to change it.`,
  );
}

const UPDATING = "We're updating this quote. You'll get the new one by email.";

// --- The customer's view -------------------------------------------------------------

export function publicQuoteStatus(status: string): PublicQuoteStatus {
  switch (status) {
    case "sent":
    case "viewed":
      return "open";
    case "approved":
    case "converted":
      return "accepted";
    case "rejected":
      return "declined";
    case "expired":
      return "expired";
    default:
      return "updating";
  }
}

/**
 * What the customer's quote page shows (`PublicQuote`): the business, the
 * lines (with what was measured and the options as details), the totals with
 * tax, the dates, and whether they can still answer. Never a cost, an
 * internal note, a range or a photo.
 */
export function toPublicQuote(row: EstimateRow, items: readonly EstimateItemRow[], settings: EstimatorSettings, now: Date): PublicQuote {
  const status = publicQuoteStatus(row.status);
  return {
    status,
    version: row.quoteSequence,
    estimateId: row.id,
    number: row.estimateNumber,
    businessName: settings.businessName,
    contactEmail: settings.contactEmail,
    contactPhone: settings.contactPhone,
    brandColor: settings.brandColor,
    currency: row.currency,
    locale: settings.locale,
    timeZone: settings.timeZone,
    customerName: row.customerName,
    jobAddress: row.jobAddress,
    message: row.quoteMessage,
    footer: settings.quoteFooter,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    validUntil: row.validUntil ? row.validUntil.toISOString() : null,
    respondedAt: row.respondedAt ? row.respondedAt.toISOString() : null,
    responseName: row.responseName,
    lines: [...items]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((item) => {
        // What the price rests on ("3 steps, 7.5 in each (estimated), 23 ft
        // of ramp"), so the business can point to it when the crew measures
        // (review EST-R05); a line from before it was stored says what was asked.
        const derived = derivedOf(item);
        const summary = derived.quoteBasis ?? derived.inputsSummary;
        return {
          description: item.description,
          details: [...(summary ? [summary] : []), ...optionLabels(item)],
          quantity: item.quantity,
          total: item.total,
        };
      }),
    subtotal: row.subtotal,
    discount: row.discount,
    taxRateBp: row.taxRateBp,
    taxAmount: row.taxAmount,
    total: row.total,
    canRespond: status === "open" && row.validUntil !== null && row.validUntil.getTime() > now.getTime(),
    logoUrl: settings.logoUrl ?? null,
  };
}

async function itemsOf(db: EstimatorDb, estimateId: string): Promise<EstimateItemRow[]> {
  return (await db
    .select()
    .from(estimatorEstimateItems)
    .where(eq(estimatorEstimateItems.estimateId, estimateId))
    .orderBy(asc(estimatorEstimateItems.sortOrder))) as EstimateItemRow[];
}

// --- Send, resend, revise -------------------------------------------------------------

export const sendQuoteSchema = z.object({
  validDays: z.number().int().min(1, "Use 1 to 365 days.").max(365, "Use 1 to 365 days.").optional(),
  message: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.string().trim().max(1000, "Keep the message to 1000 characters.").nullish(),
  ),
});

/**
 * Send a DRAFT as a formal quote. Under the row lock, in one transaction: it
 * must be a draft (`not_changeable`), have lines (`empty_estimate`), have the
 * customer's email (`no_customer_email`), and every line priced
 * (`unpriced_lines`: a "quote requested" line nobody priced). Then `sent`,
 * `sent_at`, `valid_until` = now + validDays × 24 h (default the settings'),
 * `quote_sequence + 1` (it versions the follow-up), the message; an earlier
 * answer or view from before a revise is cleared. After commit, `quote.sent`
 * (via "send"): the comms listener emails the link and queues the follow-up.
 *
 * `warnings` names each line still showing a range: the quote charges its
 * point price, and staff should know which number that is.
 */
export async function sendQuote(
  db: EstimatorDb,
  tenantId: string,
  id: string,
  input: z.input<typeof sendQuoteSchema>,
  options: EstimatorWriteOptions = {},
): Promise<{ estimate: EstimateRow; warnings: string[] } | null> {
  const parsed = sendQuoteSchema.parse(input ?? {});
  const now = options.now ?? new Date();
  const settings = options.settings ?? (await getEstimatorSettings(db, tenantId));
  const validDays = parsed.validDays ?? settings.quoteValidDays;
  const result = await db.transaction(async (tx) => {
    const row = await lockEstimate(tx, tenantId, id);
    if (!row) return null;
    // Never a quote "from " nobody, at a tax rate the owner never chose (review EST-R02).
    if (!estimatorReady(settings)) throw new EstimatorInputError("settings_incomplete", SETTINGS_INCOMPLETE_MESSAGE);
    if (row.status !== "draft") {
      throw new EstimatorInputError("not_changeable", "This quote has been sent. Revise it to make changes.");
    }
    const items = await itemsOf(tx, id);
    if (items.length === 0) throw new EstimatorInputError("empty_estimate", "Add at least one line before sending.");
    if (!row.customerEmail) throw new EstimatorInputError("no_customer_email", "Add the customer's email address to send the quote.");
    const unpriced = items.filter((item) => item.notes === QUOTE_REQUEST_NOTE && !item.priceOverridden && item.total === 0);
    if (unpriced.length > 0) {
      throw new EstimatorInputError(
        "unpriced_lines",
        `Price every line before sending: ${unpriced.map((item) => item.description).join(", ")}.`,
      );
    }
    // The same words the editor showed BEFORE the send (`sendWarnings`).
    const warnings = sendWarningsFor(items, { currency: row.currency, locale: settings.locale });
    const [updated] = (await tx
      .update(e)
      .set({
        status: "sent",
        sentAt: now,
        validUntil: new Date(now.getTime() + validDays * DAY_MS),
        quoteSequence: row.quoteSequence + 1,
        quoteMessage: parsed.message ?? null,
        viewedAt: null,
        respondedAt: null,
        approvedAt: null,
        rejectedAt: null,
        expiredAt: null,
        responseName: null,
        responseNote: null,
        updatedAt: now,
      })
      .where(and(eq(e.id, id), eq(e.tenantId, tenantId)))
      .returning()) as EstimateRow[];
    return { estimate: updated as EstimateRow, warnings };
  });
  if (!result) return null;
  await emitEvents(db, tenantId, [{ type: "quote.sent", estimateId: id, actor: options.actor ?? { type: "staff", id: null }, via: "send", ...(options.notify !== undefined ? { notify: options.notify } : {}) }], {
    now,
    onEvent: options.onEvent,
    onEventError: options.onEventError,
  });
  return result;
}

/**
 * Email the quote again (a new link; the old ones keep working): sent or
 * viewed only (`not_changeable` otherwise). No sequence bump, no new validity
 * date — the follow-up already queued stays. Emits `quote.sent` (via
 * "resend").
 */
export async function resendQuote(
  db: EstimatorDb,
  tenantId: string,
  id: string,
  options: EstimatorWriteOptions = {},
): Promise<EstimateRow | null> {
  const now = options.now ?? new Date();
  const settings = options.settings ?? (await getEstimatorSettings(db, tenantId));
  const row = await db.transaction(async (tx) => {
    const locked = await lockEstimate(tx, tenantId, id);
    if (!locked) return null;
    if (!estimatorReady(settings)) throw new EstimatorInputError("settings_incomplete", SETTINGS_INCOMPLETE_MESSAGE);
    if (locked.status !== "sent" && locked.status !== "viewed") {
      throw new EstimatorInputError(
        "not_changeable",
        locked.status === "draft" ? "Send the quote first." : "Only a quote waiting for an answer can be sent again.",
      );
    }
    if (!locked.customerEmail) throw new EstimatorInputError("no_customer_email", "Add the customer's email address to send the quote.");
    const [updated] = (await tx.update(e).set({ updatedAt: now }).where(eq(e.id, id)).returning()) as EstimateRow[];
    return updated as EstimateRow;
  });
  if (!row) return null;
  await emitEvents(db, tenantId, [{ type: "quote.sent", estimateId: id, actor: options.actor ?? { type: "staff", id: null }, via: "resend", ...(options.notify !== undefined ? { notify: options.notify } : {}) }], {
    now,
    onEvent: options.onEvent,
    onEventError: options.onEventError,
  });
  return row;
}

/**
 * Take a sent quote back to change it: sent or viewed → draft
 * (`not_changeable` otherwise). Its link now says "we're updating this quote",
 * and `quote.revised` withdraws the follow-up. Send it again when it's ready.
 */
export async function reviseQuote(
  db: EstimatorDb,
  tenantId: string,
  id: string,
  options: EstimatorWriteOptions = {},
): Promise<EstimateRow | null> {
  const now = options.now ?? new Date();
  const [updated] = (await db
    .update(e)
    .set({ status: "draft", updatedAt: now })
    .where(and(eq(e.id, id), eq(e.tenantId, tenantId), inArray(e.status, ["sent", "viewed"])))
    .returning()) as EstimateRow[];
  if (!updated) {
    const row = await getEstimateRow(db, tenantId, id);
    if (!row) return null;
    throw new EstimatorInputError("not_changeable", "Only a quote waiting for an answer can be revised.");
  }
  await emitEvents(db, tenantId, [{ type: "quote.revised", estimateId: id, actor: options.actor ?? { type: "staff", id: null } }], {
    now,
    onEvent: options.onEvent,
    onEventError: options.onEventError,
  });
  return updated;
}

// --- Expiry ----------------------------------------------------------------------------

/**
 * Announce one expiry — `quote.expired` to the listener — and THEN stamp
 * `expiry_notified_at`. In that order on purpose: a run cut off between the
 * two announces it again next time (an email that can, rarely, go twice), never
 * the other way round (an expiry nobody is ever told about). The stamp is
 * conditional, so a row two runs both reach is stamped once.
 */
async function announceExpiry(db: EstimatorDb, tenantId: string, id: string, now: Date, options: Pick<EstimatorWriteOptions, "onEvent" | "onEventError">): Promise<void> {
  await emitEvents(db, tenantId, [{ type: "quote.expired", estimateId: id, actor: { type: "system", id: null } }], {
    now,
    onEvent: options.onEvent,
    onEventError: options.onEventError,
  });
  await db
    .update(e)
    .set({ expiryNotifiedAt: now })
    .where(and(eq(e.id, id), eq(e.tenantId, tenantId), isNull(e.expiryNotifiedAt)));
}

/**
 * A PAST RECORD'S EXPIRY IS HISTORY (0.7). A quote typed in from old records
 * whose time ran out before it was entered (`valid_until` before
 * `entered_at`) is stamped as announced in the same UPDATE that expires it,
 * and so is one `setEstimateStatus` stamped when it was recorded as sent
 * (`expiry_notified_at` at or after `sent_at`): the customer is never
 * emailed "your quote has expired" about a quote from last year.
 */
function expiryStamp(now: Date) {
  return sql`case when ${e.enteredAt} is not null and ${e.validUntil} < ${e.enteredAt} and ${e.expiryNotifiedAt} is null then ${now} else ${e.expiryNotifiedAt} end`;
}

/** Already announced for THIS send: stamped at or after the quote last went out. */
function announcedForThisSend(row: { expiryNotifiedAt: Date | null; sentAt: Date | null }): boolean {
  return row.expiryNotifiedAt !== null && row.sentAt !== null && row.expiryNotifiedAt.getTime() >= row.sentAt.getTime();
}

/** Expire ONE overdue quote (the sweep's UPDATE for one row); true when this call moved it. */
async function expireOne(db: EstimatorDb, tenantId: string, id: string, now: Date, options: EstimatorWriteOptions): Promise<boolean> {
  const [row] = (await db
    .update(e)
    .set({ status: "expired", expiredAt: now, updatedAt: now, expiryNotifiedAt: expiryStamp(now) })
    .where(and(eq(e.id, id), eq(e.tenantId, tenantId), inArray(e.status, ["sent", "viewed"]), lte(e.validUntil, now)))
    .returning({ id: e.id, expiryNotifiedAt: e.expiryNotifiedAt, sentAt: e.sentAt })) as Array<{
    id: string;
    expiryNotifiedAt: Date | null;
    sentAt: Date | null;
  }>;
  if (!row) return false;
  if (!announcedForThisSend(row)) await announceExpiry(db, tenantId, id, now, options);
  return true;
}

/**
 * Expire this tenant's quotes past `valid_until`, in ONE statement — the
 * overdue sent/viewed rows, oldest first, at most `limit` (100), locked
 * `FOR UPDATE SKIP LOCKED` so two runs never fight over a row — then
 * `quote.expired` for each (actor system). Called by the cron, by `POST admin
 * expire`, lazily when a quote is viewed or answered, and (throttled) by the
 * admin estimates list.
 *
 * NOTHING EXPIRES UNANNOUNCED (review ADV-7). Each expiry is announced and
 * then stamped (`expiry_notified_at`), and every run also announces the
 * expired quotes an earlier run marked but never announced — a cron killed at
 * its time limit while a slow mail server sent the third of fifty emails used
 * to leave the other forty-seven customers and the office never told. With
 * `timeBudgetMs`, a run stops announcing when the time is spent and leaves the
 * rest to the next. Expiries from before the stamp existed are backfilled by
 * the upgrade SQL, so an upgrade doesn't announce them all at once.
 */
export async function expireQuotes(
  db: EstimatorDb,
  tenantId: string,
  options: Pick<EstimatorWriteOptions, "now" | "onEvent" | "onEventError"> & { limit?: number; timeBudgetMs?: number } = {},
): Promise<{ expired: number; estimateIds: string[]; announced: number }> {
  const now = options.now ?? new Date();
  const started = Date.now();
  const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit ?? 100)));
  const overdue = db
    .select({ id: e.id })
    .from(e)
    .where(and(eq(e.tenantId, tenantId), inArray(e.status, ["sent", "viewed"]), lte(e.validUntil, now)))
    .orderBy(asc(e.validUntil))
    .limit(limit)
    .for("update", { skipLocked: true });
  const rows = (await db
    .update(e)
    .set({ status: "expired", expiredAt: now, updatedAt: now, expiryNotifiedAt: expiryStamp(now) })
    .where(and(eq(e.tenantId, tenantId), inArray(e.id, overdue)))
    .returning({ id: e.id })) as Array<{ id: string }>;
  // This run's expiries and any an earlier run left unannounced, oldest first.
  const unannounced = (await db
    .select({ id: e.id })
    .from(e)
    .where(and(eq(e.tenantId, tenantId), eq(e.status, "expired"), isNull(e.expiryNotifiedAt)))
    .orderBy(asc(e.expiredAt), asc(e.id))
    .limit(limit)) as Array<{ id: string }>;
  const budget = typeof options.timeBudgetMs === "number" && options.timeBudgetMs > 0 ? options.timeBudgetMs : 0;
  let announced = 0;
  for (const row of unannounced) {
    if (budget > 0 && Date.now() - started >= budget) break;
    await announceExpiry(db, tenantId, row.id, now, options);
    announced += 1;
  }
  return { expired: rows.length, estimateIds: rows.map((row) => row.id), announced };
}

// --- The customer opens and answers ------------------------------------------------------

/**
 * The quote a link opens, as the customer sees it; null for every miss. An
 * overdue quote is expired first (`quote.expired`), and the FIRST view of a
 * sent quote marks it `viewed` (`UPDATE … WHERE status = 'sent'`, so two tabs
 * make one move) and emits `quote.viewed`. A draft that was sent before reads
 * "updating".
 */
export async function getQuoteByToken(
  db: EstimatorDb,
  tenantId: string,
  token: unknown,
  options: EstimatorWriteOptions = {},
): Promise<PublicQuote | null> {
  let row = await openEstimateByToken(db, tenantId, token);
  if (!row) return null;
  const now = options.now ?? new Date();
  const settings = options.settings ?? (await getEstimatorSettings(db, tenantId));
  if ((row.status === "sent" || row.status === "viewed") && row.validUntil && row.validUntil.getTime() <= now.getTime()) {
    await expireOne(db, tenantId, row.id, now, options);
    row = (await getEstimateRow(db, tenantId, row.id)) ?? row;
  }
  if (row.status === "sent") {
    const [viewed] = (await db
      .update(e)
      .set({ status: "viewed", viewedAt: now, updatedAt: now })
      .where(and(eq(e.id, row.id), eq(e.tenantId, tenantId), eq(e.status, "sent"), gt(e.validUntil, now)))
      .returning()) as EstimateRow[];
    if (viewed) {
      row = viewed;
      await emitEvents(db, tenantId, [{ type: "quote.viewed", estimateId: row.id, actor: { type: "customer", id: null } }], {
        now,
        onEvent: options.onEvent,
        onEventError: options.onEventError,
      });
    }
  }
  return toPublicQuote(row, await itemsOf(db, row.id), settings, now);
}

export const acceptQuoteSchema = z.object({
  /**
   * The quote's version the customer is looking at (`PublicQuote.version`).
   * Required: an answer is only ever to the version on the customer's screen
   * (review ADV-2).
   */
  version: z.number({ message: "Reload the quote and try again." }).int().min(0),
  name: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.string().trim().max(120, "Keep your name to 120 characters.").nullish(),
  ),
  note: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.string().trim().max(1000, "Keep the note to 1000 characters.").nullish(),
  ),
});
export const declineQuoteSchema = acceptQuoteSchema.pick({ version: true, note: true });

const QUOTE_CHANGED = "This quote changed since you opened it. Here's the new one; check it before you accept.";

async function answer(
  db: EstimatorDb,
  tenantId: string,
  token: unknown,
  kind: "accept" | "decline",
  input: { version: number; name?: string | null; note?: string | null },
  options: EstimatorWriteOptions,
): Promise<PublicQuote | null> {
  const row = await openEstimateByToken(db, tenantId, token);
  if (!row) return null;
  const now = options.now ?? new Date();
  const settings = options.settings ?? (await getEstimatorSettings(db, tenantId));
  const accepted = kind === "accept";
  // The version is IN the conditional update: an accept from a page showing
  // version 1 can't land on version 2's price, whatever happened in between.
  const [updated] = (await db
    .update(e)
    .set({
      status: accepted ? "approved" : "rejected",
      respondedAt: now,
      ...(accepted ? { approvedAt: now, responseName: input.name ?? null } : { rejectedAt: now }),
      responseNote: input.note ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(e.id, row.id),
        eq(e.tenantId, tenantId),
        inArray(e.status, ["sent", "viewed"]),
        gt(e.validUntil, now),
        eq(e.quoteSequence, input.version),
      ),
    )
    .returning()) as EstimateRow[];
  if (updated) {
    await emitEvents(
      db,
      tenantId,
      [
        {
          type: accepted ? "quote.accepted" : "quote.declined",
          estimateId: row.id,
          actor: { type: "customer", id: null },
          notify: true,
          note: input.note ?? null,
        },
      ],
      { now, onEvent: options.onEvent, onEventError: options.onEventError },
    );
    return toPublicQuote(updated, await itemsOf(db, row.id), settings, now);
  }
  // Nothing moved: say why, from the row as it is now.
  const current = (await getEstimateRow(db, tenantId, row.id)) ?? row;
  const sameVersion = current.quoteSequence === input.version;
  switch (current.status) {
    case "approved":
    case "converted":
      if (accepted && sameVersion) return toPublicQuote(current, await itemsOf(db, current.id), settings, now); // a double tap
      throw answeredRefusal("accepted", settings);
    case "rejected":
      if (!accepted && sameVersion) return toPublicQuote(current, await itemsOf(db, current.id), settings, now);
      throw answeredRefusal("declined", settings);
    case "sent":
    case "viewed":
      if (!sameVersion) throw new EstimatorInputError("quote_changed", QUOTE_CHANGED);
      await expireOne(db, tenantId, current.id, now, options);
      throw expiredRefusal(current, settings);
    case "expired":
      throw expiredRefusal(current, settings);
    default:
      throw new EstimatorInputError("not_changeable", UPDATING);
  }
}

/**
 * The customer accepts the VERSION they saw, with the name they typed and an
 * optional note. One conditional UPDATE; when nothing moved: already accepted
 * → as is, no event (a double tap); declined → `already_answered`; sent again
 * since that version → `quote_changed`; past its date → expired then
 * `quote_expired`; being revised → `not_changeable`. After commit,
 * `quote.accepted` (actor customer, notify true).
 */
export async function acceptQuote(
  db: EstimatorDb,
  tenantId: string,
  token: unknown,
  input: z.input<typeof acceptQuoteSchema>,
  options: EstimatorWriteOptions = {},
): Promise<PublicQuote | null> {
  return answer(db, tenantId, token, "accept", acceptQuoteSchema.parse(input ?? {}), options);
}

/** The customer declines, with an optional note. The mirror of `acceptQuote`. */
export async function declineQuote(
  db: EstimatorDb,
  tenantId: string,
  token: unknown,
  input: z.input<typeof declineQuoteSchema>,
  options: EstimatorWriteOptions = {},
): Promise<PublicQuote | null> {
  return answer(db, tenantId, token, "decline", declineQuoteSchema.parse(input ?? {}), options);
}

/**
 * For the comms listener and tests: an estimate's public quote as it is now
 * (no view recorded). `settings` (Tenancy 2a): the settings already read, with
 * the company's basics; default: read them.
 */
export async function peekQuote(
  db: EstimatorDb,
  tenantId: string,
  id: string,
  now: Date = new Date(),
  settings?: EstimatorSettings,
): Promise<PublicQuote | null> {
  const found = await getEstimate(db, tenantId, id);
  if (!found) return null;
  return toPublicQuote(found.estimate, found.items, settings ?? (await getEstimatorSettings(db, tenantId)), now);
}
