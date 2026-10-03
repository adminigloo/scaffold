/**
 * The field-level rules every input schema shares, written once so the admin
 * editor, the public form and the sandbox seeder cannot disagree about what a
 * phone number or a time zone is. Zod at the boundary, `text` in the table —
 * the house rule: a length limit belongs where it can be a sentence, not a
 * driver exception.
 *
 * Written against the zod surface common to v3.25 and v4 (the peer range
 * promises both), so no `z.iso`, no `z.email()` top-level helpers.
 */

import { z } from "zod";
import { privateHostReason } from "./address.js";
import { AVAILABILITY_STEP_MINUTES } from "./engine.js";
import { isValidDateString, isValidTimeZone } from "./zone.js";

export const MEDIA = ["video", "phone", "prospect_hosted"] as const;

export interface PhoneOptions {
  /**
   * The country calling code ("1", "44") assumed for a number typed WITHOUT
   * a leading "+" or "00". Omitted (or not a calling code): the "+" is
   * required, as below.
   */
  defaultCallingCode?: string | null | undefined;
}

/**
 * "1", "+1", " 44 " → "1", "44". Null for anything that is not a country
 * calling code: one to three digits, never starting with 0.
 */
export function normalizeCallingCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().replace(/^\+/, "");
  return /^[1-9]\d{0,2}$/.test(value) ? value : null;
}

/**
 * Calling codes whose national numbers KEEP their leading 0 after the code
 * (Italy, San Marino: +39 06 …). There the 0 is part of the number, not a
 * trunk prefix, so it must not be dropped.
 */
const LEADING_ZERO_KEPT = new Set(["39", "378"]);

/**
 * A North American national number: three-digit area code and three-digit
 * exchange, each starting 2–9, then four digits. Every number in country
 * code 1 (the US, Canada and the Caribbean share it) has exactly this shape,
 * so anything else after a "+1" is a typo or a foreign number, never a call
 * that will connect.
 */
const NANP_NATIONAL = /^[2-9]\d{2}[2-9]\d{6}$/;
const NANP_E164_DIGITS = /^1[2-9]\d{2}[2-9]\d{6}$/;

/**
 * A national number written the way people at home write it, with the
 * default code put in front — or null when it cannot be one, rather than a
 * guess that dials a stranger.
 *
 * Code 1 (NANP) has no "0" trunk prefix at all, so a leading 0 is refused,
 * never stripped: UK "020 7946 0958" typed on a US form used to become
 * +1 207 946 0958 — a valid-looking Maine number the host would then call.
 * NANP's own trunk prefix is "1", the same digit as the country code, so one
 * leading 1 is dropped from an eleven-digit entry ("1 801 555 0143") and the
 * remaining ten digits must be a real NANP shape.
 *
 * Every other code drops one domestic trunk "0" (UK "020 7946 0958" with
 * "44" → +44 20 7946 0958) — except Italy and San Marino, where the 0 is part
 * of the number. A second 0 after the trunk prefix is not a number anywhere
 * that uses one, so it is refused too.
 */
function withCallingCode(national: string, code: string): string | null {
  let digits = national;
  if (code === "1") {
    if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
    return NANP_NATIONAL.test(digits) ? `1${digits}` : null;
  }
  if (!LEADING_ZERO_KEPT.has(code)) {
    if (digits.startsWith("0")) digits = digits.slice(1);
    if (digits.startsWith("0")) return null;
  }
  return `${code}${digits}`;
}

/**
 * "+44 (0) 20 7946 0958" → "+44 20 7946 0958". The "(0)" after a country
 * code is the trunk prefix shown for callers inside the country, never part
 * of the international number; kept, it made +44 020 … , which does not
 * exist. Italy and San Marino keep the 0 (it is part of their numbers), so
 * there the parentheses go and the digit stays.
 */
function dropBracketedTrunkZero(text: string): string {
  return text.replace(/^(\+|00)(\s*)(\d{1,3})[\s.-]*\(\s*0\s*\)/, (_match, lead: string, gap: string, code: string) =>
    LEADING_ZERO_KEPT.has(code) ? `${lead}${gap}${code} 0` : `${lead}${gap}${code} `,
  );
}

/**
 * A dialable phone number, E.164-ish: one leading "+", then 7–15 digits.
 * Separators people type — spaces, dots, dashes, parentheses — are dropped;
 * a leading international "00" reads as "+". Anything else (letters, an
 * "ext. 12") is not a number this package can hand a host to dial. A number
 * in country code 1 must be a real North American shape (eleven digits,
 * area code and exchange starting 2–9), whichever way it was typed.
 *
 * By default the "+" is REQUIRED. Guessing a country code turns "801 555
 * 0143" into a call to somewhere in the 80x range; asking for it is one more
 * keystroke. A deployment that knows where its prospects are can say so with
 * `defaultCallingCode`: a number typed without "+" or "00" then becomes
 * "+" + code + the national digits (see withCallingCode), and an
 * international number is still read as written. With code 1, "011" — how
 * North Americans dial abroad — reads as international too ("011 44 20 7946
 * 0958" → +44 20 7946 0958). Returns null for anything these rules cannot
 * turn into a number with confidence: refusing costs the prospect one edit,
 * a wrong guess costs the host a call to a stranger.
 */
