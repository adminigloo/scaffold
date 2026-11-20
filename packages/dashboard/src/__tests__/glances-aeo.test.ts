import { afterEach, describe, expect, it } from "vitest";
import * as aeoSchema from "@adminigloo/aeo/schema";
import { createPgliteDb } from "../../../testing/src/pglite.js";
import { aiMentionsGlance } from "../glances/aeo.js";

const NOW = new Date("2026-11-19T18:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);
const ago = (date: Date) => {
  const hours = Math.round((NOW.getTime() - date.getTime()) / (60 * 60 * 1000));
  const days = Math.floor(hours / 24);
  return days >= 1 ? `${days} days ago` : `${hours} h ago`;
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const t = await createPgliteDb({ schema: { ...aeoSchema }, logQueries: false });
  close = () => t.close();
  return t.db;
}

type Db = Awaited<ReturnType<typeof setup>>;

async function addQuery(db: Db, tenantId: string, query: string): Promise<string> {
  const [row] = await db.insert(aeoSchema.aeoQueries).values({ tenantId, query }).returning({ id: aeoSchema.aeoQueries.id });
  return row!.id;
}

async function addCheck(db: Db, tenantId: string, queryId: string, cited: boolean, checkedAt: Date) {
  await db.insert(aeoSchema.aeoChecks).values({ tenantId, queryId, engine: "claude", cited, checkedAt });
}

describe("aiMentionsGlance", () => {
  it("shows a setup card when no questions are tracked", async () => {
    const db = await setup();
    const glance = await aiMentionsGlance({ db, tenantId: "tenant-a", now: NOW });
    expect(glance).toEqual({
      setup: {
        text: "No questions are tracked yet. Add a question a customer might ask to see if AI assistants name your site.",
        href: "/admin/aeo",
        label: "Add a question",
      },
    });
  });

  it("counts questions tracked and named, the change from the last run, and lists recent answers newest first", async () => {
    const db = await setup();

    const q1 = await addQuery(db, "tenant-a", "wheelchair ramp rental Raleigh");
    const q2 = await addQuery(db, "tenant-a", "best accessible home builder Raleigh");

    // q1: wasn't named last time, is named now.
    await addCheck(db, "tenant-a", q1, false, hoursAgo(169));
    await addCheck(db, "tenant-a", q1, true, hoursAgo(3));
    // q2: was named last time, isn't named now.
    await addCheck(db, "tenant-a", q2, true, hoursAgo(168));
    await addCheck(db, "tenant-a", q2, false, hoursAgo(2));

    const glance = await aiMentionsGlance({ db, tenantId: "tenant-a", now: NOW });

    expect(glance.tiles?.map((t) => ({ label: t.label, value: t.value, hint: t.hint }))).toEqual([
      { label: "Questions tracked", value: 2, hint: undefined },
      { label: "Named the site", value: 1, hint: "Same as last time" },
      { label: "Not named", value: 1, hint: undefined },
    ]);
    expect(glance.tiles?.every((t) => t.href === "/admin/aeo")).toBe(true);
    expect(glance.status).toEqual({ text: "AI assistants named your site in 1 answer of 2 this run.", tone: "neutral" });

    expect(glance.list?.rows).toEqual([
      { title: "best accessible home builder Raleigh", meta: ago(hoursAgo(2)), badge: "Not named", tone: "warn", href: "/admin/aeo" },
      { title: "wheelchair ramp rental Raleigh", meta: ago(hoursAgo(3)), badge: "Named", tone: "good", href: "/admin/aeo" },
      { title: "best accessible home builder Raleigh", meta: ago(hoursAgo(168)), badge: "Named", tone: "good", href: "/admin/aeo" },
      { title: "wheelchair ramp rental Raleigh", meta: ago(hoursAgo(169)), badge: "Not named", tone: "warn", href: "/admin/aeo" },
    ]);
  });

  it("never counts or lists another tenant's questions or answers", async () => {
    const db = await setup();
    const a1 = await addQuery(db, "tenant-a", "tenant A's question");
    await addCheck(db, "tenant-a", a1, true, hoursAgo(1));

    const b1 = await addQuery(db, "tenant-b", "tenant B's question");
    const b2 = await addQuery(db, "tenant-b", "tenant B's second question");
    await addCheck(db, "tenant-b", b1, false, hoursAgo(1));
    await addCheck(db, "tenant-b", b2, false, hoursAgo(1));

    const glanceA = await aiMentionsGlance({ db, tenantId: "tenant-a", now: NOW });
    expect(glanceA.tiles?.map((t) => t.value)).toEqual([1, 1, 0]);
    expect(glanceA.list?.rows.map((r) => r.title)).toEqual(["tenant A's question"]);

    const glanceB = await aiMentionsGlance({ db, tenantId: "tenant-b", now: NOW });
    expect(glanceB.tiles?.map((t) => t.value)).toEqual([2, 0, 2]);
  });
});
