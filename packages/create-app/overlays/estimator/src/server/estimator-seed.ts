import { sql } from "drizzle-orm";
import {
  createOption,
  createOptionValue,
  createProduct,
  DEFAULT_TAX_RATE_BP,
  listProducts,
} from "__SCOPE__/estimator";
import { db as sharedDb } from "@/db";

/**
 * A demo price book, seeded on first read of an empty catalog (the same
 * "seed on first read" pattern the feedback board uses), so the public
 * instant-estimate tool works on every environment with no deploy-time seed.
 * Replace these with your own products from the admin builder — the tool prices
 * whatever is in the catalog.
 *
 * Idempotent: if the tenant already has products it returns immediately, so it
 * is safe to call before every catalog read.
 */
export const ESTIMATOR_TENANT = "primary";

/**
 * The sales-tax rate a customer's saved estimate is taxed at, in basis points
 * (825 = 8.25%). SET THIS FOR YOUR JURISDICTION. It is the server's word — the
 * public tool and the embed never send a rate — so it lives here with the
 * tenant, and both the same-origin submit and the embed handler read it.
 */
export const ESTIMATOR_TAX_RATE_BP: number = DEFAULT_TAX_RATE_BP;

let seededThisProcess = false;

export async function ensureDemoCatalog(db = sharedDb): Promise<void> {
  if (seededThisProcess) return;
  const existing = await listProducts(db, ESTIMATOR_TENANT);
  if (existing.length > 0) {
    seededThisProcess = true;
    return;
  }

  await db.transaction(async (tx) => {
    // Serialize concurrent cold-start seeders: the advisory lock is held for the
    // transaction, so a second first-request waits, then finds it already seeded.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`estimator-seed:${ESTIMATOR_TENANT}`}))`);
    const again = await listProducts(tx, ESTIMATOR_TENANT);
    if (again.length > 0) return;
    await seedCatalog(tx);
  });

  seededThisProcess = true;
}

async function seedCatalog(db: Parameters<typeof listProducts>[0]): Promise<void> {
  // A by-the-foot service, priced per linear foot with a customer-facing option.
  const runService = await createProduct(db, {
    tenantId: ESTIMATOR_TENANT,
    name: "Install (by the foot)",
    category: "Services",
    description: "A representative measured service, priced by the linear foot of run.",
    measurementMode: "linear",
    pricePerLinearFt: 14_500,
    markupBp: 2_500,
    minimumCharge: 35_000,
    sortOrder: 10,
  });
  const finish = await createOption(db, {
    productId: runService.id,
    name: "Finish",
    optionType: "finish",
    sortOrder: 10,
  });
  await createOptionValue(db, { optionId: finish.id, label: "Standard", isDefault: true, sortOrder: 10 });
  await createOptionValue(db, { optionId: finish.id, label: "Premium", priceModifier: 6_000, sortOrder: 20 });

  // A flat-rate unit service.
  await createProduct(db, {
    tenantId: ESTIMATOR_TENANT,
    name: "Standard unit",
    category: "Services",
    description: "A single flat-priced item or visit.",
    measurementMode: "unit",
    basePrice: 9_500,
    sortOrder: 20,
  });

  // The escape hatch: shown in the tool, not instant-estimatable — files a lead.
  await createProduct(db, {
    tenantId: ESTIMATOR_TENANT,
    name: "Custom / something else",
    category: "Services",
    description: "Anything unusual — leave your details and we'll size it up.",
    measurementMode: "unit",
    isEstimatable: false,
    sortOrder: 90,
  });
}
