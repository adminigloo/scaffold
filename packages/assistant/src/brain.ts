import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  assistantChangeLog,
  assistantConfigVersion,
  assistantGlossary,
  assistantSectionVersions,
  assistantSections,
  assistantTenantRules,
} from "./schema.js";
import { withinBudget } from "./tokens.js";

/**
 * The editable brain: sections (the personality), house rules (the per-company
 * overlay), the glossary, and the change log that records every edit.
 *
 * 0.9.0 — EVERY FUNCTION TAKES THE COMPANY, and every query filters by it.
 * A section id, a rule id or a term id from another company is "unknown"
 * here, exactly as if it didn't exist: there is no path that reads or writes
 * another company's brain by guessing an id. The site's own assistant is
 * `ASSISTANT_PLATFORM` ("*").
 */

/** The loosest handle that runs these queries — driver, transaction, or test double. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AssistantDb = PgDatabase<any, any, any>;

/** Machine keys: lowercase, referenced as plain text, so no spaces or caps. */
export const sectionKeySchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z][a-z0-9_]*$/, "lowercase letters, digits and underscores");

/** A company id as the brain takes it: never empty (an empty id is a broken caller, not a company). */
const tenantIdSchema = z.string().min(1).max(200);

function company(tenantId: string): string {
  return tenantIdSchema.parse(tenantId);
}

/**
 * A unique-index violation (Postgres 23505), whether the driver's own error or
 * drizzle's "Failed query" wrapper around it (`cause`). Checking only the top
 * error missed every raced publish under drizzle 0.45, which wraps.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let at: unknown = error, depth = 0; at && depth < 4; depth += 1) {
    if ((at as { code?: unknown }).code === "23505") return true;
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

export interface SectionRow {
  id: string;
  key: string;
  label: string;
  description: string | null;
  content: string;
  sortOrder: number;
  isCore: boolean;
  requiredPhrases: string[];
  maxTokens: number;
  isActive: boolean;
}

const SECTION_COLUMNS = {
  id: assistantSections.id,
  key: assistantSections.key,
  label: assistantSections.label,
  description: assistantSections.description,
  content: assistantSections.content,
  sortOrder: assistantSections.sortOrder,
  isCore: assistantSections.isCore,
  requiredPhrases: assistantSections.requiredPhrases,
  maxTokens: assistantSections.maxTokens,
  isActive: assistantSections.isActive,
} as const;

/** Bump the company's counter so a per-request assembly read can see its config moved. */
async function bumpConfigVersion(db: AssistantDb, tenantId: string): Promise<void> {
  await db
    .insert(assistantConfigVersion)
    .values({ id: tenantId, version: 1 })
    .onConflictDoUpdate({
      target: assistantConfigVersion.id,
      set: {
        version: sql`${assistantConfigVersion.version} + 1`,
        updatedAt: new Date(),
      },
    });
}

/** One change-log line, always with the company. */
async function logChange(
  db: AssistantDb,
  tenantId: string,
  entry: Omit<typeof assistantChangeLog.$inferInsert, "id" | "tenantId" | "createdAt">,
): Promise<void> {
  await db.insert(assistantChangeLog).values({ ...entry, tenantId });
}

export interface EditorSectionRow extends SectionRow {
  /** The current head version, so the editor knows the publish base without a per-card query. */
  headVersion: number;
}

/**
 * A company's active sections plus each one's head version, for the editor —
 * one query with a correlated subquery instead of one per card.
 */
export async function listSectionsForEditor(db: AssistantDb, tenantId: string): Promise<EditorSectionRow[]> {
  const t = company(tenantId);
  const headSub = db
    .select({ v: sql<number>`max(${assistantSectionVersions.versionNumber})` })
    .from(assistantSectionVersions)
    .where(eq(assistantSectionVersions.sectionId, assistantSections.id));
  return db
    .select({ ...SECTION_COLUMNS, headVersion: sql<number>`coalesce((${headSub}), 0)` })
    .from(assistantSections)
    .where(and(eq(assistantSections.tenantId, t), eq(assistantSections.isActive, true)))
    .orderBy(asc(assistantSections.sortOrder), asc(assistantSections.key));
}

