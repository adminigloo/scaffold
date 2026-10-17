/**
 * @adminigloo/estimator-widget — the customer half of AdminIgloo's estimator.
 *
 *   <EstimateTool baseUrl="/api/estimator" />              an instant price on the business's site
 *   <EstimatorProvider config={…}><EstimatorButton /><EstimatorModal /></EstimatorProvider>
 *                                                          the same, behind a floating button
 *   <QuoteView baseUrl="/api/estimator" token={t} />       the quote the customer accepts or declines
 *
 * Talks to `@adminigloo/estimator`'s `createEstimatorHandlers` over the JSON
 * wire: the types in ./types.ts, the same shapes as the server package's
 * src/wire.ts, declared again here so this package does not depend on the
 * server package (a marketing site that embeds the estimate installs nothing
 * but this and React). The staff
 * screens are a separate entry, `@adminigloo/estimator-widget/admin`, so a
 * marketing page never ships the price book.
 */

export { ESTIMATOR_WIRE_VERSION } from "./version.js";

export { EstimateTool, EstimateFlow, useEstimatorConfig, DEFAULT_INTRO, DEFAULT_TITLE, type EstimateToolProps, type ConfigState } from "./EstimateTool.js";
export { QuoteView, StatusBanner, type QuotePayment, type QuoteViewProps } from "./QuoteView.js";
export { CustomerFields, RadioChips, Stepper, cleanInputs, hasAnyInput, inRange, rangeMessage, type ChipChoice, type CustomerFieldsProps } from "./fields.js";
export { PriceCard, priceText, type PriceState } from "./price.js";
export { EstimatorProvider, EstimatorButton, EstimatorModal, useEstimator } from "./widget.js";
export { EstimatorTransport, type SubmitInput } from "./transport.js";

export {
  createEstimatorClient,
  KEY_HEADER,
  parseCalculateResponse,
  parseCustomerField,
  parsePublicConfig,
  parsePublicPrice,
  parsePublicProduct,
  parsePublicQuote,
  parseQuoteResponse,
  parseSubmitResponse,
  parseTakeoffResponse,
  type EstimatorClientOptions,
  type EstimatorPublicTransport,
} from "./client.js";
export { joinUrl, toClientError, type ClientError, type Result, type TransportOptions } from "./http.js";

export {
  formatDate,
  formatDateTime,
  formatModifier,
  formatMoney,
  formatPercent,
  formatRange,
  friendlyError,
  withParam,
  type ErrorContext,
  type MoneyOptions,
} from "./format.js";
export {
  buildSubmitBody,
  EMPTY_DETAILS,
  isValidEmail,
  LIMITS,
  mapSubmitIssues,
  validateDetails,
  type DetailsErrors,
  type DetailsField,
  type DetailsValues,
} from "./form.js";
export { blobToBase64, fitWithin, NOT_A_PHOTO, resizePhoto, type ResizedPhoto } from "./photo.js";

export { resolveHostTheme, useHostTheme, type MatchMediaLike, type ResolvedTheme, type ThemeChoice } from "./theme.js";
export {
  BRAND_TOKEN_NAMES,
  brandStyle,
  brandTokens,
  CONTRAST_PAIRS,
  contrastRatio,
  DARK_TOKENS,
  estimatorWidgetCss,
  injectEstimatorStyles,
  LIGHT_TOKENS,
  type InjectStylesOptions,
} from "./styles.js";
export type { ChromeProps } from "./parts.js";

export type {
  // 0.1's types
  EstimatorConfig,
  EmbedProduct,
  EmbedOption,
  EmbedOptionValue,
  EmbedRange,
  EmbedTakeoff,
  EmbedMeasurement,
  // the public wire
  AcceptQuoteBody,
  BasisPoints,
  CalculateBody,
  CalculateResponse,
  Cents,
  ChoiceField,
  Confidence,
  CustomerField,
  CustomerFieldBase,
  CustomerInputs,
  DeclineQuoteBody,
  EstimateSource,
  EstimateStatus,
  Instant,
  LegacyMeasurement,
  LegacyRange,
  NumberField,
  PhotoBody,
  PhotoMediaType,
  PhotoResponse,
  PricingBasis,
  PublicConfig,
  PublicOptionValue,
  PublicPrice,
  PublicProduct,
  PublicProductOption,
  PublicQuote,
  PublicQuoteLine,
  PublicQuoteStatus,
  QuoteResponse,
  RangeMode,
  RecipeKey,
  StepperField,
  SubmitBody,
  SubmitItem,
  SubmitResponse,
  TakeoffBody,
  TakeoffReading,
  TakeoffResponse,
  TakeoffStatus,
  UnitType,
  WireErrorBody,
  WireErrorCode,
  WireIssue,
} from "./types.js";
