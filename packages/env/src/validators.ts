import type { AppEnv } from "./app-env.js";

/**
 * Does this URL resolve to the viewer's own machine?
 *
 * On a deployment this is never a harmless default: the app URL is baked into
 * every invitation link, QR code, transactional email, canonical tag and
 * sitemap entry. A staging build carrying `http://localhost:3000` hands every
 * recipient a URL pointing at their own machine, and nothing throws anywhere.
 */
export function pointsAtLocalhost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function isPostgresUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "postgres:" || protocol === "postgresql:";
  } catch {
    return false;
  }
}

/** Neon's pooled endpoint carries `-pooler` in the host. */
export function isPooledPostgresUrl(value: string): boolean {
  if (!isPostgresUrl(value)) return false;
  return new URL(value).hostname.includes("-pooler");
}

// ---------------------------------------------------------------------------
// Key mode binding
// ---------------------------------------------------------------------------

export type KeyMode = "test" | "live";

export class KeyModeMismatchError extends Error {
  readonly name = "KeyModeMismatchError";
  constructor(
    readonly varName: string,
    readonly detected: KeyMode,
    readonly expected: KeyMode,
    readonly appEnv: AppEnv,
  ) {
    super(
      `${varName} is a ${detected.toUpperCase()} key but this is the "${appEnv}" environment, ` +
        `which requires a ${expected.toUpperCase()} key. ` +
        (expected === "live"
          ? "Production must use live credentials."
          : "Only production may carry live credentials — a live key here moves real money.") +
        ` Fix the value in the Vercel ${appEnv === "production" ? "Production" : "Preview"} scope and redeploy.`,
    );
  }
}

export class KeyModeIndeterminateError extends Error {
  readonly name = "KeyModeIndeterminateError";
  constructor(readonly varName: string) {
    super(
      `${varName} is registered as mode-bound but carries neither "_test_" nor "_live_", ` +
        `so its mode cannot be verified. Either the value is malformed, or it should not be ` +
        `listed in modeBoundKeys.`,
    );
  }
}

/** Stripe and Clerk both encode mode as `_test_` / `_live_` inside the key. */
export function detectKeyMode(value: string): KeyMode | null {
  if (value.includes("_live_")) return "live";
  if (value.includes("_test_")) return "test";
  return null;
}

export function expectedKeyMode(appEnv: AppEnv): KeyMode {
  return appEnv === "production" ? "live" : "test";
}

/**
 * Bind a provider key's mode to the deployment it is running on.
 *
 * Deliberately NOT a Zod refinement. `SKIP_ENV_VALIDATION` exists so CI
 * type-check jobs run without secrets, and it switches off the whole Zod pass —
 * which would take this check with it. This runs on the raw value, always,
 * whenever the key is present.
 */
export function assertKeyMode(varName: string, value: string, appEnv: AppEnv): void {
  const detected = detectKeyMode(value);
  if (detected === null) throw new KeyModeIndeterminateError(varName);

  const expected = expectedKeyMode(appEnv);
  if (detected !== expected) {
    throw new KeyModeMismatchError(varName, detected, expected, appEnv);
  }
}

/** Run `assertKeyMode` over every registered key that is actually present. */
export function assertModeBoundKeys(
  source: Record<string, string | undefined>,
  appEnv: AppEnv,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === "") continue;
    assertKeyMode(key, value, appEnv);
  }
}
