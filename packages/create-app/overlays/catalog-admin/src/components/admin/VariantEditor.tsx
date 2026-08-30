import type { ReactNode } from "react";
import { formatMinor, type GrantKind, type ProductKind, type VariantInterval } from "__SCOPE__/catalog";
import { parseInventoryInput, parseMoneyInput } from "@/components/admin/money";

/**
 * The variant rows of the product builder.
 *
 * No `"use client"` directive: `ProductForm` carries it, and everything
 * imported by a client module is compiled into the client graph anyway. The
 * money conversion these fields depend on lives in ./money.ts — see the note at
 * the top of that file for why it is not in here.
 */

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

/**
 * One editable variant, held entirely as strings.
 *
 * The number fields are strings because a half-typed "12." is a legitimate
 * intermediate state and coercing on every keystroke deletes the dot out from
 * under the cursor. The conversion happens once, on submit and for validation,
 * through `parseMoneyInput`.
 */
export interface VariantRow {
  /** Stable React key. The row id once saved, a local token before that. */
  readonly key: string;
  /** NULL until this row has been written, which is why nothing keys on it. */
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const FIELD =
  "w-full rounded-[--radius-card] border border-line bg-surface px-2.5 py-1.5 text-sm text-ink " +
  "placeholder:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-60";

const LABEL = "mb-1 block text-[11px] font-medium uppercase tracking-wider text-ink-muted";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";

const GRANT_LABELS: Record<GrantKind, string> = {
  none: "Nothing — handled outside the platform",
  ship: "Ship something physical",
  license_key: "Issue a licence key",
  entitlement: "Unlock a feature (entitlement)",
};

export interface VariantEditorProps {
  readonly rows: readonly VariantRow[];
  readonly kind: ProductKind;
  /**
   * The caller holds `catalog.products.edit` but not `catalog.prices.edit`.
   * Presentation only — every procedure re-checks, because a disabled input is
   * a courtesy and the mutation is reachable without the page.
   */
  readonly disabled: boolean;
  /** `validateProduct` problems, keyed by their `path`. */
  readonly problemsByPath: ReadonlyMap<string, readonly string[]>;
  readonly onChange: (key: string, patch: Partial<VariantRow>) => void;
  readonly onAdd: () => void;
  readonly onRemove: (key: string) => void;
}

export function VariantEditor({
  rows,
  kind,
  disabled,
  problemsByPath,
  onChange,
  onAdd,
  onRemove,
}: VariantEditorProps) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Variants</h2>
          <p className="text-sm text-ink-muted">
            One row per thing a customer can actually buy: a size, a tier, a
            seat count. Each carries its own price and its own grant.
          </p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          disabled={disabled}
          className={`shrink-0 rounded-[--radius-card] border border-line bg-surface px-3 py-1.5 text-sm text-ink ${FOCUS} disabled:cursor-not-allowed disabled:opacity-60`}
        >
          Add variant
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-[--radius-card] border border-dashed border-line bg-surface p-4 text-sm text-ink-muted">
          No variants yet. A product needs at least one variant with a price
          before it can be published — until then the storefront can list it and
          nobody can buy it. Use <span className="text-ink">Add variant</span> to
          create the first one.
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row, index) => (
            <VariantRowFields
              key={row.key}
              row={row}
              index={index}
              kind={kind}
              disabled={disabled}
              problemsByPath={problemsByPath}
              onChange={onChange}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface VariantRowFieldsProps {
  readonly row: VariantRow;
  readonly index: number;
  readonly kind: ProductKind;
  readonly disabled: boolean;
  readonly problemsByPath: ReadonlyMap<string, readonly string[]>;
  readonly onChange: (key: string, patch: Partial<VariantRow>) => void;
  readonly onRemove: (key: string) => void;
}

function VariantRowFields({
  row,
  index,
  kind,
  disabled,
  problemsByPath,
  onChange,
  onRemove,
}: VariantRowFieldsProps) {
  const at = `variants[${index}]`;
  const money = parseMoneyInput(row.priceInput, row.currency);
  const stock = parseInventoryInput(row.inventoryInput);
  const id = (field: string) => `${row.key}-${field}`;

  return (
    <li className="rounded-[--radius-card] border border-line bg-surface p-4">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <span className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">
          Variant {index + 1}
          {row.id === null ? " · unsaved" : ""}
        </span>
        <button
          type="button"
          onClick={() => onRemove(row.key)}
          disabled={disabled}
          className={`text-sm text-danger ${FOCUS} rounded-[--radius-card] px-1 disabled:cursor-not-allowed disabled:opacity-60`}
        >
          Remove
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="lg:col-span-2">
          <label className={LABEL} htmlFor={id("name")}>
            Name
          </label>
          <input
            id={id("name")}
            className={FIELD}
            value={row.name}
            disabled={disabled}
            placeholder="Standard edition"
            onChange={(event) => onChange(row.key, { name: event.target.value })}
          />
        </div>

        <div>
          <label className={LABEL} htmlFor={id("sku")}>
            SKU <span className="normal-case tracking-normal">(optional)</span>
          </label>
          <input
            id={id("sku")}
            className={FIELD}
            value={row.sku}
            disabled={disabled}
            placeholder="DECK-STD-01"
            onChange={(event) => onChange(row.key, { sku: event.target.value })}
          />
          <FieldNote>
            Blank for anything with no stock keeping unit. Inventing one puts a
            fake value into the warehouse export.
          </FieldNote>
        </div>

        <div>
          <label className={LABEL} htmlFor={id("currency")}>
            Currency
          </label>
          <input
            id={id("currency")}
            className={`${FIELD} lowercase`}
            value={row.currency}
            disabled={disabled}
            maxLength={3}
            placeholder="usd"
            onChange={(event) =>
              onChange(row.key, { currency: event.target.value.toLowerCase() })
            }
          />
          <Problems messages={problemsByPath.get(`${at}.currency`)} />
        </div>

        <div>
          <label className={LABEL} htmlFor={id("price")}>
            Price
          </label>
          <input
            id={id("price")}
            className={FIELD}
            value={row.priceInput}
            disabled={disabled}
            inputMode="decimal"
            placeholder="12.99"
            aria-invalid={!money.ok}
            onChange={(event) =>
              onChange(row.key, { priceInput: event.target.value })
            }
          />
          {money.ok ? (
            <FieldNote>
              {/* Never a hand-rolled divide by 100 — JPY has no minor unit and
                  the result would be a hundredfold error that looks plausible. */}
              Stored as {money.minor.toString()} minor units ·{" "}
              {formatMinor(money.minor, row.currency)}
            </FieldNote>
          ) : (
            <p className="mt-1 text-xs text-danger">{money.message}</p>
          )}
          <Problems messages={problemsByPath.get(`${at}.priceMinor`)} />
        </div>

        <div>
          <label className={LABEL} htmlFor={id("interval")}>
            Billing interval
          </label>
          <select
            id={id("interval")}
            className={FIELD}
            value={row.interval}
            // A one-time product has no interval to choose. Left visible rather
            // than hidden so switching the product's kind explains itself.
            disabled={disabled || kind === "one_time"}
            onChange={(event) =>
              onChange(row.key, {
                interval: event.target.value as VariantRow["interval"],
              })
            }
          >
            <option value="">One-time</option>
            <option value="month">Every month</option>
            <option value="year">Every year</option>
          </select>
          <Problems messages={problemsByPath.get(`${at}.interval`)} />
        </div>

        <div>
          <label className={LABEL} htmlFor={id("inventory")}>
            Stock
          </label>
          <input
            id={id("inventory")}
            className={FIELD}
            value={row.inventoryInput}
            disabled={disabled}
            inputMode="numeric"
            placeholder="untracked"
            aria-invalid={!stock.ok}
            onChange={(event) =>
              onChange(row.key, { inventoryInput: event.target.value })
            }
          />
          {stock.ok ? (
            <FieldNote>
              {stock.value === null
                ? "Blank: untracked, always buyable."
                : stock.value === 0
                  ? "0: sold out."
                  : `${stock.value} in stock.`}
            </FieldNote>
          ) : (
            <p className="mt-1 text-xs text-danger">{stock.message}</p>
          )}
          <Problems messages={problemsByPath.get(`${at}.inventory`)} />
        </div>

        <div className="flex items-center lg:col-span-2">
          <label className="flex items-start gap-2 text-sm text-ink" htmlFor={id("default")}>
            <input
              id={id("default")}
              type="checkbox"
              className={`mt-0.5 accent-[var(--color-accent)] ${FOCUS}`}
              checked={row.isDefault}
              disabled={disabled}
              onChange={(event) =>
                onChange(row.key, { isDefault: event.target.checked })
              }
            />
            <span>
              Preselect this one
              <span className="block text-xs text-ink-muted">
                Exactly one, or none. With two, which price the product page
                shows depends on row order and changes between page loads.
              </span>
            </span>
          </label>
        </div>
      </div>
      <Problems messages={problemsByPath.get(`${at}.isDefault`)} />

      <GrantFields
        row={row}
        index={index}
        disabled={disabled}
        problemsByPath={problemsByPath}
        onChange={onChange}
      />
    </li>
  );
}

/**
 * What buying this variant gives the buyer.
 *
 * Per VARIANT, not per product, because that is what the table is: one purchase
 * routinely does two things, and a boxed product that also unlocks the
 * companion app is a `ship` AND an `entitlement`. This form edits one grant per
 * variant, which covers almost every product; `catalog.setGrant` upserts by
 * kind, so a second kind added through the API is not clobbered by a save here.
 */
function GrantFields({
  row,
  index,
  disabled,
  problemsByPath,
  onChange,
}: {
  readonly row: VariantRow;
  readonly index: number;
  readonly disabled: boolean;
  readonly problemsByPath: ReadonlyMap<string, readonly string[]>;
  readonly onChange: (key: string, patch: Partial<VariantRow>) => void;
}) {
  const id = (field: string) => `${row.key}-${field}`;

  return (
    <fieldset className="mt-4 border-t border-line pt-3">
      <legend className="sr-only">What buying variant {index + 1} grants</legend>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="lg:col-span-2">
          <label className={LABEL} htmlFor={id("grant")}>
            Buying this gives them
          </label>
          <select
            id={id("grant")}
            className={FIELD}
            value={row.grantKind}
            disabled={disabled}
            onChange={(event) =>
              onChange(row.key, { grantKind: event.target.value as GrantKind })
            }
          >
            {(Object.keys(GRANT_LABELS) as GrantKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {GRANT_LABELS[kind]}
              </option>
            ))}
          </select>
          <FieldNote>
            This is what routes the purchase: shipping prints a packing slip, an
            entitlement writes a row billing reads. Without it, &ldquo;does this
            need a postal address?&rdquo; gets answered by comparing product
            names in a checkout route.
          </FieldNote>
        </div>

        {row.grantKind === "entitlement" ? (
          <>
            <div>
              <label className={LABEL} htmlFor={id("feature")}>
                Feature key
              </label>
              <input
                id={id("feature")}
                className={FIELD}
                value={row.grantFeature}
                disabled={disabled}
                placeholder="advanced_reports"
                onChange={(event) =>
                  onChange(row.key, { grantFeature: event.target.value })
                }
              />
              <FieldNote>
                Required. Without it the purchase succeeds, the customer is
                charged, and the entitlement row is keyed on nothing.
              </FieldNote>
            </div>
            <div>
              <label className={LABEL} htmlFor={id("limit")}>
                Limit
              </label>
              <input
                id={id("limit")}
                className={FIELD}
                value={row.grantLimit}
                disabled={disabled}
                inputMode="numeric"
                placeholder="unlimited"
                onChange={(event) =>
                  onChange(row.key, { grantLimit: event.target.value })
                }
              />
              <FieldNote>Blank is unlimited. 0 is a real limit of none.</FieldNote>
            </div>
          </>
        ) : null}

        {row.grantKind === "license_key" ? (
          <>
            <div>
              <label className={LABEL} htmlFor={id("seats")}>
                Seats
              </label>
              <input
                id={id("seats")}
                className={FIELD}
                value={row.grantSeats}
                disabled={disabled}
                inputMode="numeric"
                placeholder="1"
                onChange={(event) =>
                  onChange(row.key, { grantSeats: event.target.value })
                }
              />
            </div>
            <div>
              <label className={LABEL} htmlFor={id("keyformat")}>
                Key format
              </label>
              <input
                id={id("keyformat")}
                className={FIELD}
                value={row.grantKeyFormat}
                disabled={disabled}
                placeholder="XXXX-XXXX-XXXX"
                onChange={(event) =>
                  onChange(row.key, { grantKeyFormat: event.target.value })
                }
              />
            </div>
          </>
        ) : null}

        {row.grantKind === "ship" ? (
          <>
            <div>
              <label className={LABEL} htmlFor={id("weight")}>
                Weight (grams)
              </label>
              <input
                id={id("weight")}
                className={FIELD}
                value={row.grantWeightGrams}
                disabled={disabled}
                inputMode="numeric"
                placeholder="340"
                onChange={(event) =>
                  onChange(row.key, { grantWeightGrams: event.target.value })
                }
              />
            </div>
            <div className="flex items-center">
              <label
                className="flex items-start gap-2 text-sm text-ink"
                htmlFor={id("address")}
              >
                <input
                  id={id("address")}
                  type="checkbox"
                  className={`mt-0.5 accent-[var(--color-accent)] ${FOCUS}`}
                  checked={row.grantRequiresAddress}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(row.key, { grantRequiresAddress: event.target.checked })
                  }
                />
                <span>Checkout must collect a postal address</span>
              </label>
            </div>
          </>
        ) : null}
      </div>
      <Problems messages={problemsByPath.get(`grants[${index}].config`)} />
      <Problems messages={problemsByPath.get(`grants[${index}].config.feature`)} />
    </fieldset>
  );
}

function FieldNote({ children }: { readonly children: ReactNode }) {
  return <p className="mt-1 text-xs text-ink-muted">{children}</p>;
}

function Problems({ messages }: { readonly messages?: readonly string[] }) {
  if (!messages || messages.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {messages.map((message) => (
        <li key={message} className="text-xs text-danger">
          {message}
        </li>
      ))}
    </ul>
  );
}
