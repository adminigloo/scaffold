import { and, asc, desc, eq, gt, inArray, isNull, like, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { parseHistoryDate } from "./history.js";
import { recipeOf } from "./catalog.js";
import { emitEvents, derivedOf, type EstimatorActor, type EstimatorEventListener, type EstimatorEvent } from "./events.js";
import { calculateItemTotal, calculateTotals, type Measurement } from "./pricing.js";
import {
  customerInputsSchema,
  lineReasons,
  measurementSchema,
  priceProduct,
  publicMeasurementSchema,
  resolveOptionSelections,
  type PricedProduct,
} from "./price-product.js";
import { inputsSummary, RECIPE_KEYS } from "./recipes.js";
import {
  estimatorEstimateItems,
  estimatorEstimates,
  estimatorPhotos,
  estimatorProducts,
  estimatorTakeoffs,
  type EstimateItemMeasurement,
  type EstimateItemOptionSnapshot,
} from "./schema.js";
import { effectiveTaxRateBp, formatMoney, getEstimatorSettings, publicEstimatesOpen, type EstimatorSettings } from "./settings.js";
import { suggestFromObservation, normalizeObservation, type ReadingRecipe } from "./takeoff.js";
import { publicLine, singleLine } from "./text.js";
import {
  EstimatorInputError,
  type EstimateItemRow,
  type EstimateRow,
  type EstimatorDb,
  type ProductRow,
  type TakeoffRow,
} from "./types.js";
import type {
  Confidence,
  Correction,
  CustomerInputs,
  EstimateAction,
  EstimateDetail,
  EstimateFilter,
  EstimateLineWire,
  EstimateListRow,
  EstimatePhoto,
  EstimateSource,
  EstimateStatus,
  ReadingWire,
  RecipeKey,
} from "./wire.js";
import { attachPhotosToEstimate, listEstimatePhotos, type EstimatorPhotoStore, type PhotoStepReporter } from "./photos.js";

/**
 * Estimates: the lead a customer saves, the staff estimate, editing either,
 * the queue, and the status lifecycle (sections 6.5–6.7 of the 0.3 contract).
 *
 * WHERE A NUMBER COMES FROM. Every server-priced line goes through
 * `priceProduct` (price-product.ts), so the price saved is the price the
 * customer was shown, and a line keeps what it was priced from — the inputs,
 * the derivation (quantities and the code's sentences), the photo reading it
 * used and where the customer corrected it, and its cost (staff only).
 *
 * EVERY EDIT IS ONE TRANSACTION. Lock the estimate (`SELECT … FOR UPDATE`,
 * tenant-scoped), check it may be edited, write, recompute the totals from the
 * lines (`recomputeEstimate`), stamp `updated_at` — so two staff editing the
 * same draft can't interleave into a total that matches neither, and a total
 * never disagrees with its lines.
 */

export interface EstimatorWriteOptions {
  onEvent?: EstimatorEventListener;
  onEventError?: (error: unknown, event: EstimatorEvent) => void;
  actor?: EstimatorActor;
  notify?: boolean;
  /** Read once per call. */
  now?: Date;
  /** Pass to skip the settings read. */
  settings?: EstimatorSettings;
}

const centsField = z.number().int().min(0);
const blankToNull = (value: unknown): unknown => (typeof value === "string" && value.trim() === "" ? null : value);
const emailOrBlank = z.preprocess(blankToNull, z.string().trim().email("Enter an email address.").max(320).nullish());

/** Written on a public line for a quote-only product: priced by a person, not at $0. */
export const QUOTE_REQUEST_NOTE = "Quote requested — this product is priced by a person, not the instant estimate.";

// --- Numbering and the atomic insert ------------------------------------------------

/**
 * `EST-2026-0001`, sequential per tenant per year.
 *
 * The next number is one past the tenant's highest this year — not the row
 * count, which a missing row (a hand-deleted test estimate) turns into a number
 * that already exists, forever. Two submits in the same instant can still read
 * the same highest; the unique (tenant, number) index makes the loser fail and
 * the insert retries it, so this stays a plain read.
 */
export async function nextEstimateNumber(db: EstimatorDb, tenantId: string, now: Date = new Date()): Promise<string> {
  const year = now.getUTCFullYear();
  const [row] = await db
    // ::int — the serverless driver returns bigger integer types as a STRING,
    // so an uncast `n` makes `n + 1` string-concatenate ("5"+1 = "51"). The
    // regex takes at most 9 digits, so the cast can never overflow.
    .select({
      n: sql<number>`coalesce(max(substring(${estimatorEstimates.estimateNumber} from '^EST-[0-9]{4}-([0-9]{1,9})$')::int), 0)::int`,
    })
    .from(estimatorEstimates)
    .where(and(eq(estimatorEstimates.tenantId, tenantId), like(estimatorEstimates.estimateNumber, `EST-${year}-%`)));
  const next = Number((row as { n: number | string } | undefined)?.n ?? 0) + 1;
  return `EST-${year}-${String(next).padStart(4, "0")}`;
}

/** Postgres unique_violation, wherever the driver or Drizzle nested it. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const ESTIMATE_NUMBER_ATTEMPTS = 5;

/** A line ready to insert. `total` is authoritative. */
export interface PricedItem {
  productId: string | null;
  description: string;
  measurement: EstimateItemMeasurement | null;
  quantity: number;
  unitPrice: number;
  laborPrice: number;
  total: number;
  lowTotal: number;
  highTotal: number;
  priceOverridden: boolean;
  cost: number | null;
  recipe: string | null;
  inputs: CustomerInputs | null;
  derived: Record<string, unknown> | null;
  takeoffId: string | null;
  corrections: Correction[] | null;
  selectedOptions: Record<string, string> | null;
  optionSnapshot: EstimateItemOptionSnapshot[] | null;
  notes: string | null;
}

type EstimateHeader = Omit<typeof estimatorEstimates.$inferInsert, "estimateNumber">;

/**
 * Number and insert an estimate with its lines, atomically.
 *
 * ONE TRANSACTION, so a failed line insert cannot leave a numbered estimate
 * with no lines. RETRIED ON 23505, because two concurrent submits can read the
 * same highest number — the unique index rejects the loser, the whole
 * transaction rolls back, and the next attempt reads a fresh number. The retry
 * is around the transaction, not inside it: after a unique violation Postgres
 * aborts the transaction, so nothing more can run in it. `inside` runs in the
 * same transaction after the insert (linking the customer's photos).
 */
async function insertEstimate(
  db: EstimatorDb,
  header: EstimateHeader,
  items: readonly PricedItem[],
  inside?: (tx: EstimatorDb, estimateId: string) => Promise<void>,
): Promise<{ id: string; estimateNumber: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const estimateNumber = await nextEstimateNumber(tx, header.tenantId, header.createdAt ?? new Date());
        const [estimate] = await tx
          .insert(estimatorEstimates)
          .values({ ...header, estimateNumber })
          .returning({ id: estimatorEstimates.id });
        const estimateId = (estimate as { id: string }).id;
        if (items.length > 0) {
          await tx.insert(estimatorEstimateItems).values(items.map((item, index) => ({ ...item, estimateId, sortOrder: index })));
        }
        if (inside) await inside(tx, estimateId);
        return { id: estimateId, estimateNumber };
      });
    } catch (error) {
      if (isUniqueViolation(error) && attempt < ESTIMATE_NUMBER_ATTEMPTS) continue;
      throw error;
    }
  }
}

// --- Lines ---------------------------------------------------------------------------

function selectionMap(selections: readonly EstimateItemOptionSnapshot[]): Record<string, string> {
  return Object.fromEntries(selections.map((s) => [s.optionId, s.valueId]));
}

/** What a line keeps of its derivation: the sentences, the reasons in staff wording, and its one-line summary. */
function storedDerivation(priced: PricedProduct): Record<string, unknown> {
  return {
    ...priced.derivation,
    reasons: lineReasons(priced),
    inputsSummary: priced.inputs ? inputsSummary(priced.recipe, priced.config, priced.inputs) : null,
  };
}

/**
 * A server-priced line. The line total is the build's `lineTotal` (the point;
 * a percent-band product's midpoint) and its low/high the range shown, each
 * plus any staff labor per item. `unitPrice` is the total ÷ quantity, for
 * display and for invoicing.
 */
export function itemFromPriced(
  priced: PricedProduct,
  extra: { description?: string | null; laborPrice?: number; notes?: string | null; corrections?: Correction[] | null },
): PricedItem {
  const labor = (extra.laborPrice ?? 0) * priced.quantity;
  const { build } = priced;
  return {
    productId: priced.product.id,
    description: extra.description?.trim() || priced.product.name,
    measurement: priced.legacyMeasurement,
    quantity: priced.quantity,
    unitPrice: Math.round(build.lineTotal / priced.quantity),
    laborPrice: extra.laborPrice ?? 0,
    total: build.lineTotal + labor,
    lowTotal: build.estimateLow + labor,
    highTotal: build.estimateHigh + labor,
    priceOverridden: false,
    cost: build.cost,
    recipe: priced.recipe,
    inputs: priced.inputs,
    derived: storedDerivation(priced),
    takeoffId: priced.reading?.takeoffId ?? null,
    corrections: extra.corrections !== undefined ? extra.corrections : priced.corrections,
    selectedOptions: selectionMap(priced.selections),
    optionSnapshot: priced.selections,
    notes: extra.notes ?? null,
  };
}

