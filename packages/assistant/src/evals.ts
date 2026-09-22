import { and, desc, eq } from "drizzle-orm";
import type { AssistantDb } from "./brain.js";
import { assistantEvalResults, assistantEvalRuns, assistantGoldens } from "./schema.js";

/**
 * The safety / eval loop (0.4).
 *
 * A golden pins a question to what a good answer MUST and MUST NOT contain, and
 * scoring is a deterministic substring check — no judge model. That is a
 * deliberate cost and trust choice: an eval run costs one model call per golden
 * (the answer itself), never a second to grade it, and a red result is a fact a
 * person can read ("the answer omitted 'discount'"), not a grade to argue with.
 * The actual answering runs in the app (it owns the provider); this module owns
 * the goldens, the scoring, and the record of every run.
 */

export type GoldenRow = typeof assistantGoldens.$inferSelect;
export type EvalRunRow = typeof assistantEvalRuns.$inferSelect;
export type EvalResultRow = typeof assistantEvalResults.$inferSelect;

export interface AnswerScore {
  passed: boolean;
  /** Required substrings the answer omitted. */
  missing: string[];
  /** Forbidden substrings the answer contained. */
  forbidden: string[];
}

/**
 * Score one answer against a golden — pure, case-insensitive, deterministic.
 * Passes only if every required substring is present and no forbidden one is.
 */
export function scoreAnswer(
  answer: string,
  golden: { mustInclude: string[]; mustNotInclude: string[] },
): AnswerScore {
  const hay = answer.toLowerCase();
  const missing = golden.mustInclude.filter((s) => s.trim() !== "" && !hay.includes(s.toLowerCase()));
  const forbidden = golden.mustNotInclude.filter((s) => s.trim() !== "" && hay.includes(s.toLowerCase()));
  return { passed: missing.length === 0 && forbidden.length === 0, missing, forbidden };
}

export async function createGolden(
  db: AssistantDb,
  input: { tenantId: string; question: string; mustInclude?: string[]; mustNotInclude?: string[]; category?: string },
): Promise<GoldenRow> {
  const [row] = await db
    .insert(assistantGoldens)
    .values({
      tenantId: input.tenantId,
      question: input.question,
      mustInclude: input.mustInclude ?? [],
      mustNotInclude: input.mustNotInclude ?? [],
      category: input.category ?? null,
    })
    .returning();
  return row as GoldenRow;
}

export async function listGoldens(db: AssistantDb, tenantId: string, activeOnly = false): Promise<GoldenRow[]> {
  const where = activeOnly
    ? and(eq(assistantGoldens.tenantId, tenantId), eq(assistantGoldens.isActive, true))
    : eq(assistantGoldens.tenantId, tenantId);
  return (await db.select().from(assistantGoldens).where(where).orderBy(desc(assistantGoldens.createdAt))) as GoldenRow[];
}

export async function deactivateGolden(db: AssistantDb, id: string): Promise<boolean> {
  const [row] = await db
    .update(assistantGoldens)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(assistantGoldens.id, id))
    .returning({ id: assistantGoldens.id });
  return row !== undefined;
}

export interface EvalResultInput {
  goldenId: string;
  question: string;
  answer: string;
  score: AnswerScore;
}

/** Persist a run and its per-golden results in one place, so total/passed can't drift from the rows. */
export async function recordEvalRun(
  db: AssistantDb,
  input: { tenantId: string; fingerprint?: string; trigger?: string; results: EvalResultInput[] },
): Promise<EvalRunRow> {
  const passed = input.results.filter((r) => r.score.passed).length;
  const [run] = await db
    .insert(assistantEvalRuns)
    .values({
      tenantId: input.tenantId,
      total: input.results.length,
      passed,
      fingerprint: input.fingerprint ?? null,
      trigger: input.trigger ?? "manual",
    })
    .returning();
  const runRow = run as EvalRunRow;
  if (input.results.length > 0) {
    await db.insert(assistantEvalResults).values(
      input.results.map((r) => ({
        runId: runRow.id,
        goldenId: r.goldenId,
        question: r.question,
        answer: r.answer,
        passed: r.score.passed,
        missing: r.score.missing,
        forbidden: r.score.forbidden,
      })),
    );
  }
  return runRow;
}

export async function listEvalRuns(db: AssistantDb, tenantId: string, limit = 20): Promise<EvalRunRow[]> {
  return (await db
    .select()
    .from(assistantEvalRuns)
    .where(eq(assistantEvalRuns.tenantId, tenantId))
    .orderBy(desc(assistantEvalRuns.createdAt))
    .limit(limit)) as EvalRunRow[];
}

export async function getEvalRunResults(db: AssistantDb, runId: string): Promise<EvalResultRow[]> {
  return (await db
    .select()
    .from(assistantEvalResults)
    .where(eq(assistantEvalResults.runId, runId))) as EvalResultRow[];
}
