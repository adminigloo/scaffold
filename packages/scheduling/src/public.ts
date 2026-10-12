import { visitInstants } from "./instants.js";
import { DEFAULT_SLOT_STEP_MINUTES, type ScoredSlot } from "./math.js";
import { TIME_OF_DAY_PATTERN } from "./time.js";
import type { PublicSlot } from "./wire.js";

export type { PublicSlot } from "./wire.js";

/**
 * What an anonymous visitor may see and send — pure, no DB.
 *
 * WHY THIS FILE EXISTS. 0.2's only finder returned `ScoredSlot`s, and the
 * generated public `slots` route returned them as they came: every slot that
 * followed a booked visit carried `previousJobAddress` — the street address of
 * the customer before it — plus the crew's name and its drive minutes. Any
 * visitor who opened the network tab had a feed of customers' home addresses.
 * A public route now gets `PublicSlot`s from `findPublicSlots`, which builds
 * them with `toPublicSlot` and has no path that returns anything else.
 */

/*
 * `PublicSlot` (declared in wire.ts, the shape the widget reads) is one
 * bookable start, as an anonymous visitor sees it: the slot id, the date and
 * wall-clock times in the business's zone, and the same start and end as
 * instants. No crew, no score, no drive time, no address — nothing about any
 * other booking.
 *
 * The slot id names a day and a start, and nothing else: not the crew. It is
 * opaque but not secret, and it carries no authority. `requestPublicBooking`
 * works out the public offer again, under the chosen crew's lock, and books
 * only a (day, start) that is in it, on the crew the offer gives it to. An id
 * for a time that isn't on offer — forged, stale, or one the policy's
 * `maxSlotsPerDay` left out — is refused.
 *
 * It used to seal the crew's id inside, unsigned, and the request checked only
 * that crew: a decoded and re-encoded id booked a start `maxSlotsPerDay` had
 * held back, a crew the visitor wasn't offered, or a crew without the skill
 * the service needs.
 */

interface SlotRef {
  date: string;
  startTime: string;
}

const SLOT_ID_VERSION = "s1";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// base64url over UTF-8, with btoa/atob rather than Buffer so the same code runs
// on Node, an edge runtime and in a test without a polyfill.
function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function encodeSlotId(ref: SlotRef): string {
  return toBase64Url(JSON.stringify([SLOT_ID_VERSION, ref.date, ref.startTime]));
}

/**
 * The (date, start) a slot id names, or null for anything that isn't one this
 * package minted. Shape only: whether the slot is still OFFERED, and to which
 * crew, is `requestPublicBooking`'s question, asked under the lock.
 */
export function decodeSlotId(slotId: string): SlotRef | null {
  if (slotId.length > 500) return null;
  const json = fromBase64Url(slotId);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  const [version, date, startTime] = parsed as unknown[];
  if (version !== SLOT_ID_VERSION) return null;
  if (typeof date !== "string" || !DATE_RE.test(date)) return null;
  if (typeof startTime !== "string" || !TIME_OF_DAY_PATTERN.test(startTime)) return null;
  // A real calendar day: 2026-02-31 matches the pattern and is not one.
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== date) return null;
  return { date, startTime };
}

/**
 * The public projection of a staff slot: the slot id, the wall-clock date and
 * times, and the same start and end as instants in `timeZone` (default UTC,
 * 0.3's reading). The crew stays on the server.
 */
export function toPublicSlot(slot: ScoredSlot, timeZone = "UTC"): PublicSlot {
  const { startsAt, endsAt } = visitInstants(slot.date, slot.startTime, slot.endTime, timeZone);
  return {
    slotId: encodeSlotId({ date: slot.date, startTime: slot.startTime }),
    date: slot.date,
    startTime: slot.startTime,
    endTime: slot.endTime,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  };
}

/**
 * The rules an anonymous request is held to. Every field has a default, so
 * `{}` is a working policy; a host passes the same object to `findPublicSlots`
 * and `requestPublicBooking` so what is offered and what is accepted agree.
 */
