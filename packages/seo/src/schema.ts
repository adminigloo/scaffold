import { Issues } from "./errors.js";
import { ref, type JsonLdNode, type Ref } from "./jsonld.js";
import { absoluteUrl, pageUrl, type Site } from "./site.js";
import { checkDate, compact, dateMillis, isHttpUrl, oneLine, slugify, type DateInput } from "./util.js";

/**
 * schema.org builders. Each one takes the site and typed input, checks the
 * properties schema.org and Google require, and returns a node with a stable
 * `@id`:
 *
 *   site-wide   {origin}/#organization, /#website, /#localbusiness, /#person-{key}
 *   per page    {canonical}#webpage, #breadcrumb, #product, #software, #event,
 *               #howto, #faq, #article, #itemlist, #place, #attraction
 *
 * so nodes link to each other with `ref()` across one page's `graph()` and
 * across the layout's and the page's script blocks. Every `@type` comes from
 * a closed list of real schema.org types (no "LandformFeature"), nothing is
 * defaulted that is a fact about the business (`isAccessibleForFree`,
 * stock status, country), and empty values never reach the output
 * (no `"sameAs": []`).
 *
 * A builder throws `SeoError` listing every problem with its input. For a node
 * built from data that may be incomplete, wrap it in `tryNode()`.
 *
 * Rich results: `product`, `softwareApplication` and `event` check by default
 * everything Google's rich result for the type requires (a Product's offer,
 * rating or rated review, and an image once it has offers; a Software App's
 * price AND rating or review; an Event's start date), so a node never reaches
 * Search Console as an invalid item by accident. `richResult: false` is the
 * deliberate other choice: the node describes the thing for answer engines
 * and the knowledge graph (a plan with no public price, an app with no
 * ratings yet, an event with no date) and is not eligible for a rich result.
 */

/** Shared by the builders whose Google rich result has requirements beyond schema.org's. */
export interface RichResultOption {
  /**
   * Default true: refuse input that Google's rich result for this type would
   * report as invalid. false: emit a plain description (no rich result; Search
   * Console may list it as an invalid item, which costs nothing else).
   */
  richResult?: boolean;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

function siteNodeId(site: Site, fragment: string): string {
  return `${site.url}/#${fragment}`;
}

function nodeId(site: Site, base: string | null, explicit: string | undefined, fallback: string): string {
  if (explicit) {
    if (isHttpUrl(explicit)) return explicit;
    const fragment = explicit.startsWith("#") ? explicit.slice(1) : explicit;
    return base ? `${base}#${fragment}` : siteNodeId(site, fragment);
  }
  return base ? `${base}#${fallback}` : siteNodeId(site, fallback);
}

export function organizationId(site: Site): string {
  return siteNodeId(site, "organization");
}

export function webSiteId(site: Site): string {
  return siteNodeId(site, "website");
}

export function webPageId(site: Site, path: string): string {
  return `${pageUrl(site, path)}#webpage`;
}

export function breadcrumbId(site: Site, path: string): string {
  return `${pageUrl(site, path)}#breadcrumb`;
}

export function personId(site: Site, key: string): string {
  return siteNodeId(site, `person-${slugify(key)}`);
}

// ---------------------------------------------------------------------------
// Closed type lists
// ---------------------------------------------------------------------------

export const ORGANIZATION_TYPES = ["Organization", "Corporation", "OnlineBusiness", "OnlineStore", "NGO", "EducationalOrganization"] as const;
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

/** A page node's type. Not FAQPage: an FAQ page is `webPage({ faq })` (typed WebPage and FAQPage) or a lone `faqPage()`. */
export const WEB_PAGE_TYPES = [
  "WebPage",
  "AboutPage",
  "ContactPage",
  "CollectionPage",
  "ItemPage",
  "ProfilePage",
  "SearchResultsPage",
  "CheckoutPage",
  "QAPage",
] as const;
export type WebPageType = (typeof WEB_PAGE_TYPES)[number];

/** Google's accepted `applicationCategory` values. */
export const APPLICATION_CATEGORIES = [
  "GameApplication",
  "SocialNetworkingApplication",
  "TravelApplication",
  "ShoppingApplication",
  "SportsApplication",
  "LifestyleApplication",
  "BusinessApplication",
  "DesignApplication",
  "DeveloperApplication",
  "DriverApplication",
  "EducationalApplication",
  "HealthApplication",
  "FinanceApplication",
  "SecurityApplication",
  "BrowserApplication",
  "CommunicationApplication",
  "DesktopEnhancementApplication",
  "EntertainmentApplication",
  "MultimediaApplication",
  "HomeApplication",
  "UtilitiesApplication",
  "ReferenceApplication",
] as const;
export type ApplicationCategory = (typeof APPLICATION_CATEGORIES)[number];

export const SOFTWARE_TYPES = ["SoftwareApplication", "WebApplication", "MobileApplication", "VideoGame"] as const;
export type SoftwareType = (typeof SOFTWARE_TYPES)[number];

export const ARTICLE_TYPES = ["Article", "BlogPosting", "NewsArticle", "TechArticle", "Report"] as const;
export type ArticleType = (typeof ARTICLE_TYPES)[number];

/** Place and its subtypes that a site page is plausibly about. Every one is a real schema.org type. */
export const PLACE_TYPES = [
  "Place",
  "TouristAttraction",
  "TouristDestination",
  "Landform",
  "Mountain",
  "Volcano",
  "Continent",
  "BodyOfWater",
  "LakeBodyOfWater",
  "RiverBodyOfWater",
  "SeaBodyOfWater",
  "Waterfall",
  "Park",
  "Beach",
  "Campground",
  "CivicStructure",
  "Museum",
  "LandmarksOrHistoricalBuildings",
  "EventVenue",
  "StadiumOrArena",
  "AdministrativeArea",
  "City",
  "State",
  "Country",
] as const;
export type PlaceType = (typeof PLACE_TYPES)[number];

export const LOCAL_BUSINESS_TYPES = [
  "LocalBusiness",
  "ProfessionalService",
  "HomeAndConstructionBusiness",
  "GeneralContractor",
  "HousePainter",
  "Electrician",
  "Plumber",
  "RoofingContractor",
  "HVACBusiness",
  "Locksmith",
  "MovingCompany",
  "AutoRepair",
  "AutomotiveBusiness",
  "Store",
  "Restaurant",
  "FoodEstablishment",
  "LegalService",
  "AccountingService",
  "FinancialService",
  "RealEstateAgent",
  "MedicalBusiness",
  "Dentist",
  "HealthAndBeautyBusiness",
  "BeautySalon",
  "SportsActivityLocation",
  "EntertainmentBusiness",
  "LodgingBusiness",
  "TravelAgency",
  "ChildCare",
  "DryCleaningOrLaundry",
  "EmploymentAgency",
] as const;
export type LocalBusinessType = (typeof LOCAL_BUSINESS_TYPES)[number];

export const AVAILABILITIES = [
  "InStock",
  "OutOfStock",
  "PreOrder",
  "PreSale",
  "BackOrder",
  "Discontinued",
  "LimitedAvailability",
  "OnlineOnly",
  "InStoreOnly",
  "SoldOut",
] as const;
export type Availability = (typeof AVAILABILITIES)[number];

// ---------------------------------------------------------------------------
// Shared input shapes
// ---------------------------------------------------------------------------

export interface PostalAddressInput {
  streetAddress?: string;
  addressLocality?: string;
  addressRegion?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-2 ("US") preferred. Never defaulted. */
  addressCountry?: string;
}

export interface GeoInput {
  latitude: number;
  longitude: number;
  elevation?: { value: number; unit: "m" | "ft" };
}

/** An image: a path or URL, or one with its size. */
export type ImageInput = string | { url: string; width?: number; height?: number; caption?: string };

/** A person or organization, by reference or by name. */
export type PartyInput = Ref | { name: string; url?: string; type?: "Person" | "Organization" };

export interface AggregateRatingInput {
  /** The average, between `worst` and `best`. */
  value: number;
  /** How many ratings (or reviews) it averages. At least 1. */
  count: number;
  /** "rating" (default) writes ratingCount; "review" writes reviewCount. */
  countOf?: "rating" | "review";
  best?: number;
  worst?: number;
}

export interface ReviewInput {
  /** A name or a party. Google's review snippet needs the author's name. */
  author: string | PartyInput;
  /** Required on a Product's or Software App's review unless `richResult: false`: Google's review snippet needs it. */
  rating?: number;
  best?: number;
  worst?: number;
  body?: string;
  name?: string;
  datePublished?: DateInput;
}

export interface OfferInput {
  /** Major units (39.99), never cents. Strings must be plain decimals ("39.99"). */
  price: number | string;
  /** ISO 4217, e.g. "USD". */
  currency: string;
  /** Stock status. Never defaulted: an untracked item is not "out of stock". */
  availability?: Availability;
  /** The page the offer is bought on. Defaults to the node's own page. */
  url?: string;
  name?: string;
  priceValidUntil?: DateInput;
  itemCondition?: "NewCondition" | "UsedCondition" | "RefurbishedCondition" | "DamagedCondition";
  /**
   * A subscription's billing period: writes a UnitPriceSpecification billed
   * per one period (`unitCode` "MON", `billingIncrement` 1), the shape Google
   * documents for subscription costs. Never `referenceQuantity`, which Google's
   * merchant listings read as unit pricing (a price per kilogram).
   */
  billing?: "month" | "year" | "week" | "day";
  /** Default: the site's Organization. Pass false for none. */
  seller?: Ref | false;
  shipping?: ShippingInput;
  returnPolicy?: ReturnPolicyInput;
}

export interface ShippingInput {
  rate: number;
  /** Defaults to the offer's currency. */
  currency?: string;
  /** ISO 3166-1 alpha-2 destination(s). */
  country: string | readonly string[];
  /** [min, max] business days to handle the order. */
  handlingDays?: readonly [number, number];
  /** [min, max] days in transit. */
  transitDays?: readonly [number, number];
}

export interface ReturnPolicyInput {
  /** ISO 3166-1 alpha-2. */
  country: string;
  category: "finite" | "unlimited" | "none";
  /** Required for "finite". */
  days?: number;
  method?: "mail" | "store" | "kiosk";
  fees?: "free" | "customer" | "restocking";
}

// ---------------------------------------------------------------------------
// Small converters
// ---------------------------------------------------------------------------

function text(issues: Issues, value: string | undefined, field: string, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) issues.add(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") {
    issues.add(`${field} must be text`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "" && required) issues.add(`${field} is required`);
  return trimmed === "" ? undefined : trimmed;
}

function url(site: Site, issues: Issues, value: string | undefined, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  try {
    return absoluteUrl(site, value);
  } catch {
    issues.add(`${field} must be an absolute URL or a path starting with "/" (got "${value}")`);
    return undefined;
  }
}

/** `sameAs`: the same thing's profiles ELSEWHERE (social, directories), so never a page on this site. */
function sameAs(site: Site, issues: Issues, values: ReadonlyArray<string | null | undefined | false> | undefined, field: string): string[] | undefined {
  if (!values) return undefined;
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const resolved = url(site, issues, value, field);
    if (resolved && new URL(resolved).origin === site.url) {
      issues.add(`${field} "${value}" is on this site; sameAs names profiles elsewhere (a page here is \`url\`)`);
      continue;
    }
    if (resolved && !out.includes(resolved)) out.push(resolved);
  }
  return out.length > 0 ? out : undefined;
}

