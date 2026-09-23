import { z } from "zod";

/**
 * SMS helpers — pure. Two jobs the package owns rather than trusting every
 * host to remember: getting a phone number into the one format carriers
 * accept, and making every outbound text legal to send.
 */

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
 *   "123", "call me"                  → null
 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) {
    // International form: trust the country code, only strip the formatting.
    // Checked BEFORE the bare-10-digit rule so "+44 1234 567890"-shaped
    // numbers that happen to have ten digits are not rewritten to +1.
    if (!/^[1-9]\d{6,14}$/.test(digits)) return null;
    // A +1 number is NANP: exactly ten digits after the country code.
    if (digits.startsWith("1") && digits.length !== 11) return null;
    return `+${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return null;
}

/** Appended when a message carries no opt-out language of its own. */
export const SMS_OPT_OUT_TEXT = "Reply STOP to opt out.";

/** Opt-out language already present — the source's three accepted variants. */
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
 * starts with it, and append the opt-out line unless opt-out language is
 * already there. Idempotent, so a template that already says both is sent
 * unchanged. Ported from the source's enforceCompliance, with the business name
 * a parameter instead of a hardcoded brand.
 */
export function enforceCompliance(
  body: string,
  senderName: string,
  optOutText: string = SMS_OPT_OUT_TEXT,
): string {
  const prefix = `${senderName.trim().replace(/:+$/, "").trim()}:`;
  let message = body.trim();
  if (!message.startsWith(prefix)) {
    message = message ? `${prefix} ${message}` : prefix;
  }
  if (!SMS_OPT_OUT_PATTERN.test(message)) {
    message = `${message} ${optOutText}`;
  }
  return message;
}
