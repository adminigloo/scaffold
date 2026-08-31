export type AppEnv = "local" | "staging" | "production";

export type EnvSource = Record<string, string | undefined>;

/**
 * Which signal actually answered "where is this running".
 *
 * Exposed because the answer and the confidence in it are different facts, and
 * a setup page that prints only the answer cannot tell an operator that nothing
 * on the box ever said where it was — which is the one state that needs acting
 * on. `unidentified` is not an error; it is a deployment nobody has labelled,
 * and the label is one variable away.
 */
export type AppEnvOrigin =
  /** `VERCEL_ENV`, injected by the platform. Nobody can forge it from the dashboard. */
  | "vercel"
  /** `APP_ENV`, set by whoever deployed this. Host-agnostic, auditable in their own config. */
  | "app-env"
  /**
   * `NODE_ENV` says this is not a production artefact — `development`, `test`,
   * or unset. Set by the toolchain itself, never by a person.
   */
  | "node-env"
  /** A production artefact, and nothing said where it is running. */
  | "unidentified";

export interface AppEnvFacts {
  readonly appEnv: AppEnv;
  readonly origin: AppEnvOrigin;
}

const APP_ENV_VALUES: readonly AppEnv[] = ["local", "staging", "production"];

/**
 * Where this process is running, and which signal said so.
 *
 * *** THIS USED TO READ `VERCEL_ENV` AND NOTHING ELSE, AND IT FAILED OPEN. ***
 *
 * The old body was a four-line switch whose DEFAULT branch was `"local"`. On
 * any host that is not Vercel — Docker, Fly, Railway, Render, ECS, a VPS —
 * there is no `VERCEL_ENV`, so a real production server resolved to "somebody's
 * laptop" and every gate built on "are we deployed?" opened. That was not
 * theoretical: a shop served with `next start` and no Stripe keys minted a
 * licence key against a paid product for free, because the gate meant to close
 * on production asked this function and was told it was on a laptop. The
 * bootstrap admin grant had the same hole from the same line — on a self-hosted
 * deployment it handed staff:admin to whichever stranger signed up first, which
 * is precisely what the "deployed" branch of that grant exists to prevent.
 *
 * PRECEDENCE, HIGHEST FIRST, AND WHY IT IS THIS ORDER.
 *
 *  1. `VERCEL_ENV`. A platform-injected value that no dashboard row can
 *     override, which is what makes the key-mode binding in `assertKeyMode`
 *     non-negotiable on Vercel. It stays at the top so that behaviour on Vercel
 *     is unchanged to the byte: a preview deployment cannot declare itself
 *     production and start accepting live credentials, because the declaration
 *     below is never consulted when the platform has spoken. `development` —
 *     what `vercel dev` sets — is a laptop and is recognised as one. An
 *     unrecognised value falls through rather than mapping to "local": a typo
 *     must not be the permissive answer.
 *
 *  2. `APP_ENV`, exactly "local", "staging" or "production". The host-agnostic
 *     source, because every host has environment variables and none of them has
 *     Vercel's. It is the only way a non-Vercel deployment can be production at
 *     all, and it does not weaken the key-mode binding by an inch: there is no
 *     value of it that lets a live key run somewhere the app then treats as
 *     non-production. `production` demands live keys and closes the dangerous
 *     paths; `staging` and `local` refuse live keys outright. The variable can
 *     only be used to accept MORE accountability, never less.
 *     An unrecognised value falls through, for the reason above.
 *
 *  3. `NODE_ENV`, as the discriminator that needs no configuration.
 *
 * THE DISCRIMINATOR, WHICH IS THE ACTUAL QUESTION. A developer's laptop must be
 * "local" with nothing configured — `pnpm install && pnpm dev` is the whole
 * promise — while a server somebody deployed must not be, and neither one can
 * be asked to set a variable to make that work. The signal that separates them
 * without anybody's help is `NODE_ENV`, because the framework sets it in both
 * directions and a person never does: `next dev` sets `development`, the test
 * runner sets `test`, and `next build` and `next start` set `production`. A
 * laptop running the dev server says "development". A script run under `tsx`
 * says nothing at all. A server serving the built application says
 * "production" on every host that has not already set the variable.
 *
 * THE LIMIT OF THAT, STATED RATHER THAN GLOSSED. Next does NOT override a
 * NODE_ENV it inherits, so `NODE_ENV=development next start` on a real server
 * resolves to "local" and opens the gates a laptop is allowed to have open. An
 * earlier draft of this comment claimed `next start` sets production "whether
 * the operator remembered to or not"; that is false, and it was measured to be
 * false — a served build with an inherited `development` minted a paid order.
 * This function cannot close that case, because the same two values are what a
 * genuine laptop presents and refusing them would break `pnpm dev` on a machine
 * with nothing configured, which is the promise the whole scaffold is built on.
 * What closes it is naming the environment: `APP_ENV` outranks NODE_ENV, so any
 * deployment that says what it is stops depending on this inference at all.
 * Setting `APP_ENV` on every deployment is therefore not belt-and-braces, it is
 * the supported way to be safe off Vercel.
 *
 * So a `NODE_ENV` other than "production" — including unset — is the toolchain
 * saying "this is not a production artefact", and it means local. Anything else
 * is a production artefact that nobody labelled.
 *
 * THE DEFAULT, WHICH IS WHERE THE BUG LIVED. An unlabelled production artefact
 * resolves to `staging`, not `local`. Staging rather than production because
 * staging is the answer that is conservative in BOTH directions at once: it
 * closes everything that keys on "is this a deployment", and it still refuses
 * live credentials, so an environment we could not identify is never allowed to
 * move real money. Defaulting to `production` would close the same gates but
 * would also start REQUIRING live keys on a box we cannot identify, which is
 * the one thing worse than the bug being fixed.
 *
 * Note what this does NOT change: `expectedKeyMode` is "test" for both "local"
 * and "staging", so an unidentified host demanded a test key before this change
 * and demands one after it. The key-mode assertion is identical everywhere;
 * only the gates that were failing open have moved.
 *
 * AND WHY IT DOES NOT BREAK THE ZERO-CREDENTIAL PROMISE. Resolving an
 * unidentified server to "staging" would, on its own, make `defineEnv` demand
 * every deferred credential — so `pnpm build` and `pnpm start` on a laptop with
 * nothing configured would stop booting, since both set NODE_ENV=production.
 * They do not, because credential strictness keys on `isDeployed()` below
 * rather than on this value. Strictness about DANGER defaults to deployed;
 * strictness about CREDENTIALS defaults to deferred. A wrong guess in the first
 * direction gives away money; a wrong guess in the second only refuses to start
 * a laptop.
 */
