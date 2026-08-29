import { Webhook } from "svix";
// Type-only. See the note in `send.ts`: a value import from `./schema.ts`
// would duplicate the table object for CJS consumers.
import type { EmailStatus } from "./schema.js";

/**
 * The three events that change what we believe about a message.
 *
 * `email.sent` and `email.delivery_delayed` are deliberately absent. We already
 * wrote `sent` ourselves when the provider accepted the message, and a delay is
 * not an outcome — treating it as one turns every slow mailbox into a bounce in
 * the reports.
 */
export type DeliveryEventType =
  | "email.delivered"
  | "email.bounced"
  | "email.complained";

export interface DeliveryEvent {
  /** The svix message id — stable across the provider's retries. */
  readonly id: string;
  readonly type: DeliveryEventType;
  /** Joins to `email_events.message_id`. */
  readonly messageId: string;
  readonly recipient: string;
  readonly occurredAt: Date;
}

/**
 * Thrown when the route has no signing secret.
 *
 * WITHOUT A SECRET THERE IS NO WAY TO TELL A REAL BOUNCE FROM ANYONE ON THE
 * INTERNET POSTING JSON AT THE ROUTE. The payload is entirely attacker-chosen,
 * and acting on it means a stranger can mark any address as bounced or
 * complained — which, in a system that suppresses those addresses, is a
 * remote button for cutting a specific customer off from their password
 * resets. So an unset secret REFUSES to process rather than trusting the body.
 *
 * Note the asymmetry with the outbound side, which quietly skips when it is
 * unconfigured. That degradation is safe because nothing untrusted is involved:
 * the worst case is mail that does not go out, and it is written down. Here the
 * input is hostile by default, so the same reflex would be a vulnerability. An
 * unconfigured inbound route must fail loudly enough that somebody sets the
 * secret.
 */
export class DeliveryWebhookNotConfiguredError extends Error {
  readonly name = "DeliveryWebhookNotConfiguredError";
  constructor() {
    super(
      "Refusing to process an email delivery webhook: RESEND_WEBHOOK_SECRET is " +
        "not set, so the payload cannot be attributed to the provider. Anyone " +
        "who knows the URL could otherwise mark any address as bounced. Set the " +
        "secret from the provider's webhook settings, or remove the route.",
    );
  }
}

export class DeliveryWebhookVerificationError extends Error {
  readonly name = "DeliveryWebhookVerificationError";
  constructor(cause?: unknown) {
    super(
      "Email delivery webhook signature verification failed. The request was not " +
        "sent by the provider, RESEND_WEBHOOK_SECRET belongs to a different " +
        "endpoint, or the route parsed the body before verifying it — the " +
        "signature covers the exact bytes that were sent, so a JSON round trip " +
        "breaks it in a way that looks identical to a forgery.",
      { cause },
    );
  }
}

/**
 * Thrown when a signed event of a handled type is missing the fields that make
 * it actionable.
 *
 * Loud rather than `null`, even though the request is genuinely from the
 * provider. `null` means "an event we do not act on", and a real bounce that
 * silently lands in that branch keeps a dead address on the list — which is
 * how a sending domain's reputation goes, one unnoticed hard bounce at a time.
 * A shape change in the provider's payload has to surface as an error.
 */
export class MalformedDeliveryEventError extends Error {
  readonly name = "MalformedDeliveryEventError";
  constructor(
    readonly type: DeliveryEventType,
    missing: string,
  ) {
    super(
      `A verified ${type} event carried no ${missing}, so it cannot be matched ` +
        `to a row in email_events. The provider's payload shape has changed.`,
    );
  }
}

interface DeliveryPayload {
  readonly type?: unknown;
  readonly created_at?: unknown;
  readonly data?: {
    readonly email_id?: unknown;
    readonly created_at?: unknown;
    readonly to?: unknown;
  };
}

/**
 * Verify a delivery webhook and normalise it.
 *
 * `body` must be the raw request text, exactly as received — the signature is
 * an HMAC over those bytes.
 *
 * Returns null for event types this package does not act on, so a route can
 * answer 200 and stop the provider retrying an event nobody wants. Throws for
 * everything that is not a well-formed, verified, actionable event, because
 * each of those cases needs somebody to look at it.
 */
