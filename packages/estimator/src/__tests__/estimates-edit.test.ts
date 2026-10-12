import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { listComponents, listProducts, updateComponent } from "../catalog.js";
import {
  addEstimateItem,
  archiveEstimate,
  createEstimate,
  createPublicEstimate,
  duplicateEstimate,
  getEstimate,
  getEstimateDetail,
  removeEstimateItem,
  searchEstimates,
  setEstimateStatus,
  staffActionsFor,
  unarchiveEstimate,
  updateEstimate,
  updateEstimateItem,
} from "../estimates.js";
import { sendQuote } from "../quotes.js";
import { loadSampleCatalog } from "../sample.js";
import { updateEstimatorSettings } from "../settings.js";
import { estimatorEstimateItems, estimatorEstimates } from "../schema.js";
import { EstimatorInputError } from "../types.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/** Staff estimates (6.6): create, edit in one transaction each, search the queue. */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function sample() {
  const tenantId = tenant();
  await loadSampleCatalog(t.db, tenantId, { showInEstimator: true });
  await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit Ramps", taxRateBp: 825 });
  const products = await listProducts(t.db, tenantId);
  const id = (name: string) => products.find((p) => p.name === name)!.id;
  return { tenantId, id };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EstimatorInputError) return error.code;
    throw error;
  }
  throw new Error("expected an EstimatorInputError");
}

/** The first statement inside the edit's transaction locks the estimate, tenant-scoped. */
function lockedFirst(): void {
  const inTx = t.queries.filter((q) => q.inTransaction);
  expect(inTx[0]!.sql).toMatch(/^select .* from "estimator_estimates" where \("estimator_estimates"\."id" = \$1 and "estimator_estimates"\."tenant_id" = \$2\) for update$/);
}

describe("creating staff estimates", () => {
  it("prices a line from inputs, starts a blank draft, refuses a free line with no description", async () => {
    const { tenantId, id } = await sample();
    const created = await createEstimate(t.db, { tenantId, taxRateBp: 725, items: [{ productId: id("Modular aluminum ramp"), inputs: { steps: 3 } }] });
    expect(created).toMatchObject({ subtotal: 692_146, rangeLow: 647_262, rangeHigh: 714_588 }); // priced in the middle, 23 ft (EST-R05); posts whole (EST-R09)
    const found = await getEstimate(t.db, tenantId, created.id);
    expect(found?.estimate).toMatchObject({ source: "staff", status: "draft", currency: "USD", rangeReasons: ["Step height 7–8 in (estimated)"] });
    expect(found?.estimate.cost).toEqual(expect.any(Number));
    expect(found?.items[0]).toMatchObject({ description: "Modular aluminum ramp", recipe: "ramp_over_steps", priceOverridden: false, lowTotal: 647_262, highTotal: 714_588 });
    const blank = await createEstimate(t.db, { tenantId, items: [] });
    expect(blank.subtotal).toBe(0);
    await expect(createEstimate(t.db, { tenantId, items: [{ unitPrice: 100 }] })).rejects.toBeInstanceOf(ZodError);
    expect(await getEstimate(t.db, tenant(), created.id)).toBeNull();
  });
});