export function describeAppEnv(source: EnvSource = process.env): AppEnvFacts {
  switch (source.VERCEL_ENV) {
    case "production":
      return { appEnv: "production", origin: "vercel" };
    case "preview":
      return { appEnv: "staging", origin: "vercel" };
    // `vercel dev`. A laptop, said by the platform.
    case "development":
      return { appEnv: "local", origin: "vercel" };
    default:
      break;
  }

  // Trimmed and lowercased because this arrives from a YAML file, a Fly secret
  // or a Dockerfile ENV, all of which carry trailing whitespace nobody can see.
  // `"Production "` naming a different environment from `"production"` is a
  // fault no one would ever find by reading their own config.
  const declared = source.APP_ENV?.trim().toLowerCase();
  if (declared !== undefined && declared.length > 0) {
    const match = APP_ENV_VALUES.find((candidate) => candidate === declared);
    if (match !== undefined) return { appEnv: match, origin: "app-env" };
    // An unrecognised APP_ENV falls through to the discriminator rather than
    // being read as local. `APP_ENV=prod` on a production box must not resolve
    // to the most permissive reading of the operator's intent.
  }

  if (source.NODE_ENV !== "production") {
    return { appEnv: "local", origin: "node-env" };
  }

  return { appEnv: "staging", origin: "unidentified" };
}

/** The deployment this process is running on. See `describeAppEnv`. */
export function resolveAppEnv(source: EnvSource = process.env): AppEnv {
  return describeAppEnv(source).appEnv;
}

/** Which variable decided, or `unidentified` if none did. See `describeAppEnv`. */
export function appEnvOrigin(source: EnvSource = process.env): AppEnvOrigin {
  return describeAppEnv(source).origin;
}

/**
 * Has this been IDENTIFIED as a deployment — by the platform, or by whoever
 * deployed it?
 *
 * Deliberately not the same question as `resolveAppEnv() !== "local"`, and the
 * gap between them is the whole design. `resolveAppEnv` answers "how dangerous
 * may this process be" and fails closed, so an unlabelled production artefact
 * comes back as `staging`. This answers "is a missing credential a mistake, or
 * merely something not done yet", and it fails to the tolerant side, so the
 * same unlabelled artefact comes back `false`.
 *
 * Two different questions, because a wrong answer costs two different things. A
 * gate that guesses wrong about danger hands out paid goods. A credential rule
 * that guesses wrong refuses to boot the laptop of somebody who ran
 * `pnpm build` — and "everything boots with no credentials" is a promise this
 * scaffold makes in writing.
 *
 * On Vercel the two coincide exactly as they always did: `VERCEL_ENV` is either
 * `preview`/`production`, in which case both say deployed, or it is not, in
 * which case both say laptop. Nothing about a Vercel project's behaviour
 * changes. Off Vercel, setting `APP_ENV=staging` or `APP_ENV=production` is
 * what turns deferred credentials into required ones — which is the second
 * reason to set it, and the sentence `/setup` prints when it is missing.
 *
 * What it gates: whether `defineEnv` relaxes `optionalUntilDeployed`, whether
 * `describeEnv` reports a deferred credential as required, and whether `appUrl`
 * refuses a `NEXT_PUBLIC_APP_URL` pointing at localhost.
 */
export function isDeployed(source: EnvSource = process.env): boolean {
  const { appEnv, origin } = describeAppEnv(source);
  return appEnv !== "local" && (origin === "vercel" || origin === "app-env");
}
