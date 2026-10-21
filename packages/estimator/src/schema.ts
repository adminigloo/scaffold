import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, updatedAt } from "./columns.js";

/**
 * The estimator's data model — a priceable catalog and the estimates built
 * from it, generalized from the SG Glass & Metal estimator to serve any trade
 * (ramps, glass, fencing, decks).
 *
 * Money is `bigint` minor units (cents) throughout — the house money rule —
 * marshalled to plain numbers (`mode: "number"`) because an estimate is far
 * inside the safe-integer range and the pricing engine works in numbers.
 * Ratios and percentages are integer basis points (bp): 10_000 = 100%.
 *
 * `tenantId` / `createdBy` are plain text with no foreign key — the
 * cross-package rule every schema here follows, so a consumer is never forced
 * to also install @adminigloo/tenancy or /auth. Catalog rows deactivate rather
 * than delete, so an old estimate's line items never dangle.
 *
 * 0.2.0 added `estimator_options.show_in_estimator`, `estimator_estimate_items
 * .option_snapshot`, and made (tenant_id, estimate_number) UNIQUE.
 *
 * 0.3.0 adds four tables (`estimator_settings`, `estimator_quote_tokens`,
 * `estimator_photos`, `estimator_takeoffs`) and columns on the other six.
 * The upgrade SQL and a full CREATE script for hosts whose migrations aren't
 * drizzle's are in the README (a test runs the CREATE script against these
 * tables, so the two can't drift).
 * THE UPGRADE RULE: every new column is nullable or has a default, so
 * `drizzle-kit generate` writes plain ALTERs. Where a new column changes
 * behaviour, its DATABASE default reproduces 0.2 for rows written before 0.3
 * (or by hand), and the package's 0.3 create schemas set the new behaviour for
 * rows written through it — `range_mode` is 'percent' here and 'measured' in
 * `createProductSchema`. Each such column says so. Run your db:generate +
 * db:migrate, then the two backfill UPDATEs in the README ("Upgrading from 0.2").
 */

/** cents, non-null, defaults to 0. */
const money = (name: string) => bigint(name, { mode: "number" }).notNull().default(0);
/** cents, nullable — an unset per-unit rate. */
const moneyNull = (name: string) => bigint(name, { mode: "number" });
/** An instant, nullable: stamped by the move that causes it. */
const instant = (name: string) => timestamp(name, { withTimezone: true });

/**
 * A business's estimator settings: one row per tenant (0.3). A tenant with no
 * row reads `DEFAULT_ESTIMATOR_SETTINGS`; the defaults below are those values,
 * so a row inserted with nothing but a tenant (the sample catalog's) reads the
 * same as no row at all. `saved_at` is what "the owner has saved settings"
 * means — NOT "a row exists": loading the sample catalog creates the row
 * without saving it, and the admin keeps asking for the business's details.
 */
