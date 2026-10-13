/**
 * Install the role templates and their grants on YOUR LAPTOP's database.
 *
 *   pnpm db:seed
 *
 * Idempotent: safe to re-run after adding a permission to the catalog. It only
 * ever touches templates marked `is_system`, never one a client has
 * customised — a catalog upgrade that rewrote a hand-edited template would
 * silently revoke access somebody deliberately granted.
 *
 * The work is `seedPermissions` (src/permissions/seed.ts), the same function
 * the deploy runs: `pnpm db:seed:deploy` runs it after `pnpm
 * db:migrate:deploy` on every deploy to staging and production
 * (.github/workflows/deploy.yml), so a deployed database gets new feature keys
 * without anyone remembering to. This script is the laptop half.
 *
 * BOOTSTRAP_ADMIN_EMAIL, when set in .env.local, is made the first
 * administrator if nobody is one yet. On a laptop that is rarely needed: the
 * first person to open /admin locally becomes one.
 */
import { db } from "../src/db";
import { seedPermissions } from "../src/permissions/seed";

async function main(): Promise<void> {
  await seedPermissions(db, { bootstrapEmail: process.env.BOOTSTRAP_ADMIN_EMAIL ?? null });
  console.log("Done.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
