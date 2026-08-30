import { z } from "zod";
import type { GrantKind, ProductKind, ProductStatus, VariantInterval } from "./schema.js";

/**
 * Everything that can be wrong with a product, as a list. No database, no
 * network.
 *
 * `import type` from ./schema.js and nothing else: under
 * `verbatimModuleSyntax` a type-only import is erased outright, so this module
 * — and therefore the package barrel — never pulls drizzle-orm/pg-core into a
 * client bundle. The same one-way rule commerce follows in ./orders.ts.
 *
 * RETURNS PROBLEMS, NEVER THROWS. A builder UI has to show every issue at once.
 * Throwing on the first means the admin fixes the slug, saves, is told about
 * the missing interval, fixes that, saves, is told about the second default
 * variant — and the fifth round trip is where the product gets abandoned
 * half-configured. It is the same reason commerce's `validateCart` returns a
 * list.
 */

export type ProblemCode =
  | "active-product-needs-variant"
  | "multiple-default-variants"
  | "subscription-variant-missing-interval"
  | "one-time-variant-has-interval"
  | "mixed-currency"
  | "currency-invalid"
  | "negative-price"
  | "negative-inventory"
  | "inventory-not-integer"
  | "slug-invalid"
  | "slug-reserved"
  | "grant-config-invalid"
  | "grant-unknown-variant";

export interface Problem {
  readonly code: ProblemCode;
  /** Written for the admin editing the product, not for a log line. */
  readonly message: string;
  /**
   * Where the problem is, as a path into the input:
   * `product.slug`, `variants`, `variants[1].interval`, `grants[0].config`.
   *
   * A string rather than an array because it is going straight into a form
   * library's `setError`, and every one of them takes this notation.
   */
  readonly path: string;
}

/** The product fields any rule here reads. */
export interface ProductDraft {
  readonly slug: string;
  readonly kind: ProductKind;
  readonly status: ProductStatus;
  readonly name?: string;
}

/**
 * A variant as the form holds it: `id` is absent until it is saved, which is
 * why nothing here may key on it.
 */
export interface VariantDraft {
  readonly id?: string;
  readonly sku?: string | null;
  readonly name?: string;
  readonly priceMinor: bigint;
  readonly currency: string;
  readonly interval?: VariantInterval | null;
  readonly isDefault?: boolean;
  readonly inventory?: number | null;
}

export interface GrantDraft {
  readonly variantId?: string;
  readonly kind: GrantKind;
  readonly config?: unknown;
}

export interface ValidateProductInput {
  readonly product: ProductDraft;
  readonly variants: readonly VariantDraft[];
  readonly grants?: readonly GrantDraft[];
}

/**
 * Per-kind shape for `product_grants.config`.
 *
 * The column is jsonb and open by design — a row written under last year's
 * shape must still load — so the shape is checked here, on the way in, where
 * the error can name the field. The one required field in the whole set is
 * `entitlement.feature`, and that is the point of doing this at all: an
 * entitlement grant with no feature name writes an entitlements row keyed on
 * `undefined`, which grants the customer nothing and looks like a successful
 * purchase from every angle except theirs.
 */
export const grantConfigSchemas = {
  ship: z.object({
    weightGrams: z.number().int().nonnegative().optional(),
    requiresAddress: z.boolean().optional(),
  }),
  license_key: z.object({
    seats: z.number().int().positive().optional(),
    keyFormat: z.string().min(1).optional(),
  }),
  entitlement: z.object({
    /** Matches `entitlements.feature` in @adminigloo/billing. */
    feature: z.string().min(1),
    /** NULL is unlimited, matching `entitlements.limit_value`. Not zero. */
    limit: z.number().int().nonnegative().nullable().optional(),
  }),
  none: z.object({}),
} as const satisfies Record<GrantKind, z.ZodType>;

/**
 * URL-safe slug: lowercase alphanumerics in hyphen-separated groups.
 *
 * No leading, trailing or doubled hyphen, because "deck--of-cards" and
 * "deck-of-cards" look identical in a sidebar and are two different rows in a
 * unique index. No uppercase, because a URL path is case-sensitive on most
 * origins and case-insensitive in most people's heads.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Long enough for a real product name, short enough to stay in a URL bar. */
const SLUG_MAX_LENGTH = 96;

