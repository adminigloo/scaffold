/**
 * The public wire, declared again on this side (estimator 0.3 contract, 8.5).
 *
 * The widget never imports `@adminigloo/estimator`: a contractor's marketing
 * page that embeds the estimate installs this package and React, nothing else.
 * So the shapes the server speaks are written out here, CHARACTER FOR
 * CHARACTER as the contract declares them — names, optionality, enums. If one
 * of these changes, the server's `src/wire.ts` changes with it, or the two
 * halves stop understanding each other without either noticing.
 *
 * The staff half of the wire is in `./admin/types.ts`, so the customer bundle
 * never carries the price book's shapes.
 */

// ---- scalars ---------------------------------------------------------------
export type Instant = string;          // ISO 8601 UTC
export type Cents = number;            // integer minor units of `currency`
export type BasisPoints = number;      // 10000 = 100%
export type RecipeKey = "ramp_over_steps" | "area" | "linear" | "count";
export type Confidence = "low" | "medium" | "high";
export type EstimateStatus = "draft" | "sent" | "viewed" | "approved" | "rejected" | "expired" | "converted";
export type EstimateSource = "public_tool" | "photo" | "staff";
export type UnitType = "per_linear_ft" | "per_sqft" | "per_unit" | "flat";
export type PricingBasis = "markup" | "margin";
export type RangeMode = "measured" | "percent";

export type WireErrorCode =
  | "invalid" | "spam_suspected" | "not_found" | "unauthorized" | "forbidden" | "origin_not_allowed"
  | "rate_limited" | "estimates_closed" | "photos_disabled" | "photo_invalid" | "photo_limit"
  | "photo_unavailable" | "takeoff_unavailable" | "product_unavailable" | "product_not_estimatable"
  | "invalid_measurement" | "invalid_options" | "invalid_supply_basis" | "invalid_recipe_config"
  | "invalid_price_range" | "discount_exceeds_subtotal" | "empty_estimate" | "no_customer_email"
  | "unpriced_lines" | "item_unavailable" | "option_unavailable" | "option_value_unavailable"
  | "component_unavailable" | "not_changeable" | "transition_not_allowed" | "quote_expired"
  | "already_answered" | "sample_already_loaded" | "settings_incomplete" | "quote_changed"
  | "managed_externally" | "internal";
export interface WireIssue { path: Array<string | number>; message: string; code?: string }
export interface WireErrorBody { error: { code: WireErrorCode; message: string; issues?: WireIssue[] } }

// ---- what the customer is asked (section 3) -----------------------------------
export interface CustomerFieldBase {
  key: string; label: string; help: string | null; required: boolean;
  presentation: "primary" | "secondary";   // secondary: behind a "More ways to measure" disclosure
}
export interface StepperField extends CustomerFieldBase { kind: "stepper"; min: number; max: number }
export interface NumberField extends CustomerFieldBase {
  kind: "number"; min: number; max: number; step: number; unit: "in" | "ft" | null; placeholder: string | null;
}
export interface ChoiceField extends CustomerFieldBase {
  kind: "choice"; choices: Array<{ value: string; label: string; sets: Record<string, number> }>;
}
export type CustomerField = StepperField | NumberField | ChoiceField;
export type CustomerInputs = Record<string, number | null>;
export interface LegacyMeasurement { widthIn?: number; heightIn?: number; sqFt?: number; linearFt?: number; units?: number }

// ---- public (createEstimatorHandlers) -------------------------------------------
export interface PublicOptionValue { id: string; label: string; priceModifier: Cents; isDefault: boolean }
export interface PublicProductOption { id: string; name: string; values: PublicOptionValue[] }
export interface PublicProduct {
  id: string; name: string; category: string | null; description: string | null;
  recipe: RecipeKey;
  fields: CustomerField[];
  quantity: { label: string; max: number } | null;     // null: don't ask "how many"
  isEstimatable: boolean;                               // false: "request a quote" (no price)
  photo: { reading: boolean; tip: string | null };
  options: PublicProductOption[];
  measurementMode: "area" | "linear" | "unit";          // 0.2, for 0.1 widgets
}
export interface PublicConfig {
  businessName: string; contactEmail: string | null; contactPhone: string | null;
  currency: string; locale: string; timeZone: string; brandColor: string | null;
  instantEstimatesEnabled: boolean;
  photos: { attach: boolean; reading: boolean; maxEdgePx: number; maxBytes: number; jpegQuality: number };
  emailsEnabled: boolean;
  minFillMs: number;
  products: PublicProduct[];
  /** The business's logo (from its company profile), or null. */
  logoUrl: string | null;
}

