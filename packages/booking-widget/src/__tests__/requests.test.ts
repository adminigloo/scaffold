import { describe, expect, it } from "vitest";
import {
  alreadyBookedMessage,
  buildBookRequest,
  emailsOn,
  EMPTY_FORM,
  firstInvalidField,
  friendlyError,
  isSlotGone,
  isValidEmail,
  issuesToFieldErrors,
  networkError,
  normalizeCallingCode,
  normalizeIssues,
  normalizePhone,
  orderedMedia,
  phoneProblem,
  reachHost,
  reachHostText,
  scrubSource,
  sourceFromSearch,
  toBookingError,
  validateBookForm,
  type BookFormValues,
} from "../requests.js";

const filled: BookFormValues = {
  name: "  Ada Lovelace ",
  email: " ada@example.com ",
  phone: "",
  company: "",
  notes: "",
  medium: "video",
};

describe("phone numbers", () => {
  it("keeps 7–15 digits after a REQUIRED country code, whatever the separators", () => {
    expect(normalizePhone("+1 (801) 555-0143")).toBe("+18015550143");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("+1.801.555.0143")).toBe("+18015550143");
    expect(normalizePhone("0044 20 7946 0958")).toBe("+442079460958");
    // No country code: not guessed (it would dial somewhere in the 80x range).
    expect(normalizePhone("(801) 555-0143")).toBeNull();
    expect(normalizePhone("+555-01")).toBeNull();
    expect(normalizePhone("+1234567890123456")).toBeNull();
    expect(normalizePhone("call me maybe")).toBeNull();
    expect(normalizePhone("801+555+0143")).toBeNull();
    expect(normalizePhone("   ")).toBeNull();
  });
});

describe("phone numbers with a default calling code (mirrors the server)", () => {
  const us = { defaultCallingCode: "1" };

  it("reads a national number in the default country, dropping one trunk prefix", () => {
    expect(normalizePhone("(801) 555-0143", us)).toBe("+18015550143");
    expect(normalizePhone("1 801 555 0143", us)).toBe("+18015550143");
    expect(normalizePhone("020 7946 0958", { defaultCallingCode: "44" })).toBe("+442079460958");
    expect(normalizePhone("06 6988 3712", { defaultCallingCode: "39" })).toBe("+390669883712");
    // International numbers are still read as written.
    expect(normalizePhone("+44 20 7946 0958", us)).toBe("+442079460958");
    expect(normalizePhone("0044 20 7946 0958", us)).toBe("+442079460958");
    expect(normalizePhone("555", us)).toBeNull();
  });

  it("only takes real calling codes", () => {
    expect(normalizeCallingCode("+1")).toBe("1");
    expect(normalizeCallingCode("353")).toBe("353");
    for (const bad of ["", "0", "1234", "US", null, 1]) expect(normalizeCallingCode(bad)).toBeNull();
    expect(normalizePhone("801 555 0143", { defaultCallingCode: "US" })).toBeNull();
  });

  it("the form accepts a national number and says what it expects when it can't", () => {
    expect(validateBookForm({ ...filled, medium: "phone", phone: "801 555 0143" }, ["phone"], us)).toEqual({});
    expect(validateBookForm({ ...filled, medium: "phone", phone: "555" }, ["phone"], us).phone).toMatch(
      /Outside \+1, start with \+ and the country code/,
    );
  });

  it("the request carries the number the server would have made of it", () => {
    const request = buildBookRequest({
      type: "intro",
      start: "2026-10-06T15:00:00Z",
      values: { ...filled, phone: "801-555-0143" },
      medium: "phone",
      timezone: "America/Denver",
      defaultCallingCode: "1",
    });
    expect(request.phone).toBe("+18015550143");
  });
});

