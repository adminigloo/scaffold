import { getEstimatorSettings, isValidTimeZone, type EstimatorSettings } from "./settings.js";
import type { EstimatorDb } from "./types.js";

/**
 * Tenancy 2a: the estimator inside a company. The estimator never imports
 * tenancy (D4): it declares, in its own types, the few seams a host fills in
 * — the company's basics (`company`), whether its public side is open
 * (`admit`), a per-company ceiling on photo-reading spend, async links and a
 * per-company office inbox. A host passing none of them gets 0.3's behaviour.
 */

/** The business as its customers know it, from the host's company profile (3.2). */
export interface EstimatorCompany {
  readonly name: string;
  /** IANA. null: not set yet (the estimator keeps its own). */
  readonly timeZone: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly logoUrl: string | null;
  /** "#rrggbb", or null. */
  readonly brandColor: string | null;
}

/** Is this business taking requests from the public right now? (3.3) */
export type EstimatorAdmission = { readonly open: true } | { readonly open: false; readonly message: string };

export interface ResolveEstimatorSettingsOptions {
  readonly company?: (tenantId: string) => EstimatorCompany | null | Promise<EstimatorCompany | null>;
  /**
   * The most a day of photo reading may cost per business on this site, in
   * cents (D14). The effective budget is `min(the business's setting, this)`.
   */
  readonly aiBudgetCeilingCents?: number;
  /** Told when the company seam throws; that read then uses the stored settings. */
  readonly onError?: (error: unknown) => void;
}

/** A ceiling is a whole number of cents, 0 or more; anything else is no ceiling. */
export function validCeiling(value: number | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * The settings a request runs on, with the company's basics (Tenancy 2a, D5)
 * and the site's ceiling on photo-reading spend (D14). Never writes: the
 * estimator stores no instant computed from the zone, so a new zone is simply
 * overlaid (dates on quotes and in emails are DISPLAYED in it).
 *
 * - With a company: the name, contact email and phone, brand colour and logo
 *   are the company's; the zone is the company's when set, else the stored
 *   one; `managedByCompany: true`. A seam that throws is reported and that
 *   read uses the stored settings.
 * - With a ceiling: `aiDailyBudgetCents = min(stored, ceiling)` and
 *   `aiBudgetCeilingCents = ceiling`. Every company's photo reading spends
 *   the PLATFORM's AI key: without this an owner could raise their own daily
 *   budget to $1,000 on the platform's bill. Because the ceilinged settings
 *   are what `runPhotoTakeoff` checks, the ceiling holds where the money is
 *   spent.
 *
 * `estimatorReady` is unchanged (`saved && businessName`). With a company the
 * name is always there, so readiness means "the owner saved estimate settings
 * once" (the tax rate and quote rules).
 */
export async function resolveEstimatorSettings(
  db: EstimatorDb,
  tenantId: string,
  options: ResolveEstimatorSettingsOptions = {},
): Promise<EstimatorSettings> {
  let settings = await getEstimatorSettings(db, tenantId);
  const ceiling = validCeiling(options.aiBudgetCeilingCents);
  if (ceiling !== null) {
    settings = { ...settings, aiDailyBudgetCents: Math.min(settings.aiDailyBudgetCents, ceiling), aiBudgetCeilingCents: ceiling };
  }
  if (!options.company) return settings;
  let company: EstimatorCompany | null;
  try {
    company = await options.company(tenantId);
  } catch (error) {
    try {
      options.onError?.(error);
    } catch {
      /* a broken reporter must not break the read */
    }
    return settings;
  }
  if (!company) return settings;
  return {
    ...settings,
    businessName: company.name,
    contactEmail: company.contactEmail,
    contactPhone: company.contactPhone,
    brandColor: company.brandColor,
    logoUrl: company.logoUrl,
    timeZone: typeof company.timeZone === "string" && isValidTimeZone(company.timeZone) ? company.timeZone : settings.timeZone,
    managedByCompany: true,
  };
}

/** The business fields a company owns (D6): a save in a managed tenant drops them. */
export const COMPANY_OWNED_ESTIMATOR_SETTINGS = ["businessName", "contactEmail", "contactPhone", "timeZone", "brandColor"] as const;
