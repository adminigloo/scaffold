import { parseCustomerField, parsePublicPrice, RECIPE_KEYS } from "../client.js";
import {
  createRequester,
  isObject,
  isString,
  isTrue,
  listOf,
  num,
  numberMap,
  numOrNull,
  oneOf,
  queryString,
  str,
  stringList,
  strOrNull,
  type Result,
  type TransportOptions,
} from "../http.js";
import type { Confidence, EstimateSource, EstimateStatus, PhotoBody, UnitType } from "../types.js";
import type {
  AdminNoticeCode,
  ProductExample,
  AdminOption,
  AdminOptionValue,
  AdminProduct,
  AdminStatus,
  AttachSupplyBody,
  ConvertResponse,
  CostLine,
  CreateEstimateBody,
  EstimateAction,
  EstimateDetail,
  EstimateFilter,
  EstimateLineWire,
  EstimateListResponse,
  EstimateListRow,
  EstimateMutationResponse,
  EstimatePatch,
  EstimatePhoto,
  EstimatorSettingsPatch,
  EstimatorSettingsWire,
  ExpireResponse,
  IssuedKeyResponse,
  IssueKeyBody,
  KeyWire,
  LineInput,
  LinePatch,
  LinkedInvoice,
  LinkedVisit,
  OptionInput,
  OptionPatch,
  OptionValueInput,
  OptionValuePatch,
  PreviewBody,
  PreviewResponse,
  PriceBreakdown,
  ProductInput,
  ProductPatch,
  ProductSupplyWire,
  QuoteLinkResponse,
  ReadingWire,
  RecipeConfig,
  RecipeInfo,
  SampleCatalogResponse,
  SendQuoteBody,
  StatusBody,
  SupplyInput,
  SupplyMutationResponse,
  SupplyPatch,
  SupplyWire,
  UpdateAttachmentBody,
  UpdateKeyBody,
  UsageResponse,
} from "./types.js";

/**
 * The staff transport: `createEstimatorAdminHandlers`' routes (contract 8.3 /
 * 9.1), every answer checked narrowly. The admin components take the
 * INTERFACE, so a host can back them with tRPC or server actions by
 * implementing it instead of mounting the HTTP handlers.
 */