export interface CalculateBody {
  productId: string;
  inputs?: CustomerInputs;
  quantity?: number;
  optionValueIds?: string[];
  takeoffId?: string | null;
  measurement?: LegacyMeasurement;      // 0.2 widgets
}
export interface PublicPrice {
  low: Cents; high: Cents; single: boolean; currency: string;
  explanation: string[]; assumption: string | null; resultPhrase: string | null;
  reasons: string[];                    // why it's a range; [] when single
  taxNote: string | null;               // "Plus 7.25% sales tax."; null at 0%
}
export interface LegacyRange { sqFt: number; linearFt: number; units: number; subtotal: Cents; estimateLow: Cents; estimateHigh: Cents }
export interface CalculateResponse {
  status: "priced" | "needs_inputs" | "quote_only";
  missing: string[];
  price: PublicPrice | null;
  result: LegacyRange | null;           // 0.2 shape, for 0.1 widgets
}

export type PhotoMediaType = "image/jpeg" | "image/png" | "image/webp";
export interface PhotoBody { imageBase64: string; mediaType: PhotoMediaType; productId?: string }
export interface PhotoResponse { photoId: string }

export interface TakeoffBody {
  productId: string; imageBase64: string; mediaType: PhotoMediaType;
  inputs?: CustomerInputs | null;       // what the customer has typed: a measured job is never read
}
export interface TakeoffReading {
  takeoffId: string;
  recipe: RecipeKey;
  status: "read" | "unreadable";
  confidence: Confidence;
  seen: boolean;
  suggested: CustomerInputs;            // pre-fill these fields
  heightRangeIn: { low: number; high: number } | null;
  lowConfidence: boolean;
  usable: boolean;
  lines: string[];                      // 5.5, shown beside the photo
  fewerCheck: string | null;            // shown when the customer lowers the count the photo filled in
}
export type TakeoffStatus =
  | "read" | "unreadable" | "not_needed" | "not_supported" | "unavailable" | "limited" | "paused" | "busy";
export interface TakeoffResponse {
  status: TakeoffStatus;
  reading: TakeoffReading | null;       // read / unreadable only
  photoId: string | null;               // the business's copy, when kept
  message: string | null;               // 5.7's table
  cached: boolean;
  available: boolean;                   // 0.2: false when reading is off here
  result: null;                         // 0.2 field: always null (the model no longer measures)
}

export interface SubmitItem {
  productId: string;
  inputs?: CustomerInputs;
  quantity?: number;
  optionValueIds?: string[];
  takeoffId?: string | null;
  /** @deprecated Ignored by the server from estimator 0.3: a website line is always the product's name. */
  description?: string;
  measurement?: LegacyMeasurement;      // 0.2 widgets
}
export interface SubmitBody {
  name: string; email?: string; phone?: string; address?: string; notes?: string;   // email or phone required
  items: SubmitItem[];                  // 1–20
  photoIds?: string[];                  // ≤ 3
  website?: string;                     // honeypot: empty or absent
  fillMs?: number;
}
export interface SubmitResponse {
  estimateId: string; estimateNumber: string;
  range: { low: Cents; high: Cents; single: boolean };
  currency: string;
  emailed: boolean;                     // a copy is on its way (emails enabled and an email given)
  id: string; subtotal: Cents; taxAmount: Cents; total: Cents;   // 0.2 CreatedEstimate fields
}

