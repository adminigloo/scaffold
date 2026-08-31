/**
 * What version of each base package a NEW project installs.
 *
 * Its own module because three things now read it — the generated
 * `package.json`, the generated `adminigloo.json`, and the test that checks it
 * against the workspace — and a table that three callers share should not be
 * buried halfway down the emitter.
 *
 * Hardcoded, and guarded by a test, because the obvious shortcut is wrong in a
 * way that fails silently. Every package sat at `^0.1.0`, and a caret range on
 * a 0.x version means `>=0.1.0 <0.2.0`: the moment @adminigloo/env shipped
 * 0.2.0, a freshly generated project quietly installed the OLD one. Everything
 * resolved, everything built, and the feature the release added simply was not
 * there.
 *
 * WHAT THIS MUST BE IN STEP WITH IS THE NEXT RELEASE, NOT THE LAST ONE, and
 * that correction is the whole of the second bug. The guard used to compare
 * each entry against the version currently in the workspace manifest, which is
 * the version already published — so it went green on a table that was, by
 * construction, one release behind the code the template is written against.
 * @adminigloo/observability sat at 0.1.1 here with a pending `minor` changeset
 * for `createErrorReporter`, an export `src/server/error-reporter.ts` imports
 * on every generated project. A project generated against the registry
 * therefore resolved `^0.1.1`, got a build with no such export, and failed to
 * compile — the same shape of failure the invitations router hit, and a
 * generator that emits projects which cannot build is not a generator.
 *
 * So the rule enforced by `versions.test.ts` is: THE RANGE EMITTED HERE MUST
 * ADMIT THE VERSION THIS COMMIT WILL PUBLISH — the workspace version with every
 * pending `.changeset` applied. A patch bump needs no edit, because a caret
 * already covers it, and demanding one would churn this file on every release
 * for no benefit. A minor bump on a 0.x version needs one, because the caret
 * excludes it precisely as it excluded 0.2.0 above. That distinction is the
 * mechanism: an entry here changes exactly when leaving it alone would break a
 * generated project, and never otherwise.
 *
 * A PIN THAT MOVES AHEAD OF THE REGISTRY IS DELIBERATE. Between writing the
 * changeset and running the release, `pnpm install` in a freshly generated
 * project cannot resolve the range, and CI's end-to-end `generate` job — which
 * installs the PUBLISHED packages — fails until the release lands. That is an
 * honest report rather than a regression: in that window the generator really
 * cannot produce a project that builds, and the alternative is the silence this
 * comment exists to describe. `versions.test.ts` also requires create-app to
 * carry a changeset of its own whenever a pinned package takes a minor bump, so
 * the corrected pin cannot be left sitting unpublished behind one that is.
 */
const PACKAGE_VERSIONS: Readonly<Record<string, string>> = {
  // 0.3.0 for the host-agnostic `resolveAppEnv()`. A project resolving 0.2.x
  // gets the four-line body that failed open — an unlabelled deployment read as
  // somebody's laptop — and `checkout.simulate` refuses to give the shop away
  // on precisely that answer.
  env: "0.3.0",
  db: "0.2.2",
  auth: "0.1.3",
  // 0.3.0: creating a tenant now writes its owner the owner role as a row, and
  // the emitted code calls the export that does it. Owning a tenant conferred
  // nothing before that, so a project on 0.2.x compiles and grants nobody
  // anything.
  tenancy: "0.3.0",
  permissions: "0.1.2",
  // 0.2.0 rather than 0.1.x because `requireTenant(...).input(...)` did not
  // compile before it. `^0.1.0` would resolve to a build a generated project
  // cannot typecheck against.
  trpc: "0.2.0",
  // The same, and the one that was actually broken: `createErrorReporter` ships
  // in 0.2.0 and `src/server/error-reporter.ts` imports it unconditionally, so
  // a project resolving 0.1.x fails to compile on a file every project gets.
  observability: "0.2.1",
  stripe: "0.1.3",
  // 0.2.0 for the variant- and product-name rules. The product builder refuses
  // to start a save that `validateProduct` cannot clear, so a project resolving
  // 0.1.x gets a validator with no opinion about a blank variant name — which
  // is the hole the form used to fall through: it created the product, had
  // `upsertVariant` refuse it, and left a draft with nothing under it.
  catalog: "0.2.0",
  commerce: "0.1.3",
  billing: "0.1.2",
  ai: "0.1.3",
  email: "0.2.1",
  // A devDependency of every generated project rather than a dependency, and
  // it belongs here all the same. `renderPackageJson` spelled `^0.1.1` out
  // inline, which put a fourteenth version in a place no drift test looked at —
  // the exact arrangement the rest of this table exists to replace.
  testing: "0.1.3",
};

export class UnknownPackageVersionError extends Error {
  readonly name = "UnknownPackageVersionError";
  constructor(pkg: string) {
    super(
      `No version recorded for ${pkg}. Add it to PACKAGE_VERSIONS in ` +
        `versions.ts — guessing a range here is how a project silently ` +
        `installs the wrong one.`,
    );
  }
}

/** `@scope/name` -> the caret range a generated project should depend on. */
export function versionRangeFor(scopedName: string): string {
  const bare = scopedName.replace(/^@[^/]+\//, "");
  const version = PACKAGE_VERSIONS[bare];
  if (!version) throw new UnknownPackageVersionError(scopedName);
  return `^${version}`;
}

export function packageVersions(): Readonly<Record<string, string>> {
  return PACKAGE_VERSIONS;
}
