/**
 * The wire: every request and response body the two handler factories speak
 * (section 8.5 of the 0.3 contract). SHARED WITH @adminigloo/estimator-widget,
 * which declares the same types in its own `src/types.ts` and
 * `src/admin/types.ts` — neither package imports the other, so a renamed field
 * here breaks the widget without either build noticing. Change both or
 * neither.
 *
 * Money is integer cents of `currency`; ratios are basis points (10000 =
 * 100%); instants are ISO strings. Costs, margins and supply prices appear only
 * on staff types, and are null for a caller without `estimator.costs.view`.
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
  | "already_answered" | "sample_already_loaded" | "settings_incomplete" | "quote_changed" | "managed_externally"
  | "internal";
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
  description?: string;                 // default: the product's name
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
  version: number;                      // the quote's send number: an answer names the version the customer saw
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
  /** The business's logo (from its company profile), or null. */
  logoUrl: string | null;
}
export interface QuoteResponse { quote: PublicQuote }
export interface AcceptQuoteBody { version: number; name?: string; note?: string; website?: string }
export interface DeclineQuoteBody { version: number; note?: string; website?: string }

// ---- staff (createEstimatorAdminHandlers) ---------------------------------------
export interface EstimatorSettingsWire {
  businessName: string; contactEmail: string | null; contactPhone: string | null;
  leadNotifyEmails: string[];
  currency: string; locale: string; timeZone: string; taxRateBp: BasisPoints;
  quoteValidDays: number; followUpDays: number; quoteFooter: string | null;
  defaultLaborRateCents: Cents | null;  // null without costs.view
  contingencyBp: BasisPoints;
  instantEstimatesEnabled: boolean; photosEnabled: boolean;
  aiDailyBudgetCents: Cents; aiPerRequesterDaily: number;
  brandColor: string | null;
  sampleLoadedAt: Instant | null; saved: boolean; updatedAt: Instant | null;
  /** The name, contact, zone and colour come from the company profile: read-only here, linking to href. null = editable here. */
  managedByCompany: { href: string | null } | null;
  /** The most a day of photo reading may cost on this site, in cents; null = no ceiling. */
  aiBudgetCeilingCents: number | null;
  /** Who gets the lead alerts is chosen in Alert settings (Tenancy 2b-1): show this link instead of the address list. null = the list is edited here. */
  alertRecipients: { href: string | null } | null;
}
export type EstimatorSettingsPatch = Partial<Omit<EstimatorSettingsWire, "sampleLoadedAt" | "saved" | "updatedAt" | "defaultLaborRateCents" | "managedByCompany" | "aiBudgetCeilingCents" | "alertRecipients">> & {
  defaultLaborRateCents?: Cents;
};

export type AdminNoticeCode =
  | "settings_not_saved" | "no_products" | "nothing_public" | "products_unpriced" | "labor_rate_zero" | "tax_default"
  | "emails_off" | "photos_no_store" | "reading_off" | "keys_without_origins";
export interface EstimatorDelivery { emails: boolean; followUps: boolean; note: string | null }
export interface AdminStatus {
  settingsSaved: boolean;
  products: { active: number; public: number };
  keys: { active: number; withoutOrigins: number };
  delivery: EstimatorDelivery;
  photos: { attach: boolean; reading: boolean };
  spend: { readingsToday: number; costTodayMicros: number; readingsMonth: number; costMonthMicros: number; dailyBudgetCents: Cents } | null;   // null without costs.view
  /** The most a day of photo reading may cost on this site (Tenancy 2a, D14), in cents; null = no ceiling. */
  aiBudgetCeilingCents: Cents | null;
  embedBaseUrl: string | null;
  notices: Array<{ code: AdminNoticeCode; message: string }>;
}
export interface UsageResponse {
  model: string | null;
  days: Array<{ date: string /* YYYY-MM-DD, UTC */; readings: number; costMicros: number }>;
  totals: { readings: number; costMicros: number; averageCostMicros: number };
}

