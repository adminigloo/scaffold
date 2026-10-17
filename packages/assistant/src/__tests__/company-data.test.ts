import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assemblePrompt, NO_MATH_FLOOR } from "../assemble.js";
import { createGlossaryTerm, createTenantRule, saveBusinessProfile, type AssistantDb } from "../brain.js";
import {
  appendMessage,
  confirmPendingAction,
  createConversation,
  createPendingAction,
  decidePendingAction,
  deleteUserData,
  faqKeyOf,
  normalizeQuestion,
  getConversation,
  getPendingAction,
  listConversations,
  listFaqs,
  listPageDocs,
  matchFaq,
  removeFaq,
  retrievePageDocs,
  saveFaq,
  sweepConversations,
  upsertPageDoc,
} from "../engine.js";
import { getEvalRunResults, listEvalRuns, recordEvalRun, createGolden, deactivateGolden, listGoldens } from "../evals.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * CONVERSATIONS, KNOWLEDGE AND PROPOSED CHANGES, PER COMPANY (0.9.0), on a
 * real Postgres. Every read names the company; another company's id is "not
 * found"; a proposed change is answered once, by the person it was offered
 * to; and what the model is sent for one company holds nothing of another's.
 */

let t: TestDb;
let db: AssistantDb;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => {
  await t.close();
});

const inFuture = () => new Date(Date.now() + 60_000);

