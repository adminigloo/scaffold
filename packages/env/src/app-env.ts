export type AppEnv = "local" | "staging" | "production";

export type EnvSource = Record<string, string | undefined>;

/**
 * The deployment this process is running on.
 *
 * DERIVED, never read from an env var of its own. `VERCEL_ENV` is set by the
 * platform and cannot be forged from the dashboard, which is what makes the
 * key-mode binding in `assertKeyMode` non-overridable by hand. Introducing an
 * `APP_ENV` variable would hand that override straight back.
 */
export function resolveAppEnv(source: EnvSource = process.env): AppEnv {
  switch (source.VERCEL_ENV) {
    case "production":
      return "production";
    case "preview":
      return "staging";
    default:
      return "local";
  }
}

/** Is this a real deployment rather than someone's laptop? */
export function isDeployed(source: EnvSource = process.env): boolean {
  return source.VERCEL_ENV === "preview" || source.VERCEL_ENV === "production";
}
