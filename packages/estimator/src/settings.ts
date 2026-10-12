import { eq } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_TAX_RATE_BP } from "./pricing.js";
import { estimatorSettings } from "./schema.js";
import { CONTROL_CHARS } from "./text.js";
import type { EstimatorDb, SettingsRow } from "./types.js";
import type { EstimatorSettingsWire } from "./wire.js";

/**
 * A business's estimator settings: one `estimator_settings` row per tenant
 * (0.3; ES-01, ES-20).
 *
 * 0.2 took the tax rate from the host's code and had nowhere to keep the
 * business's name, its contact details, who hears about a new lead, how long a
 * quote is good for, or how much photo reading may cost. A business owner
 * decides these, so they live in the database and the settings screen edits
 * them. A tenant that never saved settings reads the defaults below — 0.2's
 * behaviour (8.25% tax) — and the admin keeps asking until they are saved.
 */

export interface EstimatorSettingsValues {
  businessName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  /** Up to 5 addresses for new-lead and quote-answer notices. */
  leadNotifyEmails: string[];
  /** ISO 4217. Display only. */
  currency: string;
  /** A BCP 47 tag for number formatting. */
  locale: string;
  /** IANA zone: the dates on quotes and in emails. */
  timeZone: string;
  taxRateBp: number;
  quoteValidDays: number;
  /** 0 = no follow-up. */
  followUpDays: number;
  quoteFooter: string | null;
  defaultLaborRateCents: number;
  contingencyBp: number;
  instantEstimatesEnabled: boolean;
  photosEnabled: boolean;
  aiDailyBudgetCents: number;
  aiPerRequesterDaily: number;
  brandColor: string | null;
}

export interface EstimatorSettings extends EstimatorSettingsValues {
  tenantId: string;
  /** The owner has saved settings (`saved_at` is set) — not merely "a row exists". */
  saved: boolean;
  sampleLoadedAt: Date | null;
  updatedAt: Date | null;
}

export const DEFAULT_ESTIMATOR_SETTINGS: Readonly<EstimatorSettingsValues> = Object.freeze({
  businessName: "",
  contactEmail: null,
  contactPhone: null,
  leadNotifyEmails: [],
  currency: "USD",
  locale: "en-US",
  timeZone: "UTC",
  taxRateBp: DEFAULT_TAX_RATE_BP,
  quoteValidDays: 30,
  followUpDays: 3,
  quoteFooter: null,
  defaultLaborRateCents: 0,
  contingencyBp: 0,
  instantEstimatesEnabled: true,
  photosEnabled: true,
  aiDailyBudgetCents: 100,
  aiPerRequesterDaily: 5,
  brandColor: null,
}) as EstimatorSettingsValues;

const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+\-/]*$/;