export const createEstimateItemSchema = z.object({
  /** "" is treated as no product (a free line). */
  productId: z.string().max(200).nullish(),
  /** A product line takes the product's name by default; a free line needs one. */
  description: z.string().trim().max(500).nullish(),
  /** 0.2's measurement (a staff line may still carry one, `units` included). */
  measurement: measurementSchema.nullish(),
  /** The customer's answers, by field key (0.3). */
  inputs: customerInputsSchema.nullish(),
  quantity: z.number().int().min(1).max(1000).default(1),
  /** Staff's own price for ONE of the line. Omitted with a product, the price book prices it. */
  unitPrice: centsField.max(100_000_000).nullish(),
  laborPrice: centsField.max(100_000_000).default(0),
  optionValueIds: z.array(z.string().min(1).max(200)).max(50).default([]),
  /** @deprecated Ignored since 0.2.0: the saved map is resolved from `optionValueIds`. */
  selectedOptions: z.record(z.string(), z.string()).nullish(),
  notes: z.string().max(1000).nullish(),
  /** A photo reading the line was priced with (0.3). */
  takeoffId: z.string().max(200).nullish(),
});
export type CreateEstimateItemInput = z.input<typeof createEstimateItemSchema>;
type ParsedItem = z.output<typeof createEstimateItemSchema>;

function needsDescription(): z.ZodError {
  return new z.ZodError([{ code: "custom", path: ["description"], message: "Describe the line.", input: undefined }] as never);
}

/**
 * A STAFF line, priced. Free lines (no product) are staff's own numbers; a
 * `unitPrice` on a product line is staff's price (`price_overridden`), and its
 * cost still comes from the price book where the product can be priced, so
 * the margin stays honest; any other product line is priced by the price
 * book. A product that isn't this tenant's live product, a quote-only one
 * without a price, or a line without its measurements is REFUSED — never saved
 * at $0.
 */
async function priceStaffItem(
  db: EstimatorDb,
  tenantId: string,
  item: ParsedItem,
  settings: EstimatorSettings,
  keep: { corrections?: Correction[] | null } = {},
): Promise<PricedItem> {
  const productId = item.productId || null;
  if (!productId) {
    const description = item.description?.trim();
    if (!description) throw needsDescription();
    const unitPrice = item.unitPrice ?? 0;
    const total = calculateItemTotal(unitPrice, item.laborPrice, item.quantity);
    return {
      productId: null,
      description,
      measurement: (item.measurement ?? null) as EstimateItemMeasurement | null,
      quantity: item.quantity,
      unitPrice,
      laborPrice: item.laborPrice,
      total,
      lowTotal: total,
      highTotal: total,
      priceOverridden: true,
      cost: null,
      recipe: null,
      inputs: null,
      derived: null,
      takeoffId: null,
      corrections: null,
      selectedOptions: null,
      optionSnapshot: null,
      notes: item.notes ?? null,
    };
  }

  const request = {
    productId,
    inputs: item.inputs ?? null,
    measurement: (item.measurement ?? null) as Measurement | null,
    quantity: item.quantity,
    optionValueIds: item.optionValueIds,
    takeoffId: item.takeoffId ?? null,
  };

  if (item.unitPrice != null) {
    // Staff's own price on a catalog product. The product must still be this
    // tenant's live product and the options resolved, not typed.
    let priced: Awaited<ReturnType<typeof priceProduct>>;
    try {
      priced = await priceProduct(db, tenantId, request, { audience: "staff", settings });
    } catch (error) {
      if (error instanceof EstimatorInputError && error.code === "invalid_measurement") priced = { status: "needs_inputs", missing: [] };
      else throw error;
    }
    const total = calculateItemTotal(item.unitPrice, item.laborPrice, item.quantity);
    const base = priced.status === "priced" ? itemFromPriced(priced, { description: item.description, notes: item.notes ?? null, ...keep }) : null;
    let product: ProductRow | null = priced.status === "priced" ? priced.product : priced.status === "quote_only" ? priced.product : null;
    if (!product) {
      const [row] = (await db
        .select()
        .from(estimatorProducts)
        .where(and(eq(estimatorProducts.id, productId), eq(estimatorProducts.tenantId, tenantId), eq(estimatorProducts.isActive, true)))
        .limit(1)) as ProductRow[];
      product = row ?? null;
    }
    if (!product) throw new EstimatorInputError("product_unavailable", "That product isn't in this price book.");
    let selections = priced.status === "priced" ? priced.selections : null;
    if (!selections) {
      selections = await resolveOptionSelections(db, product.id, item.optionValueIds, "staff");
      if (selections === null) throw new EstimatorInputError("invalid_options", "Choose one value for each option.");
    }
    return {
      productId: product.id,
      description: item.description?.trim() || product.name,
      measurement: base?.measurement ?? ((item.measurement ?? null) as EstimateItemMeasurement | null),
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      laborPrice: item.laborPrice,
      total,
      lowTotal: total,
      highTotal: total,
      priceOverridden: true,
      cost: base?.cost ?? null,
      recipe: base?.recipe ?? null,
      inputs: base?.inputs ?? (item.inputs ?? null),
      derived: base?.derived ?? null,
      takeoffId: base?.takeoffId ?? null,
      corrections: base?.corrections ?? null,
      selectedOptions: selectionMap(selections),
      optionSnapshot: selections,
      notes: item.notes ?? null,
    };
  }

  const priced = await priceProduct(db, tenantId, request, { audience: "staff", settings });
  if (priced.status === "quote_only") {
    throw new EstimatorInputError(
      "product_not_estimatable",
      `${priced.product.name} is priced by a person: set the line's price yourself.`,
    );
  }
  if (priced.status === "needs_inputs") {
    throw new EstimatorInputError("invalid_measurement", "Enter the measurements for that line (or set its price yourself).");
  }
  return itemFromPriced(priced, { description: item.description, laborPrice: item.laborPrice, notes: item.notes ?? null, ...keep });
}

interface Summary {
  subtotal: number;
  rangeLow: number;
  rangeHigh: number;
  rangeReasons: string[];
  cost: number | null;
}

function summarize(items: ReadonlyArray<Pick<PricedItem, "total" | "lowTotal" | "highTotal" | "cost" | "derived">>): Summary {
  let subtotal = 0;
  let rangeLow = 0;
  let rangeHigh = 0;
  let cost: number | null = null;
  const reasons: string[] = [];
  for (const item of items) {
    subtotal += item.total;
    rangeLow += item.lowTotal;
    rangeHigh += item.highTotal;
    if (item.cost !== null && item.cost !== undefined) cost = (cost ?? 0) + item.cost;
    const lineReasons = (item.derived as { reasons?: unknown } | null)?.reasons;
    if (item.lowTotal !== item.highTotal && Array.isArray(lineReasons)) {
      for (const reason of lineReasons) if (typeof reason === "string" && !reasons.includes(reason)) reasons.push(reason);
    }
  }
  return { subtotal, rangeLow, rangeHigh, rangeReasons: reasons, cost };
}

function refuseDiscount(discount: number, subtotal: number): EstimatorInputError {
  return new EstimatorInputError(
    "discount_exceeds_subtotal",
    `A discount of ${(discount / 100).toFixed(2)} is more than the work (${(subtotal / 100).toFixed(2)}).`,
  );
}

// --- Staff create ----------------------------------------------------------------------

export const createEstimateSchema = z.object({
  tenantId: z.string().min(1).max(200),
  customerName: singleLine(200).nullish(),
  customerEmail: emailOrBlank,
  customerPhone: singleLine(60).nullish(),
  jobAddress: singleLine(500).nullish(),
  notes: z.string().max(2000).nullish(),
  internalNotes: z.string().max(5000).nullish(),
  source: z.enum(["public_tool", "photo", "staff"]).default("staff"),
  photoUrl: z.string().max(2000).nullish(),
  /** Omitted: the settings' rate (saved), else `DEFAULT_TAX_RATE_BP`. */
  taxRateBp: z.number().int().min(0).max(10_000).optional(),
  discount: centsField.default(0),
  /** May be empty (0.3): "New estimate" starts blank; sending refuses an empty one. */
  items: z.array(createEstimateItemSchema).min(0).max(100, "Up to 100 lines."),
});
export type CreateEstimateInput = z.input<typeof createEstimateSchema>;

export interface CreatedEstimate {
  id: string;
  estimateNumber: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  /** 0.3: the range the lines were shown at, pre-tax. */
  rangeLow: number;
  rangeHigh: number;
}

/**
 * Persist a STAFF estimate and its lines.
 *
 * This is the trusted path: `unitPrice`, `laborPrice`, `discount`, `taxRateBp`
 * and `photoUrl` are taken as given, because a staff member setting a price is
 * the point. A browser must never reach it — the public tool and the embed use
 * `createPublicEstimate`, which accepts none of those.
 */