/** A logo: a raster image, never a .ico icon container (Google wants at least 112×112). */
function logo(site: Site, issues: Issues, value: ImageInput | undefined, field: string): unknown {
  if (value === undefined) return undefined;
  const raw = typeof value === "string" ? value : value.url;
  if (typeof raw === "string" && /\.ico$/i.test(raw.split(/[?#]/)[0]!)) {
    issues.add(`${field} "${raw}" is an .ico file; use a square PNG, JPEG, WebP or SVG of at least 112×112`);
    return undefined;
  }
  return image(site, issues, value, field);
}

function date(issues: Issues, value: DateInput | undefined | null, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const check = checkDate(value);
  if ("problem" in check) {
    issues.add(`${field} ${check.problem}`);
    return undefined;
  }
  return check.iso;
}

function oneOf<T extends string>(issues: Issues, value: T | undefined, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) {
    issues.add(`${field} "${String(value)}" is not one of ${allowed.join(", ")}`);
    return undefined;
  }
  return value;
}

function image(site: Site, issues: Issues, value: ImageInput | undefined, field: string): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "string") return url(site, issues, value, field);
  const resolved = url(site, issues, value.url, `${field}.url`);
  if (!resolved) return undefined;
  if (value.width === undefined && value.height === undefined && !value.caption) return resolved;
  return { "@type": "ImageObject", url: resolved, contentUrl: resolved, width: value.width, height: value.height, caption: value.caption };
}

function images(site: Site, issues: Issues, value: ImageInput | readonly ImageInput[] | undefined, field: string): unknown[] | undefined {
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : [value]) as ImageInput[];
  const out = list.map((entry, i) => image(site, issues, entry, `${field}[${i}]`)).filter((entry) => entry !== undefined);
  return out.length > 0 ? out : undefined;
}

function address(issues: Issues, value: PostalAddressInput | undefined, field: string): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const fields = ["streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry"] as const;
  const out: Record<string, unknown> = { "@type": "PostalAddress" };
  let any = false;
  for (const key of fields) {
    const entry = value[key];
    if (typeof entry === "string" && entry.trim() !== "") {
      out[key] = key === "addressCountry" && /^[a-z]{2}$/i.test(entry.trim()) ? entry.trim().toUpperCase() : entry.trim();
      any = true;
    }
  }
  if (!any) issues.add(`${field} has no fields`);
  return out;
}

function geo(issues: Issues, value: GeoInput | undefined, field: string): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const okLat = Number.isFinite(value.latitude) && value.latitude >= -90 && value.latitude <= 90;
  const okLng = Number.isFinite(value.longitude) && value.longitude >= -180 && value.longitude <= 180;
  issues.check(okLat, `${field}.latitude must be between -90 and 90`);
  issues.check(okLng, `${field}.longitude must be between -180 and 180`);
  if (value.elevation) issues.check(Number.isFinite(value.elevation.value), `${field}.elevation.value must be a number`);
  return {
    "@type": "GeoCoordinates",
    latitude: value.latitude,
    longitude: value.longitude,
    elevation: value.elevation ? `${value.elevation.value} ${value.elevation.unit}` : undefined,
  };
}

function party(site: Site, issues: Issues, value: PartyInput | string | undefined, field: string, fallbackType: "Person" | "Organization"): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const name = text(issues, value, `${field}`, true);
    return name ? { "@type": fallbackType, name } : undefined;
  }
  if ("@id" in value) return ref(value["@id"]);
  const name = text(issues, value.name, `${field}.name`, true);
  return { "@type": value.type ?? fallbackType, name, url: url(site, issues, value.url, `${field}.url`) };
}

const CURRENCY = /^[A-Z]{3}$/;

function fractionDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

function price(issues: Issues, value: number | string, currency: string, field: string): string | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      issues.add(`${field} must be a number of at least 0, in major units (39.99, not cents)`);
      return undefined;
    }
    return value.toFixed(fractionDigits(currency));
  }
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value.trim())) {
    issues.add(`${field} must be a plain decimal like "39.99"`);
    return undefined;
  }
  return value.trim();
}

