/**
 * WHEN STRIPE SAYS NO (stripe 0.5): what went wrong, in words for each reader.
 *
 * A Stripe call fails for a handful of reasons, and each one has a different
 * person who can fix it:
 *
 *   setup    this SITE isn't ready: its account never signed up for Connect
 *            (Stripe's 400 "You can only create new accounts if you've signed
 *            up for Connect…"), its key is wrong (401) or restricted without
 *            the permission (403), or there is no key at all. Only the site's
 *            operator can fix it, so an owner is told it is switched off and
 *            that the operator has been told — and the operator reads Stripe's
 *            own sentence with the link to fix it.
 *   outage   Stripe didn't answer (5xx, or the SDK's own dropped connection,
 *            StripeConnectionError): nobody here can fix it, and trying again
 *            in a few minutes usually works.
 *   busy     Stripe's rate limit (429).
 *   refused  any other answer from Stripe (a 4xx this file doesn't know).
 *   unknown  it wasn't Stripe at all — a database that's down included. A
 *            dropped connection the Stripe SDK didn't raise ("fetch failed",
 *            ECONNREFUSED on :5432) is somebody else's outage: calling it
 *            Stripe's would send staff to Stripe's status page while the
 *            database is down.
 *
 * `describeStripeFailure` never throws and never returns Stripe's sentence as
 * the owner's: `stripeMessage` can name keys and accounts, so a route hands it
 * to the site's staff only.
 */

export type StripeFailureKind = "setup" | "outage" | "busy" | "refused" | "unknown";

/** Which part of the site's Stripe setup is missing. */
export type StripeSetupProblem = "connect" | "keys" | "restricted-key" | "missing-keys";

export interface StripeFailure {
  readonly kind: StripeFailureKind;
  /** For `setup`: what is missing. Null otherwise. */
  readonly setup: StripeSetupProblem | null;
  /** One plain sentence for a business owner: what happened and what happens next. Never names a setting. */
  readonly ownerMessage: string;
  /** Stripe's own sentence (or, with no key, which setting is empty), for the site's staff only. Null when Stripe said nothing. */
  readonly stripeMessage: string | null;
  /** Where the site's operator fixes it, and the words for that link. */
  readonly fixUrl: string | null;
  readonly fixLabel: string | null;
  /** The status a route answers with: 409 for setup (the site isn't ready, like a missing key), 503 for outage and busy, 502 for a refusal, 500 otherwise. */
  readonly status: number;
  /** The wire code a route answers with. */
  readonly code: "stripe_setup" | "stripe_unavailable" | "stripe_busy" | "stripe_refused" | "internal";
  /** For the log line: Stripe's error type, code, HTTP status and request id. */
  readonly detail: {
    readonly type: string | null;
    readonly code: string | null;
    readonly statusCode: number | null;
    readonly requestId: string | null;
  };
}

/** The owner's sentence when this site isn't ready to take card payments. */
export const CARD_PAYMENTS_SWITCHED_OFF = "Card payments aren't switched on for this site yet. We've told whoever runs it.";
/** The owner's sentence when Stripe didn't answer. */
export const STRIPE_NOT_ANSWERING = "Stripe isn't answering right now, so nothing was changed. Please try again in a few minutes.";
/** The owner's sentence when Stripe is rate limiting this site. */
export const STRIPE_BUSY = "Stripe is busy right now. Please wait a minute and try again.";
/** The owner's sentence for any other refusal from Stripe. */
export const STRIPE_REFUSED = "Stripe turned this down, so nothing was changed. We've told whoever runs this site.";
/** The owner's sentence when the failure wasn't Stripe's. */
export const SOMETHING_ON_OUR_SIDE = "Something went wrong on our side, so nothing was changed. We've told whoever runs this site; please try again later.";

const CONNECT_URL = "https://dashboard.stripe.com/connect";
const KEYS_URL = "https://dashboard.stripe.com/apikeys";
const STATUS_URL = "https://status.stripe.com/";

interface StripeLike {
  type?: unknown;
  rawType?: unknown;
  statusCode?: unknown;
  code?: unknown;
  message?: unknown;
  requestId?: unknown;
  raw?: { message?: unknown; type?: unknown; code?: unknown } | null;
  cause?: unknown;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Is this an error the Stripe SDK raised (or shaped like one)? */
export function isStripeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as StripeLike;
  return (typeof e.type === "string" && e.type.startsWith("Stripe")) || typeof e.rawType === "string";
}

