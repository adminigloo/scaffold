import { afterEach, describe, expect, it } from "vitest";
import * as assistant from "@adminigloo/assistant/schema";
import { createPgliteDb } from "../../../testing/src/pglite.js";
import { assistantGlance } from "../glances/assistant.js";

const NOW = new Date("2026-11-19T18:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const t = await createPgliteDb({ schema: { ...assistant }, logQueries: false });
  close = () => t.close();
  return t.db;
}

describe("assistantGlance", () => {
  it("is empty when nothing has happened yet", async () => {
    const db = await setup();
    const glance = await assistantGlance({ db, now: NOW, tenantId: "*" });
    expect(glance.tiles?.map((tile) => tile.value)).toEqual([0, 0]);
    expect(glance.list?.rows).toEqual([]);
    expect(glance.status).toEqual({ text: "0 conversations in the last 7 days.", tone: "neutral" });
  });

  it("counts this assistant's own conversations and open drafts, excludes another tenant's rows, and lists the latest changes", async () => {
    const db = await setup();
    await db.insert(assistant.assistantConversations).values([
      { id: "c-recent", tenantId: "*", userId: "user-1", createdAt: daysAgo(2) },
      { id: "c-old", tenantId: "*", userId: "user-1", createdAt: daysAgo(10) },
      { id: "c-other-tenant", tenantId: "other", userId: "user-1", createdAt: daysAgo(1) },
    ]);
    await db.insert(assistant.assistantDrafts).values([
      { tenantId: "*", targetType: "section", targetId: "sec-1", content: "a", status: "draft" },
      { tenantId: "*", targetType: "section", targetId: "sec-2", content: "b", status: "testing" },
      { tenantId: "*", targetType: "section", targetId: "sec-3", content: "c", status: "applied" },
      { tenantId: "other", targetType: "section", targetId: "sec-4", content: "d", status: "draft" },
    ]);
    await db.insert(assistant.assistantChangeLog).values([
      { tenantId: "*", entityType: "section", entityId: "e-1", action: "created", changeSummary: "created", createdAt: hoursAgo(5) },
      { tenantId: "*", entityType: "section", entityId: "e-1", action: "published", createdAt: hoursAgo(4) },
      {
        tenantId: "*",
        entityType: "tenant_rule",
        entityId: "e-2",
        action: "created",
        changeSummary: "Always mention refund window",
        createdAt: hoursAgo(3),
      },
      {
        tenantId: "*",
        entityType: "tenant_rule",
        entityId: "e-2",
        action: "deactivated",
        changeSummary: "Always mention refund window",
        createdAt: hoursAgo(2),
      },
      { tenantId: "*", entityType: "glossary", entityId: "e-3", action: "created", changeSummary: "crown", createdAt: hoursAgo(1) },
      { tenantId: "other", entityType: "section", entityId: "e-9", action: "created", changeSummary: "created", createdAt: hoursAgo(1) },
    ]);

    const glance = await assistantGlance({ db, now: NOW, tenantId: "*" });
    const [conversations, changesWaiting] = glance.tiles ?? [];

    // c-old is outside the 7-day window; c-other-tenant belongs to another assistant.
    expect(conversations?.value).toBe(1);
    // sec-3's draft is already applied; sec-4's draft belongs to another tenant.
    expect(changesWaiting).toMatchObject({ value: 2, tone: "warn" });
    expect(glance.status).toEqual({ text: "2 changes waiting to be published.", tone: "warn" });
    expect(glance.attention).toBe(2);

    // Newest first, and the other tenant's entry never appears.
    expect(glance.list?.rows.map((r) => r.title)).toEqual([
      "Crown",
      "Always mention refund window",
      "Always mention refund window",
      "Published",
      "Created",
    ]);
    expect(glance.list?.rows[0]).toMatchObject({ badge: "Glossary term", tone: "good" });
    expect(glance.list?.rows[1]).toMatchObject({ badge: "House rule", tone: "warn" });
    expect(glance.list?.rows[3]).toMatchObject({ badge: "Section", tone: "neutral" });
  });
});
