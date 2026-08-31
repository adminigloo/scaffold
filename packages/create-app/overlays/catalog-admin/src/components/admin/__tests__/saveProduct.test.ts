import { describe, expect, it } from "vitest";
import {
  saveProduct,
  type ProductFields,
  type ProductSaveDraft,
  type ProductWriteGateway,
  type SaveJournal,
  type VariantWrite,
} from "@/components/admin/saveProduct";
import { emptyVariantRow, type VariantRow } from "@/components/admin/variantRow";

/**
 * THE ONE ASSERTION THIS FILE EXISTS FOR:
 *
 *     AFTER A SUCCESSFUL SAVE THE FORM AGREES WITH THE DATABASE.
 *
 * The blocker it was written after looked correct in isolation. `handleSave`
 * awaited `upsertVariant`, used the returned id for the grant on the very next
 * line, and dropped it — so the row it came from stayed `id: null` for the
 * lifetime of the component. Nothing threw. The variant WAS in
 * `product_variants`. But `row.id === null` is what the Publish button, the
 * "has not been written yet" line, the `· unsaved` row marker and the Stripe
 * plan all read, so the product could never be published, the storefront could
 * never have anything on it, and checkout could never be exercised. Saving
 * again re-upserted and changed nothing.
 *
 * A component test could not have caught it either — `jsx: "preserve"` keeps
 * vitest out of a `.tsx` entirely. So the chain lives in a plain module and
 * this drives it against a fake catalog, asserting on what the form BELIEVES
 * afterwards rather than on which calls were made.
 */

// ---------------------------------------------------------------------------
// A catalog that behaves like the real one, in about forty lines
// ---------------------------------------------------------------------------

interface FakeCatalog {
  readonly gateway: ProductWriteGateway;
  /** Every call, in order, as `name` or `name:discriminator`. */
  readonly calls: string[];
  readonly stored: {
    readonly products: Map<string, ProductFields>;
    readonly variants: Map<string, VariantWrite>;
    readonly grants: Map<string, string>;
  };
}

/** `failAt` names a call — `upsertVariant:Deluxe` — that rejects instead. */
function fakeCatalog(failAt?: { readonly call: string; readonly error: unknown }): FakeCatalog {
  const calls: string[] = [];
  const products = new Map<string, ProductFields>();
  const variants = new Map<string, VariantWrite>();
  const grants = new Map<string, string>();
  let sequence = 0;

  function record(call: string): void {
    calls.push(call);
    if (failAt?.call === call) throw failAt.error;
  }

  const gateway: ProductWriteGateway = {
    async createProduct(input) {
      record("createProduct");
      sequence += 1;
      const id = `prod_${sequence}`;
      products.set(id, input);
      return { id };
    },
    async updateProduct(input) {
      record("updateProduct");
      products.set(input.id, input);
      return { id: input.id };
    },
    async upsertVariant(input) {
      record(`upsertVariant:${input.name}`);
      sequence += 1;
      const id = input.id ?? `var_${sequence}`;
      variants.set(id, { ...input, id });
      return { id };
    },
    async setGrant(input) {
      record(`setGrant:${input.variantId}`);
      grants.set(input.variantId, input.kind);
      return {};
    },
    async removeVariant(input) {
      record(`removeVariant:${input.id}`);
      variants.delete(input.id);
      return {};
    },
  };

  return { gateway, calls, stored: { products, variants, grants } };
}

// ---------------------------------------------------------------------------
// The form's state, as the component holds it
// ---------------------------------------------------------------------------

interface FormState {
  productId: string | null;
  rows: readonly VariantRow[];
  removedIds: readonly string[];
}

/** Exactly what `ProductForm` wires the journal to, minus React. */
function journalOnto(state: FormState): SaveJournal {
  return {
    productWritten: (id) => {
      state.productId = id;
    },
    variantWritten: (rowKey, variantId) => {
      state.rows = state.rows.map((row) =>
        row.key === rowKey ? { ...row, id: variantId } : row,
      );
    },
    variantRemoved: (variantId) => {
      state.removedIds = state.removedIds.filter((candidate) => candidate !== variantId);
    },
  };
}

function draftFrom(state: FormState, overrides: Partial<ProductSaveDraft> = {}): ProductSaveDraft {
  return {
    productId: state.productId,
    slug: "deck-of-cards",
    name: "Deck of Cards",
    description: "",
    kind: "one_time",
    rows: state.rows,
    removedIds: state.removedIds,
    ...overrides,
  };
}

function row(key: string, overrides: Partial<VariantRow> = {}): VariantRow {
  return {
    ...emptyVariantRow(key, "usd", "one_time"),
    name: "Digital deck",
    priceInput: "12.99",
    ...overrides,
  };
}

