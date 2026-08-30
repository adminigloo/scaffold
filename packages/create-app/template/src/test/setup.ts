import { fileURLToPath } from "node:url";

/** Resolved from this file, not from `process.cwd()`, so running vitest from a
 * subdirectory or from an editor's test runner still finds the same file. */
const ENV_FILE = fileURLToPath(new URL("../../.env.local", import.meta.url));

/**
 * Load .env.local, which Next reads automatically and Vitest does not.
 *
 * Without this, every test sees an empty environment: `describeIntegration`
 * skips every database suite on a machine that has a perfectly good database
 * configured, and a Stripe or Clerk test that worked under `next dev` fails
 * here for a reason that has nothing to do with the code it is testing.
 *
 * `process.loadEnvFile` rather than dotenv — one fewer dependency, and it has
 * the precedence that matters: a variable ALREADY in the environment wins over
 * the file. So CI's DATABASE_URL is not quietly replaced by whatever stale
 * value a developer left in a committed-by-accident .env.local.
 *
 * Exported as well as called, so a script that needs the same variables can
 * call it rather than growing its own copy or a `--env-file` flag that then
 * disagrees with this one about the path.
 */
export function loadLocalEnv(): void {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // Missing, unreadable, or malformed. Not an error: unit tests need nothing
    // from it, and throwing here would make `pnpm test` fail on a fresh clone
    // before a single assertion ran — which is how a suite gets abandoned on
    // day one. Anything that genuinely needs a variable fails naming it.
  }
}

loadLocalEnv();
