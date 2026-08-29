import { z } from "zod";
import { isHttpUrl, type EnvSource } from "@adminigloo/env";

/**
 * This package's contribution to the environment contract.
 *
 * LOG_LEVEL is NOT here. It lives in `coreServer()` because every project has
 * a log level whether or not it installed this package, and declaring it in
 * both places gives the app two schemas for one variable — spread order
 * decides which default wins, and the two drift the first time one of them
 * gains an enum member.
 *
 * Everything below is optional. An app runs correctly with none of it set:
 * `createLogger` writes to stdout, which every platform we deploy to already
 * collects, and `createMemoryRateLimitStore` covers a single process. Making
 * these required would mean a developer cannot boot the app locally without
 * two vendor accounts, and the reliable outcome of that is a shared `.env`
 * passed around in chat.
 */
export function observabilityServer() {
  return {
    SENTRY_DSN: z
      .string()
      .refine(isHttpUrl, { message: "must be the https DSN URL from Sentry" })
      .optional(),
    UPSTASH_REDIS_REST_URL: z
      .string()
      .refine(isHttpUrl, {
        message:
          "must be the REST URL (https://…upstash.io), not the redis:// connection " +
          "string — the REST client cannot open a TCP connection from an edge runtime",
      })
      .optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
  };
}

/**
 * Optional variables that only work as a set.
 *
 * Named here rather than retyped at the call site so an app cannot check the
 * group and miss a member — which is the same failure the group check exists
 * to catch, one level up.
 */
export const OBSERVABILITY_ENV_GROUPS = {
  sentry: ["SENTRY_DSN"],
  upstash: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
} as const;

export type EnvGroupState = "configured" | "absent" | "partial";

export interface EnvGroupStatus {
  readonly name: string;
  readonly state: EnvGroupState;
  readonly present: readonly string[];
  readonly missing: readonly string[];
  /** Non-null exactly when `state` is "partial". */
  readonly warning: string | null;
}

/**
 * Is an optional group all set, all unset, or half done?
 *
 * WARNS, NEVER THROWS, and the distinction is the whole function. Half
 * configured is the state a deployment is legitimately in for the thirty
 * seconds between pasting the first variable into a dashboard and pasting the
 * second, and refusing to boot there takes production down over a feature that
 * is optional by definition. That argues for tolerance, not for silence:
 * UPSTASH_REDIS_REST_URL shipped without its token means every rate-limit
 * check throws at request time instead — 500s on the endpoints that are
 * supposed to be the protected ones, with nothing at boot to connect them to
 * the missing variable.
 *
 * An empty string counts as absent, matching `emptyStringAsUndefined` in
 * `defineEnv`. Clearing a variable in the Vercel dashboard leaves it present
 * and empty, and treating that as configured is how a group reports itself
 * complete while holding an empty token.
 *
 * A one-member group can never be partial: with nothing else to be
 * inconsistent with, it is either configured or absent.
 */
export function groupComplete(
  name: string,
  keys: readonly string[],
  source: EnvSource = process.env,
): EnvGroupStatus {
  const present: string[] = [];
  const missing: string[] = [];
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) present.push(key);
    else missing.push(key);
  }

  const state: EnvGroupState =
    missing.length === 0 ? "configured" : present.length === 0 ? "absent" : "partial";

  return {
    name,
    state,
    present,
    missing,
    warning:
      state === "partial"
        ? `${name} is half configured: ${present.join(", ")} is set but ` +
          `${missing.join(", ")} is not. The feature is disabled, and any code that ` +
          `assumed the group was complete will fail at request time rather than here.`
        : null,
  };
}

/**
 * Every group this package owns, for one line in the boot log.
 *
 * Returns statuses rather than logging them: this module has no logger, and
 * giving it one would make the environment check depend on the thing whose
 * configuration it is checking.
 */
export function observabilityGroupStatus(
  source: EnvSource = process.env,
): readonly EnvGroupStatus[] {
  return Object.entries(OBSERVABILITY_ENV_GROUPS).map(([name, keys]) =>
    groupComplete(name, keys, source),
  );
}
