import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALLOWANCE_HELD_MESSAGE,
  commsMessages,
  commsScheduled,
  enqueueMessage,
  runDueMessages,
  sendNow,
  setTemplateActive,
  upsertTemplate,
  type CommsSenders,
  type OutboundEmail,
  type OutboundSms,
  type SenderIdentity,
} from "../index.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Tenancy 2a, D8: a company's messages go out AS the company. comms asks
 * `identity(tenantId)` per message, hands the name and reply-to to the
 * sender, and records them on the delivery log row, so the owner sees in
 * Messages what the customer saw. D10: the drain claims only the tenants it
 * is given.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function seedTemplates(tenantId: string): Promise<void> {
  await upsertTemplate(t.db, { tenantId, key: "visit_reminder", subject: "See you {{date}}", body: "Hi {{name}}, see you {{date}}." });
  await upsertTemplate(t.db, { tenantId, key: "visit_text", channel: "sms", body: "See you {{date}}." });
}

function capture() {
  const emails: OutboundEmail[] = [];
  const texts: OutboundSms[] = [];
  return {
    emails,
    texts,
    email: async (m: OutboundEmail) => {
      emails.push(m);
      return { id: `em_${emails.length}` };
    },
    sms: async (m: OutboundSms) => {
      texts.push(m);
      return { sid: `SM_${texts.length}` };
    },
  };
}

const IDENTITIES: Record<string, SenderIdentity> = {};

