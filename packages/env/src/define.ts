import { createEnv } from "@t3-oss/env-nextjs";
import type { z } from "zod";
import { resolveAppEnv, type AppEnv, type EnvSource } from "./app-env.js";
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

export interface DefineEnvOptions<
  TServer extends Record<string, z.ZodType>,
  TClient extends Record<`NEXT_PUBLIC_${string}`, z.ZodType>,
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
   * Skip Zod validation. Exists so CI type-check jobs run without secrets.
   * It does NOT disable the mode assertion — see below.
   */
  skipValidation?: boolean;
  /** Injectable for tests. Defaults to `process.env`. */
  source?: EnvSource;
}

/**
 * Validate the environment at boot. Missing or malformed → the server refuses
 * to start, which is what catches a forgotten Vercel variable before it becomes
 * a runtime bug in staging.
 *
 * ORDER MATTERS. The mode assertion runs FIRST, on the raw values, and is not
 * gated by `skipValidation`. If it were a Zod refinement, `SKIP_ENV_VALIDATION`
 * would switch it off along with everything else — and the one guarantee this
 * package exists to provide is that a live key can never run outside
 * production, with no hand-operated override.
 */
export function defineEnv<
  TServer extends Record<string, z.ZodType>,
  TClient extends Record<`NEXT_PUBLIC_${string}`, z.ZodType>,
>(
  opts: DefineEnvOptions<TServer, TClient>,
): InferEnvSchemas<TServer> & InferEnvSchemas<TClient> {
  const source = opts.source ?? process.env;
  const appEnv: AppEnv = resolveAppEnv(source);

  assertModeBoundKeys(opts.runtimeEnv, appEnv, opts.modeBoundKeys ?? []);

  const skipValidation =
    opts.skipValidation ??
    (source.NODE_ENV === "test" || Boolean(source.SKIP_ENV_VALIDATION));

  // The cast is doing real work and is sound: createEnv genuinely returns a
  // proxy carrying exactly these parsed values. TypeScript cannot prove it
  // while TServer/TClient are still type parameters, and without the cast the
  // whole point of validating types is lost at the first `env.DATABASE_URL`.
  return createEnv({
    server: opts.server,
    client: opts.client,
    runtimeEnv: opts.runtimeEnv,
    skipValidation,
    emptyStringAsUndefined: true,
  }) as unknown as InferEnvSchemas<TServer> & InferEnvSchemas<TClient>;
}
