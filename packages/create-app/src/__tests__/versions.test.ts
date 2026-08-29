import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  packageVersions,
  UnknownPackageVersionError,
  versionRangeFor,
} from "../emit.js";
import { DEFAULT_ANSWERS, packagesFor, type Answers } from "../answers.js";

const PACKAGES_DIR = join(__dirname, "..", "..", "..");

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "acme", ...overrides };
}

describe("PACKAGE_VERSIONS must match the workspace", () => {
  // The failure this guards against is silent. A caret range on a 0.x version
  // is `>=0.x.0 <0.(x+1).0`, so leaving a package at ^0.1.0 after it ships
  // 0.2.0 makes a new project install the OLD one. It resolves, it builds, and
  // the feature the release added is simply absent.
  it.each(Object.keys(packageVersions()))(
    "%s is pinned to its current workspace version",
    async (pkg) => {
      const manifest = JSON.parse(
        await readFile(join(PACKAGES_DIR, pkg, "package.json"), "utf8"),
      ) as { version: string };
      expect(packageVersions()[pkg], `update PACKAGE_VERSIONS for ${pkg}`).toBe(
        manifest.version,
      );
    },
  );

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
