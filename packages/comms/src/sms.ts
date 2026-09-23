import { z } from "zod";

/**
 * SMS helpers — pure. Two jobs the package owns rather than trusting every
 * host to remember: getting a phone number into the one format carriers
 * accept, and making every outbound text legal to send.
 */

/**
 * A NANP number as E.164 digits: country code 1, then an area code and an
 * exchange that each start 2-9. Neither can start with 0 or 1, so ten digits
 * that do are not a US/Canadian number at all.
 */
const NANP_DIGITS = /^1[2-9]\d{2}[2-9]\d{6}$/;

/**
 * A phone number in E.164 (`+18015551234`), or null when it cannot be one.
 *
 * Ported from the source's formatPhoneNumber with one deliberate change: an
 * unparseable number returns null instead of being passed through "for Twilio
 * to reject". Passed through, a typo'd number sat in the queue until send time,
 * failed at the provider, and — in the source — was then marked sent. Null lets
 * the caller refuse it where the customer can still fix it.
 *
 *   "8015551234" / "(801) 555-1234"   → "+18015551234"  (US, no country code)
 *   "1 801 555 1234"                  → "+18015551234"
 *   "+44 20 7946 0958"                → "+442079460958" (already international)
 *   "+44 (0)20 7946 0958"             → "+442079460958" (trunk 0 dropped)
 *   "0207946095", "1234567890"        → null  (ten digits, but not NANP)
 *   "123", "call me"                  → null
 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  // Every +1 result must be a real NANP shape. Ten digits used to get +1
  // forced onto them whatever they were — "0207946095" (a UK number typed
  // without its country code) became +10207946095, which no carrier routes —
  // accepted on the form, then failed at the provider the night before.
  const asNanp = (digits: string): string | null => (NANP_DIGITS.test(digits) ? `+${digits}` : null);
  if (trimmed.startsWith("+")) {
    // "+44 (0)20 …": the (0) is the trunk prefix dialled only inside the
    // country, never part of the E.164 number. Kept, it made +440207… — a
    // number that does not exist.
    const digits = trimmed.replace(/\(\s*0\s*\)/g, "").replace(/\D/g, "");
    // International form: trust the country code, only strip the formatting.
    // Checked BEFORE the bare-10-digit rule so "+44 1234 567890"-shaped
    // numbers that happen to have ten digits are not rewritten to +1.
    if (!/^[1-9]\d{6,14}$/.test(digits)) return null;
    if (digits.startsWith("1")) return asNanp(digits);
    return `+${digits}`;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return asNanp(digits);
  if (digits.length === 10) return asNanp(`1${digits}`);
  return null;
}

/** The default opt-out line, appended to every text that does not already carry it. */
export const SMS_OPT_OUT_TEXT = "Reply STOP to opt out.";

/**
 * Words that tell a recipient how to stop — the source's three variants. Used
 * ONLY to vet a configured `optOutText` (it must say how to opt out). It is no
 * longer used to decide whether a message already carries opt-out language:
 * run over the rendered text, a customer's own "please unsubscribe me" matched
 * it and the STOP line was dropped — see enforceCompliance.
 */
export const SMS_OPT_OUT_PATTERN = /reply stop|opt.?out|unsubscribe/i;

/**
 * Who the texts are from, stated on every one. REQUIRED whenever an SMS sender
 * is configured: US carriers (A2P 10DLC) and the TCPA expect each message to
 * identify the business and say how to stop, and a registered campaign that
 * sends texts without them gets filtered or suspended — for the whole number,
 * not just the offending message.
 */
export interface SmsCompliance {
  /** The business name every text starts with: "Acme Plumbing" → "Acme Plumbing: …". */
  senderName: string;
  /** Replaces "Reply STOP to opt out." — must itself say how to opt out. */
  optOutText?: string;
}

export const smsComplianceSchema = z.object({
  senderName: z
    .string()
    .trim()
    .min(1, "senderName is required")
    .max(60)
    // Strip a trailing colon the host may have added; the prefix adds its own.
    .transform((name) => name.replace(/:+$/, "").trim())
    .refine((name) => name.length > 0, "senderName is required"),
  optOutText: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine(
      (text) => SMS_OPT_OUT_PATTERN.test(text),
      'optOutText must tell the recipient how to opt out (e.g. "Reply STOP to opt out.")',
    )
    .optional(),
});

/**
 * Make one outbound text compliant: prefix `SenderName:` unless it already
 * starts with it, and append the opt-out line unless that exact line (case-
 * insensitive) is already there. Idempotent, so a template that already ends
 * with the line is sent unchanged. Ported from the source's enforceCompliance,
 * with the business name a parameter instead of a hardcoded brand.
 *
 * Deliberately stricter than the source, which skipped the line when ANY of
 * "reply stop", "opt out" or "unsubscribe" appeared. This runs on the RENDERED
 * text, so customer-supplied values count: a notes field reading "please
 * unsubscribe me from the newsletter" suppressed the STOP instruction. Now
 * only the configured line itself counts — a duplicate line is harmless, a
 * missing one can get the campaign filtered or suspended.
 */
export function enforceCompliance(
  body: string,
  senderName: string,
  optOutText: string = SMS_OPT_OUT_TEXT,
): string {
  const prefix = `${senderName.trim().replace(/:+$/, "").trim()}:`;
  const line = optOutText.trim() || SMS_OPT_OUT_TEXT;
  let message = body.trim();
  if (!message.startsWith(prefix)) {
    message = message ? `${prefix} ${message}` : prefix;
  }
  if (!message.toLowerCase().includes(line.toLowerCase())) {
    message = `${message} ${line}`;
  }
  return message;
}