const BILLING_UNIT = { day: "DAY", week: "WEE", month: "MON", year: "ANN" } as const;

function offer(site: Site, issues: Issues, input: OfferInput, field: string, defaultUrl: string | undefined): Record<string, unknown> {
  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
  issues.check(CURRENCY.test(currency), `${field}.currency must be an ISO 4217 code like "USD"`);
  const amount = price(issues, input.price, currency, `${field}.price`);
  const availability = oneOf(issues, input.availability, AVAILABILITIES, `${field}.availability`);
  const shipping = input.shipping ? shippingDetails(issues, input.shipping, currency, `${field}.shipping`) : undefined;
  const returns = input.returnPolicy ? returnPolicy(issues, input.returnPolicy, `${field}.returnPolicy`) : undefined;
  const billing = input.billing ? oneOf(issues, input.billing, ["day", "week", "month", "year"], `${field}.billing`) : undefined;
  return {
    "@type": "Offer",
    name: input.name ? oneLine(input.name) : undefined,
    price: amount,
    priceCurrency: currency,
    priceSpecification: billing
      ? {
          "@type": "UnitPriceSpecification",
          price: amount,
          priceCurrency: currency,
          unitCode: BILLING_UNIT[billing],
          billingIncrement: 1,
        }
      : undefined,
    availability: availability ? `https://schema.org/${availability}` : undefined,
    url: url(site, issues, input.url, `${field}.url`) ?? defaultUrl,
    priceValidUntil: date(issues, input.priceValidUntil, `${field}.priceValidUntil`),
    itemCondition: input.itemCondition ? `https://schema.org/${input.itemCondition}` : undefined,
    seller: input.seller === false ? undefined : (input.seller ?? ref(organizationId(site))),
    shippingDetails: shipping,
    hasMerchantReturnPolicy: returns,
  };
}

function days(issues: Issues, range: readonly [number, number] | undefined, field: string): Record<string, unknown> | undefined {
  if (!range) return undefined;
  const [min, max] = range;
  issues.check(Number.isInteger(min) && Number.isInteger(max) && min >= 0 && max >= min, `${field} must be [min, max] whole days with min ≤ max`);
  return { "@type": "QuantitativeValue", minValue: min, maxValue: max, unitCode: "DAY" };
}

function shippingDetails(issues: Issues, input: ShippingInput, offerCurrency: string, field: string): Record<string, unknown> {
  const currency = (input.currency ?? offerCurrency).toUpperCase();
  issues.check(Number.isFinite(input.rate) && input.rate >= 0, `${field}.rate must be at least 0`);
  issues.check(CURRENCY.test(currency), `${field}.currency must be an ISO 4217 code`);
  const countries = (typeof input.country === "string" ? [input.country] : [...input.country]).map((c) => c.trim().toUpperCase());
  issues.check(countries.length > 0 && countries.every((c) => /^[A-Z]{2}$/.test(c)), `${field}.country must be ISO 3166-1 alpha-2 codes`);
  const handling = days(issues, input.handlingDays, `${field}.handlingDays`);
  const transit = days(issues, input.transitDays, `${field}.transitDays`);
  return {
    "@type": "OfferShippingDetails",
    shippingRate: { "@type": "MonetaryAmount", value: Number.isFinite(input.rate) ? input.rate : undefined, currency },
    // One DefinedRegion per country, as Google's examples write it (addressCountry is one code).
    shippingDestination: countries.length === 1 ? { "@type": "DefinedRegion", addressCountry: countries[0] } : countries.map((c) => ({ "@type": "DefinedRegion", addressCountry: c })),
    deliveryTime: handling || transit ? { "@type": "ShippingDeliveryTime", handlingTime: handling, transitTime: transit } : undefined,
  };
}

const RETURN_CATEGORY = {
  finite: "https://schema.org/MerchantReturnFiniteReturnWindow",
  unlimited: "https://schema.org/MerchantReturnUnlimitedWindow",
  none: "https://schema.org/MerchantReturnNotPermitted",
} as const;
const RETURN_METHOD = { mail: "https://schema.org/ReturnByMail", store: "https://schema.org/ReturnInStore", kiosk: "https://schema.org/ReturnAtKiosk" } as const;
const RETURN_FEES = {
  free: "https://schema.org/FreeReturn",
  customer: "https://schema.org/ReturnFeesCustomerResponsibility",
  restocking: "https://schema.org/RestockingFees",
} as const;

function returnPolicy(issues: Issues, input: ReturnPolicyInput, field: string): Record<string, unknown> {
  const country = typeof input.country === "string" ? input.country.trim().toUpperCase() : "";
  issues.check(/^[A-Z]{2}$/.test(country), `${field}.country must be an ISO 3166-1 alpha-2 code`);
  const category = oneOf(issues, input.category, ["finite", "unlimited", "none"], `${field}.category`);
  if (category === "finite") issues.check(Number.isInteger(input.days) && (input.days ?? 0) > 0, `${field}.days is required for a finite return window`);
  return {
    "@type": "MerchantReturnPolicy",
    applicableCountry: country,
    returnPolicyCategory: category ? RETURN_CATEGORY[category] : undefined,
    merchantReturnDays: category === "finite" ? input.days : undefined,
    returnMethod: input.method ? RETURN_METHOD[input.method] : undefined,
    returnFees: input.fees ? RETURN_FEES[input.fees] : undefined,
  };
}

function aggregateRating(issues: Issues, input: AggregateRatingInput | undefined, field: string): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const best = input.best ?? 5;
  const worst = input.worst ?? 1;
  issues.check(Number.isFinite(best) && Number.isFinite(worst) && best > worst, `${field}: best must be greater than worst`);
  issues.check(Number.isFinite(input.value) && input.value >= worst && input.value <= best, `${field}.value must be between ${worst} and ${best}`);
  issues.check(Number.isInteger(input.count) && input.count >= 1, `${field}.count must be a whole number of at least 1`);
  return {
    "@type": "AggregateRating",
    ratingValue: input.value,
    bestRating: best,
    worstRating: worst,
    [input.countOf === "review" ? "reviewCount" : "ratingCount"]: input.count,
  };
}

/**
 * An AggregateRating from raw ratings, or undefined below `min` of them
 * (trailcards' credibility rule: no average shown until there are 3).
 */
export function aggregateRatingFrom(
  ratings: readonly number[],
  options: { min?: number; best?: number; worst?: number; decimals?: number } = {},
): AggregateRatingInput | undefined {
  const valid = ratings.filter((r) => Number.isFinite(r));
  if (valid.length === 0 || valid.length < (options.min ?? 1)) return undefined;
  const factor = 10 ** (options.decimals ?? 1);
  const value = Math.round((valid.reduce((sum, r) => sum + r, 0) / valid.length) * factor) / factor;
  return { value, count: valid.length, best: options.best ?? 5, worst: options.worst ?? 1 };
}

function review(site: Site, issues: Issues, input: ReviewInput, field: string, requireRating = false): Record<string, unknown> {
  const best = input.best ?? 5;
  const worst = input.worst ?? 1;
  if (input.rating === undefined && requireRating) {
    issues.add(`${field}.rating is required: Google's review snippet reports a review without one as invalid (or pass richResult: false)`);
  }
  if (input.rating !== undefined) {
    issues.check(Number.isFinite(input.rating) && input.rating >= worst && input.rating <= best, `${field}.rating must be between ${worst} and ${best}`);
  }
  return {
    "@type": "Review",
    author: party(site, issues, input.author, `${field}.author`, "Person"),
    reviewRating: input.rating === undefined ? undefined : { "@type": "Rating", ratingValue: input.rating, bestRating: best, worstRating: worst },
    reviewBody: input.body,
    name: input.name,
    datePublished: date(issues, input.datePublished, `${field}.datePublished`),
  };
}