describe("editing a draft: one transaction each, the estimate locked first", () => {
  it("re-prices a line on a patch; a staff price and back to the price book; free lines; totals", async () => {
    const { tenantId, id } = await sample();
    const created = await createEstimate(t.db, { tenantId, taxRateBp: 725, items: [{ productId: id("Modular aluminum ramp"), inputs: { steps: 4 } }] });
    const [line] = (await getEstimate(t.db, tenantId, created.id))!.items;

    t.queries.length = 0;
    const measured = await updateEstimateItem(t.db, tenantId, created.id, line!.id, { inputs: { steps: 4, stepHeightIn: 7.25 } });
    lockedFirst();
    expect(measured).toMatchObject({ total: 838_558, lowTotal: 838_558, highTotal: 838_558, inputs: { steps: 4, stepHeightIn: 7.25, totalRiseIn: null } });

    t.queries.length = 0;
    await addEstimateItem(t.db, tenantId, created.id, { description: "Remove old wooden steps", unitPrice: 15_000 });
    lockedFirst();
    let estimate = (await getEstimate(t.db, tenantId, created.id))!.estimate;
    expect(estimate).toMatchObject({ subtotal: 853_558, taxAmount: 61_883, total: 915_441, rangeLow: 853_558, rangeHigh: 853_558, rangeReasons: [] });

    // Staff set the price, then hand it back to the price book.
    const overridden = await updateEstimateItem(t.db, tenantId, created.id, line!.id, { unitPrice: 800_000 });
    expect(overridden).toMatchObject({ total: 800_000, priceOverridden: true, cost: expect.any(Number) });
    const back = await updateEstimateItem(t.db, tenantId, created.id, line!.id, { unitPrice: null });
    expect(back).toMatchObject({ total: 838_558, priceOverridden: false });
    // A note alone doesn't re-price.
    const noted = await updateEstimateItem(t.db, tenantId, created.id, line!.id, { notes: "Gate on the left" });
    expect(noted).toMatchObject({ total: 838_558, notes: "Gate on the left" });

    const extra = await addEstimateItem(t.db, tenantId, created.id, { productId: id("Threshold ramp"), inputs: { count: 2 } });
    expect(extra).toMatchObject({ quantity: 2, description: "Threshold ramp" });
    t.queries.length = 0;
    expect(await removeEstimateItem(t.db, tenantId, created.id, extra!.id)).toBe(true);
    lockedFirst();
    estimate = (await getEstimate(t.db, tenantId, created.id))!.estimate;
    expect(estimate.subtotal).toBe(853_558);

    // Another tenant reaches nothing.
    expect(await updateEstimateItem(t.db, tenant(), created.id, line!.id, { notes: "x" })).toBeNull();
    expect(await removeEstimateItem(t.db, tenant(), created.id, line!.id)).toBe(false);
  });

  it("the discount guard rolls the edit back; the header changes in one transaction", async () => {
    const { tenantId } = await sample();
    const created = await createEstimate(t.db, { tenantId, items: [{ description: "Work", unitPrice: 10_000 }] });
    expect(await refusal(updateEstimate(t.db, tenantId, created.id, { discount: 20_000, customerName: "Pat" }))).toBe("discount_exceeds_subtotal");
    const row = (await getEstimate(t.db, tenantId, created.id))!.estimate;
    expect(row).toMatchObject({ discount: 0, customerName: null });
    t.queries.length = 0;
    const updated = await updateEstimate(t.db, tenantId, created.id, { discount: 1_000, taxRateBp: 0, customerName: "Pat Lee", customerEmail: "pat@example.test" });
    lockedFirst();
    expect(updated).toMatchObject({ subtotal: 10_000, discount: 1_000, taxAmount: 0, total: 9_000, customerName: "Pat Lee" });
    expect(await updateEstimate(t.db, tenant(), created.id, { customerName: "X" })).toBeNull();
  });

  it("only a draft changes — except the internal notes", async () => {
    const { tenantId } = await sample();
    const created = await createEstimate(t.db, { tenantId, items: [{ description: "Work", unitPrice: 10_000 }] });
    const [line] = (await getEstimate(t.db, tenantId, created.id))!.items;
    for (const status of ["sent", "viewed", "approved"] as const) {
      expect(await setEstimateStatus(t.db, tenantId, { id: created.id, status })).toBe(true);
      expect(await refusal(updateEstimate(t.db, tenantId, created.id, { customerName: "X" }))).toBe("not_changeable");
      expect(await refusal(addEstimateItem(t.db, tenantId, created.id, { description: "More", unitPrice: 1 }))).toBe("not_changeable");
      expect(await refusal(updateEstimateItem(t.db, tenantId, created.id, line!.id, { unitPrice: 1 }))).toBe("not_changeable");
      expect(await refusal(removeEstimateItem(t.db, tenantId, created.id, line!.id))).toBe("not_changeable");
      expect((await updateEstimate(t.db, tenantId, created.id, { internalNotes: `noted while ${status}` }))?.internalNotes).toBe(`noted while ${status}`);
    }
  });

  it("at most 100 lines", async () => {
    const { tenantId } = await sample();
    const created = await createEstimate(t.db, { tenantId, items: Array.from({ length: 100 }, (_, i) => ({ description: `Line ${i}`, unitPrice: 1 })) });
    await expect(addEstimateItem(t.db, tenantId, created.id, { description: "One too many", unitPrice: 1 })).rejects.toBeInstanceOf(ZodError);
  });
});