export const estimatorSettings = pgTable(
  "estimator_settings",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    businessName: text("business_name").notNull().default(""),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    /** Up to 5 addresses for new-lead and quote-answer notices. */
    leadNotifyEmails: jsonb("lead_notify_emails").$type<string[]>().notNull().default([]),
    /** ISO 4217. Display only: nothing is ever converted. */
    currency: text("currency").notNull().default("USD"),
    /** A BCP 47 tag for number formatting. The copy is English whatever it is. */
    locale: text("locale").notNull().default("en-US"),
    /** IANA zone: the dates on quotes and in emails are written in it. */
    timeZone: text("time_zone").notNull().default("UTC"),
    /** 825 = 8.25%, `DEFAULT_TAX_RATE_BP` — 0.2's behaviour. The admin flags it until saved. */
    taxRateBp: integer("tax_rate_bp").notNull().default(825),
    quoteValidDays: integer("quote_valid_days").notNull().default(30),
    /** 0 = no follow-up. */
    followUpDays: integer("follow_up_days").notNull().default(3),
    /** Printed at the bottom of every quote ("Price includes installation and haul-away."). */
    quoteFooter: text("quote_footer"),
    /** Cents per hour, for a product with no labor rate of its own. */
    defaultLaborRateCents: money("default_labor_rate_cents"),
    /** The ± added to a measured range (rule C). A product may override. */
    contingencyBp: integer("contingency_bp").notNull().default(0),
    /** false pauses the public tool and the embed. */
    instantEstimatesEnabled: boolean("instant_estimates_enabled").notNull().default(true),
    photosEnabled: boolean("photos_enabled").notNull().default(true),
    /** The most photo reading may cost per UTC day, in cents. 0 = reading off. */
    aiDailyBudgetCents: integer("ai_daily_budget_cents").notNull().default(100),
    /** Readings one requester may trigger per UTC day. 0 = reading off. */
    aiPerRequesterDaily: integer("ai_per_requester_daily").notNull().default(5),
    /** `#rrggbb`: the widget's and the quote page's accent. */
    brandColor: text("brand_color"),
    /** Set by `loadSampleCatalog`; a second load is refused. */
    sampleLoadedAt: instant("sample_loaded_at"),
    /** Set by every `updateEstimatorSettings`. `saved` on the wire is `saved_at IS NOT NULL`. */
    savedAt: instant("saved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("estimator_settings_tenant_idx").on(t.tenantId)],
);

/**
 * A priceable thing: a shower door, a wheelchair ramp, a fence panel. Carries
 * every knob the engine reads.
 *
 * 0.3: what the CUSTOMER is asked, and how that becomes the priced quantity,
 * is the product's measurement RECIPE (`recipe`, `recipe_config`; see
 * recipes.ts). The price is built from the owner's supplies (the attachments'
 * `per`), labor hours × a rate, waste, and markup or a target margin
 * (build.ts). `measurement_mode` is kept in step with the recipe on every
 * write, because 0.1 widgets and 0.2 hosts still read it.
 */
export const estimatorProducts = pgTable(
  "estimator_products",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    category: text("category"),
    name: text("name").notNull(),
    description: text("description"),
    /** "area" (width×height), "linear" (linear feet), or "unit" (a count). Follows `recipe` from 0.3. */
    measurementMode: text("measurement_mode").notNull().default("area"),
    /**
     * `ramp_over_steps | area | linear | count` (0.3). NULL = a product from
     * before 0.3: its recipe follows `measurement_mode` (area → area in
     * inches, linear → linear, unit → count). Every 0.3 write sets it.
     */
    recipe: text("recipe"),
    /** The recipe's settings. Null or missing keys → the recipe's defaults (`resolveRecipeConfig`). */
    recipeConfig: jsonb("recipe_config").$type<Record<string, unknown>>(),
    /**
     * Ask the customer "How many ramps?". The DB default TRUE reproduces 0.2,
     * which always asked; `createProductSchema` defaults it to FALSE. Ignored
     * for a count recipe (the count is the question).
     */
    allowMultiple: boolean("allow_multiple").notNull().default(true),
    /** Null → `How many ${resultNoun.many}?`. */
    multipleLabel: text("multiple_label"),
    maxQuantity: integer("max_quantity").notNull().default(10),
    /** Lump costs (0.2's price knobs), shown under "Other costs" when non-zero. */
    basePrice: money("base_price"),
    pricePerSqFt: moneyNull("price_per_sqft"),
    pricePerLinearFt: moneyNull("price_per_linear_ft"),
    laborCost: money("labor_cost"),
    /** Thousandths of an hour per unit of the recipe's primary measure (per ft of ramp, per sq ft, per item). */
    laborHoursPerUnitMilli: integer("labor_hours_per_unit_milli").notNull().default(0),
    /** Thousandths of an hour, once per line (loading, travel, set-up). */
    laborSetupHoursMilli: integer("labor_setup_hours_milli").notNull().default(0),
    /** Cents per hour; null → the settings' `default_labor_rate_cents`. */
    laborRateCents: moneyNull("labor_rate_cents"),
    /** Material waste/overage, bp of what is bought by the foot or square foot. */
    wasteBp: integer("waste_bp").notNull().default(0),
    /** `markup | margin`. */
    pricingBasis: text("pricing_basis").notNull().default("markup"),
    /** Markup on cost, bp. */
    markupBp: integer("markup_bp").notNull().default(0),
    /** Target margin, bp (≤ 9500), when `pricing_basis = 'margin'`. */
    marginBp: integer("margin_bp").notNull().default(0),
    /** Never quote this product below this, cents. */
    minimumCharge: money("minimum_charge"),
    /**
     * `measured | percent`. The DB default 'percent' reproduces 0.2's flat band
     * for old rows; `createProductSchema` defaults to 'measured' (the range
     * comes from the measurement's own low and high, rule C).
     */
    rangeMode: text("range_mode").notNull().default("percent"),
    /** 0–5000 bp; null → the settings' `contingency_bp`. Measured mode only. */
    contingencyBp: integer("contingency_bp"),
    /** Read in `percent` mode only. */
    estimateLowBp: integer("estimate_low_bp").notNull().default(9000),
    estimateHighBp: integer("estimate_high_bp").notNull().default(11500),
    /** In the public instant-estimate tool, or staff-only. */
    showInEstimator: boolean("show_in_estimator").notNull().default(true),
    /** false = "request a quote" (no math, a person prices it). */
    isEstimatable: boolean("is_estimatable").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("estimator_products_tenant_idx").on(t.tenantId, t.isActive)],
);

