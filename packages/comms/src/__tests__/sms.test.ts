import { describe, expect, it } from "vitest";
import { enforceCompliance, normalizePhone, SMS_OPT_OUT_TEXT, smsComplianceSchema } from "../sms.js";

// Ported from the source's sms-compliance.test.ts. The business name is a
// parameter here instead of a hardcoded brand, so the source's PREFIX constant
// becomes `${SENDER}:`.
const SENDER = "SG Glass & Metal";
const PREFIX = `${SENDER}:`;
const OPT_OUT = "Reply STOP to opt out.";

describe("enforceCompliance (ported)", () => {
  it("adds prefix and opt-out to bare message", () => {
    const result = enforceCompliance("Your appointment is tomorrow.", SENDER);
    expect(result.startsWith(PREFIX)).toBe(true);
    expect(result).toContain(OPT_OUT);
  });

  it("does not double-prefix if already present", () => {
    const msg = `${PREFIX} Your appointment is tomorrow.`;
    const result = enforceCompliance(msg, SENDER);
    expect(result.indexOf(PREFIX)).toBe(0);
    expect(result.indexOf(PREFIX, 1)).toBe(-1);
  });

  it("does not double opt-out if already present", () => {
    const msg = "Your appointment is tomorrow. Reply STOP to opt out.";
    const result = enforceCompliance(msg, SENDER);
    expect(result).toContain("Reply STOP to opt out.");
    expect((result.match(/Reply STOP to opt out\./g) ?? []).length).toBe(1);
  });

  // The source's next three cases asserted that ANY of "reply stop", "opt
  // out" or "unsubscribe" anywhere in the text suppressed the opt-out line.
  // The check runs on the RENDERED message, so a customer's own words ("please
  // unsubscribe me from the newsletter" in a notes field) silently dropped the
  // STOP instruction. Inverted deliberately: only the configured line itself
  // counts, and a duplicate is harmless where a missing one is not.
  it("recognizes the opt-out line case-insensitively", () => {
    const msg = `${PREFIX} Test. reply stop to opt out.`;
    expect(enforceCompliance(msg, SENDER)).toBe(msg);
  });

  it("still appends the line when the text merely mentions 'reply stop'", () => {
    const msg = `${PREFIX} Test. reply stop to unsubscribe`;
    expect(enforceCompliance(msg, SENDER)).toBe(`${msg} ${OPT_OUT}`);
  });

  it("still appends the line for the 'opt out' variant", () => {
    const msg = `${PREFIX} Test. Text opt out to stop.`;
    expect(enforceCompliance(msg, SENDER)).toBe(`${msg} ${OPT_OUT}`);
  });

  it("still appends the line for the 'unsubscribe' variant", () => {
    const msg = `${PREFIX} Test. Text UNSUBSCRIBE to stop.`;
    expect(enforceCompliance(msg, SENDER)).toBe(`${msg} ${OPT_OUT}`);
  });

  it("preserves original message content", () => {
    const original = "Hi John, your install is at 9 AM.";
    expect(enforceCompliance(original, SENDER)).toContain(original);
  });

  it("handles empty string", () => {
    const result = enforceCompliance("", SENDER);
    expect(result.startsWith(PREFIX)).toBe(true);
    expect(result).toContain(OPT_OUT);
  });
});

describe("enforceCompliance (package additions)", () => {
  it("uses a custom opt-out line when given one", () => {
    expect(enforceCompliance("See you soon.", "Acme", "Text STOP to end.")).toBe(
      "Acme: See you soon. Text STOP to end.",
    );
  });

  it("does not double the colon when the name already ends in one", () => {
    expect(enforceCompliance("Hi", "Acme:")).toBe(`Acme: Hi ${SMS_OPT_OUT_TEXT}`);
  });

  it("appends the configured line even when the default one is already in the text", () => {
    // The CONFIGURED line is the promise the campaign was registered with.
    expect(enforceCompliance(`Hi. ${SMS_OPT_OUT_TEXT}`, "Acme", "Text STOP to end.")).toBe(
      `Acme: Hi. ${SMS_OPT_OUT_TEXT} Text STOP to end.`,
    );
  });

  it("does not let a customer's own words suppress the opt-out line", () => {
    const rendered = "Hi Sam, see you at 9. Notes: please unsubscribe me from the newsletter, don't opt out my texts";
    expect(enforceCompliance(rendered, "Acme").endsWith(` ${SMS_OPT_OUT_TEXT}`)).toBe(true);
  });
});

describe("smsComplianceSchema", () => {
  it("requires a sender name", () => {
    expect(smsComplianceSchema.safeParse({ senderName: "  " }).success).toBe(false);
    expect(smsComplianceSchema.safeParse(undefined).success).toBe(false);
    expect(smsComplianceSchema.parse({ senderName: " Acme: " }).senderName).toBe("Acme");
  });

  it("refuses an opt-out line that does not tell the recipient how to opt out", () => {
    // Appending "Thanks!" as the opt-out text would make every message
    // "compliant" by the package's check while saying nothing a carrier accepts.
    expect(smsComplianceSchema.safeParse({ senderName: "Acme", optOutText: "Thanks!" }).success).toBe(false);
    expect(smsComplianceSchema.safeParse({ senderName: "Acme", optOutText: "Reply STOP to end" }).success).toBe(true);
  });
});

// Ported from the source's communication.test.ts formatPhoneNumber cases.
describe("normalizePhone", () => {
  it("formats 10-digit US number", () => {
    expect(normalizePhone("8015551234")).toBe("+18015551234");
  });

  it("formats dashed number", () => {
    expect(normalizePhone("801-555-1234")).toBe("+18015551234");
  });

  it("formats parenthesized number", () => {
    expect(normalizePhone("(801) 555-1234")).toBe("+18015551234");
  });

  it("formats 11-digit with country code", () => {
    expect(normalizePhone("18015551234")).toBe("+18015551234");
  });

  it("passes through E.164 format", () => {
    expect(normalizePhone("+18015551234")).toBe("+18015551234");
  });

  it("returns null for an unparseable number (the source passed it through to fail at the provider)", () => {
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("call me")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });

  it("keeps an international number's own country code", () => {
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    // Ten digits after a + is NOT a bare US number: no +1 is added.
    expect(normalizePhone("+4412345678")).toBe("+4412345678");
  });

  it("refuses a +1 number that is not ten digits after the country code", () => {
    expect(normalizePhone("+1801555123")).toBeNull();
  });

  it("refuses ten digits that cannot be a NANP number instead of forcing +1 onto them", () => {
    // Area codes and exchanges never start with 0 or 1. Ten such digits are a
    // foreign number typed without its country code (a UK 020… number, a
    // mobile starting 07…); prefixing +1 texted a stranger in the US or
    // failed at the provider long after the customer left the form.
    expect(normalizePhone("0207946095")).toBeNull();
    expect(normalizePhone("0712345678")).toBeNull();
    expect(normalizePhone("1234567890")).toBeNull();
    expect(normalizePhone("8011234567")).toBeNull();
    expect(normalizePhone("1 801 155 1234")).toBeNull();
    expect(normalizePhone("+1 012 555 1234")).toBeNull();
    expect(normalizePhone("+1 801 055 1234")).toBeNull();
  });

  it("strips a (0) trunk marker from an international number", () => {
    // "+44 (0)20 …" is how UK numbers are commonly written; the 0 is dialled
    // only inside the country and is not part of the E.164 number.
    expect(normalizePhone("+44 (0)20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("+49 (0) 30 123456")).toBe("+4930123456");
  });
});