export interface EstimatorAdminTransport {
  status(): Promise<Result<AdminStatus>>;
  usage(q?: { days?: number }): Promise<Result<UsageResponse>>;
  getSettings(): Promise<Result<{ settings: EstimatorSettingsWire }>>;
  updateSettings(patch: EstimatorSettingsPatch): Promise<Result<{ settings: EstimatorSettingsWire }>>;
  listProducts(q?: { includeInactive?: boolean }): Promise<Result<{ products: AdminProduct[] }>>;
  createProduct(body: ProductInput): Promise<Result<{ product: AdminProduct }>>;
  reorderProducts(ids: string[]): Promise<Result<{ products: AdminProduct[] }>>;
  preview(body: PreviewBody): Promise<Result<PreviewResponse>>;
  getProduct(id: string): Promise<Result<{ product: AdminProduct }>>;
  updateProduct(id: string, patch: ProductPatch): Promise<Result<{ product: AdminProduct }>>;
  deactivateProduct(id: string): Promise<Result<{ product: AdminProduct }>>;
  reactivateProduct(id: string): Promise<Result<{ product: AdminProduct }>>;
  attachSupply(productId: string, body: AttachSupplyBody): Promise<Result<{ product: AdminProduct }>>;
  updateAttachment(productId: string, assignmentId: string, body: UpdateAttachmentBody): Promise<Result<{ product: AdminProduct }>>;
  removeAttachment(productId: string, assignmentId: string): Promise<Result<{ product: AdminProduct }>>;
  createOption(productId: string, body: OptionInput): Promise<Result<{ product: AdminProduct }>>;
  updateOption(optionId: string, patch: OptionPatch): Promise<Result<{ product: AdminProduct }>>;
  removeOption(optionId: string): Promise<Result<{ product: AdminProduct }>>;
  createOptionValue(optionId: string, body: OptionValueInput): Promise<Result<{ product: AdminProduct }>>;
  updateOptionValue(valueId: string, patch: OptionValuePatch): Promise<Result<{ product: AdminProduct }>>;
  setDefaultOptionValue(valueId: string): Promise<Result<{ product: AdminProduct }>>;
  removeOptionValue(valueId: string): Promise<Result<{ product: AdminProduct }>>;
  listSupplies(q?: { includeInactive?: boolean }): Promise<Result<{ supplies: SupplyWire[] }>>;
  createSupply(body: SupplyInput): Promise<Result<{ supply: SupplyWire }>>;
  updateSupply(id: string, patch: SupplyPatch): Promise<Result<SupplyMutationResponse>>;
  deactivateSupply(id: string): Promise<Result<SupplyMutationResponse>>;
  reactivateSupply(id: string): Promise<Result<SupplyMutationResponse>>;
  /** `trade`: whose sample — "lawn", "cleaning" or "ramps" (0.3's, and the server's default). */
  loadSampleCatalog(trade?: "lawn" | "cleaning" | "ramps"): Promise<Result<SampleCatalogResponse>>;
  listEstimates(q?: { filter?: EstimateFilter; q?: string; source?: EstimateSource; cursor?: string | null; limit?: number }): Promise<Result<EstimateListResponse>>;
  createEstimate(body: CreateEstimateBody): Promise<Result<EstimateMutationResponse>>;
  getEstimate(id: string): Promise<Result<{ estimate: EstimateDetail }>>;
  updateEstimate(id: string, patch: EstimatePatch): Promise<Result<EstimateMutationResponse>>;
  addLine(id: string, body: LineInput): Promise<Result<EstimateMutationResponse>>;
  updateLine(id: string, itemId: string, patch: LinePatch): Promise<Result<EstimateMutationResponse>>;
  removeLine(id: string, itemId: string): Promise<Result<EstimateMutationResponse>>;
  addPhoto(id: string, body: PhotoBody): Promise<Result<EstimateMutationResponse>>;
  removePhoto(id: string, photoId: string): Promise<Result<EstimateMutationResponse>>;
  sendQuote(id: string, body: SendQuoteBody): Promise<Result<EstimateMutationResponse>>;
  resendQuote(id: string): Promise<Result<EstimateMutationResponse>>;
  reviseQuote(id: string): Promise<Result<EstimateMutationResponse>>;
  setStatus(id: string, body: StatusBody): Promise<Result<EstimateMutationResponse>>;
  quoteLink(id: string): Promise<Result<QuoteLinkResponse>>;
  archive(id: string): Promise<Result<EstimateMutationResponse>>;
  unarchive(id: string): Promise<Result<EstimateMutationResponse>>;
  duplicate(id: string): Promise<Result<EstimateMutationResponse>>;
  convert(id: string): Promise<Result<ConvertResponse>>;
  expire(): Promise<Result<ExpireResponse>>;
  listKeys(): Promise<Result<{ keys: KeyWire[] }>>;
  issueKey(body: IssueKeyBody): Promise<Result<IssuedKeyResponse>>;
  updateKey(id: string, body: UpdateKeyBody): Promise<Result<{ key: KeyWire }>>;
  revokeKey(id: string): Promise<Result<{ key: KeyWire }>>;
}

export type EstimatorAdminClientOptions = TransportOptions;

// ---------------------------------------------------------------------------
// Shape checks
// ---------------------------------------------------------------------------

export const ESTIMATE_STATUSES: readonly EstimateStatus[] = ["draft", "sent", "viewed", "approved", "rejected", "expired", "converted"];
export const ESTIMATE_SOURCES: readonly EstimateSource[] = ["public_tool", "photo", "staff"];
export const UNIT_TYPES: readonly UnitType[] = ["per_linear_ft", "per_sqft", "per_unit", "flat"];
export const ESTIMATE_FILTERS: readonly EstimateFilter[] = ["leads", "drafts", "sent", "accepted", "declined", "expired", "converted", "all", "archived"];
const CONFIDENCES: readonly Confidence[] = ["low", "medium", "high"];
const NOTICE_CODES: readonly AdminNoticeCode[] = [
  "settings_not_saved",
  "no_products",
  "nothing_public",
  "products_unpriced",
  "labor_rate_zero",
  "tax_default",
  "emails_off",
  "photos_no_store",
  "reading_off",
  "keys_without_origins",
];
const ACTIONS: readonly EstimateAction[] = [
  "edit",
  "send",
  "resend",
  "revise",
  "mark_accepted",
  "mark_declined",
  "reopen",
  "copy_link",
  "archive",
  "unarchive",
  "duplicate",
  "convert",
  "book_visit",
];

const isId = (value: unknown): value is string => isString(value) && value.length > 0;
const stamp = (value: unknown): string => str(value);