/** A company's active sections, in assembly order. */
export async function listSections(db: AssistantDb, tenantId: string): Promise<SectionRow[]> {
  const t = company(tenantId);
  return db
    .select(SECTION_COLUMNS)
    .from(assistantSections)
    .where(and(eq(assistantSections.tenantId, t), eq(assistantSections.isActive, true)))
    .orderBy(asc(assistantSections.sortOrder), asc(assistantSections.key));
}

/** One of a company's sections by its key (active or not), or null. */
export async function getSectionByKey(db: AssistantDb, tenantId: string, key: string): Promise<SectionRow | null> {
  const t = company(tenantId);
  const [row] = await db
    .select(SECTION_COLUMNS)
    .from(assistantSections)
    .where(and(eq(assistantSections.tenantId, t), eq(assistantSections.key, key)))
    .limit(1);
  return (row as SectionRow | undefined) ?? null;
}

export const createSectionSchema = z.object({
  key: sectionKeySchema,
  label: z.string().min(1).max(80),
  description: z.string().max(500).nullish(),
  content: z.string().min(1).max(20000),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  isCore: z.boolean().optional(),
  requiredPhrases: z.array(z.string().min(1).max(200)).max(20).optional(),
  maxTokens: z.number().int().min(50).max(8000).optional(),
});

export type CreateSectionInput = z.infer<typeof createSectionSchema>;

export class SectionBudgetError extends Error {
  readonly name = "SectionBudgetError";
  constructor(readonly maxTokens: number) {
    super(`content exceeds the section's ${maxTokens}-token budget`);
  }
}

export async function createSection(
  db: AssistantDb,
  tenantId: string,
  input: CreateSectionInput,
  actor?: string,
): Promise<SectionRow> {
  const t = company(tenantId);
  const parsed = createSectionSchema.parse(input);
  const maxTokens = parsed.maxTokens ?? 600;
  // Enforced here, not merely metered in the UI — Ask Lou's maxTokens lied.
  if (!withinBudget(parsed.content, maxTokens)) throw new SectionBudgetError(maxTokens);

  const sortOrder =
    parsed.sortOrder ??
    (await db
      .select({ sortOrder: assistantSections.sortOrder })
      .from(assistantSections)
      .where(eq(assistantSections.tenantId, t))
      .orderBy(desc(assistantSections.sortOrder))
      .limit(1)
      .then((rows: Array<{ sortOrder: number }>) => (rows[0]?.sortOrder ?? 0) + 10));

  const rows = await db
    .insert(assistantSections)
    .values({
      tenantId: t,
      key: parsed.key,
      label: parsed.label,
      description: parsed.description ?? null,
      content: parsed.content,
      sortOrder,
      isCore: parsed.isCore ?? false,
      requiredPhrases: parsed.requiredPhrases ?? [],
      maxTokens,
    })
    .returning(SECTION_COLUMNS);
  const row = rows[0];
  if (!row) throw new Error("section insert returned no row");

  await logChange(db, t, {
    entityType: "section",
    entityId: row.id,
    entityKey: row.key,
    action: "created",
    performedBy: actor ?? null,
  });
  await bumpConfigVersion(db, t);
  return row;
}

/**
 * Publish an edit to a section's content — the versioned, concurrency-guarded
 * write. `baseVersion` is the version the editor last saw; if the live head
 * has moved past it, this rejects rather than silently overwriting a
 * colleague's publish. KEY and requiredPhrases are not editable here.
 */
export const publishSectionSchema = z.object({
  sectionId: z.string(),
  baseVersion: z.number().int().min(0),
  content: z.string().min(1).max(20000),
  label: z.string().min(1).max(80).optional(),
  changeSummary: z.string().max(500).optional(),
});