export interface RampRecipeConfig {
  stepsLabel: string; stepsHelp: string | null;
  stepHeightLabel: string; stepHeightHelp: string | null;
  allowTotalRise: boolean; totalRiseLabel: string; totalRiseHelp: string | null;
  stepHeightIn: { typical: number; low: number; high: number };
  usePhotoStepHeight: boolean;          // price a photo's step height, kept inside low–high (false: the photo fills the count only)
  slopeRatio: number; roundUpToFt: number; landingEveryRiseIn: number; maxSteps: number;
  photoSubject: string; photoTip: string | null;
  resultNoun: { one: string; many: string };
}
export interface AreaRecipeConfig {
  unit: "ft" | "in"; widthLabel: string; lengthLabel: string; help: string | null;
  presets: Array<{ label: string; width: number; length: number }>;
  maxWidth: number; maxLength: number; resultNoun: { one: string; many: string };
}
export interface LinearRecipeConfig {
  unit: "ft" | "in"; lengthLabel: string; help: string | null; maxLength: number; resultNoun: { one: string; many: string };
}
export interface CountRecipeConfig {
  countLabel: string; help: string | null; noun: { one: string; many: string }; maxCount: number;
  photoSubject: string | null; photoTip: string | null;
}
export type RecipeConfig = RampRecipeConfig | AreaRecipeConfig | LinearRecipeConfig | CountRecipeConfig;

export interface RecipeInfo {
  key: RecipeKey; label: string; description: string; primaryKey: string;
  bases: Array<{ key: string; label: string }>;     // supplyBasesFor(recipe) with labels ("per ft of ramp", "per item", "once per job")
  photoReading: boolean;
}

export interface SupplyWire {
  id: string; name: string; unitType: UnitType;
  unitCost: Cents | null;                // null without costs.view
  supplier: string | null; sku: string | null; note: string | null;
  isActive: boolean; usedBy: Array<{ id: string; name: string }>;
  externalRef: string | null;            // the host's own reference (a SKU or service code), when it syncs this supply
  managedExternally: boolean;            // true: the cost comes from the host's own price list; the admin can't change it
  createdAt: Instant; updatedAt: Instant;
}
export interface SupplyInput { name: string; unitType: UnitType; unitCost: Cents; supplier?: string | null; sku?: string | null; note?: string | null }
export type SupplyPatch = Partial<SupplyInput>;
export interface SupplyMutationResponse { supply: SupplyWire; affectedProducts: Array<{ id: string; name: string }> }

export interface ProductSupplyWire {
  assignmentId: string; supplyId: string; name: string; unitType: UnitType;
  unitCost: Cents | null;                // null without costs.view
  quantityMilli: number; per: string | null; perLabel: string; sortOrder: number;
  roundUp: boolean;                      // bought whole: 5.25 posts are priced as 6
}
export interface AttachSupplyBody { supplyId: string; quantityMilli: number; per?: string; sortOrder?: number; roundUp?: boolean }
export interface UpdateAttachmentBody { quantityMilli?: number; per?: string; sortOrder?: number; roundUp?: boolean }

export interface AdminOptionValue { id: string; label: string; priceModifier: Cents; isDefault: boolean; sortOrder: number }
export interface AdminOption { id: string; name: string; optionType: string; showInEstimator: boolean; sortOrder: number; values: AdminOptionValue[] }
export interface OptionInput { name: string; optionType?: string; showInEstimator?: boolean; sortOrder?: number }
export type OptionPatch = Partial<OptionInput>;
export interface OptionValueInput { label: string; priceModifier?: Cents; isDefault?: boolean; sortOrder?: number }
export type OptionValuePatch = Partial<Omit<OptionValueInput, "isDefault">>;