export function parseSettingsWire(raw: unknown): EstimatorSettingsWire | null {
  if (!isObject(raw)) return null;
  return {
    businessName: str(raw.businessName),
    contactEmail: strOrNull(raw.contactEmail),
    contactPhone: strOrNull(raw.contactPhone),
    leadNotifyEmails: stringList(raw.leadNotifyEmails),
    currency: str(raw.currency) || "USD",
    locale: str(raw.locale) || "en-US",
    timeZone: str(raw.timeZone) || "UTC",
    taxRateBp: num(raw.taxRateBp, 0),
    quoteValidDays: num(raw.quoteValidDays, 30),
    followUpDays: num(raw.followUpDays, 0),
    quoteFooter: strOrNull(raw.quoteFooter),
    defaultLaborRateCents: numOrNull(raw.defaultLaborRateCents),
    contingencyBp: num(raw.contingencyBp, 0),
    instantEstimatesEnabled: raw.instantEstimatesEnabled !== false,
    photosEnabled: raw.photosEnabled !== false,
    aiDailyBudgetCents: num(raw.aiDailyBudgetCents, 0),
    aiPerRequesterDaily: num(raw.aiPerRequesterDaily, 0),
    brandColor: strOrNull(raw.brandColor),
    sampleLoadedAt: strOrNull(raw.sampleLoadedAt),
    saved: isTrue(raw.saved),
    updatedAt: strOrNull(raw.updatedAt),
    // Tenancy 2a: an older server sends neither; that reads as 0.2's screen.
    managedByCompany: isObject(raw.managedByCompany) ? { href: strOrNull(raw.managedByCompany.href) } : null,
    aiBudgetCeilingCents: numOrNull(raw.aiBudgetCeilingCents),
    // Tenancy 2b-1: an older server sends nothing here, which reads as "the
    // list is edited here" (null), 0.3's screen. Only a path on this site or
    // an http(s) address is kept as the link, never a script URL.
    alertRecipients: isObject(raw.alertRecipients) ? { href: safeLink(raw.alertRecipients.href) } : null,
  };
}

/** A link the server sent for a screen to follow: a path on this site or an http(s) address; else null. */
function safeLink(raw: unknown): string | null {
  return isString(raw) && /^(\/(?!\/)|https?:\/\/)/i.test(raw) ? raw : null;
}

function parseSettingsResponse(body: unknown): { settings: EstimatorSettingsWire } | null {
  const settings = isObject(body) ? parseSettingsWire(body.settings) : null;
  return settings ? { settings } : null;
}

export function parseAdminStatus(raw: unknown): AdminStatus | null {
  if (!isObject(raw) || !Array.isArray(raw.notices)) return null;
  const products = isObject(raw.products) ? raw.products : {};
  const keys = isObject(raw.keys) ? raw.keys : {};
  const delivery = isObject(raw.delivery) ? raw.delivery : {};
  const photos = isObject(raw.photos) ? raw.photos : {};
  const spend = isObject(raw.spend) ? raw.spend : null;
  return {
    settingsSaved: isTrue(raw.settingsSaved),
    products: { active: num(products.active), public: num(products.public) },
    keys: { active: num(keys.active), withoutOrigins: num(keys.withoutOrigins) },
    delivery: { emails: isTrue(delivery.emails), followUps: isTrue(delivery.followUps), note: strOrNull(delivery.note) },
    photos: { attach: isTrue(photos.attach), reading: isTrue(photos.reading) },
    spend: spend
      ? {
          readingsToday: num(spend.readingsToday),
          costTodayMicros: num(spend.costTodayMicros),
          readingsMonth: num(spend.readingsMonth),
          costMonthMicros: num(spend.costMonthMicros),
          dailyBudgetCents: num(spend.dailyBudgetCents),
        }
      : null,
    embedBaseUrl: strOrNull(raw.embedBaseUrl),
    aiBudgetCeilingCents: numOrNull(raw.aiBudgetCeilingCents),
    notices: listOf(raw.notices, (n) =>
      isObject(n) && isString(n.code) && isString(n.message)
        ? { code: oneOf(n.code, NOTICE_CODES, "settings_not_saved"), message: n.message }
        : null,
    ),
  };
}

export function parseUsage(raw: unknown): UsageResponse | null {
  if (!isObject(raw) || !Array.isArray(raw.days)) return null;
  const totals = isObject(raw.totals) ? raw.totals : {};
  return {
    model: strOrNull(raw.model),
    days: listOf(raw.days, (d) => (isObject(d) && isString(d.date) ? { date: d.date, readings: num(d.readings), costMicros: num(d.costMicros) } : null)),
    totals: { readings: num(totals.readings), costMicros: num(totals.costMicros), averageCostMicros: num(totals.averageCostMicros) },
  };
}

function parseRecipeInfo(raw: unknown, fallbackKey: string): RecipeInfo {
  const info = isObject(raw) ? raw : {};
  return {
    key: oneOf(info.key, RECIPE_KEYS, oneOf(fallbackKey, RECIPE_KEYS, "count")),
    label: str(info.label),
    description: str(info.description),
    primaryKey: str(info.primaryKey),
    bases: listOf(info.bases, (b) => (isObject(b) && isString(b.key) && isString(b.label) ? { key: b.key, label: b.label } : null)),
    photoReading: isTrue(info.photoReading),
  };
}

