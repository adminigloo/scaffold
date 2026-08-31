/**
 * The pin a generated project installs must admit the release this commit makes.
 *
 * THE OLD VERSION OF THIS FILE COMPARED AGAINST THE WRONG THING. It read each
 * package's current `package.json` version and required `PACKAGE_VERSIONS` to
 * equal it — which is the version already on the registry, and therefore always
 * one release behind the source the template is written against. Under
 * changesets, `package.json` does not move when a feature lands; it moves in the
 * release pull request. So a package could gain an export, gain a `minor`
 * changeset, and have the template start importing that export, all while this
 * file stayed green on a pin of `^0.1.1` that excludes the 0.2.0 carrying it.
 *
 * That is not hypothetical and it is not small. `@adminigloo/observability`
 * ships `createErrorReporter` in a pending 0.2.0;
 * `src/server/error-reporter.ts` imports it in every generated project; the pin
 * said `^0.1.1`. A project generated against the registry resolved a build with
 * no such export and did not compile — a generator emitting broken projects,
 * with a full green suite behind it.
 *
 * So the comparison here is against the EFFECTIVE version: the workspace
 * version with every pending `.changeset` applied. And it is a range check
 * rather than an equality check, because a caret already covers a patch. That
 * asymmetry is the point of the whole file:
 *
 *   patch  0.1.1 -> 0.1.2   `^0.1.1` still admits it   no edit needed
 *   minor  0.1.1 -> 0.2.0   `^0.1.1` excludes it       the pin MUST move
 *
 * An entry in `PACKAGE_VERSIONS` therefore changes exactly when leaving it
 * alone would break a generated project, and never merely to keep two numbers
 * looking the same. A test that demands a pointless edit on every release is a
 * test people learn to satisfy without reading.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  packageVersions,
  UnknownPackageVersionError,
  versionRangeFor,
} from "../emit.js";
import { DEFAULT_ANSWERS, packagesFor, type Answers } from "../answers.js";

const PACKAGES_DIR = join(__dirname, "..", "..", "..");
const CHANGESET_DIR = join(PACKAGES_DIR, "..", ".changeset");

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "acme", ...overrides };
}

type Bump = "patch" | "minor" | "major";
const RANK: Record<Bump, number> = { patch: 1, minor: 2, major: 3 };

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseVersion(value: string): Version {
  const [major = 0, minor = 0, patch = 0] = value
    .replace(/^[\^~]/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  return { major, minor, patch };
}

function applyBump(version: Version, bump: Bump | undefined): Version {
  if (bump === undefined) return version;
  if (bump === "major") return { major: version.major + 1, minor: 0, patch: 0 };
  if (bump === "minor") return { major: version.major, minor: version.minor + 1, patch: 0 };
  return { ...version, patch: version.patch + 1 };
}

const show = (v: Version): string => `${v.major}.${v.minor}.${v.patch}`;

/**
 * Does `^base` admit `wanted`?
 *
 * Written out rather than pulled from a semver library because the only ranges
 * this file produces are carets, and the 0.x rule is the entire subject: below
 * 1.0.0 a caret pins the MINOR, so `^0.1.1` is `>=0.1.1 <0.2.0` and `^1.1.1` is
 * `>=1.1.1 <2.0.0`. Getting that rule from a dependency would hide the one line
 * of behaviour this whole module is about.
 */
function caretAdmits(base: Version, wanted: Version): boolean {
  const atLeast =
    wanted.major > base.major ||
    (wanted.major === base.major &&
      (wanted.minor > base.minor ||
        (wanted.minor === base.minor && wanted.patch >= base.patch)));
  if (!atLeast) return false;
  if (base.major > 0) return wanted.major === base.major;
  if (base.minor > 0) return wanted.major === 0 && wanted.minor === base.minor;
  return wanted.major === 0 && wanted.minor === 0;
}

