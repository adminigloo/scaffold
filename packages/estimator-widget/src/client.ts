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
  str,
  stringList,
  strOrNull,
  type Result,
  type TransportOptions,
} from "./http.js";
import type {
  AcceptQuoteBody,
  CalculateBody,
  CalculateResponse,
  Confidence,
  CustomerField,
  DeclineQuoteBody,
  LegacyRange,
  PhotoBody,
  PhotoResponse,
  PublicConfig,
  PublicOptionValue,
  PublicPrice,
  PublicProduct,
  PublicProductOption,
  PublicQuote,
  PublicQuoteLine,
  PublicQuoteStatus,
  QuoteResponse,
  RecipeKey,
  SubmitBody,
  SubmitResponse,
  TakeoffBody,
  TakeoffReading,
  TakeoffResponse,
  TakeoffStatus,
} from "./types.js";

/**
 * The customer-facing transport: `createEstimatorHandlers`' routes (contract
 * 8.2 / 9.1), each answer checked narrowly. Components take this INTERFACE,
 * not a class, so a host can back the estimator with anything that answers in
 * these shapes — a test fake, a server action, tRPC.
 */

export interface EstimatorPublicTransport {
  config(): Promise<Result<PublicConfig>>;
  calculate(body: CalculateBody): Promise<Result<CalculateResponse>>;
  photo(body: PhotoBody): Promise<Result<PhotoResponse>>;
  takeoff(body: TakeoffBody): Promise<Result<TakeoffResponse>>;
  submit(body: SubmitBody): Promise<Result<SubmitResponse>>;
  quote(token: string): Promise<Result<QuoteResponse>>;
  acceptQuote(token: string, body: AcceptQuoteBody): Promise<Result<QuoteResponse>>;
  declineQuote(token: string, body: DeclineQuoteBody): Promise<Result<QuoteResponse>>;
}

export interface EstimatorClientOptions extends TransportOptions {
  /** The `esk_…` embed key, for a page on ANOTHER website. Sent on every request as `x-adminigloo-key`. */
  clientKey?: string;
}

/** Shared with every adminigloo widget; the embed key rides in this header. */
export const KEY_HEADER = "x-adminigloo-key";

// ---------------------------------------------------------------------------
// Shape checks: only what the widget reads, with safe defaults for the rest
// ---------------------------------------------------------------------------

export const RECIPE_KEYS: readonly RecipeKey[] = ["ramp_over_steps", "area", "linear", "count"];
const CONFIDENCES: readonly Confidence[] = ["low", "medium", "high"];

/**
 * One customer field. A field the widget can't render (an unknown kind, no
 * key) is dropped rather than drawn wrong; the server then answers
 * `needs_inputs` naming it, which the tool says in plain words.
 */
export function parseCustomerField(raw: unknown): CustomerField | null {
  if (!isObject(raw) || !isString(raw.key) || !raw.key || !isString(raw.label)) return null;
  const base = {
    key: raw.key,
    label: raw.label,
    help: strOrNull(raw.help),
    required: isTrue(raw.required),
    presentation: raw.presentation === "secondary" ? ("secondary" as const) : ("primary" as const),
  };
  const min = num(raw.min, 0);
  const max = Math.max(min, num(raw.max, Number.MAX_SAFE_INTEGER));
  switch (raw.kind) {
    case "stepper":
      return { ...base, kind: "stepper", min, max };
    case "number":
      return {
        ...base,
        kind: "number",
        min,
        max,
        step: num(raw.step, 1) > 0 ? num(raw.step, 1) : 1,
        unit: raw.unit === "in" || raw.unit === "ft" ? raw.unit : null,
        placeholder: strOrNull(raw.placeholder),
      };
    case "choice":
      return {
        ...base,
        kind: "choice",
        choices: listOf(raw.choices, (choice) =>
          isObject(choice) && isString(choice.value) && isString(choice.label)
            ? { value: choice.value, label: choice.label, sets: Object.fromEntries(Object.entries(numberMap(choice.sets)).filter((e): e is [string, number] => e[1] !== null)) }
            : null,
        ),
      };
    default:
      return null;
  }
}