export function normalizePhone(raw: string, options: PhoneOptions = {}): string | null {
  const trimmed = raw.trim();
  if (!/^(\+|00)?[\d\s().-]+$/.test(trimmed)) return null;
  const text = dropBracketedTrunkZero(trimmed);
  const code = normalizeCallingCode(options.defaultCallingCode);
  let international = text.startsWith("+") || text.startsWith("00");
  let digits = text.replace(/\D/g, "");
  if (text.startsWith("00")) {
    digits = digits.slice(2);
  } else if (!international && code === "1" && digits.startsWith("011")) {
    digits = digits.slice(3);
    international = true;
  }
  if (!international) {
    if (!code || digits.length === 0) return null;
    const withCode = withCallingCode(digits, code);
    if (!withCode) return null;
    digits = withCode;
  }
  if (!/^[1-9]\d{6,14}$/.test(digits)) return null;
  if (digits.startsWith("1") && !NANP_E164_DIGITS.test(digits)) return null;
  return `+${digits}`;
}

/** The phone rule as a zod field, strict or with a default calling code. */
export function phoneSchemaFor(options: PhoneOptions = {}) {
  const code = normalizeCallingCode(options.defaultCallingCode);
  return z
    .string()
    .max(40)
    .transform((value, ctx) => {
      const normalized = normalizePhone(value, code ? { defaultCallingCode: code } : {});
      if (!normalized) {
        ctx.addIssue({
          code: "custom",
          message:
            code === "1"
              ? "Enter a 10-digit number, like 801 555 0143. Outside +1, start with + and the country code."
              : code
                ? `Enter a number we can dial (7–15 digits). Outside +${code}, start with + and the country code.`
                : "Include the country code, like +1 801 555 0143 (7–15 digits).",
        });
        return z.NEVER;
      }
      return normalized;
    });
}

/** The strict rule: the "+" and country code required. Hosts' own numbers always use this. */
export const phoneSchema = phoneSchemaFor();

export const emailSchema = z.string().trim().toLowerCase().max(254).email("Enter a valid email address.");

export const timeZoneSchema = z
  .string()
  .trim()
  .max(64)
  .refine((value) => isValidTimeZone(value), "Must be an IANA time zone, like America/Denver.");

export const dateSchema = z
  .string()
  .refine((value) => isValidDateString(value), "Must be a calendar date, YYYY-MM-DD.");

/** A wall-clock minute on the 15-minute grid, 0..1440 (1440 = midnight at the end of the day). */
export const minuteSchema = z
  .number()
  .int()
  .min(0)
  .max(1440)
  .refine((value) => value % AVAILABILITY_STEP_MINUTES === 0, "Must be on the 15-minute grid.");

/** An ISO-8601 instant with an explicit offset or Z → Date. */
export const instantSchema = z
  .string()
  .max(40)
  .refine(
    (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i.test(value) && !Number.isNaN(Date.parse(value)),
    "Must be an ISO-8601 date-time with a zone, like 2026-10-14T15:00:00Z.",
  )
  .transform((value) => new Date(value));

/** An https link, for meeting rooms. */
export const httpsUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "Must be an https:// link.");

/**
 * A secret iCal address: https, or webcal (which is https underneath). A
 * host that is private by its spelling (localhost, 10.x, [::ffff:127.0.0.1],
 * a .internal name …) is refused here, at save time, with a sentence — the
 * busy reader would refuse it on every fetch anyway (see busy-source.ts),
 * and the admin should hear why now, not as "sync failing" later.
 */
export const icsUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    try {
      return new URL(value.replace(/^webcals?:\/\//i, "https://")).protocol === "https:";
    } catch {
      return false;
    }
  }, "Must be an https:// or webcal:// calendar address.")
  .refine((value) => {
    try {
      return privateHostReason(new URL(value.replace(/^webcals?:\/\//i, "https://")).hostname) === null;
    } catch {
      return true; // the refinement above already reported a non-URL
    }
  }, "That address points at a private network, not a calendar service.")
  .transform((value) => value.replace(/^webcals?:\/\//i, "https://"));

export const typeKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "Letters, digits, dashes and underscores.");

export const mediumSchema = z.enum(MEDIA);

const EMAIL_SHAPE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;

/**
 * A campaign label ("linkedin", "newsletter-oct") — never a subscriber id.
 * Odd characters stripped, capped at 100, and anything email- or
 * token-shaped refused outright, so a `?src=` that carries a person or a
 * secret does not get written into a booking row.
 */
export function scrubSource(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  if (EMAIL_SHAPE.test(text)) return null;
  // A long unbroken run of letters and digits is a token, not a campaign.
  if (/[A-Za-z0-9_-]{32,}/.test(text) && /\d/.test(text) && /[A-Za-z]/.test(text)) return null;
  const cleaned = text.replace(/[^\p{L}\p{N} _.:/+-]/gu, "").slice(0, 100).trim();
  return cleaned || null;
}