function parseSupplyRef(raw: unknown): { id: string; name: string } | null {
  return isObject(raw) && isId(raw.id) ? { id: raw.id, name: str(raw.name) } : null;
}

export function parseSupply(raw: unknown): SupplyWire | null {
  if (!isObject(raw) || !isId(raw.id) || !isString(raw.name)) return null;
  return {
    id: raw.id,
    name: raw.name,
    unitType: oneOf(raw.unitType, UNIT_TYPES, "per_unit"),
    unitCost: numOrNull(raw.unitCost),
    supplier: strOrNull(raw.supplier),
    sku: strOrNull(raw.sku),
    note: strOrNull(raw.note),
    isActive: raw.isActive !== false,
    usedBy: listOf(raw.usedBy, parseSupplyRef),
    externalRef: strOrNull(raw.externalRef),
    managedExternally: isTrue(raw.managedExternally),
    createdAt: stamp(raw.createdAt),
    updatedAt: stamp(raw.updatedAt),
  };
}

function parseProductSupply(raw: unknown): ProductSupplyWire | null {
  if (!isObject(raw) || !isId(raw.assignmentId)) return null;
  return {
    assignmentId: raw.assignmentId,
    supplyId: str(raw.supplyId),
    name: str(raw.name),
    unitType: oneOf(raw.unitType, UNIT_TYPES, "per_unit"),
    unitCost: numOrNull(raw.unitCost),
    quantityMilli: num(raw.quantityMilli),
    per: strOrNull(raw.per),
    perLabel: str(raw.perLabel),
    sortOrder: num(raw.sortOrder),
    roundUp: isTrue(raw.roundUp),
  };
}

function parseOptionValue(raw: unknown): AdminOptionValue | null {
  if (!isObject(raw) || !isId(raw.id)) return null;
  return { id: raw.id, label: str(raw.label), priceModifier: num(raw.priceModifier), isDefault: isTrue(raw.isDefault), sortOrder: num(raw.sortOrder) };
}