/** The first dashboard.stripe.com link in Stripe's sentence, without its closing full stop. */
function dashboardLink(message: string | null): string | null {
  const found = message?.match(/https:\/\/dashboard\.stripe\.com\/[^\s"')]*/);
  return found ? found[0].replace(/[.,;:]+$/, "") : null;
}

function failure(
  kind: StripeFailureKind,
  setup: StripeSetupProblem | null,
  stripeMessage: string | null,
  fix: readonly [url: string, label: string] | null,
  detail: StripeFailure["detail"],
): StripeFailure {
  const [ownerMessage, status, code] =
    kind === "setup"
      ? ([CARD_PAYMENTS_SWITCHED_OFF, 409, "stripe_setup"] as const)
      : kind === "outage"
        ? ([STRIPE_NOT_ANSWERING, 503, "stripe_unavailable"] as const)
        : kind === "busy"
          ? ([STRIPE_BUSY, 503, "stripe_busy"] as const)
          : kind === "refused"
            ? ([STRIPE_REFUSED, 502, "stripe_refused"] as const)
            : ([SOMETHING_ON_OUR_SIDE, 500, "internal"] as const);
  return { kind, setup, ownerMessage, stripeMessage, fixUrl: fix?.[0] ?? null, fixLabel: fix?.[1] ?? null, status, code, detail };
}

/** There is no Stripe key (or no Connect webhook secret) on this site: card payments can't start. */
export function stripeNotSetUp(missing: string): StripeFailure {
  return failure("setup", "missing-keys", `${missing} isn't set on this site, so Stripe can't be called.`, [KEYS_URL, "Get the keys in Stripe"], {
    type: null,
    code: null,
    statusCode: null,
    requestId: null,
  });
}

/**
 * What a failed Stripe call means, for the owner, for the site's staff and for
 * the log. Anything the Stripe SDK didn't raise is `unknown`, a dropped
 * connection included: the SDK wraps its own as StripeConnectionError, so a
 * bare "fetch failed" or ECONNREFUSED came from something else (the database,
 * most often), never from Stripe.
 */
export function describeStripeFailure(error: unknown): StripeFailure {
  const e = (error && typeof error === "object" ? error : {}) as StripeLike;
  const type = str(e.type);
  const rawType = str(e.rawType) ?? str(e.raw?.type);
  const statusCode = typeof e.statusCode === "number" ? e.statusCode : null;
  const code = str(e.code) ?? str(e.raw?.code);
  const message = str(e.raw?.message) ?? str(e.message);
  const detail = { type: type ?? rawType, code, statusCode, requestId: str(e.requestId) };

  if (!isStripeError(error)) return failure("unknown", null, null, null, detail);

  if (type === "StripeConnectionError" || type === "StripeAPIError" || rawType === "api_error" || (statusCode !== null && statusCode >= 500)) {
    return failure("outage", null, message, [STATUS_URL, "Stripe's status page"], detail);
  }
  if (type === "StripeRateLimitError" || statusCode === 429 || code === "rate_limit") {
    return failure("busy", null, message, null, detail);
  }
  if (type === "StripeAuthenticationError" || statusCode === 401 || code === "api_key_expired" || code === "platform_api_key_expired") {
    return failure("setup", "keys", message, [KEYS_URL, "Check this site's API keys in Stripe"], detail);
  }
  if (type === "StripePermissionError" || statusCode === 403) {
    return failure("setup", "restricted-key", message, [KEYS_URL, "Give this site's key the permissions it needs"], detail);
  }
  // The platform account isn't set up for Connect: "You can only create new
  // accounts if you've signed up for Connect, which you can do at
  // https://dashboard.stripe.com/connect", or its platform profile (who
  // carries losses) isn't finished.
  if (message && /signed up for Connect|platform[- ]profile|settings\/connect|dashboard\.stripe\.com\/connect|Connect (?:is not|isn't) enabled/i.test(message)) {
    return failure("setup", "connect", message, [dashboardLink(message) ?? CONNECT_URL, "Finish setting up Connect in Stripe"], detail);
  }
  return failure("refused", null, message, null, detail);
}

/** What a route may show its caller: Stripe's own sentence and the fix only for the site's staff. */
export function stripeFailureWire(found: StripeFailure, staff: boolean): {
  code: StripeFailure["code"];
  message: string;
  staff?: { message: string | null; fixUrl: string | null; fixLabel: string | null };
} {
  return {
    code: found.code,
    message: found.ownerMessage,
    ...(staff && (found.stripeMessage || found.fixUrl) ? { staff: { message: found.stripeMessage, fixUrl: found.fixUrl, fixLabel: found.fixLabel } } : {}),
  };
}
