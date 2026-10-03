import { describe, expect, it } from "vitest";
import {
  emailSchema,
  icsUrlSchema,
  instantSchema,
  normalizeCallingCode,
  normalizePhone,
  phoneSchema,
  phoneSchemaFor,
  scrubSource,
  timeZoneSchema,
} from "../fields.js";
import { generateToken, hashToken, looksLikeToken } from "../tokens.js";
import { bookingPermissions } from "../permissions.js";

describe("normalizePhone", () => {
  it("keeps one leading + and 7–15 digits", () => {
    expect(normalizePhone("+1 (801) 555-0143")).toBe("+18015550143");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("0044 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("+1.801.555.0143")).toBe("+18015550143");
  });

  it("refuses numbers without a country code, too short, too long, or with letters", () => {
    expect(normalizePhone("(801) 555-0143")).toBeNull();
    expect(normalizePhone("+123456")).toBeNull();
    expect(normalizePhone("+1234567890123456")).toBeNull();
    expect(normalizePhone("+1 801 555 0143 ext 2")).toBeNull();
    expect(normalizePhone("1+8015550143")).toBeNull();
  });

  it("the schema reports a sentence, not a regex", () => {
    const result = phoneSchema.safeParse("555-0143");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/country code/);
    expect(phoneSchema.parse("+1 801 555 0143")).toBe("+18015550143");
  });
});

describe("normalizePhone with a default calling code", () => {
  const us = { defaultCallingCode: "1" };
  const uk = { defaultCallingCode: "44" };

  it("reads a number typed without + or 00 in the default country", () => {
    expect(normalizePhone("(801) 555-0143", us)).toBe("+18015550143");
    expect(normalizePhone("801.555.0143", us)).toBe("+18015550143");
  });

  it("drops one domestic trunk prefix: the usual 0, and NANP's 1 before ten digits", () => {
    expect(normalizePhone("020 7946 0958", uk)).toBe("+442079460958");
    expect(normalizePhone("00 44 20 7946 0958", uk)).toBe("+442079460958"); // 00 is international, not trunk
    expect(normalizePhone("1 801 555 0143", us)).toBe("+18015550143");
    expect(normalizePhone("1-801-555-0143", us)).toBe("+18015550143");
    // NANP's "1" only when it LEADS exactly eleven digits; anything else that
    // is not ten NANP digits is refused, never guessed at.
    expect(normalizePhone("801 555 0143 1", us)).toBeNull();
    // One trunk 0 at most: a second one is not a UK number, so it is refused.
    expect(normalizePhone("0 020 7946 0958", uk)).toBeNull();
  });

  /**
   * The review's cases, table-driven. Every row a North American form
   * (calling code 1) used to turn into a DIFFERENT, valid-looking number —
   * the host would have dialled a stranger — now either reads correctly or
   * is refused so the prospect fixes it.
   */
  it.each([
    // [input, default code, expected]
    ["020 7946 0958", "1", null], // UK number without +44: NOT +1 207 946 0958 (Maine)
    ["0207 946 0958", "1", null],
    ["011 44 20 7946 0958", "1", "+442079460958"], // how North Americans dial abroad
    ["011-44-20-7946-0958", "1", "+442079460958"],
    ["011 1 801 555 0143", "1", "+18015550143"],
    ["+44 (0) 20 7946 0958", "1", "+442079460958"], // "(0)" after +CC is the trunk prefix, dropped
    ["+44(0)20 7946 0958", "1", "+442079460958"],
    ["0044 (0)20 7946 0958", "1", "+442079460958"],
    ["+39 (0)6 6988 3712", "1", "+390669883712"], // Italy keeps its 0
    ["0801 555 0143", "1", null], // NANP never strips a leading 0
    ["123 456 7890", "1", null], // area code cannot start with 1
    ["801 155 0143", "1", null], // exchange cannot start with 1
    ["801 055 0143", "1", null], // …or 0
    ["801 555 014", "1", null], // nine digits
    ["801 555 01434", "1", null], // eleven digits not starting with 1
    ["2 801 555 0143", "1", null], // eleven digits with a stray lead
    ["1 801 555 0143", "1", "+18015550143"],
    ["(801) 555-0143", "1", "+18015550143"],
    ["+1 801 555 0143", "1", "+18015550143"],
    ["+1 801 555 01434", "1", null], // +1 must be exactly ten NANP digits
    ["+1 123 555 0143", null, null], // …whichever way it was typed
    ["+1 801 555 0143", null, "+18015550143"],
    ["020 7946 0958", "44", "+442079460958"],
    ["0 020 7946 0958", "44", null],
    ["06 6988 3712", "39", "+390669883712"],
  ])("normalizePhone(%j, code %s) → %s", (input, code, expected) => {
    expect(normalizePhone(input, code ? { defaultCallingCode: code } : {})).toBe(expected);
  });

  it("keeps the leading 0 where it belongs to the number (Italy)", () => {
    expect(normalizePhone("06 6988 3712", { defaultCallingCode: "39" })).toBe("+390669883712");
  });

  it("still reads an international number as written", () => {
    expect(normalizePhone("+44 20 7946 0958", us)).toBe("+442079460958");
    expect(normalizePhone("0044 20 7946 0958", us)).toBe("+442079460958");
  });

  it("still refuses what is not dialable", () => {
    expect(normalizePhone("555", us)).toBeNull();
    expect(normalizePhone("call me", us)).toBeNull();
    expect(normalizePhone("", us)).toBeNull();
    expect(normalizePhone("1234567890123456", us)).toBeNull();
  });

  it("a code that is not a calling code means strict", () => {
    expect(normalizeCallingCode("+1")).toBe("1");
    expect(normalizeCallingCode(" 44 ")).toBe("44");
    for (const bad of ["", "0", "01", "1234", "US", undefined, 1]) expect(normalizeCallingCode(bad)).toBeNull();
    expect(normalizePhone("801 555 0143", { defaultCallingCode: "US" })).toBeNull();
  });

  it("phoneSchemaFor words its message for the rule in force", () => {
    const result = phoneSchemaFor(us).safeParse("555");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/Outside \+1, start with \+/);
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/10-digit/);
    expect(phoneSchemaFor(us).parse("801 555 0143")).toBe("+18015550143");
    expect(phoneSchemaFor({}).safeParse("801 555 0143").success).toBe(false);
    // The UK number on a +1 form is refused with a sentence, not stored as +1 207 …
    expect(phoneSchemaFor(us).safeParse("020 7946 0958").success).toBe(false);
  });
});

