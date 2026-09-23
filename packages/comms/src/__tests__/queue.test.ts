import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelScheduled,
  type CommsSenders,
  commsScheduled,
  commsTemplates,
  enqueueMessage,
  type OutboundEmail,
  runDueMessages,
  setTemplateActive,
} from "../index.js";
import { createFakeDb, type FakeDbHooks } from "./fake-db.js";

const T = "t1";
const NOW = new Date("2026-09-23T15:00:00Z");
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function setup(hooks: FakeDbHooks = {}) {
  const fake = createFakeDb(hooks);
  fake.seed(commsTemplates, [
    { tenantId: T, key: "reminder", channel: "email", subject: "See you {{date}}", body: "Hi {{name}}, see you {{date}}." },
    { tenantId: T, key: "text_reminder", channel: "sms", subject: null, body: "See you {{date}}." },
  ]);
  const sent: OutboundEmail[] = [];
  const senders: CommsSenders = {
    email: async (m) => {
      sent.push(m);
      return { id: `em_${sent.length}` };
    },
  };
  /** A due queue row, inserted directly — the state a cron tick finds. */
  const queue = (row: Record<string, unknown>) =>
    fake.seed(commsScheduled, [
      { tenantId: T, channel: "email", toAddress: "sam@example.com", templateKey: "reminder", vars: {}, sendAt: ago(MIN), ...row },
    ])[0]!;
  return { ...fake, sent, senders, queue, scheduled: () => fake.rows("comms_scheduled") };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runDueMessages — forward progress", () => {
  it("201 poison rows ahead of a valid one cannot starve it", async () => {
    // Before: a failed row went back to `pending` with the SAME sendAt, so the
    // oldest 200 poison rows were re-selected every tick, forever, and the
    // valid reminder behind them never sent.
    const { db, queue, senders, sent, scheduled } = setup();
    for (let i = 0; i < 201; i++) queue({ templateKey: "deleted_template", sendAt: ago(60 * MIN - i) });
    queue({ toAddress: "valid@example.com", sendAt: ago(MIN) });

    await runDueMessages(db, senders, NOW); // tick 1: the limit (200) of poison rows
    await runDueMessages(db, senders, NOW); // tick 2
    expect(sent.map((m) => m.to)).toEqual(["valid@example.com"]);
    const poison = scheduled().filter((r) => r.templateKey === "deleted_template");
    expect(poison.every((r) => r.status === "failed")).toBe(true);
  });

  it("a row that throws neither aborts the batch nor strands itself in `sending`", async () => {
    // Before: the throw escaped runDueMessages — every row after it went
    // unprocessed and the thrower stayed `sending` forever.
    const { db, queue, senders, sent, scheduled } = setup({
      onInsert: (table, row) => {
        if (table === "comms_messages" && row.toAddress === "boom@example.com") throw new Error("connection reset");
      },
    });
    queue({ toAddress: "a@example.com", sendAt: ago(3 * MIN) });
    const boom = queue({ toAddress: "boom@example.com", sendAt: ago(2 * MIN) });
    queue({ toAddress: "c@example.com", sendAt: ago(MIN) });

    await runDueMessages(db, senders, NOW);
    expect(sent.map((m) => m.to).sort()).toEqual(["a@example.com", "boom@example.com", "c@example.com"]);
    const row = scheduled().find((r) => r.id === boom.id)!;
    // The provider accepted it; only the log write failed. Retrying would
    // email the customer twice, so it is recorded sent, with the reason.
    expect(row.status).toBe("sent");
    expect(row.lastError).toMatch(/writing the delivery log failed: connection reset/);
  });

  it("a throw before sending is retried later, not lost and not stuck", async () => {
    const { db, queue, senders, scheduled } = setup();
    const row = queue({});
    const result = await runDueMessages(db, senders, {
      now: NOW,
      beforeSend: () => {
        throw new Error("bookings table unavailable");
      },
    });
    expect(result).toMatchObject({ processed: 1, retrying: 1 });
    expect(scheduled().find((r) => r.id === row.id)).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "bookings table unavailable",
      claimedAt: null,
    });
  });

  it("backs off a transient failure exponentially, then gives up as failed after maxAttempts", async () => {
    const { db, queue, scheduled } = setup();
    const row = queue({});
    const flaky: CommsSenders = {
      email: async () => {
        throw new Error("provider 503");
      },
    };
    const delays: number[] = [];
    let now = NOW;
    for (let attempt = 1; attempt <= 5; attempt++) {
      await runDueMessages(db, flaky, now);
      const current = scheduled().find((r) => r.id === row.id)!;
      if (attempt < 5) {
        expect(current).toMatchObject({ status: "pending", attempts: attempt, lastError: "provider 503" });
        const sendAt = current.sendAt as Date;
        delays.push(Math.round((sendAt.getTime() - now.getTime()) / MIN));
        now = sendAt;
      } else {
        expect(current).toMatchObject({ status: "failed", attempts: 5 });
        expect(current.lastError).toMatch(/provider 503 \(gave up after 5 attempts\)/);
      }
    }
    expect(delays).toEqual([5, 10, 20, 40]);
  });

  it("does not re-send a backed-off row on the very next tick", async () => {
    const { db, queue, scheduled } = setup();
    queue({});
    let calls = 0;
    const flaky: CommsSenders = {
      email: async () => {
        calls += 1;
        throw new Error("provider 503");
      },
    };
    await runDueMessages(db, flaky, NOW);
    await runDueMessages(db, flaky, new Date(NOW.getTime() + MIN));
    expect(calls).toBe(1);
    expect(scheduled()[0]!.status).toBe("pending");
  });

  it("ends permanent failures at once instead of retrying them", async () => {
    const { db, queue, scheduled } = setup();
    queue({ templateKey: "deleted_template" });
    queue({ toAddress: "8015551234", channel: "sms", templateKey: "text_reminder" });
    // An SMS sender smuggled past the type without compliance config.
    const senders = { sms: async () => ({ sid: "x" }) } as unknown as CommsSenders;
    const result = await runDueMessages(db, senders, NOW);
    expect(result).toMatchObject({ processed: 2, failed: 2, retrying: 0 });
    const [missing, noCompliance] = scheduled();
    expect(missing).toMatchObject({ status: "failed", lastError: 'no template "deleted_template"' });
    expect(noCompliance!.status).toBe("failed");
    expect(noCompliance!.lastError).toMatch(/^sms compliance not configured/);
  });

  it("reclaims a claim abandoned by a dead worker, and leaves a live one alone", async () => {
    const { db, queue, senders, sent, scheduled } = setup();
    const dead = queue({ toAddress: "dead@example.com", status: "sending", claimedAt: ago(11 * MIN), attempts: 1 });
    const legacy = queue({ toAddress: "legacy@example.com", status: "sending", claimedAt: null, attempts: 0 });
    const live = queue({ toAddress: "live@example.com", status: "sending", claimedAt: ago(2 * MIN), attempts: 1 });
    const exhausted = queue({ toAddress: "spent@example.com", status: "sending", claimedAt: ago(30 * MIN), attempts: 5 });

    const result = await runDueMessages(db, senders, NOW);
    expect(result.reclaimed).toBe(2);
    expect(sent.map((m) => m.to).sort()).toEqual(["dead@example.com", "legacy@example.com"]);
    const byId = (id: unknown) => scheduled().find((r) => r.id === id)!;
    expect(byId(dead.id)).toMatchObject({ status: "sent", attempts: 2 });
    expect(byId(legacy.id)).toMatchObject({ status: "sent", attempts: 1 });
    expect(byId(live.id)).toMatchObject({ status: "sending" });
    expect(byId(exhausted.id).status).toBe("failed");
  });

  it("stops claiming when the time budget is spent and leaves the rest pending", async () => {
    vi.useFakeTimers({ now: NOW });
    const { db, queue, scheduled } = setup();
    for (let i = 0; i < 5; i++) queue({ toAddress: `c${i}@example.com`, sendAt: ago((10 - i) * MIN) });
    const slow: CommsSenders = {
      email: async () => {
        vi.setSystemTime(Date.now() + 1000); // each send takes a second
        return { id: "x" };
      },
    };
    const result = await runDueMessages(db, slow, { now: NOW, timeBudgetMs: 2500 });
    expect(result).toMatchObject({ processed: 3, sent: 3, stoppedEarly: true });
    expect(scheduled().filter((r) => r.status === "pending")).toHaveLength(2);
  });

  it("sends each row exactly once when two ticks overlap (the atomic claim)", async () => {
    const { db, queue, senders, sent } = setup();
    for (let i = 0; i < 10; i++) queue({ toAddress: `c${i}@example.com` });
    const [a, b] = await Promise.all([runDueMessages(db, senders, NOW), runDueMessages(db, senders, NOW)]);
    expect(a.sent + b.sent).toBe(10);
    expect(new Set(sent.map((m) => m.to)).size).toBe(10);
    expect(sent).toHaveLength(10);
  });

  it("still accepts the original positional (now, limit) form", async () => {
    const { db, queue, senders } = setup();
    queue({});
    queue({});
    expect((await runDueMessages(db, senders, NOW, 1)).processed).toBe(1);
  });
});