export interface AdminProduct {
  id: string; name: string; category: string | null; description: string | null;
  recipe: RecipeKey; recipeInfo: RecipeInfo; recipeConfig: RecipeConfig;
  fields: CustomerField[];               // exactly what the customer is asked
  allowMultiple: boolean; multipleLabel: string | null; maxQuantity: number;
  supplies: ProductSupplyWire[];
  labor: { hoursPerUnitMilli: number; setupHoursMilli: number; rateCents: Cents | null; effectiveRateCents: Cents | null };   // rates null without costs.view
  wasteBp: BasisPoints | null; pricingBasis: PricingBasis; markupBp: BasisPoints | null; marginBp: BasisPoints | null;   // null without costs.view
  minimumCharge: Cents;
  rangeMode: RangeMode; contingencyBp: BasisPoints | null; estimateLowBp: BasisPoints; estimateHighBp: BasisPoints;
  example: ProductExample | null;        // the price at an everyday answer ("3 steps"), for the list; null for price-by-quote
  lumpCosts: { basePrice: Cents; pricePerSqFt: Cents | null; pricePerLinearFt: Cents | null; laborCost: Cents } | null;   // null without costs.view
  showInEstimator: boolean; isEstimatable: boolean; sortOrder: number; isActive: boolean;
  options: AdminOption[];
  createdAt: Instant; updatedAt: Instant;
}
export interface ProductInput {
  name: string; category?: string | null; description?: string | null;
  recipe: RecipeKey; recipeConfig?: Partial<RecipeConfig>;
  allowMultiple?: boolean; multipleLabel?: string | null; maxQuantity?: number;
  laborHoursPerUnitMilli?: number; laborSetupHoursMilli?: number; laborRateCents?: Cents | null;
  wasteBp?: BasisPoints; pricingBasis?: PricingBasis; markupBp?: BasisPoints; marginBp?: BasisPoints;
  minimumCharge?: Cents;
  rangeMode?: RangeMode; contingencyBp?: BasisPoints | null; estimateLowBp?: BasisPoints; estimateHighBp?: BasisPoints;
  basePrice?: Cents; pricePerSqFt?: Cents | null; pricePerLinearFt?: Cents | null; laborCost?: Cents;
  showInEstimator?: boolean; isEstimatable?: boolean; sortOrder?: number;
}
export type ProductPatch = Partial<ProductInput>;
export interface ProductExample {
  label: string;                         // "3 steps", "10 ft × 10 ft"
  price: Cents;                          // the point price at that answer
  marginBp: BasisPoints | null;          // null without costs.view
}

export interface ProductDraft extends ProductPatch {
  supplies?: Array<{ supplyId: string; quantityMilli: number; per: string; roundUp?: boolean }>;   // replaces the product's, in the preview only
  options?: Array<{ name: string; values: Array<{ label: string; priceModifier: Cents; isDefault?: boolean }> }>;
}
export interface PreviewBody {
  productId?: string | null; draft?: ProductDraft | null;
  inputs?: CustomerInputs | null; quantity?: number; optionValueIds?: string[];   // draft options are chosen by their default
}
export interface CostLine {
  kind: "supply" | "lump" | "waste" | "labor" | "setup" | "markup" | "margin" | "option" | "minimum";
  label: string; quantity: number | null; unit: string | null; unitCost: Cents | null; amount: Cents;
}
export interface PriceBreakdown {
  low: Cents; point: Cents; high: Cents; cost: Cents; marginBp: BasisPoints; minimumApplied: boolean;
  lines: CostLine[];
}
export interface PreviewResponse {
  fields: CustomerField[];
  status: "priced" | "needs_inputs" | "quote_only";
  missing: string[];
  customerView: PublicPrice | null;      // exactly what the customer would see
  breakdown: PriceBreakdown | null;      // null without costs.view
}
export interface SampleCatalogResponse { products: number; supplies: number }

export interface Correction { field: string; label: string; from: number; to: number | null }
export interface ReadingWire {
  takeoffId: string; status: "read" | "unreadable"; confidence: Confidence;
  lines: string[]; suggested: CustomerInputs; heightRangeIn: { low: number; high: number } | null;
  model: string | null; costMicros: number | null;   // costMicros null without costs.view
  createdAt: Instant;
}
export interface EstimateLineWire {
  id: string; productId: string | null; description: string;
  recipe: RecipeKey | null; inputs: CustomerInputs | null; inputsSummary: string | null;
  explanation: string[]; assumption: string | null; reasons: string[];
  quantity: number; unitPrice: Cents; laborPrice: Cents;
  total: Cents; lowTotal: Cents; highTotal: Cents; priceOverridden: boolean;
  options: Array<{ optionId: string; optionName: string; valueId: string; valueLabel: string; priceModifier: Cents }>;
  reading: ReadingWire | null;
  corrections: Correction[];
  cost: Cents | null;                    // null without costs.view
  notes: string | null; sortOrder: number;
}
export interface EstimatePhoto { id: string; url: string; width: number; height: number; source: "public" | "staff"; takeoffId: string | null; createdAt: Instant }
export interface LinkedVisit { id: string; when: string; status: string; url: string | null }
export interface LinkedInvoice { id: string; number: string; status: string; url: string | null }
export type EstimateAction =
  | "edit" | "send" | "resend" | "revise" | "mark_accepted" | "mark_declined" | "reopen"
  | "copy_link" | "archive" | "unarchive" | "duplicate" | "convert" | "book_visit";
