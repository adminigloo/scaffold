import { describe, expect, it } from "vitest";
import {
  type CommsSenders,
  commsTemplates,
  DEFAULT_EMAIL_SUBJECT,
  type OutboundEmail,
  type OutboundSms,
  sendNow,
} from "../index.js";
import { createFakeDb } from "./fake-db.js";

const T = "t1";

function withTemplates(templates: Array<Record<string, unknown>>) {
  const fake = createFakeDb();
  fake.seed(
    commsTemplates,
    templates.map((t) => ({ tenantId: T, channel: "email", subject: "Hello {{name}}", ...t })),
  );
  return fake;
}

function recorder() {
  const emails: OutboundEmail[] = [];
  const texts: OutboundSms[] = [];
  return {
    emails,
    texts,
    email: async (m: OutboundEmail) => {
      emails.push(m);
      return { id: "em_1" };
    },
    sms: async (m: OutboundSms) => {
      texts.push(m);
      return { sid: "SM_1" };
    },
  };
}

describe("sendNow — SMS compliance", () => {
  it("sends the compliant text and logs exactly what was sent", async () => {
    const fake = withTemplates([{ key: "reminder", channel: "sms", subject: null, body: "Hi {{name}}, see you at 9." }]);
    const r = recorder();
    const row = await sendNow(
      fake.db,
      { tenantId: T, to: "(801) 555-1234", templateKey: "reminder", vars: { name: "Sam" } },
      { sms: r.sms, smsCompliance: { senderName: "Acme Plumbing" } },
    );
    const sent = "Acme Plumbing: Hi Sam, see you at 9. Reply STOP to opt out.";
    expect(r.texts).toEqual([{ to: "+18015551234", body: sent }]);
    expect(row).toMatchObject({ status: "sent", body: sent, toAddress: "+18015551234", providerId: "SM_1" });
  });

  it("keeps the STOP line when the customer's own text mentions unsubscribing", async () => {
    // The check runs on the rendered text: a notes field reading "please
    // unsubscribe me from the newsletter" used to count as opt-out language,
    // and the text went out with no way to stop them.
    const fake = withTemplates([{ key: "reminder", channel: "sms", subject: null, body: "See you at 9. Notes: {{notes}}" }]);
    const r = recorder();
    await sendNow(
      fake.db,
      { tenantId: T, to: "8015551234", templateKey: "reminder", vars: { notes: "please unsubscribe me from the newsletter" } },
      { sms: r.sms, smsCompliance: { senderName: "Acme" } },
    );
    expect(r.texts[0]?.body).toBe("Acme: See you at 9. Notes: please unsubscribe me from the newsletter Reply STOP to opt out.");
  });

  it("passes a caller's idempotency key through to the sender", async () => {
    const fake = withTemplates([{ key: "reminder", channel: "sms", subject: null, body: "Hi" }]);
    const r = recorder();
    await sendNow(
      fake.db,
      { tenantId: T, to: "8015551234", templateKey: "reminder", idempotencyKey: "booking:b1:confirmation" },
      { sms: r.sms, smsCompliance: { senderName: "Acme" } },
    );
    expect(r.texts[0]?.idempotencyKey).toBe("booking:b1:confirmation");
  });

  it("refuses to text at all when compliance is missing at runtime (a cast or plain JS)", async () => {
    const fake = withTemplates([{ key: "reminder", channel: "sms", subject: null, body: "Hi" }]);
    const r = recorder();
    const row = await sendNow(
      fake.db,
      { tenantId: T, to: "8015551234", templateKey: "reminder" },
      { sms: r.sms } as unknown as CommsSenders,
    );
    expect(r.texts).toHaveLength(0);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/^sms compliance not configured/);
  });

  it("makes an sms sender without smsCompliance a type error", () => {
    // @ts-expect-error — smsCompliance is required once an sms sender is configured
    const senders: CommsSenders = { sms: async () => ({ id: "x" }) };
    const ok: CommsSenders = { sms: async () => ({ id: "x" }), smsCompliance: { senderName: "Acme" } };
    const emailOnly: CommsSenders = { email: async () => undefined };
    expect([senders, ok, emailOnly]).toHaveLength(3);
  });

  it("still logs a clean skip with no SMS provider — and shows the compliant text it would have sent", async () => {
    const fake = withTemplates([{ key: "reminder", channel: "sms", subject: null, body: "Hi" }]);
    const row = await sendNow(
      fake.db,
      { tenantId: T, to: "8015551234", templateKey: "reminder" },
      { smsCompliance: { senderName: "Acme" } },
    );
    expect(row).toMatchObject({ status: "skipped", body: "Acme: Hi Reply STOP to opt out.", error: "no sms provider configured" });
  });
});

