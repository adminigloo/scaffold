import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createEstimate,
  createEstimatorAdminHandlers,
  estimatorPermissions,
  expireQuotes,
  getEstimateRow,
  getEstimatorSettings,
  HISTORY_EARLIEST,
  publicSubmitSchema,
  setEstimateStatus,
  type EstimatorEvent,
} from "../index.js";
import { ADMIN_BASE, readJson, request } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * PAST RECORDS WITH THEIR REAL DATES (estimator 0.7): staff entering a
 * business's old quotes give the day each happened. The estimate keeps that
 * day (its number is that year's, its stamps and events carry it, the
 * customer is never told) and records when and by whom it was entered. A
 * future date, one before 2000 or one before the estimate was made is
 * refused, naming the field. No public route takes a date.
 */

const NOW = new Date("2026-10-20T15:00:00.000Z");
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function issuesOf(p: Promise<unknown>): Promise<{ path: (string | number)[]; message: string }[]> {
  try {
    await p;
  } catch (error) {
    return ((error as { issues?: { path: (string | number)[]; message: string }[] }).issues ?? []).map((i) => ({ path: i.path, message: i.message }));
  }
  throw new Error("expected a refusal");
}

describe("createEstimate with occurredAt", () => {
  it("keeps the real day (and that year's number), and records when and by whom it was entered", async () => {
    const tenantId = tenant();
    const made = await createEstimate(t.db, { tenantId, customerName: "Pat Lee", items: [], source: "staff" }, "u-sam", {
      now: NOW,
      occurredAt: "2025-03-04T15:00:00Z",
    });
    expect(made.estimateNumber).toBe("EST-2025-0001");
    const row = (await getEstimateRow(t.db, tenantId, made.id))!;
    expect(row.createdAt.toISOString()).toBe("2025-03-04T15:00:00.000Z");
    expect(row.enteredAt?.toISOString()).toBe(NOW.toISOString());
    expect(row.enteredBy).toBe("u-sam");
    // One made today is just made today: nothing says "entered later".
    const today = await createEstimate(t.db, { tenantId, customerName: "Jo", items: [], source: "staff" }, "u-sam", { now: NOW });
    const todayRow = (await getEstimateRow(t.db, tenantId, today.id))!;
    expect(todayRow.createdAt.toISOString()).toBe(NOW.toISOString());
    expect(todayRow.enteredAt).toBeNull();
    expect(today.estimateNumber).toBe("EST-2026-0001");
  });

  it("refuses a future date, one before 2000 and one that isn't a date, naming occurredAt", async () => {
    const tenantId = tenant();
    const make = (occurredAt: string) => createEstimate(t.db, { tenantId, items: [], source: "staff" }, "u-sam", { now: NOW, occurredAt });
    expect(await issuesOf(make("2026-10-21"))).toEqual([{ path: ["occurredAt"], message: "That date is in the future. Enter the day it really happened." }]);
    expect(await issuesOf(make("1999-12-31T23:59:59Z"))).toEqual([{ path: ["occurredAt"], message: "That date is before 2000. Check the year." }]);
    expect((await issuesOf(make("last spring")))[0]?.path).toEqual(["occurredAt"]);
    expect(HISTORY_EARLIEST.toISOString()).toBe("2000-01-01T00:00:00.000Z");
    const count = await t.db.execute(sql`select count(*)::int as n from estimator_estimates where tenant_id = ${tenantId}`);
    expect(Number((count.rows[0] as { n: number }).n)).toBe(0);
  });
});