describe("phone numbers with calling code 1 (NANP) — the rule the server applies", () => {
  const us = { defaultCallingCode: "1" };

  // [typed, stored] — null means refused, with a message, before the round trip.
  const table: Array<[string, string | null]> = [
    // National numbers: ten digits, area code and exchange starting 2-9.
    ["801 555 0143", "+18015550143"],
    ["(801) 555-0143", "+18015550143"],
    ["801.555.0143", "+18015550143"],
    // The NANP trunk prefix: one leading 1, only on eleven digits.
    ["1 801 555 0143", "+18015550143"],
    ["1-801-555-0143", "+18015550143"],
    // NEGATIVE CONTROL for the review's bug: UK "020 7946 0958" typed without
    // its code used to lose its 0 and become +12079460958, a real-looking
    // Maine number. North America has no 0 trunk prefix: refused.
    ["020 7946 0958", null],
    ["0 801 555 0143", null],
    // Wrong digit counts no longer slip through as "7 to 15 digits".
    ["555 0143", null],
    ["801 555 01434", null],
    ["11 801 555 0143", null],
    // Area code or exchange starting 0 or 1 is not a NANP number.
    ["101 555 0143", null],
    ["801 155 0143", null],
    // 011 is how North Americans dial abroad: read as international.
    ["011 44 20 7946 0958", "+442079460958"],
    ["011-33-1-42-68-53-00", "+33142685300"],
    // …and the international number then follows the +CC rules.
    ["011 1 801 555 0143", "+18015550143"],
    ["011 1 020 7946 0958", null],
    // International forms are read as written.
    ["+44 20 7946 0958", "+442079460958"],
    ["0044 20 7946 0958", "+442079460958"],
    // "(0)" right after the country code is a trunk prefix, never part of the number…
    ["+44 (0) 20 7946 0958", "+442079460958"],
    ["+44 (0)20 7946 0958", "+442079460958"],
    ["0044 (0)20 7946 0958", "+442079460958"],
    // …except in Italy, where the 0 belongs to the number: only the brackets go.
    ["+39 (0)6 6988 3712", "+390669883712"],
    // +1 is NANP: exactly ten national digits after it.
    ["+1 801 555 0143", "+18015550143"],
    ["+1 020 7946 0958", null],
    ["+1 801 555 01", null],
    // No country code starts with 0.
    ["+0 801 555 0143", null],
  ];

  it.each(table)("%s → %s", (typed, stored) => {
    expect(normalizePhone(typed, us)).toBe(stored);
    // The form agrees with normalizePhone, both ways.
    const problem = phoneProblem(typed, us);
    if (stored) expect(problem).toBeNull();
    else expect(problem).toMatch(/\S/);
  });

  it("without a default code, 011 is NOT an exit code and +1 is still checked", () => {
    expect(normalizePhone("011 44 20 7946 0958")).toBeNull();
    expect(normalizePhone("+1 020 7946 0958")).toBeNull();
    expect(normalizePhone("+1 801 555 0143")).toBe("+18015550143");
    expect(normalizePhone("+44 (0)20 7946 0958")).toBe("+442079460958");
  });

  it("other default codes keep the one-0 trunk rule (and Italy keeps its 0)", () => {
    expect(normalizePhone("020 7946 0958", { defaultCallingCode: "44" })).toBe("+442079460958");
    expect(normalizePhone("06 6988 3712", { defaultCallingCode: "39" })).toBe("+390669883712");
    // 011 is only an exit code in North America.
    expect(normalizePhone("011 2345 6789", { defaultCallingCode: "44" })).toBe("+441123456789");
    // One trunk 0, not two: "0 020 …" is no number anywhere.
    expect(normalizePhone("0 020 7946 0958", { defaultCallingCode: "44" })).toBeNull();
  });

  it("says WHY a number was refused, in words that say how to fix it", () => {
    expect(phoneProblem("020 7946 0958", us)).toBe(
      "US and Canadian numbers don't start with 0. Outside +1, start with + and the country code (or 011).",
    );
    expect(phoneProblem("555 0143", us)).toBe(
      "Enter a 10-digit US or Canadian number, like 801 555 0143. Outside +1, start with + and the country code.",
    );
    expect(phoneProblem("+1 020 7946 0958", us)).toBe("A +1 number has ten digits after the 1, like +1 801 555 0143.");
    expect(phoneProblem("801 555 0143")).toMatch(/Include the country code, like \+1 801 555 0143/);
    expect(phoneProblem("12", { defaultCallingCode: "44" })).toMatch(/Outside \+44, start with \+/);
    expect(phoneProblem("call me", us)).toMatch(/digits only/);
    expect(phoneProblem("", us)).toBeNull();
    expect(phoneProblem("801 555 0143", us)).toBeNull();
  });

  it("the form shows the specific message on the phone field", () => {
    expect(validateBookForm({ ...filled, medium: "phone", phone: "020 7946 0958" }, ["phone"], us).phone).toMatch(
      /don't start with 0/,
    );
    expect(validateBookForm({ ...filled, medium: "phone", phone: "011 44 20 7946 0958" }, ["phone"], us)).toEqual({});
  });
});