describe("sendNow — recipients", () => {
  it("logs an invalid phone number as failed without calling the provider", async () => {
    const fake = withTemplates([{ key: "reminder", channel: "sms", subject: null, body: "Hi" }]);
    const r = recorder();
    const row = await sendNow(
      fake.db,
      { tenantId: T, to: "555-1234", templateKey: "reminder" },
      { sms: r.sms, smsCompliance: { senderName: "Acme" } },
    );
    expect(r.texts).toHaveLength(0);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/invalid recipient for sms/);
  });

  it("logs an invalid email address as failed without calling the provider", async () => {
    const fake = withTemplates([{ key: "confirm", body: "Hi" }]);
    const r = recorder();
    const row = await sendNow(fake.db, { tenantId: T, to: "not-an-email", templateKey: "confirm" }, { email: r.email });
    expect(r.emails).toHaveLength(0);
    expect(row).toMatchObject({ status: "failed" });
    expect(row.error).toMatch(/invalid recipient for email/);
  });
});

describe("sendNow — the sender contract", () => {
  const cases: Array<[string, unknown, string, string | null]> = [
    ["Resend's resolved { error }", { data: null, error: { message: "domain not verified", name: "validation_error" } }, "failed", "domain not verified"],
    ["{ ok: false }", { ok: false }, "failed", "the sender reported the message was not sent"],
    ["@adminigloo/email's failed outcome", { status: "failed", error: new Error("HTTP 422") }, "failed", "HTTP 422"],
    ["@adminigloo/email's skipped outcome", { status: "skipped", reason: "no-api-key" }, "skipped", "the sender skipped it (its provider is not configured)"],
  ];
  for (const [name, resolved, status, error] of cases) {
    it(`treats ${name} as ${status}, not sent`, async () => {
      const fake = withTemplates([{ key: "confirm", body: "Hi" }]);
      const row = await sendNow(
        fake.db,
        { tenantId: T, to: "sam@example.com", templateKey: "confirm" },
        { email: async () => resolved as never },
      );
      expect(row.status).toBe(status);
      expect(row.error).toBe(error);
    });
  }

  it("reads the provider id from Resend's { data: { id } }", async () => {
    const fake = withTemplates([{ key: "confirm", body: "Hi" }]);
    const row = await sendNow(
      fake.db,
      { tenantId: T, to: "sam@example.com", templateKey: "confirm" },
      { email: async () => ({ data: { id: "re_123" }, error: null }) },
    );
    expect(row).toMatchObject({ status: "sent", providerId: "re_123" });
  });

  it("still treats a throw as failed", async () => {
    const fake = withTemplates([{ key: "confirm", body: "Hi" }]);
    const row = await sendNow(
      fake.db,
      { tenantId: T, to: "sam@example.com", templateKey: "confirm" },
      {
        email: async () => {
          throw new Error("socket hang up");
        },
      },
    );
    expect(row).toMatchObject({ status: "failed", error: "socket hang up" });
  });

  it("hands the email sender escaped HTML alongside the plain text", async () => {
    const fake = withTemplates([{ key: "confirm", body: "Hi {{name}},\n\nSee {{url}}" }]);
    const r = recorder();
    await sendNow(
      fake.db,
      { tenantId: T, to: "sam@example.com", templateKey: "confirm", vars: { name: "<b>Sam</b>", url: "https://x.com/a" } },
      { email: r.email },
    );
    expect(r.emails[0]?.body).toBe("Hi <b>Sam</b>,\n\nSee https://x.com/a");
    expect(r.emails[0]?.html).toBe(
      '<p>Hi &lt;b&gt;Sam&lt;/b&gt;,</p>\n<p>See <a href="https://x.com/a">https://x.com/a</a></p>',
    );
  });
});

