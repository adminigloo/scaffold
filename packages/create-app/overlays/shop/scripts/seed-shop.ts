/**
 * A catalogue you can actually buy from, and three orders that prove it.
 *
 *   pnpm db:seed        role templates and their grants — run this FIRST
 *   pnpm db:seed:demo   people, a tenant and an audit trail, then THIS file
 *
 * WHY THIS EXISTS. Everything after "Buy" was unreachable on a fresh project,
 * and not because it was unbuilt: `fulfilPurchase` writes the order, grants the
 * entitlement, mints the licence key and books the shipment, the simulated
 * checkout calls it with no Stripe account, and all of it is tested. What was
 * missing was a product. With an empty `products` table /products is an empty
 * page, /products/[slug] has no slug to resolve, /checkout has nothing to
 * price, and the simulated purchase button therefore cannot be clicked by
 * anybody. The road was missing, not the destination.
 *
 * WHAT IT SEEDS, AND WHY EACH ROW IS HERE. One active product per grant kind,
 * so buying each one exercises a different half of `applyGrant`:
 *
 *   entitlement   Field Notes     a subscription that grants a feature
 *   license_key   Trail Atlas     a key minted inside the booking transaction
 *   ship          Compass badge   a shipment row for a warehouse queue
 *   none          Trail fund      a purchase that grants nothing, on purpose
 *
 * Plus the rows that make the REFUSALS demonstrable, which nothing else in the
 * project can show you: a draft and an archived product (`not_for_sale`), a
 * zero-inventory variant (`sold_out`) and a null-inventory one — the untracked
 * digital case that an `inventory ?? 0` bug reports as sold out.
 *
 * EVERY ORDER GOES THROUGH `fulfilPurchase`, never a raw insert into `orders`.
 * Two writers drift, and they drift in the direction nobody tests, because the
 * seed runs every day and the real path runs for the first time against a
 * paying customer. Going through it also means these orders carry the same
 * audit rows, the same idempotency keys and the same grants as a real purchase.
 *
 * IDEMPOTENT. Every id is a fixed `demo_` constant and every order is booked
 * under a fixed `sim_` reference, so re-running restores the fixture rather
 * than multiplying it — the reference becomes `orders.idempotency_key` and the
 * unique index does the rest.
 */
import { eq } from "drizzle-orm";
import { users } from "__SCOPE__/auth/schema";
import {
  products,
  productGrants,
  productVariants,
} from "__SCOPE__/catalog/schema";
import { pointsAtLocalhost, resolveAppEnv } from "__SCOPE__/env";
import { db } from "../src/db";
import { env } from "../src/env";
import { fulfilPurchase } from "../src/server/fulfilment";
import { STOREFRONT_TENANT_ID } from "../src/server/routers/checkout";

/**
 * Who the seeded orders belong to: the demo owner `seed-demo.ts` creates.
 *
 * Looked up rather than assumed — see `resolveBuyer`. This file is runnable on
 * its own, and an order attributed to a user id with no row behind it is worse
 * than a guest order, because every join to `users` misses and the order shows
 * up owned by nobody with nothing to say it was meant to belong to someone.
 */
const DEMO_BUYER_ID = "demo_user_ada";

interface SeedVariant {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly priceMinor: bigint;
  readonly interval: "month" | "year" | null;
  /** NULL is untracked — the normal case for anything digital. */
  readonly inventory: number | null;
  readonly grantId: string;
  readonly grant:
    | {
        readonly kind: "entitlement";
        readonly config: { readonly feature: string; readonly limit: number | null };
      }
    | { readonly kind: "license_key"; readonly config: { readonly seats: number } }
    | {
        readonly kind: "ship";
        readonly config: {
          readonly weightGrams: number;
          readonly requiresAddress: boolean;
        };
      }
    | { readonly kind: "none"; readonly config: Record<string, never> };
}

interface SeedProduct {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly kind: "one_time" | "subscription";
  readonly status: "draft" | "active" | "archived";
  readonly sortOrder: number;
  readonly variants: readonly SeedVariant[];
}