describe("email honesty", () => {
  it("only an explicit false turns email off", () => {
    expect(emailsOn(undefined)).toBe(true);
    expect(emailsOn(null)).toBe(true);
    expect(emailsOn({})).toBe(true);
    expect(emailsOn({ emailsEnabled: true })).toBe(true);
    expect(emailsOn({ emailsEnabled: false })).toBe(false);
  });

  it("sends people to the confirmation email only when one exists, else a contact, else the host by name", () => {
    expect(reachHost({}, "Dallin")).toEqual({ kind: "reply" });
    expect(reachHost({ emailsEnabled: false, contactEmail: "hi@site.test" }, "Dallin")).toEqual({
      kind: "email",
      address: "hi@site.test",
    });
    expect(reachHost({ emailsEnabled: false, contactEmail: "not an email" }, "Dallin")).toEqual({ kind: "direct", who: "Dallin" });
    expect(reachHost({ emailsEnabled: false }, "")).toEqual({ kind: "direct", who: "the host" });
    expect(reachHostText({ kind: "reply" })).toBe("reply to your confirmation email");
    expect(reachHostText({ kind: "email", address: "hi@site.test" })).toBe("email hi@site.test");
    expect(reachHostText({ kind: "direct", who: "Dallin" })).toBe("contact Dallin directly");
  });

  it("already_booked never mentions a confirmation email the server never sent", () => {
    const on = alreadyBookedMessage({}, { sandbox: false, hostDisplayName: "Dallin" });
    expect(on).toMatch(/Check your email for the confirmation/);
    const contact = alreadyBookedMessage({ emailsEnabled: false, contactEmail: "hi@site.test" }, { sandbox: false, hostDisplayName: "Dallin" });
    expect(contact).toBe("You're already booked for this time. To move or cancel it, email hi@site.test.");
    const none = alreadyBookedMessage({ emailsEnabled: false }, { sandbox: false, hostDisplayName: "Dallin" });
    expect(none).toBe("You're already booked for this time. To move or cancel it, contact Dallin directly.");
    for (const message of [contact, none]) expect(message).not.toMatch(/confirmation email|check your email/i);
    expect(alreadyBookedMessage({}, { sandbox: true, hostDisplayName: "Dallin" })).toMatch(/Sandbox — nothing was emailed/);
  });
});

