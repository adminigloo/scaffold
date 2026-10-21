import { formatMoney } from "../format.js";
import { SIGNED_OUT_MESSAGE, statusWords, type ClientError } from "../http.js";
import type { EstimateSource, EstimateStatus, RecipeKey, UnitType } from "../types.js";
import type {
  AreaRecipeConfig,
  CountRecipeConfig,
  EstimateFilter,
  EstimateListRow,
  LinearRecipeConfig,
  RampRecipeConfig,
  RecipeConfig,
  RecipeInfo,
} from "./types.js";

/**
 * The staff screens' rules and words, pure: what a status or a refusal is
 * called, how an owner types a price or a percentage, and the four ways a
 * product can be measured. Unit tests, not click paths.
 *
 * The words are for a business owner, never a developer: "Accepted", "From
 * your website", "Retiring this takes it out of 3 products' prices" — not
 * status codes.
 */

// ---------------------------------------------------------------------------
// Typing numbers the way an owner does
// ---------------------------------------------------------------------------

/** "$1,234.56" / "1234.5" / "95" → cents; "" → null; anything else → NaN. Whole cents. */
export function parseMoneyInput(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  if (!/^-?\d*(?:\.\d*)?$/.test(cleaned) || cleaned === "." || cleaned === "-") return Number.NaN;
  return Math.round(Number(cleaned) * 100);
}

/** Cents as the text in a money field: 9500 → "95.00". Empty for null. */
export function centsToInput(cents: number | null | undefined): string {
  return typeof cents === "number" && Number.isFinite(cents) ? (cents / 100).toFixed(2) : "";
}

/** "7.25" / "7.25%" → 725 basis points; "" → null; anything else → NaN. */
export function parsePercentInput(text: string): number | null {
  const cleaned = text.replace(/[%\s]/g, "");
  if (cleaned === "") return null;
  if (!/^-?\d*(?:\.\d*)?$/.test(cleaned) || cleaned === ".") return Number.NaN;
  return Math.round(Number(cleaned) * 100);
}

/** Basis points as the text in a percentage field: 725 → "7.25", 4000 → "40". */
export function bpToInput(bp: number | null | undefined): string {
  if (typeof bp !== "number" || !Number.isFinite(bp)) return "";
  return String(Number.parseFloat((bp / 100).toFixed(2)));
}

/** "0.35" → 350 thousandths; "" → null; anything else → NaN. For hours and quantities. */
export function parseMilliInput(text: string): number | null {
  const cleaned = text.replace(/[,\s]/g, "");
  if (cleaned === "") return null;
  if (!/^\d*(?:\.\d*)?$/.test(cleaned) || cleaned === ".") return Number.NaN;
  return Math.round(Number(cleaned) * 1000);
}

/** Thousandths as text: 350 → "0.35", 2000 → "2". */
export function milliToInput(milli: number | null | undefined): string {
  if (typeof milli !== "number" || !Number.isFinite(milli)) return "";
  return String(Number.parseFloat((milli / 1000).toFixed(3)));
}