const CATALOGUE: readonly SeedProduct[] = [
  {
    id: "demo_prod_field_notes",
    slug: "field-notes",
    name: "Field Notes",
    description:
      "A monthly dispatch from the trail. Grants the field-notes.archive " +
      "entitlement for as long as the subscription runs.",
    kind: "subscription",
    status: "active",
    sortOrder: 10,
    variants: [
      {
        id: "demo_var_field_notes_monthly",
        sku: "FN-M",
        name: "Monthly",
        priceMinor: 900n,
        interval: "month",
        inventory: null,
        grantId: "demo_grant_field_notes_monthly",
        grant: {
          kind: "entitlement",
          // NULL is unlimited, and it is not zero. A finite limit scales with
          // quantity inside `applyGrant`; unlimited stays unlimited.
          config: { feature: "field-notes.archive", limit: null },
        },
      },
      {
        id: "demo_var_field_notes_yearly",
        sku: "FN-Y",
        name: "Yearly",
        priceMinor: 9000n,
        interval: "year",
        inventory: null,
        grantId: "demo_grant_field_notes_yearly",
        grant: {
          kind: "entitlement",
          config: { feature: "field-notes.archive", limit: null },
        },
      },
    ],
  },
  {
    id: "demo_prod_trail_atlas",
    slug: "trail-atlas",
    name: "Trail Atlas",
    description:
      "Offline maps for every waymarked route. Buying one mints a licence key " +
      "inside the same transaction that books the order.",
    kind: "one_time",
    status: "active",
    sortOrder: 20,
    variants: [
      {
        id: "demo_var_trail_atlas_single",
        sku: "TA-1",
        name: "Single seat",
        priceMinor: 2900n,
        interval: null,
        // Untracked on purpose. This is the row that catches an
        // `inventory ?? 0` regression, which marks every digital product in the
        // catalogue as sold out and looks like nothing at all until a customer
        // says so.
        inventory: null,
        grantId: "demo_grant_trail_atlas_single",
        grant: { kind: "license_key", config: { seats: 1 } },
      },
      {
        id: "demo_var_trail_atlas_team",
        sku: "TA-5",
        name: "Team — five seats",
        priceMinor: 9900n,
        interval: null,
        inventory: null,
        grantId: "demo_grant_trail_atlas_team",
        grant: { kind: "license_key", config: { seats: 5 } },
      },
    ],
  },
  {
    id: "demo_prod_compass_badge",
    slug: "compass-badge",
    name: "Brass compass badge",
    description:
      "A physical thing in a padded envelope. Buying one books a shipment row " +
      "with no carrier and no shipped_at — a warehouse queue entry, not a " +
      "claim that anything has moved.",
    kind: "one_time",
    status: "active",
    sortOrder: 30,
    variants: [
      {
        id: "demo_var_compass_badge_one",
        sku: "CB-1",
        name: "One badge",
        priceMinor: 1400n,
        interval: null,
        inventory: 25,
        grantId: "demo_grant_compass_badge_one",
        grant: {
          kind: "ship",
          config: { weightGrams: 60, requiresAddress: true },
        },
      },
      {
        id: "demo_var_compass_badge_pair",
        sku: "CB-2",
        name: "Boxed pair",
        priceMinor: 2400n,
        interval: null,
        // Genuinely sold out, so `assertPurchasable` has something to refuse
        // with `sold_out` rather than with `insufficient_stock`. They are
        // different sentences to a customer and only one of them means "come
        // back later".
        inventory: 0,
        grantId: "demo_grant_compass_badge_pair",
        grant: {
          kind: "ship",
          config: { weightGrams: 130, requiresAddress: true },
        },
      },
    ],
  },
  {
    id: "demo_prod_trail_fund",
    slug: "trail-fund",
    name: "Trail fund",
    description:
      "A contribution to path maintenance. Grants nothing — the `none` kind is " +
      "a real answer, not a missing one.",
    kind: "one_time",
    status: "active",
    sortOrder: 40,
    variants: [
      {
        id: "demo_var_trail_fund_ten",
        sku: "TF-10",
        name: "Ten pounds",
        priceMinor: 1000n,
        interval: null,
        inventory: null,
        grantId: "demo_grant_trail_fund_ten",
        grant: { kind: "none", config: {} },
      },
    ],
  },
  {
    // Never on the storefront. It is here so the `not_for_sale` refusal can be
    // seen at all: the seed prints its checkout URL, and following that link is
    // the only way to watch the branch run.
    id: "demo_prod_winter_atlas",
    slug: "winter-atlas",
    name: "Winter Atlas (unreleased)",
    description:
      "A draft. Drafts are never shown to customers and cannot be bought.",
    kind: "one_time",
    status: "draft",
    sortOrder: 50,
    variants: [
      {
        id: "demo_var_winter_atlas_single",
        sku: "WA-1",
        name: "Single seat",
        priceMinor: 3400n,
        interval: null,
        inventory: null,
        grantId: "demo_grant_winter_atlas_single",
        grant: { kind: "license_key", config: { seats: 1 } },
      },
    ],
  },
  {
    // Archived, not deleted: it was for sale once, and the orders that name it
    // still do.
    id: "demo_prod_summit_poster",
    slug: "summit-poster",
    name: "Summit poster (retired)",
    description:
      "Withdrawn from sale. Archived products stay so old receipts still " +
      "resolve to something.",
    kind: "one_time",
    status: "archived",
    sortOrder: 60,
    variants: [
      {
        id: "demo_var_summit_poster_a2",
        sku: "SP-A2",
        name: "A2, rolled",
        priceMinor: 1800n,
        interval: null,
        inventory: 0,
        grantId: "demo_grant_summit_poster_a2",
        grant: {
          kind: "ship",
          config: { weightGrams: 220, requiresAddress: true },
        },
      },
    ],
  },
];