export interface EstimateSnapshot {
  id: string; number: string; status: EstimateStatus; source: EstimateSource;
  customerName: string | null; customerEmail: string | null; customerPhone: string | null;
  jobAddress: string | null; notes: string | null;
  currency: string; subtotal: Cents; discount: Cents; taxRateBp: BasisPoints; taxAmount: Cents; total: Cents;
  rangeLow: Cents; rangeHigh: Cents; rangeReasons: string[];
  validUntil: Instant | null; sentAt: Instant | null; viewedAt: Instant | null; respondedAt: Instant | null;
  approvedAt: Instant | null; rejectedAt: Instant | null; expiredAt: Instant | null; convertedAt: Instant | null;
  archivedAt: Instant | null;
  responseName: string | null; responseNote: string | null; quoteMessage: string | null; quoteSequence: number;
  photoCount: number;
  lines: Array<{ description: string; inputsSummary: string | null; quantity: number; total: Cents; lowTotal: Cents; highTotal: Cents;
                 options: string[]; assumption: string | null }>;
  createdAt: Instant; updatedAt: Instant;
}
export interface EstimateDetail extends Omit<EstimateSnapshot, "lines"> {
  internalNotes: string | null;
  cost: Cents | null; marginBp: BasisPoints | null;   // null without costs.view
  lines: EstimateLineWire[];
  photos: EstimatePhoto[];
  actions: EstimateAction[];
  sendWarnings: string[];                // before "Send quote": each line still showing a range, and what it is priced at
  links: { bookVisitUrl: string | null; visits: LinkedVisit[]; invoice: LinkedInvoice | null };
  timeline: Array<{ at: Instant; label: string }>;   // "Lead received", "Quote sent", "Viewed", "Accepted by Pat Lee", …
}
export interface EstimateListRow {
  id: string; number: string; status: EstimateStatus; source: EstimateSource;
  customerName: string | null; customerEmail: string | null; jobAddress: string | null;
  total: Cents; rangeLow: Cents; rangeHigh: Cents; currency: string;
  photoCount: number; hasReading: boolean;
  validUntil: Instant | null; archivedAt: Instant | null; createdAt: Instant; updatedAt: Instant;
}
export type EstimateFilter = "all" | "leads" | "drafts" | "sent" | "accepted" | "declined" | "expired" | "converted" | "archived";
export interface EstimateListResponse { estimates: EstimateListRow[]; nextCursor: string | null; counts: Record<EstimateFilter, number> }

export interface LineInput {
  productId?: string | null; description?: string;   // a product line takes the product's name by default; a free line needs one
  inputs?: CustomerInputs | null; quantity?: number; optionValueIds?: string[];
  unitPrice?: Cents | null; laborPrice?: Cents; notes?: string | null;
}
export type LinePatch = Partial<LineInput>;
export interface CreateEstimateBody {
  customerName?: string | null; customerEmail?: string | null; customerPhone?: string | null;
  jobAddress?: string | null; notes?: string | null; internalNotes?: string | null;
  discount?: Cents; taxRateBp?: BasisPoints;
  items?: LineInput[];                   // may be empty: an empty draft to fill in
}
export interface EstimatePatch {
  customerName?: string | null; customerEmail?: string | null; customerPhone?: string | null;
  jobAddress?: string | null; notes?: string | null; internalNotes?: string | null;
  discount?: Cents; taxRateBp?: BasisPoints;
}
export interface SendQuoteBody { validDays?: number; message?: string | null }
export interface StatusBody { status: "approved" | "rejected" | "draft"; note?: string | null; notify?: boolean }
export interface EstimateMutationResponse { estimate: EstimateDetail; warnings: string[] }
export interface QuoteLinkResponse { url: string }
export interface ConvertResponse { invoice: LinkedInvoice; estimate: EstimateDetail }
export interface ExpireResponse { expired: number }

export interface KeyWire {
  id: string; label: string; keyPrefix: string; allowedOrigins: string[];
  revokedAt: Instant | null; lastUsedAt: Instant | null; createdAt: Instant;
}
export interface IssueKeyBody { label: string; allowedOrigins?: string[] }
export interface IssuedKeyResponse { key: KeyWire; plaintext: string }   // the only time the key is shown
export interface UpdateKeyBody { label?: string; allowedOrigins?: string[] }
