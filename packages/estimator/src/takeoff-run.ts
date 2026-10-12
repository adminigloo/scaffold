import { and, eq, gte, sql } from "drizzle-orm";
import { recipeOf } from "./catalog.js";
import { decodeBase64Strict, encodeBase64, inspectImage, photoRefusalMessage, sha256Hex } from "./image.js";
import { keepPublicPhoto, type EstimatorPhotoStore, type PublicPhotoLimits } from "./photos.js";
import { recipeReadsPhotos, type NormalizedObservation } from "./recipes.js";
import { estimatorProducts, estimatorTakeoffs } from "./schema.js";
import { getEstimatorSettings, publicEstimatesOpen, type EstimatorSettings } from "./settings.js";
import {
  buildTakeoffPrompt,
  maxTakeoffCallMicros,
  normalizeObservation,
  observationJsonSchema,
  suggestFromObservation,
  takeoffCostMicros,
  TAKEOFF_SYSTEM_PROMPT,
  type ReadingRecipe,
  type TakeoffModel,
  type TakeoffUsage,
} from "./takeoff.js";
import { EstimatorInputError, type EstimatorDb, type ProductRow, type TakeoffRow } from "./types.js";
import type { CountRecipeConfig, CustomerInputs, RecipeConfig, RecipeKey, TakeoffReading, TakeoffResponse, TakeoffStatus } from "./wire.js";

/**
 * The photo-reading pipeline (section 5.7 of the 0.3 contract). Every step
 * that answers stops the pipeline, and the expensive one — the model call —
 * is the LAST, behind every reason not to make it:
 *
 *    1. decode and inspect the image          → refuse `photo_invalid`
 *    2. the product (this tenant's, live)     → refuse `product_unavailable`
 *    3. the settings                          → refuse `estimates_closed` / `photos_disabled`
 *    4. the photo's hash
 *    5. KEEP A COPY for the business (a store; the visitor under the photo cap; never blocks the reading)
 *    6. already measured                      → "not_needed", no model call (rule B)
 *    7. a recipe that reads no photos         → "not_supported"
 *    8. no model, or reading switched off     → "unavailable"
 *    9. THE CACHE: same tenant, product, photo → that reading, free
 *   10. per requester, today (fail closed)    → "limited"     ┐ one transaction, under the
 *   11. the day's budget (fail closed)        → "paused"      │ business's advisory lock; a
 *   12. CLAIM the (tenant, product, hash) row → "busy"        ┘ claim is counted at its ceiling
 *   13. call the model                        → a throw is "unavailable", cost the ceiling
 *   14. normalize, store, record the spend, answer
 *
 * The answer is always 200 with a status the widget turns into a sentence;
 * every limit FAILS CLOSED with "count them and enter the number", because a
 * customer can always type the number and the business must never be
 * surprised by the bill.
 */

export interface RunPhotoTakeoffInput {
  tenantId: string;
  productId: string;
  imageBase64: string;
  mediaType: string;
  /** What the customer has already typed: a measured job is never read. */
  inputs?: CustomerInputs | null;
  /** Who is asking (an IP, by default); hashed with the tenant before it is stored. */
  requesterKey: string | null;
  now?: Date;
}

export interface RunPhotoTakeoffDeps {
  model?: TakeoffModel;
  photoStore?: EstimatorPhotoStore;
  /** Told about every model call's spend (create-app writes it to `ai_usage`). Contained: a throw goes to `onError`. */
  recordUsage?: (usage: TakeoffUsage) => void | Promise<void>;
  /** Default 150; 50–400. */
  maxTokens?: number;
  /** Pass to skip the read. */
  settings?: EstimatorSettings;
  /** The daily caps on photos kept for visitors (`DEFAULT_PUBLIC_PHOTO_LIMITS`). */
  photoLimits?: PublicPhotoLimits;
  onError?: (error: unknown, context: { tenantId: string; step: string }) => void;
}

/** A pending claim younger than this belongs to a request still waiting on the model. */
const CLAIM_STALE_MS = 60_000;

function thingsFor(recipe: RecipeKey, config: RecipeConfig): string {
  return recipe === "count" ? (config as CountRecipeConfig).noun.many : "steps";
}

function messageFor(status: TakeoffStatus, things: string, stored: boolean): string | null {
  switch (status) {
    case "read":
    case "unreadable":
      return null;
    case "not_needed":
      return stored
        ? "You've measured it already, so we've just kept your photo with your estimate."
        : "You've measured it already, so we'll use your numbers.";
    // No "below": on a phone the questions are ABOVE the photo (review EST-R07).
    case "not_supported":
      return "Thanks for the photo. This one is priced from your measurements, so please fill those in.";
    case "unavailable":
      return `We can't read photos right now, so please count the ${things} and enter the number.`;
    case "limited":
      return `You've used today's photo readings, so please count the ${things} and enter the number.`;
    case "paused":
      return `Photo reading is paused for today, so please count the ${things} and enter the number.`;
    case "busy":
      return "We're already reading this photo. Give it a moment and try again.";
  }
}