describe("identity per tenant", () => {
  it("reaches the sender and the log columns, for each company its own", async () => {
    const a = tenant("green");
    const b = tenant("summit");
    await seedTemplates(a);
    await seedTemplates(b);
    IDENTITIES[a] = { name: "Green Acres", replyTo: "gail@greenacres.test" };
    IDENTITIES[b] = { name: "Summit Lawn", replyTo: "sam@summit.test" };
    const c = capture();
    const senders: CommsSenders = { email: c.email, identity: (id) => IDENTITIES[id] ?? null };

    const rowA = await sendNow(t.db, { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder", vars: { name: "Pat", date: "Tue" } }, senders);
    const rowB = await sendNow(t.db, { tenantId: b, to: "lee@example.com", templateKey: "visit_reminder", vars: { name: "Lee", date: "Wed" } }, senders);

    expect(c.emails[0]).toMatchObject({ tenantId: a, fromName: "Green Acres", replyTo: "gail@greenacres.test", to: "pat@example.com" });
    expect(c.emails[1]).toMatchObject({ tenantId: b, fromName: "Summit Lawn", replyTo: "sam@summit.test", to: "lee@example.com" });
    expect(rowA).toMatchObject({ status: "sent", fromName: "Green Acres", replyTo: "gail@greenacres.test" });
    expect(rowB).toMatchObject({ status: "sent", fromName: "Summit Lawn", replyTo: "sam@summit.test" });

    // Read back from the table itself, not just the returned row.
    const [stored] = await t.db.select().from(commsMessages).where(eq(commsMessages.id, rowA.id));
    expect(stored).toMatchObject({ fromName: "Green Acres", replyTo: "gail@greenacres.test" });
  });

  it("without an identity, 0.2's behaviour: nulls on the message and on the row", async () => {
    const a = tenant();
    await seedTemplates(a);
    const c = capture();
    const row = await sendNow(t.db, { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder", vars: {} }, { email: c.email });
    expect(c.emails[0]).toMatchObject({ tenantId: a, fromName: null, replyTo: null });
    expect(row).toMatchObject({ status: "sent", fromName: null, replyTo: null });
  });

  it("records who it would have been on a skipped row (no email provider yet)", async () => {
    const a = tenant();
    await seedTemplates(a);
    const row = await sendNow(
      t.db,
      { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder", vars: {} },
      { identity: () => ({ name: "Green Acres", replyTo: "gail@greenacres.test" }) },
    );
    expect(row).toMatchObject({ status: "skipped", fromName: "Green Acres", replyTo: "gail@greenacres.test" });
  });

  it("an invalid reply-to is passed as null (the sender's default), and the row shows it empty", async () => {
    const a = tenant();
    await seedTemplates(a);
    const c = capture();
    const row = await sendNow(
      t.db,
      { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder", vars: {} },
      { email: c.email, identity: () => ({ name: "Green Acres", replyTo: "not an address" }) },
    );
    expect(c.emails[0]).toMatchObject({ fromName: "Green Acres", replyTo: null });
    expect(row).toMatchObject({ status: "sent", fromName: "Green Acres", replyTo: null });
  });

  it("a name with control characters is cleaned before it reaches the sender", async () => {
    const a = tenant();
    await seedTemplates(a);
    const c = capture();
    await sendNow(
      t.db,
      { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder", vars: {} },
      { email: c.email, identity: () => ({ name: "Green\r\nAcres", replyTo: null }) },
    );
    expect(c.emails[0]?.fromName).toBe("Green Acres");
  });

  it("a throwing identity fails the message and sends NOTHING under the platform's name", async () => {
    const a = tenant();
    await seedTemplates(a);
    const c = capture();
    const row = await sendNow(
      t.db,
      { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder", vars: {} },
      {
        email: c.email,
        identity: () => {
          throw new Error("profile lookup timed out");
        },
      },
    );
    expect(c.emails).toHaveLength(0);
    expect(row.status).toBe("failed");
    expect(row.error).toContain("couldn't read who this business sends as");
    expect(row.error).toContain("profile lookup timed out");
  });

  it("…and the queue RETRIES it (a transient failure), then sends once the identity reads", async () => {
    const a = tenant();
    await seedTemplates(a);
    const c = capture();
    const now = new Date();
    const id = await enqueueMessage(t.db, {
      tenantId: a,
      to: "pat@example.com",
      templateKey: "visit_reminder",
      sendAt: new Date(now.getTime() - 60_000),
    });
    let broken = true;
    const senders: CommsSenders = {
      email: c.email,
      identity: async () => {
        if (broken) throw new Error("database blip");
        return { name: "Green Acres", replyTo: "gail@greenacres.test" };
      },
    };
    const first = await runDueMessages(t.db, senders, { now, tenantIds: [a], retryBaseMs: 0 });
    expect(first).toMatchObject({ retrying: 1, sent: 0, failed: 0 });
    const [queued] = await t.db.select().from(commsScheduled).where(eq(commsScheduled.id, id as string));
    expect(queued?.status).toBe("pending");
    expect(c.emails).toHaveLength(0);

    broken = false;
    const second = await runDueMessages(t.db, senders, { now: new Date(now.getTime() + 1000), tenantIds: [a] });
    expect(second.sent).toBe(1);
    expect(c.emails[0]).toMatchObject({ fromName: "Green Acres", replyTo: "gail@greenacres.test" });
  });

  it("SMS: the company's name is the sender name every text starts with; compliance still required", async () => {
    const a = tenant();
    await seedTemplates(a);
    const c = capture();
    const row = await sendNow(
      t.db,
      { tenantId: a, to: "8015551234", templateKey: "visit_text", vars: { date: "Tue" } },
      {
        sms: c.sms,
        smsCompliance: { senderName: "Igloo Back Office" },
        identity: () => ({ name: "Green Acres", replyTo: "gail@greenacres.test" }),
      },
    );
    expect(c.texts[0]).toEqual({ tenantId: a, to: "+18015551234", body: "Green Acres: See you Tue. Reply STOP to opt out.", idempotencyKey: undefined });
    // A text records no From name or reply-to.
    expect(row).toMatchObject({ status: "sent", fromName: null, replyTo: null });
  });

  it("SMS without compliance config is still refused, identity or not", async () => {
    const a = tenant();
    await seedTemplates(a);
    const c = capture();
    const senders = {
      sms: c.sms,
      identity: () => ({ name: "Green Acres", replyTo: null }),
    } as unknown as CommsSenders;
    const row = await sendNow(t.db, { tenantId: a, to: "8015551234", templateKey: "visit_text", vars: {} }, senders);
    expect(row.status).toBe("failed");
    expect(row.error).toContain("sms compliance not configured");
    expect(c.texts).toHaveLength(0);
  });
});

describe("runDueMessages({ tenantIds })", () => {
  async function queueFor(tenantId: string, now: Date): Promise<string> {
    await seedTemplates(tenantId);
    return (await enqueueMessage(t.db, {
      tenantId,
      to: `${tenantId}@example.com`,
      templateKey: "visit_reminder",
      sendAt: new Date(now.getTime() - 60_000),
    })) as string;
  }

  it("claims only the listed tenants' rows", async () => {
    const now = new Date();
    const a = tenant("active-a");
    const b = tenant("active-b");
    const suspended = tenant("suspended");
    await queueFor(a, now);
    await queueFor(b, now);
    const waiting = await queueFor(suspended, now);
    const c = capture();
    const result = await runDueMessages(t.db, { email: c.email }, { now, tenantIds: [a, b] });
    expect(result.sent).toBe(2);
    expect(c.emails.map((m) => m.tenantId).sort()).toEqual([a, b].sort());
    const [row] = await t.db.select().from(commsScheduled).where(eq(commsScheduled.id, waiting));
    expect(row?.status).toBe("pending");
  });

  it("an empty list claims nothing and moves nothing: the housekeeping is scoped to the list too (review TB-3)", async () => {
    const now = new Date();
    const a = tenant();
    const id = await queueFor(a, now);
    // A row a dead worker claimed 20 minutes ago.
    await t.db
      .update(commsScheduled)
      .set({ status: "sending", claimedAt: new Date(now.getTime() - 20 * 60_000), attempts: 1 })
      .where(eq(commsScheduled.id, id));
    const c = capture();
    t.queries.length = 0;
    const result = await runDueMessages(t.db, { email: c.email }, { now, tenantIds: [] });
    expect(result.reclaimed).toBe(0);
    expect(result.processed).toBe(0);
    expect(c.emails).toHaveLength(0);
    // Nothing was sent to the queue table at all: no claim, no reclaim.
    expect(t.queries.some((q) => q.sql.includes('"comms_scheduled"'))).toBe(false);
    const [row] = await t.db.select().from(commsScheduled).where(eq(commsScheduled.id, id));
    expect(row?.status).toBe("sending");
    // The company's own run reclaims it.
    const own = await runDueMessages(t.db, { email: c.email }, { now, tenantIds: [a] });
    expect(own.reclaimed).toBe(1);
  });

  it("the stale-claim reclaim and the 0.1.x cleanup stay inside the listed tenants, and count only theirs (review TB-3)", async () => {
    const now = new Date();
    const a = tenant();
    const b = tenant();
    const ids: Record<string, string> = {};
    for (const [label, tenantId, attempts] of [["aOut", a, 5], ["aLeft", a, 1], ["bOut", b, 5]] as const) {
      ids[label] = await queueFor(tenantId, now);
      await t.db
        .update(commsScheduled)
        .set({ status: "sending", claimedAt: new Date(now.getTime() - 20 * 60_000), attempts })
        .where(eq(commsScheduled.id, ids[label]!));
    }
    const legacyA = await queueFor(a, now);
    await t.db.update(commsScheduled).set({ status: "sending", claimedAt: null }).where(eq(commsScheduled.id, legacyA));
    const c = capture();
    const result = await runDueMessages(t.db, { email: c.email }, { now, tenantIds: [b] });
    expect(result.failed).toBe(1);
    expect(result.reclaimed).toBe(0);
    const statusOf = async (id: string) => (await t.db.select().from(commsScheduled).where(eq(commsScheduled.id, id)))[0]?.status;
    expect(await statusOf(ids["aOut"]!)).toBe("sending");
    expect(await statusOf(ids["aLeft"]!)).toBe("sending");
    expect(await statusOf(legacyA)).toBe("sending");
    expect(await statusOf(ids["bOut"]!)).toBe("failed");
  });

  it("companies take turns: one company's 250 overdue rows don't hold back another's one (review SEC-2A-01)", async () => {
    const now = new Date();
    const noisy = tenant("noisy");
    const green = tenant("green");
    await seedTemplates(noisy);
    await seedTemplates(green);
    // Noisy Co's backlog, all due before Green Acres' single reminder.
    await t.db.insert(commsScheduled).values(
      Array.from({ length: 250 }, (_, i) => ({
        tenantId: noisy,
        channel: "email",
        toAddress: `n${i}@example.com`,
        templateKey: "visit_reminder",
        vars: {},
        sendAt: new Date(now.getTime() - 10 * 60_000 - i * 1000),
      })),
    );
    const greenRow = (await enqueueMessage(t.db, {
      tenantId: green,
      to: "pat@example.com",
      templateKey: "visit_reminder",
      sendAt: new Date(now.getTime() - 60_000),
    })) as string;
    const c = capture();
    const result = await runDueMessages(t.db, { email: c.email }, { now, tenantIds: [noisy, green], limit: 200 });
    expect(result.processed).toBe(200);
    expect(result.stoppedEarly).toBe(true);
    const [row] = await t.db.select().from(commsScheduled).where(eq(commsScheduled.id, greenRow));
    expect(row?.status).toBe("sent");
    // And Green Acres went out early in the run, not last.
    expect(c.emails.findIndex((m) => m.tenantId === green)).toBeLessThan(2);
    // Within a company it is still oldest first.
    const noisyTimes = c.emails.filter((m) => m.tenantId === noisy).map((m) => Number(m.to.slice(1, m.to.indexOf("@"))));
    expect(noisyTimes.slice(0, 3)).toEqual([249, 248, 247]);
  });

  it("asks for the identity once per tenant per drain", async () => {
    const now = new Date();
    const a = tenant();
    const b = tenant();
    await seedTemplates(a);
    await seedTemplates(b);
    for (const tenantId of [a, a, a, b, b]) {
      await enqueueMessage(t.db, {
        tenantId,
        to: "pat@example.com",
        templateKey: "visit_reminder",
        sendAt: new Date(now.getTime() - 60_000),
      });
    }
    const asked: string[] = [];
    const c = capture();
    const result = await runDueMessages(
      t.db,
      { email: c.email, identity: (id) => (asked.push(id), { name: id === a ? "Green Acres" : "Summit Lawn", replyTo: null }) },
      { now, tenantIds: [a, b] },
    );
    expect(result.sent).toBe(5);
    expect(asked.sort()).toEqual([a, b].sort());
    expect(c.emails.filter((m) => m.tenantId === a).every((m) => m.fromName === "Green Acres")).toBe(true);
    expect(c.emails.filter((m) => m.tenantId === b).every((m) => m.fromName === "Summit Lawn")).toBe(true);
  });

  it("undefined keeps 0.2's drain of every tenant", async () => {
    const now = new Date(Date.now() + 365 * 24 * 3_600_000);
    const a = tenant();
    const b = tenant();
    await seedTemplates(a);
    await seedTemplates(b);
    for (const tenantId of [a, b]) {
      await enqueueMessage(t.db, { tenantId, to: "pat@example.com", templateKey: "visit_reminder", sendAt: new Date(now.getTime() - 60_000), skipIfPast: false });
    }
    const c = capture();
    const result = await runDueMessages(t.db, { email: c.email }, { now });
    expect(c.emails.map((m) => m.tenantId)).toEqual(expect.arrayContaining([a, b]));
    expect(result.sent).toBeGreaterThanOrEqual(2);
  });
});

describe("a business's sending allowance (review SEC-2A-03)", () => {
  it("a message over the allowance is held, logged failed with the reason, and never reaches the sender", async () => {
    const a = tenant();
    await seedTemplates(a);
    const c = capture();
    let left = 2;
    const asked: string[] = [];
    const senders: CommsSenders = {
      email: c.email,
      allowance: ({ tenantId, templateKey }) => {
        asked.push(`${tenantId}:${templateKey}`);
        return left-- > 0;
      },
    };
    const rows = [];
    for (let i = 0; i < 3; i++) {
      rows.push(await sendNow(t.db, { tenantId: a, to: `p${i}@example.com`, templateKey: "visit_reminder", vars: {} }, senders));
    }
    expect(rows.map((r) => r.status)).toEqual(["sent", "sent", "failed"]);
    expect(rows[2]?.error).toBe(ALLOWANCE_HELD_MESSAGE);
    expect(c.emails).toHaveLength(2);
    expect(asked).toEqual([`${a}:visit_reminder`, `${a}:visit_reminder`, `${a}:visit_reminder`]);
  });

  it("only a message that would really leave counts: a switched-off template or no sender never asks", async () => {
    const a = tenant();
    await seedTemplates(a);
    await setTemplateActive(t.db, a, "visit_reminder", false);
    let asked = 0;
    const allowance = () => (asked++, true);
    await sendNow(t.db, { tenantId: a, to: "p@example.com", templateKey: "visit_reminder", vars: {} }, { email: capture().email, allowance });
    await setTemplateActive(t.db, a, "visit_reminder", true);
    await sendNow(t.db, { tenantId: a, to: "p@example.com", templateKey: "visit_reminder", vars: {} }, { allowance });
    expect(asked).toBe(0);
  });

  it("a queued message that is held is retried later, not dropped", async () => {
    const now = new Date();
    const a = tenant();
    await seedTemplates(a);
    const id = (await enqueueMessage(t.db, { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder", sendAt: new Date(now.getTime() - 60_000) })) as string;
    const c = capture();
    const held = await runDueMessages(t.db, { email: c.email, allowance: () => false }, { now, tenantIds: [a] });
    expect(held.retrying).toBe(1);
    const [row] = await t.db.select().from(commsScheduled).where(eq(commsScheduled.id, id));
    expect(row?.status).toBe("pending");
    expect(row?.lastError).toBe(ALLOWANCE_HELD_MESSAGE);
    expect(c.emails).toHaveLength(0);
  });

  it("a throwing allowance sends (a broken limiter must not stop every company's mail)", async () => {
    const a = tenant();
    await seedTemplates(a);
    const c = capture();
    const row = await sendNow(
      t.db,
      { tenantId: a, to: "p@example.com", templateKey: "visit_reminder", vars: {} },
      {
        email: c.email,
        allowance: () => {
          throw new Error("limiter down");
        },
      },
    );
    expect(row.status).toBe("sent");
  });
});

describe("a message's own reply-to (review T2A-BO-12)", () => {
  it("overrides the business's reply-to for that message, and the log records it", async () => {
    const a = tenant();
    await seedTemplates(a);
    const c = capture();
    const senders: CommsSenders = { email: c.email, identity: () => ({ name: "Green Acres", replyTo: "office@greenacres.test" }) };
    const row = await sendNow(
      t.db,
      { tenantId: a, to: "office@greenacres.test", templateKey: "visit_reminder", vars: {}, replyTo: "pat@example.com" },
      senders,
    );
    expect(c.emails[0]).toMatchObject({ fromName: "Green Acres", replyTo: "pat@example.com" });
    expect(row.replyTo).toBe("pat@example.com");
  });

  it("an address that isn't one is ignored: the business's reply-to stays", async () => {
    const a = tenant();
    await seedTemplates(a);
    const c = capture();
    const senders: CommsSenders = { email: c.email, identity: () => ({ name: "Green Acres", replyTo: "office@greenacres.test" }) };
    await sendNow(t.db, { tenantId: a, to: "office@greenacres.test", templateKey: "visit_reminder", vars: {}, replyTo: "not an address" }, senders);
    await sendNow(t.db, { tenantId: a, to: "office@greenacres.test", templateKey: "visit_reminder", vars: {}, replyTo: null }, senders);
    expect(c.emails.map((m) => m.replyTo)).toEqual(["office@greenacres.test", "office@greenacres.test"]);
  });
});