describe("the booking form", () => {
  it("passes a complete form", () => {
    expect(validateBookForm(filled, ["video", "phone"])).toEqual({});
    expect(isValidEmail("ada@example.com")).toBe(true);
  });

  it("names every missing or malformed field", () => {
    const errors = validateBookForm({ ...EMPTY_FORM }, ["video", "phone"]);
    expect(Object.keys(errors).sort()).toEqual(["email", "medium", "name"]);
    expect(validateBookForm({ ...filled, email: "ada@" }, ["video"]).email).toMatch(/valid email/);
    expect(validateBookForm({ ...filled, name: "x".repeat(121) }, ["video"]).name).toMatch(/120/);
    expect(validateBookForm({ ...filled, notes: "x".repeat(1001) }, ["video"]).notes).toMatch(/1000/);
  });

  it("requires a phone only for a phone call, but checks one whenever it is given", () => {
    expect(validateBookForm({ ...filled, medium: "phone" }, ["phone"]).phone).toMatch(/number we should call/);
    expect(validateBookForm({ ...filled, medium: "phone", phone: "+1 801 555 0143" }, ["phone"])).toEqual({});
    expect(validateBookForm({ ...filled, phone: "12" }, ["video"]).phone).toMatch(/7 to 15 digits/);
    expect(validateBookForm({ ...filled, medium: "phone", phone: "801 555 0143" }, ["phone"]).phone).toMatch(
      /Include the country code, like \+1 801 555 0143/,
    );
  });

  it("rejects a medium the type does not offer", () => {
    expect(validateBookForm({ ...filled, medium: "prospect_hosted" }, ["video", "phone"]).medium).toBeTruthy();
  });

  it("points focus at the first problem in visual order", () => {
    expect(firstInvalidField({ notes: "x", email: "y" })).toBe("email");
    expect(firstInvalidField({ phone: "x", medium: "y" })).toBe("medium");
    expect(firstInvalidField({})).toBeNull();
  });

  it("orders the radios the same way whatever order the server lists them", () => {
    expect(orderedMedia(["prospect_hosted", "video"])).toEqual(["video", "prospect_hosted"]);
  });
});

describe("the book request", () => {
  it("trims, and omits optional fields that are empty", () => {
    const request = buildBookRequest({
      type: "intro",
      start: "2026-10-06T15:00:00Z",
      values: filled,
      medium: "video",
      timezone: "America/Denver",
    });
    expect(request).toEqual({
      type: "intro",
      start: "2026-10-06T15:00:00Z",
      name: "Ada Lovelace",
      email: "ada@example.com",
      medium: "video",
      timezone: "America/Denver",
    });
    expect("holdToken" in request).toBe(false);
    expect("phone" in request).toBe(false);
  });

  it("carries the hold, a normalized phone, the extras and a scrubbed source", () => {
    const request = buildBookRequest({
      type: "intro",
      start: "2026-10-06T15:00:00Z",
      holdToken: "hold_abc",
      values: { ...filled, phone: "+1 (801) 555-0143", company: " Analytical Engines ", notes: " Bring the diagrams " },
      medium: "phone",
      timezone: "Europe/London",
      source: "newsletter<script>/oct",
    });
    expect(request).toMatchObject({
      holdToken: "hold_abc",
      phone: "+18015550143",
      company: "Analytical Engines",
      notes: "Bring the diagrams",
      medium: "phone",
      source: "newsletterscript/oct",
    });
  });
});

describe("attribution", () => {
  it("scrubs to printable, short, markup-free text", () => {
    expect(scrubSource("google / cpc")).toBe("google / cpc");
    expect(scrubSource('"><img src=x>')).toBe("img srcx");
    expect(scrubSource("a".repeat(150))).toHaveLength(100);
    expect(scrubSource("<<>>")).toBeUndefined();
  });

  it("prefers ?src=, else joins the UTM tags", () => {
    expect(sourceFromSearch("?src=launch&utm_source=x")).toBe("launch");
    expect(sourceFromSearch("?utm_source=newsletter&utm_medium=email&utm_campaign=october")).toBe(
      "newsletter/email/october",
    );
    expect(sourceFromSearch("?utm_campaign=only")).toBe("only");
    expect(sourceFromSearch("")).toBeUndefined();
  });
});