/**
 * A supply in the owner's library (the API keeps the name "component"; the
 * screens say "supply"): aluminum ramp section, handrail, a permit. `unit_type`
 * is the SUPPLIER's unit, for display ("per ft", "per sq ft", "each", "flat");
 * how much of it a product uses, and per what, is on the attachment.
 */
export const estimatorComponents = pgTable(
  "estimator_components",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    /** per_sqft | per_linear_ft | per_unit | flat */
    unitType: text("unit_type").notNull().default("flat"),
    /** Cents per supplier unit. Staff-only: never on a public wire. */
    unitCost: money("unit_cost"),
    supplier: text("supplier"),
    sku: text("sku"),
    /** "Price as of Oct 2026". */
    note: text("note"),
    /**
     * The host's own reference for this supply — a SKU or a service code in a
     * price list it already keeps (0.3). Unique per business, so a sync job
     * can `upsertComponentByRef` the same row every night.
     */
    externalRef: text("external_ref"),
    /**
     * The cost comes from the host's own price list (a sync job owns it): the
     * admin shows it read-only and refuses a cost change, so the next sync
     * never silently undoes an owner's edit (0.3).
     */
    managedExternally: boolean("managed_externally").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("estimator_components_tenant_idx").on(t.tenantId, t.isActive),
    // NULLs are distinct in a unique index: only supplies WITH a reference collide.
    uniqueIndex("estimator_components_tenant_ref_uniq").on(t.tenantId, t.externalRef),
  ],
);

/** A supply on a product (the bill of materials), with how much of it per what. */
export const estimatorProductComponents = pgTable(
  "estimator_product_components",
  {
    id: idColumn(),
    productId: text("product_id").notNull(),
    componentId: text("component_id").notNull(),
    /** Thousandths: 1000 = 1.0 of the supplier's unit, per `per`. */
    quantityMilli: integer("quantity_milli").notNull().default(1000),
    /**
     * What `quantity_milli` is per (0.3): one of the product recipe's quantity
     * keys (`rampFt`, `landings`, `sqFt`, `perimeterFt`, `linearFt`), `item`
     * (once per item of the line) or `job` (once per line). NULL = 0.2's
     * behaviour: scale by the supply's `unit_type`.
     */
    per: text("per"),
    /**
     * Bought whole (0.3): the quantity is rounded UP to a whole supplier unit
     * per item before it is priced — a post every 4 ft on a 21-ft ramp is 6
     * posts, not 5.25. Rounding up is the spare, so no waste is added on top.
     * The DB default (false) keeps rows written before it pricing as they did;
     * `attachComponent` turns it on for an "each" supply unless told not to.
     */
    roundUp: boolean("round_up").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("estimator_product_components_product_idx").on(t.productId)],
);

/** A choice offered on a product: glass type, hardware finish, railing style. */
export const estimatorOptions = pgTable(
  "estimator_options",
  {
    id: idColumn(),
    productId: text("product_id").notNull(),
    name: text("name").notNull(),
    /** Free-form (glass_type, finish, style…) — no enum, so any trade fits. */
    optionType: text("option_type").notNull().default("custom"),
    /**
     * Offered in the public instant-estimate tool, or staff-only (a rush fee,
     * a site-access surcharge). A hidden option is left out of every public
     * option read AND ignored by public pricing, so a browser cannot price
     * with a value it was never shown. (0.2.0)
     */
    showInEstimator: boolean("show_in_estimator").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("estimator_options_product_idx").on(t.productId)],
);