export async function createEstimate(
  db: EstimatorDb,
  input: CreateEstimateInput,
  createdBy?: string,
  options: {
    now?: Date;
    settings?: EstimatorSettings;
    /**
     * 0.7, past records: the day this estimate was really made (staff and
     * server paths only). Not in the future, not before 2000. Its number is
     * that year's; `entered_at`/`entered_by` record that it was typed in now.
     */
    occurredAt?: Date | string;
  } = {},
): Promise<CreatedEstimate> {
  const parsed = createEstimateSchema.parse(input);
  const enteredAt = options.now ?? new Date();
  const settings = options.settings ?? (await getEstimatorSettings(db, parsed.tenantId));
  // A day ("2025-06-14") is that day where the company is.
  const now =
    options.occurredAt !== undefined ? parseHistoryDate(options.occurredAt, enteredAt, "occurredAt", null, settings.timeZone) : enteredAt;
  const backdated = options.occurredAt !== undefined;

  const items: PricedItem[] = [];
  for (const item of parsed.items) items.push(await priceStaffItem(db, parsed.tenantId, item, settings));
  const summary = summarize(items);
  if (parsed.discount > summary.subtotal) throw refuseDiscount(parsed.discount, summary.subtotal);
  const taxRateBp = parsed.taxRateBp ?? effectiveTaxRateBp(settings);
  const totals = calculateTotals({ itemTotals: items.map((item) => item.total), taxRateBp, discount: parsed.discount });

  const created = await insertEstimate(
    db,
    {
      tenantId: parsed.tenantId,
      status: "draft",
      customerName: parsed.customerName || null,
      customerEmail: parsed.customerEmail || null,
      customerPhone: parsed.customerPhone || null,
      jobAddress: parsed.jobAddress || null,
      subtotal: totals.subtotal,
      taxRateBp,
      taxAmount: totals.taxAmount,
      discount: parsed.discount,
      total: totals.total,
      rangeLow: summary.rangeLow,
      rangeHigh: summary.rangeHigh,
      rangeReasons: summary.rangeReasons,
      currency: settings.currency,
      cost: summary.cost,
      notes: parsed.notes || null,
      internalNotes: parsed.internalNotes || null,
      source: parsed.source,
      photoUrl: parsed.photoUrl ?? null,
      createdBy: createdBy ?? null,
      createdAt: now,
      updatedAt: now,
      ...(backdated ? { enteredAt, enteredBy: createdBy ?? null } : {}),
    },
    items,
  );
  return {
    ...created,
    subtotal: totals.subtotal,
    taxAmount: totals.taxAmount,
    total: totals.total,
    rangeLow: summary.rangeLow,
    rangeHigh: summary.rangeHigh,
  };
}

// --- Public submit: the lead -----------------------------------------------------------

/**
 * One line of a public submit: WHAT the customer wants, never what it costs.
 * No unitPrice, laborPrice, notes — or description: unknown keys are dropped,
 * never trusted.
 *
 * NO DESCRIPTION (review ADV-1). It used to take any 500 characters as the
 * line's name, and the line's name goes into the customer's copy of the
 * estimate — an email the visitor addresses to anybody, sent from the
 * business's verified domain ("Your card was declined, update it at https://…")
 * — and onto the quote and the invoice. The widget never sent one. A public
 * line is always the product's own name.
 */
export const publicSubmitItemSchema = z.object({
  productId: z.string().min(1).max(200),
  /** 0.2's shape (a 0.1 widget). No `units`. */
  measurement: publicMeasurementSchema.nullish(),
  /** The customer's answers (0.3). */
  inputs: customerInputsSchema.nullish(),
  quantity: z.number().int().min(1).max(1000).default(1),
  optionValueIds: z.array(z.string().min(1).max(200)).max(50).default([]),
  /** The photo reading the widget pre-filled from (0.3). */
  takeoffId: z.string().max(200).nullish(),
});

/**
 * A lead from the public instant-estimate tool or the embed. There is no
 * tenantId, discount, taxRateBp or photoUrl here: the tenant and its tax rate
 * come from the server, and a discount is a staff decision. A lead needs a
 * name and a way to reach them — an email or a phone. The name, phone and
 * address are one line each, and a name or address with a web address in it
 * is refused: they are echoed back in the customer's copy (text.ts).
 */
export const publicSubmitSchema = z
  .object({
    customerName: publicLine(200, "your name").refine((value) => value.length > 0, "Enter your name."),
    customerEmail: emailOrBlank,
    customerPhone: z.preprocess(blankToNull, singleLine(60).nullish()),
    jobAddress: z.preprocess(blankToNull, publicLine(500, "the address").nullish()),
    notes: z.preprocess(blankToNull, z.string().trim().max(2000).nullish()),
    /** @deprecated Ignored (0.3): "photo" when a line used a reading, else "public_tool". */
    source: z.enum(["public_tool", "photo"]).optional(),
    items: z.array(publicSubmitItemSchema).min(1, "Pick what you need.").max(20),
    /** The customer's photos, kept by `POST photo` or a reading (0.3). */
    photoIds: z.array(z.string().min(1).max(200)).max(3, "Up to 3 photos.").default([]),
  })
  .refine((v) => Boolean(v.customerEmail) || Boolean(v.customerPhone), {
    message: "Enter an email or a phone number so we can reach you.",
    path: ["customerEmail"],
  });
export type PublicSubmitInput = z.input<typeof publicSubmitSchema>;

/** Server-side facts about the tenant a public submit is for — never from the body. */
export interface PublicEstimateConfig {
  tenantId: string;
  /**
   * @deprecated — the settings' tax rate. Used only while the tenant has no
   * saved settings (then `DEFAULT_TAX_RATE_BP`).
   */
  taxRateBp?: number;
  settings?: EstimatorSettings;
  onEvent?: EstimatorEventListener;
  onEventError?: (error: unknown, event: EstimatorEvent) => void;
  now?: Date;
  /** Who asked (an IP, by default). Accepted for the handler's symmetry; a lead never stores it. */
  requesterKey?: string | null;
  /**
   * Tenancy 2b-1 (review BO-13): the store the customer's photos are in. After
   * the lead commits, each linked photo is put on its estimate there
   * (`attach`), so it is filed with the estimate and the estimate's
   * permissions decide who opens it. Without it (or a 0.4 store with no
   * `attach`), 0.4's behaviour.
   */
  photoStore?: EstimatorPhotoStore;
  /** Told about a photo step that failed after the lead was saved (step "photo-attach"). The lead stands. */
  onError?: PhotoStepReporter;
}