/** The start of the UTC day `now` is in: the AI budget's day, whatever the business's zone. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The reading on the wire, from a ledger row. */
export function readingFromRow(row: TakeoffRow, recipe: ReadingRecipe, config: RecipeConfig): TakeoffReading {
  const observation: NormalizedObservation | null = row.status === "read" ? normalizeObservation(recipe, row.observation) : null;
  const suggestion = suggestFromObservation(recipe, config, observation);
  const confidence = (row.confidence as TakeoffReading["confidence"] | null) ?? observation?.confidence ?? "low";
  return {
    takeoffId: row.id,
    recipe,
    status: row.status === "read" ? "read" : "unreadable",
    confidence,
    seen: observation?.seen ?? false,
    suggested: suggestion.suggested,
    heightRangeIn: suggestion.heightRangeIn,
    lowConfidence: suggestion.lowConfidence,
    usable: suggestion.usable,
    lines: suggestion.lines,
    fewerCheck: suggestion.usable ? suggestion.fewerCheck : null,
  };
}

/** A fixed phrase for a failed call: never the provider's text, a key or the image. */
function errorPhrase(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (/timeout/i.test(name) || /timed? ?out/i.test(message)) return "timeout";
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && Number.isInteger(status)) return `provider error ${status}`;
  return "provider error";
}

/**
 * Read one customer photo for a product: OBSERVATIONS ONLY (rule A), as
 * cheaply as possible (rule B). See the module comment for the order of work.
 * Refusals throw `EstimatorInputError`; every other outcome is a
 * `TakeoffResponse` status.
 */