function finish<T extends JsonLdNode>(issues: Issues, node: T): T {
  issues.throwIfAny();
  return compact(node);
}

// ---------------------------------------------------------------------------
// Organization, WebSite
// ---------------------------------------------------------------------------

export interface OrganizationInput {
  type?: OrganizationType;
  /** Default: the site name. */
  name?: string;
  /** Default: the site URL. */
  url?: string;
  /** A square raster image of at least 112×112 (not favicon.ico). */
  logo?: ImageInput;
  description?: string;
  legalName?: string;
  /** Social and directory profiles, never a page on this site. Empty and falsy entries are dropped; an empty list is omitted. */
  sameAs?: ReadonlyArray<string | null | undefined | false>;
  email?: string;
  telephone?: string;
  address?: PostalAddressInput;
  contactPoints?: ReadonlyArray<{ contactType: string; email?: string; telephone?: string; url?: string; availableLanguage?: string | readonly string[] }>;
  foundingDate?: DateInput;
  founders?: readonly PartyInput[];
  id?: string;
}

export function organization(site: Site, input: OrganizationInput = {}): JsonLdNode {
  const issues = new Issues("organization");
  const type = oneOf(issues, input.type ?? "Organization", ORGANIZATION_TYPES, "type");
  if (input.email !== undefined) issues.check(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email), "email is not an email address");
  return finish(issues, {
    "@type": type ?? "Organization",
    "@id": nodeId(site, null, input.id, "organization"),
    name: text(issues, input.name ?? site.name, "name", true),
    legalName: text(issues, input.legalName, "legalName", false),
    url: url(site, issues, input.url, "url") ?? pageUrl(site, "/"),
    logo: logo(site, issues, input.logo, "logo"),
    description: text(issues, input.description, "description", false),
    email: input.email,
    telephone: input.telephone,
    address: address(issues, input.address, "address"),
    contactPoint: input.contactPoints?.map((point, i) => ({
      "@type": "ContactPoint",
      contactType: text(issues, point.contactType, `contactPoints[${i}].contactType`, true),
      email: point.email,
      telephone: point.telephone,
      url: url(site, issues, point.url, `contactPoints[${i}].url`),
      availableLanguage: point.availableLanguage,
    })),
    foundingDate: date(issues, input.foundingDate, "foundingDate"),
    founder: input.founders?.map((founder, i) => party(site, issues, founder, `founders[${i}]`, "Person")),
    sameAs: sameAs(site, issues, input.sameAs, "sameAs"),
  });
}

export interface WebSiteInput {
  name?: string;
  alternateName?: string;
  description?: string;
  inLanguage?: string;
  /**
   * Your site search, as a path or URL containing `{search_term_string}`,
   * e.g. "/search?q={search_term_string}". Writes a SearchAction. Google
   * retired the sitelinks search box this once fed (November 2024), so it
   * draws nothing in Google; it still tells other readers where your search
   * is.
   */
  searchUrlTemplate?: string;
  /** Default: the site's Organization. Pass false for none. */
  publisher?: Ref | false;
  id?: string;
}

export function webSite(site: Site, input: WebSiteInput = {}): JsonLdNode {
  const issues = new Issues("webSite");
  let action: Record<string, unknown> | undefined;
  if (input.searchUrlTemplate !== undefined) {
    issues.check(input.searchUrlTemplate.includes("{search_term_string}"), "searchUrlTemplate must contain {search_term_string}");
    const template = input.searchUrlTemplate.startsWith("/") ? `${site.url}${input.searchUrlTemplate}` : input.searchUrlTemplate;
    issues.check(isHttpUrl(template.replace("{search_term_string}", "x")), "searchUrlTemplate must be a path or an absolute URL");
    action = {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: template },
      "query-input": "required name=search_term_string",
    };
  }
  return finish(issues, {
    "@type": "WebSite",
    "@id": nodeId(site, null, input.id, "website"),
    url: pageUrl(site, "/"),
    name: text(issues, input.name ?? site.name, "name", true),
    alternateName: text(issues, input.alternateName, "alternateName", false),
    description: text(issues, input.description ?? site.description, "description", false),
    inLanguage: input.inLanguage ?? site.language,
    publisher: input.publisher === false ? undefined : (input.publisher ?? ref(organizationId(site))),
    potentialAction: action,
  });
}

// ---------------------------------------------------------------------------
// WebPage, CollectionPage, Speakable, BreadcrumbList
// ---------------------------------------------------------------------------

export interface SpeakableSpecification {
  "@type": "SpeakableSpecification";
  cssSelector?: string[];
  xpath?: string[];
}

/**
 * The parts of a page a voice assistant may read aloud. Exactly one of
 * `cssSelector` or `xpath`. Point it at the page's own lead (its h1 and first
 * paragraph), and keep those selectors stable: a selector that matches
 * nothing (trailcards' `main p:first-of-type` under a nested <main>) is
 * silently useless. Google reads it for news publishers only (beta); answer
 * engines may read it anywhere.
 */
export function speakable(input: { cssSelector?: readonly string[]; xpath?: readonly string[] }): SpeakableSpecification {
  const issues = new Issues("speakable");
  const css = (input.cssSelector ?? []).map((s) => s.trim()).filter(Boolean);
  const xpath = (input.xpath ?? []).map((s) => s.trim()).filter(Boolean);
  issues.check((css.length > 0) !== (xpath.length > 0), "give exactly one of cssSelector or xpath, non-empty");
  issues.throwIfAny();
  return css.length > 0 ? { "@type": "SpeakableSpecification", cssSelector: css } : { "@type": "SpeakableSpecification", xpath };
}

export interface WebPageInput {
  path: string;
  name: string;
  description?: string;
  type?: WebPageType;
  datePublished?: DateInput;
  dateModified?: DateInput;
  inLanguage?: string;
  /** true: link the page's BreadcrumbList (`{canonical}#breadcrumb`). */
  breadcrumb?: boolean | Ref;
  primaryImage?: ImageInput;
  about?: Ref | readonly Ref[];
  mainEntity?: Ref | readonly Ref[];
  /**
   * The page's FAQ, from the same list the page renders. The page node is
   * then typed `["WebPage", "FAQPage"]` with the questions as its
   * `mainEntity`: ONE page node for the URL, where a separate `faqPage()`
   * beside a `webPage()` would make two. Not with `mainEntity`.
   */
  faq?: readonly FaqItemInput[];
  speakable?: SpeakableSpecification;
  /** Default: the site's WebSite. */
  isPartOf?: Ref;
  id?: string;
}

export function webPage(site: Site, input: WebPageInput): JsonLdNode {
  const issues = new Issues("webPage");
  const canonical = safePageUrl(site, issues, input.path);
  const type = oneOf(issues, input.type ?? "WebPage", WEB_PAGE_TYPES, "type");
  const breadcrumb = input.breadcrumb === true ? (canonical ? { "@id": `${canonical}#breadcrumb` } : undefined) : input.breadcrumb || undefined;
  if (input.faq !== undefined) {
    issues.check(input.mainEntity === undefined, "faq and mainEntity cannot both be given: the FAQ's questions are the page's main entity");
    issues.check(input.faq.length > 0, "faq must have at least one question when given");
  }
  const questions = input.faq ? faqQuestions(issues, input.faq, "faq") : undefined;
  return finish(issues, {
    "@type": questions ? [type ?? "WebPage", "FAQPage"] : (type ?? "WebPage"),
    "@id": nodeId(site, canonical, input.id, "webpage"),
    url: canonical,
    name: text(issues, input.name, "name", true),
    description: text(issues, input.description, "description", false),
    isPartOf: input.isPartOf ?? ref(webSiteId(site)),
    inLanguage: input.inLanguage ?? site.language,
    datePublished: date(issues, input.datePublished, "datePublished"),
    dateModified: date(issues, input.dateModified, "dateModified"),
    breadcrumb,
    primaryImageOfPage: input.primaryImage === undefined ? undefined : imageObject(site, issues, input.primaryImage, "primaryImage"),
    about: input.about,
    mainEntity: questions ?? input.mainEntity,
    speakable: input.speakable,
  });
}