describe("sendNow — subject, kill switch, channel, repeats", () => {
  it("falls back to the default subject when the rendered subject is empty", async () => {
    const fake = withTemplates([{ key: "confirm", subject: "{{title}}", body: "Hi" }]);
    const r = recorder();
    await sendNow(fake.db, { tenantId: T, to: "sam@example.com", templateKey: "confirm" }, { email: r.email });
    await sendNow(
      fake.db,
      { tenantId: T, to: "sam@example.com", templateKey: "confirm" },
      { email: r.email, defaultEmailSubject: "News from Acme" },
    );
    expect(r.emails.map((e) => e.subject)).toEqual([DEFAULT_EMAIL_SUBJECT, "News from Acme"]);
  });

  it("records the variables that rendered blank", async () => {
    const fake = withTemplates([{ key: "confirm", body: "Hi {{name}} at {{time}}" }]);
    const row = await sendNow(
      fake.db,
      { tenantId: T, to: "sam@example.com", templateKey: "confirm", vars: { time: "9am" } },
      {},
    );
    expect(row.missingVars).toEqual(["name"]);
  });

  it("skips (does not fail) a template that is switched off", async () => {
    const fake = withTemplates([{ key: "confirm", body: "Hi", isActive: false }]);
    const r = recorder();
    const row = await sendNow(fake.db, { tenantId: T, to: "sam@example.com", templateKey: "confirm" }, { email: r.email });
    expect(r.emails).toHaveLength(0);
    expect(row).toMatchObject({ status: "skipped", error: 'template "confirm" is switched off' });
  });

  it("fails as 'channel changed' when the template no longer matches the expected channel", async () => {
    const fake = withTemplates([{ key: "reminder", channel: "sms", subject: null, body: "Hi" }]);
    const r = recorder();
    const row = await sendNow(
      fake.db,
      { tenantId: T, to: "sam@example.com", templateKey: "reminder", channel: "email" },
      { email: r.email, sms: r.sms, smsCompliance: { senderName: "Acme" } },
    );
    expect(r.texts).toHaveLength(0);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/^channel changed/);
  });

  it("skips a repeat inside minIntervalMs, with the reason logged, and sends once the window has passed", async () => {
    const fake = withTemplates([{ key: "review_request", body: "Review us?" }]);
    const r = recorder();
    const input = { tenantId: T, to: "sam@example.com", templateKey: "review_request", minIntervalMs: 30 * 24 * 3600_000 };
    expect((await sendNow(fake.db, input, { email: r.email })).status).toBe("sent");
    const repeat = await sendNow(fake.db, input, { email: r.email });
    expect(repeat.status).toBe("skipped");
    expect(repeat.error).toMatch(/already reached sam@example.com within the last 30 days/);
    expect(r.emails).toHaveLength(1);

    // Age the earlier send past the window: now it may go again.
    for (const row of fake.rows("comms_messages")) row.createdAt = new Date(Date.now() - 31 * 24 * 3600_000);
    expect((await sendNow(fake.db, input, { email: r.email })).status).toBe("sent");
    // A different recipient was never limited.
    expect((await sendNow(fake.db, { ...input, to: "kim@example.com" }, { email: r.email })).status).toBe("sent");
  });

  it("logs a missing template as failed", async () => {
    const fake = withTemplates([]);
    const row = await sendNow(fake.db, { tenantId: T, to: "sam@example.com", templateKey: "nope" }, {});
    expect(row).toMatchObject({ status: "failed", error: 'no template "nope"' });
    expect(fake.rows("comms_messages")).toHaveLength(1);
  });
});
