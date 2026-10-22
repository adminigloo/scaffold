import { KIND_KEY } from "./registry.js";
import { isTimeZone } from "./time.js";

/**
 * WHAT A PERSON TICKED AT SIGN-UP (digest 0.1), carried across the sign-up
 * itself in a short-lived first-party cookie: the sign-up form is the
 * identity provider's (Clerk's), so the page beside it can't add a field to
 * it. `<SignUpEmailChoice>` (./ui) writes the cookie — the browser's time
 * zone always, each digest only when its box is ticked (unticked by
 * default) — and the page a new account lands on first reads it once,
 * applies it (`digests.applySignUpChoice`) and deletes it.
 *
 * The cookie says nothing about who: it is applied to whoever is signed in
 * when it is read, and only to choices they haven't made yet.
 */
export const SIGN_UP_CHOICE_COOKIE = "aig_email_choice";

/** A day: long enough for a sign-up with an emailed code, short enough to be gone tomorrow. */
export const SIGN_UP_CHOICE_MAX_AGE_SECONDS = 24 * 60 * 60;

export interface SignUpChoiceValue {
  readonly timeZone: string | null;
  readonly digests: readonly string[];
}

export function encodeSignUpChoice(choice: SignUpChoiceValue): string {
  return encodeURIComponent(JSON.stringify({ v: 1, tz: choice.timeZone, d: [...choice.digests] }));
}

/** The cookie's value read back, checked; null for anything else. */
export function parseSignUpChoice(value: string | null | undefined): SignUpChoiceValue | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(value));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as { v?: unknown; tz?: unknown; d?: unknown };
  if (record.v !== 1) return null;
  const timeZone = isTimeZone(record.tz) ? record.tz : null;
  const digests = Array.isArray(record.d) ? record.d.filter((key): key is string => typeof key === "string" && KIND_KEY.test(key)).slice(0, 20) : [];
  return { timeZone, digests };
}