describe("the calendar address field", () => {
  it("refuses a private host at save time, with a sentence", () => {
    for (const value of ["https://127.0.0.1/x.ics", "webcal://[::ffff:127.0.0.1]/x.ics", "https://metadata.google.internal/x", "https://localhost./x.ics"]) {
      const result = icsUrlSchema.safeParse(value);
      expect(result.success, value).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.message).toMatch(/private network/);
    }
    expect(icsUrlSchema.parse("webcal://calendar.google.com/calendar/ical/x/private-y/basic.ics")).toBe(
      "https://calendar.google.com/calendar/ical/x/private-y/basic.ics",
    );
  });
});

describe("other fields", () => {
  it("emails are trimmed and lower-cased", () => {
    expect(emailSchema.parse("  Ada@Example.COM ")).toBe("ada@example.com");
    expect(emailSchema.safeParse("not-an-email").success).toBe(false);
  });

  it("time zones must be IANA names", () => {
    expect(timeZoneSchema.safeParse("America/Denver").success).toBe(true);
    expect(timeZoneSchema.safeParse("Mountain Time").success).toBe(false);
  });

  it("instants need an explicit zone", () => {
    expect(instantSchema.parse("2026-10-14T15:00:00Z").toISOString()).toBe("2026-10-14T15:00:00.000Z");
    expect(instantSchema.parse("2026-10-14T09:00:00-06:00").toISOString()).toBe("2026-10-14T15:00:00.000Z");
    expect(instantSchema.safeParse("2026-10-14T15:00:00").success).toBe(false);
    expect(instantSchema.safeParse("2026-10-14").success).toBe(false);
    expect(instantSchema.safeParse("tomorrow").success).toBe(false);
  });

  it("scrubSource keeps campaign labels and refuses people and secrets", () => {
    expect(scrubSource("linkedin")).toBe("linkedin");
    expect(scrubSource("  newsletter-oct <script> ")).toBe("newsletter-oct script");
    expect(scrubSource("ada@example.com")).toBeNull();
    expect(scrubSource("x9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2")).toBeNull();
    expect(scrubSource("a".repeat(300))?.length).toBe(100);
    expect(scrubSource("")).toBeNull();
    expect(scrubSource(undefined)).toBeNull();
  });
});

describe("tokens", () => {
  it("are 32 random bytes as base64url, hashed to sha256 hex", async () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(token);
    expect(looksLikeToken(token)).toBe(true);
    expect(looksLikeToken("../../etc")).toBe(false);
    const hash = await hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken(token)).toBe(hash);
  });
});

describe("bookingPermissions", () => {
  it("declares the four booking.* keys and nothing outside its namespace", () => {
    expect(Object.keys(bookingPermissions).sort()).toEqual([
      "booking.availability.manage",
      "booking.calls.manage",
      "booking.calls.view",
      "booking.settings.manage",
    ]);
    for (const definition of Object.values(bookingPermissions)) {
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.defaultFor).toContain("admin");
    }
  });
});
