/**
 * The prospect's side: config, open slots, hold, book, and manage-by-token.
 * The handler factory is a thin HTTP skin over exactly these functions, so a
 * host app that wants tRPC instead of the factory calls them directly and
 * gets identical behaviour.
 *
 * EVERY CLAIM ON TIME RUNS IN ONE TRANSACTION UNDER THE HOST LOCK: hold, book
 * and reschedule each re-verify the exact start with the same engine that
 * offered it, then write — so two prospects racing for 10:00 get one booking
 * and one `slot_taken`, never two bookings. Squire's writes were
 * non-transactional and its public path had no double-booking check at all.
 *
 * TOKENS ARE CAPABILITIES. A manage token is the prospect's whole identity
 * here; an unknown or foreign token gets the same `not_found` as everything
 * else, so the routes cannot be used to probe for bookings.
 */

import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { alreadyBookedMessage, BookingError, issuesFrom } from "../errors.js";
import { HOLD_MINUTES, horizonEnd, unionSlots } from "../engine.js";
import {
  emailSchema,
  instantSchema,
  mediumSchema,
  normalizeCallingCode,
  phoneSchemaFor,
  scrubSource,
  typeKeySchema,
  type PhoneOptions,
} from "../fields.js";
import { buildHostFeed, buildIcs } from "../ics.js";
import { bookingBookings, bookingHosts, bookingTypes, type BookingMedium } from "../schema.js";
import { generateToken, hashToken, looksLikeToken } from "../tokens.js";
import { isValidTimeZone } from "../zone.js";
import {
  emit,
  eventHost,
  eventType,
  isChangeable,
  nowOf,
  recordEvent,
  tenantOf,
  toAdminBooking,
  toPublicBooking,
  type BookingContext,
  type BookingRow,
  type HostRow,
  type PublicBooking,
  type TypeRow,
} from "./context.js";
import { moveBooking } from "./move.js";
import {
  activeTypeByKey,
  assignHost,
  bookedFromHoldSince,
  deleteEventsFor,
  fetchExternalBusy,
  freeHostsAt,
  holdByTokenHash,
  hostSlots,
  liveHoldsOfSubject,
  loadSchedulingData,
  lockHosts,
  poolHosts,
} from "./slots.js";

const DAY_MS = 86_400_000;
/** Longest window one slots call may span. */
export const MAX_SLOT_WINDOW_DAYS = 31;

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new BookingError("invalid", "Some details need another look.", issuesFrom(result.error));
  return result.data;
}

async function typeById(ctx: BookingContext, typeId: string): Promise<TypeRow | null> {
  const rows: TypeRow[] = await ctx.db
    .select()
    .from(bookingTypes)
    .where(and(eq(bookingTypes.tenantId, tenantOf(ctx)), eq(bookingTypes.id, typeId)))
    .limit(1);
  return rows[0] ?? null;
}