describe("runDueMessages — deciding at send time", () => {
  it("beforeSend 'skip' cancels the row and logs why", async () => {
    const { db, queue, senders, sent, scheduled, rows } = setup();
    queue({ refType: "invoice", refId: "inv_1" });
    const result = await runDueMessages(db, senders, {
      now: NOW,
      beforeSend: () => ({ skip: true, reason: "invoice already paid" }),
    });
    expect(result.cancelled).toBe(1);
    expect(sent).toHaveLength(0);
    expect(scheduled()[0]).toMatchObject({ status: "cancelled", lastError: "cancelled at send time: invoice already paid" });
    expect(rows("comms_messages")[0]).toMatchObject({ status: "cancelled", error: "cancelled at send time: invoice already paid" });
  });

  it("beforeSend can supply fresh values — the visit moved since it was queued", async () => {
    const { db, queue, senders, sent } = setup();
    queue({ vars: { name: "Sam", date: "Monday" } });
    await runDueMessages(db, senders, {
      now: NOW,
      beforeSend: () => ({ to: "sam.new@example.com", vars: { date: "Tuesday" } }),
    });
    expect(sent[0]).toMatchObject({ to: "sam.new@example.com", subject: "See you Tuesday", body: "Hi Sam, see you Tuesday." });
  });

  it("expires a row past expiresAt instead of sending it late", async () => {
    const { db, queue, senders, sent, scheduled } = setup();
    queue({ sendAt: ago(3 * 60 * MIN), expiresAt: ago(60 * MIN) });
    const result = await runDueMessages(db, senders, NOW);
    expect(result.expired).toBe(1);
    expect(sent).toHaveLength(0);
    expect(scheduled()[0]!.status).toBe("expired");
  });

  it("a switched-off template ends its queued messages as skipped", async () => {
    const { db, queue, senders, sent, scheduled } = setup();
    queue({});
    await setTemplateActive(db, T, "reminder", false);
    await runDueMessages(db, senders, NOW);
    expect(sent).toHaveLength(0);
    expect(scheduled()[0]).toMatchObject({ status: "skipped", lastError: 'template "reminder" is switched off' });
  });

  it("fails a row whose template changed channel since it was queued", async () => {
    const { db, queue, senders, sent, scheduled } = setup();
    queue({ templateKey: "text_reminder", channel: "email" });
    await runDueMessages(db, { ...senders, sms: async () => ({ sid: "x" }), smsCompliance: { senderName: "Acme" } }, NOW);
    expect(sent).toHaveLength(0);
    expect(scheduled()[0]!.status).toBe("failed");
    expect(scheduled()[0]!.lastError).toMatch(/^channel changed/);
  });
});

