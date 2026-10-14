import type { ClientError } from "./http.js";

/**
 * Money, dates and errors in words — pure, so every branch is a unit test.
 *
 * Formatting is the ONLY thing the widget does to a number (contract 9): the
 * server works out every price, quantity and sentence, and the widget puts the
 * business's currency symbol on it. Money arrives in integer cents and is
 * shown with `Intl.NumberFormat(locale, { style: "currency", currency })`.
 */

/** Minor units per major unit for a currency (100 for USD, 1 for JPY), from Intl. */
function fractionDigits(currency: string, locale: string): number {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export interface MoneyOptions {
  /** Whole currency units ("$6,444"): an estimate isn't to the cent; a quote is. */
  whole?: boolean;
}

/**
 * Integer cents as money: `formatMoney(644396, "USD", "en-US")` → "$6,443.96";
 * `{ whole: true }` → "$6,444". A currency or locale Intl doesn't know falls
 * back to en-US / USD rather than throwing mid-render.
 */
export function formatMoney(cents: number, currency = "USD", locale = "en-US", options: MoneyOptions = {}): string {
  const safe = Number.isFinite(cents) ? cents : 0;
  const make = (loc: string, cur: string) => {
    const digits = fractionDigits(cur, loc);
    const amount = safe / 10 ** digits;
    return new Intl.NumberFormat(loc, {
      style: "currency",
      currency: cur,
      ...(options.whole ? { maximumFractionDigits: 0, minimumFractionDigits: 0 } : {}),
    }).format(amount);
  };
  try {
    return make(locale, currency);
  } catch {
    try {
      return make("en-US", currency);
    } catch {
      return make("en-US", "USD");
    }
  }
}

/** "$6,444 – $7,164", or one amount when the two are the same. Whole units: it's an estimate. */
export function formatRange(low: number, high: number, currency = "USD", locale = "en-US"): string {
  const a = formatMoney(low, currency, locale, { whole: true });
  const b = formatMoney(high, currency, locale, { whole: true });
  return a === b ? a : `${a} – ${b}`;
}

/** "+$120" / "+$12.50" / "−$20": an option's price, as the customer reads it on a chip. */
export function formatModifier(cents: number, currency = "USD", locale = "en-US"): string {
  const digits = fractionDigits(currency, locale);
  const whole = cents % 10 ** digits === 0;
  const text = formatMoney(Math.abs(cents), currency, locale, { whole });
  return `${cents < 0 ? "−" : "+"}${text}`;
}

/** Basis points as a percentage: 725 → "7.25%", 500 → "5%", 2857 → "28.57%". */
export function formatPercent(bp: number): string {
  const value = Math.round((Number.isFinite(bp) ? bp : 0)) / 100;
  return `${Number.parseFloat(value.toFixed(2))}%`;
}

/** An instant as a date in the business's zone: "November 14, 2026". Empty for nothing usable. */
export function formatDate(instant: string | null | undefined, locale = "en-US", timeZone = "UTC"): string {
  if (!instant) return "";
  const at = Date.parse(instant);
  if (!Number.isFinite(at)) return "";
  const options: Intl.DateTimeFormatOptions = { month: "long", day: "numeric", year: "numeric" };
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(at);
  }
}

/** An instant with its time: "Nov 14, 2026, 3:05 PM". */
export function formatDateTime(instant: string | null | undefined, locale = "en-US", timeZone = "UTC"): string {
  if (!instant) return "";
  const at = Date.parse(instant);
  if (!Number.isFinite(at)) return "";
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(at);
  }
}

/** The first word of a name when it looks like one ("Pat" from "Pat Lee"), else "". */
/**
 * "Mountain Time (MST)" for "America/Denver" (Tenancy 2a review T2A-BO-14):
 * the name an owner knows, the same words Schedule settings uses, instead of
 * the zone's database id. An engine that won't name it gets the id with
 * spaces ("America/Denver" → "America/Denver"; "America/New_York" → "America/New York").
 */
export function zoneLabel(zone: string, at: Date = new Date(), locale = "en-US"): string {
  const part = (style: "short" | "longGeneric"): string => {
    try {
      const parts = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: style } as Intl.DateTimeFormatOptions).formatToParts(at);
      return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    } catch {
      return "";
    }
  };
  const short = part("short");
  const generic = part("longGeneric");
  if (generic && short && generic !== short && !/^(GMT|UTC)[+−-]/.test(generic)) return `${generic} (${short})`;
  return generic || short || zone.replace(/_/g, " ");
}

export function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  // Letters, apostrophes and hyphens only: "www.spam.com" typed as a name is
  // not said back to anyone.
  return /^[\p{L}][\p{L}'’-]*$/u.test(first) ? first : "";
}

/** `href` + "?" or "&" + `key=value`: the booking link that carries the estimate. */
export function withParam(href: string, key: string, value: string): string {
  const [base, hash] = href.split("#", 2) as [string, string | undefined];
  const joined = `${base}${base.includes("?") ? "&" : "?"}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  return hash === undefined ? joined : `${joined}#${hash}`;
}

export type ErrorContext = "config" | "calculate" | "photo" | "takeoff" | "submit" | "quote" | "respond";

/**
 * What a CUSTOMER reads for an error, by where it happened. Codes whose server
 * message is written for a person (a quote that expired, naming the business's
 * phone; spam) use it; everything else gets fixed words, because a server's
 * text for `internal` or a proxy's HTML page is not for customers.
 */
export function friendlyError(error: ClientError, context: ErrorContext): string {
  const own = error.message && error.message !== error.code ? error.message : null;
  switch (error.code) {
    case "network":
      return "We couldn't connect. Check your connection and try again.";
    case "rate_limited":
      return "That's a lot of tries in a short time. Wait a minute, then try again.";
    case "spam_suspected":
      return own ?? "That was quicker than a person can fill in the form. Please check your details and send it again.";
    case "unauthorized":
    case "origin_not_allowed":
      return "This estimator isn't set up for this website yet.";
    case "estimates_closed":
      return "Instant estimates aren't available right now.";
    case "photos_disabled":
      return "This estimator doesn't take photos.";
    case "photo_invalid":
      return own ?? "That photo couldn't be used. Please try another one.";
    case "photo_limit":
      return "That's as many photos as we can take.";
    case "photo_unavailable":
    case "takeoff_unavailable":
      return "Your photo couldn't be attached. Your estimate can still be saved without it.";
    case "product_unavailable":
    case "product_not_estimatable":
    case "option_unavailable":
    case "option_value_unavailable":
    case "invalid_options":
      return "That isn't available any more. Please refresh the page.";
    case "quote_expired":
    case "already_answered":
    case "not_changeable":
      return own ?? "This quote has changed. Here's how it stands now.";
    case "quote_changed":
      return own ?? "This quote changed since you opened it. Here's the new one; check it before you accept.";
    case "not_found":
      if (context === "quote" || context === "respond") {
        return "This quote link doesn't work. It may have been replaced by a newer one; check your latest email from the business.";
      }
      return "That isn't available any more. Please refresh the page.";
    case "invalid":
    case "invalid_measurement":
      if (context === "submit") {
        return error.issues && error.issues.length > 0 ? "Please check the highlighted fields." : "Some details weren't accepted. Please check them and try again.";
      }
      if (context === "calculate") return "Check the numbers above.";
      return "Something about this page isn't right. Please refresh and try again.";
    case "bad_response":
      if (error.status === 429) return "That's a lot of tries in a short time. Wait a minute, then try again.";
      return "Something went wrong on our side. Please try again.";
    default:
      return "Something went wrong on our side. Please try again.";
  }
}