async function hostById(ctx: BookingContext, hostId: string): Promise<HostRow | null> {
  const rows: HostRow[] = await ctx.db
    .select()
    .from(bookingHosts)
    .where(and(eq(bookingHosts.tenantId, tenantOf(ctx)), eq(bookingHosts.id, hostId)))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PublicBookingType {
  key: string;
  name: string;
  description: string;
  durationMinutes: number;
  media: BookingMedium[];
  /** No start sooner than this after now. */
  minNoticeMinutes: number;
  /** Whole days ahead in the host's zone, today included — how far the widget's date strip runs. */
  horizonDays: number;
}

export interface PublicConfig {
  sandbox: boolean;
  hostDisplayName: string;
  hostTimezone: string;
  types: PublicBookingType[];
  /**
   * Present only when the deployment set one: the calling code a phone
   * number typed without "+" is read in, so the widget checks numbers by
   * the same rule the server will.
   */
  defaultCallingCode?: string;
  /**
   * Does this deployment email the prospect? A widget written before this
   * field reads its absence as true (the old behaviour); with false it must
   * not promise a confirmation email, and should make the manage link on
   * the confirmation page the thing to keep. Describes the real deployment —
   * in sandbox mode nothing is ever sent, whatever this says.
   */
  emailsEnabled: boolean;
  /** A person to write to, when the host app chose to show one; absent/null means none. */
  contactEmail: string | null;
}

/**
 * What the widget renders before anything is picked. The host shown is the
 * first active host (oldest first) — the 0.1 contract names one host; with a
 * pool the prospect still picks a time, never a person. Only types with at
 * least one active host are offered: a type nobody can take is not bookable.
 * Notice and horizon ride along so the widget can lay out exactly the days
 * that can be booked instead of guessing from the slots it got back.
 */
export async function getPublicConfig(ctx: BookingContext): Promise<PublicConfig> {
  const tenantId = tenantOf(ctx);
  const hosts: HostRow[] = await ctx.db
    .select()
    .from(bookingHosts)
    .where(and(eq(bookingHosts.tenantId, tenantId), eq(bookingHosts.isActive, true)))
    .orderBy(asc(bookingHosts.createdAt), asc(bookingHosts.id));
  const types: TypeRow[] = await ctx.db
    .select()
    .from(bookingTypes)
    .where(and(eq(bookingTypes.tenantId, tenantId), eq(bookingTypes.isActive, true)))
    .orderBy(asc(bookingTypes.sortOrder), asc(bookingTypes.name));
  const activeIds = new Set(hosts.map((host) => host.id));
  const first = hosts[0];
  const defaultCallingCode = normalizeCallingCode(ctx.defaultCallingCode);
  return {
    sandbox: ctx.sandbox ?? false,
    hostDisplayName: first?.displayName ?? "",
    hostTimezone: first?.timezone ?? "UTC",
    types: types
      .filter((type) => (type.hostIds.length === 0 ? activeIds.size > 0 : type.hostIds.some((id) => activeIds.has(id))))
      .map((type) => ({
        key: type.key,
        name: type.name,
        description: type.description ?? "",
        durationMinutes: type.durationMinutes,
        media: type.media,
        minNoticeMinutes: type.minNoticeMinutes,
        horizonDays: type.horizonDays,
      })),
    ...(defaultCallingCode ? { defaultCallingCode } : {}),
    emailsEnabled: ctx.emailsEnabled !== false,
    contactEmail: ctx.contactEmail || null,
  };
}

/**
 * The booking a manage token opens, when it can move into `type`: same
 * tenant, same type, still confirmed or requested, and not yet started.
 * Anything else — a malformed token, a stranger's guess, a cancelled or past
 * call — is null, and the caller decides what null means on its route.
 */
async function reschedulableByToken(
  ctx: BookingContext,
  token: string,
  type: Pick<TypeRow, "id">,
  now: Date,
): Promise<BookingRow | null> {
  if (!looksLikeToken(token)) return null;
  const rows: BookingRow[] = await ctx.db
    .select()
    .from(bookingBookings)
    .where(and(eq(bookingBookings.tenantId, tenantOf(ctx)), eq(bookingBookings.manageTokenHash, await hashToken(token))))
    .limit(1);
  const row = rows[0];
  if (!row || row.typeId !== type.id || !isChangeable(row, now)) return null;
  return row;
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/**
 * A manage token offered alongside a slots or hold request. Deliberately
 * not shape-validated here: an unrecognisable token is "no such booking"
 * (looksLikeToken, then the lookup), never a 400 — so neither route can be
 * used to tell a malformed token from a well-formed stranger's guess.
 */
const manageTokenField = z.string().optional();

export const listOpenSlotsSchema = z.object({
  typeKey: typeKeySchema,
  from: instantSchema.optional(),
  to: instantSchema.optional(),
  /**
   * The invitee's manage token, when the list is for moving their booking:
   * that booking stops counting as busy, so times next to (or overlapping)
   * the call being moved are offered. Ignored when it opens nothing.
   */
  manageToken: manageTokenField,
});
export type ListOpenSlotsInput = z.input<typeof listOpenSlotsSchema>;

export interface OpenSlots {
  slots: Array<{ start: string; end: string }>;
  /** 'off' no calendar connected; 'degraded' a calendar failed and only internal bookings were checked. */
  busySync: "ok" | "degraded" | "off";
}

/**
 * Open starts for a type: the union across its host pool, as distinct
 * times. `from`/`to` default to now and the horizon, are clamped to the
 * type's notice and horizon, and one call spans at most 31 days.
 *
 * RESCHEDULE-AWARE. With the manage token of a booking of this type that can
 * still move, that booking is left out of busy — the same exclusion
 * rescheduleByToken applies when it writes — so "move my call half an hour
 * later" is offered rather than blocked by the call itself (and by its own
 * buffers). A token that opens nothing changes nothing and says nothing: this
 * route answers the same list either way, so it is no oracle for tokens.
 */
export async function listOpenSlots(ctx: BookingContext, input: ListOpenSlotsInput): Promise<OpenSlots> {
  const tenantId = tenantOf(ctx);
  const { typeKey, from, to, manageToken } = parse(listOpenSlotsSchema, input);
  const now = nowOf(ctx);
  const type = await activeTypeByKey(ctx.db, tenantId, typeKey);
  const hosts = await poolHosts(ctx.db, tenantId, type);
  if (hosts.length === 0) return { slots: [], busySync: "off" };
  const moving = manageToken ? await reschedulableByToken(ctx, manageToken, type, now) : null;

  const earliest = new Date(Math.max((from ?? now).getTime(), now.getTime() + type.minNoticeMinutes * 60_000));
  const furthestHorizon = Math.max(...hosts.map((host) => horizonEnd(now, host.timezone, type.horizonDays).getTime()));
  const latest = new Date(
    Math.min(
      (to ?? new Date(furthestHorizon)).getTime(),
      furthestHorizon,
      earliest.getTime() + MAX_SLOT_WINDOW_DAYS * DAY_MS,
    ),
  );
  const withCalendar = ctx.busySource && hosts.some((host) => host.busyIcsUrl);
  if (latest.getTime() <= earliest.getTime()) return { slots: [], busySync: withCalendar ? "ok" : "off" };

  const external = await fetchExternalBusy(ctx, hosts, earliest, latest);
  const data = await loadSchedulingData(
    ctx.db,
    tenantId,
    hosts.map((host) => host.id),
    earliest,
    latest,
    now,
    moving ? [moving.id] : [],
  );
  const slots = hosts.flatMap((host) =>
    hostSlots({ host, type, data, external: external.byHost.get(host.id) ?? [], from: earliest, to: latest, engineNow: now }),
  );
  return {
    slots: unionSlots(slots).map((slot) => ({ start: slot.start.toISOString(), end: slot.end.toISOString() })),
    busySync: external.status,
  };
}

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

const tokenSchema = z.string().refine((value) => looksLikeToken(value), "Not a valid token.");

export const holdSlotSchema = z.object({
  typeKey: typeKeySchema,
  start: instantSchema,
  previousHoldToken: tokenSchema.optional(),
  /** Holding a new time for an existing booking (a reschedule): see holdSlot. */
  manageToken: manageTokenField,
});
export type HoldSlotInput = z.input<typeof holdSlotSchema>;

export interface HoldResult {
  holdToken: string;
  expiresAt: string;
  start: string;
  end: string;
}

/** Live holds one requester may have at once, unless the host app says otherwise. */
export const DEFAULT_MAX_HOLDS_PER_SUBJECT = 2;

/**
 * HOLD SQUATTING. Holds are anonymous and free, and each one takes a start —
 * plus its neighbours, through the buffers — off the market for ten minutes.
 * Without a per-requester cap, one script could keep a host's whole horizon
 * held so no real prospect is ever offered a time (the per-IP request rate
 * only slows that down). A host app that can name the requester passes
 * `subject` (the handler factory's `holdSubject` option: usually the client
 * IP's rate-limit key); only its SHA-256, salted with the tenant, is stored.
 */
export interface HoldLimits {
  /** Who is asking. null/absent → no per-subject cap for this hold. */
  subject?: string | null;
  /** Live holds one subject may have at once, not counting the one being replaced. Default 2. */
  maxPerSubject?: number;
}

/**
 * Claim a start for ten minutes while the prospect fills in the form. Picking
 * another time passes `previousHoldToken`, which is released in the SAME
 * transaction before the new claim is checked — so moving from 10:00 to
 * 10:15 never blocks itself. Holds emit no events.
 *
 * A reschedule passes the booking's `manageToken`: that booking is excluded
 * from the check, as it is in the slot list that offered the time and in
 * rescheduleByToken that will consume the hold — so a time next to the call
 * being moved can be held, not just seen. Here a token that opens no booking
 * this type could move is `not_found` before any work: the caller asked to
 * act FOR a booking, and pretending it exists would hold a time the
 * reschedule then cannot use.
 *
 * With `limits.subject`, a requester who already has `maxPerSubject` live
 * holds is refused (`rate_limited`) — counted under the host lock and a lock
 * on the subject, AFTER the hold being replaced was released, so moving a
 * hold from 10:00 to 10:15 is never refused. A refusal rolls back the
 * release too: the requester keeps the hold they had.
 */
export async function holdSlot(ctx: BookingContext, input: HoldSlotInput, limits: HoldLimits = {}): Promise<HoldResult> {
  const tenantId = tenantOf(ctx);
  const parsed = parse(holdSlotSchema, input);
  const now = nowOf(ctx);
  const maxPerSubject =
    Number.isInteger(limits.maxPerSubject) && (limits.maxPerSubject ?? 0) >= 1
      ? (limits.maxPerSubject as number)
      : DEFAULT_MAX_HOLDS_PER_SUBJECT;
  const subjectHash = limits.subject ? await hashToken(`${tenantId}:${limits.subject}`) : null;
  const type = await activeTypeByKey(ctx.db, tenantId, parsed.typeKey);
  const moving = parsed.manageToken !== undefined ? await reschedulableByToken(ctx, parsed.manageToken, type, now) : null;
  if (parsed.manageToken !== undefined && !moving) throw new BookingError("not_found");
  const excludeIds = moving ? [moving.id] : [];
  const hosts = await poolHosts(ctx.db, tenantId, type);
  if (hosts.length === 0) throw new BookingError("slot_taken");
  const external = await fetchExternalBusy(ctx, hosts, new Date(parsed.start.getTime() - DAY_MS), new Date(parsed.start.getTime() + DAY_MS));
  const previousHash = parsed.previousHoldToken ? await hashToken(parsed.previousHoldToken) : null;
  const holdToken = generateToken();
  const holdTokenHash = await hashToken(holdToken);
  const expiresAt = new Date(now.getTime() + HOLD_MINUTES * 60_000);
  const end = new Date(parsed.start.getTime() + type.durationMinutes * 60_000);

  await ctx.db.transaction(async (tx) => {
    await lockHosts(tx, tenantId, hosts.map((host) => host.id));
    if (previousHash) {
      const released = await tx
        .delete(bookingBookings)
        .where(
          and(
            eq(bookingBookings.tenantId, tenantId),
            eq(bookingBookings.holdTokenHash, previousHash),
            eq(bookingBookings.status, "hold"),
          ),
        )
        .returning({ id: bookingBookings.id });
      await deleteEventsFor(tx, tenantId, released.map((row) => row.id));
    }
    if (subjectHash) {
      // Taken after the host locks, always last and only one per
      // transaction, so it adds no lock-order cycle; it serialises one
      // requester's holds across different host pools too.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`booking-subject:${tenantId}:${subjectHash}`}))`);
      if ((await liveHoldsOfSubject(tx, tenantId, subjectHash, now)) >= maxPerSubject) {
        throw new BookingError(
          "rate_limited",
          "You already have times on hold. Finish booking one, or wait a few minutes, then try again.",
        );
      }
    }
    const free = await freeHostsAt({ db: tx, tenantId, type, hosts, start: parsed.start, external, now, excludeIds });
    // A reschedule's hold reserves the host who keeps the call when free
    // (rescheduleByToken prefers them too); otherwise the fairest free one.
    const host = (moving && free.find((candidate) => candidate.id === moving.hostId)) || (await assignHost(tx, tenantId, free, now));
    if (!host) throw new BookingError("slot_taken");
    const inserted: Array<{ id: string }> = await tx
      .insert(bookingBookings)
      .values({
        tenantId,
        typeId: type.id,
        hostId: host.id,
        status: "hold",
        startUtc: parsed.start,
        endUtc: end,
        hostTimezone: host.timezone,
        holdTokenHash,
        holdExpiresAt: expiresAt,
        holdSubjectHash: subjectHash,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: bookingBookings.id });
    const id = inserted[0]?.id;
    if (!id) throw new Error("hold insert returned no row");
    await recordEvent(tx, { tenantId, bookingId: id, kind: "held", actor: "invitee", at: now });
  });
  return { holdToken, expiresAt: expiresAt.toISOString(), start: parsed.start.toISOString(), end: end.toISOString() };
}

export const releaseHoldSchema = z.object({ holdToken: z.string().max(200) });

/**
 * Let a held time go (the widget calls this on leave, best-effort). Always
 * answers ok: an unknown or expired token has nothing to release, and a
 * different answer would only tell a stranger which tokens were real.
 */
export async function releaseHold(ctx: BookingContext, input: z.input<typeof releaseHoldSchema>): Promise<{ ok: true }> {
  const tenantId = tenantOf(ctx);
  const { holdToken } = parse(releaseHoldSchema, input);
  if (!looksLikeToken(holdToken)) return { ok: true };
  const holdHash = await hashToken(holdToken);
  await ctx.db.transaction(async (tx) => {
    const released = await tx
      .delete(bookingBookings)
      .where(
        and(
          eq(bookingBookings.tenantId, tenantId),
          eq(bookingBookings.holdTokenHash, holdHash),
          eq(bookingBookings.status, "hold"),
        ),
      )
      .returning({ id: bookingBookings.id });
    await deleteEventsFor(tx, tenantId, released.map((row) => row.id));
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Book
// ---------------------------------------------------------------------------

/**
 * The booking form's schema for a deployment. Only the phone rule varies:
 * with `defaultCallingCode`, a number typed without "+" is read in that
 * country (fields.normalizePhone); without it the "+" is required.
 */
export function bookSchemaFor(options: PhoneOptions = {}) {
  return z
    .object({
      typeKey: typeKeySchema,
      start: instantSchema,
      holdToken: tokenSchema.optional(),
      name: z.string().trim().min(1, "Enter your name.").max(120),
      email: emailSchema,
      phone: z.union([phoneSchemaFor(options), z.literal("").transform(() => undefined)]).optional(),
      company: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(1000).optional(),
      medium: mediumSchema,
      /** The zone the prospect saw times in; an unknown zone falls back to the host's. */
      timezone: z.string().max(64).optional(),
      source: z.string().max(500).optional(),
    })
    .superRefine((value, ctx) => {
      if (value.medium === "phone" && !value.phone) {
        ctx.addIssue({ code: "custom", path: ["phone"], message: "A phone number is needed for a phone call." });
      }
    });
}

/** The strict form schema (the "+" required on a phone number). */
export const bookSchema = bookSchemaFor();
export type BookInput = z.input<typeof bookSchema>;

export interface BookResult {
  booking: PublicBooking;
  /** The plaintext manage token — returned here once and never stored. */
  manageToken: string;
}

/**
 * Book a call. With a live hold for this exact start, the hold row BECOMES
 * the booking; with none (or an expired one), the start is re-verified and
 * booked directly if still free. A presented hold that lapsed and lost the
 * time answers `hold_expired`; no hold and no time answers `slot_taken`.
 *
 * DOUBLE SUBMIT. A hold token whose hold already became a standing booking
 * in the last ten minutes answers `already_booked`: that is the same form
 * sent twice (a double click, a retry after a response that never arrived),
 * and the first one worked. Without this the second request saw no hold,
 * found the time occupied — by its own booking — and told the prospect their
 * hold had expired; and with a host pool it could even book them TWICE, on a
 * second free host. The booked row keeps its hold's token hash for this.
 */
export async function book(ctx: BookingContext, input: BookInput): Promise<BookResult> {
  const tenantId = tenantOf(ctx);
  const parsed = parse(bookSchemaFor({ defaultCallingCode: ctx.defaultCallingCode }), input);
  const now = nowOf(ctx);
  const type = await activeTypeByKey(ctx.db, tenantId, parsed.typeKey);
  if (!type.media.includes(parsed.medium)) {
    throw new BookingError("invalid", "That way of meeting is not offered for this call.", [
      { path: ["medium"], message: `Choose one of: ${type.media.join(", ")}.` },
    ]);
  }
  const hosts = await poolHosts(ctx.db, tenantId, type);
  if (hosts.length === 0) throw new BookingError("slot_taken");
  const external = await fetchExternalBusy(ctx, hosts, new Date(parsed.start.getTime() - DAY_MS), new Date(parsed.start.getTime() + DAY_MS));
  const holdHash = parsed.holdToken ? await hashToken(parsed.holdToken) : null;
  const manageToken = generateToken();
  const manageTokenHash = await hashToken(manageToken);
  const end = new Date(parsed.start.getTime() + type.durationMinutes * 60_000);
  const source = scrubSource(parsed.source);

  const result = await ctx.db.transaction(async (tx) => {
    await lockHosts(tx, tenantId, hosts.map((host) => host.id));
    const hold = holdHash ? await holdByTokenHash(tx, tenantId, holdHash) : null;
    // Under the lock, so a second submit that queued behind the first sees
    // the first's committed booking here rather than racing it.
    if (
      holdHash &&
      !hold &&
      (await bookedFromHoldSince(tx, tenantId, holdHash, new Date(now.getTime() - HOLD_MINUTES * 60_000)))
    ) {
      throw new BookingError(
        "already_booked",
        ctx.sandbox
          ? "You're already booked for this time. (Sandbox: nothing was emailed — the manage link on your confirmation still works.)"
          : alreadyBookedMessage({
              ...(ctx.emailsEnabled !== undefined ? { emailsEnabled: ctx.emailsEnabled } : {}),
              contactEmail: ctx.contactEmail ?? null,
            }),
      );
    }
    const liveHold =
      hold &&
      hold.typeId === type.id &&
      hold.startUtc.getTime() === parsed.start.getTime() &&
      hold.holdExpiresAt !== null &&
      hold.holdExpiresAt.getTime() > now.getTime()
        ? hold
        : null;
    const free = await freeHostsAt({
      db: tx,
      tenantId,
      type,
      hosts,
      start: parsed.start,
      external,
      now,
      // A live hold guaranteed the time when it was taken; measure notice from then.
      ...(liveHold ? { engineNow: liveHold.createdAt } : {}),
      excludeIds: hold ? [hold.id] : [],
    });
    // Keep the held host when it is still free; otherwise the fairest free one.
    const host = (liveHold && free.find((candidate) => candidate.id === liveHold.hostId)) || (await assignHost(tx, tenantId, free, now));
    if (!host) throw new BookingError(holdHash && !liveHold ? "hold_expired" : "slot_taken");

    const status = host.autoConfirm ? "confirmed" : "requested";
    const values = {
      hostId: host.id,
      typeId: type.id,
      status,
      startUtc: parsed.start,
      endUtc: end,
      hostTimezone: host.timezone,
      inviteeTimezone: parsed.timezone && isValidTimeZone(parsed.timezone) ? parsed.timezone : host.timezone,
      // Kept (no longer a hold: status and holdExpiresAt say so) so a second
      // submit of the same form is recognised — see bookedFromHoldSince.
      holdTokenHash: holdHash,
      holdExpiresAt: null,
      // Who held it mattered only while it was a hold; a booking does not keep it.
      holdSubjectHash: null,
      manageTokenHash,
      inviteeName: parsed.name,
      inviteeEmail: parsed.email,
      inviteePhone: parsed.phone ?? null,
      inviteeCompany: parsed.company || null,
      notes: parsed.notes || null,
      medium: parsed.medium,
      source,
      updatedAt: now,
    } as const;

    let row: BookingRow | undefined;
    if (hold) {
      // The hold row becomes the booking (or, expired/mismatched, is reused
      // for it) — one row, one id, from first click to confirmation.
      [row] = await tx
        .update(bookingBookings)
        .set(values)
        .where(and(eq(bookingBookings.tenantId, tenantId), eq(bookingBookings.id, hold.id)))
        .returning();
    } else {
      [row] = await tx
        .insert(bookingBookings)
        .values({ ...values, tenantId, createdAt: now })
        .returning();
    }
    if (!row) throw new Error("booking write returned no row");
    await recordEvent(tx, {
      tenantId,
      bookingId: row.id,
      kind: "booked",
      actor: "invitee",
      detail: { status, medium: parsed.medium, typeKey: type.key, fromHold: Boolean(liveHold) },
      at: now,
    });
    return { row, host };
  });

  await emit(ctx, {
    event: "booking.created",
    tenantId,
    booking: toAdminBooking(result.row, result.host, type),
    host: eventHost(result.host),
    type: eventType(type),
    manageToken,
  });
  return {
    booking: toPublicBooking(result.row, result.host, type, {
      now,
      ...(ctx.sandbox !== undefined ? { sandbox: ctx.sandbox } : {}),
      manageUrl: ctx.manageUrl?.(manageToken) ?? null,
      realBookingUrl: ctx.realBookingUrl ?? null,
    }),
    manageToken,
  };
}

// ---------------------------------------------------------------------------
// Manage by token
// ---------------------------------------------------------------------------

async function bookingByManageToken(ctx: BookingContext, token: string): Promise<BookingRow> {
  if (!looksLikeToken(token)) throw new BookingError("not_found");
  const rows: BookingRow[] = await ctx.db
    .select()
    .from(bookingBookings)
    .where(and(eq(bookingBookings.tenantId, tenantOf(ctx)), eq(bookingBookings.manageTokenHash, await hashToken(token))))
    .limit(1);
  const row = rows[0];
  // A hold never carries a manage token; belt and braces for a hand-edited row.
  if (!row || row.status === "hold") throw new BookingError("not_found");
  return row;
}

async function hydrate(ctx: BookingContext, row: BookingRow): Promise<{ host: HostRow; type: TypeRow | null }> {
  const [host, type] = await Promise.all([hostById(ctx, row.hostId), typeById(ctx, row.typeId)]);
  if (!host) throw new BookingError("not_found");
  return { host, type };
}

function publicOf(ctx: BookingContext, row: BookingRow, host: HostRow, type: TypeRow | null, token: string): PublicBooking {
  return toPublicBooking(row, host, type, {
    now: nowOf(ctx),
    ...(ctx.sandbox !== undefined ? { sandbox: ctx.sandbox } : {}),
    manageUrl: ctx.manageUrl?.(token) ?? null,
    realBookingUrl: ctx.realBookingUrl ?? null,
  });
}

/**
 * The prospect's booking, in whatever state it is — the manage page shows a
 * cancelled or past call as such rather than pretending it never existed.
 * Unknown tokens are `not_found`.
 */
export async function getBookingByToken(ctx: BookingContext, token: string): Promise<PublicBooking> {
  const row = await bookingByManageToken(ctx, token);
  const { host, type } = await hydrate(ctx, row);
  return publicOf(ctx, row, host, type, token);
}

export const cancelByTokenSchema = z.object({ reason: z.string().trim().max(500).optional() });

/**
 * Cancel. Idempotent — cancelling a cancelled booking returns it unchanged.
 * A call that has already happened (or was marked completed / no-show) can
 * no longer be cancelled and answers `not_found`, the same as an unknown
 * token.
 */
export async function cancelByToken(
  ctx: BookingContext,
  token: string,
  input: z.input<typeof cancelByTokenSchema> = {},
): Promise<PublicBooking> {
  const tenantId = tenantOf(ctx);
  const { reason } = parse(cancelByTokenSchema, input);
  const now = nowOf(ctx);
  const found = await bookingByManageToken(ctx, token);
  const { host, type } = await hydrate(ctx, found);
  if (found.status === "cancelled") return publicOf(ctx, found, host, type, token);
  if (!isChangeable(found, now)) throw new BookingError("not_found");

  const outcome = await ctx.db.transaction(async (tx) => {
    await lockHosts(tx, tenantId, [found.hostId]);
    const [updated]: BookingRow[] = await tx
      .update(bookingBookings)
      .set({
        status: "cancelled",
        cancelledAt: now,
        cancelledBy: "invitee",
        cancelReason: reason || null,
        sequence: found.sequence + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(bookingBookings.tenantId, tenantId),
          eq(bookingBookings.id, found.id),
          // Only from a live state: a concurrent cancel (or a host cancel)
          // that landed first wins, and this one becomes a no-op.
          inArray(bookingBookings.status, ["confirmed", "requested"]),
        ),
      )
      .returning();
    if (!updated) {
      const [current]: BookingRow[] = await tx
        .select()
        .from(bookingBookings)
        .where(and(eq(bookingBookings.tenantId, tenantId), eq(bookingBookings.id, found.id)))
        .limit(1);
      if (current?.status === "cancelled") return { row: current, changed: false };
      throw new BookingError("not_found");
    }
    await recordEvent(tx, {
      tenantId,
      bookingId: found.id,
      kind: "cancelled",
      actor: "invitee",
      detail: { from: found.status },
      at: now,
    });
    return { row: updated, changed: true };
  });
  const row = outcome.row;
  if (!outcome.changed) return publicOf(ctx, row, host, type, token);

  await emit(ctx, {
    event: "booking.cancelled",
    tenantId,
    booking: toAdminBooking(row, host, type),
    host: eventHost(host),
    type: type ? eventType(type) : { id: found.typeId, key: "", name: "Call", durationMinutes: 0 },
    by: "invitee",
  });
  return publicOf(ctx, row, host, type, token);
}

export const rescheduleByTokenSchema = z.object({
  start: instantSchema,
  holdToken: tokenSchema.optional(),
});

/**
 * Move a call. The SAME row moves — new start and end, sequence + 1, manage
 * token unchanged — so the prospect's link keeps working (D2) and their
 * calendar updates the event it already has. The conflict check excludes the
 * booking being moved (and the prospect's own hold for the new time). The
 * current host keeps the call when free at the new time; otherwise the held
 * host, otherwise the fairest free one. Status stays confirmed / requested.
 * The transaction is move.ts's, shared with the host's own reschedule.
 */
export async function rescheduleByToken(
  ctx: BookingContext,
  token: string,
  input: z.input<typeof rescheduleByTokenSchema>,
): Promise<PublicBooking> {
  const parsed = parse(rescheduleByTokenSchema, input);
  const found = await bookingByManageToken(ctx, token);
  const holdHash = parsed.holdToken ? await hashToken(parsed.holdToken) : null;
  const result = await moveBooking(
    ctx,
    found,
    { start: parsed.start, holdHash },
    { actor: "invitee", notChangeable: () => new BookingError("not_found"), manageToken: token },
  );
  return publicOf(ctx, result.row, result.host, result.type, token);
}

/**
 * The prospect's .ics: PUBLISH while the call stands, CANCEL once it does
 * not, same UID throughout, SEQUENCE from the row. A sandbox booking's file
 * is a labelled non-event instead (ics.ts SANDBOX_TITLE_PREFIX), so nothing
 * a demo visitor imports reads like a real call.
 */
export async function icsByToken(
  ctx: BookingContext,
  token: string,
  options: { uidDomain: string },
): Promise<{ ics: string; method: "PUBLISH" | "CANCEL" }> {
  const row = await bookingByManageToken(ctx, token);
  const { host, type } = await hydrate(ctx, row);
  const method = row.status === "cancelled" ? "CANCEL" : "PUBLISH";
  const manageUrl = ctx.manageUrl?.(token);
  return {
    method,
    ics: buildIcs({
      booking: {
        id: row.id,
        startUtc: row.startUtc,
        endUtc: row.endUtc,
        sequence: row.sequence,
        medium: row.medium ?? "video",
        inviteeName: row.inviteeName ?? "",
        inviteeEmail: row.inviteeEmail ?? "",
      },
      host,
      type: { name: type?.name ?? "Call" },
      method,
      uidDomain: options.uidDomain,
      ...(manageUrl ? { manageUrl } : {}),
      now: nowOf(ctx),
      audience: "invitee",
      ...(ctx.sandbox ? { sandbox: true, realBookingUrl: ctx.realBookingUrl ?? null } : {}),
    }),
  };
}

/**
 * The host's subscribable feed: upcoming CONFIRMED calls, first name and
 * company only (F7). An unknown token, a token from another tenant, or a
 * deactivated host is `not_found`.
 */
export async function hostFeed(ctx: BookingContext, feedToken: string, options: { uidDomain: string }): Promise<string> {
  const tenantId = tenantOf(ctx);
  if (!looksLikeToken(feedToken)) throw new BookingError("not_found");
  const hosts: HostRow[] = await ctx.db
    .select()
    .from(bookingHosts)
    .where(
      and(
        eq(bookingHosts.tenantId, tenantId),
        eq(bookingHosts.feedTokenHash, await hashToken(feedToken)),
        eq(bookingHosts.isActive, true),
      ),
    )
    .limit(1);
  const host = hosts[0];
  if (!host) throw new BookingError("not_found");
  const now = nowOf(ctx);
  const [rows, types] = await Promise.all([
    ctx.db
      .select()
      .from(bookingBookings)
      .where(
        and(
          eq(bookingBookings.tenantId, tenantId),
          eq(bookingBookings.hostId, host.id),
          eq(bookingBookings.status, "confirmed"),
          gt(bookingBookings.endUtc, now),
        ),
      )
      .orderBy(asc(bookingBookings.startUtc))
      .limit(500) as Promise<BookingRow[]>,
    ctx.db.select().from(bookingTypes).where(eq(bookingTypes.tenantId, tenantId)) as Promise<TypeRow[]>,
  ]);
  const typeNames = new Map(types.map((type) => [type.id, type.name]));
  return buildHostFeed({
    host,
    uidDomain: options.uidDomain,
    now,
    bookings: rows.map((row) => ({
      id: row.id,
      startUtc: row.startUtc,
      endUtc: row.endUtc,
      sequence: row.sequence,
      medium: row.medium ?? "video",
      typeName: typeNames.get(row.typeId) ?? "Call",
      inviteeName: row.inviteeName ?? "",
      inviteeCompany: row.inviteeCompany,
    })),
  });
}
