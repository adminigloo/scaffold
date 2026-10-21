import type { GrantKind, ProductKind, VariantInterval } from "__SCOPE__/catalog";

/**
 * The variant row model, and the two functions that shape one.
 *
 * A PLAIN `.ts` MODULE rather than part of VariantEditor.tsx, for the reason
 * spelled out at the top of ./money.ts: tsconfig sets `jsx: "preserve"` because
 * Next compiles JSX itself, and esbuild refuses to transform a `.tsx` under
 * that setting. Anything a unit test needs to import therefore cannot live in a
 * component file, and `grantConfigFor` is the function that decides what goes
 * into `product_grants.config` — the jsonb column that answers "does this need
 * a postal address?" for the whole checkout. It was untestable purely because
 * of where it sat.
 */

/**
 * One editable variant, held entirely as strings.
 *
 * The number fields are strings because a half-typed "12." is a legitimate
 * intermediate state and coercing on every keystroke deletes the dot out from
 * under the cursor. The conversion happens once, on submit and for validation,
 * through `parseMoneyInput`.
 */
export interface VariantRow {
  /**
   * Stable React key, fixed for the lifetime of the row.
   *
   * The variant id for a row that arrived from the server, a local token for
   * one added here — and it does NOT become the id when the row is saved.
   * Changing a key remounts the inputs, which mid-save would take the caret out
   * from under whoever is still typing in the row below.
   */
  readonly key: string;
  /**
   * The database id, or NULL for a row that has never been written.
   *
   * WRITE IT BACK THE MOMENT THE SERVER RETURNS IT. Everything that asks
   * whether the form agrees with the database reads this field: the Publish
   * button, the "has not been written yet" line under it, the `· unsaved`
   * marker on the row header, and which rows the Stripe plan can compare
   * against. A save that stores the row and drops the returned id leaves all
   * four insisting the variant does not exist, with no way out but a page
   * reload and nothing on screen suggesting one.
   */
  readonly id: string | null;
  readonly name: string;
  readonly sku: string;
  readonly priceInput: string;
  readonly currency: string;
  /** "" is one-time; the column stores NULL for it. */
  readonly interval: "" | VariantInterval;
  readonly isDefault: boolean;
  readonly inventoryInput: string;
  readonly grantKind: GrantKind;
  readonly grantFeature: string;
  readonly grantLimit: string;
  readonly grantSeats: string;
  readonly grantKeyFormat: string;
  readonly grantWeightGrams: string;
  readonly grantRequiresAddress: boolean;
}

export function emptyVariantRow(key: string, currency: string, kind: ProductKind): VariantRow {
  return {
    key,
    id: null,
    name: "",
    sku: "",
    priceInput: "",
    currency,
    // Pre-filled to match the product's kind, because the alternative is a
    // form that is born invalid: a subscription variant with no interval is
    // `subscription-variant-missing-interval` before anyone has typed.
    interval: kind === "subscription" ? "month" : "",
    isDefault: false,
    inventoryInput: "",
    grantKind: "none",
    grantFeature: "",
    grantLimit: "",
    grantSeats: "",
    grantKeyFormat: "",
    grantWeightGrams: "",
    grantRequiresAddress: false,
  };
}

/** The `product_grants.config` payload for a row, shaped by its kind. */
export function grantConfigFor(row: VariantRow): Record<string, unknown> {
  switch (row.grantKind) {
    case "entitlement":
      return {
        feature: row.grantFeature.trim(),
        // NULL is unlimited, matching `entitlements.limit_value`. Not zero —
        // zero is a real limit meaning "none of this feature".
        limit: row.grantLimit.trim() === "" ? null : Number(row.grantLimit),
      };
    case "license_key":
      return {
        ...(row.grantSeats.trim() === "" ? {} : { seats: Number(row.grantSeats) }),
        ...(row.grantKeyFormat.trim() === "" ? {} : { keyFormat: row.grantKeyFormat.trim() }),
      };
    case "ship":
      return {
        ...(row.grantWeightGrams.trim() === ""
          ? {}
          : { weightGrams: Number(row.grantWeightGrams) }),
        requiresAddress: row.grantRequiresAddress,
      };
    case "none":
      return {};
  }
}

/**
 * What to call this row in a sentence.
 *
 * Its name, then its SKU, then its position — never the empty string, which is
 * what a message reads as when a nameless row is described by `row.name`. The
 * same order @__SCOPE__/catalog labels a variant in, so a problem raised by the
 * package and one raised by this form name the same row the same way.
 */
export function variantLabel(row: VariantRow, index: number): string {
  const name = row.name.trim();
  if (name !== "") return name;
  const sku = row.sku.trim();
  if (sku !== "") return sku;
  return `variant ${index + 1}`;
}