describe("server errors", () => {
  it("reads the contract's error body", () => {
    const error = toBookingError(409, { error: { code: "slot_taken", message: "taken" } });
    expect(error).toEqual({ code: "slot_taken", message: "taken", status: 409, issues: [] });
    expect(isSlotGone(error)).toBe(true);
    expect(isSlotGone(toBookingError(409, { error: { code: "hold_expired", message: "x" } }))).toBe(true);
    expect(isSlotGone(toBookingError(429, { error: { code: "rate_limited", message: "x" } }))).toBe(false);
  });

  it("falls back to the status when the body is not the contract's", () => {
    expect(toBookingError(409, null).code).toBe("slot_taken");
    expect(toBookingError(404, "<html>").code).toBe("not_found");
    expect(toBookingError(402, {}).code).toBe("unlicensed");
    expect(toBookingError(429, { error: { code: "weird", message: "x" } }).code).toBe("rate_limited");
    expect(toBookingError(502, null).code).toBe("server");
    expect(toBookingError(500, { error: "boom" }).message).toBe("boom");
  });

  it("accepts zod's raw issues and its flatten() shape", () => {
    expect(normalizeIssues([{ path: ["email"], message: "Invalid email" }, { path: "phone", message: "Too short" }])).toEqual([
      { path: ["email"], message: "Invalid email" },
      { path: ["phone"], message: "Too short" },
    ]);
    expect(normalizeIssues({ formErrors: [], fieldErrors: { name: ["Required"], notes: ["Too long", "x"] } })).toEqual([
      { path: ["name"], message: "Required" },
      { path: ["notes"], message: "Too long" },
      { path: ["notes"], message: "x" },
    ]);
    expect(normalizeIssues("nonsense")).toEqual([]);
    const error = toBookingError(400, {
      error: { code: "invalid", message: "bad", issues: [{ path: ["phone"], message: "Phone is required for a phone call" }] },
    });
    expect(error.issues).toHaveLength(1);
  });

  it("maps issues onto form fields, first message per field, ignoring non-form paths", () => {
    expect(
      issuesToFieldErrors([
        { path: ["email"], message: "first" },
        { path: ["email"], message: "second" },
        { path: ["start"], message: "not a field" },
        { path: [], message: "root" },
      ]),
    ).toEqual({ email: "first" });
  });

  it("says something human for each code, by context", () => {
    expect(friendlyError(networkError(), "slots")).toMatch(/couldn't reach/);
    expect(friendlyError(toBookingError(429, null), "hold")).toMatch(/Wait a minute/);
    // A rate limit names the host's human address when the app gave one, and only a valid one.
    expect(friendlyError(toBookingError(429, null), "book", { emailsEnabled: false, contactEmail: "dallin@adminigloo.test" })).toBe(
      "That's a lot of tries in a short time. Wait a minute, then try again. Or email dallin@adminigloo.test.",
    );
    expect(friendlyError(toBookingError(429, null), "book", { contactEmail: "not an address" })).not.toMatch(/email/);
    expect(friendlyError(toBookingError(429, null), "book", null)).not.toMatch(/email/);
    expect(friendlyError(toBookingError(402, null), "config")).toMatch(/isn't available/);
    expect(friendlyError(toBookingError(409, null), "book")).toMatch(/Someone just booked that time/);
    expect(friendlyError(toBookingError(409, { error: { code: "hold_expired", message: "" } }), "book")).toMatch(
      /hold on that time ran out/,
    );
    expect(friendlyError(toBookingError(404, null), "manage")).toMatch(/no longer valid/);
    expect(friendlyError(toBookingError(404, null), "config")).toMatch(/nothing to book/);
    const invalid = toBookingError(400, { error: { code: "invalid", message: "x", issues: [{ path: ["email"], message: "m" }] } });
    expect(friendlyError(invalid, "book")).toMatch(/highlighted fields/);
    expect(friendlyError(toBookingError(400, null), "book")).toMatch(/weren't accepted/);
    expect(friendlyError(toBookingError(400, null), "hold")).toMatch(/can't be booked any more/);
    expect(friendlyError(toBookingError(500, null), "book")).toMatch(/on our side/);
  });

  it("already_booked: the first submit worked — not a lost time to pick again", () => {
    const error = toBookingError(409, { error: { code: "already_booked", message: "x" } });
    expect(error.code).toBe("already_booked");
    expect(isSlotGone(error)).toBe(false);
    expect(friendlyError(error, "book")).toMatch(/already booked/);
    expect(friendlyError(error, "book")).toMatch(/Check your email/);
  });
});
