import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALLOWANCE_HELD_MESSAGE,
  commsMessages,
  commsScheduled,
  deliverNow,
  enqueueMessage,
  runDueMessages,
  sendNow,
  setTemplateActive,
  upsertTemplate,
  type CommsFailure,
  type CommsSenders,
  type OutboundEmail,
} from "../index.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Tenancy 2b-1, 12.1 and 12.2, on a REAL Postgres (IF-21): comms tells the
 * host once a message has failed FOR GOOD (`onFailed`), never about one the
 * queue will retry or a skip, and `deliverNow` says whether trying again
 * could change the outcome. Every assertion about a row reads the row back.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function seed(tenantId: string): Promise<void> {
  await upsertTemplate(t.db, { tenantId, key: "visit_reminder", subject: "See you {{date}}", body: "Hi {{name}}, see you {{date}}." });
  await upsertTemplate(t.db, { tenantId, key: "visit_text", channel: "sms", body: "See you {{date}}." });
}

/** An `onFailed` that records what it was told. */
function told() {
  const failures: CommsFailure[] = [];
  return { failures, onFailed: (failure: CommsFailure) => void failures.push(failure) };
}

const ok = async (_m: OutboundEmail) => ({ id: "em_1" });
const throws = async (_m: OutboundEmail): Promise<{ id: string }> => {
  throw new Error("provider down");
};

async function logRow(id: string) {
  const [row] = await t.db.select().from(commsMessages).where(eq(commsMessages.id, id));
  return row;
}

async function queueRow(tenantId: string, id: string) {
  const [row] = await t.db
    .select()
    .from(commsScheduled)
    .where(and(eq(commsScheduled.tenantId, tenantId), eq(commsScheduled.id, id)));
  return row;
}