describe("duplicate, archive", () => {
  it("a duplicate is a fresh staff draft, re-priced NOW from the price book", async () => {
    const { tenantId, id } = await sample();
    const original = await createEstimate(t.db, {
      tenantId,
      customerName: "Pat Lee",
      customerEmail: "pat@example.test",
      items: [
        { productId: id("Modular aluminum ramp"), inputs: { steps: 3, stepHeightIn: 7.5 } },
        { description: "Haul away", unitPrice: 5_000 },
      ],
    });
    await setEstimateStatus(t.db, tenantId, { id: original.id, status: "sent" });
    const section = (await listComponents(t.db, tenantId)).find((c) => c.name === "Aluminum ramp section")!;
    await updateComponent(t.db, tenantId, section.id, { unitCost: 10_000 });
    const copy = (await duplicateEstimate(t.db, tenantId, original.id, "member-1"))!;
    const found = (await getEstimate(t.db, tenantId, copy.id))!;
    expect(found.estimate).toMatchObject({ status: "draft", source: "staff", customerName: "Pat Lee", sentAt: null, quoteSequence: 0, createdBy: "member-1" });
    expect(found.items.map((i) => i.description)).toEqual(["Modular aluminum ramp", "Haul away"]);
    expect(found.items[0]!.total).toBeGreaterThan(692_367); // the new supply price
    expect(found.items[1]!.total).toBe(5_000);
    expect(copy.estimateNumber).not.toBe(original.estimateNumber);
    expect(await duplicateEstimate(t.db, tenant(), original.id)).toBeNull();

    // A "quote requested" line is still unpriced in the copy: sending asks for its price.
    const lead = await createPublicEstimate(
      t.db,
      { customerName: "Sam", customerEmail: "sam@x.test", items: [{ productId: id("Something else") }] },
      { tenantId },
    );
    const leadCopy = (await duplicateEstimate(t.db, tenantId, lead.id))!;
    expect(await refusal(sendQuote(t.db, tenantId, leadCopy.id, {}))).toBe("unpriced_lines");
  });

  it("archive hides an estimate from the queue (any status); unarchive brings it back", async () => {
    const { tenantId } = await sample();
    const created = await createEstimate(t.db, { tenantId, items: [] });
    expect(await archiveEstimate(t.db, tenant(), created.id)).toBe(false);
    expect(await archiveEstimate(t.db, tenantId, created.id)).toBe(true);
    expect((await searchEstimates(t.db, tenantId)).rows).toHaveLength(0);
    expect((await searchEstimates(t.db, tenantId, { filter: "archived" })).rows).toHaveLength(1);
    expect(staffActionsFor((await getEstimate(t.db, tenantId, created.id))!.estimate)).toContain("unarchive");
    expect(await unarchiveEstimate(t.db, tenantId, created.id)).toBe(true);
    expect((await searchEstimates(t.db, tenantId)).rows).toHaveLength(1);
  });
});