/** What the Publish button reads. The number that stayed at 1 forever. */
function unsavedRows(state: FormState): number {
  return state.rows.filter((candidate) => candidate.id === null).length;
}

// ---------------------------------------------------------------------------

describe("after a successful save the form agrees with the database", () => {
  it("writes back the id of every variant the server stored", async () => {
    const state: FormState = { productId: null, rows: [row("new-1")], removedIds: [] };
    const catalog = fakeCatalog();

    const outcome = await saveProduct(draftFrom(state), catalog.gateway, journalOnto(state));

    expect(outcome.status).toBe("saved");
    // The row is no longer id-less, and the id is the one the database chose —
    // not a value this form invented for itself.
    expect(state.rows[0]?.id).not.toBeNull();
    expect([...catalog.stored.variants.keys()]).toEqual([state.rows[0]?.id]);
  });

  it("leaves no row counted as unsaved, so Publish becomes reachable", async () => {
    const state: FormState = {
      productId: null,
      rows: [row("new-1"), row("new-2", { name: "Printed deck", priceInput: "24.00" })],
      removedIds: [],
    };

    await saveProduct(draftFrom(state), fakeCatalog().gateway, journalOnto(state));

    // THE BLOCKER, as one number. This stayed at the row count no matter how
    // many times Save was pressed, and `disabled={… || unsavedRows > 0}` meant
    // the product could never go live.
    expect(unsavedRows(state)).toBe(0);
  });

  it("adopts the product id, so the create form stops being a create form", async () => {
    const state: FormState = { productId: null, rows: [row("new-1")], removedIds: [] };

    const outcome = await saveProduct(draftFrom(state), fakeCatalog().gateway, journalOnto(state));

    expect(state.productId).not.toBeNull();
    expect(outcome.status === "saved" && outcome.productId).toBe(state.productId);
  });

  it("attaches the grant to the id the variant was actually written under", async () => {
    const state: FormState = {
      productId: null,
      rows: [row("new-1", { grantKind: "entitlement", grantFeature: "advanced_reports" })],
      removedIds: [],
    };
    const catalog = fakeCatalog();

    await saveProduct(draftFrom(state), catalog.gateway, journalOnto(state));

    const variantId = state.rows[0]?.id ?? "";
    expect(catalog.stored.grants.get(variantId)).toBe("entitlement");
  });

  it("keeps the row's React key stable across the save", async () => {
    // The id is adopted; the key is not replaced by it. Changing a key remounts
    // the inputs, which mid-save takes the caret out from under whoever is
    // still typing in the row below.
    const state: FormState = { productId: null, rows: [row("new-1")], removedIds: [] };

    await saveProduct(draftFrom(state), fakeCatalog().gateway, journalOnto(state));

    expect(state.rows[0]?.key).toBe("new-1");
  });
});

describe("saving twice", () => {
  it("updates the product and its rows rather than writing them again", async () => {
    const state: FormState = { productId: null, rows: [row("new-1")], removedIds: [] };
    const catalog = fakeCatalog();

    await saveProduct(draftFrom(state), catalog.gateway, journalOnto(state));
    await saveProduct(draftFrom(state), catalog.gateway, journalOnto(state));

    // One product and one variant, from two saves. Without the write-back the
    // second save would have inserted a second variant — and on the create
    // page, a second product refused for a duplicate slug.
    expect(catalog.stored.products.size).toBe(1);
    expect(catalog.stored.variants.size).toBe(1);
    expect(catalog.calls).toEqual([
      "createProduct",
      "upsertVariant:Digital deck",
      `setGrant:${state.rows[0]?.id}`,
      "updateProduct",
      "upsertVariant:Digital deck",
      `setGrant:${state.rows[0]?.id}`,
    ]);
  });
});