/** How long an unlinked photo may wait for its submit. */
const PHOTO_LINK_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Save a customer's estimate from the public tool or the embed — the lead.
 *
 * The server prices every line, for the public audience (the product must be
 * this tenant's, active and shown; staff-only options are ignored), exactly as
 * `POST calculate` showed it. The line keeps the customer's inputs, the
 * derivation, the photo reading it used (a `takeoffId` must be this tenant's
 * and this product's, else `takeoff_unavailable`) and where the customer
 * changed what the photo suggested. The customer's photos (`photoIds`: this
 * tenant's, unlinked, from the last 48 h, else `photo_unavailable`) are linked
 * in the same transaction. A quote-only product is kept as a $0 "quote
 * requested" line. After commit, `lead.received`.
 */
export async function createPublicEstimate(
  db: EstimatorDb,
  input: PublicSubmitInput,
  config: PublicEstimateConfig,
): Promise<CreatedEstimate> {
  const parsed = publicSubmitSchema.parse(input);
  const tenantId = z.string().min(1).max(200).parse(config.tenantId);
  const now = config.now ?? new Date();
  const settings = config.settings ?? (await getEstimatorSettings(db, tenantId));
  // Closed until the business is set up: no lead is taken whose copy would be
  // "from " nobody, at a tax rate the owner never chose (review EST-R02).
  if (!publicEstimatesOpen(settings)) {
    throw new EstimatorInputError("estimates_closed", "Instant estimates aren't available right now. Please call or email us.");
  }

  const items: PricedItem[] = [];
  let read = false;
  for (const item of parsed.items) {
    const priced = await priceProduct(
      db,
      tenantId,
      {
        productId: item.productId,
        inputs: item.inputs ?? null,
        measurement: (item.measurement ?? null) as Measurement | null,
        quantity: item.quantity,
        optionValueIds: item.optionValueIds,
        takeoffId: item.takeoffId ?? null,
      },
      { audience: "public", settings, strictTakeoff: true },
    );
    if (priced.status === "quote_only") {
      items.push({
        productId: priced.product.id,
        description: priced.product.name,
        measurement: null,
        quantity: 1,
        unitPrice: 0,
        laborPrice: 0,
        total: 0,
        lowTotal: 0,
        highTotal: 0,
        priceOverridden: false,
        cost: null,
        recipe: null,
        inputs: item.inputs ?? null,
        derived: null,
        takeoffId: null,
        corrections: null,
        selectedOptions: null,
        optionSnapshot: null,
        notes: QUOTE_REQUEST_NOTE,
      });
      continue;
    }
    if (priced.status === "needs_inputs") {
      throw new EstimatorInputError(
        "invalid_measurement",
        "Answer the questions above (the measurements) before sending your estimate.",
      );
    }
    if (priced.reading?.status === "read") read = true;
    items.push(itemFromPriced(priced, {}));
  }

  const summary = summarize(items);
  const taxRateBp = effectiveTaxRateBp(settings, config.taxRateBp);
  const totals = calculateTotals({ itemTotals: items.map((item) => item.total), taxRateBp, discount: 0 });
  const photoIds = [...new Set(parsed.photoIds)];
  // The stored files of the photos linked in the transaction, to put on the
  // estimate once it has committed (never inside it: a slow store must not
  // hold the lead's transaction open, and a rolled-back lead attaches nothing).
  let linkedFileIds: string[] = [];

  const created = await insertEstimate(
    db,
    {
      tenantId,
      status: "draft",
      customerName: parsed.customerName,
      customerEmail: parsed.customerEmail || null,
      customerPhone: parsed.customerPhone || null,
      jobAddress: parsed.jobAddress || null,
      subtotal: totals.subtotal,
      taxRateBp,
      taxAmount: totals.taxAmount,
      discount: 0,
      total: totals.total,
      rangeLow: summary.rangeLow,
      rangeHigh: summary.rangeHigh,
      rangeReasons: summary.rangeReasons,
      currency: settings.currency,
      cost: summary.cost,
      notes: parsed.notes || null,
      source: read ? "photo" : "public_tool",
      photoUrl: null,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    },
    items,
    photoIds.length === 0
      ? undefined
      : async (tx, estimateId) => {
          const linked = (await tx
            .update(estimatorPhotos)
            .set({ estimateId, linkedAt: now })
            .where(
              and(
                eq(estimatorPhotos.tenantId, tenantId),
                inArray(estimatorPhotos.id, photoIds),
                isNull(estimatorPhotos.estimateId),
                gt(estimatorPhotos.createdAt, new Date(now.getTime() - PHOTO_LINK_WINDOW_MS)),
              ),
            )
            .returning({ id: estimatorPhotos.id, fileId: estimatorPhotos.fileId })) as Array<{ id: string; fileId: string }>;
          if (linked.length !== photoIds.length) {
            throw new EstimatorInputError(
              "photo_unavailable",
              "One of your photos isn't available any more. Add it again, or send your estimate without it.",
            );
          }
          linkedFileIds = linked.map((row) => row.fileId);
        },
  );

  // Committed: the customer's photos go on their estimate in the file store
  // (Tenancy 2b-1, review BO-13). Each is contained and reported; the lead
  // and its photo rows stand whatever the store says.
  await attachPhotosToEstimate(config.photoStore, { tenantId, estimateId: created.id, fileIds: linkedFileIds }, config.onError);

  await emitEvents(db, tenantId, [{ type: "lead.received", estimateId: created.id, actor: { type: "customer", id: null }, via: "online" }], {
    now,
    onEvent: config.onEvent,
    onEventError: config.onEventError,
  });

  return {
    ...created,
    subtotal: totals.subtotal,
    taxAmount: totals.taxAmount,
    total: totals.total,
    rangeLow: summary.rangeLow,
    rangeHigh: summary.rangeHigh,
  };
}

// --- Reading -----------------------------------------------------------------------------

/** @deprecated — use `searchEstimates` (filters, search, paging, counts). */
export async function listEstimates(db: EstimatorDb, tenantId: string, limit = 100): Promise<EstimateRow[]> {
  return (await db
    .select()
    .from(estimatorEstimates)
    .where(eq(estimatorEstimates.tenantId, tenantId))
    .orderBy(desc(estimatorEstimates.createdAt), desc(estimatorEstimates.id))
    .limit(limit)) as EstimateRow[];
}

/** An estimate row with its lines (0.2's `getEstimate` answer; renamed in 0.3 — the wire's `EstimateDetail` is the admin view). */
export interface EstimateWithItems {
  estimate: EstimateRow;
  items: EstimateItemRow[];
}

/** One of this tenant's estimates with its lines; null when it is not theirs. */
export async function getEstimate(db: EstimatorDb, tenantId: string, id: string): Promise<EstimateWithItems | null> {
  const [estimate] = await db
    .select()
    .from(estimatorEstimates)
    .where(and(eq(estimatorEstimates.id, id), eq(estimatorEstimates.tenantId, tenantId)))
    .limit(1);
  if (!estimate) return null;
  const items = await db
    .select()
    .from(estimatorEstimateItems)
    .where(eq(estimatorEstimateItems.estimateId, id))
    .orderBy(asc(estimatorEstimateItems.sortOrder));
  return { estimate: estimate as EstimateRow, items: items as EstimateItemRow[] };
}

/** The estimate row alone, tenant-scoped. */
export async function getEstimateRow(db: EstimatorDb, tenantId: string, id: string): Promise<EstimateRow | null> {
  const [row] = (await db
    .select()
    .from(estimatorEstimates)
    .where(and(eq(estimatorEstimates.id, id), eq(estimatorEstimates.tenantId, tenantId)))
    .limit(1)) as EstimateRow[];
  return row ?? null;
}

// --- Statuses ----------------------------------------------------------------------------

export const ESTIMATE_STATUSES = ["draft", "sent", "viewed", "approved", "rejected", "expired", "converted"] as const;

/**
 * The only moves an estimate's status can make. draft → sent → viewed →
 * approved | rejected | expired (a sent quote can be answered unviewed);
 * approved → converted; a rejected or expired quote can be reopened to draft.
 * 0.3 adds "revise": a sent or viewed quote back to draft, to change it (its
 * link says "we're updating this quote" meanwhile). `converted` is TERMINAL:
 * it means an invoice exists, so an estimate that could leave it could be
 * invoiced twice.
 *
 * approved → converted is made ONLY by `markEstimateConverted`, the invoicing
 * claim; `setEstimateStatus` refuses it.
 */
export const ESTIMATE_STATUS_TRANSITIONS: Readonly<Record<EstimateStatus, readonly EstimateStatus[]>> = {
  draft: ["sent"],
  sent: ["viewed", "approved", "rejected", "expired", "draft"],
  viewed: ["approved", "rejected", "expired", "draft"],
  approved: ["converted"],
  rejected: ["draft"],
  expired: ["draft"],
  converted: [],
};

/** Where an estimate in `from` may move next ([] for an unknown status). */
export function allowedNextStatuses(from: string): readonly EstimateStatus[] {
  return (ESTIMATE_STATUS_TRANSITIONS as Record<string, readonly EstimateStatus[] | undefined>)[from] ?? [];
}

export function canTransitionEstimate(from: string, to: string): boolean {
  return allowedNextStatuses(from).includes(to as EstimateStatus);
}

export const setEstimateStatusSchema = z.object({
  id: z.string().min(1),
  status: z.enum(ESTIMATE_STATUSES),
  /** The customer's (or staff's) note on an accept or decline (0.3). */
  note: z.string().trim().max(1000).nullish(),
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Move one of this tenant's estimates to a new status along
 * `ESTIMATE_STATUS_TRANSITIONS`. The check is in the UPDATE's WHERE (the
 * current status must be one that may move to the target), so it is atomic.
 * False when the estimate is not the tenant's or the move is not allowed from
 * its current status — and always for `converted`.
 *
 * 0.3: the move stamps its timestamp (→ sent: `sent_at` and `valid_until`; →
 * approved: `approved_at` and `responded_at`; …) and → approved / rejected
 * emits `quote.accepted` / `quote.declined` (actor staff, `via: "staff"`,
 * `notify` from options, default false). It never emits `quote.sent` — no link
 * was sent; that is `sendQuote`.
 */
export async function setEstimateStatus(
  db: EstimatorDb,
  tenantId: string,
  input: z.input<typeof setEstimateStatusSchema>,
  options: EstimatorWriteOptions & {
    /**
     * 0.7, past records: the day this really happened (staff and server
     * paths only) — not in the future, not before 2000, not before the
     * estimate was made. Its stamp (sent_at, approved_at…) and its event
     * carry that day, and the customer is never told.
     */
    occurredAt?: Date | string;
  } = {},
): Promise<boolean> {
  const parsed = setEstimateStatusSchema.parse(input);
  if (parsed.status === "converted") return false;
  const from = ESTIMATE_STATUSES.filter((s) => ESTIMATE_STATUS_TRANSITIONS[s].includes(parsed.status));
  if (from.length === 0) return false;
  const enteredAt = options.now ?? new Date();
  let now = enteredAt;
  const backdated = options.occurredAt !== undefined;
  let settings = options.settings;
  if (backdated) {
    const [made] = await db
      .select({ createdAt: estimatorEstimates.createdAt })
      .from(estimatorEstimates)
      .where(and(eq(estimatorEstimates.id, parsed.id), eq(estimatorEstimates.tenantId, tenantId)))
      .limit(1);
    if (!made) return false;
    settings ??= await getEstimatorSettings(db, tenantId);
    // A day ("2025-06-14") is that day where the company is.
    now = parseHistoryDate(
      options.occurredAt,
      enteredAt,
      "occurredAt",
      { at: (made as { createdAt: Date }).createdAt, what: "the estimate was made" },
      settings.timeZone,
    );
  }
  const set: Partial<typeof estimatorEstimates.$inferInsert> = { status: parsed.status, updatedAt: now };
  switch (parsed.status) {
    case "sent": {
      settings ??= await getEstimatorSettings(db, tenantId);
      set.sentAt = now;
      set.validUntil = new Date(now.getTime() + settings.quoteValidDays * DAY_MS);
      // A past quote whose time ran out before it was typed in expired long
      // ago: that is history, not news. Stamped as announced, the expiry
      // sweep moves it to "expired" and tells nobody — no "your quote has
      // expired" email to a customer about a quote from last year.
      if (backdated && set.validUntil.getTime() <= enteredAt.getTime()) set.expiryNotifiedAt = enteredAt;
      break;
    }
    case "viewed":
      set.viewedAt = now;
      break;
    case "approved":
      set.approvedAt = now;
      set.respondedAt = now;
      if (parsed.note !== undefined) set.responseNote = parsed.note ?? null;
      break;
    case "rejected":
      set.rejectedAt = now;
      set.respondedAt = now;
      if (parsed.note !== undefined) set.responseNote = parsed.note ?? null;
      break;
    case "expired":
      set.expiredAt = now;
      break;
    case "draft":
      break;
  }
  const [row] = await db
    .update(estimatorEstimates)
    .set(set)
    .where(
      and(eq(estimatorEstimates.id, parsed.id), eq(estimatorEstimates.tenantId, tenantId), inArray(estimatorEstimates.status, from)),
    )
    .returning({ id: estimatorEstimates.id });
  if (row === undefined) return false;
  if (parsed.status === "approved" || parsed.status === "rejected") {
    await emitEvents(
      db,
      tenantId,
      [
        {
          type: parsed.status === "approved" ? "quote.accepted" : "quote.declined",
          estimateId: parsed.id,
          actor: options.actor ?? { type: "staff", id: null },
          // A past record is history, never news to the customer.
          notify: backdated ? false : (options.notify ?? false),
          via: "staff",
          note: parsed.note ?? null,
        },
      ],
      { now, onEvent: options.onEvent, onEventError: options.onEventError },
    );
  }
  return true;
}

/**
 * Claim an APPROVED estimate for invoicing — the invoicing bridge's once-only
 * step, and the only way an estimate becomes `converted`.
 *
 * One conditional UPDATE (`… WHERE status = 'approved' RETURNING *`), so of
 * two concurrent "create invoice from this estimate" calls exactly one gets the
 * row back and the other gets null. Call it inside the transaction that
 * creates the invoice, and treat null as "not approved, or already converted
 * (or not this tenant's)": do not invoice. Stamps `converted_at`; emits
 * `estimate.converted` when `options.onEvent` is given (after the claim —
 * inside the caller's transaction, so pass it only where that is fine).
 */
export async function markEstimateConverted(
  db: EstimatorDb,
  tenantId: string,
  id: string,
  options: EstimatorWriteOptions = {},
): Promise<EstimateRow | null> {
  const now = options.now ?? new Date();
  const [row] = await db
    .update(estimatorEstimates)
    .set({ status: "converted", convertedAt: now, updatedAt: now })
    .where(and(eq(estimatorEstimates.id, id), eq(estimatorEstimates.tenantId, tenantId), eq(estimatorEstimates.status, "approved")))
    .returning();
  const claimed = (row as EstimateRow | undefined) ?? null;
  if (claimed && options.onEvent) {
    await emitEvents(db, tenantId, [{ type: "estimate.converted", estimateId: id, actor: options.actor ?? { type: "staff", id: null } }], {
      now,
      onEvent: options.onEvent,
      onEventError: options.onEventError,
    });
  }
  return claimed;
}

/** What the editor offers for an estimate in this state (8.5's `EstimateAction`). */
export function staffActionsFor(
  row: Pick<EstimateRow, "status" | "archivedAt">,
  _now: Date = new Date(),
  seams: { convert?: boolean; bookVisit?: boolean; copyLink?: boolean } = {},
): EstimateAction[] {
  const actions: EstimateAction[] = [];
  const copyLink = seams.copyLink !== false;
  switch (row.status) {
    case "draft":
      actions.push("edit", "send", "duplicate");
      break;
    case "sent":
    case "viewed":
      actions.push("resend", "revise", "mark_accepted", "mark_declined");
      if (copyLink) actions.push("copy_link");
      actions.push("duplicate");
      break;
    case "approved":
      if (seams.convert) actions.push("convert");
      if (seams.bookVisit) actions.push("book_visit");
      if (copyLink) actions.push("copy_link");
      actions.push("duplicate");
      break;
    case "rejected":
    case "expired":
      actions.push("reopen", "duplicate");
      break;
    case "converted":
      actions.push("duplicate");
      break;
  }
  actions.push(row.archivedAt ? "unarchive" : "archive");
  return actions;
}

// --- Editing (one transaction each) --------------------------------------------------------

/** Lock this tenant's estimate for the transaction; null when it is not theirs. */
export async function lockEstimate(tx: EstimatorDb, tenantId: string, id: string): Promise<EstimateRow | null> {
  const [row] = (await tx
    .select()
    .from(estimatorEstimates)
    .where(and(eq(estimatorEstimates.id, id), eq(estimatorEstimates.tenantId, tenantId)))
    .for("update")) as EstimateRow[];
  return row ?? null;
}

export const NOT_CHANGEABLE_MESSAGE = "This quote has been sent. Revise it to make changes.";

function notChangeable(row: Pick<EstimateRow, "status">): EstimatorInputError {
  return new EstimatorInputError(
    "not_changeable",
    row.status === "sent" || row.status === "viewed"
      ? NOT_CHANGEABLE_MESSAGE
      : row.status === "approved" || row.status === "converted"
        ? "This quote has been accepted, so it can't be changed. Duplicate it to make a new one."
        : "Reopen this quote to make changes.",
  );
}

/**
 * Recompute an estimate's totals from its lines, in the caller's transaction:
 * subtotal = Σ line totals, the range and its reasons, the cost, tax at the
 * estimate's own rate, the total. A discount bigger than the new subtotal is
 * refused (`discount_exceeds_subtotal`), rolling the edit back.
 */
export async function recomputeEstimate(
  tx: EstimatorDb,
  tenantId: string,
  id: string,
  options: { now?: Date; row?: EstimateRow } = {},
): Promise<EstimateRow> {
  const row = options.row ?? (await getEstimateRow(tx, tenantId, id));
  if (!row) throw new EstimatorInputError("item_unavailable", "That estimate isn't available.");
  const items = (await tx
    .select()
    .from(estimatorEstimateItems)
    .where(eq(estimatorEstimateItems.estimateId, id))) as EstimateItemRow[];
  const summary = summarize(items);
  if (row.discount > summary.subtotal) throw refuseDiscount(row.discount, summary.subtotal);
  const totals = calculateTotals({ itemTotals: items.map((i) => i.total), taxRateBp: row.taxRateBp, discount: row.discount });
  const [updated] = (await tx
    .update(estimatorEstimates)
    .set({
      subtotal: totals.subtotal,
      taxAmount: totals.taxAmount,
      total: totals.total,
      rangeLow: summary.rangeLow,
      rangeHigh: summary.rangeHigh,
      rangeReasons: summary.rangeReasons,
      cost: summary.cost,
      updatedAt: options.now ?? new Date(),
    })
    .where(and(eq(estimatorEstimates.id, id), eq(estimatorEstimates.tenantId, tenantId)))
    .returning()) as EstimateRow[];
  return updated as EstimateRow;
}

export const updateEstimateSchema = z
  .object({
    customerName: z.preprocess(blankToNull, singleLine(200).nullable()),
    customerEmail: z.preprocess(blankToNull, z.string().trim().email("Enter an email address.").max(320).nullable()),
    customerPhone: z.preprocess(blankToNull, singleLine(60).nullable()),
    jobAddress: z.preprocess(blankToNull, singleLine(500).nullable()),
    notes: z.preprocess(blankToNull, z.string().max(2000).nullable()),
    internalNotes: z.preprocess(blankToNull, z.string().max(5000).nullable()),
    discount: centsField.max(100_000_000_000),
    taxRateBp: z.number().int().min(0, "Enter a rate from 0% to 30%.").max(3000, "Enter a rate from 0% to 30%."),
  })
  .partial();
export type UpdateEstimateInput = z.input<typeof updateEstimateSchema>;

/**
 * Edit an estimate's header: the customer's details, the notes, the discount,
 * the tax rate. Only a DRAFT may change (`not_changeable` otherwise: revise a
 * sent quote first), except `internalNotes`, which staff can always edit.
 * Null when the estimate isn't this tenant's.
 */
export async function updateEstimate(
  db: EstimatorDb,
  tenantId: string,
  id: string,
  patch: UpdateEstimateInput,
  options: EstimatorWriteOptions = {},
): Promise<EstimateRow | null> {
  const parsed = updateEstimateSchema.parse(patch);
  const now = options.now ?? new Date();
  return db.transaction(async (tx) => {
    const row = await lockEstimate(tx, tenantId, id);
    if (!row) return null;
    const keys = Object.keys(parsed);
    if (row.status !== "draft" && keys.some((key) => key !== "internalNotes")) throw notChangeable(row);
    if (keys.length === 0) return row;
    const [updated] = (await tx
      .update(estimatorEstimates)
      .set({ ...parsed, updatedAt: now })
      .where(and(eq(estimatorEstimates.id, id), eq(estimatorEstimates.tenantId, tenantId)))
      .returning()) as EstimateRow[];
    if ("discount" in parsed || "taxRateBp" in parsed) return recomputeEstimate(tx, tenantId, id, { now, row: updated as EstimateRow });
    return updated as EstimateRow;
  });
}

const MAX_LINES = 100;

/**
 * Add a line to a draft — priced from the price book (or staff's own price, or
 * a line of their own) — and recompute the totals, in one transaction. Null
 * when the estimate isn't this tenant's; `not_changeable` unless a draft; a
 * 101st line is a ZodError on `items`.
 */
export async function addEstimateItem(
  db: EstimatorDb,
  tenantId: string,
  estimateId: string,
  item: CreateEstimateItemInput,
  options: EstimatorWriteOptions = {},
): Promise<EstimateItemRow | null> {
  const parsed = createEstimateItemSchema.parse(item);
  const now = options.now ?? new Date();
  const settings = options.settings ?? (await getEstimatorSettings(db, tenantId));
  return db.transaction(async (tx) => {
    const row = await lockEstimate(tx, tenantId, estimateId);
    if (!row) return null;
    if (row.status !== "draft") throw notChangeable(row);
    const existing = (await tx
      .select({ id: estimatorEstimateItems.id, sortOrder: estimatorEstimateItems.sortOrder })
      .from(estimatorEstimateItems)
      .where(eq(estimatorEstimateItems.estimateId, estimateId))) as Array<{ id: string; sortOrder: number }>;
    if (existing.length >= MAX_LINES) {
      throw new z.ZodError([{ code: "custom", path: ["items"], message: "Up to 100 lines.", input: undefined }] as never);
    }
    const priced = await priceStaffItem(tx, tenantId, parsed, settings);
    const sortOrder = existing.reduce((max, line) => Math.max(max, line.sortOrder), -1) + 1;
    const [inserted] = (await tx
      .insert(estimatorEstimateItems)
      .values({ ...priced, estimateId, sortOrder })
      .returning()) as EstimateItemRow[];
    await recomputeEstimate(tx, tenantId, estimateId, { now, row });
    return inserted as EstimateItemRow;
  });
}

const REPRICE_KEYS = ["productId", "inputs", "quantity", "optionValueIds", "unitPrice", "laborPrice", "measurement", "takeoffId"] as const;

/**
 * A line patch: every field optional and NO defaults. (Deriving it from the
 * create schema with `.partial()` is zod 4's trap — a `.default()` survives,
 * so a patch of `{ notes }` would have come back with quantity 1.)
 */
export const updateEstimateItemSchema = z.object({
  productId: z.string().max(200).nullish(),
  description: z.string().trim().max(500).nullish(),
  measurement: measurementSchema.nullish(),
  inputs: customerInputsSchema.nullish(),
  quantity: z.number().int().min(1).max(1000).optional(),
  unitPrice: centsField.max(100_000_000).nullish(),
  laborPrice: centsField.max(100_000_000).optional(),
  optionValueIds: z.array(z.string().min(1).max(200)).max(50).optional(),
  notes: z.string().max(1000).nullish(),
  takeoffId: z.string().max(200).nullish(),
});

/**
 * Change a line of a draft. A patch that touches what the price comes from
 * (product, inputs, quantity, options, staff's price, labor) RE-PRICES the
 * line from the price book NOW — `unitPrice: null` returns a staff-priced line
 * to the price book — and the totals are recomputed, in one transaction. A
 * patch of only the description or notes changes only those. The customer's
 * corrections to a photo reading are kept as they were (staff edits are not
 * the customer's). Null when the estimate or line isn't this tenant's.
 */
export async function updateEstimateItem(
  db: EstimatorDb,
  tenantId: string,
  estimateId: string,
  itemId: string,
  patch: Partial<CreateEstimateItemInput>,
  options: EstimatorWriteOptions = {},
): Promise<EstimateItemRow | null> {
  const parsedPatch = updateEstimateItemSchema.parse(patch ?? {});
  const raw = (patch ?? {}) as Record<string, unknown>;
  // A key the caller SENT (null included: `unitPrice: null` means "back to the price book").
  const has = (key: string) => Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined;
  const now = options.now ?? new Date();
  const settings = options.settings ?? (await getEstimatorSettings(db, tenantId));
  return db.transaction(async (tx) => {
    const row = await lockEstimate(tx, tenantId, estimateId);
    if (!row) return null;
    if (row.status !== "draft") throw notChangeable(row);
    const [item] = (await tx
      .select()
      .from(estimatorEstimateItems)
      .where(and(eq(estimatorEstimateItems.id, itemId), eq(estimatorEstimateItems.estimateId, estimateId)))
      .limit(1)) as EstimateItemRow[];
    if (!item) return null;

    const reprice = REPRICE_KEYS.some((key) => has(key));
    let values: Partial<typeof estimatorEstimateItems.$inferInsert>;
    if (reprice) {
      const inputs = has("inputs") ? (parsedPatch.inputs ?? null) : item.inputs;
      const productChanged = has("productId") && (parsedPatch.productId || null) !== item.productId;
      const merged = createEstimateItemSchema.parse({
        productId: has("productId") ? parsedPatch.productId : item.productId,
        // A product line keeps its description unless the patch names one, or the product changed.
        description: has("description") ? parsedPatch.description : productChanged ? null : item.description,
        inputs,
        // A 0.2 line (no inputs) keeps being priced from its 0.2 measurement.
        measurement: has("measurement") ? parsedPatch.measurement : inputs === null && !productChanged ? item.measurement : null,
        quantity: has("quantity") ? parsedPatch.quantity : item.quantity,
        unitPrice: has("unitPrice") ? parsedPatch.unitPrice : item.priceOverridden ? item.unitPrice : null,
        laborPrice: has("laborPrice") ? parsedPatch.laborPrice : item.laborPrice,
        optionValueIds: has("optionValueIds") ? parsedPatch.optionValueIds : productChanged ? [] : Object.values(item.selectedOptions ?? {}),
        notes: has("notes") ? parsedPatch.notes : item.notes,
        takeoffId: has("takeoffId") ? parsedPatch.takeoffId : productChanged ? null : item.takeoffId,
      });
      values = await priceStaffItem(tx, tenantId, merged, settings, { corrections: productChanged ? null : (item.corrections ?? null) });
    } else {
      values = {};
      if (has("description")) {
        const description = parsedPatch.description?.trim();
        if (!description) throw needsDescription();
        values.description = description;
      }
      if (has("notes")) values.notes = parsedPatch.notes ?? null;
      if (Object.keys(values).length === 0) return item;
    }
    const [updated] = (await tx
      .update(estimatorEstimateItems)
      .set(values)
      .where(and(eq(estimatorEstimateItems.id, itemId), eq(estimatorEstimateItems.estimateId, estimateId)))
      .returning()) as EstimateItemRow[];
    await recomputeEstimate(tx, tenantId, estimateId, { now, row });
    return updated as EstimateItemRow;
  });
}

/**
 * Remove a line from a draft and recompute, in one transaction. The last line
 * can go (an empty draft); sending refuses an empty estimate. False when the
 * estimate or line isn't this tenant's.
 */
export async function removeEstimateItem(
  db: EstimatorDb,
  tenantId: string,
  estimateId: string,
  itemId: string,
  options: EstimatorWriteOptions = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  return db.transaction(async (tx) => {
    const row = await lockEstimate(tx, tenantId, estimateId);
    if (!row) return false;
    if (row.status !== "draft") throw notChangeable(row);
    const removed = (await tx
      .delete(estimatorEstimateItems)
      .where(and(eq(estimatorEstimateItems.id, itemId), eq(estimatorEstimateItems.estimateId, estimateId)))
      .returning({ id: estimatorEstimateItems.id })) as Array<{ id: string }>;
    if (removed.length === 0) return false;
    await recomputeEstimate(tx, tenantId, estimateId, { now, row });
    return true;
  });
}

/**
 * A new draft (source "staff") with the same customer and lines, re-priced
 * NOW from the price book; no photos, no quote state. CONTRACT: a line that
 * can't be re-priced (its product retired since) is copied at its old price
 * as staff's own, so a duplicate never fails. Null when not this tenant's.
 */
export async function duplicateEstimate(
  db: EstimatorDb,
  tenantId: string,
  id: string,
  createdBy?: string,
  options: { now?: Date; settings?: EstimatorSettings } = {},
): Promise<CreatedEstimate | null> {
  const found = await getEstimate(db, tenantId, id);
  if (!found) return null;
  const now = options.now ?? new Date();
  const settings = options.settings ?? (await getEstimatorSettings(db, tenantId));
  const items: PricedItem[] = [];
  for (const line of found.items) {
    const copy: PricedItem = {
      productId: line.productId,
      description: line.description,
      measurement: line.measurement,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      laborPrice: line.laborPrice,
      total: line.total,
      lowTotal: line.total,
      highTotal: line.total,
      // A "quote requested" line stays unpriced (sending still asks for its price).
      priceOverridden: line.notes !== QUOTE_REQUEST_NOTE,
      cost: line.cost,
      recipe: line.recipe,
      inputs: line.inputs,
      derived: line.derived,
      takeoffId: null,
      corrections: null,
      selectedOptions: line.selectedOptions,
      optionSnapshot: line.optionSnapshot,
      notes: line.notes,
    };
    if (line.productId && !line.priceOverridden && line.notes !== QUOTE_REQUEST_NOTE) {
      try {
        items.push(
          await priceStaffItem(
            db,
            tenantId,
            createEstimateItemSchema.parse({
              productId: line.productId,
              description: line.description,
              inputs: line.inputs,
              measurement: line.inputs ? null : line.measurement,
              quantity: line.quantity,
              laborPrice: line.laborPrice,
              optionValueIds: Object.values(line.selectedOptions ?? {}),
              notes: line.notes,
            }),
            settings,
          ),
        );
        continue;
      } catch (error) {
        if (!(error instanceof EstimatorInputError)) throw error;
      }
    }
    items.push(copy);
  }
  const summary = summarize(items);
  const discount = Math.min(found.estimate.discount, summary.subtotal);
  const totals = calculateTotals({ itemTotals: items.map((i) => i.total), taxRateBp: found.estimate.taxRateBp, discount });
  const created = await insertEstimate(
    db,
    {
      tenantId,
      status: "draft",
      customerName: found.estimate.customerName,
      customerEmail: found.estimate.customerEmail,
      customerPhone: found.estimate.customerPhone,
      jobAddress: found.estimate.jobAddress,
      subtotal: totals.subtotal,
      taxRateBp: found.estimate.taxRateBp,
      taxAmount: totals.taxAmount,
      discount,
      total: totals.total,
      rangeLow: summary.rangeLow,
      rangeHigh: summary.rangeHigh,
      rangeReasons: summary.rangeReasons,
      currency: settings.currency,
      cost: summary.cost,
      notes: found.estimate.notes,
      internalNotes: found.estimate.internalNotes,
      source: "staff",
      photoUrl: null,
      createdBy: createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    },
    items,
  );
  return { ...created, subtotal: totals.subtotal, taxAmount: totals.taxAmount, total: totals.total, rangeLow: summary.rangeLow, rangeHigh: summary.rangeHigh };
}

/** Hide an estimate from the default queue (any status); false when not this tenant's. */
export async function archiveEstimate(db: EstimatorDb, tenantId: string, id: string, options: { now?: Date } = {}): Promise<boolean> {
  const now = options.now ?? new Date();
  const [row] = await db
    .update(estimatorEstimates)
    .set({ archivedAt: now, updatedAt: now })
    .where(and(eq(estimatorEstimates.id, id), eq(estimatorEstimates.tenantId, tenantId)))
    .returning({ id: estimatorEstimates.id });
  return row !== undefined;
}

export async function unarchiveEstimate(db: EstimatorDb, tenantId: string, id: string, options: { now?: Date } = {}): Promise<boolean> {
  const now = options.now ?? new Date();
  const [row] = await db
    .update(estimatorEstimates)
    .set({ archivedAt: null, updatedAt: now })
    .where(and(eq(estimatorEstimates.id, id), eq(estimatorEstimates.tenantId, tenantId)))
    .returning({ id: estimatorEstimates.id });
  return row !== undefined;
}

// --- The queue -------------------------------------------------------------------------------

export const ESTIMATE_FILTERS: readonly EstimateFilter[] = [
  "all",
  "leads",
  "drafts",
  "sent",
  "accepted",
  "declined",
  "expired",
  "converted",
  "archived",
];
export type { EstimateFilter } from "./wire.js";

const e = estimatorEstimates;

/** Each filter as SQL. Every filter but `archived` leaves archived estimates out. */
function filterSql(filter: EstimateFilter): SQL {
  const live = sql`${e.archivedAt} is null`;
  switch (filter) {
    case "all":
      return live;
    case "leads":
      return sql`${live} and ${e.status} = 'draft' and ${e.source} <> 'staff' and ${e.sentAt} is null`;
    case "drafts":
      return sql`${live} and ${e.status} = 'draft' and (${e.source} = 'staff' or ${e.sentAt} is not null)`;
    case "sent":
      return sql`${live} and ${e.status} in ('sent', 'viewed')`;
    case "accepted":
      return sql`${live} and ${e.status} = 'approved'`;
    case "declined":
      return sql`${live} and ${e.status} = 'rejected'`;
    case "expired":
      return sql`${live} and ${e.status} = 'expired'`;
    case "converted":
      return sql`${live} and ${e.status} = 'converted'`;
    case "archived":
      return sql`${e.archivedAt} is not null`;
  }
}

export const searchEstimatesSchema = z.object({
  filter: z.enum(ESTIMATE_FILTERS as unknown as [EstimateFilter, ...EstimateFilter[]]).default("all"),
  q: z.string().trim().max(100).optional(),
  source: z.enum(["public_tool", "photo", "staff"]).optional(),
  cursor: z.string().max(400).nullish(),
  limit: z.number().int().min(1).max(100).default(50),
});

function encodeCursor(createdAt: string, id: string): string {
  return btoa(JSON.stringify([createdAt, id])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const padded = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const value = JSON.parse(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))) as unknown;
    if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string" && !Number.isNaN(Date.parse(value[0]))) {
      return { createdAt: value[0], id: value[1] };
    }
  } catch {
    /* not one of ours */
  }
  return null;
}