function parseOptionValue(raw: unknown): PublicOptionValue | null {
  if (!isObject(raw) || !isString(raw.id) || !raw.id || !isString(raw.label)) return null;
  return { id: raw.id, label: raw.label, priceModifier: num(raw.priceModifier, 0), isDefault: isTrue(raw.isDefault) };
}

export function parseProductOption(raw: unknown): PublicProductOption | null {
  if (!isObject(raw) || !isString(raw.id) || !raw.id || !isString(raw.name)) return null;
  const values = listOf(raw.values, parseOptionValue);
  return values.length > 0 ? { id: raw.id, name: raw.name, values } : null;
}

export function parsePublicProduct(raw: unknown): PublicProduct | null {
  if (!isObject(raw) || !isString(raw.id) || !raw.id || !isString(raw.name)) return null;
  const quantity =
    isObject(raw.quantity) && isString(raw.quantity.label) ? { label: raw.quantity.label, max: Math.max(1, num(raw.quantity.max, 10)) } : null;
  const photo = isObject(raw.photo) ? raw.photo : {};
  return {
    id: raw.id,
    name: raw.name,
    category: strOrNull(raw.category),
    description: strOrNull(raw.description),
    recipe: oneOf(raw.recipe, RECIPE_KEYS, "count"),
    fields: listOf(raw.fields, parseCustomerField),
    quantity,
    // Absent reads as priceable: an older server that doesn't say still prices.
    isEstimatable: raw.isEstimatable !== false,
    photo: { reading: isTrue(photo.reading), tip: strOrNull(photo.tip) },
    options: listOf(raw.options, parseProductOption),
    measurementMode: oneOf(raw.measurementMode, ["area", "linear", "unit"] as const, "unit"),
  };
}

export function parsePublicConfig(body: unknown): PublicConfig | null {
  if (!isObject(body) || !Array.isArray(body.products)) return null;
  const photos = isObject(body.photos) ? body.photos : {};
  return {
    businessName: str(body.businessName),
    contactEmail: strOrNull(body.contactEmail),
    contactPhone: strOrNull(body.contactPhone),
    currency: /^[A-Z]{3}$/.test(str(body.currency)) ? str(body.currency) : "USD",
    locale: str(body.locale) || "en-US",
    timeZone: str(body.timeZone) || "UTC",
    brandColor: /^#[0-9a-fA-F]{6}$/.test(str(body.brandColor)) ? str(body.brandColor) : null,
    // Absent reads as open: an older server that doesn't say still estimates.
    instantEstimatesEnabled: body.instantEstimatesEnabled !== false,
    photos: {
      attach: isTrue(photos.attach),
      reading: isTrue(photos.reading),
      maxEdgePx: Math.max(64, num(photos.maxEdgePx, 768)),
      maxBytes: Math.max(1, num(photos.maxBytes, 600_000)),
      jpegQuality: Math.min(1, Math.max(0.3, num(photos.jpegQuality, 0.8))),
    },
    // Only an explicit true promises email: a page that can't tell must not
    // send anyone to an inbox nobody wrote to.
    emailsEnabled: isTrue(body.emailsEnabled),
    minFillMs: Math.max(0, num(body.minFillMs, 0)),
    products: listOf(body.products, parsePublicProduct),
    // Tenancy 2a: an older server sends none.
    logoUrl: strOrNull(body.logoUrl),
  };
}

export function parsePublicPrice(raw: unknown): PublicPrice | null {
  if (!isObject(raw)) return null;
  const low = numOrNull(raw.low);
  const high = numOrNull(raw.high);
  if (low === null || high === null) return null;
  return {
    low,
    high,
    single: isTrue(raw.single) || low === high,
    currency: str(raw.currency) || "USD",
    explanation: stringList(raw.explanation),
    assumption: strOrNull(raw.assumption),
    resultPhrase: strOrNull(raw.resultPhrase),
    reasons: stringList(raw.reasons),
    taxNote: strOrNull(raw.taxNote),
  };
}