export type PublishResult =
  | { published: true; versionNumber: number }
  | { published: false; reason: "conflict"; headVersion: number }
  | { published: false; reason: "unknown" }
  | { published: false; reason: "budget"; maxTokens: number }
  | { published: false; reason: "missing_phrase"; phrase: string };

async function headVersionOf(db: AssistantDb, sectionId: string): Promise<number> {
  const [head] = await db
    .select({ versionNumber: assistantSectionVersions.versionNumber })
    .from(assistantSectionVersions)
    .where(eq(assistantSectionVersions.sectionId, sectionId))
    .orderBy(desc(assistantSectionVersions.versionNumber))
    .limit(1);
  return head?.versionNumber ?? 0;
}

/** The section, only if it is this company's. */
async function sectionOf(db: AssistantDb, tenantId: string, sectionId: string): Promise<SectionRow | null> {
  const [section] = await db
    .select(SECTION_COLUMNS)
    .from(assistantSections)
    .where(and(eq(assistantSections.tenantId, tenantId), eq(assistantSections.id, sectionId)))
    .limit(1);
  return (section as SectionRow | undefined) ?? null;
}

export async function publishSection(
  db: AssistantDb,
  tenantId: string,
  input: z.infer<typeof publishSectionSchema>,
  actor?: string,
): Promise<PublishResult> {
  const t = company(tenantId);
  const parsed = publishSectionSchema.parse(input);

  const section = await sectionOf(db, t, parsed.sectionId);
  if (!section) return { published: false, reason: "unknown" };

  if (!withinBudget(parsed.content, section.maxTokens)) {
    return { published: false, reason: "budget", maxTokens: section.maxTokens };
  }
  // The guardrail: a required phrase deleted out of the content is refused,
  // so a bad edit can't ship a bot that forgot its own name.
  for (const phrase of section.requiredPhrases) {
    if (!parsed.content.includes(phrase)) {
      return { published: false, reason: "missing_phrase", phrase };
    }
  }

  const headVersion = await headVersionOf(db, parsed.sectionId);
  if (headVersion !== parsed.baseVersion) {
    return { published: false, reason: "conflict", headVersion };
  }

  const nextVersion = headVersion + 1;
  // Four writes as one transaction; the unique index on (sectionId,
  // versionNumber) is the real arbiter of two publishes at the same base, and
  // the loser's 23505 becomes the `conflict` the type promises.
  try {
    await db.transaction(async (tx: AssistantDb) => {
      await tx.insert(assistantSectionVersions).values({
        sectionId: parsed.sectionId,
        versionNumber: nextVersion,
        content: parsed.content,
        changeSummary: parsed.changeSummary ?? null,
        createdBy: actor ?? null,
      });
      await tx
        .update(assistantSections)
        .set({ content: parsed.content, ...(parsed.label ? { label: parsed.label } : {}) })
        .where(and(eq(assistantSections.tenantId, t), eq(assistantSections.id, parsed.sectionId)));
      await logChange(tx, t, {
        entityType: "section",
        entityId: parsed.sectionId,
        entityKey: section.key,
        action: "published",
        sectionId: parsed.sectionId,
        versionNumber: nextVersion,
        changeSummary: parsed.changeSummary ?? null,
        performedBy: actor ?? null,
      });
      await bumpConfigVersion(tx, t);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { published: false, reason: "conflict", headVersion: await headVersionOf(db, parsed.sectionId) };
    }
    throw error;
  }
  return { published: true, versionNumber: nextVersion };
}

/**
 * Roll a section back to a prior version's content — itself a publish, so it
 * runs the SAME budget and required-phrase checks and lands as a new version.
 */
export async function rollbackSection(
  db: AssistantDb,
  tenantId: string,
  input: { sectionId: string; toVersion: number },
  actor?: string,
): Promise<PublishResult> {
  const t = company(tenantId);
  const section = await sectionOf(db, t, input.sectionId);
  if (!section) return { published: false, reason: "unknown" };
  const [target] = await db
    .select({ content: assistantSectionVersions.content })
    .from(assistantSectionVersions)
    .where(
      and(
        eq(assistantSectionVersions.sectionId, input.sectionId),
        eq(assistantSectionVersions.versionNumber, input.toVersion),
      ),
    )
    .limit(1);
  if (!target) return { published: false, reason: "unknown" };

  return publishSection(
    db,
    t,
    {
      sectionId: input.sectionId,
      baseVersion: await headVersionOf(db, input.sectionId),
      content: target.content,
      changeSummary: `rolled back to v${input.toVersion}`,
    },
    actor,
  );
}

export interface VersionRow {
  versionNumber: number;
  changeSummary: string | null;
  createdBy: string | null;
  createdAt: Date;
}

/** A section's history — empty for a section that isn't this company's. */
export async function listSectionVersions(db: AssistantDb, tenantId: string, sectionId: string): Promise<VersionRow[]> {
  const t = company(tenantId);
  return db
    .select({
      versionNumber: assistantSectionVersions.versionNumber,
      changeSummary: assistantSectionVersions.changeSummary,
      createdBy: assistantSectionVersions.createdBy,
      createdAt: assistantSectionVersions.createdAt,
    })
    .from(assistantSectionVersions)
    .innerJoin(assistantSections, eq(assistantSections.id, assistantSectionVersions.sectionId))
    .where(and(eq(assistantSections.tenantId, t), eq(assistantSectionVersions.sectionId, sectionId)))
    .orderBy(desc(assistantSectionVersions.versionNumber));
}

/**
 * Deactivate, never delete. Refused for a core section, and refused while one
 * of the company's house rules still references the key.
 */
export type DeactivateResult =
  | { deactivated: true }
  | { deactivated: false; reason: "unknown" | "core" | "referenced"; referenceCount?: number };

export async function deactivateSection(
  db: AssistantDb,
  tenantId: string,
  sectionId: string,
  actor?: string,
): Promise<DeactivateResult> {
  const t = company(tenantId);
  const section = await sectionOf(db, t, sectionId);
  if (!section) return { deactivated: false, reason: "unknown" };
  if (section.isCore) return { deactivated: false, reason: "core" };

  const referencing = await db
    .select({ id: assistantTenantRules.id })
    .from(assistantTenantRules)
    .where(
      and(
        eq(assistantTenantRules.tenantId, t),
        eq(assistantTenantRules.sectionKey, section.key),
        eq(assistantTenantRules.isActive, true),
      ),
    );
  if (referencing.length > 0) {
    return { deactivated: false, reason: "referenced", referenceCount: referencing.length };
  }

  await db
    .update(assistantSections)
    .set({ isActive: false })
    .where(and(eq(assistantSections.tenantId, t), eq(assistantSections.id, sectionId)));
  await logChange(db, t, {
    entityType: "section",
    entityId: sectionId,
    entityKey: section.key,
    action: "deactivated",
    performedBy: actor ?? null,
  });
  await bumpConfigVersion(db, t);
  return { deactivated: true };
}

// ---------------------------------------------------------------------------
// The business profile (0.9.0): what the owner writes, in plain words, about
// the business — what it does, where, its hours, how it likes to talk. Kept
// as the company's own `business_profile` section, so it rides at the top of
// the system prompt (the part the provider caches within a company), with a
// version history like any section.
// ---------------------------------------------------------------------------

export const BUSINESS_PROFILE_KEY = "business_profile";
/** Roughly a page of prose: enough to describe a business, small enough to send every turn. */
export const BUSINESS_PROFILE_MAX_TOKENS = 700;
const PROFILE_LEAD = "About this business, in the owner's words:\n";

export const businessProfileSchema = z.object({
  content: z.string().trim().max(2_400),
});

/** The owner's own words, without the line the prompt adds in front. */
export function profileText(content: string): string {
  return content.startsWith(PROFILE_LEAD) ? content.slice(PROFILE_LEAD.length) : content;
}

/** The company's profile, in the owner's words ("" when none is written yet). */
export async function getBusinessProfile(db: AssistantDb, tenantId: string): Promise<string> {
  const section = await getSectionByKey(db, tenantId, BUSINESS_PROFILE_KEY);
  return section && section.isActive ? profileText(section.content) : "";
}

export type SaveProfileResult =
  | { saved: true }
  | { saved: false; reason: "budget"; maxTokens: number }
  | { saved: false; reason: "conflict" };

/**
 * Write the company's profile: create it the first time, publish a new version
 * after that, deactivate it when emptied. The budget is enforced here, as for
 * every section.
 */
export async function saveBusinessProfile(
  db: AssistantDb,
  tenantId: string,
  input: z.infer<typeof businessProfileSchema>,
  actor?: string,
): Promise<SaveProfileResult> {
  const t = company(tenantId);
  const { content } = businessProfileSchema.parse(input);
  if (content.length > 0 && !withinBudget(content, BUSINESS_PROFILE_MAX_TOKENS)) {
    return { saved: false, reason: "budget", maxTokens: BUSINESS_PROFILE_MAX_TOKENS };
  }
  const full = `${PROFILE_LEAD}${content}`;
  const existing = await getSectionByKey(db, t, BUSINESS_PROFILE_KEY);
  if (!existing) {
    if (content.length === 0) return { saved: true };
    try {
      await createSection(
        db,
        t,
        {
          key: BUSINESS_PROFILE_KEY,
          label: "About the business",
          description: "What the owner wrote about the business, in their own words.",
          content: full,
          sortOrder: 5,
          maxTokens: BUSINESS_PROFILE_MAX_TOKENS + 50,
        },
        actor,
      );
    } catch (error) {
      if (isUniqueViolation(error)) return { saved: false, reason: "conflict" };
      throw error;
    }
    return { saved: true };
  }
  if (content.length === 0) {
    if (!existing.isActive) return { saved: true };
    await db
      .update(assistantSections)
      .set({ isActive: false })
      .where(and(eq(assistantSections.tenantId, t), eq(assistantSections.id, existing.id)));
    await logChange(db, t, {
      entityType: "section",
      entityId: existing.id,
      entityKey: BUSINESS_PROFILE_KEY,
      action: "deactivated",
      performedBy: actor ?? null,
    });
    await bumpConfigVersion(db, t);
    return { saved: true };
  }
  if (!existing.isActive) {
    await db
      .update(assistantSections)
      .set({ isActive: true })
      .where(and(eq(assistantSections.tenantId, t), eq(assistantSections.id, existing.id)));
  }
  if (existing.content === full) return { saved: true };
  const result = await publishSection(
    db,
    t,
    {
      sectionId: existing.id,
      baseVersion: await headVersionOf(db, existing.id),
      content: full,
      changeSummary: "Business profile updated",
    },
    actor,
  );
  if (result.published) return { saved: true };
  if (result.reason === "budget") return { saved: false, reason: "budget", maxTokens: BUSINESS_PROFILE_MAX_TOKENS };
  return { saved: false, reason: "conflict" };
}

// ---------------------------------------------------------------------------
// House rules and glossary — the per-company layer and the term list, each
// with its own change-log writes and token budget.
// ---------------------------------------------------------------------------

export const createTenantRuleSchema = z.object({
  tenantId: tenantIdSchema,
  sectionKey: z.string().max(60).nullish(),
  label: z.string().min(1).max(80),
  instruction: z.string().min(1).max(2000),
  maxTokens: z.number().int().min(50).max(2000).optional(),
});

export interface TenantRuleRow {
  id: string;
  sectionKey: string | null;
  label: string;
  instruction: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
}

/** A company's active house rules, in order. */
export async function listTenantRules(db: AssistantDb, tenantId: string): Promise<TenantRuleRow[]> {
  const t = company(tenantId);
  return db
    .select({
      id: assistantTenantRules.id,
      sectionKey: assistantTenantRules.sectionKey,
      label: assistantTenantRules.label,
      instruction: assistantTenantRules.instruction,
      sortOrder: assistantTenantRules.sortOrder,
      isActive: assistantTenantRules.isActive,
      createdAt: assistantTenantRules.createdAt,
    })
    .from(assistantTenantRules)
    .where(and(eq(assistantTenantRules.tenantId, t), eq(assistantTenantRules.isActive, true)))
    .orderBy(asc(assistantTenantRules.sortOrder), asc(assistantTenantRules.createdAt));
}

export async function createTenantRule(
  db: AssistantDb,
  input: z.infer<typeof createTenantRuleSchema>,
  actor?: string,
): Promise<{ id: string } | { error: "budget"; maxTokens: number }> {
  const parsed = createTenantRuleSchema.parse(input);
  const maxTokens = parsed.maxTokens ?? 200;
  if (!withinBudget(parsed.instruction, maxTokens)) return { error: "budget", maxTokens };

  const rows = await db
    .insert(assistantTenantRules)
    .values({
      tenantId: parsed.tenantId,
      sectionKey: parsed.sectionKey ?? null,
      label: parsed.label,
      instruction: parsed.instruction,
      maxTokens,
      createdBy: actor ?? null,
    })
    .returning({ id: assistantTenantRules.id });
  const row = rows[0];
  if (!row) throw new Error("tenant rule insert returned no row");
  await logChange(db, parsed.tenantId, {
    entityType: "tenant_rule",
    entityId: row.id,
    entityKey: parsed.sectionKey ?? null,
    action: "created",
    changeSummary: parsed.label,
    performedBy: actor ?? null,
  });
  await bumpConfigVersion(db, parsed.tenantId);
  return { id: row.id };
}

/** Remove one of the company's house rules; false for a rule that isn't the company's (or is gone). */
export async function deactivateTenantRule(
  db: AssistantDb,
  tenantId: string,
  ruleId: string,
  actor?: string,
): Promise<boolean> {
  const t = company(tenantId);
  const rows = await db
    .update(assistantTenantRules)
    .set({ isActive: false })
    .where(
      and(
        eq(assistantTenantRules.tenantId, t),
        eq(assistantTenantRules.id, ruleId),
        eq(assistantTenantRules.isActive, true),
      ),
    )
    .returning({ id: assistantTenantRules.id, sectionKey: assistantTenantRules.sectionKey, label: assistantTenantRules.label });
  const row = rows[0];
  if (!row) return false;
  await logChange(db, t, {
    entityType: "tenant_rule",
    entityId: ruleId,
    entityKey: row.sectionKey,
    action: "deactivated",
    changeSummary: row.label,
    performedBy: actor ?? null,
  });
  await bumpConfigVersion(db, t);
  return true;
}

export const createGlossaryTermSchema = z.object({
  termKey: sectionKeySchema,
  preferred: z.string().min(1).max(120),
  aliases: z.array(z.string().min(1).max(60)).max(20).optional(),
  definition: z.string().max(500).nullish(),
  category: z.string().max(60).nullish(),
});

export interface GlossaryRow {
  id: string;
  termKey: string;
  preferred: string;
  aliases: string[];
  definition: string | null;
  category: string | null;
}

/** A company's active glossary, by key. */
export async function listGlossary(db: AssistantDb, tenantId: string): Promise<GlossaryRow[]> {
  const t = company(tenantId);
  return db
    .select({
      id: assistantGlossary.id,
      termKey: assistantGlossary.termKey,
      preferred: assistantGlossary.preferred,
      aliases: assistantGlossary.aliases,
      definition: assistantGlossary.definition,
      category: assistantGlossary.category,
    })
    .from(assistantGlossary)
    .where(and(eq(assistantGlossary.tenantId, t), eq(assistantGlossary.isActive, true)))
    .orderBy(asc(assistantGlossary.termKey));
}

/**
 * Upsert on (company, term key): a term removed earlier is reactivated rather
 * than colliding with the unique index.
 */
export async function createGlossaryTerm(
  db: AssistantDb,
  tenantId: string,
  input: z.infer<typeof createGlossaryTermSchema>,
  actor?: string,
): Promise<{ id: string }> {
  const t = company(tenantId);
  const parsed = createGlossaryTermSchema.parse(input);
  const rows = await db
    .insert(assistantGlossary)
    .values({
      tenantId: t,
      termKey: parsed.termKey,
      preferred: parsed.preferred,
      aliases: parsed.aliases ?? [],
      definition: parsed.definition ?? null,
      category: parsed.category ?? null,
    })
    .onConflictDoUpdate({
      target: [assistantGlossary.tenantId, assistantGlossary.termKey],
      set: {
        preferred: parsed.preferred,
        aliases: parsed.aliases ?? [],
        definition: parsed.definition ?? null,
        category: parsed.category ?? null,
        isActive: true,
      },
    })
    .returning({ id: assistantGlossary.id });
  const row = rows[0];
  if (!row) throw new Error("glossary insert returned no row");
  await logChange(db, t, {
    entityType: "glossary",
    entityId: row.id,
    entityKey: parsed.termKey,
    action: "created",
    changeSummary: parsed.preferred,
    performedBy: actor ?? null,
  });
  await bumpConfigVersion(db, t);
  return { id: row.id };
}

/** Remove one of the company's terms; false for a term that isn't the company's (or is gone). */
export async function deactivateGlossaryTerm(
  db: AssistantDb,
  tenantId: string,
  termId: string,
  actor?: string,
): Promise<boolean> {
  const t = company(tenantId);
  const rows = await db
    .update(assistantGlossary)
    .set({ isActive: false })
    .where(and(eq(assistantGlossary.tenantId, t), eq(assistantGlossary.id, termId), eq(assistantGlossary.isActive, true)))
    .returning({ id: assistantGlossary.id, termKey: assistantGlossary.termKey, preferred: assistantGlossary.preferred });
  const row = rows[0];
  if (!row) return false;
  await logChange(db, t, {
    entityType: "glossary",
    entityId: termId,
    entityKey: row.termKey,
    action: "deactivated",
    changeSummary: row.preferred,
    performedBy: actor ?? null,
  });
  await bumpConfigVersion(db, t);
  return true;
}

/** A glossary key from the words a person typed: "The Yard!" → "the_yard". */
export function termKeyFor(words: string): string {
  const key = words
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return /^[a-z]/.test(key) ? key : `t_${key}`.slice(0, 60);
}

export interface ChangeLogRow {
  id: bigint;
  entityType: string;
  entityKey: string | null;
  action: string;
  versionNumber: number | null;
  changeSummary: string | null;
  performedBy: string | null;
  createdAt: Date;
}

/** A company's change log, newest first. */
export async function listChangeLog(db: AssistantDb, tenantId: string, limit = 50): Promise<ChangeLogRow[]> {
  const t = company(tenantId);
  return db
    .select({
      id: assistantChangeLog.id,
      entityType: assistantChangeLog.entityType,
      entityKey: assistantChangeLog.entityKey,
      action: assistantChangeLog.action,
      versionNumber: assistantChangeLog.versionNumber,
      changeSummary: assistantChangeLog.changeSummary,
      performedBy: assistantChangeLog.performedBy,
      createdAt: assistantChangeLog.createdAt,
    })
    .from(assistantChangeLog)
    .where(eq(assistantChangeLog.tenantId, t))
    .orderBy(desc(assistantChangeLog.id))
    .limit(Math.min(Math.max(limit, 1), 200));
}

/** Log a change made outside this module (a knowledge page, an FAQ) the same way. */
export async function recordBrainChange(
  db: AssistantDb,
  tenantId: string,
  entry: {
    entityType: string;
    entityId: string;
    entityKey?: string | null;
    action: string;
    changeSummary?: string | null;
    performedBy?: string | null;
  },
): Promise<void> {
  const t = company(tenantId);
  await logChange(db, t, {
    entityType: entry.entityType,
    entityId: entry.entityId,
    entityKey: entry.entityKey ?? null,
    action: entry.action,
    changeSummary: entry.changeSummary ?? null,
    performedBy: entry.performedBy ?? null,
  });
  await bumpConfigVersion(db, t);
}