/** Is this an IANA zone the runtime knows? */
export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.length === 0 || zone.length > 64 || !ZONE_NAME.test(zone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A BCP 47 tag `Intl.NumberFormat` accepts. */
export function isValidLocale(tag: unknown): tag is string {
  if (typeof tag !== "string" || tag.length === 0 || tag.length > 35) return false;
  try {
    new Intl.NumberFormat(tag);
    return Intl.NumberFormat.supportedLocalesOf([tag]).length > 0;
  } catch {
    return false;
  }
}

/** Three capitals that `Intl` can format as a currency. */
export function isValidCurrency(code: unknown): code is string {
  if (typeof code !== "string" || !/^[A-Z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat("en-US", { style: "currency", currency: code });
    return true;
  } catch {
    return false;
  }
}

/** A blank text field from a form means "none". */
const blankToNull = (value: unknown): unknown => (typeof value === "string" && value.trim() === "" ? null : value);
const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep it to ${max} characters.`)
    .refine((value) => !CONTROL_CHARS.test(value), "Keep this on one line.");
const email = z.string().trim().email("Enter an email address.").max(320, "Enter an email address.");

/**
 * A partial settings edit. Every field is optional and a patch changes only
 * the keys it names; unknown keys are dropped. Each refusal is a ZodError
 * issue with the field's path, so a settings screen can put the message
 * beside the field.
 */
export const updateEstimatorSettingsSchema = z
  .object({
    businessName: oneLine(120),
    contactEmail: z.preprocess(blankToNull, email.nullable()),
    contactPhone: z.preprocess(blankToNull, oneLine(40).nullable()),
    leadNotifyEmails: z.array(email).max(5, "Up to 5 addresses."),
    currency: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .refine(isValidCurrency, "Use a three-letter currency code, like USD."),
    locale: z.string().trim().refine(isValidLocale, "Use a language tag, like en-US."),
    timeZone: z.string().trim().refine(isValidTimeZone, "Pick a time zone from the list."),
    taxRateBp: z
      .number()
      .int("Enter a rate from 0% to 30%.")
      .min(0, "Enter a rate from 0% to 30%.")
      .max(3000, "Enter a rate from 0% to 30%."),
    quoteValidDays: z.number().int().min(1, "Use 1 to 365 days.").max(365, "Use 1 to 365 days."),
    followUpDays: z.number().int().min(0, "Use 0 to 60 days (0 = no follow-up).").max(60, "Use 0 to 60 days (0 = no follow-up)."),
    quoteFooter: z.preprocess(blankToNull, z.string().trim().max(2000, "Keep it to 2000 characters.").nullable()),
    defaultLaborRateCents: z.number().int().min(0).max(1_000_000, "Use a rate up to $10,000 an hour."),
    contingencyBp: z.number().int().min(0, "Use 0% to 50%.").max(5000, "Use 0% to 50%."),
    instantEstimatesEnabled: z.boolean(),
    photosEnabled: z.boolean(),
    aiDailyBudgetCents: z.number().int().min(0).max(100_000, "Use up to $1,000 a day."),
    aiPerRequesterDaily: z.number().int().min(0).max(100, "Use 0 to 100."),
    brandColor: z.preprocess(
      blankToNull,
      z
        .string()
        .trim()
        .regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #0d6b64.")
        .transform((value) => value.toLowerCase())
        .nullable(),
    ),
  })
  .partial();
export type UpdateEstimatorSettingsInput = z.input<typeof updateEstimatorSettingsSchema>;

/** A stored row → settings. Defensive about hand-written rows: an unknown zone reads UTC, and so on. */
function fromRow(row: SettingsRow): EstimatorSettings {
  return {
    tenantId: row.tenantId,
    businessName: row.businessName,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    leadNotifyEmails: Array.isArray(row.leadNotifyEmails)
      ? row.leadNotifyEmails.filter((value): value is string => typeof value === "string")
      : [],
    currency: isValidCurrency(row.currency) ? row.currency : "USD",
    locale: isValidLocale(row.locale) ? row.locale : "en-US",
    timeZone: isValidTimeZone(row.timeZone) ? row.timeZone : "UTC",
    taxRateBp: row.taxRateBp,
    quoteValidDays: row.quoteValidDays,
    followUpDays: row.followUpDays,
    quoteFooter: row.quoteFooter,
    defaultLaborRateCents: row.defaultLaborRateCents,
    contingencyBp: row.contingencyBp,
    instantEstimatesEnabled: row.instantEstimatesEnabled,
    photosEnabled: row.photosEnabled,
    aiDailyBudgetCents: row.aiDailyBudgetCents,
    aiPerRequesterDaily: row.aiPerRequesterDaily,
    brandColor: row.brandColor,
    saved: row.savedAt !== null && row.savedAt !== undefined,
    sampleLoadedAt: row.sampleLoadedAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

export function defaultEstimatorSettings(tenantId: string): EstimatorSettings {
  return {
    ...DEFAULT_ESTIMATOR_SETTINGS,
    leadNotifyEmails: [],
    tenantId,
    saved: false,
    sampleLoadedAt: null,
    updatedAt: null,
  };
}

/** This tenant's settings, or the defaults (`saved: false`) when it never saved any. Never writes. */
export async function getEstimatorSettings(db: EstimatorDb, tenantId: string): Promise<EstimatorSettings> {
  const [row] = (await db
    .select()
    .from(estimatorSettings)
    .where(eq(estimatorSettings.tenantId, tenantId))
    .limit(1)) as SettingsRow[];
  return row ? fromRow(row) : defaultEstimatorSettings(tenantId);
}

/**
 * Upsert this tenant's settings; a patch changes only the keys it names, and
 * every save stamps `saved_at` — so the admin stops asking for the business's
 * details only once an owner has actually saved them.
 */
export async function updateEstimatorSettings(
  db: EstimatorDb,
  tenantId: string,
  patch: UpdateEstimatorSettingsInput,
  options: { now?: Date } = {},
): Promise<EstimatorSettings> {
  const parsed = updateEstimatorSettingsSchema.parse(patch);
  const now = options.now ?? new Date();
  const values = { ...parsed } as Partial<EstimatorSettingsValues>;
  const [row] = (await db
    .insert(estimatorSettings)
    .values({ tenantId, ...values, savedAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: estimatorSettings.tenantId, set: { ...values, savedAt: now, updatedAt: now } })
    .returning()) as SettingsRow[];
  return fromRow(row as SettingsRow);
}

/**
 * Has the owner set the business up enough for a CUSTOMER to hear from it:
 * settings saved, and a business name to sign with (review EST-R02).
 *
 * WHY THIS GATES THE PUBLIC SIDE. Until then every customer-facing word would
 * come from defaults: an estimate email "from " nobody, a price "plus 8.25%
 * sales tax" at a rate the owner never chose. The estimate page, the embed
 * and the photo reading stay closed ("not available right now") and a quote
 * can't be sent (`settings_incomplete`) until the owner saves the business's
 * name in Settings — whose first-run form asks for the tax rate and the
 * default labor rate in the same save.
 */
export function estimatorReady(settings: Pick<EstimatorSettings, "saved" | "businessName">): boolean {
  return settings.saved && settings.businessName.trim() !== "";
}

/** The public estimator answers customers: switched on, and the business set up (`estimatorReady`). */
export function publicEstimatesOpen(settings: Pick<EstimatorSettings, "saved" | "businessName" | "instantEstimatesEnabled">): boolean {
  return settings.instantEstimatesEnabled && estimatorReady(settings);
}

/** The refusal a quote send gets before the business is set up. */
export const SETTINGS_INCOMPLETE_MESSAGE = "Add your business name and tax rate in Settings first.";

/**
 * Settings → the wire (`EstimatorSettingsWire`). Without `includeCosts` (the
 * caller lacks `estimator.costs.view`) the default labor rate is null: it is
 * what an hour of the business's work costs (review ADV-3).
 */
export function toSettingsWire(settings: EstimatorSettings, options: { includeCosts?: boolean } = {}): EstimatorSettingsWire {
  return {
    businessName: settings.businessName,
    contactEmail: settings.contactEmail,
    contactPhone: settings.contactPhone,
    leadNotifyEmails: [...settings.leadNotifyEmails],
    currency: settings.currency,
    locale: settings.locale,
    timeZone: settings.timeZone,
    taxRateBp: settings.taxRateBp,
    quoteValidDays: settings.quoteValidDays,
    followUpDays: settings.followUpDays,
    quoteFooter: settings.quoteFooter,
    defaultLaborRateCents: options.includeCosts === false ? null : settings.defaultLaborRateCents,
    contingencyBp: settings.contingencyBp,
    instantEstimatesEnabled: settings.instantEstimatesEnabled,
    photosEnabled: settings.photosEnabled,
    aiDailyBudgetCents: settings.aiDailyBudgetCents,
    aiPerRequesterDaily: settings.aiPerRequesterDaily,
    brandColor: settings.brandColor,
    sampleLoadedAt: settings.sampleLoadedAt ? settings.sampleLoadedAt.toISOString() : null,
    saved: settings.saved,
    updatedAt: settings.updatedAt ? settings.updatedAt.toISOString() : null,
  };
}

/**
 * The tax rate a public estimate is saved at: saved settings win; until they
 * are saved, the handler's deprecated `taxRateBp` option; then
 * `DEFAULT_TAX_RATE_BP`. (A staff estimate takes its own `taxRateBp`, else the
 * same chain.)
 */
export function effectiveTaxRateBp(settings: EstimatorSettings, legacy?: number | null): number {
  if (settings.saved) return settings.taxRateBp;
  if (typeof legacy === "number" && Number.isInteger(legacy) && legacy >= 0 && legacy <= 10_000) return legacy;
  return settings.taxRateBp;
}

/** Money as the business writes it ("$6,443.96"), in its currency and locale. */
export function formatMoney(cents: number, settings: Pick<EstimatorSettingsValues, "currency" | "locale">, wholeUnits = false): string {
  const options: Intl.NumberFormatOptions = { style: "currency", currency: settings.currency };
  if (wholeUnits) {
    options.minimumFractionDigits = 0;
    options.maximumFractionDigits = 0;
  }
  try {
    return new Intl.NumberFormat(settings.locale, options).format(wholeUnits ? Math.round(cents / 100) : cents / 100);
  } catch {
    return new Intl.NumberFormat("en-US", { ...options, currency: "USD" }).format(wholeUnits ? Math.round(cents / 100) : cents / 100);
  }
}
