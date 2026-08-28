import { z } from "zod";
import { isDeployed, type EnvSource } from "./app-env.js";
import {
  isHttpUrl,
  isPooledPostgresUrl,
  isPostgresUrl,
  pointsAtLocalhost,
} from "./validators.js";

/**
 * The public origin of this deployment.
 *
 * Refuses localhost on a real deployment. The error names the rebuild
 * requirement because `NEXT_PUBLIC_*` values are inlined at build time —
 * correcting the variable in the dashboard and walking away changes nothing.
 */
export function appUrl(source: EnvSource = process.env) {
  return z
    .string()
    .refine(isHttpUrl, { message: "must be an http(s) URL" })
    .refine((url) => !isDeployed(source) || !pointsAtLocalhost(url), {
      message:
        "points at localhost on a DEPLOYED environment. Set it to that deployment's public " +
        "origin and REDEPLOY — NEXT_PUBLIC_* values are inlined at build time, so changing " +
        "the variable without a rebuild does nothing.",
    });
}

/** Pooled Postgres connection — what the application uses. */
export function pooledPostgresUrl() {
  return z.string().refine(isPooledPostgresUrl, {
    message:
      "must be the POOLED Postgres endpoint (hostname contains '-pooler'). " +
      "The unpooled endpoint belongs in DATABASE_URL_UNPOOLED and is for migrations only.",
  });
}

/** Direct Postgres connection — migrations only; drizzle-kit misbehaves via a pooler. */
export function unpooledPostgresUrl() {
  return z
    .string()
    .refine(isPostgresUrl, { message: "must be a postgres:// URL" })
    .refine((v) => !isPooledPostgresUrl(v), {
      message:
        "must be the UNPOOLED Postgres endpoint. Migrations run against the direct " +
        "connection; a pooled endpoint causes drizzle-kit to hang or misreport state.",
    });
}

/** A secret that must carry a known prefix, e.g. `whsec_` or `re_`. */
export function prefixedSecret(prefix: string, minLength = prefix.length + 8) {
  return z
    .string()
    .min(minLength, { message: `is too short to be a valid ${prefix}… credential` })
    .refine((v) => v.startsWith(prefix), {
      message: `must start with "${prefix}"`,
    });
}

/** A high-entropy secret you generate yourself (cron secrets, peppers, HMAC keys). */
export function generatedSecret(minLength = 32) {
  return z.string().min(minLength, {
    message:
      `must be at least ${minLength} characters. Generate one with: ` +
      `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`,
  });
}