function imageObject(site: Site, issues: Issues, value: ImageInput, field: string): Record<string, unknown> | undefined {
  const descriptor = typeof value === "string" ? { url: value } : value;
  const resolved = url(site, issues, descriptor.url, `${field}.url`);
  if (!resolved) return undefined;
  return { "@type": "ImageObject", url: resolved, contentUrl: resolved, width: descriptor.width, height: descriptor.height, caption: descriptor.caption };
}

function safePageUrl(site: Site, issues: Issues, path: string): string | null {
  if (typeof path !== "string" || path.trim() === "") {
    issues.add("path is required");
    return null;
  }
  try {
    return pageUrl(site, path);
  } catch (error) {
    issues.add((error as Error).message.replace(/^@adminigloo\/seo pageUrl: /, ""));
    return null;
  }
}

export interface CollectionPageInput extends Omit<WebPageInput, "type" | "mainEntity"> {
  /** The ItemList this page collects (from `itemList()`); linked as mainEntity. */
  list?: JsonLdNode | Ref;
}

/** A WebPage of type CollectionPage whose mainEntity is its ItemList (/templates, /trails, /use-cases). */
export function collectionPage(site: Site, input: CollectionPageInput): JsonLdNode {
  const { list, ...rest } = input;
  return webPage(site, { ...rest, type: "CollectionPage", ...(list ? { mainEntity: ref(list["@id"]) } : {}) });
}

export interface BreadcrumbItemInput {
  name: string;
  /** Path or URL. May be left out on the last item only (it becomes the page itself). */
  path?: string;
}

export function breadcrumbList(site: Site, input: { path: string; items: readonly BreadcrumbItemInput[]; id?: string }): JsonLdNode {
  const issues = new Issues("breadcrumbList");
  const canonical = safePageUrl(site, issues, input.path);
  issues.check(Array.isArray(input.items) && input.items.length > 0, "items must have at least one entry");
  const items = (input.items ?? []).map((item, i) => {
    const last = i === input.items.length - 1;
    const target = item.path === undefined ? (last ? (canonical ?? undefined) : undefined) : url(site, issues, item.path, `items[${i}].path`);
    if (target === undefined && !last) issues.add(`items[${i}].path is required (only the last item may leave it out)`);
    return { "@type": "ListItem", position: i + 1, name: text(issues, item.name, `items[${i}].name`, true), item: target };
  });
  return finish(issues, {
    "@type": "BreadcrumbList",
    "@id": nodeId(site, canonical, input.id, "breadcrumb"),
    itemListElement: items,
  });
}

// ---------------------------------------------------------------------------
// Product, SoftwareApplication
// ---------------------------------------------------------------------------

export interface ProductInput extends RichResultOption {
  path: string;
  name: string;
  description?: string;
  /**
   * Required once there are offers (unless `richResult: false`): Google reads
   * a Product with an Offer as a merchant listing, where the image is
   * required. Also recommended there: `shipping` and `returnPolicy` on the
   * offer.
   */
  image?: ImageInput | readonly ImageInput[];
  sku?: string;
  mpn?: string;
  gtin?: string;
  /** A brand name, or a ref (e.g. to the site's Organization). */
  brand?: string | Ref;
  category?: string;
  offers?: OfferInput | readonly OfferInput[];
  aggregateRating?: AggregateRatingInput;
  reviews?: readonly ReviewInput[];
  /** Several Products on one page (a pricing page) each need their own, e.g. "plan-pro". */
  id?: string;
}

export function product(site: Site, input: ProductInput): JsonLdNode {
  const issues = new Issues("product");
  const canonical = safePageUrl(site, issues, input.path);
  const offers = input.offers === undefined ? [] : Array.isArray(input.offers) ? input.offers : [input.offers as OfferInput];
  const rich = input.richResult !== false;
  if (rich) {
    issues.check(
      offers.length > 0 || input.aggregateRating !== undefined || (input.reviews?.length ?? 0) > 0,
      "a Product needs at least one of offers, aggregateRating or rated reviews (or richResult: false, for a plan with no public price)",
    );
    const imageCount = input.image === undefined ? 0 : Array.isArray(input.image) ? input.image.length : 1;
    if (offers.length > 0) {
      issues.check(imageCount > 0, "image is required with offers: Google reads a Product with an Offer as a merchant listing, which needs an image (or richResult: false)");
    }
  }
  if (input.gtin !== undefined) issues.check(/^\d{8}$|^\d{12,14}$/.test(input.gtin), "gtin must be 8, 12, 13 or 14 digits");
  return finish(issues, {
    "@type": "Product",
    "@id": nodeId(site, canonical, input.id, "product"),
    name: text(issues, input.name, "name", true),
    description: text(issues, input.description, "description", false),
    url: canonical ?? undefined,
    image: images(site, issues, input.image, "image"),
    sku: input.sku,
    mpn: input.mpn,
    gtin: input.gtin,
    brand: input.brand === undefined ? undefined : typeof input.brand === "string" ? { "@type": "Brand", name: input.brand } : input.brand,
    category: input.category,
    offers:
      offers.length === 0
        ? undefined
        : offers.length === 1
          ? offer(site, issues, offers[0]!, "offers", canonical ?? undefined)
          : offers.map((o, i) => offer(site, issues, o, `offers[${i}]`, canonical ?? undefined)),
    aggregateRating: aggregateRating(issues, input.aggregateRating, "aggregateRating"),
    review: input.reviews?.map((r, i) => review(site, issues, r, `reviews[${i}]`, rich)),
  });
}

export interface SoftwareApplicationInput extends RichResultOption {
  /** The app's page. Default: a site-wide node (`{origin}/#software`). */
  path?: string;
  type?: SoftwareType;
  name: string;
  description?: string;
  applicationCategory: ApplicationCategory;
  /** e.g. "Web", "iOS, Android". */
  operatingSystem?: string;
  /** Google requires a price (0 for free), unless `richResult: false`. */
  offers?: OfferInput | readonly OfferInput[];
  /** Google requires this or `reviews`, unless `richResult: false`. */
  aggregateRating?: AggregateRatingInput;
  reviews?: readonly ReviewInput[];
  screenshot?: ImageInput | readonly ImageInput[];
  featureList?: readonly string[];
  /** Default: the site's Organization. Pass false for none. */
  publisher?: Ref | false;
  id?: string;
}

