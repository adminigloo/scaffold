import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../columns.js";
import { NOT_RESENT_SENTENCE } from "../email.js";
import { Directory, draft, greenAcres, rowsFor, rowsOf, world, type World } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The email copies (Tenancy 2b-1, 4.5; D7, D8): each outcome to its row
 * state, what the host's seam is handed, and the alerts cron (stale claims,
 * expiry, backoff, giving up, the companies it is told, the time budget, two
 * runs at once, companies taking turns).
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const MINUTE = 60_000;

/** One invoice-paid alert to the owner (email by default, sent by notifications). */
async function paid(w: World, tenantId: string, extra: Parameters<typeof draft>[2] = {}) {
  const report = await w.alerts.notify(draft(tenantId, "invoicing.invoice.paid", extra));
  return report;
}

describe("notify's sends", () => {
  it("sent → sent, with emailed_at", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    expect(await paid(w, a)).toMatchObject({ alerted: 1, emailed: 1, emailsFailed: 0, emailsLater: 0 });
    const [row] = await rowsFor(t, a, p.owner.userId);
    expect(row).toMatchObject({ emailStatus: "sent", emailTo: p.owner.email, emailAttempts: 1 });
    expect(row!.emailedAt).toEqual(w.clock.now);
  });

  it("skipped → skipped, with the reason", async () => {
    const w = world(t);
    w.mailbox.answer = () => ({ status: "skipped", reason: "this address unsubscribed" });
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await paid(w, a);
    expect((await rowsFor(t, a, p.owner.userId))[0]).toMatchObject({ emailStatus: "skipped", emailError: "this address unsubscribed" });
  });

  it("failed and retryable → pending again, due in 2^attempts minutes", async () => {
    const w = world(t);
    w.mailbox.answer = () => ({ status: "failed", error: "provider busy", retryable: true });
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    expect(await paid(w, a)).toMatchObject({ emailed: 0, emailsLater: 1 });
    const [row] = await rowsFor(t, a, p.owner.userId);
    expect(row).toMatchObject({ emailStatus: "pending", emailAttempts: 1, emailError: "provider busy" });
    expect(row!.emailNextAt!.getTime()).toBe(w.clock.now.getTime() + 2 * MINUTE);
  });

  it("failed and not retryable → failed", async () => {
    const w = world(t);
    w.mailbox.answer = () => ({ status: "failed", error: "mailbox doesn't exist", retryable: false });
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    expect(await paid(w, a)).toMatchObject({ emailsFailed: 1 });
    expect((await rowsFor(t, a, p.owner.userId))[0]).toMatchObject({ emailStatus: "failed", emailError: "mailbox doesn't exist" });
  });

  it("the seam throwing, with a provider that drops a repeat (emailIdempotent) → as a retryable failure, reported", async () => {
    const w = world(t, { emailIdempotent: true });
    w.mailbox.answer = () => {
      throw new Error("socket hang up");
    };
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    expect(await paid(w, a)).toMatchObject({ emailsLater: 1 });
    expect((await rowsFor(t, a, p.owner.userId))[0]).toMatchObject({ emailStatus: "pending", emailError: "socket hang up" });
    expect(w.errors.map((e) => e.context.step)).toContain("email");
  });

  it("the seam throwing, with SMTP (no idempotency key): it may have gone, so it is never sent again (review FH-9)", async () => {
    // The README's nodemailer seam, verbatim in shape: the server accepted
    // the message, then the connection dropped and sendMail threw.
    const w = world(t);
    let throws = true;
    w.mailbox.answer = () => {
      if (!throws) return { status: "sent" };
      throws = false;
      throw Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNRESET" });
    };
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    expect(await paid(w, a)).toMatchObject({ emailed: 0, emailsFailed: 1, emailsLater: 0 });
    expect((await rowsFor(t, a, p.owner.userId))[0]).toMatchObject({
      emailStatus: "failed",
      emailError: `${NOT_RESENT_SENTENCE} (Connection closed unexpectedly)`,
    });
    expect(w.errors.map((e) => e.context.step)).toContain("email");
    w.clock.now = new Date(w.clock.now.getTime() + 60 * MINUTE);
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ sent: 0 });
    expect(w.mailbox.to(p.owner.email!)).toHaveLength(1);
  });

  it("with SMTP, a seam that ANSWERS a retryable failure (refused before the message went) is still tried again", async () => {
    const w = world(t);
    w.mailbox.answer = () => ({ status: "failed", error: "couldn't connect to the mail server", retryable: true });
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    expect(await paid(w, a)).toMatchObject({ emailsLater: 1 });
    w.mailbox.answer = () => ({ status: "sent" });
    w.clock.now = new Date(w.clock.now.getTime() + 3 * MINUTE);
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ sent: 1 });
    expect((await rowsFor(t, a, p.owner.userId))[0]).toMatchObject({ emailStatus: "sent" });
  });

  it("timed out → left sending, counted for later", async () => {
    const w = world(t, { sendTimeoutMs: 30 });
    w.mailbox.answer = () => new Promise(() => {});
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    expect(await paid(w, a)).toMatchObject({ emailed: 0, emailsLater: 1 });
    expect((await rowsFor(t, a, p.owner.userId))[0]).toMatchObject({ emailStatus: "sending", emailAttempts: 1 });
  });

  it("a send that finishes after the timeout is still recorded, guarded on its claim", async () => {
    const w = world(t, { sendTimeoutMs: 20 });
    let finish!: () => void;
    w.mailbox.answer = () => new Promise((resolve) => (finish = () => resolve({ status: "sent" })));
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await paid(w, a);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await rowsFor(t, a, p.owner.userId))[0]).toMatchObject({ emailStatus: "sent" });
  });

  it("hands the seam the alert with links broken, the key alert:{id}, and who it is", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await paid(w, a, {
      title: "Paid via https://evil.example/pay",
      body: "Note: visit www.evil.example\nthanks",
      href: "/app/invoices/i1",
      replyTo: "pat@customer.test",
    });
    const [row] = await rowsFor(t, a, p.owner.userId);
    expect(w.mailbox.sent).toEqual([
      {
        tenantId: a,
        alertId: row!.id,
        kind: "invoicing.invoice.paid",
        to: p.owner.email,
        recipientName: "Gail Owner",
        addressOnly: false,
        title: "Paid via https[:]//evil[.]example/pay",
        body: "Note: visit www[.]evil.example\nthanks",
        href: "/app/invoices/i1",
        replyTo: "pat@customer.test",
        idempotencyKey: `alert:${row!.id}`,
      },
    ]);
    // What a person sees in the app is what was written.
    expect(row!.title).toBe("Paid via https://evil.example/pay");
  });

  it("an email-only address's copy says so (addressOnly)", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.setRouting({ tenantId: a, routing: "invoices", mode: "chosen", userIds: [p.admin.userId], extraEmails: ["books@greenacres.test"], by: p.owner.userId });
    await paid(w, a);
    expect(w.mailbox.to("books@greenacres.test")).toMatchObject([{ addressOnly: true, recipientName: null }]);
    expect(w.mailbox.to(p.admin.email!)).toMatchObject([{ addressOnly: false }]);
  });

  it("no email seam: everything stays in the app", async () => {
    const w = world(t, { email: undefined });
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await paid(w, a);
    expect((await rowsFor(t, a, p.owner.userId))[0]).toMatchObject({ emailStatus: "none" });
  });
});

