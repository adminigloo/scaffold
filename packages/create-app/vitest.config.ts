import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Vitest's default is five seconds, which is a budget for a unit test. The
 * generator's tests are not unit tests: several of them run `planEmit` once per
 * configuration, and `planEmit` reads and renders every file in `template/` and
 * every selected overlay from disk. The evidence sweep in capabilities.test.ts
 * sat at 4.98 seconds on a quiet machine and timed out whenever another suite
 * was running beside it — a red suite that says nothing about the generator and
 * everything about how busy the laptop was.
 */
const testTimeout = 30_000;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "generator",
          testTimeout,
          // `template/` and `overlays/` are DATA to this project, not code: the
          // generator reads them as text and renders them. Their .test.ts files
          // still contain unrendered tokens like `__SCOPE__/permissions`, which
          // is not a resolvable package name here and never will be — Vitest's
          // default include would walk into them and fail the generator's own
          // suite on files that are working exactly as intended.
          //
          // The overlay project below runs them instead, with the tokens
          // aliased to the workspace packages they are rendered into.
          exclude: ["**/node_modules/**", "**/dist/**", "template/**", "overlays/**"],
        },
      },
      {
        /**
         * The product builder's own tests, run against workspace source.
         *
         * THEY USED TO RUN NOWHERE. `pnpm test` skipped them as data, and the
         * generated-project job in CI typechecks and builds but does not test —
         * so the whole monorepo suite was green while the admin shipped a form
         * on which no product could ever be published. A test that runs in no
         * pipeline is a comment with assertions in it.
         *
         * The aliases are what the generator's own emit does, as resolution
         * rules: `__SCOPE__` becomes the project's package scope, and `@/`
         * becomes its `src/`. Pointing them at each workspace package's `src`
         * rather than at its built output means a rule added to the catalog
         * package and a form that relies on it are checked against each other
         * in the same run.
         *
         * Scoped to catalog-admin deliberately. An overlay whose tests need a
         * database, a Stripe key or a Next request context does not belong in a
         * project that must pass on a laptop with nothing configured; add
         * another entry here when one of them is ready to.
         */
        resolve: {
          alias: [
            { find: /^__SCOPE__\/catalog$/, replacement: here("../catalog/src/index.ts") },
            {
              find: /^@\/components\/admin\//,
              replacement: here("./overlays/catalog-admin/src/components/admin/"),
            },
            // Reached from storefrontUrl.ts. It lives in the stripe overlay,
            // which is where the storefront itself lives — the admin links to
            // pages it does not own, and the URL rule has to come from the
            // owner or the two drift.
            { find: /^@\/storefront$/, replacement: here("./overlays/stripe/src/storefront.ts") },
          ],
        },
        test: {
          name: "catalog-admin",
          testTimeout,
          include: ["overlays/catalog-admin/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
        },
      },
      {
        /**
         * The storefront's URL rule, run against workspace source.
         *
         * The smallest of the three and the one with the widest blast radius:
         * `productHref` is what the shop window, the product page, the admin's
         * "view on the storefront" link and the seed script's printed URLs all
         * agree on, so a change to it that nothing checks silently 404s four
         * surfaces at once.
         *
         * It is the ONLY file in the stripe overlay that can run here. Its
         * neighbours — `src/server/fulfilment.ts`, the checkout router, the
         * webhook — reach `@/db`, `@/env` and `@/server/routers/_app`, and the
         * last of those does not exist as workspace source at all: the
         * generator RENDERS it, differently per configuration. There is no
         * alias that makes them resolvable here and inventing one would be
         * testing a fiction. They run in a generated project instead, which is
         * why the CI job that generates one now runs its suite —
         * `emitted-tests.test.ts` is what keeps that promise honest for every
         * test file this package ships.
         */
        resolve: {
          alias: [
            { find: /^@\/storefront$/, replacement: here("./overlays/stripe/src/storefront.ts") },
          ],
        },
        test: {
          name: "storefront",
          testTimeout,
          include: ["overlays/stripe/src/__tests__/*.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
        },
      },
      {
        /**
         * The customer account area's decisions, run against workspace source.
         *
         * SAME ARGUMENT AS THE PROJECT ABOVE, and the same reason it is scoped
         * this narrowly. Everything under `/account` is a read of rows
         * `fulfilPurchase` already wrote, so the code that can be wrong is the
         * code that decides what those rows MEAN — a subscription that says
         * "renews" to somebody who cancelled, an unlimited allowance rendered
         * as zero, a shipment row with three NULLs presented as a parcel in
         * transit. None of that is database behaviour and all of it is one
         * wrong branch, which is exactly the shape a suite catches and a build
         * does not.
         *
         * It can run here at all only because those decisions live in
         * `src/account.ts` with no `@/db` import — the queries are in
         * `src/server/account.ts` and are deliberately not covered, since a
         * test with a mocked database would assert the mock's opinion of a
         * WHERE clause, which is the one thing about them that matters and the
         * one thing a mock cannot check. Those are exercised by generating a
         * project and running it.
         */
        resolve: {
          alias: [
            { find: /^__SCOPE__\/billing$/, replacement: here("../billing/src/index.ts") },
            { find: /^@\/account$/, replacement: here("./overlays/account/src/account.ts") },
            {
              find: /^@\/components\/account\//,
              replacement: here("./overlays/account/src/components/account/"),
            },
            // Only ever a `import type { BadgeTone }`, which esbuild erases
            // before resolution — aliased anyway so the day somebody imports a
            // value from the barrel it fails loudly here rather than resolving
            // to nothing.
            { find: /^@\/components\/ui$/, replacement: here("./template/src/components/ui/index.ts") },
          ],
        },
        test: {
          name: "account",
          testTimeout,
          include: ["overlays/account/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
        },
      },
    ],
  },
});