export function softwareApplication(site: Site, input: SoftwareApplicationInput): JsonLdNode {
  const issues = new Issues("softwareApplication");
  const canonical = input.path === undefined ? null : safePageUrl(site, issues, input.path);
  const type = oneOf(issues, input.type ?? "SoftwareApplication", SOFTWARE_TYPES, "type");
  const category = oneOf(issues, input.applicationCategory, APPLICATION_CATEGORIES, "applicationCategory");
  issues.check(input.applicationCategory !== undefined, "applicationCategory is required");
  const offers = input.offers === undefined ? [] : Array.isArray(input.offers) ? input.offers : [input.offers as OfferInput];
  const rich = input.richResult !== false;
  if (rich) {
    issues.check(offers.length > 0, "offers is required (a price, 0 for free), or richResult: false");
    issues.check(
      input.aggregateRating !== undefined || (input.reviews?.length ?? 0) > 0,
      "aggregateRating or reviews is required: Google's Software App result needs one (an app with no ratings yet passes richResult: false)",
    );
  }
  const offerUrl = canonical ?? pageUrl(site, "/");
  return finish(issues, {
    "@type": type ?? "SoftwareApplication",
    "@id": nodeId(site, canonical, input.id, "software"),
    name: text(issues, input.name, "name", true),
    description: text(issues, input.description, "description", false),
    url: offerUrl,
    applicationCategory: category,
    operatingSystem: input.operatingSystem,
    offers:
      offers.length === 0
        ? undefined
        : offers.length === 1
          ? offer(site, issues, offers[0]!, "offers", offerUrl)
          : offers.map((o, i) => offer(site, issues, o, `offers[${i}]`, offerUrl)),
    aggregateRating: aggregateRating(issues, input.aggregateRating, "aggregateRating"),
    review: input.reviews?.map((r, i) => review(site, issues, r, `reviews[${i}]`, rich)),
    screenshot: images(site, issues, input.screenshot, "screenshot"),
    featureList: input.featureList && input.featureList.length > 0 ? [...input.featureList] : undefined,
    publisher: input.publisher === false ? undefined : (input.publisher ?? ref(organizationId(site))),
  });
}

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------

export type EventLocationInput =
  | { type: "virtual"; url?: string }
  | { type: "place"; name: string; address: PostalAddressInput; geo?: GeoInput };

export interface EventInput extends RichResultOption {
  path: string;
  name: string;
  description?: string;
  /**
   * Required by Google, unless `richResult: false` (an event with no date
   * yet, described without one). A date-time needs its time zone
   * ("2026-10-01T19:00:00-06:00"); it is kept with that offset.
   */
  startDate?: DateInput | null;
  endDate?: DateInput | null;
  /**
   * "rescheduled" needs `previousStartDate`; "moved-online" needs online or
   * mixed attendance with a virtual location (Google's rules for each).
   */
  status?: "scheduled" | "cancelled" | "postponed" | "rescheduled" | "moved-online";
  /** The start date(s) before a reschedule. */
  previousStartDate?: DateInput | readonly DateInput[];
  /** online needs a virtual location, offline a place, mixed both. */
  attendance: "online" | "offline" | "mixed";
  /** A virtual location defaults its URL to the event page. */
  location: EventLocationInput | readonly EventLocationInput[];
  organizer?: PartyInput;
  performer?: PartyInput | readonly PartyInput[];
  image?: ImageInput | readonly ImageInput[];
  offers?: OfferInput | readonly OfferInput[];
  /** Only when you know it; never defaulted. */
  isAccessibleForFree?: boolean;
  id?: string;
}

const EVENT_STATUS = {
  scheduled: "https://schema.org/EventScheduled",
  cancelled: "https://schema.org/EventCancelled",
  postponed: "https://schema.org/EventPostponed",
  rescheduled: "https://schema.org/EventRescheduled",
  "moved-online": "https://schema.org/EventMovedOnline",
} as const;
const ATTENDANCE = {
  online: "https://schema.org/OnlineEventAttendanceMode",
  offline: "https://schema.org/OfflineEventAttendanceMode",
  mixed: "https://schema.org/MixedEventAttendanceMode",
} as const;

export function event(site: Site, input: EventInput): JsonLdNode {
  const issues = new Issues("event");
  const canonical = safePageUrl(site, issues, input.path);
  const hasStart = input.startDate !== undefined && input.startDate !== null;
  if (input.richResult !== false) issues.check(hasStart, "startDate is required (an event with no date yet passes richResult: false)");
  const start = date(issues, input.startDate, "startDate");
  const end = date(issues, input.endDate, "endDate");
  if (start && end) issues.check(dateMillis(end) >= dateMillis(start), "endDate is before startDate");
  if (end && !hasStart) issues.add("endDate needs a startDate");
  const attendance = oneOf(issues, input.attendance, ["online", "offline", "mixed"], "attendance");
  const status = oneOf(issues, input.status ?? "scheduled", ["scheduled", "cancelled", "postponed", "rescheduled", "moved-online"], "status");
  const previous = (input.previousStartDate === undefined ? [] : Array.isArray(input.previousStartDate) ? input.previousStartDate : [input.previousStartDate as DateInput]).map(
    (value, i) => date(issues, value, `previousStartDate[${i}]`),
  );
  if (status === "rescheduled") issues.check(previous.length > 0, 'status "rescheduled" needs previousStartDate, the date it was moved from');
  else issues.check(previous.length === 0, 'previousStartDate is only for status "rescheduled"');
  const locations = (Array.isArray(input.location) ? input.location : input.location ? [input.location] : []) as EventLocationInput[];
  const hasVirtual = locations.some((l) => l.type === "virtual");
  const hasPlace = locations.some((l) => l.type === "place");
  if (attendance === "online") issues.check(hasVirtual, "an online event needs a virtual location");
  if (attendance === "offline") issues.check(hasPlace, "an offline event needs a place location");
  if (attendance === "mixed") issues.check(hasVirtual && hasPlace, "a mixed event needs a virtual and a place location");
  if (status === "moved-online") {
    issues.check(attendance === "online" || attendance === "mixed", 'status "moved-online" needs attendance "online" (or "mixed"), with a virtual location');
  }
  const location = locations.map((l, i) => {
    if (l.type === "virtual") return { "@type": "VirtualLocation", url: url(site, issues, l.url, `location[${i}].url`) ?? canonical ?? undefined };
    issues.check(l.address !== undefined, `location[${i}].address is required`);
    return {
      "@type": "Place",
      name: text(issues, l.name, `location[${i}].name`, true),
      address: address(issues, l.address, `location[${i}].address`),
      geo: geo(issues, l.geo, `location[${i}].geo`),
    };
  });
  const offers = input.offers === undefined ? [] : Array.isArray(input.offers) ? input.offers : [input.offers as OfferInput];
  const performers = input.performer === undefined ? [] : Array.isArray(input.performer) ? input.performer : [input.performer as PartyInput];
  return finish(issues, {
    "@type": "Event",
    "@id": nodeId(site, canonical, input.id, "event"),
    name: text(issues, input.name, "name", true),
    description: text(issues, input.description, "description", false),
    url: canonical ?? undefined,
    startDate: start,
    endDate: end,
    previousStartDate: previous.length === 0 ? undefined : previous.length === 1 ? previous[0] : previous,
    eventStatus: status ? EVENT_STATUS[status] : undefined,
    eventAttendanceMode: attendance ? ATTENDANCE[attendance] : undefined,
    location: location.length === 1 ? location[0] : location,
    organizer: party(site, issues, input.organizer, "organizer", "Organization"),
    performer: performers.length === 0 ? undefined : performers.map((p, i) => party(site, issues, p, `performer[${i}]`, "Person")),
    image: images(site, issues, input.image, "image"),
    offers: offers.length === 0 ? undefined : offers.map((o, i) => offer(site, issues, o, `offers[${i}]`, canonical ?? undefined)),
    isAccessibleForFree: input.isAccessibleForFree,
  });
}

// ---------------------------------------------------------------------------
// HowTo, FAQPage
// ---------------------------------------------------------------------------

export interface HowToInput {
  path: string;
  name: string;
  description?: string;
  steps: ReadonlyArray<{ name?: string; text: string; path?: string; image?: ImageInput }>;
  /** ISO 8601 duration, e.g. "PT15M". */
  totalTime?: string;
  estimatedCost?: { value: number; currency: string };
  supplies?: readonly string[];
  tools?: readonly string[];
  image?: ImageInput | readonly ImageInput[];
  id?: string;
}