/**
 * The highest bump each package has pending, from the changeset frontmatter.
 *
 * DIRECTLY DECLARED BUMPS ONLY. Changesets also patches the dependents of a
 * bumped package, and a dependent patch is invisible to a caret by definition —
 * modelling it here would be a second implementation of somebody else's release
 * algorithm, kept in step by nothing, in order to predict a number that cannot
 * change the answer.
 */
async function pendingBumps(): Promise<Map<string, Bump>> {
  const bumps = new Map<string, Bump>();
  for (const entry of await readdir(CHANGESET_DIR)) {
    if (!entry.endsWith(".md") || entry === "README.md") continue;
    const source = await readFile(join(CHANGESET_DIR, entry), "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? "";
    for (const line of frontmatter.matchAll(
      /"([^"]+)":\s*(patch|minor|major)/g,
    )) {
      const name = line[1];
      const bump = line[2] as Bump;
      if (!name) continue;
      const bare = name.replace(/^@[^/]+\//, "");
      const held = bumps.get(bare);
      if (!held || RANK[bump] > RANK[held]) bumps.set(bare, bump);
    }
  }
  return bumps;
}

/** The version a package will carry once this commit is released. */
async function effectiveVersions(): Promise<Map<string, Version>> {
  const bumps = await pendingBumps();
  const out = new Map<string, Version>();
  for (const pkg of Object.keys(packageVersions())) {
    const manifest = JSON.parse(
      await readFile(join(PACKAGES_DIR, pkg, "package.json"), "utf8"),
    ) as { version: string };
    out.set(pkg, applyBump(parseVersion(manifest.version), bumps.get(pkg)));
  }
  return out;
}

