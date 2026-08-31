import type { GrantKind, ProductKind, VariantInterval } from "__SCOPE__/catalog";
import { parseInventoryInput, parseMoneyInput } from "@/components/admin/money";
import {
  firstFaultPath,
  refusalReasons,
  reviewProductDraft,
} from "@/components/admin/productDraft";
import { grantConfigFor, variantLabel, type VariantRow } from "@/components/admin/variantRow";
import type { SaveStep } from "@/components/admin/saveErrors";

/**
 * Saving a product: the chain of writes, and what the form must adopt from each.
 *
 * WHY THIS IS NOT INSIDE THE COMPONENT. Two of the three defects that made the
 * product flow unusable lived in this chain, and neither was visible in
 * isolation — the code read correctly line by line. They were only findable by
 * running the sequence and asking what the form believed afterwards, which is
 * exactly what a test can do to a plain function and cannot do to a click
 * handler. `jsx: "preserve"` means a `.tsx` cannot even be imported by vitest;
 * see the note at the top of ./money.ts.
 *
 * THE INVARIANT, and it is the whole reason for the `journal` parameter:
 *
 *     AFTER A SUCCESSFUL SAVE THE FORM AGREES WITH THE DATABASE.
 *
 * Every write here returns an id, and every id has to land back on the row that
 * produced it BEFORE the next await. Dropping one is not cosmetic. `row.id`
 * is what the Publish button, the "not been written yet" line, the `· unsaved`
 * marker and the Stripe plan all read, so a save that stores the variant and
 * forgets its id leaves an admin looking at a written row the form insists does
 * not exist, pressing Save in a loop that changes nothing, with no way out but
 * a reload and nothing on screen to suggest one.
 *
 * Adopting the ids as they arrive — rather than re-seeding the form from a
 * refetch — is also what makes a HALF-FINISHED save recoverable. A chain broken
 * by a dropped connection leaves the product created and some rows written; on
 * the next press the product has an id so it is updated rather than created
 * again, and each written row has an id so it is updated rather than
 * duplicated. Press Save again is the recovery story, on the create form too,
 * where there is no page to reload.
 *
 * NOT ONE TRANSACTION, deliberately. `create` and `upsertVariant` are
 * separately permissioned: `catalog.products.edit` and `catalog.prices.edit`
 * are different keys, because changing what a customer is charged is not the
 * same act as fixing a typo. One procedure doing both would collapse them into
 * whichever is weaker.
 */

// ---------------------------------------------------------------------------
// What the chain writes through
// ---------------------------------------------------------------------------

export interface ProductFields {
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly kind: ProductKind;
}

export interface VariantWrite {
  /** Absent for a row that has never been written. */
  readonly id?: string;
  readonly productId: string;
  readonly name: string;
  readonly sku: string | null;
  readonly priceMinor: bigint;
  readonly currency: string;
  readonly interval: VariantInterval | null;
  readonly isDefault: boolean;
  readonly inventory: number | null;
  readonly sortOrder: number;
}

export interface GrantWrite {
  readonly variantId: string;
  readonly kind: GrantKind;
  readonly config: Record<string, unknown>;
}

/**
 * The procedures, as an interface rather than as `api.catalog.*` directly.
 *
 * The component supplies the tRPC mutations; a test supplies four functions and
 * a list. Nothing about the order of the writes, the ids that come back or the
 * refusal to start depends on React, a network, or a database being present.
 */
export interface ProductWriteGateway {
  createProduct(input: ProductFields): Promise<{ readonly id: string }>;
  updateProduct(input: ProductFields & { readonly id: string }): Promise<{ readonly id: string }>;
  upsertVariant(input: VariantWrite): Promise<{ readonly id: string }>;
  setGrant(input: GrantWrite): Promise<unknown>;
  removeVariant(input: { readonly id: string }): Promise<unknown>;
}

/**
 * Where each write is recorded the instant the server confirms it.
 *
 * Called DURING the chain, not after it, so a failure at step four cannot undo
 * the form's knowledge of steps one to three. The component wires these to
 * `setState`; a test wires them to an array and asserts on it.
 */
export interface SaveJournal {
  /** The product now exists under this id — from a create, or the one we had. */
  productWritten(productId: string): void;
  /** This row is now a database row. Keyed on `row.key`, which never changes. */
  variantWritten(rowKey: string, variantId: string): void;
  /** This deletion has happened, so a retry must not attempt it again. */
  variantRemoved(variantId: string): void;
}

// ---------------------------------------------------------------------------
// Input and outcome
// ---------------------------------------------------------------------------

export interface ProductSaveDraft {
  /**
   * The product's id, or null for one that has never been written.
   *
   * Null only until the FIRST successful create. A create that failed halfway
   * still leaves an id here on the next attempt, which is what stops a retry
   * inserting a second product and then being refused for a duplicate slug.
   */
  readonly productId: string | null;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly kind: ProductKind;
  readonly rows: readonly VariantRow[];
  readonly removedIds: readonly string[];
}

