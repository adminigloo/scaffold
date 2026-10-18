import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enqueueMessage, runDueMessages, sendNow, upsertTemplate, type CommsSent, type OutboundEmail } from "../index.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * comms 0.5: `onSent` — told once a message has gone, from `sendNow` and from
 * the queue's drain, after its log row is written; never about a skip or a
 * failure, and a throwing `onSent` never fails the send. (The customer list
 * puts each message on its customer's timeline from here.)
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const ok = async (_m: OutboundEmail) => ({ id: "em_1" });
const throws = async (_m: OutboundEmail): Promise<{ id: string }> => {
  throw new Error("provider down");
};

describe("onSent", () => {
  it("tells a sent message once, with its log row, and never a skip or a failure", async () => {
    const a = tenant("sent");
    await upsertTemplate(t.db, { tenantId: a, key: "visit_reminder", subject: "See you {{date}}", body: "Hi, see you {{date}}." });
    const told: CommsSent[] = [];
    const onSent = (sent: CommsSent) => void told.push(sent);
    const row = await sendNow(t.db, { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder", vars: { date: "Tue" } }, { email: ok, onSent });
    await sendNow(t.db, { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder" }, { onSent });
    await sendNow(t.db, { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder" }, { email: throws, onSent });
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ tenantId: a, messageId: row.id, scheduledId: null, channel: "email", to: "pat@example.com", templateKey: "visit_reminder", subject: "See you Tue" });
  });

  it("tells a queued message the drain sends, and a throwing onSent fails nothing", async () => {
    const a = tenant("sent");
    await upsertTemplate(t.db, { tenantId: a, key: "follow_up", subject: "Hello", body: "Hello." });
    const id = await enqueueMessage(t.db, { tenantId: a, to: "kim@example.com", templateKey: "follow_up", sendAt: new Date(Date.now() - 1_000) });
    const told: CommsSent[] = [];
    const result = await runDueMessages(t.db, {
      email: ok,
      onSent: (sent) => {
        told.push(sent);
        throw new Error("listener broke");
      },
    });
    expect(result.sent).toBe(1);
    expect(told.map((sent) => [sent.scheduledId, sent.to])).toEqual([[id, "kim@example.com"]]);
  });
});
