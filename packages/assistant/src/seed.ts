import { eq } from "drizzle-orm";
import type { AssistantDb } from "./brain.js";
import { assistantSections } from "./schema.js";

/**
 * The personality and the guardrails a fresh install boots with.
 *
 * The guardrail sections are Ben Anderson's year of tuning, distilled: each
 * rule below is one his commits added in reaction to a real bad answer, now
 * shipped as a default so a buyer inherits the scar tissue without the scars.
 * They seed `isCore` — an owner can edit them, but the editor flags the
 * weight, and publish refuses to strip the identity phrases.
 *
 * Idempotent: seeded on first read of an empty table, conflict-safe on key,
 * so installing needs a migration and nothing else — the same lazy-seed
 * contract the feedback board's columns keep.
 */
export const DEFAULT_SECTIONS = [
  {
    key: "core_personality",
    label: "Core personality",
    sortOrder: 10,
    isCore: true,
    requiredPhrases: ["assistant"],
    maxTokens: 500,
    content:
      "You are a helpful product assistant embedded in this application. You " +
      "answer questions about the product and the customer's own data, in " +
      "plain prose, briefly. When you do not know, say so and point to where " +
      "the answer would be — never invent one, and never stop at 'I don't know'.",
  },
  {
    key: "no_math",
    label: "No arithmetic",
    sortOrder: 20,
    isCore: true,
    requiredPhrases: [],
    maxTokens: 400,
    content:
      "Never compute a number. Quote figures exactly as a tool returned them, " +
      "with the label and period the tool gave. Do not add, subtract, average, " +
      "or compare magnitudes yourself — not even from numbers the user typed. " +
      "Speak in directions ('higher than last month') only when a tool " +
      "established the comparison. A number you calculate is untestable and " +
      "will eventually be wrong; a number a tool returned is not yours to " +
      "second-guess.",
  },
  {
    key: "data_sourcing",
    label: "Data sourcing",
    sortOrder: 30,
    isCore: true,
    requiredPhrases: [],
    maxTokens: 500,
    content:
      "Reach live data only through the tools provided. Prefer a value already " +
      "on the user's screen over fetching it again. Every value you cite must " +
      "carry the period or scope its tool reported. When a tool says it could " +
      "not honor a filter, say so plainly rather than presenting the wider " +
      "result as if it were the narrow one. When two sources disagree, do not " +
      "declare which is wrong — say where to look. Never name a specific record " +
      "as the cause of something unless a tool result shows it; offer " +
      "candidates, not verdicts.",
  },
  {
    key: "boundaries",
    label: "Refusal boundaries",
    sortOrder: 40,
    isCore: true,
    requiredPhrases: [],
    maxTokens: 400,
    content:
      "You do not give legal, tax, medical, or investment advice, and you do " +
      "not make commitments on the company's behalf — you cannot promise a " +
      "refund, waive a fee, or guarantee an outcome. For those, offer to " +
      "connect the person with a human. You never change records directly; any " +
      "change you help with is proposed for a person to confirm.",
  },
  {
    key: "internal_names",
    label: "Internal names stay internal",
    sortOrder: 50,
    isCore: true,
    requiredPhrases: [],
    maxTokens: 250,
    content:
      "Never expose internal identifiers, field names, or system keys in what " +
      "you say. Describe things the way a person on the page would name them, " +
      "not the way the database does.",
  },
] as const;

/**
 * Seed ONE company's guardrails (0.9.0): every company starts with its own
 * copy, and an edit to one company's never reaches another's.
 *
 * INSERT-IF-ABSENT, PER KEY. A company can have rows before its guardrails
 * (the owner wrote the business profile before anyone asked a question), so
 * "the company has rows" is not "the company is seeded": each default whose
 * key the company doesn't have yet is added. A section the owner turned off
 * is still a row, so it is never brought back. Race-safe: an insert that
 * meets the (company, key) unique index is skipped, not an error.
 */
export async function seedDefaultSections(db: AssistantDb, tenantId: string): Promise<number> {
  if (!tenantId) throw new Error("seedDefaultSections needs the company");
  const existing = (await db
    .select({ key: assistantSections.key })
    .from(assistantSections)
    .where(eq(assistantSections.tenantId, tenantId))) as Array<{ key: string }>;
  const have = new Set(existing.map((row) => row.key));
  let inserted = 0;
  for (const section of DEFAULT_SECTIONS) {
    if (have.has(section.key)) continue;
    const rows = await db
      .insert(assistantSections)
      .values({ ...section, tenantId, requiredPhrases: [...section.requiredPhrases] })
      .onConflictDoNothing({ target: [assistantSections.tenantId, assistantSections.key] })
      .returning({ id: assistantSections.id });
    inserted += rows.length;
  }
  return inserted;
}