describe("onFailed: a failed sendNow / deliverNow is told once", () => {
  it("tells a provider failure with the log row, the address and the template", async () => {
    const a = tenant("fail");
    await seed(a);
    const spy = told();
    const row = await sendNow(
      t.db,
      { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder", vars: { name: "Pat", date: "Tue" } },
      { email: throws, onFailed: spy.onFailed },
    );
    expect(row.status).toBe("failed");
    expect(spy.failures).toHaveLength(1);
    const failure = spy.failures[0]!;
    expect(failure).toMatchObject({
      tenantId: a,
      messageId: row.id,
      scheduledId: null,
      channel: "email",
      to: "pat@example.com",
      templateKey: "visit_reminder",
      error: "provider down",
    });
    expect(failure.at).toBeInstanceOf(Date);
    // Told AFTER the outcome is recorded: the row it names is in the log, failed.
    expect((await logRow(failure.messageId!))?.status).toBe("failed");
  });

  it("tells a permanent failure too (no such template), with the row that says so", async () => {
    const a = tenant("fail");
    const spy = told();
    const result = await deliverNow(t.db, { tenantId: a, to: "pat@example.com", templateKey: "missing_one" }, { email: ok, onFailed: spy.onFailed });
    expect(result.message.status).toBe("failed");
    expect(spy.failures.map((f) => f.messageId)).toEqual([result.message.id]);
    expect(spy.failures[0]?.error).toBe('no template "missing_one"');
  });

  it("never tells a send or a skip (no provider set up is not a failure)", async () => {
    const a = tenant("fail");
    await seed(a);
    const spy = told();
    const sent = await sendNow(t.db, { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder" }, { email: ok, onFailed: spy.onFailed });
    const noProvider = await sendNow(t.db, { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder" }, { onFailed: spy.onFailed });
    await setTemplateActive(t.db, a, "visit_reminder", false);
    const off = await sendNow(t.db, { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder" }, { email: ok, onFailed: spy.onFailed });
    expect([sent.status, noProvider.status, off.status]).toEqual(["sent", "skipped", "skipped"]);
    expect(spy.failures).toEqual([]);
  });

  it("a throwing onFailed changes nothing: the row is logged and returned, nothing is thrown", async () => {
    const a = tenant("fail");
    await seed(a);
    let calls = 0;
    const senders: CommsSenders = {
      email: throws,
      onFailed: () => {
        calls += 1;
        throw new Error("the reporter is down");
      },
    };
    const row = await sendNow(t.db, { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder" }, senders);
    expect(calls).toBe(1);
    expect(row.status).toBe("failed");
    expect((await logRow(row.id))?.error).toBe("provider down");
    // An async rejection is swallowed the same way.
    const asyncRow = await sendNow(t.db, { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder" }, {
      email: throws,
      onFailed: async () => Promise.reject(new Error("still down")),
    });
    expect(asyncRow.status).toBe("failed");
  });
});

describe("deliverNow: retryable per failure kind (12.2)", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly input?: Partial<{ to: string; templateKey: string; channel: "email" | "sms" }>;
    readonly senders: CommsSenders;
    readonly status: "sent" | "skipped" | "failed";
    readonly retryable: boolean;
  }> = [
    { name: "sent", senders: { email: ok }, status: "sent", retryable: false },
    { name: "no provider (a skip)", senders: {}, status: "skipped", retryable: false },
    { name: "the sender skipped it", senders: { email: async () => ({ status: "skipped" }) }, status: "skipped", retryable: false },
    { name: "the provider threw", senders: { email: throws }, status: "failed", retryable: true },
    { name: "the provider answered an error", senders: { email: async () => ({ data: null, error: { message: "rate limited" } }) }, status: "failed", retryable: true },
    { name: "the sending allowance held it", senders: { email: ok, allowance: () => false }, status: "failed", retryable: true },
    {
      name: "who the business sends as couldn't be read",
      senders: {
        email: ok,
        identity: () => {
          throw new Error("db down");
        },
      },
      status: "failed",
      retryable: true,
    },
    { name: "no such template", input: { templateKey: "nope" }, senders: { email: ok }, status: "failed", retryable: false },
    { name: "an address that isn't one", input: { to: "not-an-address" }, senders: { email: ok }, status: "failed", retryable: false },
    { name: "the channel changed", input: { channel: "sms" }, senders: { email: ok }, status: "failed", retryable: false },
    {
      name: "texts not set up properly",
      input: { templateKey: "visit_text", to: "8015551234" },
      // A cast, as plain JS would: an sms sender with no compliance config.
      senders: { sms: async () => ({ sid: "SM" }) } as unknown as CommsSenders,
      status: "failed",
      retryable: false,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: ${c.status}, retryable ${c.retryable}`, async () => {
      const a = tenant("dn");
      await seed(a);
      const spy = told();
      const result = await deliverNow(
        t.db,
        { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder", ...c.input },
        { ...c.senders, onFailed: spy.onFailed },
      );
      expect(result.message.status).toBe(c.status);
      expect(result.retryable).toBe(c.retryable);
      if (c.status === "failed" && c.name === "the sending allowance held it") {
        expect(result.message.error).toBe(ALLOWANCE_HELD_MESSAGE);
      }
      // Every failure is told, retryable or not; nothing else is.
      expect(spy.failures).toHaveLength(c.status === "failed" ? 1 : 0);
    });
  }

  it("sendNow is deliverNow's row", async () => {
    const a = tenant("dn");
    await seed(a);
    const row = await sendNow(t.db, { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder" }, { email: throws });
    const result = await deliverNow(t.db, { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder" }, { email: throws });
    expect(Object.keys(result.message).sort()).toEqual(Object.keys(row).sort());
    expect(result.message.error).toBe(row.error);
  });
});

describe("onFailed: the drain tells only what it gives up (12.1)", () => {
  const now = new Date("2026-11-02T15:00:00Z");
  const due = new Date(now.getTime() - 60_000);

  async function queue(tenantId: string, templateKey = "visit_reminder", to = "pat@example.com"): Promise<string> {
    const id = await enqueueMessage(t.db, { tenantId, to, templateKey, sendAt: due, skipIfPast: false });
    expect(id).toBeTruthy();
    return id!;
  }

  it("a permanent failure is told once, with the queue row and the log row that recorded it", async () => {
    const a = tenant("drain");
    await seed(a);
    const id = await queue(a);
    // The template is deleted from under the queued message: "no template", permanent.
    await t.db.delete(commsMessages).where(eq(commsMessages.tenantId, a));
    await t.client.query(`delete from comms_templates where tenant_id = $1`, [a]);
    const spy = told();
    const result = await runDueMessages(t.db, { email: ok, onFailed: spy.onFailed }, { now, tenantIds: [a] });
    expect(result.failed).toBe(1);
    expect(spy.failures).toHaveLength(1);
    const failure = spy.failures[0]!;
    expect(failure).toMatchObject({ tenantId: a, scheduledId: id, channel: "email", to: "pat@example.com", templateKey: "visit_reminder" });
    expect(failure.error).toBe('no template "visit_reminder"');
    const log = await logRow(failure.messageId!);
    expect(log).toMatchObject({ status: "failed", scheduledId: id });
    expect((await queueRow(a, id))?.status).toBe("failed");
  });

  it("a transient failure is NOT told while it will retry, and told once when out of attempts", async () => {
    const a = tenant("drain");
    await seed(a);
    const id = await queue(a);
    const spy = told();
    const senders: CommsSenders = { email: throws, onFailed: spy.onFailed };
    // Attempt 1 of 2: retrying, nobody hears.
    const first = await runDueMessages(t.db, senders, { now, tenantIds: [a], maxAttempts: 2, retryBaseMs: 0 });
    expect(first).toMatchObject({ retrying: 1, failed: 0 });
    expect(spy.failures).toEqual([]);
    expect((await queueRow(a, id))?.status).toBe("pending");
    // Attempt 2 of 2: given up, told once.
    const second = await runDueMessages(t.db, senders, { now: new Date(now.getTime() + 1000), tenantIds: [a], maxAttempts: 2, retryBaseMs: 0 });
    expect(second).toMatchObject({ retrying: 0, failed: 1 });
    expect(spy.failures).toHaveLength(1);
    expect(spy.failures[0]).toMatchObject({ scheduledId: id, templateKey: "visit_reminder" });
    expect(spy.failures[0]!.error).toContain("gave up after 2 attempts");
    // The log row it names is the LAST attempt's.
    const logs = await t.db
      .select()
      .from(commsMessages)
      .where(and(eq(commsMessages.tenantId, a), eq(commsMessages.scheduledId, id)));
    expect(logs).toHaveLength(2);
    const last = [...logs].sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : x.id < y.id ? -1 : 1)).at(-1)!;
    expect(spy.failures[0]!.messageId).toBe(last.id);
    // A third run finds nothing to give up again.
    await runDueMessages(t.db, senders, { now: new Date(now.getTime() + 5000), tenantIds: [a], maxAttempts: 2 });
    expect(spy.failures).toHaveLength(1);
  });

  it("a held message (the allowance) is retried, not told, until it runs out of attempts", async () => {
    const a = tenant("drain");
    await seed(a);
    await queue(a);
    const spy = told();
    const result = await runDueMessages(t.db, { email: ok, allowance: () => false, onFailed: spy.onFailed }, { now, tenantIds: [a] });
    expect(result.retrying).toBe(1);
    expect(spy.failures).toEqual([]);
  });

  it("an abandoned claim out of attempts is told with no log row of its own", async () => {
    const a = tenant("drain");
    await seed(a);
    const id = await queue(a);
    // A worker claimed it on its last attempt and died: `sending`, stale.
    await t.db
      .update(commsScheduled)
      .set({ status: "sending", attempts: 5, claimedAt: new Date(now.getTime() - 60 * 60 * 1000) })
      .where(eq(commsScheduled.id, id));
    const spy = told();
    const result = await runDueMessages(t.db, { email: ok, onFailed: spy.onFailed }, { now, tenantIds: [a] });
    expect(result.failed).toBe(1);
    expect(spy.failures).toEqual([
      expect.objectContaining({
        tenantId: a,
        messageId: null,
        scheduledId: id,
        to: "pat@example.com",
        templateKey: "visit_reminder",
        error: "abandoned mid-send, out of attempts (5)",
      }),
    ]);
  });

  it("an abandoned claim with attempts left is revived, not told", async () => {
    const a = tenant("drain");
    await seed(a);
    const id = await queue(a);
    await t.db
      .update(commsScheduled)
      .set({ status: "sending", attempts: 1, claimedAt: new Date(now.getTime() - 60 * 60 * 1000) })
      .where(eq(commsScheduled.id, id));
    const spy = told();
    const result = await runDueMessages(t.db, { email: ok, onFailed: spy.onFailed }, { now, tenantIds: [a] });
    expect(result).toMatchObject({ reclaimed: 1, sent: 1, failed: 0 });
    expect(spy.failures).toEqual([]);
  });

  it("a 0.1.x `sending` row (state unknown, possibly delivered) is failed but not told", async () => {
    const a = tenant("drain");
    await seed(a);
    const id = await queue(a);
    await t.db.update(commsScheduled).set({ status: "sending", claimedAt: null }).where(eq(commsScheduled.id, id));
    const spy = told();
    const result = await runDueMessages(t.db, { email: ok, onFailed: spy.onFailed }, { now, tenantIds: [a] });
    expect(result.failed).toBe(1);
    expect(spy.failures).toEqual([]);
  });

  it("a skip, a send, a cancel and an expiry are never told", async () => {
    const a = tenant("drain");
    await seed(a);
    await queue(a);
    const spy = told();
    // No provider: skipped.
    const skipped = await runDueMessages(t.db, { onFailed: spy.onFailed }, { now, tenantIds: [a] });
    expect(skipped.skipped).toBe(1);
    await queue(a, "visit_reminder", "sam@example.com");
    const sent = await runDueMessages(t.db, { email: ok, onFailed: spy.onFailed }, { now, tenantIds: [a] });
    expect(sent.sent).toBe(1);
    await queue(a, "visit_reminder", "lee@example.com");
    const cancelled = await runDueMessages(t.db, { email: ok, onFailed: spy.onFailed }, { now, tenantIds: [a], beforeSend: () => "skip" });
    expect(cancelled.cancelled).toBe(1);
    await enqueueMessage(t.db, {
      tenantId: a,
      to: "kim@example.com",
      templateKey: "visit_reminder",
      sendAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
      skipIfPast: false,
    });
    const expired = await runDueMessages(t.db, { email: ok, onFailed: spy.onFailed }, { now, tenantIds: [a] });
    expect(expired.expired).toBe(1);
    expect(spy.failures).toEqual([]);
  });

  it("a row cancelled while its last attempt was sending is not told (this run didn't give it up)", async () => {
    const a = tenant("drain");
    await seed(a);
    const id = await queue(a);
    const spy = told();
    const result = await runDueMessages(
      t.db,
      {
        email: async () => {
          // The owner cancels the visit mid-send; then the provider fails.
          await t.db.update(commsScheduled).set({ status: "cancelled" }).where(eq(commsScheduled.id, id));
          throw new Error("provider down");
        },
        onFailed: spy.onFailed,
      },
      { now, tenantIds: [a], maxAttempts: 1 },
    );
    expect(result.processed).toBe(1);
    expect((await queueRow(a, id))?.status).toBe("cancelled");
    expect(spy.failures).toEqual([]);
  });

  it("a throwing onFailed changes nothing: the drain records every row and goes on", async () => {
    const a = tenant("drain");
    await seed(a);
    const first = await queue(a, "visit_reminder", "one@example.com");
    const second = await queue(a, "visit_reminder", "two@example.com");
    let calls = 0;
    const result = await runDueMessages(
      t.db,
      {
        email: throws,
        onFailed: () => {
          calls += 1;
          throw new Error("reporter down");
        },
      },
      { now, tenantIds: [a], maxAttempts: 1 },
    );
    expect(calls).toBe(2);
    expect(result).toMatchObject({ processed: 2, failed: 2 });
    expect((await queueRow(a, first))?.status).toBe("failed");
    expect((await queueRow(a, second))?.status).toBe("failed");
  });

  it("only the drained companies' give-ups are told", async () => {
    const a = tenant("drain");
    const b = tenant("drain");
    await seed(a);
    await seed(b);
    await queue(a);
    await queue(b);
    const spy = told();
    await runDueMessages(t.db, { email: throws, onFailed: spy.onFailed }, { now, tenantIds: [a], maxAttempts: 1 });
    expect(spy.failures.map((f) => f.tenantId)).toEqual([a]);
  });
});