describe("enqueueMessage", () => {
  const future = () => new Date(Date.now() + 24 * 60 * MIN);

  it("links the row to what it is about, for cancelScheduled", async () => {
    const { db, scheduled } = setup();
    await enqueueMessage(db, { tenantId: T, to: "sam@example.com", templateKey: "reminder", sendAt: future(), refType: "booking", refId: "b1" });
    expect(scheduled()[0]).toMatchObject({ refType: "booking", refId: "b1", status: "pending", attempts: 0 });
  });

  it("refuses a refType without a refId", async () => {
    const { db } = setup();
    await expect(
      enqueueMessage(db, { tenantId: T, to: "sam@example.com", templateKey: "reminder", sendAt: future(), refType: "booking" }),
    ).rejects.toThrow(/refType and refId go together/);
  });

  it("validates the recipient for the template's channel, and normalises phones", async () => {
    const { db, scheduled } = setup();
    await expect(
      enqueueMessage(db, { tenantId: T, to: "sam at example", templateKey: "reminder", sendAt: future() }),
    ).rejects.toThrow(/not an email address/);
    await expect(
      enqueueMessage(db, { tenantId: T, to: "555-1234", templateKey: "text_reminder", sendAt: future() }),
    ).rejects.toThrow(/not a phone number/);
    await enqueueMessage(db, { tenantId: T, to: "(801) 555-1234", templateKey: "text_reminder", sendAt: future() });
    expect(scheduled()).toHaveLength(1);
    expect(scheduled()[0]).toMatchObject({ channel: "sms", toAddress: "+18015551234" });
  });

  it("skips a sendAt already in the past by default, within a small grace", async () => {
    const { db, scheduled } = setup();
    const base = { tenantId: T, to: "sam@example.com", templateKey: "reminder" };
    expect(await enqueueMessage(db, { ...base, sendAt: new Date(Date.now() - 60 * MIN) })).toBeNull();
    expect(await enqueueMessage(db, { ...base, sendAt: new Date(Date.now() - 30_000) })).toEqual(expect.any(String));
    expect(await enqueueMessage(db, { ...base, sendAt: new Date(Date.now() - 60 * MIN), skipIfPast: false })).toEqual(
      expect.any(String),
    );
    expect(scheduled()).toHaveLength(2);
  });

  it("refuses an expiresAt that is not after sendAt", async () => {
    const { db } = setup();
    const sendAt = future();
    await expect(
      enqueueMessage(db, { tenantId: T, to: "sam@example.com", templateKey: "reminder", sendAt, expiresAt: sendAt }),
    ).rejects.toThrow(/expiresAt must be after sendAt/);
  });

  it("is idempotent on dedupeKey: a replay returns the first row and queues nothing", async () => {
    const { db, scheduled } = setup();
    const input = { tenantId: T, to: "sam@example.com", templateKey: "reminder", sendAt: future(), dedupeKey: "booking:b1:reminder" };
    const first = await enqueueMessage(db, input);
    const replay = await enqueueMessage(db, input);
    expect(replay).toBe(first);
    expect(scheduled()).toHaveLength(1);
    // Keys are per tenant, and rows without a key never collide.
    await enqueueMessage(db, { ...input, tenantId: "t2" });
    await enqueueMessage(db, { ...input, dedupeKey: undefined });
    await enqueueMessage(db, { ...input, dedupeKey: undefined });
    expect(scheduled()).toHaveLength(4);
  });

  it("refuses an explicit channel that contradicts the template", async () => {
    const { db } = setup();
    await expect(
      enqueueMessage(db, { tenantId: T, to: "sam@example.com", templateKey: "reminder", sendAt: future(), channel: "sms" }),
    ).rejects.toThrow(/is email, not sms/);
  });
});