/** Rows of a company left pending (each failed once in the request). */
async function leavePending(w: World, tenantId: string, count = 1) {
  const answer = w.mailbox.answer;
  w.mailbox.answer = () => ({ status: "failed", error: "provider busy", retryable: true });
  for (let i = 0; i < count; i += 1) await paid(w, tenantId);
  w.mailbox.answer = answer;
  w.mailbox.sent.length = 0;
}

describe("deliverPendingEmails (the alerts cron)", () => {
  it("sends what is due, once", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await leavePending(w, a);
    w.clock.now = new Date(w.clock.now.getTime() + 3 * MINUTE);
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ sent: 1, failed: 0, retrying: 0 });
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ sent: 0 });
    expect(w.mailbox.to(p.owner.email!)).toHaveLength(1);
    expect((await rowsFor(t, a, p.owner.userId))[0]).toMatchObject({ emailStatus: "sent", emailAttempts: 2 });
  });

  it("leaves a row alone until it is due (backoff)", async () => {
    const w = world(t);
    const a = tenant("a");
    greenAcres(w.directory, a);
    await leavePending(w, a);
    w.clock.now = new Date(w.clock.now.getTime() + 1 * MINUTE);
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ sent: 0 });
    expect(w.mailbox.sent).toEqual([]);
  });

  it("retries with growing backoff and gives up after maxAttempts", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await leavePending(w, a);
    w.mailbox.answer = () => ({ status: "failed", error: "provider busy", retryable: true });
    const advance = (minutes: number) => (w.clock.now = new Date(w.clock.now.getTime() + minutes * MINUTE));
    advance(3);
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a], maxAttempts: 3 })).toMatchObject({ retrying: 1 });
    let [row] = await rowsFor(t, a, p.owner.userId);
    expect(row!.emailAttempts).toBe(2);
    expect(row!.emailNextAt!.getTime()).toBe(w.clock.now.getTime() + 4 * MINUTE);
    advance(5);
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a], maxAttempts: 3 })).toMatchObject({ failed: 1 });
    [row] = await rowsFor(t, a, p.owner.userId);
    expect(row).toMatchObject({ emailStatus: "failed", emailAttempts: 3, emailError: "provider busy (gave up after 3 tries)" });
  });

  it("expires a pending row older than maxAgeMs (26 h)", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await leavePending(w, a);
    w.clock.now = new Date(w.clock.now.getTime() + 27 * 60 * MINUTE);
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ expired: 1, sent: 0 });
    expect((await rowsFor(t, a, p.owner.userId))[0]).toMatchObject({ emailStatus: "expired", emailError: "too late to be useful" });
    expect(w.mailbox.sent).toEqual([]);
  });

  it("with emailIdempotent, reclaims a stale `sending` and sends it (the key stops a double)", async () => {
    const w = world(t, { emailIdempotent: true, sendTimeoutMs: 10 });
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    w.mailbox.answer = () => new Promise(() => {});
    await paid(w, a);
    w.mailbox.answer = () => ({ status: "sent" });
    w.clock.now = new Date(w.clock.now.getTime() + 11 * MINUTE);
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ reclaimed: 1, sent: 1 });
    const [row] = await rowsFor(t, a, p.owner.userId);
    expect(row).toMatchObject({ emailStatus: "sent", emailAttempts: 2 });
    const keys = w.mailbox.sent.map((m) => m.idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });

  it("without it, ends a stale `sending` failed with its sentence and never sends it (review G12)", async () => {
    const w = world(t, { sendTimeoutMs: 10 });
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    w.mailbox.answer = () => new Promise(() => {});
    await paid(w, a);
    w.mailbox.sent.length = 0;
    w.mailbox.answer = () => ({ status: "sent" });
    w.clock.now = new Date(w.clock.now.getTime() + 11 * MINUTE);
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ failed: 1, sent: 0, reclaimed: 0 });
    expect((await rowsFor(t, a, p.owner.userId))[0]).toMatchObject({ emailStatus: "failed", emailError: NOT_RESENT_SENTENCE });
    expect(w.mailbox.sent).toEqual([]);
  });

  it("a `sending` row claimed less than 10 minutes ago is left alone", async () => {
    const w = world(t, { emailIdempotent: true, sendTimeoutMs: 10 });
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    w.mailbox.answer = () => new Promise(() => {});
    await paid(w, a);
    w.clock.now = new Date(w.clock.now.getTime() + 5 * MINUTE);
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ reclaimed: 0, sent: 0 });
    expect((await rowsFor(t, a, p.owner.userId))[0]).toMatchObject({ emailStatus: "sending" });
  });

  it("honours tenantIds: only the companies named, and [] claims and touches nothing", async () => {
    const directory = new Directory();
    const w = world(t, {}, directory);
    const a = tenant("a");
    const b = tenant("b");
    greenAcres(directory, a);
    greenAcres(directory, b);
    await leavePending(w, a);
    await leavePending(w, b);
    w.clock.now = new Date(w.clock.now.getTime() + 27 * 60 * MINUTE);
    t.queries.length = 0;
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [] })).toEqual({
      sent: 0,
      skipped: 0,
      failed: 0,
      retrying: 0,
      expired: 0,
      reclaimed: 0,
      stoppedEarly: false,
    });
    expect(t.queries).toEqual([]);
    w.clock.now = new Date(w.clock.now.getTime() - 27 * 60 * MINUTE + 3 * MINUTE);
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [b] })).toMatchObject({ sent: 1 });
    expect((await rowsOf(t, a))[0]).toMatchObject({ emailStatus: "pending" });
    expect((await rowsOf(t, b))[0]).toMatchObject({ emailStatus: "sent" });
  });

  it("stops starting rows when the time budget is spent", async () => {
    const w = world(t);
    const a = tenant("a");
    greenAcres(w.directory, a);
    await leavePending(w, a, 2);
    w.clock.now = new Date(w.clock.now.getTime() + 3 * MINUTE);
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a], timeBudgetMs: 0 })).toMatchObject({ sent: 0, stoppedEarly: true });
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ sent: 2, stoppedEarly: false });
  });

  it("two runs at once claim each row once (the attempt guard)", async () => {
    const w = world(t);
    const a = tenant("a");
    greenAcres(w.directory, a);
    await leavePending(w, a, 6);
    w.clock.now = new Date(w.clock.now.getTime() + 3 * MINUTE);
    const [one, two] = await Promise.all([w.alerts.deliverPendingEmails({ tenantIds: [a] }), w.alerts.deliverPendingEmails({ tenantIds: [a] })]);
    expect(one.sent + two.sent).toBe(6);
    expect(new Set(w.mailbox.sent.map((m) => m.alertId)).size).toBe(6);
    expect(w.mailbox.sent).toHaveLength(6);
    const claims = t.queries.filter((q) => /^update/i.test(q.sql) && q.sql.includes('"email_attempts" = $'));
    expect(claims.length).toBeGreaterThan(0);
  });

  it("companies take turns: 600 due rows of A never hold back B's one (review BO-14)", async () => {
    const directory = new Directory();
    const w = world(t, {}, directory);
    const a = tenant("a");
    const b = tenant("b");
    const p = greenAcres(directory, a);
    const q = greenAcres(directory, b);
    const A = t.tables.alerts;
    const due = new Date(w.clock.now.getTime() - 60 * MINUTE);
    const row = (tenantId: string, recipientId: string, i: number, nextAt: Date) => ({
      id: newId(),
      tenantId,
      recipientId,
      reachedVia: "audience",
      kind: "invoicing.invoice.paid",
      title: `Invoice ${i} paid`,
      dedupeKey: `invoicing.invoice.paid:bulk-${tenantId}-${i}`,
      createdAt: w.clock.now,
      emailStatus: "pending",
      emailTo: "x@x.test",
      emailNextAt: nextAt,
    });
    for (let start = 0; start < 600; start += 200) {
      await t.db.insert(A).values(Array.from({ length: 200 }, (_, i) => row(a, p.owner.userId, start + i, new Date(due.getTime() - (start + i) * 1000))));
    }
    // B's row is the newest due of all: by due time alone it would be last.
    await t.db.insert(A).values(row(b, q.owner.userId, 0, due));
    const result = await w.alerts.deliverPendingEmails({ tenantIds: [a, b], limit: 10 });
    expect(result).toMatchObject({ sent: 10, stoppedEarly: true });
    expect(w.mailbox.sent.filter((m) => m.tenantId === b)).toHaveLength(1);
    const left = await t.db
      .select({ id: A.id })
      .from(A)
      .where(and(inArray(A.tenantId, [a, b]), eq(A.emailStatus, "pending")));
    expect(left).toHaveLength(591);
  });
});