/**
 * Slugs that would collide with a route rather than resolve to a product.
 *
 * A storefront routes `/products/[slug]`, and Next resolves the literal segment
 * `/products/new` — the admin's create page — before the dynamic one. A product
 * slugged "new" is then unreachable, which is confusing; worse, a product
 * slugged "checkout" or "cart" shadows a page the customer needs mid-purchase.
 * Rejecting them at save time costs one error message. Discovering them costs a
 * slug change on a URL that has already been printed.
 */
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "_next",
  "account",
  "admin",
  "api",
  "assets",
  "cart",
  "checkout",
  "create",
  "delete",
  "edit",
  "health",
  "login",
  "logout",
  "new",
  "product",
  "products",
  "search",
  "sign-in",
  "sign-up",
  "signin",
  "signup",
  "static",
  "webhooks",
]);

/**
 * Everything wrong with this product. Empty means it is safe to publish.
 *
 * The rules are deliberately independent of each other: a product can trip six
 * of them at once and gets six problems, because the admin wants the whole list
 * and not a chain of causes. The only place that ordering matters is inventory,
 * where a fractional value is reported once as fractional rather than twice.
 */
export function validateProduct(input: ValidateProductInput): readonly Problem[] {
  const problems: Problem[] = [];
  const { product, variants } = input;
  const grants = input.grants ?? [];

  // ---- slug -------------------------------------------------------------
  const slug = product.slug;
  if (!SLUG_PATTERN.test(slug) || slug.length > SLUG_MAX_LENGTH) {
    problems.push({
      code: "slug-invalid",
      message:
        `"${slug}" is not a usable URL slug. Use lowercase letters, numbers ` +
        `and single hyphens between them, up to ${SLUG_MAX_LENGTH} characters.`,
      path: "product.slug",
    });
  } else if (RESERVED_SLUGS.has(slug)) {
    // `else if`: a slug that is not URL-safe cannot also be a reserved word,
    // and two errors on one field is one error too many.
    problems.push({
      code: "slug-reserved",
      message:
        `"${slug}" is reserved by a storefront route, so a product using it ` +
        `would never be reachable. Pick another slug.`,
      path: "product.slug",
    });
  }

  // ---- an active product must be buyable ---------------------------------
  // Checked on `active` only. A draft with no variants yet is the normal state
  // of a product somebody is halfway through creating, and flagging it turns
  // the builder into a wall of red before the admin has typed anything.
  if (product.status === "active" && variants.length === 0) {
    problems.push({
      code: "active-product-needs-variant",
      message:
        "An active product needs at least one variant. Without one there is " +
        "no price, so the storefront can list it but nobody can buy it.",
      path: "variants",
    });
  }

  // ---- per-variant rules --------------------------------------------------
  const referenceCurrency = normaliseCurrency(variants[0]?.currency ?? "");
  let defaultsSeen = 0;

  for (const [index, variant] of variants.entries()) {
    const at = `variants[${index}]`;
    const label = variant.name ?? variant.sku ?? `variant ${index + 1}`;

    if (variant.isDefault === true) {
      defaultsSeen += 1;
      // Reported on every default AFTER the first, so the form highlights the
      // ones to switch off rather than the one that is probably correct.
      if (defaultsSeen > 1) {
        problems.push({
          code: "multiple-default-variants",
          message:
            `"${label}" is a second default variant. Exactly one variant may ` +
            `be the default, or none — with two, which one the product page ` +
            `preselects depends on the order the rows came back from the ` +
            `database, so the price shown changes between page loads.`,
          path: `${at}.isDefault`,
        });
      }
    }

    // ---- interval must agree with the product's kind ---------------------
    // The rule a CHECK constraint cannot express: `kind` is on `products` and
    // `interval` is on `product_variants`, and a check constraint may only read
    // columns of its own row.
    const interval = variant.interval ?? null;
    if (product.kind === "subscription" && interval === null) {
      problems.push({
        code: "subscription-variant-missing-interval",
        message:
          `"${label}" has no billing interval, but this is a subscription ` +
          `product. Stripe cannot create a recurring price without one, so ` +
          `checkout would fail at session creation.`,
        path: `${at}.interval`,
      });
    }
    if (product.kind === "one_time" && interval !== null) {
      problems.push({
        code: "one-time-variant-has-interval",
        message:
          `"${label}" bills every ${interval}, but this is a one-time ` +
          `product. A recurring price here charges the customer again next ` +
          `${interval} for something they bought once.`,
        path: `${at}.interval`,
      });
    }

    // ---- currency ---------------------------------------------------------
    const currency = normaliseCurrency(variant.currency);
    if (!/^[a-z]{3}$/.test(currency)) {
      // Not a listed rule, kept because `formatMinor` asks Intl for this
      // currency's minor-unit exponent and Intl throws RangeError on anything
      // that is not three letters. Caught here it is a form error; missed, it
      // is an uncaught exception on the product page.
      problems.push({
        code: "currency-invalid",
        message:
          `"${variant.currency}" is not a three-letter currency code, so no ` +
          `price for "${label}" can be formatted or sent to Stripe.`,
        path: `${at}.currency`,
      });
    } else if (currency !== referenceCurrency) {
      problems.push({
        code: "mixed-currency",
        message:
          `"${label}" is priced in ${currency.toUpperCase()} while the rest ` +
          `of this product is in ${referenceCurrency.toUpperCase()}. One ` +
          `product cannot span currencies: "from $12" has no meaning across ` +
          `two of them, and a switch between variants on a subscription ` +
          `prorates against an amount in the wrong unit.`,
        path: `${at}.currency`,
      });
    }

    // ---- price -------------------------------------------------------------
    // Zero is legal — a free tier and an included accessory are both real
    // variants. Negative is not: it is a discount smuggled in as a product, and
    // Stripe rejects a negative unit_amount outright.
    if (variant.priceMinor < 0n) {
      problems.push({
        code: "negative-price",
        message: `"${label}" has a negative price. Free is 0, not below it.`,
        path: `${at}.priceMinor`,
      });
    }

    // ---- inventory ----------------------------------------------------------
    // `undefined` and `null` both mean untracked and are skipped. Only a real
    // number is checked, which is the whole reason the column is nullable.
    const inventory = variant.inventory;
    if (inventory !== undefined && inventory !== null) {
      if (!Number.isInteger(inventory)) {
        problems.push({
          code: "inventory-not-integer",
          message:
            `"${label}" has a fractional stock count. The column is an ` +
            `integer, so Postgres rejects the write and the whole save fails ` +
            `with a driver error that names no field.`,
          path: `${at}.inventory`,
        });
      } else if (inventory < 0) {
        // `else if`: 1.5 is already reported as fractional.
        problems.push({
          code: "negative-inventory",
          message:
            `"${label}" has negative stock. Sold out is 0; below zero is an ` +
            `oversell that has already happened and needs a human, not a row.`,
          path: `${at}.inventory`,
        });
      }
    }
  }

  // ---- grants ---------------------------------------------------------------
  const variantIds = new Set(
    variants
      .map((variant) => variant.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );

  for (const [index, grant] of grants.entries()) {
    const at = `grants[${index}]`;

    // Only meaningful once at least one variant has been saved; in a create
    // form every variant is id-less and every grant is attached by position.
    if (
      grant.variantId !== undefined &&
      variantIds.size > 0 &&
      !variantIds.has(grant.variantId)
    ) {
      problems.push({
        code: "grant-unknown-variant",
        message:
          `This ${grant.kind} grant points at a variant that is not part of ` +
          `the product. Buying any variant here would grant nothing, and the ` +
          `purchase still succeeds — the customer is charged and receives ` +
          `nothing.`,
        path: `${at}.variantId`,
      });
      continue;
    }

    const schema = grantConfigSchemas[grant.kind];
    const parsed = schema.safeParse(grant.config ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue ? issue.path.map(String).join(".") : "";
      problems.push({
        code: "grant-config-invalid",
        message:
          `The ${grant.kind} grant is misconfigured` +
          (field ? ` (${field}): ` : ": ") +
          (issue?.message ?? "unknown problem") +
          ".",
        path: field ? `${at}.config.${field}` : `${at}.config`,
      });
    }
  }

  return problems;
}

/**
 * Whether this product may be published.
 *
 * A named function rather than `problems.length === 0` at each call site,
 * because the admin UI's enable/disable on the publish button and the server's
 * refusal to set `status = 'active'` have to be the same rule. Two copies of it
 * drift the moment someone decides one problem is "only a warning" — and the
 * first warning anybody adds is always the one that ships a broken price.
 *
 * There is no severity axis, deliberately. Every rule above describes something
 * that produces a wrong charge, an unreachable page, or a purchase that grants
 * nothing.
 */
export function canPublish(problems: readonly Problem[]): boolean {
  return problems.length === 0;
}

/** Stripe's spelling, and `product_variants.currency`'s: trimmed, lowercase. */
function normaliseCurrency(currency: string): string {
  return currency.trim().toLowerCase();
}