export interface PublicBookingPolicy {
  /** The earliest start a visitor may pick, in minutes from now. Default 1440 (a day ahead). */
  minNoticeMinutes?: number;
  /** The furthest start a visitor may pick, in days from now. Default 30. */
  horizonDays?: number;
  /** Minutes between offered starts. Default 30. */
  slotStepMinutes?: number;
  /**
   * The visit lengths a visitor may ask for. Default 30, 45, 60, 90, 120, 180
   * and 240 minutes. A list rather than a range so a visitor can't claim a
   * whole day with `durationMinutes: 480`.
   */
  durationsMinutes?: readonly number[];
  /**
   * Where a request lands. Default "pending": a person accepts it, the way a
   * staff member confirms a request on the phone. "confirmed" books straight
   * into the calendar — for a business that wants instant booking and is
   * happy to cancel the odd bad one.
   */
  requestStatus?: "pending" | "confirmed";
  /**
   * Most starts offered per day, keeping the best-scored (the start right
   * after a visit, then mornings) and showing them in time order. Default
   * null: every start that fits. A request for a start this held back is
   * refused, the same as a taken one.
   */
  maxSlotsPerDay?: number | null;
  /**
   * Minutes kept clear before and after every visit on the calendar when
   * offering times to the public. Default 30.
   *
   * A FIXED BUFFER, NOT THE VISITOR'S DRIVE, ON PURPOSE. The public list used
   * to be worked out from the visitor's geocoded address: a start right after
   * a booked visit was offered only when the drive from it fitted the gap, so
   * typing an address and reading the first start after 10:00 said how far
   * that address was from the customer booked before — 0 minutes away meant
   * "the 08:00 visit is at this address". With one buffer for everyone the
   * list is the same whatever is typed. The real drive is still checked when
   * the request is made, under the crew's lock, where a drive that doesn't fit
   * is the same `slot_unavailable` as a taken time.
   */
  travelBufferMinutes?: number;
  /**
   * How many requests one requester may have waiting (pending, today or
   * later) at once. Default 3; null for no cap. Applies only when the host
   * passes `requesterKey` to `requestPublicBooking` — the package can't tell
   * one anonymous caller from another on its own.
   *
   * A pending request holds its time until somebody acts on it, so without a
   * cap one script with a fresh junk email per request could empty a crew's
   * whole online calendar in a minute. A rate limit bounds how FAST requests
   * arrive; this bounds how many are holding time.
   */
  maxOpenRequestsPerRequester?: number | null;
  /**
   * Refuse a request with no address (`address_unresolved`). Default false.
   * Turn it on for a business that always goes to the customer: with a
   * geocoding provider, every visit then has coordinates for the drive checks.
   */
  requireAddress?: boolean;
}

export type ResolvedPublicBookingPolicy = Readonly<Required<PublicBookingPolicy>>;

export const DEFAULT_PUBLIC_BOOKING_POLICY: ResolvedPublicBookingPolicy = Object.freeze({
  minNoticeMinutes: 24 * 60,
  horizonDays: 30,
  slotStepMinutes: DEFAULT_SLOT_STEP_MINUTES,
  durationsMinutes: Object.freeze([30, 45, 60, 90, 120, 180, 240]),
  requestStatus: "pending",
  maxSlotsPerDay: null,
  travelBufferMinutes: 30,
  maxOpenRequestsPerRequester: 3,
  requireAddress: false,
});

/** A policy with every default filled in — what the public functions actually run on. */
export function resolvePublicBookingPolicy(policy: PublicBookingPolicy = {}): ResolvedPublicBookingPolicy {
  const d = DEFAULT_PUBLIC_BOOKING_POLICY;
  return {
    minNoticeMinutes: policy.minNoticeMinutes ?? d.minNoticeMinutes,
    horizonDays: policy.horizonDays ?? d.horizonDays,
    slotStepMinutes: policy.slotStepMinutes ?? d.slotStepMinutes,
    durationsMinutes: policy.durationsMinutes ?? d.durationsMinutes,
    requestStatus: policy.requestStatus ?? d.requestStatus,
    maxSlotsPerDay: policy.maxSlotsPerDay ?? d.maxSlotsPerDay,
    travelBufferMinutes: policy.travelBufferMinutes ?? d.travelBufferMinutes,
    // `null` is a real answer here ("no cap"), so only a missing key takes the default.
    maxOpenRequestsPerRequester:
      policy.maxOpenRequestsPerRequester === undefined
        ? d.maxOpenRequestsPerRequester
        : policy.maxOpenRequestsPerRequester,
    requireAddress: policy.requireAddress ?? d.requireAddress,
  };
}