describe("refusing to start", () => {
  it("writes nothing at all when a variant has no name", async () => {
    // The reason the raw zod dump was reachable. `validateProduct` had no rule
    // for a variant name, so the chain began, created the product, and only
    // then had `upsertVariant` refuse — leaving a draft product with no
    // variants and a message telling the admin to reload.
    const state: FormState = { productId: null, rows: [row("new-1", { name: "" })], removedIds: [] };
    const catalog = fakeCatalog();

    const outcome = await saveProduct(draftFrom(state), catalog.gateway, journalOnto(state));

    expect(outcome.status).toBe("refused");
    expect(catalog.calls).toEqual([]);
    expect(catalog.stored.products.size).toBe(0);
    expect(outcome.status === "refused" && outcome.faultPath).toBe("variants[0].name");
    expect(outcome.status === "refused" && outcome.reasons.join(" ")).toContain("Variant 1");
  });

  it("writes nothing when an amount cannot be read", async () => {
    const state: FormState = {
      productId: null,
      rows: [row("new-1", { priceInput: "12,99" })],
      removedIds: [],
    };
    const catalog = fakeCatalog();

    const outcome = await saveProduct(draftFrom(state), catalog.gateway, journalOnto(state));

    expect(outcome.status).toBe("refused");
    expect(catalog.calls).toEqual([]);
  });

  it("writes nothing when the product itself has no name", async () => {
    const state: FormState = { productId: null, rows: [row("new-1")], removedIds: [] };
    const catalog = fakeCatalog();

    const outcome = await saveProduct(
      draftFrom(state, { name: "  " }),
      catalog.gateway,
      journalOnto(state),
    );

    expect(outcome.status).toBe("refused");
    expect(catalog.calls).toEqual([]);
  });
});

describe("a chain that breaks partway", () => {
  it("leaves the form holding every write that landed", async () => {
    const state: FormState = {
      productId: null,
      rows: [row("new-1"), row("new-2", { name: "Deluxe" })],
      removedIds: [],
    };
    const catalog = fakeCatalog({
      call: "upsertVariant:Deluxe",
      error: new TypeError("Failed to fetch"),
    });

    const outcome = await saveProduct(draftFrom(state), catalog.gateway, journalOnto(state));

    expect(outcome.status).toBe("failed");
    // Partial writes are still possible on a dropped connection. What must not
    // also be lost is the form's knowledge of them.
    expect(state.productId).not.toBeNull();
    expect(state.rows[0]?.id).not.toBeNull();
    expect(state.rows[1]?.id).toBeNull();
    expect(outcome.status === "failed" && outcome.step).toEqual({
      kind: "variant",
      index: 1,
      label: "Deluxe",
    });
  });

  it("is recovered by pressing Save again, with no duplicate anything", async () => {
    const state: FormState = {
      productId: null,
      rows: [row("new-1"), row("new-2", { name: "Deluxe" })],
      removedIds: [],
    };

    const broken = fakeCatalog({ call: "upsertVariant:Deluxe", error: new Error("boom") });
    await saveProduct(draftFrom(state), broken.gateway, journalOnto(state));

    // The retry runs against the same store, with the ids the form kept.
    const retry = await saveProduct(draftFrom(state), broken.gateway, journalOnto(state));

    expect(retry.status).toBe("failed"); // still broken, but nothing duplicated
    expect(broken.stored.products.size).toBe(1);
    expect(broken.calls.filter((call) => call === "createProduct")).toHaveLength(1);
    expect(broken.calls.filter((call) => call === "updateProduct")).toHaveLength(1);
  });

  it("counts only the writes the server confirmed", async () => {
    const state: FormState = {
      productId: null,
      rows: [row("new-1"), row("new-2", { name: "Deluxe" })],
      removedIds: [],
    };
    const catalog = fakeCatalog({ call: "upsertVariant:Deluxe", error: new Error("boom") });

    const outcome = await saveProduct(draftFrom(state), catalog.gateway, journalOnto(state));

    // product + first variant + its grant. Not the attempt that failed.
    expect(outcome.status === "failed" && outcome.written).toBe(3);
  });
});

describe("removals", () => {
  it("writes variants before deleting any, so the last one can be replaced", async () => {
    // `removeVariant` refuses to take the last variant off a product. Ordering
    // the chain this way is what lets an admin swap the only variant out.
    const state: FormState = {
      productId: "prod_existing",
      rows: [row("new-1", { name: "Replacement" })],
      removedIds: ["var_old"],
    };
    const catalog = fakeCatalog();

    await saveProduct(draftFrom(state), catalog.gateway, journalOnto(state));

    expect(catalog.calls[0]).toBe("updateProduct");
    expect(catalog.calls[1]).toBe("upsertVariant:Replacement");
    expect(catalog.calls.at(-1)).toBe("removeVariant:var_old");
    expect(state.removedIds).toEqual([]);
  });

  it("does not retry a deletion that already happened", async () => {
    const state: FormState = {
      productId: "prod_existing",
      rows: [row("new-1")],
      removedIds: ["var_a", "var_b"],
    };
    const catalog = fakeCatalog({ call: "removeVariant:var_b", error: new Error("boom") });

    await saveProduct(draftFrom(state), catalog.gateway, journalOnto(state));

    // var_a is gone from the queue; retrying it would hit NOT_FOUND on a row
    // that is already deleted and turn a recoverable save into a stuck one.
    expect(state.removedIds).toEqual(["var_b"]);
  });
});