describe("conversations and messages", () => {
  it("are the company's: another company's id finds nothing", async () => {
    const a = tenant();
    const b = tenant();
    const conv = await createConversation(db, { tenantId: a, userId: "ada", title: "Mowing" });
    await appendMessage(db, { tenantId: a, conversationId: conv.id, role: "user", blocks: [{ kind: "text", text: "Alpha secret question" }] });
    await appendMessage(db, { tenantId: a, conversationId: conv.id, role: "assistant", blocks: [{ kind: "text", text: "Alpha answer" }] });

    const mine = await getConversation(db, a, conv.id);
    expect(mine?.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(mine?.messages.every((m) => m.tenantId === a)).toBe(true);
    expect(await getConversation(db, b, conv.id)).toBeNull();
    expect(await listConversations(db, b)).toEqual([]);
    expect((await listConversations(db, a, { userId: "ada" })).map((c) => c.id)).toEqual([conv.id]);
    expect(await listConversations(db, a, { userId: "someone-else" })).toEqual([]);

    // A message appended under the wrong company can't attach to A's thread.
    await expect(
      appendMessage(db, { tenantId: b, conversationId: conv.id, role: "user", blocks: [{ kind: "text", text: "stray" }] }),
    ).rejects.toThrow(/isn't this company's/);
    expect((await getConversation(db, a, conv.id))?.messages).toHaveLength(2);
  });

  it("are swept and erased one company at a time", async () => {
    const a = tenant();
    const b = tenant();
    const ca = await createConversation(db, { tenantId: a, userId: "u" });
    const cb = await createConversation(db, { tenantId: b, userId: "u" });
    await appendMessage(db, { tenantId: a, conversationId: ca.id, role: "user", blocks: [] });
    await appendMessage(db, { tenantId: b, conversationId: cb.id, role: "user", blocks: [] });
    expect(await deleteUserData(db, { tenantId: a, userId: "u" })).toEqual({ conversations: 1, messages: 1 });
    expect(await getConversation(db, b, cb.id)).not.toBeNull();
    expect(await sweepConversations(db, { olderThan: new Date(Date.now() + 60_000), tenantId: b })).toEqual({ conversations: 1, messages: 1 });
  });
});

describe("FAQs and knowledge", () => {
  it("keeps each company's answers to itself, matches a question word for word, and finds by keyword", async () => {
    const a = tenant();
    const b = tenant();
    const saved = await saveFaq(db, a, { question: "Do you work on Sundays?", answer: "No — Monday to Saturday only." }, "owner");
    if (!saved.saved) throw new Error("not saved");
    // The same question again updates the one answer.
    const again = await saveFaq(db, a, { question: "do you work on sundays", answer: "No, never on Sundays." });
    if (!again.saved) throw new Error("not saved");
    expect(again.faq.id).toBe(saved.faq.id);
    expect((await listFaqs(db, a)).map((f) => f.answer)).toEqual(["No, never on Sundays."]);
    expect(await listFaqs(db, b)).toEqual([]);

    expect((await matchFaq(db, a, "Do you work on Sundays?!"))?.answer).toBe("No, never on Sundays.");
    expect(await matchFaq(db, b, "Do you work on Sundays?")).toBeNull();
    expect(await matchFaq(db, a, "Do you work on Sundays in summer?")).toBeNull();

    await upsertPageDoc(db, { tenantId: a, pageKey: "/app/invoices", title: "Invoices", body: "Send an invoice from the ledger; overdue ones turn red." });
    const found = await retrievePageDocs(db, { tenantId: a, queryText: "how do overdue invoices look" });
    expect(found.map((d) => d.title)).toContain("Invoices");
    expect(await retrievePageDocs(db, { tenantId: b, queryText: "how do overdue invoices look" })).toEqual([]);
    // A question of only stop words matches nothing, without an error.
    expect(await retrievePageDocs(db, { tenantId: a, queryText: "what is it?" })).toEqual([]);

    expect(await saveFaq(db, b, { id: saved.faq.id, question: "Hijack?", answer: "Yes." })).toEqual({ saved: false, reason: "not_found" });
    expect(await removeFaq(db, b, saved.faq.id)).toBe(false);
    expect(await removeFaq(db, a, saved.faq.id)).toBe(true);
    expect(await matchFaq(db, a, "Do you work on Sundays?")).toBeNull();
    expect((await listPageDocs(db, a, { kind: "faq" }))[0]?.isActive).toBe(false);
  });
});

describe("FAQs in any language (review L10)", () => {
  it("keeps two Chinese questions apart, matches each, and never makes an empty key", async () => {
    const a = tenant();
    await saveFaq(db, a, { question: "周日营业吗？", answer: "周日不营业。" });
    await saveFaq(db, a, { question: "可以开发票吗？", answer: "可以。" });
    expect((await listFaqs(db, a)).map((f) => f.answer).sort()).toEqual(["可以。", "周日不营业。"]);
    expect((await matchFaq(db, a, "周日营业吗"))?.answer).toBe("周日不营业。");
    expect((await matchFaq(db, a, "可以开发票吗"))?.answer).toBe("可以。");
    expect(normalizeQuestion("¿Abren el DOMINGO?")).toBe("abren el domingo");
    expect(faqKeyOf("???")).toMatch(/^faq:#[0-9a-f]{32}$/);
    expect(faqKeyOf("?!")).not.toBe(faqKeyOf("??"));
  });
});

describe("proposed changes: answered once, by the person they were offered to", () => {
  async function proposal(tenantId: string, createdBy = "ada", expiresAt = inFuture()) {
    const conv = await createConversation(db, { tenantId, userId: createdBy });
    return createPendingAction(db, {
      tenantId,
      conversationId: conv.id,
      toolName: "save_faq",
      params: { question: "Q?", answer: "A." },
      summary: "Save the answer to “Q?”",
      idempotencyKey: crypto.randomUUID(),
      expiresAt,
      createdBy,
    });
  }

  it("a double-clicked “Yes, do it” acts once", async () => {
    const a = tenant();
    const action = await proposal(a);
    const clicks = await Promise.all([
      decidePendingAction(db, { tenantId: a, id: action.id, userId: "ada", decision: "confirm" }),
      decidePendingAction(db, { tenantId: a, id: action.id, userId: "ada", decision: "confirm" }),
      decidePendingAction(db, { tenantId: a, id: action.id, userId: "ada", decision: "confirm" }),
    ]);
    expect(clicks.filter((c) => c.decided)).toHaveLength(1);
    expect(clicks.filter((c) => !c.decided && c.reason === "not_pending")).toHaveLength(2);
    expect((await getPendingAction(db, a, action.id))?.status).toBe("confirmed");
  });

  it("is not found for another company, and for another person in the same company", async () => {
    const a = tenant();
    const b = tenant();
    const action = await proposal(a);
    expect(await decidePendingAction(db, { tenantId: b, id: action.id, userId: "ada", decision: "confirm" })).toMatchObject({
      decided: false,
      reason: "not_found",
    });
    expect(await decidePendingAction(db, { tenantId: a, id: action.id, userId: "arlo", decision: "confirm" })).toMatchObject({
      decided: false,
      reason: "not_found",
    });
    expect(await getPendingAction(db, b, action.id)).toBeNull();
    expect(await confirmPendingAction(db, b, action.id)).toEqual({ confirmed: false, reason: "not_found" });
    expect((await getPendingAction(db, a, action.id))?.status).toBe("pending");
  });

  it("can't be answered after it runs out, and says so", async () => {
    const a = tenant();
    const action = await proposal(a, "ada", new Date(Date.now() - 1_000));
    expect(await decidePendingAction(db, { tenantId: a, id: action.id, userId: "ada", decision: "confirm" })).toMatchObject({
      decided: false,
      reason: "expired",
    });
    expect((await getPendingAction(db, a, action.id))?.status).toBe("expired");
  });

  it("“No” is final too", async () => {
    const a = tenant();
    const action = await proposal(a);
    expect((await decidePendingAction(db, { tenantId: a, id: action.id, userId: "ada", decision: "decline" })).decided).toBe(true);
    expect(await decidePendingAction(db, { tenantId: a, id: action.id, userId: "ada", decision: "confirm" })).toMatchObject({
      reason: "not_pending",
    });
  });
});

describe("what the model is sent, for one company", () => {
  it("holds that company's profile, rules, words and knowledge — and the no-math floor — and nothing of another's", async () => {
    const a = tenant();
    const b = tenant();
    await saveBusinessProfile(db, a, { content: "Alpha Lawn Care, Boise." });
    await createTenantRule(db, { tenantId: a, label: "Sundays", instruction: "Alpha never works Sundays." });
    await createGlossaryTerm(db, a, { termKey: "the_yard", preferred: "the yard", definition: "Alpha's depot on 5th." });
    await saveFaq(db, a, { question: "Where is the yard?", answer: "Alpha's yard is on 5th Street." });
    await saveBusinessProfile(db, b, { content: "Bravo Roofing, Reno." });

    const forA = await assemblePrompt(db, { tenantId: a, turnText: "where is the yard" });
    expect(forA.system).toContain("Alpha Lawn Care, Boise.");
    expect(forA.system.endsWith(NO_MATH_FLOOR)).toBe(true);
    expect(forA.system).toMatch(/Never compute a number/);
    const contextA = forA.contextBlocks.join("\n");
    expect(contextA).toContain("Alpha never works Sundays.");
    expect(contextA).toContain("Alpha's depot on 5th.");
    expect(contextA).toContain("Alpha's yard is on 5th Street.");

    const forB = await assemblePrompt(db, { tenantId: b, turnText: "where is the yard" });
    const all = `${forB.system}\n${forB.contextBlocks.join("\n")}`;
    expect(all).toContain("Bravo Roofing, Reno.");
    expect(all).not.toMatch(/Alpha/);
    // The glossary rides only when the turn uses the word.
    const unrelated = await assemblePrompt(db, { tenantId: a, turnText: "what's the weather" });
    expect(unrelated.contextBlocks.join("\n")).not.toContain("depot");
    // The cacheable prefix is the same for every turn in a company.
    expect(unrelated.system).toBe(forA.system);
  });
});

describe("evals, per company", () => {
  it("lists, retires and reads results only inside the company", async () => {
    const a = tenant();
    const b = tenant();
    const golden = await createGolden(db, { tenantId: a, question: "Q?", mustInclude: ["x"] });
    expect(await deactivateGolden(db, b, golden.id)).toBe(false);
    expect(await listGoldens(db, a, true)).toHaveLength(1);
    const run = await recordEvalRun(db, {
      tenantId: a,
      results: [{ goldenId: golden.id, question: "Q?", answer: "x", score: { passed: true, missing: [], forbidden: [] } }],
    });
    expect(await getEvalRunResults(db, a, run.id)).toHaveLength(1);
    expect(await getEvalRunResults(db, b, run.id)).toEqual([]);
    expect(await listEvalRuns(db, b)).toEqual([]);
  });
});