describe("PACKAGE_VERSIONS against the release this commit makes", () => {
  it("can still find the changeset directory", async () => {
    // Guards every assertion below. If the directory moves or the frontmatter
    // stops parsing, every pending bump silently reads as "none" and this file
    // quietly reverts to the check that missed the observability bug.
    //
    // IT ASKS WHETHER THE DIRECTORY IS THERE, NOT WHETHER ANYTHING IS PENDING.
    // It used to require at least one `.md`, which is true on every commit
    // except the one that matters: `changeset version` CONSUMES the changesets,
    // so the release commit itself has none and this assertion failed on it —
    // a red suite at exactly the moment somebody is deciding whether it is safe
    // to publish. An empty changeset directory is the normal state directly
    // after a release. A MISSING one is the failure worth catching, and
    // `config.json` is the file changesets requires and reads on every command,
    // so it is present whether or not anything is pending.
    const entries = await readdir(CHANGESET_DIR);
    expect(
      entries,
      `no config.json under ${CHANGESET_DIR} — has the directory moved? Every ` +
        `pending bump below would read as "none" and this file would revert ` +
        `to the check that missed the observability bug.`,
    ).toContain("config.json");
  });

  it.each(Object.keys(packageVersions()))(
    "%s: the emitted range admits the version this release publishes",
    async (pkg) => {
      const effective = (await effectiveVersions()).get(pkg);
      expect(effective, `no workspace manifest read for ${pkg}`).toBeDefined();
      const range = versionRangeFor(`@adminigloo/${pkg}`);

      expect(
        caretAdmits(parseVersion(range), effective as Version),
        `${range} does not admit ${show(effective as Version)}, which is what ` +
          `${pkg} will publish once the pending changesets are applied. A ` +
          `generated project would install the previous line and fail to ` +
          `compile against exports that only exist in the new one. Set ` +
          `PACKAGE_VERSIONS.${pkg} to "${show(effective as Version)}".`,
      ).toBe(true);
    },
  );

  it.each(Object.keys(packageVersions()))(
    "%s: is not pinned to a version nobody is going to publish",
    async (pkg) => {
      // The other direction, and the reason the check above is not enough on
      // its own: `^9.9.9` admits nothing and would pass a test that only asked
      // whether the range was wide enough. A pin may be the version in the
      // workspace or the version this release will produce, and nothing else.
      const manifest = JSON.parse(
        await readFile(join(PACKAGES_DIR, pkg, "package.json"), "utf8"),
      ) as { version: string };
      const effective = (await effectiveVersions()).get(pkg) as Version;
      const pinned = packageVersions()[pkg];

      expect(
        [manifest.version, show(effective)],
        `${pkg} is pinned to ${pinned}, which is neither the version in the ` +
          `workspace (${manifest.version}) nor the one the pending changesets ` +
          `produce (${show(effective)}). A range for a version that will never ` +
          `exist fails at pnpm install, in a generated project, on somebody ` +
          `else's machine.`,
      ).toContain(pinned);
    },
  );

  it("ships create-app in the same release as any minor it now requires", async () => {
    // THE ORDERING RULE, and the thing that makes a corrected pin worth
    // anything. Moving `observability` to 0.2.0 here fixes nothing unless
    // create-app is republished carrying the change: the copy already on the
    // registry keeps pinning `^0.1.1`, and every project generated from it goes
    // on installing a release without the exports the template imports.
    //
    // Scoped to minor and major. A patch needs no pin change, so it needs no
    // release of this package either.
    const bumps = await pendingBumps();
    const forcing = Object.keys(packageVersions()).filter((pkg) => {
      const bump = bumps.get(pkg);
      return bump === "minor" || bump === "major";
    });
    if (forcing.length === 0) return;

    expect(
      bumps.get("create-app"),
      `${forcing.join(", ")} take a minor bump in this release, so ` +
        `PACKAGE_VERSIONS had to move — and a pin that moves in a package ` +
        `nobody publishes is a pin that never reaches anyone. Add a changeset ` +
        `for @adminigloo/create-app.`,
    ).toBeDefined();
  });

  it("records a version for every package the generator can install", () => {
    const combos: Answers[] = [
      answers(),
      answers({ businessModel: "one-time" }),
      answers({ businessModel: "subscription" }),
      answers({ businessModel: "both", includeAi: true, includeEmail: true }),
    ];
    for (const a of combos) {
      for (const pkg of packagesFor(a)) {
        expect(() => versionRangeFor(pkg)).not.toThrow();
      }
    }
    // The devDependency too. It is installed by every project and was the one
    // range `renderPackageJson` spelled out inline, where nothing checked it.
    expect(() => versionRangeFor("@adminigloo/testing")).not.toThrow();
  });

  it("emits a caret range, not a bare version", () => {
    expect(versionRangeFor("@adminigloo/env")).toMatch(/^\^\d+\.\d+\.\d+$/);
  });

  it("refuses to guess for a package it does not know", () => {
    expect(() => versionRangeFor("@adminigloo/nonexistent")).toThrow(
      UnknownPackageVersionError,
    );
  });
});

describe("the caret rule this file turns on", () => {
  // `caretAdmits` is the whole argument of versions.ts expressed as ten lines
  // of arithmetic, and every assertion above is only as true as it is. The 0.x
  // cases are the ones that matter: they are why a minor bump forces an edit
  // and a patch does not.
  const admits = (base: string, wanted: string): boolean =>
    caretAdmits(parseVersion(base), parseVersion(wanted));

  it("covers a patch below 1.0.0", () => {
    expect(admits("0.1.1", "0.1.2")).toBe(true);
  });

  it("excludes a minor below 1.0.0, which is the bug this file exists for", () => {
    expect(admits("0.1.1", "0.2.0")).toBe(false);
  });

  it("covers a minor at or above 1.0.0", () => {
    expect(admits("1.1.1", "1.4.0")).toBe(true);
    expect(admits("1.1.1", "2.0.0")).toBe(false);
  });

  it("excludes anything older than the pin", () => {
    expect(admits("0.1.2", "0.1.1")).toBe(false);
  });

  it("pins the patch when the minor is zero", () => {
    expect(admits("0.0.3", "0.0.4")).toBe(true);
    expect(admits("0.0.3", "0.1.0")).toBe(false);
  });
});
