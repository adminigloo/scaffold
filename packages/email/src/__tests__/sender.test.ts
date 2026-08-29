import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  formatSenderAddress,
  InvalidSenderAddressError,
  parseSenderAddress,
} from "../sender.js";

describe("parseSenderAddress — the bare form", () => {
  it("parses a plain address", () => {
    expect(parseSenderAddress("hello@x.com")).toEqual({
      name: null,
      email: "hello@x.com",
    });
  });

  it("trims surrounding whitespace, which is what a pasted env value has", () => {
    expect(parseSenderAddress("  hello@x.com \n")).toEqual({
      name: null,
      email: "hello@x.com",
    });
  });

  it("keeps a plus-tag and a dotted local part intact", () => {
    expect(parseSenderAddress("no.reply+billing@mail.x.co.uk")?.email).toBe(
      "no.reply+billing@mail.x.co.uk",
    );
  });

  it("accepts a punycode domain", () => {
    expect(parseSenderAddress("hi@xn--80ak6aa92e.xn--p1ai")).not.toBeNull();
  });
});

describe("parseSenderAddress — the display-name form", () => {
  it("parses the form that took riddler-go down at boot", () => {
    expect(parseSenderAddress("Riddler Go <hello@riddlergo.com>")).toEqual({
      name: "Riddler Go",
      email: "hello@riddlergo.com",
    });
  });

  it("is exactly the string z.email() rejects", () => {
    // Pinning the claim rather than asserting it in a comment. This is the
    // whole reason the parser exists: the value is correct, deliverability
    // guidance recommends it, and the validator riddler-go reached for calls
    // it "Invalid email" — at boot, so the server never starts.
    const value = "Riddler Go <hello@riddlergo.com>";
    expect(z.email().safeParse(value).success).toBe(false);
    expect(parseSenderAddress(value)).not.toBeNull();
  });

  it("tolerates ragged spacing around the brackets", () => {
    expect(parseSenderAddress("Riddler Go   <  hello@x.com  >")).toEqual({
      name: "Riddler Go",
      email: "hello@x.com",
    });
  });

  it("treats angle brackets with no name as a bare address", () => {
    expect(parseSenderAddress("<hello@x.com>")).toEqual({
      name: null,
      email: "hello@x.com",
    });
  });

  it("allows dots, apostrophes and parentheses in an unquoted name", () => {
    // The over-validation this parser exists to undo. `Acme Inc.` is a real
    // company name and rejecting it is the same class of bug as rejecting the
    // display-name form at all.
    expect(parseSenderAddress("Acme Inc. <hi@acme.com>")?.name).toBe("Acme Inc.");
    expect(parseSenderAddress("O'Brien Ltd (Support) <hi@ob.com>")?.name).toBe(
      "O'Brien Ltd (Support)",
    );
  });
});

describe("parseSenderAddress — quoted display names", () => {
  it("unquotes a name containing a comma", () => {
    expect(parseSenderAddress('"Riddler, Go" <hello@x.com>')).toEqual({
      name: "Riddler, Go",
      email: "hello@x.com",
    });
  });

  it("REJECTS the same comma unquoted", () => {
    // An unquoted comma in a display name makes the header parse as two
    // addresses: `From: Riddler, Go <hello@x.com>` is "Riddler" plus
    // "Go <hello@x.com>" to a strict MTA. Accepting it here produces mail that
    // is delivered by some providers, silently dropped by others, and
    // impossible to diagnose from our side.
    expect(parseSenderAddress("Riddler, Go <hello@x.com>")).toBeNull();
    expect(parseSenderAddress("Riddler; Go <hello@x.com>")).toBeNull();
    expect(parseSenderAddress("Sales: Riddler <hello@x.com>")).toBeNull();
  });

  it("unescapes an embedded quote", () => {
    expect(parseSenderAddress('"Riddler \\"Go\\"" <hello@x.com>')?.name).toBe(
      'Riddler "Go"',
    );
  });

  it("unescapes an embedded backslash", () => {
    expect(parseSenderAddress('"A\\\\B" <hello@x.com>')?.name).toBe("A\\B");
  });

  it("keeps an address that happens to sit inside the quoted name", () => {
    expect(parseSenderAddress('"a<b" <x@y.com>')).toEqual({
      name: "a<b",
      email: "x@y.com",
    });
  });

  it("rejects a quoted name that never closes", () => {
    expect(parseSenderAddress('"Riddler Go <hello@x.com>')).toBeNull();
  });

  it("rejects a dangling escape, which is an unterminated quote in disguise", () => {
    // `"Riddler\" <a@b.com>` looks closed but the quote it ends on is escaped.
    expect(parseSenderAddress('"Riddler\\" <hello@x.com>')).toBeNull();
  });

  it("treats an empty quoted name as no name at all", () => {
    expect(parseSenderAddress('"" <hello@x.com>')).toEqual({
      name: null,
      email: "hello@x.com",
    });
  });
});

