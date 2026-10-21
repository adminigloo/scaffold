import {
  canPublish as catalogCanPublish,
  validateProduct,
  type GrantDraft,
  type Problem,
  type ProductKind,
  type VariantDraft,
} from "__SCOPE__/catalog";
import { parseInventoryInput, parseMoneyInput } from "@/components/admin/money";
import { grantConfigFor, variantLabel, type VariantRow } from "@/components/admin/variantRow";

/**
 * What is wrong with the product the builder currently holds.
 *
 * ONE implementation, asked two questions. The form asks it on every keystroke
 * to render the problem list and to enable or disable Save; `saveProduct` asks
 * it again before the first write, to refuse a chain that cannot finish. Those
 * used to be different code — the second one did not exist at all — which is
 * how a blank variant name got as far as creating the product row and then
 * failing on the variant, leaving a draft with nothing under it.
 *
 * A PLAIN `.ts` MODULE, for the reason at the top of ./money.ts: esbuild will
 * not transform a `.tsx` under `jsx: "preserve"`, so a rule that lives in a
 * component file is a rule no unit test can reach.
 *
 * The rules themselves are the PACKAGE's. Nothing here decides whether a
 * product is publishable; `validateProduct` and `canPublish` do, and the server
 * re-runs both in `catalog.publish`. A browser holding its own copy of the
 * rules is how a UI ends up offering a button the API then refuses — which is
 * the whole reason this module exists rather than an `if` in the click handler.
 */

export interface ProductDraftState {
  readonly slug: string;
  readonly name: string;
  readonly kind: ProductKind;
  readonly rows: readonly VariantRow[];
}

export interface DraftReview {
  /** Everything `validateProduct` found, in its own order. */
  readonly problems: readonly Problem[];
  /** The same problems keyed by `path`, for rendering beside the field. */
  readonly problemsByPath: ReadonlyMap<string, readonly string[]>;
  /**
   * Amounts and stock counts that could not be parsed at all.
   *
   * Kept apart from `problems` because `validateProduct` cannot see them: by
   * the time it runs the value is already a bigint, and "12,99" never became
   * one. Reported alongside, so the summary really is everything at once.
   */
  readonly moneyProblems: readonly string[];
  /** The package's rule, not `problems.length === 0` written out again. */
  readonly publishable: boolean;
  /**
   * Whether a save may START.
   *
   * False means some field cannot be written as it stands, and the chain must
   * not begin: the first call would land the product row and the second would
   * be refused, which is a half-written product and a message telling the admin
   * to reload a page that, on a create form, does not exist yet.
   */
  readonly writable: boolean;
}

/**
 * Run the package's validator over the form as it stands.
 *
 * `status: "active"` rather than the product's real status, because the
 * question the builder is answering is "what stops this from going live". With
 * the stored `'draft'` the rule that matters most — an active product needs a
 * variant — never fires, and the admin finds out at the publish button.
 */
export function reviewProductDraft(state: ProductDraftState): DraftReview {
  const moneyProblems: string[] = [];

  const variants: VariantDraft[] = state.rows.map((row, index) => {
    const label = variantLabel(row, index);
    const money = parseMoneyInput(row.priceInput, row.currency);
    if (!money.ok) moneyProblems.push(`"${label}": ${money.message}`);

    const stock = parseInventoryInput(row.inventoryInput);
    if (!stock.ok) moneyProblems.push(`"${label}": ${stock.message}`);

    return {
      id: row.id ?? undefined,
      sku: row.sku.trim() === "" ? null : row.sku.trim(),
      name: row.name.trim(),
      // 0 is a stand-in for an amount that could not be parsed; the failure is
      // already reported above, and substituting it keeps every OTHER rule
      // running instead of hiding them behind one bad field.
      priceMinor: money.ok ? money.minor : 0n,
      currency: row.currency,
      interval: row.interval === "" ? null : row.interval,
      isDefault: row.isDefault,
      inventory: stock.ok ? stock.value : null,
    };
  });

  // One grant per row, in row order, so `grants[i]` in a problem path is the
  // same i the variant editor renders.
  const grants: GrantDraft[] = state.rows.map((row) => ({
    variantId: row.id ?? undefined,
    kind: row.grantKind,
    config: grantConfigFor(row),
  }));

  const problems = validateProduct({
    product: {
      slug: state.slug.trim(),
      kind: state.kind,
      status: "active",
      name: state.name.trim(),
    },
    variants,
    grants,
  });

  const problemsByPath = new Map<string, string[]>();
  for (const problem of problems) {
    const bucket = problemsByPath.get(problem.path);
    if (bucket) bucket.push(problem.message);
    else problemsByPath.set(problem.path, [problem.message]);
  }

  const publishable = catalogCanPublish(problems);

  return {
    problems,
    problemsByPath,
    moneyProblems,
    publishable,
    writable: publishable && moneyProblems.length === 0,
  };
}

/**
 * Every reason a save must not start, as sentences, in the order to fix them.
 *
 * Money failures first: an unparseable amount is the one thing on this form
 * that turns a keystroke into a wrong charge, so it is the thing to look at
 * first.
 */
export function refusalReasons(review: DraftReview): readonly string[] {
  return [...review.moneyProblems, ...review.problems.map((problem) => problem.message)];
}

/** Where to send the cursor when a save is refused: the first thing to fix. */
export function firstFaultPath(review: DraftReview): string | null {
  return review.problems[0]?.path ?? null;
}