describe("the queue: searchEstimates", () => {
  it("filters, search, counts, and a cursor across 120 rows, newest first", async () => {
    const tenantId = tenant("queue");
    const base = new Date("2026-11-02T15:00:00Z").getTime();
    const ids: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      // Pairs share an instant: the id breaks the tie.
      const created = await createEstimate(
        t.db,
        { tenantId, customerName: i === 7 ? "Pat Lee" : `Customer ${i}`, customerPhone: i === 8 ? "(801) 555-0199" : null, items: [] },
        undefined,
        { now: new Date(base + Math.floor(i / 2) * 1000) },
      );
      ids.push(created.id);
    }
    // A few leads, a sent quote, an accepted one, an archived one.
    await t.db.update(estimatorEstimates).set({ source: "public_tool" }).where(eq(estimatorEstimates.id, ids[0]!));
    await t.db.update(estimatorEstimates).set({ source: "photo" }).where(eq(estimatorEstimates.id, ids[1]!));
    await setEstimateStatus(t.db, tenantId, { id: ids[2]!, status: "sent" });
    await setEstimateStatus(t.db, tenantId, { id: ids[3]!, status: "sent" });
    await setEstimateStatus(t.db, tenantId, { id: ids[3]!, status: "approved" });
    await archiveEstimate(t.db, tenantId, ids[4]!);

    const pages: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof searchEstimates>> = await searchEstimates(t.db, tenantId, { limit: 50, cursor });
      pages.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(pages).toHaveLength(119); // the archived one is left out
    expect(new Set(pages).size).toBe(119);
    const rows = await t.db.select().from(estimatorEstimates).where(eq(estimatorEstimates.tenantId, tenantId));
    const expected = rows
      .filter((r) => r.archivedAt === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      .map((r) => r.id);
    expect(pages).toEqual(expected);

    const result = await searchEstimates(t.db, tenantId, { filter: "leads" });
    expect(result.rows.map((r) => r.id).sort()).toEqual([ids[0], ids[1]].sort());
    expect(result.counts).toEqual({ all: 119, leads: 2, drafts: 115, sent: 1, accepted: 1, declined: 0, expired: 0, converted: 0, archived: 1 });
    expect((await searchEstimates(t.db, tenantId, { q: "pat" })).rows.map((r) => r.customerName)).toEqual(["Pat Lee"]);
    expect((await searchEstimates(t.db, tenantId, { q: "555-0199" })).rows).toHaveLength(1);
    expect((await searchEstimates(t.db, tenantId, { q: "100%" })).rows).toHaveLength(0); // LIKE wildcards are literal
    expect((await searchEstimates(t.db, tenantId, { source: "photo" })).rows.map((r) => r.id)).toEqual([ids[1]]);
    expect((await searchEstimates(t.db, tenant(), {})).rows).toHaveLength(0);
  });

  it("the staff detail: lines, actions and a timeline; costs only when allowed", async () => {
    const { tenantId, id } = await sample();
    const created = await createEstimate(t.db, { tenantId, items: [{ productId: id("Modular aluminum ramp"), inputs: { steps: 3 } }] });
    const detail = (await getEstimateDetail(t.db, tenantId, created.id))!;
    expect(detail.lines[0]).toMatchObject({ recipe: "ramp_over_steps", inputsSummary: "3 steps", reasons: ["Step height 7–8 in (estimated)"], cost: null });
    expect(detail.cost).toBeNull();
    expect(detail.actions).toEqual(["edit", "send", "duplicate", "archive"]);
    expect(detail.timeline.map((e) => e.label)).toEqual(["Created"]);
    const withCosts = (await getEstimateDetail(t.db, tenantId, created.id, { includeCosts: true }))!;
    expect(withCosts.cost).toEqual(expect.any(Number));
    expect(withCosts.marginBp).toEqual(expect.any(Number));
    const [item] = await t.db.select().from(estimatorEstimateItems).where(eq(estimatorEstimateItems.estimateId, created.id));
    expect(withCosts.lines[0]!.cost).toBe(item!.cost);
  });
});