describe("parseSenderAddress — rubbish", () => {
  const rubbish = [
    "",
    "   ",
    "hello",
    "hello@",
    "@x.com",
    "hello@@x.com",
    "a@b@c.com",
    "hello@localhost",
    "hello@com",
    "hello world@x.com",
    "hello@x .com",
    "hello@-x.com",
    "hello@x-.com",
    "hello@x..com",
    ".hello@x.com",
    "hello.@x.com",
    "hel..lo@x.com",
    "hello@192.168.0.1",
    "Riddler Go <hello@x.com",
    "Riddler Go hello@x.com>",
    "Riddler Go <>",
    "Riddler Go <not-an-address>",
    "<>",
    "a@x.com, b@x.com",
    "Riddler Go <a@x.com> trailing",
  ];

  for (const value of rubbish) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      expect(parseSenderAddress(value)).toBeNull();
    });
  }

  it("rejects null and undefined rather than throwing on them", () => {
    // These arrive as unset optional environment variables, and a call site
    // that has to guard first is a call site that forgets.
    expect(parseSenderAddress(null)).toBeNull();
    expect(parseSenderAddress(undefined)).toBeNull();
  });

  it("rejects an over-long local part and an over-long address", () => {
    expect(parseSenderAddress(`${"a".repeat(65)}@x.com`)).toBeNull();
    expect(parseSenderAddress(`${"a".repeat(250)}@x.com`)).toBeNull();
  });
});

describe("parseSenderAddress — header injection", () => {
  // A display name is copied verbatim into a `From:` header. A CR or LF ends
  // that header and begins whatever the attacker wrote next, so a name of
  // `Riddler\r\nBcc: them@evil.com` is a way to add recipients to somebody
  // else's mail. Providers vary in whether they reject it; we do not.
  const injections = [
    "Riddler\r\nBcc: them@evil.com <hello@x.com>",
    "Riddler\nBcc: them@evil.com <hello@x.com>",
    '"Riddler\r\nBcc: them@evil.com" <hello@x.com>',
    `Riddler${String.fromCharCode(0)}Go <hello@x.com>`,
  ];

  for (const value of injections) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      expect(parseSenderAddress(value)).toBeNull();
    });
  }
});

describe("formatSenderAddress", () => {
  it("emits a bare address when there is no name", () => {
    expect(formatSenderAddress({ name: null, email: "hello@x.com" })).toBe(
      "hello@x.com",
    );
  });

  it("emits the display-name form", () => {
    expect(formatSenderAddress({ name: "Riddler Go", email: "hello@x.com" })).toBe(
      "Riddler Go <hello@x.com>",
    );
  });

  it("quotes a name that would otherwise re-parse the header", () => {
    expect(formatSenderAddress({ name: "Riddler, Go", email: "hello@x.com" })).toBe(
      '"Riddler, Go" <hello@x.com>',
    );
  });

  it("escapes quotes and backslashes inside a quoted name", () => {
    expect(formatSenderAddress({ name: 'A"B\\C', email: "hello@x.com" })).toBe(
      '"A\\"B\\\\C" <hello@x.com>',
    );
  });

  it("treats a whitespace-only name as no name", () => {
    expect(formatSenderAddress({ name: "   ", email: "hello@x.com" })).toBe(
      "hello@x.com",
    );
  });

  it("refuses to build a header from an unusable address", () => {
    expect(() => formatSenderAddress({ name: null, email: "nope" })).toThrow(
      InvalidSenderAddressError,
    );
  });

  it("refuses a name carrying a newline instead of emitting it", () => {
    // The one place this could become header injection from our own side.
    expect(() =>
      formatSenderAddress({ name: "Riddler\r\nBcc: them@evil.com", email: "a@x.com" }),
    ).toThrow(InvalidSenderAddressError);
  });

  it("names the variable in the error, so the fix is obvious", () => {
    expect(() => formatSenderAddress({ name: null, email: "nope" }, "EMAIL_FROM")).toThrow(
      /EMAIL_FROM/,
    );
  });
});

describe("parse and format round-trip", () => {
  const values = [
    "hello@x.com",
    "Riddler Go <hello@x.com>",
    '"Riddler, Go" <hello@x.com>',
    '"Riddler \\"Go\\"" <hello@x.com>',
    "Acme Inc. <hi@acme.com>",
    "no.reply+billing@mail.x.co.uk",
  ];

  for (const value of values) {
    it(`survives ${JSON.stringify(value)}`, () => {
      const parsed = parseSenderAddress(value);
      expect(parsed).not.toBeNull();
      if (parsed === null) return;
      const formatted = formatSenderAddress(parsed);
      // The law that matters: whatever the parser accepted, the formatter can
      // re-emit and the parser reads back identically. Without it, a name with
      // a comma survives one hop and turns into two recipients on the next.
      expect(parseSenderAddress(formatted)).toEqual(parsed);
    });
  }

  it("normalises the two spellings of the same address to one output", () => {
    const bare = parseSenderAddress("hello@x.com");
    const bracketed = parseSenderAddress("<hello@x.com>");
    expect(bare).toEqual(bracketed);
  });
});
