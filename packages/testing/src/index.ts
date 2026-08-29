/**
 * The determinism primitives every area shares. Nothing else lives here.
 *
 * THE AREAS ARE NOT RE-EXPORTED FROM THIS ENTRY, deliberately. Each one is its
 * own subpath — "@adminigloo/testing/db", "/auth", "/permissions", "/stripe",
 * "/factories", "/playwright" — because their runtime costs are not comparable:
 * "/db" loads the Neon driver, "/stripe" loads the Stripe SDK, "/auth" loads
 * svix, and "/permissions" and "/factories" load nothing but plain functions. A
 * barrel that re-exported all six would make a vitest file that wants
 * `withPermissions` pay for all of them, and tsup does not code-split CJS, so
 * the CJS build would inline every one of those graphs into a single file.
 *
 * Types are safe to re-export anywhere: they erase at build time. The rule is
 * about values.
 */
export { deterministicId, fixedTime, slugify, FIXED_NOW } from "./deterministic.js";
export type { Seeded } from "./deterministic.js";