/**
 * One selectable value of an option, with the cents it adds. From 0.3 the
 * modifier is a PRICE (added after markup): the customer sees "+$120" and
 * pays $120.
 */
export const estimatorOptionValues = pgTable(
  "estimator_option_values",
  {
    id: idColumn(),
    optionId: text("option_id").notNull(),
    label: text("label").notNull(),
    priceModifier: money("price_modifier"),
    isDefault: boolean("is_default").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("estimator_option_values_option_idx").on(t.optionId)],
);

/** A measurement captured on an estimate line — whatever the trade needed (0.2's shape). */
export interface EstimateItemMeasurement {
  widthIn?: number;
  heightIn?: number;
  sqFt?: number;
  linearFt?: number;
  units?: number;
}

/**
 * The priced-at-submit record of one chosen option value, stored on the line.
 * Labels and modifiers change in the price book; the estimate must keep saying
 * what the customer picked and what it cost at the time.
 */
export interface EstimateItemOptionSnapshot {
  optionId: string;
  optionName: string;
  valueId: string;
  valueLabel: string;
  /** Cents this value added to ONE of the product when priced. */
  priceModifier: number;
}

/** A saved estimate. Money in cents; status is its lifecycle. */
export const estimatorEstimates = pgTable(
  "estimator_estimates",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    estimateNumber: text("estimate_number").notNull(),
    /**
     * draft | sent | viewed | approved | rejected | expired | converted —
     * moved only along `ESTIMATE_STATUS_TRANSITIONS`; `converted` is terminal.
     */
    status: text("status").notNull().default("draft"),
    customerName: text("customer_name"),
    customerEmail: text("customer_email"),
    customerPhone: text("customer_phone"),
    jobAddress: text("job_address"),
    subtotal: money("subtotal"),
    taxRateBp: integer("tax_rate_bp").notNull().default(825),
    taxAmount: money("tax_amount"),
    discount: money("discount"),
    total: money("total"),
    /** Σ lines' `low_total`, pre-tax: what the customer was shown. Backfill = subtotal. */
    rangeLow: money("range_low"),
    /** Σ lines' `high_total`. Backfill = subtotal. */
    rangeHigh: money("range_high"),
    /** Why the range is wide ("Step height 7–8 in (estimated)"). */
    rangeReasons: jsonb("range_reasons").$type<string[]>(),
    /** The settings' currency when the estimate was made. */
    currency: text("currency").notNull().default("USD"),
    /** Σ lines' cost at the point price. Staff-only: never on a public or quote wire, never in an event. */
    cost: moneyNull("cost"),
    notes: text("notes"),
    internalNotes: text("internal_notes"),
    /** How it arrived: "public_tool", "photo", "staff". */
    source: text("source").notNull().default("staff"),
    /** A staff-set photo URL (0.2). 0.3 photos live in `estimator_photos`. */
    photoUrl: text("photo_url"),
    /** The note staff wrote when sending; top of the quote and the email. */
    quoteMessage: text("quote_message"),
    /** +1 on every send (not resend). Versions the follow-up. */
    quoteSequence: integer("quote_sequence").notNull().default(0),
    /** Set on send: now + validDays × 24 h. */
    validUntil: instant("valid_until"),
    sentAt: instant("sent_at"),
    /** The FIRST view. */
    viewedAt: instant("viewed_at"),
    respondedAt: instant("responded_at"),
    approvedAt: instant("approved_at"),
    rejectedAt: instant("rejected_at"),
    expiredAt: instant("expired_at"),
    convertedAt: instant("converted_at"),
    /** Hides it from the default queue. */
    archivedAt: instant("archived_at"),
    /**
     * When the expiry was announced (the `quote.expired` event handed to the
     * listener). An expiry the cron marked but was cut off before announcing
     * stays null, and the next run announces it (0.3).
     */
    expiryNotifiedAt: instant("expiry_notified_at"),
    /** The name the customer typed when accepting. */
    responseName: text("response_name"),
    /** Their note on accept or decline. */
    responseNote: text("response_note"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /**
     * 0.7, past records: when and by whom an estimate made on an EARLIER day
     * (`occurredAt`) was typed in. Its own dates (created, sent, accepted…)
     * say when things happened; these say it was entered later. Null on an
     * estimate made the day it happened.
     */
    enteredAt: instant("entered_at"),
    enteredBy: text("entered_by"),
  },
  (t) => [
    index("estimator_estimates_tenant_idx").on(t.tenantId, t.status),
    // UNIQUE (0.2.0; was a plain index). Numbering reads the tenant's highest
    // number and adds one, so two submits in the same instant computed the
    // same EST-2026-0042 and both saved it — two customers, one reference.
    // The index makes the loser fail with 23505 and `createEstimate` retries
    // with a fresh number.
    uniqueIndex("estimator_estimates_tenant_number_uniq").on(t.tenantId, t.estimateNumber),
    // The queue pages newest first by (created_at, id) (0.3).
    index("estimator_estimates_tenant_created_idx").on(t.tenantId, t.createdAt),
    // The expiry sweep: this tenant's sent/viewed quotes past valid_until (0.3).
    index("estimator_estimates_tenant_valid_idx").on(t.tenantId, t.status, t.validUntil),
  ],
);