describe("setEstimateStatus with occurredAt", () => {
  it("stamps the real day, tells nobody, and its event carries that day", async () => {
    const tenantId = tenant();
    const events: EstimatorEvent[] = [];
    const made = await createEstimate(t.db, { tenantId, customerName: "Pat Lee", items: [], source: "staff" }, "u-sam", {
      now: NOW,
      occurredAt: "2025-03-04",
    });
    const opts = { now: NOW, onEvent: (e: EstimatorEvent) => void events.push(e), notify: true };
    expect(await setEstimateStatus(t.db, tenantId, { id: made.id, status: "sent" }, { ...opts, occurredAt: "2025-03-05" })).toBe(true);
    expect(await setEstimateStatus(t.db, tenantId, { id: made.id, status: "approved", note: "Go ahead" }, { ...opts, occurredAt: "2025-03-09" })).toBe(true);
    const row = (await getEstimateRow(t.db, tenantId, made.id))!;
    expect(row.sentAt?.toISOString()).toBe("2025-03-05T12:00:00.000Z");
    expect(row.approvedAt?.toISOString()).toBe("2025-03-09T12:00:00.000Z");
    expect(events.map((e) => [e.type, e.occurredAt, e.data.notify])).toEqual([["quote.accepted", "2025-03-09T12:00:00.000Z", false]]);
  });

  it("refuses a day before the estimate was made, and another company's estimate is not found", async () => {
    const tenantId = tenant();
    const other = tenant();
    const made = await createEstimate(t.db, { tenantId, items: [], source: "staff" }, "u-sam", { now: NOW, occurredAt: "2025-03-04" });
    expect(await issuesOf(setEstimateStatus(t.db, tenantId, { id: made.id, status: "sent" }, { now: NOW, occurredAt: "2025-03-01" }))).toEqual([
      { path: ["occurredAt"], message: "That's before the estimate was made (2025-03-04)." },
    ]);
    expect(await setEstimateStatus(t.db, other, { id: made.id, status: "sent" }, { now: NOW, occurredAt: "2025-03-05" })).toBe(false);
    expect((await getEstimateRow(t.db, tenantId, made.id))!.status).toBe("draft");
  });
});

