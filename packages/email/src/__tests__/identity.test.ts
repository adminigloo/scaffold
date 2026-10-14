import { describe, expect, it } from "vitest";
import {
  createEmailSender,
  EmailMessageInvalidError,
  type EmailMessage,
  type OutboundEmail,
  type TransportResult,
} from "../send.js";
import { parseSenderAddress, sanitizeDisplayName } from "../sender.js";

/**
 * Tenancy 2a, D8: a company's emails go out under the company's NAME on the
 * platform's verified address, with the company's own Reply-To. These pin the
 * per-message fields and, just as hard, that a message without them is 0.2's
 * output byte for byte.
 */

const FROM = "Igloo Back Office <hello@igloo.test>";

function capture() {
  const calls: OutboundEmail[] = [];
  return {
    calls,
    send: async (outbound: OutboundEmail): Promise<TransportResult> => {
      calls.push(outbound);
      return { id: `msg_${calls.length}` };
    },
  };
}

const base: EmailMessage = {
  to: "customer@example.com",
  subject: "Your visit",
  text: "See you Tuesday.",
};

describe("per-message fromName", () => {
  it("puts the company's name on the platform's own address", async () => {
    const t = capture();
    const sender = createEmailSender({ from: FROM, send: t.send });
    const outcome = await sender.send({ ...base, fromName: "Green Acres" });
    expect(t.calls[0]?.from).toBe("Green Acres <hello@igloo.test>");
    // The log records the From actually used.
    expect(outcome.log.fromAddress).toBe("Green Acres <hello@igloo.test>");
  });

  it("quotes a name with a comma, so it stays one address", async () => {
    const t = capture();
    const sender = createEmailSender({ from: FROM, send: t.send });
    await sender.send({ ...base, fromName: "Green Acres, LLC" });
    const from = t.calls[0]?.from ?? "";
    expect(from).toBe('"Green Acres, LLC" <hello@igloo.test>');
    // Round-trips through the parser as ONE address with the whole name.
    expect(parseSenderAddress(from)).toEqual({ name: "Green Acres, LLC", email: "hello@igloo.test" });
  });

  it("strips CR and LF, so a name can never add a header", async () => {
    const t = capture();
    const sender = createEmailSender({ from: FROM, send: t.send });
    await sender.send({ ...base, fromName: "Green\r\nBcc: thief@evil.test" });
    const from = t.calls[0]?.from ?? "";
    expect(from).not.toMatch(/[\r\n]/);
    expect(from.startsWith('"Green Bcc: thief@evil.test" <hello@igloo.test>')).toBe(true);
  });

  it("falls back to the sender's own name when the name is empty after cleaning", async () => {
    const t = capture();
    const sender = createEmailSender({ from: FROM, send: t.send });
    await sender.send({ ...base, fromName: " \t\n " });
    await sender.send({ ...base, fromName: null });
    expect(t.calls[0]?.from).toBe(FROM);
    expect(t.calls[1]?.from).toBe(FROM);
  });

  it("works on a bare EMAIL_FROM too", async () => {
    const t = capture();
    const sender = createEmailSender({ from: "hello@igloo.test", send: t.send });
    await sender.send({ ...base, fromName: "Summit Lawn" });
    expect(t.calls[0]?.from).toBe("Summit Lawn <hello@igloo.test>");
  });

  it("is recorded on a skipped send too, so an unconfigured site shows who it would have been", async () => {
    const sender = createEmailSender({ from: FROM });
    const outcome = await sender.send({ ...base, fromName: "Green Acres" });
    expect(outcome.status).toBe("skipped");
    expect(outcome.log.fromAddress).toBe("Green Acres <hello@igloo.test>");
  });
});

describe("per-message replyTo", () => {
  it("replaces the default Reply-To", async () => {
    const t = capture();
    const sender = createEmailSender({ from: FROM, replyTo: "owner@igloo.test", send: t.send });
    await sender.send({ ...base, replyTo: "gail@greenacres.test" });
    expect(t.calls[0]?.replyTo).toBe("gail@greenacres.test");
  });

  it("accepts a named reply-to", async () => {
    const t = capture();
    const sender = createEmailSender({ from: FROM, send: t.send });
    await sender.send({ ...base, replyTo: "Gail <gail@greenacres.test>" });
    expect(t.calls[0]?.replyTo).toBe("Gail <gail@greenacres.test>");
  });

  it("refuses an unparseable reply-to with a typed error naming the field", async () => {
    const t = capture();
    const sender = createEmailSender({ from: FROM, replyTo: "owner@igloo.test", send: t.send });
    const error = await sender.send({ ...base, replyTo: "not an address" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailMessageInvalidError);
    expect((error as EmailMessageInvalidError).field).toBe("replyTo");
    expect(t.calls).toHaveLength(0);
  });

  it("an empty or null reply-to keeps the default", async () => {
    const t = capture();
    const sender = createEmailSender({ from: FROM, replyTo: "owner@igloo.test", send: t.send });
    await sender.send({ ...base, replyTo: "" });
    await sender.send({ ...base, replyTo: null });
    expect(t.calls.map((c) => c.replyTo)).toEqual(["owner@igloo.test", "owner@igloo.test"]);
  });
});

describe("with neither field", () => {
  it("is 0.2's output exactly", async () => {
    const t = capture();
    const sender = createEmailSender({ from: FROM, replyTo: "owner@igloo.test", send: t.send });
    const outcome = await sender.send({ ...base, template: "visit", tenantId: "t1" });
    expect(t.calls[0]).toEqual({
      from: FROM,
      to: "customer@example.com",
      replyTo: "owner@igloo.test",
      subject: "Your visit",
      html: null,
      text: "See you Tuesday.",
    });
    expect(outcome.log).toEqual({
      messageId: "msg_1",
      toAddress: "customer@example.com",
      fromAddress: FROM,
      subject: "Your visit",
      template: "visit",
      tenantId: "t1",
      status: "sent",
      provider: "resend",
      error: null,
      metadata: null,
    });
  });
});

describe("sanitizeDisplayName", () => {
  it("collapses whitespace and trims", () => {
    expect(sanitizeDisplayName("  Green   Acres \t")).toBe("Green Acres");
  });

  it("removes control characters", () => {
    expect(sanitizeDisplayName("Green\u0000Acres\u007f")).toBe("Green Acres");
  });

  it("cuts to max at a character boundary", () => {
    expect(sanitizeDisplayName("a".repeat(100))).toHaveLength(64);
    expect(sanitizeDisplayName("Green Acres", 5)).toBe("Green");
    // An emoji is never split into half a surrogate pair.
    const cut = sanitizeDisplayName("ab🌲cd", 3) ?? "";
    expect(cut).toBe("ab🌲");
  });

  it("is null for nothing", () => {
    expect(sanitizeDisplayName(undefined)).toBeNull();
    expect(sanitizeDisplayName(null)).toBeNull();
    expect(sanitizeDisplayName("   ")).toBeNull();
    expect(sanitizeDisplayName("\r\n")).toBeNull();
  });
});
