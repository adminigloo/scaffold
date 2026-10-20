import { listProducts, recipeOf } from "./catalog.js";
import { priceProduct } from "./price-product.js";
import { customerFieldsFor } from "./recipes.js";
import { formatMoney, getEstimatorSettings, publicEstimatesOpen, type EstimatorSettings } from "./settings.js";
import type { EstimatorDb } from "./types.js";
import type { CustomerInputs } from "./wire.js";

/**
 * One service on a business's public page (create-app 0.36's mini website):
 * a product the owner put on their website, and the least it costs.
 */
export interface StartingPrice {
  readonly productId: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string | null;
  /**
   * The lowest price the customer could be quoted, in cents: the bottom of
   * the range for the smallest job the product's own questions allow (one
   * step, one item, the smallest size), priced by the same `priceProduct` the
   * estimate page runs — never a number typed somewhere else. Null when the
   * product is priced by a person (a quote), prices at $0 (not set up yet), or
   * instant estimates are closed.
   */
  readonly fromCents: number | null;
  /** "$1,450", in the business's currency and locale; null with `fromCents`. */
  readonly from: string | null;
}

/**
 * The services a business shows on its public page, each with "from $X"
 * (create-app 0.36). The products the owner switched on for the website
 * ("Show on your website"), in the price book's own order.
 *
 * THE PRICE IS THE ESTIMATE PAGE'S OWN. Each product is priced with the
 * smallest answers its questions accept — every required count at its
 * minimum, every required size at its smallest — through `priceProduct` with
 * `audience: "public"`, so the floor, the minimum charge, the options'
 * defaults and the never-a-public-$0 rule all apply exactly as they would for
 * a customer. The "from" is that price's low end. Nothing is written.
 *
 * Pass the business's resolved settings (`resolveEstimatorSettings`, which
 * folds in the company's name) when you have them; without them the stored
 * settings are read.
 */
export async function startingPrices(
  db: EstimatorDb,
  tenantId: string,
  options: { readonly settings?: EstimatorSettings; readonly limit?: number } = {},
): Promise<StartingPrice[]> {
  const settings = options.settings ?? (await getEstimatorSettings(db, tenantId));
  const open = publicEstimatesOpen(settings);
  const products = (await listProducts(db, tenantId, { publicOnly: true })).slice(0, options.limit ?? 12);
  const out: StartingPrice[] = [];
  for (const product of products) {
    let fromCents: number | null = null;
    if (open && product.isEstimatable) {
      try {
        const { recipe, config } = recipeOf(product);
        const inputs: CustomerInputs = {};
        for (const field of customerFieldsFor(recipe, config)) {
          if (!field.required) continue;
          if (field.kind === "stepper" || field.kind === "number") inputs[field.key] = field.min;
          else if (field.kind === "choice" && field.choices[0]) Object.assign(inputs, field.choices[0].sets);
        }
        const priced = await priceProduct(db, tenantId, { productId: product.id, inputs, quantity: 1 }, { audience: "public", settings });
        if (priced.status === "priced" && priced.build.estimateLow > 0) fromCents = priced.build.estimateLow;
      } catch {
        // A product whose smallest job can't be priced shows without a "from".
        fromCents = null;
      }
    }
    out.push({
      productId: product.id,
      name: product.name,
      description: product.description,
      category: product.category,
      fromCents,
      // Whole units, rounded DOWN: "from $1,449", never a cent above the real floor.
      from: fromCents === null ? null : formatMoney(Math.floor(fromCents / 100) * 100, settings, true),
    });
  }
  return out;
}