export type ProductSaveOutcome =
  | {
      readonly status: "saved";
      readonly productId: string;
      readonly written: number;
    }
  | {
      /** Nothing was sent. The draft cannot be written as it stands. */
      readonly status: "refused";
      readonly reasons: readonly string[];
      readonly faultPath: string | null;
    }
  | {
      readonly status: "failed";
      /** Non-null whenever the product itself landed before the failure. */
      readonly productId: string | null;
      readonly written: number;
      readonly step: SaveStep;
      readonly error: unknown;
    };

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

export async function saveProduct(
  draft: ProductSaveDraft,
  gateway: ProductWriteGateway,
  journal: SaveJournal,
): Promise<ProductSaveOutcome> {
  // ---- refuse before writing anything -------------------------------------
  // The Save button is already disabled while this would fail; that is a
  // courtesy, and a courtesy is not a guard. Without the check here, a blank
  // variant name creates the product, then has `upsertVariant` refuse it, and
  // leaves a draft product with no variants under it — which is how the raw
  // zod dump became reachable in the first place.
  const review = reviewProductDraft({
    slug: draft.slug,
    name: draft.name,
    kind: draft.kind,
    rows: draft.rows,
  });
  if (!review.writable) {
    return {
      status: "refused",
      reasons: refusalReasons(review),
      faultPath: firstFaultPath(review),
    };
  }

  // Parsed up front, all of it, before the first call. A row whose amount
  // cannot be read must not be skipped mid-chain: `continue` there is how a
  // variant silently fails to be written while the save reports success.
  const prepared: {
    readonly row: VariantRow;
    readonly index: number;
    readonly priceMinor: bigint;
    readonly inventory: number | null;
  }[] = [];

  for (const [index, row] of draft.rows.entries()) {
    const money = parseMoneyInput(row.priceInput, row.currency);
    const stock = parseInventoryInput(row.inventoryInput);
    if (!money.ok || !stock.ok) {
      // Unreachable while `review.writable` holds — both are money problems —
      // and kept because the alternative is a non-null assertion that would
      // still be here after somebody changes what `writable` covers.
      return {
        status: "refused",
        reasons: refusalReasons(review),
        faultPath: `variants[${index}].priceMinor`,
      };
    }
    prepared.push({ row, index, priceMinor: money.minor, inventory: stock.value });
  }

  let step: SaveStep = { kind: "product" };
  let written = 0;
  let productId = draft.productId;

  try {
    const fields: ProductFields = {
      slug: draft.slug.trim(),
      name: draft.name.trim(),
      description: draft.description.trim() === "" ? null : draft.description.trim(),
      kind: draft.kind,
    };

    productId =
      productId === null
        ? (await gateway.createProduct(fields)).id
        : (await gateway.updateProduct({ id: productId, ...fields })).id;
    // Before the next await, always. If the connection drops on the very next
    // call, the form still knows the product exists and under which id.
    journal.productWritten(productId);
    written += 1;

    // Variants BEFORE removals, so replacing the only variant on an active
    // product works: `removeVariant` refuses to take the last one, and by then
    // the replacement exists.
    for (const { row, index, priceMinor, inventory } of prepared) {
      step = { kind: "variant", index, label: variantLabel(row, index) };

      const saved = await gateway.upsertVariant({
        ...(row.id === null ? {} : { id: row.id }),
        productId,
        name: row.name.trim(),
        sku: row.sku.trim() === "" ? null : row.sku.trim(),
        priceMinor,
        currency: row.currency,
        interval: row.interval === "" ? null : row.interval,
        isDefault: row.isDefault,
        inventory,
        sortOrder: index,
      });
      // THE LINE THE BLOCKER WAS MISSING. `saved.id` was used for the grant
      // below and then thrown away, so the row stayed `id: null` for the
      // lifetime of the component and Publish stayed disabled forever.
      journal.variantWritten(row.key, saved.id);
      written += 1;

      step = { kind: "grant", index, label: variantLabel(row, index) };
      await gateway.setGrant({
        variantId: saved.id,
        kind: row.grantKind,
        config: grantConfigFor(row),
      });
      written += 1;
    }

    for (const id of draft.removedIds) {
      step = { kind: "removal", variantId: id };
      await gateway.removeVariant({ id });
      // Dropped one at a time rather than cleared at the end, so a failure on
      // the third deletion does not leave the first two queued for a retry that
      // would fail with NOT_FOUND on rows that are already gone.
      journal.variantRemoved(id);
      written += 1;
    }

    return { status: "saved", productId, written };
  } catch (error) {
    return { status: "failed", productId, written, step, error };
  }
}