describe("the staff routes take a past date; the public ones never do", () => {
  const admin = (handlers: ReturnType<typeof createEstimatorAdminHandlers>, path: string, body: unknown) =>
    handlers.handle(request("POST", `${ADMIN_BASE}/v1/admin/${path}`, body));

  it("POST estimates and POST estimates/{id}/status with occurredAt; the detail says when it was entered", async () => {
    const tenantId = tenant();
    const handlers = createEstimatorAdminHandlers({ db: t.db, tenantId, authorize: () => ({ userId: "u-sam" }), now: () => NOW });
    const created = await admin(handlers, "estimates", { customerName: "Pat Lee", occurredAt: "2025-06-14" });
    expect(created.status).toBe(201);
    const detail = (await readJson(created)).estimate;
    expect(detail).toMatchObject({ number: "EST-2025-0001", createdAt: "2025-06-14T12:00:00.000Z", enteredAt: NOW.toISOString(), enteredBy: "u-sam" });
    expect(detail.timeline.map((e: { label: string }) => e.label)).toEqual(["Created", "Entered from past records"]);

    const sent = await admin(handlers, `estimates/${detail.id}/status`, { status: "sent", occurredAt: "2025-06-15" });
    expect(sent.status).toBe(200);
    expect((await readJson(sent)).estimate.sentAt).toBe("2025-06-15T12:00:00.000Z");
    // "sent" without a date is Send quote's, which emails: refused here.
    const bare = await admin(handlers, `estimates/${detail.id}/status`, { status: "sent" });
    expect(bare.status).toBe(400);
    const future = await admin(handlers, `estimates/${detail.id}/status`, { status: "approved", occurredAt: "2027-01-01" });
    expect(future.status).toBe(400);
    expect((await readJson(future)).error.issues).toEqual([
      expect.objectContaining({ path: ["occurredAt"], message: "That date is in the future. Enter the day it really happened." }),
    ]);
  });

  it("the public submit drops a date it is sent (unknown keys are never trusted)", () => {
    const parsed = publicSubmitSchema.parse({
      customerName: "Pat",
      customerEmail: "pat@example.test",
      items: [{ productId: "p-1" }],
      occurredAt: "2024-01-01",
      createdAt: "2024-01-01",
    }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("occurredAt");
    expect(parsed).not.toHaveProperty("createdAt");
  });
});

describe("a past quote whose time ran out before it was typed in expires silently (review: back-dated 'sent' emailed 'quote expired')", () => {
  const customer = { customerName: "Pat Lee", customerEmail: "pat@example.test", items: [], source: "staff" as const };

  it("back-dated sent → the sweep moves it to expired and announces nothing", async () => {
    const tenantId = tenant();
    const events: EstimatorEvent[] = [];
    const made = await createEstimate(t.db, { tenantId, ...customer }, "u-sam", { now: NOW, occurredAt: "2024-03-01" });
    expect(await setEstimateStatus(t.db, tenantId, { id: made.id, status: "sent" }, { now: NOW, occurredAt: "2024-03-02" })).toBe(true);
    const swept = await expireQuotes(t.db, tenantId, { now: NOW, onEvent: (e) => void events.push(e) });
    expect(swept).toMatchObject({ expired: 1, announced: 0 });
    expect((await getEstimateRow(t.db, tenantId, made.id))!.status).toBe("expired");
    expect(events.filter((e) => e.type === "quote.expired")).toEqual([]);
    // A second run (the cron after the list's throttled sweep) still tells nobody.
    await expireQuotes(t.db, tenantId, { now: new Date(NOW.getTime() + 86_400_000), onEvent: (e) => void events.push(e) });
    expect(events).toEqual([]);
  });

  it("an estimate made in the app long ago and recorded as sent back then is silent too (no entered_at to go by)", async () => {
    const tenantId = tenant();
    const events: EstimatorEvent[] = [];
    const made = await createEstimate(t.db, { tenantId, ...customer }, "u-sam", { now: new Date("2024-03-01T15:00:00Z") });
    expect((await getEstimateRow(t.db, tenantId, made.id))!.enteredAt).toBeNull();
    expect(await setEstimateStatus(t.db, tenantId, { id: made.id, status: "sent" }, { now: NOW, occurredAt: "2024-03-02" })).toBe(true);
    expect(await expireQuotes(t.db, tenantId, { now: NOW, onEvent: (e) => void events.push(e) })).toMatchObject({ expired: 1, announced: 0 });
    expect(events).toEqual([]);
  });

  it("the sweep itself keeps an entered row's old expiry quiet, stamp or not (a row written another way)", async () => {
    const tenantId = tenant();
    const events: EstimatorEvent[] = [];
    const made = await createEstimate(t.db, { tenantId, ...customer }, "u-sam", { now: NOW, occurredAt: "2024-03-01" });
    await setEstimateStatus(t.db, tenantId, { id: made.id, status: "sent" }, { now: NOW, occurredAt: "2024-03-02" });
    await t.db.execute(sql`update estimator_estimates set expiry_notified_at = null where id = ${made.id}`);
    expect(await expireQuotes(t.db, tenantId, { now: NOW, onEvent: (e) => void events.push(e) })).toMatchObject({ expired: 1, announced: 0 });
    expect(events).toEqual([]);
    expect((await getEstimateRow(t.db, tenantId, made.id))!.expiryNotifiedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("NEGATIVE CONTROL: the same quote really sent on that day is announced to the customer", async () => {
    const tenantId = tenant();
    const events: EstimatorEvent[] = [];
    const made = await createEstimate(t.db, { tenantId, ...customer }, "u-sam", { now: new Date("2024-03-01T15:00:00Z") });
    expect(await setEstimateStatus(t.db, tenantId, { id: made.id, status: "sent" }, { now: new Date("2024-03-02T15:00:00Z") })).toBe(true);
    const swept = await expireQuotes(t.db, tenantId, { now: NOW, onEvent: (e) => void events.push(e) });
    expect(swept).toMatchObject({ expired: 1, announced: 1 });
    expect(events.map((e) => [e.type, e.data.notify])).toEqual([["quote.expired", true]]);
  });

  it("a past quote still open when it is typed in expires later like any other (that day's news)", async () => {
    const tenantId = tenant();
    const events: EstimatorEvent[] = [];
    const made = await createEstimate(t.db, { tenantId, ...customer }, "u-sam", { now: NOW, occurredAt: "2026-10-10" });
    expect(await setEstimateStatus(t.db, tenantId, { id: made.id, status: "sent" }, { now: NOW, occurredAt: "2026-10-12" })).toBe(true);
    expect(await expireQuotes(t.db, tenantId, { now: NOW, onEvent: (e) => void events.push(e) })).toMatchObject({ expired: 0 });
    await expireQuotes(t.db, tenantId, { now: new Date("2026-11-20T15:00:00Z"), onEvent: (e) => void events.push(e) });
    expect(events.map((e) => e.type)).toEqual(["quote.expired"]);
  });
});

describe("a day is the company's day (review: '2025-06-14' was saved as UTC midnight, shown as the 13th in Denver)", () => {
  async function inZone(timeZone: string) {
    const tenantId = tenant();
    const settings = { ...(await getEstimatorSettings(t.db, tenantId)), timeZone };
    return { tenantId, settings };
  }
  const dayIn = (instant: Date | null | undefined, timeZone: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant!);

  it("America/Denver: the 14th stays the 14th, and its number is that year's", async () => {
    const { tenantId, settings } = await inZone("America/Denver");
    const made = await createEstimate(t.db, { tenantId, items: [], source: "staff" }, "u-sam", { now: NOW, settings, occurredAt: "2025-01-01" });
    expect(made.estimateNumber).toBe("EST-2025-0001");
    const row = (await getEstimateRow(t.db, tenantId, made.id))!;
    expect(dayIn(row.createdAt, "America/Denver")).toBe("2025-01-01");
    expect(await setEstimateStatus(t.db, tenantId, { id: made.id, status: "sent" }, { now: NOW, settings, occurredAt: "2025-06-14" })).toBe(true);
    expect(dayIn((await getEstimateRow(t.db, tenantId, made.id))!.sentAt, "America/Denver")).toBe("2025-06-14");
  });

  it("Asia/Tokyo: today's date typed in the morning is today there, not 'in the future'", async () => {
    const { tenantId, settings } = await inZone("Asia/Tokyo");
    // 08:30 in Tokyo on Oct 21 is still Oct 20 in UTC.
    const morning = new Date("2026-10-20T23:30:00Z");
    const made = await createEstimate(t.db, { tenantId, items: [], source: "staff" }, "u-sam", { now: morning, settings, occurredAt: "2026-10-21" });
    const row = (await getEstimateRow(t.db, tenantId, made.id))!;
    expect(dayIn(row.createdAt, "Asia/Tokyo")).toBe("2026-10-21");
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(morning.getTime());
    // NEGATIVE CONTROL: the same day in UTC is tomorrow, and refused.
    expect(await issuesOf(createEstimate(t.db, { tenantId: tenant(), items: [], source: "staff" }, "u-sam", { now: morning, occurredAt: "2026-10-21" }))).toEqual([
      { path: ["occurredAt"], message: "That date is in the future. Enter the day it really happened." },
    ]);
    // Tomorrow in Tokyo is still refused.
    expect((await issuesOf(createEstimate(t.db, { tenantId, items: [], source: "staff" }, "u-sam", { now: morning, settings, occurredAt: "2026-10-22" })))[0]?.message).toBe(
      "That date is in the future. Enter the day it really happened.",
    );
  });
});

describe("a past date needs its own permission (review: past dates rode on the ordinary keys)", () => {
  it("without estimator.history a dated estimate or status is refused; the same without a date goes through", async () => {
    const tenantId = tenant();
    const handlers = createEstimatorAdminHandlers({
      db: t.db,
      tenantId,
      authorize: (_req, permission) => (permission === "estimator.history" ? false : { userId: "u-sam" }),
      now: () => NOW,
    });
    const post = (path: string, body: unknown) => handlers.handle(request("POST", `${ADMIN_BASE}/v1/admin/${path}`, body));
    const dated = await post("estimates", { customerName: "Pat Lee", occurredAt: "2025-06-14" });
    expect(dated.status).toBe(403);
    expect((await readJson(dated)).error.message).toBe("Giving a past date needs the “Enter past records” permission. Leave the date out to record it as today, or ask the owner.");
    const count = await t.db.execute(sql`select count(*)::int as n from estimator_estimates where tenant_id = ${tenantId}`);
    expect(Number((count.rows[0] as { n: number }).n)).toBe(0);
    // NEGATIVE CONTROL: the same person makes it for today.
    const today = await post("estimates", { customerName: "Pat Lee" });
    expect(today.status).toBe(201);
    const id = (await readJson(today)).estimate.id;
    expect((await post(`estimates/${id}/status`, { status: "sent", occurredAt: "2026-10-20" })).status).toBe(403);
    expect((await getEstimateRow(t.db, tenantId, id))!.status).toBe("draft");
    expect(estimatorPermissions["estimator.history"].defaultFor).toEqual(["owner", "admin"]);
  });
});
