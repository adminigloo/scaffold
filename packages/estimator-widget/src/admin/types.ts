import type {
  BasisPoints,
  Cents,
  Confidence,
  CustomerField,
  CustomerInputs,
  EstimateSource,
  EstimateStatus,
  Instant,
  PricingBasis,
  PublicPrice,
  RangeMode,
  RecipeKey,
  UnitType,
} from "../types.js";

/**
 * The staff half of the wire (estimator 0.3 contract, 8.5), declared again on
 * this side and CHARACTER FOR CHARACTER as the contract has it. The public
 * half (scalars, fields, `PublicPrice`) is in `../types.ts`; this file imports
 * it rather than repeating it, and the admin entry re-exports both.
 *
 * A cost, a supply cost, a labor rate or a margin is `null` when the signed-in
 * person lacks `estimator.costs.view`: the server strips them, and the screens
 * say so instead of showing a zero.
 */

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
}
export type EstimatorSettingsPatch = Partial<Omit<EstimatorSettingsWire, "sampleLoadedAt" | "saved" | "updatedAt" | "defaultLaborRateCents" | "managedByCompany" | "aiBudgetCeilingCents">> & {
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
  embedBaseUrl: string | null;
  notices: Array<{ code: AdminNoticeCode; message: string }>;
  /** The most a day of photo reading may cost on this site (Tenancy 2a, D14), in cents; null = no ceiling. */
  aiBudgetCeilingCents: Cents | null;
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