export async function runPhotoTakeoff(
  db: EstimatorDb,
  input: RunPhotoTakeoffInput,
  deps: RunPhotoTakeoffDeps = {},
): Promise<TakeoffResponse> {
  const now = input.now ?? new Date();
  const report = (error: unknown, step: string) => {
    try {
      deps.onError?.(error, { tenantId: input.tenantId, step });
    } catch {
      /* a broken reporter must not break the reading */
    }
  };

  // 1. The image, before any query.
  const bytes = decodeBase64Strict(input.imageBase64);
  if (!bytes) throw new EstimatorInputError("photo_invalid", photoRefusalMessage("bad_base64"));
  const inspected = inspectImage(bytes, input.mediaType);
  if (!inspected.ok) throw new EstimatorInputError("photo_invalid", photoRefusalMessage(inspected.reason));

  // 2. The product: this tenant's, live, shown, priced instantly.
  const [product] = (await db
    .select()
    .from(estimatorProducts)
    .where(
      and(
        eq(estimatorProducts.id, input.productId),
        eq(estimatorProducts.tenantId, input.tenantId),
        eq(estimatorProducts.isActive, true),
        eq(estimatorProducts.showInEstimator, true),
        eq(estimatorProducts.isEstimatable, true),
      ),
    )
    .limit(1)) as ProductRow[];
  if (!product) throw new EstimatorInputError("product_unavailable", "That product isn't available. Refresh the page and pick again.");
  const { recipe, config } = recipeOf(product);
  const things = thingsFor(recipe, config);

  // 3. Settings: closed until the business is set up (review EST-R02).
  const settings = deps.settings ?? (await getEstimatorSettings(db, input.tenantId));
  if (!publicEstimatesOpen(settings)) {
    throw new EstimatorInputError("estimates_closed", "Instant estimates aren't available right now. Please call or email us.");
  }
  if (!settings.photosEnabled) throw new EstimatorInputError("photos_disabled", "This estimator doesn't take photos.");

  // 4. The photo's identity, and who is asking (hashed with the tenant).
  const photoHash = await sha256Hex(bytes);
  const requesterHash = await sha256Hex(`${input.tenantId}:${input.requesterKey ?? "none"}`);

  // 5. Keep a copy for the business. The reading never depends on storage,
  // and a visitor over the day's photo cap still gets their reading — the
  // copy is just not kept (review ADV-5).
  let photoId: string | null = null;
  if (deps.photoStore) {
    try {
      const kept = await keepPublicPhoto(
        db,
        deps.photoStore,
        input.tenantId,
        { bytes, mediaType: inspected.mediaType, width: inspected.width, height: inspected.height, sha256: photoHash },
        now,
        { requesterHash, ...(deps.photoLimits ? { limits: deps.photoLimits } : {}) },
      );
      photoId = kept.id;
    } catch (error) {
      if (!(error instanceof EstimatorInputError && error.code === "photo_limit")) report(error, "store");
    }
  }
  const answer = (status: TakeoffStatus, extra: Partial<TakeoffResponse> = {}): TakeoffResponse => ({
    status,
    reading: null,
    photoId,
    message: messageFor(status, things, photoId !== null),
    cached: false,
    available: status !== "unavailable" && status !== "not_supported",
    result: null,
    ...extra,
  });

  // 6. Already measured: no model call at all.
  const typed = input.inputs ?? {};
  const has = (key: string) => typeof typed[key] === "number";
  if (recipe === "ramp_over_steps" && has("steps") && (has("stepHeightIn") || has("totalRiseIn"))) return answer("not_needed");
  // CONTRACT: a total rise alone is a full measurement too (the steps aren't
  // needed to price it), so it is never read either.
  if (recipe === "ramp_over_steps" && has("totalRiseIn")) return answer("not_needed");
  if (recipe === "count" && has("count")) return answer("not_needed");

  // 7. A recipe that reads no photos.
  if (!recipeReadsPhotos(recipe, config)) return answer("not_supported");
  const readingRecipe = recipe as ReadingRecipe;

  // 8. Reading switched off here.
  const model = deps.model;
  if (!model || settings.aiDailyBudgetCents <= 0 || settings.aiPerRequesterDaily <= 0) return answer("unavailable");

  const fromRow = (row: TakeoffRow, cached: boolean): TakeoffResponse =>
    answer(row.status === "read" ? "read" : "unreadable", { reading: readingFromRow(row, readingRecipe, config), cached });
  const cacheKey = and(
    eq(estimatorTakeoffs.tenantId, input.tenantId),
    eq(estimatorTakeoffs.productId, product.id),
    eq(estimatorTakeoffs.photoHash, photoHash),
  );

  // 9. The cache: an identical photo for this tenant and product never calls the AI twice.
  const [existing] = (await db.select().from(estimatorTakeoffs).where(cacheKey).limit(1)) as TakeoffRow[];
  if (existing && (existing.status === "read" || existing.status === "unreadable")) return fromRow(existing, true);

  const dayStart = utcDayStart(now);
  const maxTokens = Math.max(50, Math.min(400, Math.trunc(deps.maxTokens ?? 150)));
  const ceiling = maxTakeoffCallMicros(model, maxTokens);

  // 10–12, ONE TRANSACTION under this business's advisory lock (review
  // ADV-4). The count, the sum and the claim used to be separate statements,
  // and a claim was written with cost 0 until the model answered — so every
  // request arriving during the one or two seconds a reading takes passed the
  // budget check, and a burst from many addresses spent several times the
  // day's budget. Now each claim is written AT ITS CEILING (the most the call
  // can cost) and corrected to the real cost when the model answers, and the
  // next request can't read the sum until this one's claim is in it. A call
  // killed mid-flight (the route's time ran out) stays counted at its ceiling.
  //
  // Every limit still FAILS CLOSED: a failed count is "limited", a failed sum
  // "paused" (the step that failed says which).
  type Gate =
    | { kind: "limited" | "paused" | "busy" }
    | { kind: "cached"; row: TakeoffRow }
    | { kind: "claimed"; id: string };
  // Assigned inside the transaction; declared wide so the catch can read it.
  let step = "limit" as "limit" | "budget" | "claim";
  let gate: Gate;
  try {
    gate = await db.transaction(async (tx): Promise<Gate> => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`estimator-takeoff:${input.tenantId}`}))`);

      // 10. Per requester, today.
      const [counted] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(estimatorTakeoffs)
        .where(
          and(
            eq(estimatorTakeoffs.tenantId, input.tenantId),
            eq(estimatorTakeoffs.requesterHash, requesterHash),
            gte(estimatorTakeoffs.createdAt, dayStart),
          ),
        )) as Array<{ n: number | string }>;
      if (Number(counted?.n ?? 0) >= settings.aiPerRequesterDaily) return { kind: "limited" };

      // 11. The day's budget — readings in progress counted at their ceiling —
      // with room for this call at its most expensive.
      step = "budget";
      const [spent] = (await tx
        .select({ micros: sql<number>`coalesce(sum(${estimatorTakeoffs.costMicros}), 0)::bigint` })
        .from(estimatorTakeoffs)
        .where(and(eq(estimatorTakeoffs.tenantId, input.tenantId), gte(estimatorTakeoffs.createdAt, dayStart)))) as Array<{
        micros: number | string;
      }>;
      if (Number(spent?.micros ?? 0) + ceiling > settings.aiDailyBudgetCents * 10_000) return { kind: "paused" };

      // 12. Claim the row: one model call per photo, even under a double tap.
      step = "claim";
      const [claimed] = (await tx
        .insert(estimatorTakeoffs)
        .values({
          tenantId: input.tenantId,
          productId: product.id,
          recipe,
          photoHash,
          photoId,
          status: "pending",
          requesterHash,
          costMicros: ceiling,
          costEstimated: true,
          createdAt: now,
        })
        .onConflictDoNothing({ target: [estimatorTakeoffs.tenantId, estimatorTakeoffs.productId, estimatorTakeoffs.photoHash] })
        .returning({ id: estimatorTakeoffs.id })) as Array<{ id: string }>;
      if (claimed) return { kind: "claimed", id: claimed.id };
      const [held] = (await tx.select().from(estimatorTakeoffs).where(cacheKey).limit(1)) as TakeoffRow[];
      if (!held) return { kind: "busy" };
      if (held.status === "read" || held.status === "unreadable") return { kind: "cached", row: held };
      const stale = new Date(now.getTime() - CLAIM_STALE_MS);
      if (held.status === "pending" && held.createdAt.getTime() >= stale.getTime()) return { kind: "busy" };
      const [reclaimed] = (await tx
        .update(estimatorTakeoffs)
        .set({
          status: "pending",
          createdAt: now,
          requesterHash,
          photoId: photoId ?? held.photoId,
          error: null,
          costMicros: ceiling,
          costEstimated: true,
        })
        .where(
          and(
            eq(estimatorTakeoffs.id, held.id),
            sql`(${estimatorTakeoffs.status} = 'failed' or (${estimatorTakeoffs.status} = 'pending' and ${estimatorTakeoffs.createdAt} < ${stale.toISOString()}::timestamptz))`,
          ),
        )
        .returning({ id: estimatorTakeoffs.id })) as Array<{ id: string }>;
      return reclaimed ? { kind: "claimed", id: reclaimed.id } : { kind: "busy" };
    });
  } catch (error) {
    if (step === "claim") throw error;
    report(error, step);
    return answer(step === "limit" ? "limited" : "paused");
  }
  if (gate.kind === "cached") return fromRow(gate.row, true);
  if (gate.kind !== "claimed") return answer(gate.kind);
  const takeoffId = gate.id;

  const record = async (usage: TakeoffUsage) => {
    if (!deps.recordUsage) return;
    try {
      await deps.recordUsage(usage);
    } catch (error) {
      report(error, "usage");
    }
  };

  // 13. The model call: the observation schema, a few short lines, nothing a customer typed.
  const started = Date.now();
  let response;
  try {
    response = await model.read({
      system: TAKEOFF_SYSTEM_PROMPT,
      prompt: buildTakeoffPrompt(readingRecipe, config),
      schema: observationJsonSchema(readingRecipe),
      image: { base64: encodeBase64(bytes), mediaType: inspected.mediaType },
      maxTokens,
    });
  } catch (error) {
    report(error, "model");
    await db
      .update(estimatorTakeoffs)
      .set({ status: "failed", error: errorPhrase(error), model: model.model, costMicros: ceiling, costEstimated: true, completedAt: now })
      .where(eq(estimatorTakeoffs.id, takeoffId));
    await record({
      tenantId: input.tenantId,
      takeoffId,
      operation: "estimator_takeoff",
      model: model.model,
      inputTokens: 0,
      outputTokens: 0,
      costMicros: ceiling,
      costEstimated: true,
      outcome: "errored",
      durationMs: Date.now() - started,
    });
    return answer("unavailable");
  }

  // 14. Normalize (never the model's text), store, record, answer.
  const observation = normalizeObservation(readingRecipe, response.output);
  const counted = observation
    ? observation.recipe === "ramp_over_steps"
      ? observation.risers !== null
      : observation.count !== null
    : false;
  const status = observation && observation.seen && counted ? "read" : "unreadable";
  const inputTokens = Math.max(0, Math.trunc(response.inputTokens));
  const outputTokens = Math.max(0, Math.trunc(response.outputTokens));
  const costMicros = takeoffCostMicros({ inputTokens, outputTokens }, model.rates);
  const [row] = (await db
    .update(estimatorTakeoffs)
    .set({
      status,
      observation: observation as unknown as Record<string, unknown> | null,
      confidence: observation?.confidence ?? null,
      model: model.model,
      inputTokens,
      outputTokens,
      costMicros,
      costEstimated: false,
      error: null,
      completedAt: now,
    })
    .where(eq(estimatorTakeoffs.id, takeoffId))
    .returning()) as TakeoffRow[];
  await record({
    tenantId: input.tenantId,
    takeoffId,
    operation: "estimator_takeoff",
    model: model.model,
    inputTokens,
    outputTokens,
    costMicros,
    costEstimated: false,
    outcome: status,
    durationMs: Date.now() - started,
  });
  return fromRow(row as TakeoffRow, false);
}