/**
 * The orders, and the references they are booked under.
 *
 * FIXED REFERENCES, not `simulatedReference()`. The reference becomes
 * `orders.idempotency_key`, so a constant is what makes re-running this script
 * restore three orders instead of adding three more — the same property a
 * redelivered Stripe webhook relies on, exercised here every time you re-seed.
 * The shape has to satisfy `/^sim_[0-9a-f-]{36}$/` or `fulfilPurchase` refuses
 * it before touching the database.
 */
const DEMO_ORDERS: readonly {
  readonly reference: string;
  readonly variantId: string;
  readonly quantity: number;
  readonly what: string;
}[] = [
  {
    reference: "sim_00000000-0000-4000-8000-00000000d001",
    variantId: "demo_var_trail_atlas_single",
    quantity: 1,
    what: "Trail Atlas, Single seat: mints a licence key",
  },
  {
    reference: "sim_00000000-0000-4000-8000-00000000d002",
    variantId: "demo_var_compass_badge_one",
    quantity: 2,
    what: "Brass compass badge x2: books a shipment",
  },
  {
    reference: "sim_00000000-0000-4000-8000-00000000d003",
    variantId: "demo_var_field_notes_monthly",
    quantity: 1,
    what: "Field Notes, Monthly: grants an entitlement",
  },
];

function fail(message: string): never {
  console.error("");
  console.error("SEED REFUSED");
  console.error(message);
  console.error("");
  process.exit(1);
}

/**
 * The same two gates `seed-demo.ts` uses, repeated rather than shared.
 *
 * Importing them would run that script's `main()` as a side effect of loading
 * the module, and moving them to a third file would put a safety gate
 * somewhere neither seed's reader looks. Twelve duplicated lines are the
 * cheaper mistake.
 *
 * Both are needed. `resolveAppEnv()` now recognises every host, so it stops a
 * run from inside any deployment rather than only a Vercel build — but the
 * dangerous case is the ordinary one it cannot see: a developer running this
 * under `tsx` on their own laptop, where "local" is the honest answer, with a
 * `.env.local` that came from `vercel env pull --environment=production`. The
 * app URL is the tell, because it came from the same pull.
 */
function assertLocal(): void {
  const appEnv = resolveAppEnv();
  if (appEnv !== "local") {
    fail(
      `resolveAppEnv() is "${appEnv}". This script writes fictional products ` +
        `and books orders nobody paid for. In a customer's database they are ` +
        `indistinguishable from real ones by the time anyone notices.`,
    );
  }
  if (!pointsAtLocalhost(env.NEXT_PUBLIC_APP_URL)) {
    fail(
      `NEXT_PUBLIC_APP_URL is ${env.NEXT_PUBLIC_APP_URL}, not localhost.\n` +
        `That means .env.local is pointing at a deployed environment — most ` +
        `likely pulled with \`vercel env pull\` — so DATABASE_URL is pointing ` +
        `there too. Restore the local values before running this.`,
    );
  }
}

/**
 * REFUSES ONCE STRIPE IS CONFIGURED, on exactly the condition
 * `checkout.simulate` refuses on.
 *
 * A deployment with a secret key is one that can take money, and booking a
 * `paid` order against it with no payment behind it puts a hole in the ledger
 * that reconciles against nothing. Read from `env` rather than from
 * `isStripeConfigured()` because this process never constructs a Stripe client,
 * and that helper reports what has been constructed.
 */
function assertStripeIsNotConfigured(): void {
  if (env.STRIPE_SECRET_KEY) {
    fail(
      `STRIPE_SECRET_KEY is set, so this deployment can take real payments. ` +
        `The orders below are booked with no payment at all, exactly as the ` +
        `simulated checkout books them — and that path closes the moment ` +
        `Stripe is configured. Use the real checkout with a test card instead.`,
    );
  }
}

