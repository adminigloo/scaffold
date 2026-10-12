/**
 * @adminigloo/estimator-widget/admin — the staff screens.
 *
 *   <EstimatorAdmin baseUrl="/api/admin/estimator" />    everything, in four tabs
 *   <EstimatesQueue … />     leads and quotes: search, filters, archive
 *   <EstimateEditor … />     one estimate: photo, the AI's reading, lines, send the quote
 *   <PriceBook … />          products priced from your supplies, with a live test quote
 *   <EstimatorSettings … />  business, quotes, pricing, lead alerts, photos and AI
 *   <EmbedKeys … />          keys and the snippet for another website
 *
 * Talks to `@adminigloo/estimator`'s `createEstimatorAdminHandlers` (or any
 * object implementing `EstimatorAdminTransport`). A client entry, separate
 * from the customer-facing one so a marketing page never ships the admin.
 */

export { ESTIMATOR_WIRE_VERSION } from "../version.js";

export { EstimatorAdmin, type EstimatorAdminProps, type EstimatorAdminSection } from "./EstimatorAdmin.js";
export { PriceBook, SuppliesLibrary, affectedText, SAMPLE_CONFIRM, type PriceBookProps } from "./PriceBook.js";
export { ProductEditor, formFromProduct, formProblem, productInputFromForm, productPatch, type ProductEditorProps, type ProductForm } from "./ProductEditor.js";
export { EstimatesQueue, type EstimatesQueueProps } from "./EstimatesQueue.js";
export { EstimateEditor, correctionText, type EstimateEditorProps } from "./EstimateEditor.js";
export { EmbedKeys, embedSnippets, originsFromText, resolveEmbedBaseUrl, type EmbedKeysProps } from "./EmbedKeys.js";
export { EstimatorSettings, type EstimatorSettingsProps, type EstimatorSettingsSection } from "./EstimatorSettings.js";
export { AdminNotices, useAdminBasics, type AdminBasics, type AdminChromeProps } from "./ui.js";

export {
  createEstimatorAdminClient,
  ESTIMATE_FILTERS,
  ESTIMATE_SOURCES,
  ESTIMATE_STATUSES,
  parseAdminProduct,
  parseAdminStatus,
  parseEstimateDetail,
  parseEstimateList,
  parseKey,
  parsePreview,
  parseSettingsWire,
  parseSupply,
  parseUsage,
  UNIT_TYPES,
  type EstimatorAdminClientOptions,
  type EstimatorAdminTransport,
} from "./client.js";
export type { ClientError, Result, TransportOptions } from "../http.js";

export { estimatorAdminCss, injectEstimatorAdminStyles } from "./styles.js";
export { CustomerFields, type CustomerFieldsProps } from "../fields.js";

export {
  adminErrorText,
  allTimeZones,
  AREA_DEFAULTS,
  bpToInput,
  centsToInput,
  COMMON_CURRENCIES,
  configFor,
  COUNT_DEFAULTS,
  FILTER_EMPTY,
  FILTER_LABEL,
  formatMicros,
  formatMicrosExact,
  issuesByField,
  LINEAR_DEFAULTS,
  milliToInput,
  parseMilliInput,
  parseMoneyInput,
  parseNumberInput,
  parsePercentInput,
  perPrimaryLabel,
  RAMP_DEFAULTS,
  RECIPE_CATALOG,
  recipeInfoFor,
  showsRange,
  SOURCE_LABEL,
  statusLabel,
  timeAgo,
  UNIT_LABEL,
  US_TIME_ZONES,
  type RecipeCatalogEntry,
  type StatusTone,
  type ZoneChoice,
} from "./helpers.js";

export type {
  AdminNoticeCode,
  AdminOption,
  AdminOptionValue,
  AdminProduct,
  AdminStatus,
  AreaRecipeConfig,
  AttachSupplyBody,
  ConvertResponse,
  CostLine,
  CountRecipeConfig,
  CreateEstimateBody,
  Correction,
  EstimateAction,
  EstimateDetail,
  EstimateFilter,
  EstimateLineWire,
  EstimateListResponse,
  EstimateListRow,
  EstimateMutationResponse,
  EstimatePatch,
  EstimatePhoto,
  EstimateSnapshot,
  EstimatorDelivery,
  EstimatorSettingsPatch,
  EstimatorSettingsWire,
  ExpireResponse,
  IssuedKeyResponse,
  IssueKeyBody,
  KeyWire,
  LinearRecipeConfig,
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
  ProductDraft,
  ProductInput,
  ProductPatch,
  ProductSupplyWire,
  QuoteLinkResponse,
  RampRecipeConfig,
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
export type {
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
  WireErrorBody,
  WireErrorCode,
  WireIssue,
} from "../types.js";
