#!/usr/bin/env node
//
// Is the CI credentials fixture actually well formed?
//
// WHY A FIXTURE NEEDS A TEST. The defect this exists to catch is a value that
// LOOKS right — the correct prefix in front of the wrong shape — and the
// pipeline is the worst possible instrument for finding it. A malformed Clerk
// publishable key costs a full `pnpm install`, a typecheck, a suite and a
// `next build` before anything notices, and then reports itself as a server
// that never answered, forty screens down inside a step that scrolled past.
// The nightly matrix spent days saying that, on all six entries, about a row
// of zeros. This runs in a millisecond and names the variable.
//
// It restates Clerk's rule rather than importing it. `@clerk/shared` exports
// `isPublishableKey`, but this runs against a project that has not been
// installed yet — and in the matrix it runs before `pnpm install` in a
// directory outside the workspace, where there is nothing to import from. The
// rule is four lines and it is stable; a dependency here would be a dependency
// on the thing under test.
//
//   node .github/scripts/check-credentials.mjs <app-dir>

import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = process.argv[2];
if (!app) {
  console.error("usage: node check-credentials.mjs <app-dir>");
  process.exit(2);
}

const path = join(app, ".env.local");
const values = new Map();
for (const line of readFileSync(path, "utf8").split("\n")) {
  // Quotes optional. It used to require them, and a line written without them
  // was silently DROPPED — so removing the quotes from, say, STRIPE_SECRET_KEY
  // would make that variable invisible to every assertion below rather than
  // failing one. A guard that degrades in the passing direction is worse than
  // no guard, because it still reports success.
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match?.[1] === undefined || match[2] === undefined) continue;
  // Strip a surrounding pair of quotes if there is one, now that the pattern no
  // longer consumes them. Only a matched pair: a lone quote is part of a value
  // somebody wrote by hand, and eating it would change what is asserted.
  const raw = match[2].trim();
  const value =
    (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
      ? raw.slice(1, -1)
      : raw;
  values.set(match[1], value);
}

const failures = [];

/**
 * A decoded key, safe to print.
 *
 * The interesting failure decodes to binary — `pk_test_0000…` comes out as
 * seven repeats of one unprintable byte — and pasting that into an annotation
 * gives a reader a row of replacement glyphs to squint at. Anything outside
 * printable ASCII becomes a dot, and the length is stated, so the message says
 * "this is not text" rather than showing something that looks like corruption
 * in the log viewer.
 */
function printable(value) {
  const cleaned = value.replace(/[^\x20-\x7e]/g, ".");
  return `"${cleaned}" (${value.length} chars)`;
}

/**
 * Clerk's own rule, as `@clerk/shared` applies it: exactly three
 * underscore-separated parts, the third being base64 of a DOTTED frontend API
 * host with exactly one `$` at the end. The key encodes the host the browser
 * will be sent to, which is why a prefix on its own proves nothing.
 */
function clerkPublishableKeyFault(key) {
  const parts = key.split("_");
  if (parts.length !== 3 || (parts[0] !== "pk" && parts[0] !== "PK")) {
    return "must be pk_test_<base64> in exactly three underscore-separated parts";
  }
  if (parts[1] !== "test" && parts[1] !== "live") return 'must carry "test" or "live" as its mode';
  let decoded;
  try {
    decoded = Buffer.from(parts[2] ?? "", "base64").toString("utf8");
  } catch {
    return "does not base64-decode at all";
  }
  if (!decoded.endsWith("$")) {
    return `decodes to ${printable(decoded)}, which does not end in "$" — Clerk rejects it with "Publishable key not valid (expected format: pk_test_... or pk_live_...)". The part after pk_test_ must be base64 of the frontend API host, ending in one "$"`;
  }
  const host = decoded.slice(0, -1);
  if (host.includes("$")) return `decodes to ${printable(decoded)}, which carries more than one "$"`;
  if (!host.includes(".")) return `decodes to the host ${printable(host)}, which is not a dotted hostname`;
  return null;
}

const publishable = values.get("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
if (publishable === undefined) {
  // Absent is a fault here rather than a degraded feature. The whole reason CI
  // writes credentials is to exercise the branches that only exist once Clerk
  // is configured; an unset key silently puts the run back on the path that
  // could not see the prerender crash.
  failures.push("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not set, so this run would serve the UNCONFIGURED app");
} else {
  const fault = clerkPublishableKeyFault(publishable);
  if (fault) failures.push(`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ${fault}`);
}

// `defineEnv` asserts key mode on the raw values on every boot, and it is not
// gated by SKIP_ENV_VALIDATION. A fixture carrying a live marker would fail
// every job here with KeyModeMismatchError, and the message would be about
// production credentials rather than about this file.
for (const [name, value] of values) {
  if (value.includes("_live_")) {
    failures.push(`${name} carries a _live_ marker; no CI environment is ever production`);
  }
}

// The prefixes the generated `src/env.ts` asserts through `prefixedSecret`.
// Cheap, and it catches a fixture edited to the wrong provider's key.
const PREFIXES = {
  CLERK_SECRET_KEY: "sk_",
  CLERK_WEBHOOK_SIGNING_SECRET: "whsec_",
  STRIPE_SECRET_KEY: "sk_",
  STRIPE_WEBHOOK_SECRET: "whsec_",
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_",
  RESEND_API_KEY: "re_",
  ANTHROPIC_API_KEY: "sk-ant-",
};
for (const [name, prefix] of Object.entries(PREFIXES)) {
  const value = values.get(name);
  if (value !== undefined && !value.startsWith(prefix)) {
    failures.push(`${name} does not start with "${prefix}", which its env fragment requires`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`::error title=credentials fixture::${failure}`);
  }
  process.exit(1);
}

console.log(`${path}: ${values.size} variables, every one well formed`);
