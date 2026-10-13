import { z } from "zod";

/**
 * The per-company settings registry (decision D13, contract 5.3).
 *
 * WHY A REGISTRY. Every feature package needs a few company-level answers —
 * scheduling needs the company's time zone, the estimator its business name
 * and contact line, comms the reply-to address. Without one place to keep
 * them, each package grows its own settings table and the owner fills in the
 * same time zone four times. Instead a package contributes a FRAGMENT (a zod
 * schema plus plain-words field specs); the project composes the fragments
 * once, like the permission catalog; `<CompanySettings>` draws every section
 * from the field specs with no per-package UI; and server code reads typed
 * values back (`readSettings`).
 *
 * STORAGE. `tenants.settings` jsonb, one key per fragment. Name and web
 * address are real columns; logo and colour live in `tenants.branding`; the
 * setup checklist's state in `tenants.setup_state`. So the registry owns
 * `settings` completely and nothing else writes there.
 *
 * ONE BAD SAVE CAN'T TAKE THE PAGE DOWN. Stored values are parsed field by
 * field; a field that no longer parses (a schema tightened since it was
 * saved, a hand-edited row) falls back to that field's default and is
 * REPORTED, never thrown.
 */

export type SettingsFieldKind = "text" | "textarea" | "email" | "tel" | "url" | "timezone" | "select" | "toggle" | "number";