describe("cancelScheduled", () => {
  it("cancels every pending row about a thing, leaving history and other tenants alone", async () => {
    const { db, queue, scheduled } = setup();
    const pending = queue({ refType: "booking", refId: "b1", sendAt: new Date(NOW.getTime() + 60 * MIN) });
    const review = queue({ refType: "booking", refId: "b1", templateKey: "review", sendAt: new Date(NOW.getTime() + 60 * MIN) });
    const sent = queue({ refType: "booking", refId: "b1", status: "sent" });
    const otherTenant = queue({ tenantId: "t2", refType: "booking", refId: "b1" });
    const otherBooking = queue({ refType: "booking", refId: "b2" });

    expect(await cancelScheduled(db, { tenantId: T, refType: "booking", refId: "b1", templateKey: "reminder" })).toBe(1);
    expect(await cancelScheduled(db, { tenantId: T, refType: "booking", refId: "b1" })).toBe(1);
    const status = (row: Record<string, unknown>) => scheduled().find((r) => r.id === row.id)!.status;
    expect([pending, review].map(status)).toEqual(["cancelled", "cancelled"]);
    expect([sent, otherTenant, otherBooking].map(status)).toEqual(["sent", "pending", "pending"]);
  });

  it("cancels one row by id — but not another tenant's", async () => {
    const { db, queue, scheduled } = setup();
    const row = queue({});
    expect(await cancelScheduled(db, { tenantId: "t2", id: row.id as string })).toBe(0);
    expect(await cancelScheduled(db, { tenantId: T, id: row.id as string })).toBe(1);
    expect(scheduled()[0]!.status).toBe("cancelled");
  });

  it("a cancelled row is never sent", async () => {
    const { db, queue, senders, sent } = setup();
    const row = queue({});
    await cancelScheduled(db, { tenantId: T, id: row.id as string });
    await runDueMessages(db, senders, NOW);
    expect(sent).toHaveLength(0);
  });

  it("refuses an ambiguous input rather than guessing which rows were meant", async () => {
    const { db } = setup();
    await expect(cancelScheduled(db, { tenantId: T, id: "x", refType: "booking", refId: "b1" } as never)).rejects.toThrow();
    await expect(cancelScheduled(db, { tenantId: T } as never)).rejects.toThrow();
  });
});
