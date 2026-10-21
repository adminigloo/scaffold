import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

/** Resolved from this file, like setup.ts, so any runner finds the same file. */
const ENV_FILE = fileURLToPath(new URL("../../.env.local", import.meta.url));

/**
 * Anything that would reach an outside service: a database, a key, a token, a
 * secret. The unit tests never get one of these from .env.local.
 */
const OUTSIDE = /^(DATABASE_URL|POSTGRES_|KV_|UPSTASH_|REDIS_)|SECRET|_KEY$|_KEY_|TOKEN|PASSWORD|WEBHOOK/;

/**
 * The UNIT project's setup: .env.local's plain settings (NEXT_PUBLIC_APP_URL
 * and the like), and none of its keys, so `pnpm test` behaves on a laptop as
 * it does in CI: no database, no network, nothing charged.
 *
 * It used to load the whole file, the same as the integration project. In a
 * project whose .env.local held Stripe test keys (Igloo Back Office), the
 * isolation proof's Connect route then called Stripe for real: a refusal
 * read as a 502, and with Connect switched on it would have made a connected
 * account on every run. The integration project still loads everything
 * (src/test/setup.ts); it needs DATABASE_URL.
 *
 * A variable already in the environment wins, as in setup.ts.
 */
export function loadLocalSettings(): void {
  let text: string;
  try {
    text = readFileSync(ENV_FILE, "utf8");
  } catch {
    // No .env.local: unit tests need nothing from it.
    return;
  }
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (OUTSIDE.test(name) || process.env[name] !== undefined) continue;
    process.env[name] = value;
  }
}

loadLocalSettings();