export function howTo(site: Site, input: HowToInput): JsonLdNode {
  const issues = new Issues("howTo");
  const canonical = safePageUrl(site, issues, input.path);
  issues.check(Array.isArray(input.steps) && input.steps.length > 0, "steps must have at least one entry");
  if (input.totalTime !== undefined) issues.check(/^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/.test(input.totalTime), "totalTime must be an ISO 8601 duration like PT15M");
  if (input.estimatedCost) issues.check(CURRENCY.test(input.estimatedCost.currency), "estimatedCost.currency must be an ISO 4217 code");
  return finish(issues, {
    "@type": "HowTo",
    "@id": nodeId(site, canonical, input.id, "howto"),
    name: text(issues, input.name, "name", true),
    description: text(issues, input.description, "description", false),
    url: canonical ?? undefined,
    totalTime: input.totalTime,
    estimatedCost: input.estimatedCost ? { "@type": "MonetaryAmount", value: input.estimatedCost.value, currency: input.estimatedCost.currency } : undefined,
    supply: input.supplies?.map((name) => ({ "@type": "HowToSupply", name })),
    tool: input.tools?.map((name) => ({ "@type": "HowToTool", name })),
    image: images(site, issues, input.image, "image"),
    step: (input.steps ?? []).map((step, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      name: text(issues, step.name, `steps[${i}].name`, false),
      text: text(issues, step.text, `steps[${i}].text`, true),
      url: url(site, issues, step.path, `steps[${i}].path`),
      image: image(site, issues, step.image, `steps[${i}].image`),
    })),
  });
}

export interface FaqItemInput {
  question: string;
  /** Plain text, or the limited HTML Google allows (links, lists, bold). */
  answer: string;
}

function faqQuestions(issues: Issues, input: readonly FaqItemInput[], field: string): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return (input ?? []).map((item, i) => {
    const question = text(issues, item.question, `${field}[${i}].question`, true);
    if (question) {
      issues.check(!seen.has(question.toLowerCase()), `${field}[${i}].question repeats an earlier question`);
      seen.add(question.toLowerCase());
    }
    return { "@type": "Question", name: question, acceptedAnswer: { "@type": "Answer", text: text(issues, item.answer, `${field}[${i}].answer`, true) } };
  });
}

/**
 * The FAQ on a page, from the SAME list the page renders, so the markup can
 * never answer differently from the page. (Google shows FAQ rich results for
 * government and health sites only since 2023; answer engines still read it.)
 *
 * This node IS the page's node (an FAQPage is a WebPage), for a page that
 * has no `webPage()` node, like a home page whose graph is the Organization,
 * the app and its FAQ. A page that has a `webPage()` node passes the FAQ to
 * it (`webPage({ faq })`) instead: two page nodes for one URL is two FAQPage
 * nodes or two competing pages, and `graph()` refuses it.
 */
export function faqPage(site: Site, input: { path: string; items: readonly FaqItemInput[]; name?: string; id?: string }): JsonLdNode {
  const issues = new Issues("faqPage");
  const canonical = safePageUrl(site, issues, input.path);
  issues.check(Array.isArray(input.items) && input.items.length > 0, "items must have at least one question");
  const items = faqQuestions(issues, input.items ?? [], "items");
  return finish(issues, {
    "@type": "FAQPage",
    "@id": nodeId(site, canonical, input.id, "faq"),
    url: canonical ?? undefined,
    name: text(issues, input.name, "name", false),
    isPartOf: ref(webSiteId(site)),
    mainEntity: items,
  });
}

// ---------------------------------------------------------------------------
// Article / BlogPosting
// ---------------------------------------------------------------------------

export interface ArticleInput {
  path: string;
  type?: ArticleType;
  headline: string;
  description?: string;
  image?: ImageInput | readonly ImageInput[];
  datePublished: DateInput;
  dateModified?: DateInput;
  /** At least one. A ref (to a `person()` node) or a name. */
  authors: readonly PartyInput[];
  /** Default: the site's Organization. */
  publisher?: Ref;
  section?: string;
  keywords?: readonly string[];
  wordCount?: number;
  inLanguage?: string;
  speakable?: SpeakableSpecification;
  id?: string;
}

export function article(site: Site, input: ArticleInput): JsonLdNode {
  const issues = new Issues("article");
  const canonical = safePageUrl(site, issues, input.path);
  const type = oneOf(issues, input.type ?? "Article", ARTICLE_TYPES, "type");
  issues.check(Array.isArray(input.authors) && input.authors.length > 0, "authors must name at least one author");
  issues.check(input.datePublished !== undefined && input.datePublished !== null, "datePublished is required");
  const published = date(issues, input.datePublished, "datePublished");
  const modified = date(issues, input.dateModified, "dateModified");
  if (published && modified) issues.check(dateMillis(modified) >= dateMillis(published), "dateModified is before datePublished");
  if (input.wordCount !== undefined) issues.check(Number.isInteger(input.wordCount) && input.wordCount >= 0, "wordCount must be a whole number");
  return finish(issues, {
    "@type": type ?? "Article",
    "@id": nodeId(site, canonical, input.id, "article"),
    headline: text(issues, input.headline, "headline", true),
    description: text(issues, input.description, "description", false),
    url: canonical ?? undefined,
    mainEntityOfPage: canonical ? { "@id": `${canonical}#webpage` } : undefined,
    image: images(site, issues, input.image, "image"),
    datePublished: published,
    dateModified: modified,
    author: (input.authors ?? []).map((author, i) => party(site, issues, author, `authors[${i}]`, "Person")),
    publisher: input.publisher ?? ref(organizationId(site)),
    articleSection: input.section,
    keywords: input.keywords && input.keywords.length > 0 ? input.keywords.join(", ") : undefined,
    wordCount: input.wordCount,
    inLanguage: input.inLanguage ?? site.language,
    speakable: input.speakable,
  });
}

/** `article()` typed BlogPosting. */
export function blogPosting(site: Site, input: Omit<ArticleInput, "type">): JsonLdNode {
  return article(site, { ...input, type: "BlogPosting" });
}

// ---------------------------------------------------------------------------
// ItemList, Person
// ---------------------------------------------------------------------------

export interface ItemListInput {
  /** The page the list is on (its @id is `{canonical}#itemlist`). */
  path: string;
  name?: string;
  description?: string;
  /** Each item's own page. */
  items: ReadonlyArray<{ path: string; name?: string; image?: ImageInput }>;
  order?: "ascending" | "descending" | "unordered";
  id?: string;
}

/** A list of links to items' own pages (Google's "summary page" carousel shape). */
export function itemList(site: Site, input: ItemListInput): JsonLdNode {
  const issues = new Issues("itemList");
  const canonical = safePageUrl(site, issues, input.path);
  issues.check(Array.isArray(input.items) && input.items.length > 0, "items must have at least one entry");
  const order = oneOf(issues, input.order, ["ascending", "descending", "unordered"], "order");
  const ORDER = { ascending: "https://schema.org/ItemListOrderAscending", descending: "https://schema.org/ItemListOrderDescending", unordered: "https://schema.org/ItemListUnordered" };
  return finish(issues, {
    "@type": "ItemList",
    "@id": nodeId(site, canonical, input.id, "itemlist"),
    name: text(issues, input.name, "name", false),
    description: text(issues, input.description, "description", false),
    itemListOrder: order ? ORDER[order] : undefined,
    numberOfItems: input.items?.length ?? 0,
    itemListElement: (input.items ?? []).map((item, i) => {
      issues.check(typeof item.path === "string" && item.path !== "", `items[${i}].path is required`);
      return {
        "@type": "ListItem",
        position: i + 1,
        url: url(site, issues, item.path, `items[${i}].path`),
        name: text(issues, item.name, `items[${i}].name`, false),
        image: image(site, issues, item.image, `items[${i}].image`),
      };
    }),
  });
}