/**
 * One row per issued embed key. The row IS the licence: issuing a key lets a
 * customer's own website run the estimate widget for this tenant; revoking it
 * (revokedAt) turns the widget dark on the next request. Only the SHA-256 hash
 * is stored — the plaintext exists once, in the issuance response. `keyPrefix`
 * is the first few visible characters, kept plain so a row is recognizable in
 * the admin without ever revealing the secret.
 */
export const estimatorClientKeys = pgTable(
  "estimator_client_keys",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    label: text("label").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    /**
     * The websites this key works on (0.3): ≤ 20 lowercased `https://host[:port]`
     * origins. EMPTY = any origin — 0.2 keys keep working, and the admin flags
     * them ("Works on any website. Add yours.").
     */
    allowedOrigins: jsonb("allowed_origins").$type<string[]>().notNull().default([]),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("estimator_client_keys_hash_idx").on(t.keyHash),
    index("estimator_client_keys_tenant_idx").on(t.tenantId),
  ],
);

/** A line on an estimate. Measurement is jsonb (quantities, not money). */
export const estimatorEstimateItems = pgTable(
  "estimator_estimate_items",
  {
    id: idColumn(),
    estimateId: text("estimate_id").notNull(),
    productId: text("product_id"),
    description: text("description").notNull(),
    /**
     * 0.2's measurement shape, still written where one exists (`{ linearFt }`
     * for a ramp or a length, `{ widthIn, heightIn }` for an area in inches,
     * `{ sqFt }` for one in feet), so invoicing and 0.2 readers keep working.
     */
    measurement: jsonb("measurement").$type<EstimateItemMeasurement>(),
    quantity: integer("quantity").notNull().default(1),
    unitPrice: money("unit_price"),
    laborPrice: money("labor_price"),
    total: money("total"),
    /** The line's shown range, cents. Backfill = total. */
    lowTotal: money("low_total"),
    highTotal: money("high_total"),
    /** Staff typed the price (`unitPrice`). */
    priceOverridden: boolean("price_overridden").notNull().default(false),
    /** Cost at the point, cents. Staff-only. */
    cost: moneyNull("cost"),
    /** The recipe the line was priced with. */
    recipe: text("recipe"),
    /** The customer's inputs as finally priced (`{"steps":4,"stepHeightIn":null}`). */
    inputs: jsonb("inputs").$type<Record<string, number | null>>(),
    /** The `LineDerivation`: quantities low/point/high, the sentences, the assumption, the reasons. */
    derived: jsonb("derived").$type<Record<string, unknown>>(),
    /** The photo reading this line used (`estimator_takeoffs.id`). */
    takeoffId: text("takeoff_id"),
    /** Where the final input differs from what the reading suggested. */
    corrections: jsonb("corrections").$type<Array<{ field: string; label: string; from: number; to: number | null }>>(),
    /**
     * optionId → optionValueId chosen, as RESOLVED by the server against the
     * product's own options (never the caller's map, which named whatever it
     * liked). Empty when nothing was chosen.
     */
    selectedOptions: jsonb("selected_options").$type<Record<string, string>>(),
    /** What each chosen value was called and cost when priced. (0.2.0) */
    optionSnapshot: jsonb("option_snapshot").$type<EstimateItemOptionSnapshot[]>(),
    sortOrder: integer("sort_order").notNull().default(0),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [index("estimator_estimate_items_estimate_idx").on(t.estimateId)],
);

/**
 * The customer's quote links (0.3). Only the SHA-256 of each token is kept;
 * the plaintext leaves in one email (or one "copy the link" answer) and is
 * never stored. Several per estimate, for scheduling's reason: every email —
 * send, resend, follow-up, the accept confirmation — mints its own link, so no
 * event ever carries a secret, and every link keeps working.
 */
export const estimatorQuoteTokens = pgTable(
  "estimator_quote_tokens",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    estimateId: text("estimate_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    /**
     * The quote's `quote_sequence` when this link was minted. A link from an
     * earlier send stops working once the quote is sent again (a revision, or
     * a wrong email address corrected): only the newest version's links open
     * it. Null = minted before this column existed: still works.
     */
    quoteSequence: integer("quote_sequence"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("estimator_quote_tokens_hash_idx").on(t.tokenHash),
    index("estimator_quote_tokens_estimate_idx").on(t.tenantId, t.estimateId),
  ],
);

/**
 * A photo kept for the business (0.3): the bytes live in the injected photo
 * store (create-app wraps @adminigloo/storage); this row says whose it is and
 * which estimate it belongs to. Unlinked until a submit (or staff) attaches
 * it; `purgeOrphanPhotos` deletes the ones nobody ever submitted.
 */
export const estimatorPhotos = pgTable(
  "estimator_photos",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    estimateId: text("estimate_id"),
    /** The photo store's id for the bytes. */
    fileId: text("file_id").notNull(),
    /** Where staff open it. Never on a public wire. */
    url: text("url").notNull(),
    /** image/jpeg | image/png | image/webp — from the bytes, not the client. */
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    /** Hex SHA-256 of the bytes. */
    sha256: text("sha256").notNull(),
    /** public | staff */
    source: text("source").notNull().default("public"),
    /** Hex SHA-256 of `tenantId + ":" + requesterKey`, for the per-visitor photo cap (public photos only). */
    requesterHash: text("requester_hash"),
    createdAt: createdAt(),
    linkedAt: instant("linked_at"),
  },
  (t) => [
    index("estimator_photos_estimate_idx").on(t.tenantId, t.estimateId),
    index("estimator_photos_hash_idx").on(t.tenantId, t.sha256),
    index("estimator_photos_created_idx").on(t.tenantId, t.createdAt),
    index("estimator_photos_requester_idx").on(t.tenantId, t.requesterHash, t.createdAt),
  ],
);

/**
 * The photo-reading ledger AND cache (0.3). One row per model call: what was
 * read (the NORMALIZED observation, never the model's text), what it cost, and
 * who asked (hashed). The unique (tenant, product, photo hash) is the cache:
 * an identical photo for the same tenant and product never calls the AI twice
 * — and it is also the claim, so a double tap makes one call.
 */
export const estimatorTakeoffs = pgTable(
  "estimator_takeoffs",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    productId: text("product_id").notNull(),
    recipe: text("recipe").notNull(),
    /** Hex SHA-256 of the image bytes sent to the model. */
    photoHash: text("photo_hash").notNull(),
    /** The stored copy, when there is a photo store. */
    photoId: text("photo_id"),
    /** pending | read | unreadable | failed */
    status: text("status").notNull().default("pending"),
    observation: jsonb("observation").$type<Record<string, unknown>>(),
    /** low | medium | high */
    confidence: text("confidence"),
    /** The exact model id called. */
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Millionths of a US dollar (the provider prices in USD, whatever the business's currency). */
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    /** True when the call failed before usage came back and `cost_micros` is the conservative ceiling. */
    costEstimated: boolean("cost_estimated").notNull().default(false),
    /** Hex SHA-256 of `tenantId + ":" + requesterKey`. */
    requesterHash: text("requester_hash"),
    /** A fixed phrase ("timeout", "provider error 529"); never a key or a body. */
    error: text("error"),
    createdAt: createdAt(),
    completedAt: instant("completed_at"),
  },
  (t) => [
    uniqueIndex("estimator_takeoffs_photo_idx").on(t.tenantId, t.productId, t.photoHash),
    index("estimator_takeoffs_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("estimator_takeoffs_requester_idx").on(t.tenantId, t.requesterHash, t.createdAt),
  ],
);