async function seedCatalogue(): Promise<void> {
  for (const product of CATALOGUE) {
    await db
      .insert(products)
      .values({
        id: product.id,
        tenantId: STOREFRONT_TENANT_ID,
        slug: product.slug,
        name: product.name,
        description: product.description,
        kind: product.kind,
        status: product.status,
        sortOrder: product.sortOrder,
      })
      // On the id, not on (tenant_id, slug). Both are unique and either would
      // do on a clean database; the id is the one this script controls, so a
      // re-run restores THIS row rather than adopting whatever else has taken
      // the slug in the meantime.
      .onConflictDoUpdate({
        target: products.id,
        set: {
          name: product.name,
          description: product.description,
          kind: product.kind,
          status: product.status,
          sortOrder: product.sortOrder,
          deletedAt: null,
        },
      });

    for (const variant of product.variants) {
      await db
        .insert(productVariants)
        .values({
          id: variant.id,
          productId: product.id,
          sku: variant.sku,
          name: variant.name,
          priceMinor: variant.priceMinor,
          currency: "gbp",
          interval: variant.interval,
          inventory: variant.inventory,
        })
        .onConflictDoUpdate({
          target: productVariants.id,
          set: {
            name: variant.name,
            priceMinor: variant.priceMinor,
            interval: variant.interval,
            // Restored, not left as found. The zero-inventory variant is a
            // fixture, and a previous run's purchase must not quietly turn the
            // sold-out demonstration into an in-stock one.
            inventory: variant.inventory,
          },
        });

      await db
        .insert(productGrants)
        .values({
          id: variant.grantId,
          variantId: variant.id,
          kind: variant.grant.kind,
          config: variant.grant.config,
        })
        // A fixed id, because `product_grants` has no natural unique key.
        // Without one, every re-run would add a second grant to the same
        // variant and one purchase would mint two licence keys.
        .onConflictDoUpdate({
          target: productGrants.id,
          set: { kind: variant.grant.kind, config: variant.grant.config },
        });
    }
  }
}

/**
 * The demo owner's id, or NULL for a guest order.
 *
 * `orders.user_id` is nullable by design — a guest purchase is a first-class
 * case in this scaffold — so a missing demo user is not a reason to refuse.
 */
async function resolveBuyer(): Promise<string | null> {
  const row = await db.query.users.findFirst({
    where: eq(users.id, DEMO_BUYER_ID),
  });
  return row?.id ?? null;
}

async function main(): Promise<void> {
  assertLocal();
  assertStripeIsNotConfigured();

  console.log("");
  console.log("Seeding the shop");
  console.log(`  storefront tenant  ${STOREFRONT_TENANT_ID}`);
  console.log(`  products           ${CATALOGUE.length}`);
  console.log("");

  await seedCatalogue();

  const buyerId = await resolveBuyer();
  if (buyerId === null) {
    console.log(
      "No demo buyer in the users table, so the orders below are booked as " +
        "guest purchases. Run `pnpm db:seed:demo` first to attribute them.",
    );
    console.log("");
  }

  for (const order of DEMO_ORDERS) {
    const result = await fulfilPurchase({
      variantId: order.variantId,
      quantity: order.quantity,
      userId: buyerId,
      tenantId: STOREFRONT_TENANT_ID,
      reference: order.reference,
      source: "simulated",
    });
    const grants =
      result.grants.map((grant) => grant.kind).join(", ") || "nothing";
    console.log(
      `  ${result.created ? "booked " : "existing"} ${result.orderNumber}  ` +
        `${order.what} (grants: ${grants})`,
    );
  }

  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");

  console.log("");
  console.log("Done. The purchase path is walkable now, with no credentials:");
  console.log("");
  console.log(`  ${base}/products`);
  console.log("      four products, one per grant kind");
  console.log(`  ${base}/products/trail-atlas`);
  console.log("      buy it. With no STRIPE_SECRET_KEY the checkout records a");
  console.log("      simulated order and shows you the licence key it minted");
  console.log("");
  console.log("The refusals, which nothing else in the project can show you:");
  console.log(
    `  ${base}/checkout?product=compass-badge&variant=demo_var_compass_badge_pair`,
  );
  console.log("      sold out: inventory is 0, not NULL");
  console.log(
    `  ${base}/checkout?product=winter-atlas&variant=demo_var_winter_atlas_single`,
  );
  console.log("      a draft: the storefront will not resolve it, and the");
  console.log("      procedure behind it refuses with not_for_sale");
  console.log("");
  console.log("Every order above is flagged in the audit log as a sensitive");
  console.log("action, commerce.order.simulated:");
  console.log(`  ${base}/admin/audit?sensitive=1`);
  console.log("");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