function parseLegacyRange(raw: unknown): LegacyRange | null {
  if (!isObject(raw) || numOrNull(raw.estimateLow) === null || numOrNull(raw.estimateHigh) === null) return null;
  return {
    sqFt: num(raw.sqFt),
    linearFt: num(raw.linearFt),
    units: num(raw.units),
    subtotal: num(raw.subtotal),
    estimateLow: num(raw.estimateLow),
    estimateHigh: num(raw.estimateHigh),
  };
}

export function parseCalculateResponse(body: unknown): CalculateResponse | null {
  if (!isObject(body) || !isString(body.status) || !["priced", "needs_inputs", "quote_only"].includes(body.status)) return null;
  const status = body.status as CalculateResponse["status"];
  const price = parsePublicPrice(body.price);
  // "priced" without a price we can read is not an answer we can show.
  if (status === "priced" && !price) return null;
  return { status, missing: stringList(body.missing), price, result: parseLegacyRange(body.result) };
}

export function parsePhotoResponse(body: unknown): PhotoResponse | null {
  return isObject(body) && isString(body.photoId) && body.photoId ? { photoId: body.photoId } : null;
}

const TAKEOFF_STATUSES: readonly TakeoffStatus[] = ["read", "unreadable", "not_needed", "not_supported", "unavailable", "limited", "paused", "busy"];

export function parseTakeoffReading(raw: unknown): TakeoffReading | null {
  if (!isObject(raw) || !isString(raw.takeoffId) || !raw.takeoffId) return null;
  const range = isObject(raw.heightRangeIn) ? raw.heightRangeIn : null;
  const low = range ? numOrNull(range.low) : null;
  const high = range ? numOrNull(range.high) : null;
  return {
    takeoffId: raw.takeoffId,
    recipe: oneOf(raw.recipe, RECIPE_KEYS, "ramp_over_steps"),
    status: raw.status === "read" ? "read" : "unreadable",
    confidence: oneOf(raw.confidence, CONFIDENCES, "low"),
    seen: isTrue(raw.seen),
    suggested: numberMap(raw.suggested),
    heightRangeIn: low !== null && high !== null ? { low, high } : null,
    lowConfidence: isTrue(raw.lowConfidence),
    usable: isTrue(raw.usable),
    lines: stringList(raw.lines),
    fewerCheck: strOrNull(raw.fewerCheck),
  };
}

export function parseTakeoffResponse(body: unknown): TakeoffResponse | null {
  if (!isObject(body) || !isString(body.status) || !(TAKEOFF_STATUSES as readonly string[]).includes(body.status)) return null;
  const status = body.status as TakeoffStatus;
  return {
    status,
    reading: status === "read" || status === "unreadable" ? parseTakeoffReading(body.reading) : null,
    photoId: strOrNull(body.photoId),
    message: strOrNull(body.message),
    cached: isTrue(body.cached),
    available: body.available !== false,
    result: null,
  };
}

export function parseSubmitResponse(body: unknown): SubmitResponse | null {
  if (!isObject(body) || !isString(body.estimateNumber) || !body.estimateNumber) return null;
  const id = str(body.estimateId) || str(body.id);
  const range = isObject(body.range) ? body.range : null;
  const subtotal = num(body.subtotal);
  const low = range ? num(range.low, subtotal) : subtotal;
  const high = range ? num(range.high, low) : low;
  return {
    estimateId: id,
    estimateNumber: body.estimateNumber,
    range: { low, high, single: range ? isTrue(range.single) || low === high : low === high },
    currency: str(body.currency) || "USD",
    emailed: isTrue(body.emailed),
    id,
    subtotal,
    taxAmount: num(body.taxAmount),
    total: num(body.total),
  };
}

const QUOTE_STATUSES: readonly PublicQuoteStatus[] = ["open", "accepted", "declined", "expired", "updating"];

function parseQuoteLine(raw: unknown): PublicQuoteLine | null {
  if (!isObject(raw) || !isString(raw.description)) return null;
  return { description: raw.description, details: stringList(raw.details), quantity: num(raw.quantity, 1), total: num(raw.total) };
}

