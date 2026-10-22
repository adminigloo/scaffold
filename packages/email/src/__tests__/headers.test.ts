import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmailSender,
  createResendTransport,
  EmailMessageInvalidError,
  type EmailMessage,
  type OutboundEmail,
  type TransportResult,
} from "../send.js";

/**
 * Extra headers and the idempotency key (0.5): what a digest needs to carry
 * RFC 8058's one-click unsubscribe, and to be retried without arriving twice.
 */

const FROM = "Alma <hello@alma.example.com>";
const UNSUBSCRIBE = {
  "List-Unsubscribe": "<https://alma.example.com/api/email/v1/unsubscribe?t=abc.def>",
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
};

const message: EmailMessage = {
  to: "pat@example.com",
  subject: "Morning summary: Tuesday, October 21",
  text: "Good morning",
  html: "<p>Good morning</p>",
  headers: UNSUBSCRIBE,
  idempotencyKey: "digest:morning:user_1:2026-10-21",
};

function recording() {
  const calls: OutboundEmail[] = [];
  return {
    calls,
    transport: async (outbound: OutboundEmail): Promise<TransportResult> => {
      calls.push(outbound);
      return { id: "msg_1" };
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extra headers and the idempotency key reach the transport", () => {
  it("hands both over as given", async () => {
    const { calls, transport } = recording();
    await createEmailSender({ from: FROM, send: transport }).send(message);
    expect(calls[0]?.headers).toEqual(UNSUBSCRIBE);
    expect(calls[0]?.idempotencyKey).toBe("digest:morning:user_1:2026-10-21");
  });

  it("hands over neither key for a message with neither (an older transport sees what it always did)", async () => {
    const { calls, transport } = recording();
    await createEmailSender({ from: FROM, send: transport }).send({ to: "pat@example.com", subject: "Hi", text: "Hi" });
    expect(Object.keys(calls[0] ?? {})).not.toContain("headers");
    expect(Object.keys(calls[0] ?? {})).not.toContain("idempotencyKey");
  });

  it("Resend gets the headers in the body and the key as Idempotency-Key", async () => {
    const spy = vi.fn(async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ id: "msg_r" }) }));
    vi.stubGlobal("fetch", spy);
    await createResendTransport("re_test_000")({
      from: FROM,
      to: "pat@example.com",
      replyTo: null,
      subject: "Hi",
      html: null,
      text: "Hi",
      headers: UNSUBSCRIBE,
      idempotencyKey: "digest:k",
    });
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe("digest:k");
    expect(JSON.parse(String(init.body)).headers).toEqual(UNSUBSCRIBE);
  });

  it("Resend gets neither when the message has neither", async () => {
    const spy = vi.fn(async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ id: "msg_r" }) }));
    vi.stubGlobal("fetch", spy);
    await createResendTransport("re_test_000")({ from: FROM, to: "pat@example.com", replyTo: null, subject: "Hi", html: null, text: "Hi" });
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain("idempotency-key");
    expect(Object.keys(JSON.parse(String(init.body)))).not.toContain("headers");
  });
});

describe("a header that would change the message is refused, never dropped", () => {
  const send = (overrides: Partial<EmailMessage>) =>
    createEmailSender({ from: FROM, send: recording().transport }).send({ ...message, ...overrides });

  it.each([
    ["a line break in a value (header injection)", { "List-Unsubscribe": "<https://a.example.com>\r\nBcc: x@evil.example.com" }],
    ["a header the message's own fields write", { Subject: "Another subject" }],
    ["the same header twice", { "list-unsubscribe": "<https://a.example.com>", "List-Unsubscribe": "<https://b.example.com>" }],
    ["a name that isn't a header name", { "List Unsubscribe": "<https://a.example.com>" }],
    ["an empty value", { "List-Unsubscribe": "  " }],
  ])("%s", async (_label, headers) => {
    await expect(send({ headers })).rejects.toThrow(EmailMessageInvalidError);
    await expect(send({ headers })).rejects.toMatchObject({ field: "headers" });
  });

  it("refuses them on an unconfigured deployment too, so a laptop finds the bug", async () => {
    await expect(
      createEmailSender({ from: FROM }).send({ ...message, headers: { To: "someone@example.com" } }),
    ).rejects.toMatchObject({ field: "headers" });
  });

  it.each([["with a space"], [""], ["x".repeat(257)], ["é"]])("an idempotency key %j is refused", async (key) => {
    await expect(send({ idempotencyKey: key })).rejects.toMatchObject({ field: "idempotencyKey" });
  });

  it("skips (no key) with the headers checked and nothing sent", async () => {
    const outcome = await createEmailSender({ from: FROM }).send(message);
    expect(outcome.status).toBe("skipped");
  });
});
