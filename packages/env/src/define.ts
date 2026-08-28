import { createEnv } from "@t3-oss/env-nextjs";
import type { z } from "zod";
import { resolveAppEnv, type AppEnv, type EnvSource } from "./app-env.js";
import { assertModeBoundKeys } from "./validators.js";

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
>(opts: DefineEnvOptions<TServer, TClient>) {
  const source = opts.source ?? process.env;
  const appEnv: AppEnv = resolveAppEnv(source);

  assertModeBoundKeys(opts.runtimeEnv, appEnv, opts.modeBoundKeys ?? []);

  const skipValidation =
    opts.skipValidation ??
    (source.NODE_ENV === "test" || Boolean(source.SKIP_ENV_VALIDATION));

  return createEnv({
    server: opts.server,
    client: opts.client,
    runtimeEnv: opts.runtimeEnv,
    skipValidation,
    emptyStringAsUndefined: true,
  });
}