export interface PersonInput {
  name: string;
  /** What the @id is made from (default: the name). Use a stable key (a slug or user id) if names can change. */
  key?: string;
  /** Their page on this site, or elsewhere. */
  url?: string;
  image?: ImageInput;
  jobTitle?: string;
  description?: string;
  sameAs?: ReadonlyArray<string | null | undefined | false>;
  /** Default: the site's Organization. Pass false for none. */
  worksFor?: Ref | false;
  id?: string;
}

export function person(site: Site, input: PersonInput): JsonLdNode {
  const issues = new Issues("person");
  const name = text(issues, input.name, "name", true);
  return finish(issues, {
    "@type": "Person",
    "@id": input.id ? nodeId(site, null, input.id, "person") : personId(site, input.key ?? name ?? "person"),
    name,
    url: url(site, issues, input.url, "url"),
    image: image(site, issues, input.image, "image"),
    jobTitle: text(issues, input.jobTitle, "jobTitle", false),
    description: text(issues, input.description, "description", false),
    sameAs: sameAs(site, issues, input.sameAs, "sameAs"),
    worksFor: input.worksFor === false ? undefined : (input.worksFor ?? ref(organizationId(site))),
  });
}

// ---------------------------------------------------------------------------
// Place, TouristAttraction, LocalBusiness
// ---------------------------------------------------------------------------

export interface PlaceInput {
  /** The place's page on this site. Without one the node is site-wide (`{origin}/#place-{name}`). */
  path?: string;
  type?: PlaceType;
  /** A more specific real type, written as `additionalType` (e.g. "Mountain" on a TouristAttraction). */
  additionalType?: PlaceType;
  name: string;
  description?: string;
  geo?: GeoInput;
  address?: PostalAddressInput;
  image?: ImageInput | readonly ImageInput[];
  id?: string;
}

function placeNode(site: Site, issues: Issues, input: PlaceInput, defaultType: PlaceType, fragment: string): JsonLdNode {
  const canonical = input.path === undefined ? null : safePageUrl(site, issues, input.path);
  const type = oneOf(issues, input.type ?? defaultType, PLACE_TYPES, "type");
  const additional = oneOf(issues, input.additionalType, PLACE_TYPES, "additionalType");
  const name = text(issues, input.name, "name", true);
  return {
    "@type": type ?? defaultType,
    "@id": canonical ? nodeId(site, canonical, input.id, fragment) : nodeId(site, null, input.id, `${fragment}-${slugify(name ?? fragment)}`),
    additionalType: additional ? `https://schema.org/${additional}` : undefined,
    name,
    description: text(issues, input.description, "description", false),
    url: canonical ?? undefined,
    geo: geo(issues, input.geo, "geo"),
    address: address(issues, input.address, "address"),
    image: images(site, issues, input.image, "image"),
  };
}

export function place(site: Site, input: PlaceInput): JsonLdNode {
  const issues = new Issues("place");
  return finish(issues, placeNode(site, issues, input, "Place", "place"));
}

export interface TouristAttractionInput extends Omit<PlaceInput, "type"> {
  /** Only when you know it (fee areas exist); never defaulted. */
  isAccessibleForFree?: boolean;
  publicAccess?: boolean;
  touristType?: string | readonly string[];
  /** Where to book or buy (path or URL). */
  tourBookingPage?: string;
  aggregateRating?: AggregateRatingInput;
  reviews?: readonly ReviewInput[];
}

/**
 * ONE node per attraction page, ratings and photos included: trailcards
 * emitted two TouristAttraction nodes for each trail with nothing linking
 * them. A landform goes in `additionalType` ("Mountain", "Waterfall"), never
 * the invented "LandformFeature".
 */
export function touristAttraction(site: Site, input: TouristAttractionInput): JsonLdNode {
  const issues = new Issues("touristAttraction");
  const node = placeNode(site, issues, { ...input, type: "TouristAttraction" }, "TouristAttraction", "attraction");
  return finish(issues, {
    ...node,
    isAccessibleForFree: input.isAccessibleForFree,
    publicAccess: input.publicAccess,
    touristType: input.touristType,
    tourBookingPage: url(site, issues, input.tourBookingPage, "tourBookingPage"),
    aggregateRating: aggregateRating(issues, input.aggregateRating, "aggregateRating"),
    review: input.reviews?.map((r, i) => review(site, issues, r, `reviews[${i}]`)),
  });
}

export interface OpeningHoursInput {
  days: ReadonlyArray<"Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday" | "Sunday">;
  /** "09:00" */
  opens: string;
  /** "17:00". Open all day: opens "00:00", closes "23:59" (never "24:00"). */
  closes: string;
}

export interface LocalBusinessInput {
  type?: LocalBusinessType;
  /** Default: the site name. */
  name?: string;
  /** Default: the site URL. */
  url?: string;
  /** Required by Google. */
  address: PostalAddressInput;
  geo?: GeoInput;
  telephone?: string;
  email?: string;
  image?: ImageInput | readonly ImageInput[];
  logo?: ImageInput;
  description?: string;
  /** e.g. "$$". */
  priceRange?: string;
  openingHours?: readonly OpeningHoursInput[];
  areaServed?: string | readonly string[];
  /** Profiles elsewhere (a Google Business Profile, Yelp), never a page on this site. */
  sameAs?: ReadonlyArray<string | null | undefined | false>;
  // No aggregateRating or reviews, on purpose: this is the site's own business, and Google ignores
  // (and may act on) ratings a business publishes about itself, its own widgets of third-party reviews included.
  /** Default: the site's Organization. Pass false when the business IS the organization node. */
  parentOrganization?: Ref | false;
  id?: string;
}

export function localBusiness(site: Site, input: LocalBusinessInput): JsonLdNode {
  const issues = new Issues("localBusiness");
  const type = oneOf(issues, input.type ?? "LocalBusiness", LOCAL_BUSINESS_TYPES, "type");
  issues.check(input.address !== undefined, "address is required");
  const selfRated = input as LocalBusinessInput & { aggregateRating?: unknown; reviews?: unknown };
  if (selfRated.aggregateRating !== undefined || selfRated.reviews !== undefined) {
    issues.add(
      "aggregateRating and reviews are not accepted: this node is the site's own business, and Google ignores (and may act on) ratings a business publishes about itself",
    );
  }
  const hours = (input.openingHours ?? []).map((h, i) => {
    // 00:00 to 23:59, as Google reads them; open all day is opens "00:00", closes "23:59".
    issues.check(/^([01]\d|2[0-3]):[0-5]\d$/.test(h.opens) && /^([01]\d|2[0-3]):[0-5]\d$/.test(h.closes), `openingHours[${i}] times must be HH:MM from 00:00 to 23:59`);
    issues.check(h.days.length > 0, `openingHours[${i}].days must name at least one day`);
    return { "@type": "OpeningHoursSpecification", dayOfWeek: [...h.days], opens: h.opens, closes: h.closes };
  });
  return finish(issues, {
    "@type": type ?? "LocalBusiness",
    "@id": nodeId(site, null, input.id, "localbusiness"),
    name: text(issues, input.name ?? site.name, "name", true),
    url: url(site, issues, input.url, "url") ?? pageUrl(site, "/"),
    description: text(issues, input.description, "description", false),
    address: address(issues, input.address, "address"),
    geo: geo(issues, input.geo, "geo"),
    telephone: input.telephone,
    email: input.email,
    image: images(site, issues, input.image, "image"),
    logo: logo(site, issues, input.logo, "logo"),
    priceRange: input.priceRange,
    openingHoursSpecification: hours,
    areaServed: input.areaServed,
    sameAs: sameAs(site, issues, input.sameAs, "sameAs"),
    parentOrganization: input.parentOrganization === false ? undefined : (input.parentOrganization ?? ref(organizationId(site))),
  });
}