/**
 * The queue: newest first (`created_at desc, id desc`), one filter, a search
 * (`q`: number, name, email, phone, address), a source, and an opaque cursor
 * for "Load more". `counts` is every filter's count in one query and ignores
 * `q`, `source` and the cursor, so the chips don't jump while staff search.
 */
export async function searchEstimates(
  db: EstimatorDb,
  tenantId: string,
  query: z.input<typeof searchEstimatesSchema> = {},
): Promise<{ rows: EstimateListRow[]; nextCursor: string | null; counts: Record<EstimateFilter, number> }> {
  const parsed = searchEstimatesSchema.parse(query);
  const conditions: SQL[] = [sql`${e.tenantId} = ${tenantId}`, filterSql(parsed.filter)];
  if (parsed.q) {
    const pattern = `%${parsed.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    conditions.push(
      sql`(${e.estimateNumber} ilike ${pattern} or coalesce(${e.customerName}, '') ilike ${pattern} or coalesce(${e.customerEmail}, '') ilike ${pattern} or coalesce(${e.customerPhone}, '') ilike ${pattern} or coalesce(${e.jobAddress}, '') ilike ${pattern})`,
    );
  }
  if (parsed.source) conditions.push(sql`${e.source} = ${parsed.source}`);
  const cursor = parsed.cursor ? decodeCursor(parsed.cursor) : null;
  if (cursor) conditions.push(sql`(${e.createdAt}, ${e.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id})`);

  const rows = (await db
    .select({
      row: estimatorEstimates,
      cursorAt: sql<string>`to_char(${e.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      // Qualified by hand: inside a select list drizzle writes a column bare,
      // and "id" would be ambiguous in the subqueries.
      photoCount: sql<number>`(select count(*)::int from estimator_photos p where p.tenant_id = estimator_estimates.tenant_id and p.estimate_id = estimator_estimates.id)`,
      hasReading: sql<boolean>`exists (select 1 from estimator_estimate_items i join estimator_takeoffs t on t.id = i.takeoff_id where i.estimate_id = estimator_estimates.id and t.tenant_id = estimator_estimates.tenant_id and t.status = 'read')`,
    })
    .from(estimatorEstimates)
    .where(sql.join(conditions, sql` and `))
    .orderBy(desc(e.createdAt), desc(e.id))
    .limit(parsed.limit + 1)) as Array<{ row: EstimateRow; cursorAt: string; photoCount: number | string; hasReading: boolean }>;

  const page = rows.slice(0, parsed.limit);
  const last = page.at(-1);
  const nextCursor = rows.length > parsed.limit && last ? encodeCursor(last.cursorAt, last.row.id) : null;

  const countFields = Object.fromEntries(
    ESTIMATE_FILTERS.map((filter) => [filter, sql<number>`count(*) filter (where ${filterSql(filter)})::int`]),
  );
  const [countRow] = (await db
    .select(countFields)
    .from(estimatorEstimates)
    .where(eq(estimatorEstimates.tenantId, tenantId))) as Array<Record<string, number | string>>;
  const counts = Object.fromEntries(ESTIMATE_FILTERS.map((filter) => [filter, Number(countRow?.[filter] ?? 0)])) as Record<
    EstimateFilter,
    number
  >;

  return {
    rows: page.map(({ row, photoCount, hasReading }) => ({
      id: row.id,
      number: row.estimateNumber,
      status: row.status as EstimateStatus,
      source: row.source as EstimateSource,
      customerName: row.customerName,
      customerEmail: row.customerEmail,
      jobAddress: row.jobAddress,
      total: row.total,
      rangeLow: row.rangeLow,
      rangeHigh: row.rangeHigh,
      currency: row.currency,
      photoCount: Number(photoCount),
      hasReading: Boolean(hasReading),
      validUntil: row.validUntil ? row.validUntil.toISOString() : null,
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    nextCursor,
    counts,
  };
}

// --- Before a quote is sent ------------------------------------------------------------------

/**
 * Each line still showing a RANGE, in words staff read before they send
 * (review EST-R05): the quote charges the line's point price, and that rests
 * on an assumption the customer never measured.
 *
 *   "Line 1 (Modular aluminum ramp) is priced at 3 steps, 7.5 in each
 *    (estimated), 23 ft of ramp. The range was $6,490 – $7,146 (Step height
 *    7–8 in (estimated)): measure first, or send it as is."
 *
 * The editor shows these beside "Send quote" (`EstimateDetail.sendWarnings`)
 * and `sendQuote` answers them again; every number is the line's own.
 */
export function sendWarningsFor(
  items: ReadonlyArray<Pick<EstimateItemRow, "description" | "lowTotal" | "highTotal" | "derived" | "sortOrder">>,
  money: { currency: string; locale: string },
): string[] {
  const warnings: string[] = [];
  [...items]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .forEach((item, index) => {
      if (item.lowTotal === item.highTotal) return;
      const derived = derivedOf(item);
      const basis = derived.quoteBasis ?? derived.inputsSummary ?? null;
      const reasons = Array.isArray(derived.reasons) && derived.reasons.length > 0 ? ` (${derived.reasons.join("; ")})` : "";
      const range = `${formatMoney(item.lowTotal, money, true)} – ${formatMoney(item.highTotal, money, true)}`;
      warnings.push(
        `Line ${index + 1} (${item.description}) is priced at ${basis ?? "the middle of its range"}. The range was ${range}${reasons}: measure first, or send it as is.`,
      );
    });
  return warnings;
}

// --- The staff detail ------------------------------------------------------------------------

function timelineOf(row: EstimateRow): Array<{ at: string; label: string }> {
  const entered = row.enteredAt ? [{ at: row.enteredAt, label: "Entered from past records" }] : [];
  const entries: Array<{ at: Date; label: string }> = [
    { at: row.createdAt, label: row.source === "staff" ? "Created" : "Lead received" },
  ];
  if (row.sentAt) entries.push({ at: row.sentAt, label: row.quoteSequence > 1 ? "Quote sent again" : "Quote sent" });
  if (row.viewedAt) entries.push({ at: row.viewedAt, label: "Viewed" });
  if (row.approvedAt) entries.push({ at: row.approvedAt, label: row.responseName ? `Accepted by ${row.responseName}` : "Accepted" });
  if (row.rejectedAt) entries.push({ at: row.rejectedAt, label: "Declined" });
  if (row.expiredAt) entries.push({ at: row.expiredAt, label: "Expired" });
  if (row.convertedAt) entries.push({ at: row.convertedAt, label: "Turned into an invoice" });
  if (row.archivedAt) entries.push({ at: row.archivedAt, label: "Archived" });
  entries.push(...entered);
  return entries.sort((a, b) => a.at.getTime() - b.at.getTime()).map((entry) => ({ at: entry.at.toISOString(), label: entry.label }));
}

/**
 * The staff view of one estimate (`EstimateDetail` less `links`, which the
 * admin handler adds): every line with its derivation, the photo reading
 * beside the final answer and the customer's corrections, the photos (with a
 * URL staff can open now), what the editor offers, and a timeline. Without
 * `includeCosts` every cost and margin is null. Null when not this tenant's.
 */
export async function getEstimateDetail(
  db: EstimatorDb,
  tenantId: string,
  id: string,
  options: {
    photoStore?: EstimatorPhotoStore;
    /** Where staff's own photos are (review SEC-02); default `photoStore`. */
    staffPhotoStore?: EstimatorPhotoStore;
    includeCosts?: boolean;
    now?: Date;
    seams?: { convert?: boolean; bookVisit?: boolean; copyLink?: boolean };
    /** For the money in `sendWarnings`. Default "en-US". */
    locale?: string;
  } = {},
): Promise<Omit<EstimateDetail, "links"> | null> {
  const found = await getEstimate(db, tenantId, id);
  if (!found) return null;
  const { estimate: row, items } = found;
  const costs = options.includeCosts === true;

  const takeoffIds = [...new Set(items.map((i) => i.takeoffId).filter((v): v is string => Boolean(v)))];
  const takeoffs =
    takeoffIds.length === 0
      ? []
      : ((await db
          .select()
          .from(estimatorTakeoffs)
          .where(and(eq(estimatorTakeoffs.tenantId, tenantId), inArray(estimatorTakeoffs.id, takeoffIds)))) as TakeoffRow[]);
  const productIds = [...new Set(takeoffs.map((t) => t.productId))];
  const products =
    productIds.length === 0
      ? []
      : ((await db
          .select()
          .from(estimatorProducts)
          .where(and(eq(estimatorProducts.tenantId, tenantId), inArray(estimatorProducts.id, productIds)))) as ProductRow[]);

  const readingOf = (takeoffId: string | null): ReadingWire | null => {
    if (!takeoffId) return null;
    const t = takeoffs.find((candidate) => candidate.id === takeoffId);
    if (!t || (t.status !== "read" && t.status !== "unreadable")) return null;
    const recipe = (t.recipe === "count" ? "count" : "ramp_over_steps") as ReadingRecipe;
    const product = products.find((p) => p.id === t.productId);
    const config = product ? recipeOf(product).config : recipeOf({ recipe, measurementMode: "linear", recipeConfig: null }).config;
    const observation = t.status === "read" ? normalizeObservation(recipe, t.observation) : null;
    // Staff wording: what the photo showed, without the customer's "you can
    // change the count" (review EST-R11).
    const suggestion = suggestFromObservation(recipe, config, observation, "staff");
    return {
      takeoffId: t.id,
      status: t.status === "read" ? "read" : "unreadable",
      confidence: ((t.confidence as Confidence | null) ?? observation?.confidence ?? "low") as Confidence,
      lines: suggestion.lines,
      suggested: suggestion.suggested,
      heightRangeIn: suggestion.heightRangeIn,
      model: t.model,
      costMicros: costs ? t.costMicros : null,
      createdAt: t.createdAt.toISOString(),
    };
  };

  const lines: EstimateLineWire[] = items.map((item) => {
    const derived = derivedOf(item);
    return {
      id: item.id,
      productId: item.productId,
      description: item.description,
      recipe: item.recipe && (RECIPE_KEYS as readonly string[]).includes(item.recipe) ? (item.recipe as RecipeKey) : null,
      inputs: item.inputs ?? null,
      inputsSummary: derived.inputsSummary ?? null,
      explanation: Array.isArray(derived.explanation) ? [...derived.explanation] : [],
      assumption: derived.assumption ?? null,
      reasons: item.lowTotal !== item.highTotal && Array.isArray(derived.reasons) ? [...derived.reasons] : [],
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      laborPrice: item.laborPrice,
      total: item.total,
      lowTotal: item.lowTotal,
      highTotal: item.highTotal,
      priceOverridden: item.priceOverridden,
      options: (item.optionSnapshot ?? []).map((o) => ({ ...o })),
      reading: readingOf(item.takeoffId),
      corrections: Array.isArray(item.corrections) ? [...item.corrections] : [],
      cost: costs ? item.cost : null,
      notes: item.notes,
      sortOrder: item.sortOrder,
    };
  });

  const photos: EstimatePhoto[] = await listEstimatePhotos(db, tenantId, id, options.photoStore, options.staffPhotoStore);
  const revenue = row.subtotal - row.discount;
  const marginBp = costs && row.cost !== null ? (revenue > 0 ? Math.round(((revenue - row.cost) / revenue) * 10_000) : 0) : null;
  const iso = (value: Date | null) => (value ? value.toISOString() : null);

  return {
    id: row.id,
    number: row.estimateNumber,
    status: row.status as EstimateStatus,
    source: row.source as EstimateSource,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    customerPhone: row.customerPhone,
    jobAddress: row.jobAddress,
    notes: row.notes,
    currency: row.currency,
    subtotal: row.subtotal,
    discount: row.discount,
    taxRateBp: row.taxRateBp,
    taxAmount: row.taxAmount,
    total: row.total,
    rangeLow: row.rangeLow,
    rangeHigh: row.rangeHigh,
    rangeReasons: Array.isArray(row.rangeReasons) ? [...row.rangeReasons] : [],
    validUntil: iso(row.validUntil),
    sentAt: iso(row.sentAt),
    viewedAt: iso(row.viewedAt),
    respondedAt: iso(row.respondedAt),
    approvedAt: iso(row.approvedAt),
    rejectedAt: iso(row.rejectedAt),
    expiredAt: iso(row.expiredAt),
    convertedAt: iso(row.convertedAt),
    archivedAt: iso(row.archivedAt),
    responseName: row.responseName,
    responseNote: row.responseNote,
    quoteMessage: row.quoteMessage,
    quoteSequence: row.quoteSequence,
    photoCount: photos.length,
    internalNotes: row.internalNotes,
    cost: costs ? row.cost : null,
    marginBp,
    lines,
    photos,
    actions: staffActionsFor(row, options.now ?? new Date(), options.seams ?? {}),
    sendWarnings: row.status === "draft" ? sendWarningsFor(items, { currency: row.currency, locale: options.locale ?? "en-US" }) : [],
    timeline: timelineOf(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    enteredAt: iso(row.enteredAt ?? null),
    enteredBy: row.enteredBy ?? null,
  };
}

/** The staff-only extras a staff email shows: the photo count, and each line's reading and corrections. */
export interface EstimateStaffDetail {
  photoCount: number;
  lines: Array<{ description: string; reading: { lines: string[]; confidence: Confidence } | null; corrections: Correction[] }>;
}

export function staffDetailOf(detail: Omit<EstimateDetail, "links">): EstimateStaffDetail {
  return {
    photoCount: detail.photos.length,
    lines: detail.lines.map((line) => ({
      description: line.description,
      reading: line.reading ? { lines: [...line.reading.lines], confidence: line.reading.confidence } : null,
      corrections: [...line.corrections],
    })),
  };
}

