import { createEnv } from "@t3-oss/env-nextjs";
import type { z } from "zod";
import { isDeployed, resolveAppEnv, type AppEnv, type EnvSource } from "./app-env.js";
import { assertModeBoundKeys } from "./validators.js";

/**
 * The values a schema record produces once parsed.
 *
 * Needed because the return type of `createEnv` cannot be computed through a
 * generic type parameter: TS defers the mapped type and every variable comes
 * out `unknown`, so `env.DATABASE_URL` is unusable without a cast at every
 * call site. Spelling the result out here is what makes the generated app
 * typecheck.
 */
export type InferEnvSchemas<T extends Record<string, z.ZodType>> = {
  readonly [K in keyof T]: z.output<T[K]>;
};

/**
 * Widen the named keys to `| undefined`.
 *
 * UNCONDITIONALLY — including on production, where nothing is ever relaxed.
 * Whether a key was relaxed turns on `VERCEL_ENV`, a runtime fact no type can
 * observe, so a conditional type here would have to guess. Guessing `string`
 * hands the consumer a definite value that is `undefined` on every laptop,
 * which trades a clear boot error for `Cannot read properties of undefined`
 * inside a request handler. A pessimistic type forces the `if (!env.X)` branch
 * that a feature-degrades-locally design needs anyway.
 */
export type OptionalUntilDeployed<T, K extends PropertyKey> = {
  readonly [P in keyof T]: P extends K ? T[P] | undefined : T[P];
};

export interface DefineEnvOptions<
  TServer extends Record<string, z.ZodType>,
  TClient extends Record<`NEXT_PUBLIC_${string}`, z.ZodType>,
  TOptionalKey extends string = never,
> {
  server: TServer;
  client: TClient;
  runtimeEnv: Record<string, string | undefined>;
  /**
   * Variables whose `_test_` / `_live_` mode must match the deployment.
   * Each package contributes its own; the app concatenates them.
   */
  modeBoundKeys?: readonly string[];
  /**
   * Credentials a laptop is allowed to boot without.
   *
   * Locally, a listed variable that is ABSENT disables its feature instead of
   * refusing to start — the point being that nobody should have to open Neon,
   * Clerk and Stripe accounts before `pnpm dev` prints a URL. A listed variable
   * that is PRESENT is still validated in full, and on staging or production
   * the list is ignored entirely.
   *
   * Pass a literal or `as const` array: the element type is what widens the
   * corresponding keys to `| undefined` in the result. A plain `string[]`
   * widens every key, which is correct but blunt.
   */
  optionalUntilDeployed?: readonly TOptionalKey[];
  /**
   * Skip Zod validation. Exists so CI type-check jobs run without secrets.
   * It does NOT disable the mode assertion — see below.
   */
  skipValidation?: boolean;
  /** Injectable for tests. Defaults to `process.env`. */
  source?: EnvSource;
}

/**
 * Replace each listed schema with an optional one.
 *
 * `.optional()` is what makes the malformed case come out right, and it is the
 * reason this is not a presence check: it admits `undefined` and nothing else,
 * so an unset DATABASE_URL disables persistence while a DATABASE_URL pasted
 * with a truncated host still fails at boot. Tolerating the pasted-wrong one
 * would turn a one-line startup error into a connection failure thrown from
 * inside a request handler much later, with nothing pointing back at the typo.
 */
function relaxToOptional<T extends Record<string, z.ZodType>>(
  schemas: T,
  keys: readonly string[],
): T {
  let relaxed: Record<string, z.ZodType> | undefined;
  for (const key of keys) {
    // The list spans both records, so each pass sees keys it does not own —
    // and a key contributed by a package the app did not install owns no
    // schema at all.
    const schema = schemas[key];
    if (schema === undefined) continue;
    relaxed ??= { ...schemas };
    relaxed[key] = schema.optional();
  }
  // Restates what `OptionalUntilDeployed` already declares on the return type:
  // these keys now parse to `| undefined`. The record shape is unchanged.
  return (relaxed ?? schemas) as T;
}

/**
 * Validate the environment at boot. Missing or malformed → the server refuses
 * to start, which is what catches a forgotten Vercel variable before it becomes
 * a runtime bug in staging.
 *
 * ORDER MATTERS. The mode assertion runs FIRST, on the raw values, and is not
 * gated by `skipValidation` or by `optionalUntilDeployed`. If it were a Zod
 * refinement, `SKIP_ENV_VALIDATION` would switch it off along with everything
 * else — and the one guarantee this package exists to provide is that a live
 * key can never run outside production, with no hand-operated override.
 * Listing a key in `optionalUntilDeployed` says it may be ABSENT locally; it
 * never says a present value may be the wrong mode.
 */
export function defineEnv<
  TServer extends Record<string, z.ZodType>,
  TClient extends Record<`NEXT_PUBLIC_${string}`, z.ZodType>,
  TOptionalKey extends string = never,
>(
  opts: DefineEnvOptions<TServer, TClient, TOptionalKey>,
): OptionalUntilDeployed<
  InferEnvSchemas<TServer> & InferEnvSchemas<TClient>,
  TOptionalKey
> {
  const source = opts.source ?? process.env;
  const appEnv: AppEnv = resolveAppEnv(source);

  assertModeBoundKeys(opts.runtimeEnv, appEnv, opts.modeBoundKeys ?? []);

  const skipValidation =
    opts.skipValidation ??
    (source.NODE_ENV === "test" || Boolean(source.SKIP_ENV_VALIDATION));

  // Strictness scales with the environment, and it asks `isDeployed` rather
  // than `appEnv !== "local"`. The two used to be the same question and are no
  // longer: an unlabelled production artefact now resolves to "staging" so that
  // the danger gates close, and keying credentials off that value would refuse
  // to boot `pnpm build` and `pnpm start` on a laptop with nothing configured —
  // both of which set NODE_ENV=production. `isDeployed` is true only where the
  // platform or the operator SAID this is a deployment, which is exactly the
  // case where a missing credential is the forgotten-dashboard-variable bug
  // this package was written to catch rather than a credential nobody has got
  // round to yet. On Vercel the two predicates coincide and nothing changes.
  const optionalUntilDeployed = isDeployed(source)
    ? []
    : (opts.optionalUntilDeployed ?? []);
  const server = relaxToOptional(opts.server, optionalUntilDeployed);
  const client = relaxToOptional(opts.client, optionalUntilDeployed);

  // The cast is doing real work and is sound: createEnv genuinely returns a
  // proxy carrying exactly these parsed values. TypeScript cannot prove it
  // while TServer/TClient are still type parameters, and without the cast the
  // whole point of validating types is lost at the first `env.DATABASE_URL`.
  return createEnv({
    server,
    client,
    runtimeEnv: opts.runtimeEnv,
    skipValidation,
    emptyStringAsUndefined: true,
  }) as unknown as OptionalUntilDeployed<
    InferEnvSchemas<TServer> & InferEnvSchemas<TClient>,
    TOptionalKey
  >;
}