function parseOption(raw: unknown): AdminOption | null {
  if (!isObject(raw) || !isId(raw.id)) return null;
  return {
    id: raw.id,
    name: str(raw.name),
    optionType: str(raw.optionType) || "select",
    showInEstimator: raw.showInEstimator !== false,
    sortOrder: num(raw.sortOrder),
    values: listOf(raw.values, parseOptionValue).sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

function parseProductExample(raw: unknown): ProductExample | null {
  if (!isObject(raw) || !isString(raw.label) || numOrNull(raw.price) === null) return null;
  return { label: raw.label, price: num(raw.price), marginBp: numOrNull(raw.marginBp) };
}

export function parseAdminProduct(raw: unknown): AdminProduct | null {
  if (!isObject(raw) || !isId(raw.id) || !isString(raw.name)) return null;
  const recipe = oneOf(raw.recipe, RECIPE_KEYS, "count");
  const labor = isObject(raw.labor) ? raw.labor : {};
  const lump = isObject(raw.lumpCosts) ? raw.lumpCosts : null;
  return {
    id: raw.id,
    name: raw.name,
    category: strOrNull(raw.category),
    description: strOrNull(raw.description),
    recipe,
    recipeInfo: parseRecipeInfo(raw.recipeInfo, recipe),
    // Kept as the server sent it: the editor lays it over the recipe's defaults.
    recipeConfig: (isObject(raw.recipeConfig) ? raw.recipeConfig : {}) as unknown as RecipeConfig,
    fields: listOf(raw.fields, parseCustomerField),
    allowMultiple: isTrue(raw.allowMultiple),
    multipleLabel: strOrNull(raw.multipleLabel),
    maxQuantity: num(raw.maxQuantity, 10),
    supplies: listOf(raw.supplies, parseProductSupply).sort((a, b) => a.sortOrder - b.sortOrder),
    labor: {
      hoursPerUnitMilli: num(labor.hoursPerUnitMilli),
      setupHoursMilli: num(labor.setupHoursMilli),
      rateCents: numOrNull(labor.rateCents),
      effectiveRateCents: numOrNull(labor.effectiveRateCents),
    },
    // Null for a caller without estimator.costs.view: the server strips them.
    wasteBp: numOrNull(raw.wasteBp),
    pricingBasis: raw.pricingBasis === "margin" ? "margin" : "markup",
    markupBp: numOrNull(raw.markupBp),
    marginBp: numOrNull(raw.marginBp),
    minimumCharge: num(raw.minimumCharge),
    rangeMode: raw.rangeMode === "percent" ? "percent" : "measured",
    contingencyBp: numOrNull(raw.contingencyBp),
    estimateLowBp: num(raw.estimateLowBp, 9000),
    estimateHighBp: num(raw.estimateHighBp, 11500),
    example: parseProductExample(raw.example),
    lumpCosts: lump
      ? { basePrice: num(lump.basePrice), pricePerSqFt: numOrNull(lump.pricePerSqFt), pricePerLinearFt: numOrNull(lump.pricePerLinearFt), laborCost: num(lump.laborCost) }
      : null,
    showInEstimator: raw.showInEstimator !== false,
    isEstimatable: raw.isEstimatable !== false,
    sortOrder: num(raw.sortOrder),
    isActive: raw.isActive !== false,
    options: listOf(raw.options, parseOption).sort((a, b) => a.sortOrder - b.sortOrder),
    createdAt: stamp(raw.createdAt),
    updatedAt: stamp(raw.updatedAt),
  };
}

const productResponse = (body: unknown): { product: AdminProduct } | null => {
  const product = isObject(body) ? parseAdminProduct(body.product) : null;
  return product ? { product } : null;
};
const productsResponse = (body: unknown): { products: AdminProduct[] } | null =>
  isObject(body) && Array.isArray(body.products) ? { products: listOf(body.products, parseAdminProduct) } : null;

const COST_KINDS: readonly CostLine["kind"][] = ["supply", "lump", "waste", "labor", "setup", "markup", "margin", "option", "minimum"];

function parseCostLine(raw: unknown): CostLine | null {
  if (!isObject(raw) || !isString(raw.label)) return null;
  return {
    kind: oneOf(raw.kind, COST_KINDS, "supply"),
    label: raw.label,
    quantity: numOrNull(raw.quantity),
    unit: strOrNull(raw.unit),
    unitCost: numOrNull(raw.unitCost),
    amount: num(raw.amount),
  };
}

function parseBreakdown(raw: unknown): PriceBreakdown | null {
  if (!isObject(raw) || numOrNull(raw.point) === null) return null;
  return {
    low: num(raw.low),
    point: num(raw.point),
    high: num(raw.high),
    cost: num(raw.cost),
    marginBp: num(raw.marginBp),
    minimumApplied: isTrue(raw.minimumApplied),
    lines: listOf(raw.lines, parseCostLine),
  };
}

export function parsePreview(raw: unknown): PreviewResponse | null {
  if (!isObject(raw) || !isString(raw.status) || !["priced", "needs_inputs", "quote_only"].includes(raw.status)) return null;
  return {
    fields: listOf(raw.fields, parseCustomerField),
    status: raw.status as PreviewResponse["status"],
    missing: stringList(raw.missing),
    customerView: parsePublicPrice(raw.customerView),
    breakdown: parseBreakdown(raw.breakdown),
  };
}

function parseReading(raw: unknown): ReadingWire | null {
  if (!isObject(raw) || !isId(raw.takeoffId)) return null;
  const range = isObject(raw.heightRangeIn) ? raw.heightRangeIn : null;
  const low = range ? numOrNull(range.low) : null;
  const high = range ? numOrNull(range.high) : null;
  return {
    takeoffId: raw.takeoffId,
    status: raw.status === "read" ? "read" : "unreadable",
    confidence: oneOf(raw.confidence, CONFIDENCES, "low"),
    lines: stringList(raw.lines),
    suggested: numberMap(raw.suggested),
    heightRangeIn: low !== null && high !== null ? { low, high } : null,
    model: strOrNull(raw.model),
    costMicros: numOrNull(raw.costMicros),
    createdAt: stamp(raw.createdAt),
  };
}

function parseLine(raw: unknown): EstimateLineWire | null {
  if (!isObject(raw) || !isId(raw.id)) return null;
  const total = num(raw.total);
  return {
    id: raw.id,
    productId: strOrNull(raw.productId),
    description: str(raw.description),
    recipe: isString(raw.recipe) && (RECIPE_KEYS as readonly string[]).includes(raw.recipe) ? (raw.recipe as EstimateLineWire["recipe"]) : null,
    inputs: isObject(raw.inputs) ? numberMap(raw.inputs) : null,
    inputsSummary: strOrNull(raw.inputsSummary),
    explanation: stringList(raw.explanation),
    assumption: strOrNull(raw.assumption),
    reasons: stringList(raw.reasons),
    quantity: num(raw.quantity, 1),
    unitPrice: num(raw.unitPrice),
    laborPrice: num(raw.laborPrice),
    total,
    lowTotal: num(raw.lowTotal, total),
    highTotal: num(raw.highTotal, total),
    priceOverridden: isTrue(raw.priceOverridden),
    options: listOf(raw.options, (o) =>
      isObject(o) && isString(o.valueId)
        ? { optionId: str(o.optionId), optionName: str(o.optionName), valueId: o.valueId, valueLabel: str(o.valueLabel), priceModifier: num(o.priceModifier) }
        : null,
    ),
    reading: parseReading(raw.reading),
    corrections: listOf(raw.corrections, (c) =>
      isObject(c) && isString(c.field) ? { field: c.field, label: str(c.label) || c.field, from: num(c.from), to: numOrNull(c.to) } : null,
    ),
    cost: numOrNull(raw.cost),
    notes: strOrNull(raw.notes),
    sortOrder: num(raw.sortOrder),
  };
}

function parsePhoto(raw: unknown): EstimatePhoto | null {
  if (!isObject(raw) || !isId(raw.id) || !isString(raw.url)) return null;
  return {
    id: raw.id,
    url: raw.url,
    width: num(raw.width),
    height: num(raw.height),
    source: raw.source === "staff" ? "staff" : "public",
    takeoffId: strOrNull(raw.takeoffId),
    createdAt: stamp(raw.createdAt),
  };
}

function parseLinkedVisit(raw: unknown): LinkedVisit | null {
  return isObject(raw) && isId(raw.id) ? { id: raw.id, when: str(raw.when), status: str(raw.status), url: strOrNull(raw.url) } : null;
}

export function parseLinkedInvoice(raw: unknown): LinkedInvoice | null {
  return isObject(raw) && isId(raw.id) ? { id: raw.id, number: str(raw.number), status: str(raw.status), url: strOrNull(raw.url) } : null;
}

export function parseEstimateDetail(raw: unknown): EstimateDetail | null {
  if (!isObject(raw) || !isId(raw.id) || !isString(raw.status) || !(ESTIMATE_STATUSES as readonly string[]).includes(raw.status)) return null;
  const links = isObject(raw.links) ? raw.links : {};
  const subtotal = num(raw.subtotal);
  return {
    id: raw.id,
    number: str(raw.number),
    status: raw.status as EstimateStatus,
    source: oneOf(raw.source, ESTIMATE_SOURCES, "staff"),
    customerName: strOrNull(raw.customerName),
    customerEmail: strOrNull(raw.customerEmail),
    customerPhone: strOrNull(raw.customerPhone),
    jobAddress: strOrNull(raw.jobAddress),
    notes: strOrNull(raw.notes),
    currency: str(raw.currency) || "USD",
    subtotal,
    discount: num(raw.discount),
    taxRateBp: num(raw.taxRateBp),
    taxAmount: num(raw.taxAmount),
    total: num(raw.total),
    rangeLow: num(raw.rangeLow, subtotal),
    rangeHigh: num(raw.rangeHigh, subtotal),
    rangeReasons: stringList(raw.rangeReasons),
    validUntil: strOrNull(raw.validUntil),
    sentAt: strOrNull(raw.sentAt),
    viewedAt: strOrNull(raw.viewedAt),
    respondedAt: strOrNull(raw.respondedAt),
    approvedAt: strOrNull(raw.approvedAt),
    rejectedAt: strOrNull(raw.rejectedAt),
    expiredAt: strOrNull(raw.expiredAt),
    convertedAt: strOrNull(raw.convertedAt),
    archivedAt: strOrNull(raw.archivedAt),
    responseName: strOrNull(raw.responseName),
    responseNote: strOrNull(raw.responseNote),
    quoteMessage: strOrNull(raw.quoteMessage),
    quoteSequence: num(raw.quoteSequence),
    photoCount: num(raw.photoCount),
    createdAt: stamp(raw.createdAt),
    updatedAt: stamp(raw.updatedAt),
    internalNotes: strOrNull(raw.internalNotes),
    cost: numOrNull(raw.cost),
    marginBp: numOrNull(raw.marginBp),
    lines: listOf(raw.lines, parseLine).sort((a, b) => a.sortOrder - b.sortOrder),
    photos: listOf(raw.photos, parsePhoto),
    actions: stringList(raw.actions).filter((a): a is EstimateAction => (ACTIONS as readonly string[]).includes(a)),
    links: {
      bookVisitUrl: strOrNull(links.bookVisitUrl),
      visits: listOf(links.visits, parseLinkedVisit),
      invoice: parseLinkedInvoice(links.invoice),
    },
    timeline: listOf(raw.timeline, (t) => (isObject(t) && isString(t.at) && isString(t.label) ? { at: t.at, label: t.label } : null)),
    sendWarnings: stringList(raw.sendWarnings),
  };
}

const estimateResponse = (body: unknown): { estimate: EstimateDetail } | null => {
  const estimate = isObject(body) ? parseEstimateDetail(body.estimate) : null;
  return estimate ? { estimate } : null;
};
const mutationResponse = (body: unknown): EstimateMutationResponse | null => {
  const estimate = isObject(body) ? parseEstimateDetail(body.estimate) : null;
  return estimate && isObject(body) ? { estimate, warnings: stringList(body.warnings) } : null;
};

function parseListRow(raw: unknown): EstimateListRow | null {
  if (!isObject(raw) || !isId(raw.id) || !isString(raw.status) || !(ESTIMATE_STATUSES as readonly string[]).includes(raw.status)) return null;
  const total = num(raw.total);
  return {
    id: raw.id,
    number: str(raw.number),
    status: raw.status as EstimateStatus,
    source: oneOf(raw.source, ESTIMATE_SOURCES, "staff"),
    customerName: strOrNull(raw.customerName),
    customerEmail: strOrNull(raw.customerEmail),
    jobAddress: strOrNull(raw.jobAddress),
    total,
    rangeLow: num(raw.rangeLow, total),
    rangeHigh: num(raw.rangeHigh, total),
    currency: str(raw.currency) || "USD",
    photoCount: num(raw.photoCount),
    hasReading: isTrue(raw.hasReading),
    validUntil: strOrNull(raw.validUntil),
    archivedAt: strOrNull(raw.archivedAt),
    createdAt: stamp(raw.createdAt),
    updatedAt: stamp(raw.updatedAt),
  };
}

export function parseEstimateList(raw: unknown): EstimateListResponse | null {
  if (!isObject(raw) || !Array.isArray(raw.estimates)) return null;
  const counts = isObject(raw.counts) ? raw.counts : {};
  const out = {} as Record<EstimateFilter, number>;
  for (const filter of ESTIMATE_FILTERS) out[filter] = num(counts[filter]);
  return { estimates: listOf(raw.estimates, parseListRow), nextCursor: strOrNull(raw.nextCursor), counts: out };
}

export function parseKey(raw: unknown): KeyWire | null {
  if (!isObject(raw) || !isId(raw.id)) return null;
  return {
    id: raw.id,
    label: str(raw.label),
    keyPrefix: str(raw.keyPrefix),
    allowedOrigins: stringList(raw.allowedOrigins),
    revokedAt: strOrNull(raw.revokedAt),
    lastUsedAt: strOrNull(raw.lastUsedAt),
    createdAt: stamp(raw.createdAt),
  };
}

const keyResponse = (body: unknown): { key: KeyWire } | null => {
  const key = isObject(body) ? parseKey(body.key) : null;
  return key ? { key } : null;
};

const supplyMutation = (body: unknown): SupplyMutationResponse | null => {
  const supply = isObject(body) ? parseSupply(body.supply) : null;
  return supply && isObject(body) ? { supply, affectedProducts: listOf(body.affectedProducts, parseSupplyRef) } : null;
};

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;
const A = "/v1/admin";

export function createEstimatorAdminClient(options: EstimatorAdminClientOptions): EstimatorAdminTransport {
  const http = createRequester(options);
  const post = <T>(path: string, body: unknown, parse: (b: unknown) => T | null) => http.post(`${A}/${path}`, body, parse);
  const get = <T>(path: string, parse: (b: unknown) => T | null) => http.get(`${A}/${path}`, parse);
  return {
    status: () => get("status", parseAdminStatus),
    usage: (q) => get(`usage${queryString({ days: q?.days })}`, parseUsage),
    getSettings: () => get("settings", parseSettingsResponse),
    updateSettings: (patch) => post("settings", patch, parseSettingsResponse),
    listProducts: (q) => get(`products${queryString({ include: q?.includeInactive ? "inactive" : undefined })}`, productsResponse),
    createProduct: (body) => post("products", body, productResponse),
    reorderProducts: (ids) => post("products/reorder", { ids }, productsResponse),
    preview: (body) => post("products/preview", body, parsePreview),
    getProduct: (id) => get(`products/${enc(id)}`, productResponse),
    updateProduct: (id, patch) => post(`products/${enc(id)}`, patch, productResponse),
    deactivateProduct: (id) => post(`products/${enc(id)}/deactivate`, {}, productResponse),
    reactivateProduct: (id) => post(`products/${enc(id)}/reactivate`, {}, productResponse),
    attachSupply: (productId, body) => post(`products/${enc(productId)}/supplies`, body, productResponse),
    updateAttachment: (productId, assignmentId, body) => post(`products/${enc(productId)}/supplies/${enc(assignmentId)}`, body, productResponse),
    removeAttachment: (productId, assignmentId) => post(`products/${enc(productId)}/supplies/${enc(assignmentId)}/remove`, {}, productResponse),
    createOption: (productId, body) => post(`products/${enc(productId)}/options`, body, productResponse),
    updateOption: (optionId, patch) => post(`options/${enc(optionId)}`, patch, productResponse),
    removeOption: (optionId) => post(`options/${enc(optionId)}/remove`, {}, productResponse),
    createOptionValue: (optionId, body) => post(`options/${enc(optionId)}/values`, body, productResponse),
    updateOptionValue: (valueId, patch) => post(`option-values/${enc(valueId)}`, patch, productResponse),
    setDefaultOptionValue: (valueId) => post(`option-values/${enc(valueId)}/default`, {}, productResponse),
    removeOptionValue: (valueId) => post(`option-values/${enc(valueId)}/remove`, {}, productResponse),
    listSupplies: (q) =>
      get(`supplies${queryString({ include: q?.includeInactive ? "inactive" : undefined })}`, (b) =>
        isObject(b) && Array.isArray(b.supplies) ? { supplies: listOf(b.supplies, parseSupply) } : null,
      ),
    createSupply: (body) =>
      post("supplies", body, (b) => {
        const supply = isObject(b) ? parseSupply(b.supply) : null;
        return supply ? { supply } : null;
      }),
    updateSupply: (id, patch) => post(`supplies/${enc(id)}`, patch, supplyMutation),
    deactivateSupply: (id) => post(`supplies/${enc(id)}/deactivate`, {}, supplyMutation),
    reactivateSupply: (id) => post(`supplies/${enc(id)}/reactivate`, {}, supplyMutation),
    loadSampleCatalog: (trade) =>
      post("sample-catalog", trade ? { trade } : {}, (b) =>
        isObject(b) && numOrNull(b.products) !== null ? { products: num(b.products), supplies: num(b.supplies) } : null,
      ),
    listEstimates: (q) =>
      get(
        `estimates${queryString({ filter: q?.filter, q: q?.q?.trim() || undefined, source: q?.source, cursor: q?.cursor ?? undefined, limit: q?.limit })}`,
        parseEstimateList,
      ),
    createEstimate: (body) => post("estimates", body, mutationResponse),
    getEstimate: (id) => get(`estimates/${enc(id)}`, estimateResponse),
    updateEstimate: (id, patch) => post(`estimates/${enc(id)}`, patch, mutationResponse),
    addLine: (id, body) => post(`estimates/${enc(id)}/items`, body, mutationResponse),
    updateLine: (id, itemId, patch) => post(`estimates/${enc(id)}/items/${enc(itemId)}`, patch, mutationResponse),
    removeLine: (id, itemId) => post(`estimates/${enc(id)}/items/${enc(itemId)}/remove`, {}, mutationResponse),
    addPhoto: (id, body) => post(`estimates/${enc(id)}/photos`, body, mutationResponse),
    removePhoto: (id, photoId) => post(`estimates/${enc(id)}/photos/${enc(photoId)}/remove`, {}, mutationResponse),
    sendQuote: (id, body) => post(`estimates/${enc(id)}/send`, body, mutationResponse),
    resendQuote: (id) => post(`estimates/${enc(id)}/resend`, {}, mutationResponse),
    reviseQuote: (id) => post(`estimates/${enc(id)}/revise`, {}, mutationResponse),
    setStatus: (id, body) => post(`estimates/${enc(id)}/status`, body, mutationResponse),
    quoteLink: (id) => post(`estimates/${enc(id)}/link`, {}, (b) => (isObject(b) && isId(b.url) ? { url: b.url } : null)),
    archive: (id) => post(`estimates/${enc(id)}/archive`, {}, mutationResponse),
    unarchive: (id) => post(`estimates/${enc(id)}/unarchive`, {}, mutationResponse),
    duplicate: (id) => post(`estimates/${enc(id)}/duplicate`, {}, mutationResponse),
    convert: (id) =>
      post(`estimates/${enc(id)}/convert`, {}, (b) => {
        if (!isObject(b)) return null;
        const invoice = parseLinkedInvoice(b.invoice);
        const estimate = parseEstimateDetail(b.estimate);
        return invoice && estimate ? { invoice, estimate } : null;
      }),
    expire: () => post("expire", {}, (b) => (isObject(b) && numOrNull(b.expired) !== null ? { expired: num(b.expired) } : null)),
    listKeys: () => get("keys", (b) => (isObject(b) && Array.isArray(b.keys) ? { keys: listOf(b.keys, parseKey) } : null)),
    issueKey: (body) =>
      post("keys", body, (b) => {
        const key = isObject(b) ? parseKey(b.key) : null;
        return key && isObject(b) && isId(b.plaintext) ? { key, plaintext: b.plaintext } : null;
      }),
    updateKey: (id, body) => post(`keys/${enc(id)}`, body, keyResponse),
    revokeKey: (id) => post(`keys/${enc(id)}/revoke`, {}, keyResponse),
  };
}