/** A plain number field: "12" → 12; "" → null; anything else → NaN. */
export function parseNumberInput(text: string): number | null {
  const cleaned = text.trim().replace(",", ".");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** AI spend: USD millionths as money a person reads ("$0.24", "under $0.01", "$0.00"). */
export function formatMicros(micros: number): string {
  if (!Number.isFinite(micros) || micros <= 0) return "$0.00";
  if (micros < 10_000) return "under $0.01";
  return formatMoney(Math.round(micros / 10_000), "USD", "en-US");
}

/** A small amount exactly, for "about $0.001 a photo": a tenth of a cent is still a number an owner can read. */
export function formatMicrosExact(micros: number): string {
  if (!Number.isFinite(micros) || micros <= 0) return "$0.00";
  if (micros >= 10_000) return formatMoney(Math.round(micros / 10_000), "USD", "en-US");
  const dollars = (micros / 1_000_000).toFixed(4).replace(/0+$/, "");
  return `$${dollars}`;
}

// ---------------------------------------------------------------------------
// Statuses, sources, filters
// ---------------------------------------------------------------------------

export const UNIT_LABEL: Record<UnitType, string> = { per_linear_ft: "per ft", per_sqft: "per sq ft", per_unit: "each", flat: "flat" };

export const SOURCE_LABEL: Record<EstimateSource, string> = { public_tool: "From your website", photo: "Photo estimate", staff: "Made by staff" };

export const FILTER_LABEL: Record<EstimateFilter, string> = {
  leads: "Leads",
  drafts: "Drafts",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  converted: "Invoiced",
  all: "All",
  archived: "Archived",
};

export const FILTER_EMPTY: Record<EstimateFilter, string> = {
  leads: "No leads yet. Share your estimate page to get some.",
  drafts: "No drafts. Start one with New estimate.",
  sent: "No quotes are waiting on an answer.",
  accepted: "No accepted quotes yet.",
  declined: "No declined quotes.",
  expired: "No expired quotes.",
  converted: "Nothing has been invoiced yet.",
  all: "No estimates yet. Share your estimate page, or start one with New estimate.",
  archived: "Nothing is archived.",
};

export type StatusTone = "accent" | "muted" | "warn" | "ok" | "danger";

/**
 * A status as staff read it, with a tone for its tag (colour is never the only
 * signal: the words are always there). A draft that came from the website and
 * was never sent is a "New lead"; a draft that was sent before is being
 * revised (`validUntil` is set by every send and kept).
 */
export function statusLabel(row: { status: EstimateStatus; source: EstimateSource; validUntil: string | null }): { label: string; tone: StatusTone } {
  switch (row.status) {
    case "draft":
      if (row.validUntil) return { label: "Being revised", tone: "muted" };
      return row.source === "staff" ? { label: "Draft", tone: "muted" } : { label: "New lead", tone: "accent" };
    case "sent":
      return { label: "Sent", tone: "warn" };
    case "viewed":
      return { label: "Viewed", tone: "warn" };
    case "approved":
      return { label: "Accepted", tone: "ok" };
    case "rejected":
      return { label: "Declined", tone: "danger" };
    case "expired":
      return { label: "Expired", tone: "muted" };
    case "converted":
      return { label: "Invoiced", tone: "ok" };
  }
}

/** "just now", "5 min ago", "2 h ago", "3 days ago", else the date. */
export function timeAgo(instant: string, nowMs: number, locale = "en-US"): string {
  const at = Date.parse(instant);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.round((nowMs - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
  try {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric" }).format(at);
  } catch {
    return new Date(at).toDateString();
  }
}

/** Is a queue row a lead whose amount is still a range? */
export function showsRange(row: Pick<EstimateListRow, "status" | "rangeLow" | "rangeHigh">): boolean {
  return row.status === "draft" && row.rangeLow !== row.rangeHigh;
}

// ---------------------------------------------------------------------------
// Errors in plain words
// ---------------------------------------------------------------------------

/**
 * What staff read when a change didn't go through. The estimator's refusals
 * are written as one plain sentence an owner can act on ("This quote has been
 * sent. Revise it to make changes."), so the server's message is shown as it
 * is wherever there is one; fixed words cover the rest.
 */
export function adminErrorText(error: ClientError): string {
  if (error.status === 401) return SIGNED_OUT_MESSAGE;
  const own = error.message && error.message !== error.code ? error.message : null;
  switch (error.code) {
    case "network":
      return "Couldn't reach the server. Check your connection and try again.";
    case "bad_response":
      return error.status === 429 ? "That's a lot of changes in a short time. Wait a minute, then try again." : statusWords(error.status, "Something went wrong on our side. Please try again.");
    case "internal":
      return "Something went wrong on our side. Please try again.";
    case "forbidden":
      return own ?? "You don't have permission to do that.";
    case "rate_limited":
      return "That's a lot of changes in a short time. Wait a minute, then try again.";
    case "not_found":
      return own ?? "That isn't there any more. Refresh and try again.";
    case "invalid":
      return error.issues && error.issues.length > 0
        ? error.issues.map((issue) => issue.message).join(" ")
        : (own ?? "Some details weren't accepted. Check them and try again.");
    default:
      return own ?? "That didn't go through. Please try again.";
  }
}

/** Issues keyed by the full path ("presets.0.label") and by the first string segment ("allowedOrigins"). */
export function issuesByField(error: ClientError | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error?.issues ?? []) {
    const key = issue.path.map(String).join(".");
    const top = issue.path.find((part) => typeof part === "string");
    if (key && !out[key]) out[key] = issue.message;
    if (typeof top === "string" && !out[top]) out[top] = issue.message;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Time zones and currencies by the names owners use
// ---------------------------------------------------------------------------

export interface ZoneChoice {
  zone: string;
  label: string;
}

/** The US zones first, by name and a city. Copied from scheduling-widget's helpers; change both or neither. */
export const US_TIME_ZONES: readonly ZoneChoice[] = [
  { zone: "America/New_York", label: "Eastern Time (New York)" },
  { zone: "America/Chicago", label: "Central Time (Chicago)" },
  { zone: "America/Denver", label: "Mountain Time (Denver)" },
  { zone: "America/Phoenix", label: "Mountain Time, no daylight saving (Phoenix)" },
  { zone: "America/Los_Angeles", label: "Pacific Time (Los Angeles)" },
  { zone: "America/Anchorage", label: "Alaska Time (Anchorage)" },
  { zone: "Pacific/Honolulu", label: "Hawaii Time (Honolulu)" },
];

/** Every IANA zone the browser knows, for "Other…". */
export function allTimeZones(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (typeof supported === "function") return supported("timeZone");
  } catch {
    /* fall through */
  }
  return ["UTC", "Europe/London", "Europe/Paris", "Australia/Sydney", ...US_TIME_ZONES.map((z) => z.zone)];
}

export const COMMON_CURRENCIES: ReadonlyArray<{ code: string; label: string }> = [
  { code: "USD", label: "US dollar (USD)" },
  { code: "CAD", label: "Canadian dollar (CAD)" },
  { code: "AUD", label: "Australian dollar (AUD)" },
  { code: "NZD", label: "New Zealand dollar (NZD)" },
  { code: "GBP", label: "British pound (GBP)" },
  { code: "EUR", label: "Euro (EUR)" },
];

// ---------------------------------------------------------------------------
// The four ways a product is measured
// ---------------------------------------------------------------------------

/**
 * The recipes as the price book names them, with each one's default settings
 * and what a supply can be counted "per".
 *
 * CONTRACT: the admin wire has no route that lists recipes; each product
 * carries only its OWN `recipeInfo`. The recipe picker needs all four (and
 * their defaults, to fill the settings when the owner switches), so they are
 * written out here from contract 3.2–3.7. Wherever the server's `recipeInfo`
 * is at hand (the product's saved recipe) it wins. These are words and
 * settings an owner edits, not numbers the widget works out: every quantity
 * and price is still the server's (`preview`).
 */
export interface RecipeCatalogEntry extends RecipeInfo {
  defaults: RecipeConfig;
}

export const RAMP_DEFAULTS: RampRecipeConfig = {
  stepsLabel: "How many steps go up to the door?",
  stepsHelp: "Count every step up, including the last one onto the porch or landing: 2 steps and the porch is 3.",
  stepHeightLabel: "Height of one step (optional)",
  stepHeightHelp: "Measure from the top of one step to the top of the next.",
  allowTotalRise: true,
  totalRiseLabel: "Or the total height, ground to door threshold (optional)",
  totalRiseHelp: "If you measured the whole height instead, enter it here.",
  // The same defaults as the server (recipes.ts): the typical step is the
  // middle of the band, so an unmeasured job is never priced at its cheapest end.
  stepHeightIn: { typical: 7.5, low: 7, high: 8 },
  usePhotoStepHeight: true,
  slopeRatio: 12,
  roundUpToFt: 1,
  landingEveryRiseIn: 30,
  maxSteps: 20,
  photoSubject: "the steps up to the door",
  photoTip: "Stand to the side so every step shows.",
  resultNoun: { one: "ramp", many: "ramps" },
};

export const AREA_DEFAULTS: AreaRecipeConfig = {
  unit: "ft",
  widthLabel: "Width",
  lengthLabel: "Length",
  help: null,
  presets: [],
  maxWidth: 1000,
  maxLength: 1000,
  resultNoun: { one: "area", many: "areas" },
};

export const LINEAR_DEFAULTS: LinearRecipeConfig = {
  unit: "ft",
  lengthLabel: "Length",
  help: null,
  maxLength: 5000,
  resultNoun: { one: "run", many: "runs" },
};

export const COUNT_DEFAULTS: CountRecipeConfig = {
  countLabel: "How many?",
  help: null,
  noun: { one: "item", many: "items" },
  maxCount: 50,
  photoSubject: null,
  photoTip: null,
};

const ITEM = { key: "item", label: "per item" };
const JOB = { key: "job", label: "once per job" };

export const RECIPE_CATALOG: Readonly<Record<RecipeKey, RecipeCatalogEntry>> = {
  ramp_over_steps: {
    key: "ramp_over_steps",
    label: "Steps up to a door (ramp)",
    description: "Customers count the steps up to their door. We work out the rise and the feet of ramp from your step height and slope.",
    primaryKey: "rampFt",
    bases: [{ key: "rampFt", label: "per ft of ramp" }, { key: "landings", label: "per resting landing" }, ITEM, JOB],
    photoReading: true,
    defaults: RAMP_DEFAULTS,
  },
  area: {
    key: "area",
    label: "Width × length",
    description: "Customers give a width and a length, or pick a common size. Priced by the square foot and the edge.",
    primaryKey: "sqFt",
    bases: [{ key: "sqFt", label: "per sq ft" }, { key: "perimeterFt", label: "per ft of edge" }, ITEM, JOB],
    photoReading: false,
    defaults: AREA_DEFAULTS,
  },
  linear: {
    key: "linear",
    label: "A length",
    description: "Customers give one length they can measure with a tape.",
    primaryKey: "linearFt",
    bases: [{ key: "linearFt", label: "per ft" }, ITEM, JOB],
    photoReading: false,
    defaults: LINEAR_DEFAULTS,
  },
  count: {
    key: "count",
    label: "A count",
    description: "Customers say how many. Per-item costs scale with the count; per-job costs come once.",
    primaryKey: "item",
    bases: [ITEM, JOB],
    photoReading: false,
    defaults: COUNT_DEFAULTS,
  },
};

/** The recipe's info: the server's when it is the product's saved recipe, else the catalog's. Bases de-duplicated. */
export function recipeInfoFor(recipe: RecipeKey, saved?: RecipeInfo | null): RecipeInfo {
  const base = saved && saved.key === recipe && saved.label ? saved : RECIPE_CATALOG[recipe];
  const seen = new Set<string>();
  const bases = (base.bases.length > 0 ? base.bases : RECIPE_CATALOG[recipe].bases).filter((b) => (seen.has(b.key) ? false : (seen.add(b.key), true)));
  return { key: recipe, label: base.label, description: base.description, primaryKey: base.primaryKey || RECIPE_CATALOG[recipe].primaryKey, bases, photoReading: base.photoReading };
}

/** A stored config laid over the recipe's defaults (missing keys → defaults), the way the server resolves it. */
export function configFor(recipe: RecipeKey, stored: unknown): RecipeConfig {
  const defaults = RECIPE_CATALOG[recipe].defaults as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...defaults };
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      if (key in defaults && value !== undefined) out[key] = value;
    }
  }
  return out as unknown as RecipeConfig;
}

/** "Hours per ft of ramp" from a base's label ("per ft of ramp"). */
export function perPrimaryLabel(info: RecipeInfo): string {
  const base = info.bases.find((b) => b.key === info.primaryKey);
  return base ? base.label.replace(/^per\s+/i, "") : "unit";
}