export type PublicQuoteStatus = "open" | "accepted" | "declined" | "expired" | "updating";
export interface PublicQuoteLine { description: string; details: string[]; quantity: number; total: Cents }
export interface PublicQuote {
  status: PublicQuoteStatus;
  estimateId: string;                   // for "book the work" links (VisitPicker's estimateId); the token holder is the customer
  number: string;
  businessName: string; contactEmail: string | null; contactPhone: string | null;
  brandColor: string | null; currency: string; locale: string; timeZone: string;
  customerName: string | null; jobAddress: string | null;
  message: string | null; footer: string | null;
  sentAt: Instant | null; validUntil: Instant | null;
  respondedAt: Instant | null; responseName: string | null;
  lines: PublicQuoteLine[];
  subtotal: Cents; discount: Cents; taxRateBp: BasisPoints; taxAmount: Cents; total: Cents;
  canRespond: boolean;                  // open and before validUntil
  version: number;                      // the quote's send number: an answer names the version the customer saw
  /** The business's logo (from its company profile), or null. */
  logoUrl: string | null;
}
export interface QuoteResponse { quote: PublicQuote }
export interface AcceptQuoteBody { version: number; name?: string; note?: string; website?: string }
export interface DeclineQuoteBody { version: number; note?: string; website?: string }

// ---------------------------------------------------------------------------
// 0.1's types (kept: a 0.1 host's imports still compile)
// ---------------------------------------------------------------------------

/**
 * The provider's settings: 0.1's `baseUrl`, `clientKey`, `title` and
 * `subtitle`, plus 0.2's look-and-behaviour options (contract 9.5).
 *
 * CONTRACT: 9.5 says EstimatorConfig "keeps" `clientKey`. It stays, but is
 * OPTIONAL from 0.2: the business's own pages talk to the same-origin
 * handlers with no key (8.2), and a required key would make them issue one
 * for their own website. A 0.1 host that passes it is unaffected.
 */
export interface EstimatorConfig {
  /** Root of the mounted handlers, e.g. "https://summitramps.com/api/estimator". */
  baseUrl: string;
  /** The `esk_…` embed key issued for this business. Omit on the business's own site (same origin). */
  clientKey?: string;
  /** The dialog's heading. Default "Get an instant estimate". */
  title?: string;
  /** One line under the heading. Default "A real price in a minute, before anyone drives out." */
  subtitle?: string;
  /** "auto" (default) follows the host page; "light" / "dark" pin it. */
  theme?: "auto" | "light" | "dark";
  /** The business's colour. Undefined: the estimator's own setting; null: the stylesheet's default. */
  accentColor?: string | null;
  /** After saving: "Book a visit to measure" links here, with `estimate=<id>` added. */
  bookHref?: string;
  /** Show a small "Powered by AdminIgloo" line. Default false. */
  poweredBy?: boolean;
  /** Formatting locale for money and dates. Default: the business's setting. */
  locale?: string;
  /** A CSP nonce for the injected <style> tag. */
  nonce?: string;
}

/** @deprecated 0.1's product shape (`EstimatorTransport.config()`); use `PublicProduct`. */
export interface EmbedProduct {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  measurementMode: string;
  isEstimatable: boolean;
}

/** @deprecated 0.1's option value; use `PublicOptionValue`. */
export interface EmbedOptionValue {
  id: string;
  label: string;
  priceModifier: number;
  isDefault: boolean;
}

/** @deprecated 0.1's option; use `PublicProductOption`. */
export interface EmbedOption {
  id: string;
  name: string;
  values: EmbedOptionValue[];
}

/** @deprecated 0.1's range (the same shape as the wire's `LegacyRange`). */
export interface EmbedRange {
  sqFt: number;
  linearFt: number;
  units: number;
  subtotal: number;
  estimateLow: number;
  estimateHigh: number;
}

/**
 * @deprecated 0.1's photo reading, which carried MEASUREMENTS the model worked
 * out. From estimator 0.3 the model reports only what it sees
 * (`TakeoffReading`), so the deprecated transport always answers `result: null`.
 */
export interface EmbedTakeoff {
  sqFt: number | null;
  linearFt: number | null;
  units: number | null;
  confidence: string;
  summary: string;
  assumptions: string[];
}

/** @deprecated 0.1's measurement; the same shape as the wire's `LegacyMeasurement`. */
export interface EmbedMeasurement {
  widthIn?: number;
  heightIn?: number;
  sqFt?: number;
  linearFt?: number;
  units?: number;
}
