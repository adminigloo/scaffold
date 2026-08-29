import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmailSender,
  createResendTransport,
  EmailMessageInvalidError,
  EmailTransportError,
  type EmailMessage,
  type OutboundEmail,
  type TransportResult,
} from "../send.js";
import { InvalidSenderAddressError } from "../sender.js";

const FROM = "Riddler Go <hello@riddlergo.com>";
const API_KEY = "re_TestKey_000000000000";

const message: EmailMessage = {
  to: "customer@example.com",
  subject: "Your receipt",
  html: "<p>Thanks</p>",
  template: "receipt",
  tenantId: "t_42",
  metadata: { invoiceId: "in_1" },
};

/** Records what it was handed, so the dispatch path is observable. */
function recordingTransport(result: TransportResult = { id: "msg_1" }) {
  const calls: OutboundEmail[] = [];
  return {
    calls,
    transport: async (outbound: OutboundEmail): Promise<TransportResult> => {
      calls.push(outbound);
      return result;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createEmailSender — an unconfigured deployment", () => {
  it("skips instead of throwing, and never touches the network", () => {
    // The reason this package exists. A deployment with no credential must
    // still run every feature that happens to send mail: throwing here means
    // sign-up cannot finish because the welcome email cannot be sent.
    const fetchSpy = vi.fn(() => {
      throw new Error("the network was touched");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const sender = createEmailSender({ from: FROM });
    expect(sender.configured).toBe(false);

    return sender.send(message).then((outcome) => {
      expect(outcome.status).toBe("skipped");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it("logs the whole intent, so a developer can read off what would have gone", () => {
    const sender = createEmailSender({ from: FROM });
    return sender.send(message).then((outcome) => {
      expect(outcome.log).toEqual({
        messageId: null,
        toAddress: "customer@example.com",
        fromAddress: "Riddler Go <hello@riddlergo.com>",
        subject: "Your receipt",
        template: "receipt",
        tenantId: "t_42",
        status: "skipped",
        provider: "resend",
        error: null,
        metadata: { invoiceId: "in_1" },
      });
    });
  });

  it("records no error, because nothing failed", () => {
    // `skipped` is an outcome, not a failure. A row with an error message here
    // would show up in every "recent email failures" query and train whoever
    // reads it to ignore the list.
    const sender = createEmailSender({ from: FROM });
    return sender.send(message).then((outcome) => {
      expect(outcome.log.error).toBeNull();
      expect(outcome.log.messageId).toBeNull();
      if (outcome.status !== "skipped") throw new Error("expected a skip");
      expect(outcome.reason).toBe("no-transport");
    });
  });

  it("still validates the message, so a bug is not hidden by the skip", () => {
    // Otherwise every message is "fine" until the day a key is added, and the
    // first thing the new credential does is surface a year of broken calls.
    const sender = createEmailSender({ from: FROM });
    return expect(
      sender.send({ to: message.to, subject: "", html: "<p>x</p>" }),
    ).rejects.toThrow(EmailMessageInvalidError);
  });
});

describe("createEmailSender — the dispatch path", () => {
  it("sends through an injected transport and returns the provider id", async () => {
    const { calls, transport } = recordingTransport({ id: "msg_abc" });
    const sender = createEmailSender({ apiKey: API_KEY, from: FROM, send: transport });

    const outcome = await sender.send(message);

    expect(outcome.status).toBe("sent");
    expect(outcome.log.status).toBe("sent");
    expect(outcome.log.messageId).toBe("msg_abc");
    expect(calls).toHaveLength(1);
  });

  it("treats an injected transport as configuration even with no API key", () => {
    // The seam for a deployment sending through something other than Resend,
    // and for these tests. Handing us a way to send is an explicit statement
    // that this deployment sends.
    const { transport } = recordingTransport();
    const sender = createEmailSender({ from: FROM, send: transport });
    expect(sender.configured).toBe(true);
  });

  it("hands the transport a formatted From with the display name intact", async () => {
    const { calls, transport } = recordingTransport();
    const sender = createEmailSender({
      apiKey: API_KEY,
      from: '"Riddler, Go" <hello@riddlergo.com>',
      send: transport,
    });

    await sender.send(message);

    // Quoted, because an unquoted comma makes the header two addresses.
    expect(calls[0]?.from).toBe('"Riddler, Go" <hello@riddlergo.com>');
  });

  it("passes a reply-to when set and null when not", async () => {
    const withReply = recordingTransport();
    await createEmailSender({
      apiKey: API_KEY,
      from: FROM,
      replyTo: "Support <help@riddlergo.com>",
      send: withReply.transport,
    }).send(message);
    expect(withReply.calls[0]?.replyTo).toBe("Support <help@riddlergo.com>");

    const without = recordingTransport();
    await createEmailSender({
      apiKey: API_KEY,
      from: FROM,
      send: without.transport,
    }).send(message);
    expect(without.calls[0]?.replyTo).toBeNull();
  });

  it("ignores a reply-to that is only whitespace", () => {
    // An unset Vercel variable arrives as "" or " ", and treating that as a
    // value means every reply bounces off an empty header.
    const sender = createEmailSender({ from: FROM, replyTo: "   " });
    expect(sender.replyTo).toBeNull();
  });

  it("records the provider name on the row", async () => {
    const { transport } = recordingTransport();
    const outcome = await createEmailSender({
      from: FROM,
      send: transport,
      provider: "ses",
    }).send(message);
    expect(outcome.log.provider).toBe("ses");
  });

  it("survives a provider that accepts the message without returning an id", async () => {
    const { transport } = recordingTransport({ id: null });
    const outcome = await createEmailSender({ from: FROM, send: transport }).send(
      message,
    );
    expect(outcome.status).toBe("sent");
    expect(outcome.log.messageId).toBeNull();
  });
});

describe("createEmailSender — a transport that fails", () => {
  it("returns the failure instead of throwing it", async () => {
    // The caller's remaining job is to write the row. An exception here loses
    // the record of an attempt that may in fact have been delivered.
    const sender = createEmailSender({
      from: FROM,
      send: async () => {
        throw new EmailTransportError(422, "domain is not verified");
      },
    });

    const outcome = await sender.send(message);

    expect(outcome.status).toBe("failed");
    expect(outcome.log.status).toBe("failed");
    expect(outcome.log.error).toMatch(/domain is not verified/);
    expect(outcome.log.messageId).toBeNull();
  });

  it("keeps the full intent on a failed row, same as a skipped one", async () => {
    const sender = createEmailSender({
      from: FROM,
      send: async () => {
        throw new Error("boom");
      },
    });
    const outcome = await sender.send(message);
    expect(outcome.log.toAddress).toBe("customer@example.com");
    expect(outcome.log.tenantId).toBe("t_42");
    expect(outcome.log.metadata).toEqual({ invoiceId: "in_1" });
  });

  it("normalises a transport that throws something that is not an Error", async () => {
    // `error` is a text column. A thrown string would otherwise reach it as
    // undefined and the row would say a send failed for no reason at all.
    const sender = createEmailSender({
      from: FROM,
      send: async () => {
        throw "rate limited";
      },
    });
    const outcome = await sender.send(message);
    expect(outcome.status).toBe("failed");
    expect(outcome.log.error).toBe("rate limited");
  });
});

describe("createEmailSender — validation", () => {
  const sender = createEmailSender({ from: FROM, send: recordingTransport().transport });

  it("refuses a message with neither html nor text", async () => {
    // A provider accepts this and the recipient gets a blank email, which is
    // worse than an error because nothing anywhere says it went wrong.
    await expect(
      sender.send({ to: "a@x.com", subject: "Hi" }),
    ).rejects.toThrow(EmailMessageInvalidError);
  });

  it("treats a whitespace-only body as no body", async () => {
    await expect(
      sender.send({ to: "a@x.com", subject: "Hi", html: "   ", text: "\n" }),
    ).rejects.toThrow(EmailMessageInvalidError);
  });

  it("accepts text alone, and html alone", async () => {
    await expect(
      sender.send({ to: "a@x.com", subject: "Hi", text: "hello" }),
    ).resolves.toBeDefined();
    await expect(
      sender.send({ to: "a@x.com", subject: "Hi", html: "<p>hello</p>" }),
    ).resolves.toBeDefined();
  });

  it("refuses an empty or whitespace subject", async () => {
    await expect(
      sender.send({ to: "a@x.com", subject: "  ", text: "hi" }),
    ).rejects.toThrow(EmailMessageInvalidError);
  });

  it("refuses a recipient that is not an address", async () => {
    await expect(
      sender.send({ to: "not-an-address", subject: "Hi", text: "hi" }),
    ).rejects.toThrow(EmailMessageInvalidError);
  });

  it("accepts a recipient with a display name", async () => {
    const { calls, transport } = recordingTransport();
    const named = createEmailSender({ from: FROM, send: transport });
    await named.send({ to: "Ada L. <ada@x.com>", subject: "Hi", text: "hi" });
    expect(calls[0]?.to).toBe("Ada L. <ada@x.com>");
  });

  it("names the field it rejected", async () => {
    await expect(
      sender.send({ to: "a@x.com", subject: "", text: "hi" }),
    ).rejects.toThrow(/subject/);
  });
});

describe("createEmailSender — construction", () => {
  it("throws on a from address it cannot parse, naming EMAIL_FROM", () => {
    expect(() => createEmailSender({ from: "not an address" })).toThrow(
      InvalidSenderAddressError,
    );
    expect(() => createEmailSender({ from: "not an address" })).toThrow(/EMAIL_FROM/);
  });

  it("accepts the display-name form that z.email() would have rejected", () => {
    // The regression. This is a correct, recommended value, and the previous
    // implementation refused to boot on it.
    expect(() => createEmailSender({ from: FROM })).not.toThrow();
  });

  it("throws on an unparseable reply-to, naming EMAIL_REPLY_TO", () => {
    expect(() => createEmailSender({ from: FROM, replyTo: "nope" })).toThrow(
      /EMAIL_REPLY_TO/,
    );
  });

  it("treats a blank API key the same as an absent one", () => {
    // An unset Vercel variable arrives as an empty string, which would
    // otherwise be used as a bearer token and fail on every send with a 401
    // rather than being reported as unconfigured.
    expect(createEmailSender({ apiKey: "", from: FROM }).configured).toBe(false);
    expect(createEmailSender({ apiKey: "  ", from: FROM }).configured).toBe(false);
  });
});

describe("createResendTransport", () => {
  function stubFetch(response: {
    ok: boolean;
    status: number;
    statusText?: string;
    body: unknown;
  }) {
    const spy = vi.fn(async () => ({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText ?? "",
      json: async () => response.body,
    }));
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  const outbound: OutboundEmail = {
    from: "Riddler Go <hello@riddlergo.com>",
    to: "customer@example.com",
    replyTo: null,
    subject: "Your receipt",
    html: "<p>Thanks</p>",
    text: null,
  };

  it("posts to the provider with the key as a bearer token", async () => {
    const spy = stubFetch({ ok: true, status: 200, body: { id: "msg_xyz" } });

    const result = await createResendTransport(API_KEY)(outbound);

    expect(result).toEqual({ id: "msg_xyz" });
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>)["authorization"]).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(JSON.parse(String(init.body))).toEqual({
      from: "Riddler Go <hello@riddlergo.com>",
      to: ["customer@example.com"],
      subject: "Your receipt",
      html: "<p>Thanks</p>",
    });
  });

  it("omits the fields that are null rather than sending them as null", async () => {
    const spy = stubFetch({ ok: true, status: 200, body: { id: "m" } });
    await createResendTransport(API_KEY)(outbound);
    const body: unknown = JSON.parse(
      String((spy.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(Object.keys(body as Record<string, unknown>)).not.toContain("text");
    expect(Object.keys(body as Record<string, unknown>)).not.toContain("reply_to");
  });

  it("surfaces the provider's own explanation, not just the status", async () => {
    // "HTTP 403" sends the reader to a dashboard to discover something the
    // response body already told us.
    stubFetch({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      body: { message: "The riddlergo.com domain is not verified" },
    });

    await expect(createResendTransport(API_KEY)(outbound)).rejects.toThrow(
      /domain is not verified/,
    );
  });

  it("falls back to the status text when the body explains nothing", async () => {
    stubFetch({ ok: false, status: 500, statusText: "Internal Server Error", body: null });
    await expect(createResendTransport(API_KEY)(outbound)).rejects.toThrow(
      EmailTransportError,
    );
  });

  it("survives a non-2xx whose body is not JSON at all", async () => {
    // A gateway returning an HTML error page. Without the guard, the
    // `.json()` rejection replaces the real failure with a parse error.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      })),
    );
    await expect(createResendTransport(API_KEY)(outbound)).rejects.toThrow(
      /HTTP 502/,
    );
  });

  it("reports an unreachable provider as a transport error, not a crash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    );
    await expect(createResendTransport(API_KEY)(outbound)).rejects.toThrow(
      /could not be reached/,
    );
  });

  it("tolerates a 200 with no id in the body", async () => {
    stubFetch({ ok: true, status: 200, body: {} });
    await expect(createResendTransport(API_KEY)(outbound)).resolves.toEqual({
      id: null,
    });
  });
});