export interface SettingsField {
  /** Key inside the fragment's object (flat: no dots). */
  readonly key: string;
  /** Plain words: "Email customers can reach you at". */
  readonly label: string;
  readonly help?: string;
  readonly kind: SettingsFieldKind;
  /** For `select`. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly placeholder?: string;
  /** e.g. "email", "tel", "address-line1". */
  readonly autoComplete?: string;
  /** Default "full". Two "half" fields pair on one row on a wide screen. */
  readonly width?: "full" | "half";
  /** UI hint only; the schema decides. */
  readonly required?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export interface TenantSettingsFragment<
  K extends string = string,
  S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
> {
  /** /^[a-z][a-z0-9-]{1,31}$/ and not starting with "__". The jsonb key under tenants.settings. */
  readonly key: K;
  /** The section heading: "Business details". */
  readonly label: string;
  readonly description?: string;
  /** Every field must have a default, so `schema.parse({})` yields the defaults. */
  readonly schema: S;
  /** Every field.key must exist in schema.shape (checked at definition). */
  readonly fields: readonly SettingsField[];
  /** Default "tenant.view". */
  readonly viewPermission?: string;
  /** Default "tenant.edit". */
  readonly editPermission?: string;
  /** Default 100; ascending. */
  readonly order?: number;
}

export class DuplicateSettingsFragmentError extends Error {
  readonly name = "DuplicateSettingsFragmentError";
}

export class InvalidSettingsFragmentError extends Error {
  readonly name = "InvalidSettingsFragmentError";
}

const FRAGMENT_KEY = /^[a-z][a-z0-9-]{1,31}$/;
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Declare one fragment. Throws `InvalidSettingsFragmentError` at definition
 * (i.e. at boot, in front of the developer) for a bad key, a field not in the
 * schema, or a schema whose `parse({})` fails — a fragment without defaults
 * would make every company that never saved it unreadable.
 */
export function defineSettingsFragment<const K extends string, S extends z.ZodObject<z.ZodRawShape>>(
  fragment: TenantSettingsFragment<K, S>,
): TenantSettingsFragment<K, S> {
  if (!FRAGMENT_KEY.test(fragment.key) || fragment.key.startsWith("__")) {
    throw new InvalidSettingsFragmentError(
      `Settings fragment key "${fragment.key}" must be 2-32 characters of lowercase letters, digits and dashes, ` +
        `starting with a letter. It is the key under tenants.settings, so it is permanent.`,
    );
  }
  const shape = fragment.schema.shape as Record<string, unknown>;
  const seen = new Set<string>();
  for (const field of fragment.fields) {
    if (!FIELD_KEY.test(field.key)) {
      throw new InvalidSettingsFragmentError(`Field "${field.key}" in settings fragment "${fragment.key}" must be a flat key (letters, digits, underscores).`);
    }
    if (seen.has(field.key)) {
      throw new InvalidSettingsFragmentError(`Field "${field.key}" is listed twice in settings fragment "${fragment.key}".`);
    }
    seen.add(field.key);
    if (!Object.prototype.hasOwnProperty.call(shape, field.key)) {
      throw new InvalidSettingsFragmentError(
        `Field "${field.key}" in settings fragment "${fragment.key}" is not in its schema, so nothing would ever be saved for it.`,
      );
    }
    if (field.kind === "select" && (!field.options || field.options.length === 0)) {
      throw new InvalidSettingsFragmentError(`Select field "${field.key}" in settings fragment "${fragment.key}" has no options.`);
    }
  }
  const defaults = fragment.schema.safeParse({});
  if (!defaults.success) {
    throw new InvalidSettingsFragmentError(
      `Settings fragment "${fragment.key}" has a field with no default (schema.parse({}) fails). Give every field a .default(), ` +
        `so a company that never saved this section still reads.`,
    );
  }
  return fragment;
}

export type SettingsValues<F extends readonly TenantSettingsFragment[]> = {
  readonly [P in F[number] as P["key"]]: z.output<P["schema"]>;
};

export interface SettingsParseProblem {
  readonly fragment: string;
  readonly message: string;
}

export interface TenantSettingsRegistry<F extends readonly TenantSettingsFragment[] = readonly TenantSettingsFragment[]> {
  /** Sorted by order, then key. */
  readonly fragments: F;
  get(key: string): TenantSettingsFragment | undefined;
  defaults(): SettingsValues<F>;
  /** Parse one stored settings blob: per fragment, field by field; a field that fails falls back to its default and is reported. */
  parse(stored: unknown): { readonly values: SettingsValues<F>; readonly problems: readonly SettingsParseProblem[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One fragment's stored value → its typed value, salvaging every field that still parses. */
export function parseFragment(
  fragment: TenantSettingsFragment,
  stored: unknown,
): { readonly value: Record<string, unknown>; readonly problem: string | null } {
  const input = isRecord(stored) ? stored : {};
  const whole = fragment.schema.safeParse(input);
  if (whole.success) return { value: whole.data as Record<string, unknown>, problem: null };

  // Field by field: keep what parses, default what doesn't, name what didn't.
  const shape = fragment.schema.shape as Record<string, z.ZodTypeAny>;
  const value: Record<string, unknown> = {};
  const bad: string[] = [];
  for (const [key, schema] of Object.entries(shape)) {
    const one = schema.safeParse(input[key]);
    if (one.success) {
      value[key] = one.data;
    } else {
      bad.push(key);
      const fallback = schema.safeParse(undefined);
      value[key] = fallback.success ? fallback.data : null;
    }
  }
  return {
    value,
    problem: `Stored settings for "${fragment.key}" had values that no longer fit (${bad.join(", ") || "the section"}); their defaults were used.`,
  };
}

/** Compose the project's fragments. Throws `DuplicateSettingsFragmentError` on a repeated key. */
export function defineTenantSettings<const F extends readonly TenantSettingsFragment[]>(fragments: F): TenantSettingsRegistry<F> {
  const seen = new Set<string>();
  for (const fragment of fragments) {
    if (seen.has(fragment.key)) {
      throw new DuplicateSettingsFragmentError(
        `Two settings fragments use the key "${fragment.key}", so one would silently overwrite the other's saved values. Rename one.`,
      );
    }
    seen.add(fragment.key);
  }
  const sorted = [...fragments].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.key.localeCompare(b.key)) as unknown as F;

  return {
    fragments: sorted,
    get: (key) => fragments.find((f) => f.key === key),
    defaults() {
      const out: Record<string, unknown> = {};
      for (const f of fragments) out[f.key] = f.schema.parse({});
      return out as SettingsValues<F>;
    },
    parse(stored) {
      const blob = isRecord(stored) ? stored : {};
      const values: Record<string, unknown> = {};
      const problems: SettingsParseProblem[] = [];
      for (const f of fragments) {
        const { value, problem } = parseFragment(f, blob[f.key]);
        values[f.key] = value;
        if (problem) problems.push({ fragment: f.key, message: problem });
      }
      return { values: values as SettingsValues<F>, problems };
    },
  };
}

/** Is this an IANA time zone this runtime knows ("America/Denver")? */
export function isTimeZone(value: string): boolean {
  if (typeof value !== "string" || value.trim() === "" || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const emptyToNull = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? null : value;

function optionalText(max: number) {
  return z
    .preprocess(emptyToNull, z.string().trim().max(max, `Keep it to ${max} characters or fewer.`).nullable())
    .default(null);
}

/**
 * The company fragment tenancy ships (key `company`, "Business details").
 * The service refuses to start without it: the checklist and the operator
 * detail read its time zone and contact fields, and Tenancy 2's packages
 * read `settings.company.timeZone` as their default zone.
 */
export const companySettings = defineSettingsFragment({
  key: "company",
  label: "Business details",
  description: "How customers reach you, and the time zone your dates and times use.",
  order: 10,
  schema: z.object({
    timeZone: z
      .preprocess(emptyToNull, z.string().refine(isTimeZone, "Choose a time zone from the list.").nullable())
      .default(null),
    contactEmail: z
      .preprocess(
        emptyToNull,
        z
          .string()
          .trim()
          .toLowerCase()
          .max(254, "Keep it to 254 characters or fewer.")
          .email("Enter an email address, like you@example.com.")
          .nullable(),
      )
      .default(null),
    contactPhone: optionalText(40),
    addressLine1: optionalText(120),
    addressLine2: optionalText(120),
    city: optionalText(80),
    region: optionalText(80),
    postalCode: optionalText(20),
    country: optionalText(80),
  }),
  fields: [
    { key: "timeZone", kind: "timezone", label: "Time zone", help: "Dates and times your customers see use this." },
    { key: "contactEmail", kind: "email", label: "Email customers can reach you at", autoComplete: "email" },
    { key: "contactPhone", kind: "tel", label: "Phone customers can call", autoComplete: "tel" },
    { key: "addressLine1", kind: "text", label: "Street address", autoComplete: "address-line1" },
    { key: "addressLine2", kind: "text", label: "Apartment, suite, unit (optional)", autoComplete: "address-line2" },
    { key: "city", kind: "text", label: "City", width: "half", autoComplete: "address-level2" },
    { key: "region", kind: "text", label: "State", width: "half", autoComplete: "address-level1" },
    { key: "postalCode", kind: "text", label: "ZIP code", width: "half", autoComplete: "postal-code" },
    { key: "country", kind: "text", label: "Country", width: "half", autoComplete: "country-name" },
  ],
});
