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

/** The loosest handle that runs these queries — driver, transaction, or test double. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AssistantDb = PgDatabase<any, any, any>;

/** Machine keys: lowercase, referenced as plain text, so no spaces or caps. */
export const sectionKeySchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z][a-z0-9_]*$/, "lowercase letters, digits and underscores");

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

/** Bump the singleton so a per-request assembly read can see config moved. */
async function bumpConfigVersion(db: AssistantDb): Promise<void> {
  await db
    .insert(assistantConfigVersion)
    .values({ id: "singleton", version: 1 })
    .onConflictDoUpdate({
      target: assistantConfigVersion.id,
      set: {
        version: sql`${assistantConfigVersion.version} + 1`,
        updatedAt: new Date(),
      },
    });
}

/** The active sections, in assembly order. */
export async function listSections(db: AssistantDb): Promise<SectionRow[]> {
  return db
    .select(SECTION_COLUMNS)
    .from(assistantSections)
    .where(eq(assistantSections.isActive, true))
    .orderBy(asc(assistantSections.sortOrder), asc(assistantSections.key));
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
  input: CreateSectionInput,
  actor?: string,
): Promise<SectionRow> {
  const parsed = createSectionSchema.parse(input);
  const maxTokens = parsed.maxTokens ?? 600;
  // Enforced here, not merely metered in the UI — Ask Lou's maxTokens lied.
  if (!withinBudget(parsed.content, maxTokens)) throw new SectionBudgetError(maxTokens);

  const sortOrder =
    parsed.sortOrder ??
    (await db
      .select({ sortOrder: assistantSections.sortOrder })
      .from(assistantSections)
      .orderBy(desc(assistantSections.sortOrder))
      .limit(1)
      .then((rows: Array<{ sortOrder: number }>) => (rows[0]?.sortOrder ?? 0) + 10));

  const rows = await db
    .insert(assistantSections)
    .values({
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

  await db.insert(assistantChangeLog).values({
    entityType: "section",
    entityId: row.id,
    entityKey: row.key,
    action: "created",
    performedBy: actor ?? null,
  });
  await bumpConfigVersion(db);
  return row;
}

/**
 * Publish an edit to a section's content — the versioned, concurrency-guarded
 * write. `baseVersion` is the version the editor last saw; if the live head
 * has moved past it, this rejects rather than silently overwriting a
 * colleague's publish (the review's optimistic-concurrency fix). KEY and
 * requiredPhrases are not editable here — the key is immutable, and required
 * phrases are the guardrail publish checks AGAINST.
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

export async function publishSection(
  db: AssistantDb,
  input: z.infer<typeof publishSectionSchema>,
  actor?: string,
): Promise<PublishResult> {
  const parsed = publishSectionSchema.parse(input);

  const [section] = await db
    .select(SECTION_COLUMNS)
    .from(assistantSections)
    .where(eq(assistantSections.id, parsed.sectionId))
    .limit(1);
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

  const [head] = await db
    .select({ versionNumber: assistantSectionVersions.versionNumber })
    .from(assistantSectionVersions)
    .where(eq(assistantSectionVersions.sectionId, parsed.sectionId))
    .orderBy(desc(assistantSectionVersions.versionNumber))
    .limit(1);
  const headVersion = head?.versionNumber ?? 0;
  if (headVersion !== parsed.baseVersion) {
    return { published: false, reason: "conflict", headVersion };
  }

  const nextVersion = headVersion + 1;
  // Snapshot the OUTGOING content as the new version, then move the live row.
  // The version row is the content history; the live row is just the head.
  await db.insert(assistantSectionVersions).values({
    sectionId: parsed.sectionId,
    versionNumber: nextVersion,
    content: parsed.content,
    changeSummary: parsed.changeSummary ?? null,
    createdBy: actor ?? null,
  });
  await db
    .update(assistantSections)
    .set({ content: parsed.content, ...(parsed.label ? { label: parsed.label } : {}) })
    .where(eq(assistantSections.id, parsed.sectionId));
  await db.insert(assistantChangeLog).values({
    entityType: "section",
    entityId: parsed.sectionId,
    entityKey: section.key,
    action: "published",
    sectionId: parsed.sectionId,
    versionNumber: nextVersion,
    changeSummary: parsed.changeSummary ?? null,
    performedBy: actor ?? null,
  });
  await bumpConfigVersion(db);
  return { published: true, versionNumber: nextVersion };
}

/**
 * Roll a section back to a prior version's content — which is itself a
 * publish of that old content, so it runs the SAME budget and required-phrase
 * checks (a rollback is not a privileged bypass, the review's invariant) and
 * lands as a new version at the head. History is never rewound, only extended.
 */
export async function rollbackSection(
  db: AssistantDb,
  input: { sectionId: string; toVersion: number },
  actor?: string,
): Promise<PublishResult> {
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

  const [head] = await db
    .select({ versionNumber: assistantSectionVersions.versionNumber })
    .from(assistantSectionVersions)
    .where(eq(assistantSectionVersions.sectionId, input.sectionId))
    .orderBy(desc(assistantSectionVersions.versionNumber))
    .limit(1);

  return publishSection(
    db,
    {
      sectionId: input.sectionId,
      baseVersion: head?.versionNumber ?? 0,
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

export async function listSectionVersions(
  db: AssistantDb,
  sectionId: string,
): Promise<VersionRow[]> {
  return db
    .select({
      versionNumber: assistantSectionVersions.versionNumber,
      changeSummary: assistantSectionVersions.changeSummary,
      createdBy: assistantSectionVersions.createdBy,
      createdAt: assistantSectionVersions.createdAt,
    })
    .from(assistantSectionVersions)
    .where(eq(assistantSectionVersions.sectionId, sectionId))
    .orderBy(desc(assistantSectionVersions.versionNumber));
}

/**
 * Deactivate, never delete (§4: history is never destroyed). Refused for a
 * core section, and refused while a tenant rule still references the key —
 * the delete-guard the review asked to enumerate, since no FK spans the
 * by-key reference.
 */
export type DeactivateResult =
  | { deactivated: true }
  | { deactivated: false; reason: "unknown" | "core" | "referenced"; referenceCount?: number };

export async function deactivateSection(
  db: AssistantDb,
  sectionId: string,
  actor?: string,
): Promise<DeactivateResult> {
  const [section] = await db
    .select({ id: assistantSections.id, key: assistantSections.key, isCore: assistantSections.isCore })
    .from(assistantSections)
    .where(eq(assistantSections.id, sectionId))
    .limit(1);
  if (!section) return { deactivated: false, reason: "unknown" };
  if (section.isCore) return { deactivated: false, reason: "core" };

  const referencing = await db
    .select({ id: assistantTenantRules.id })
    .from(assistantTenantRules)
    .where(
      and(
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
    .where(eq(assistantSections.id, sectionId));
  await db.insert(assistantChangeLog).values({
    entityType: "section",
    entityId: sectionId,
    entityKey: section.key,
    action: "deactivated",
    performedBy: actor ?? null,
  });
  await bumpConfigVersion(db);
  return { deactivated: true };
}