export function verifyDeliveryWebhook(
  body: string,
  headers: Record<string, string>,
  secret: string | null | undefined,
): DeliveryEvent | null {
  if (typeof secret !== "string" || secret.trim().length === 0) {
    throw new DeliveryWebhookNotConfiguredError();
  }

  let payload: DeliveryPayload;
  try {
    payload = new Webhook(secret).verify(body, headers) as DeliveryPayload;
  } catch (cause) {
    throw new DeliveryWebhookVerificationError(cause);
  }

  const type = payload.type;
  if (!isDeliveryEventType(type)) return null;

  const messageId = payload.data?.email_id;
  if (typeof messageId !== "string" || messageId.length === 0) {
    throw new MalformedDeliveryEventError(type, "email_id");
  }

  const recipient = firstRecipient(payload.data?.to);
  if (recipient === null) throw new MalformedDeliveryEventError(type, "recipient");

  return {
    // svix's id, not the message id: it is stable across the provider's
    // retries of THIS notification, which is what makes the route's
    // deduplication work. `email_id` repeats across delivered-then-bounced.
    id: headers["svix-id"] ?? messageId,
    type,
    messageId,
    recipient,
    occurredAt: resolveOccurredAt(payload, headers),
  };
}

/**
 * The `email_events.status` an event moves the row to.
 *
 * An exhaustive switch with no `default`, so adding a member to
 * `DeliveryEventType` fails the build here. A `default` would quietly file the
 * new type under whatever seemed reasonable at the time.
 *
 * THIS IS NOT ENOUGH ON ITS OWN. Each type maps to a terminal status with no
 * notion of which one is more final, so writing the result straight to the row
 * lets a retried `email.delivered` land after `email.bounced` and erase it.
 * Gate the UPDATE on `shouldApplyDeliveryStatus`.
 */
export function mapDeliveryStatus(type: DeliveryEventType): EmailStatus {
  switch (type) {
    case "email.delivered":
      return "delivered";
    case "email.bounced":
      return "bounced";
    case "email.complained":
      return "complained";
  }
}

function isDeliveryEventType(type: unknown): type is DeliveryEventType {
  return (
    type === "email.delivered" ||
    type === "email.bounced" ||
    type === "email.complained"
  );
}

/**
 * The provider sends `to` as an array even for a single recipient. We only ever
 * send to one address (see `EmailMessage.to`), so the first entry is the one
 * the row is about.
 */
function firstRecipient(to: unknown): string | null {
  if (typeof to === "string") return to.length > 0 ? to : null;
  if (!Array.isArray(to)) return null;
  const first: unknown = to[0];
  return typeof first === "string" && first.length > 0 ? first : null;
}

/**
 * When the provider says this happened.
 *
 * Every candidate is checked for `Invalid Date` before it is returned. An
 * unparseable timestamp string would otherwise become a `Date` whose getTime()
 * is NaN, which the Postgres driver rejects — turning one malformed field into
 * a 500, which makes svix retry the same malformed event for days.
 *
 * Falls back to the svix timestamp, then to now, because the row has to be
 * updated regardless: the status is the fact that matters and a slightly wrong
 * timestamp is a much smaller lie than a bounce that was never recorded.
 */