export function parsePublicQuote(raw: unknown): PublicQuote | null {
  if (!isObject(raw) || !isString(raw.status) || !(QUOTE_STATUSES as readonly string[]).includes(raw.status) || !isString(raw.number)) return null;
  return {
    status: raw.status as PublicQuoteStatus,
    estimateId: str(raw.estimateId),
    number: raw.number,
    businessName: str(raw.businessName),
    contactEmail: strOrNull(raw.contactEmail),
    contactPhone: strOrNull(raw.contactPhone),
    brandColor: /^#[0-9a-fA-F]{6}$/.test(str(raw.brandColor)) ? str(raw.brandColor) : null,
    currency: /^[A-Z]{3}$/.test(str(raw.currency)) ? str(raw.currency) : "USD",
    locale: str(raw.locale) || "en-US",
    timeZone: str(raw.timeZone) || "UTC",
    customerName: strOrNull(raw.customerName),
    jobAddress: strOrNull(raw.jobAddress),
    message: strOrNull(raw.message),
    footer: strOrNull(raw.footer),
    sentAt: strOrNull(raw.sentAt),
    validUntil: strOrNull(raw.validUntil),
    respondedAt: strOrNull(raw.respondedAt),
    responseName: strOrNull(raw.responseName),
    lines: listOf(raw.lines, parseQuoteLine),
    subtotal: num(raw.subtotal),
    discount: num(raw.discount),
    taxRateBp: num(raw.taxRateBp),
    taxAmount: num(raw.taxAmount),
    total: num(raw.total),
    canRespond: isTrue(raw.canRespond),
    // An older server sends no version: 0 there, which that server ignores.
    version: num(raw.version, 0),
    logoUrl: strOrNull(raw.logoUrl),
  };
}

export function parseQuoteResponse(body: unknown): QuoteResponse | null {
  const quote = isObject(body) ? parsePublicQuote(body.quote) : null;
  return quote ? { quote } : null;
}

/** 0.2's `POST /v1/options` answer (the deprecated transport's `options()`). */
export function parseOptionsResponse(body: unknown): { options: PublicProductOption[] } | null {
  return isObject(body) && Array.isArray(body.options) ? { options: listOf(body.options, parseProductOption) } : null;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** Token routes carry the token in the PATH, encoded (contract 8.2). */
function quotePath(token: string, suffix = ""): string {
  return `/v1/quote/${encodeURIComponent(token)}${suffix}`;
}

/**
 * The HTTP transport over `createEstimatorHandlers`. With `clientKey`, every
 * request (GETs too) carries `x-adminigloo-key`: a keyed embed is on another
 * website, so the request is cross-origin and preflighted anyway.
 */
export function createEstimatorClient(options: EstimatorClientOptions): EstimatorPublicTransport & {
  /** 0.2's `POST /v1/options`; the deprecated `EstimatorTransport` reads it. */
  options(productId: string): Promise<Result<{ options: PublicProductOption[] }>>;
} {
  const headers = { ...(options.headers ?? {}), ...(options.clientKey ? { [KEY_HEADER]: options.clientKey } : {}) };
  const http = createRequester({
    baseUrl: options.baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    headers,
  });
  return {
    config: () => http.get("/v1/config", parsePublicConfig),
    calculate: (body) => http.post("/v1/calculate", body, parseCalculateResponse),
    photo: (body) => http.post("/v1/photo", body, parsePhotoResponse),
    takeoff: (body) => http.post("/v1/takeoff", body, parseTakeoffResponse),
    submit: (body) => http.post("/v1/submit", body, parseSubmitResponse),
    quote: (token) => http.get(quotePath(token), parseQuoteResponse),
    acceptQuote: (token, body) => http.post(quotePath(token, "/accept"), body, parseQuoteResponse),
    declineQuote: (token, body) => http.post(quotePath(token, "/decline"), body, parseQuoteResponse),
    options: (productId) => http.post("/v1/options", { productId }, parseOptionsResponse),
  };
}
