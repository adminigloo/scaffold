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

  it("recognizes 'Reply STOP' (case-insensitive)", () => {
    const msg = `${PREFIX} Test. reply stop to unsubscribe`;
    const result = enforceCompliance(msg, SENDER);
    expect(result).not.toContain(OPT_OUT);
    expect(result).toBe(msg);
  });

  it("recognizes 'opt out' variant", () => {
    const msg = `${PREFIX} Test. Text opt out to stop.`;
    expect(enforceCompliance(msg, SENDER)).toBe(msg);
  });

  it("recognizes 'unsubscribe' variant", () => {
    const msg = `${PREFIX} Test. Text UNSUBSCRIBE to stop.`;
    expect(enforceCompliance(msg, SENDER)).toBe(msg);
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
});