function resolveOccurredAt(
  payload: DeliveryPayload,
  headers: Record<string, string>,
): Date {
  for (const candidate of [payload.created_at, payload.data?.created_at]) {
    if (typeof candidate !== "string") continue;
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const svixTimestamp = Number(headers["svix-timestamp"]);
  if (Number.isFinite(svixTimestamp) && svixTimestamp > 0) {
    return new Date(svixTimestamp * 1000);
  }

  return new Date();
}

/**
 * How final a status is. Higher wins.
 *
 * The provider's events do not arrive in the order they happened. svix retries
 * a failed POST at 5s, 5m and 30m, so a `delivered` that was generated first
 * can land after a `bounced` that was generated later — and a route that
 * applies events in arrival order (the obvious implementation) writes
 * `delivered` over `bounced`. The address then reads as healthy in
 * `email_events_status_created_idx`, the suppression list never gets it, and we
 * keep mailing a dead address until the receiving domain blocks the sending
 * domain. Ranking is what makes the write order-independent.
 *
 * The tiers:
 *
 *   0 `queued`      we wrote the row; nothing has left yet
 *   1 `sent`        the provider accepted it — no recipient has seen it
 *   2 `delivered`   the receiving server accepted it
 *   3 `bounced`, `complained`
 *                   terminal negative outcomes. Both mean "stop mailing this
 *                   address", both are the reason the log exists, and neither
 *                   may be erased by a `delivered` that describes an earlier
 *                   moment. They share a rank because neither is more final
 *                   than the other: a bounce and a complaint for one message
 *                   are mutually exclusive in practice, so if both appear the
 *                   later one is simply the newer information, and either
 *                   value suppresses the address.
 *   4 `failed`, `skipped`
 *                   decided here, never dispatched, and therefore NOT
 *                   ADDRESSABLE BY A WEBHOOK AT ALL — see below.
 *
 * SKIPPED CAN NEVER BE SUPERSEDED, and neither can `failed`. Both are written
 * for a message that never reached the provider, so `email_events.message_id`
 * is null on those rows (see the column comment in `schema.ts`) and the
 * webhook's only lookup key cannot match them. An inbound event that appears
 * to select one is a broken join or an id collision, never a real delivery
 * report — and applying it would overwrite the one row that proves the mail
 * was never sent, which is exactly the row somebody is reading when they ask
 * why the customer got nothing. So they sit above every provider status and
 * nothing this module produces can move them.
 */
export function deliveryStatusRank(status: EmailStatus): number {
  return DELIVERY_STATUS_RANK[status];
}

const DELIVERY_STATUS_RANK: Readonly<Record<EmailStatus, number>> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  bounced: 3,
  complained: 3,
  failed: 4,
  skipped: 4,
};

/** Timestamps for the equal-rank comparison. Both optional; see below. */
export interface DeliveryStatusOrder {
  /** When the currently recorded status happened — `email_events.updatedAt`. */
  readonly currentOccurredAt?: Date | null | undefined;
  /** `DeliveryEvent.occurredAt` for the event being applied. */
  readonly incomingOccurredAt?: Date | null | undefined;
}

/**
 * Whether a delivery event may move a row from `current` to `incoming`.
 *
 * Call this before the UPDATE. Without it, the last event to arrive wins, and
 * the last to arrive is whichever one the provider had to retry.
 *
 * The rules, in order:
 *
 *  - No current status (a row we have not written a status for yet): apply.
 *  - Different ranks: the higher rank wins, and TIMESTAMPS ARE IGNORED. This is
 *    the whole guard — a `delivered` generated an hour after a `bounced` still
 *    loses, because "the address rejected us" outranks "an earlier hop
 *    accepted us" no matter when either message was produced.
 *  - Equal ranks (`bounced` vs `complained`, or the same status twice): the
 *    later `occurredAt` wins. These are genuinely comparable — both suppress
 *    the address — so the newest information is the one to keep.
 *  - Equal ranks with an exact tie, a missing timestamp, or an unparseable one:
 *    DO NOT APPLY. Keeping what is already written makes a redelivery of the
 *    same event a no-op, so svix retrying the same notification three times
 *    produces one write instead of three, and two events that carry the
 *    identical timestamp settle on the same value whichever order they land in.
 *    Order-independence is worth more here than the arbitrary preference a
 *    coin-flip tiebreak would encode.
 */
export function shouldApplyDeliveryStatus(
  current: EmailStatus | null | undefined,
  incoming: EmailStatus,
  order: DeliveryStatusOrder = {},
): boolean {
  if (current === null || current === undefined) return true;

  const currentRank = deliveryStatusRank(current);
  const incomingRank = deliveryStatusRank(incoming);
  if (incomingRank !== currentRank) return incomingRank > currentRank;

  const currentAt = usableTime(order.currentOccurredAt);
  const incomingAt = usableTime(order.incomingOccurredAt);
  if (currentAt === null || incomingAt === null) return false;
  return incomingAt > currentAt;
}

/**
 * A comparable epoch time, or null.
 *
 * `Invalid Date` is checked because the current timestamp comes off a database
 * row rather than out of `resolveOccurredAt`, and `NaN > NaN` is false in a way
 * that silently reads as "keep the old status" — which is the correct answer,
 * but only by accident. Making it explicit keeps it correct when the comparison
 * is next edited.
 */
function usableTime(at: Date | null | undefined): number | null {
  if (!(at instanceof Date)) return null;
  const time = at.getTime();
  return Number.isNaN(time) ? null : time;
}
