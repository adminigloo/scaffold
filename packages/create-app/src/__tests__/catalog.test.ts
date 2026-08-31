/**
 * The workspace catalog and the generated project must agree.
 *
 * `pnpm-workspace.yaml` names one version of `drizzle-orm`, `zod`, `stripe` and
 * `@trpc/server` for the whole workspace, and every published package now says
 * `catalog:` instead of repeating it. That fixes the eleven-edit bump inside the
 * repo and does nothing at all for the generated project, which is not a
 * workspace member and carries its own hardcoded ranges in `emit.ts`.
 *
 * So the bump that used to be eleven edits is now two, and the second one is the
 * one that gets forgotten. Missing it is silent in the worst way: the packages
 * are built and their .d.ts files emitted against the catalog version, the
 * generated app installs a different one, and the mismatch surfaces in a client
 * project as an unreadable structural error between two packages that each look
 * correct on their own.
 *
 * This test is the second edit becoming mandatory.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DEFAULT_ANSWERS, type Answers } from "../answers.js";
import { renderPackageJson } from "../emit.js";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

interface WorkspaceFile {
  readonly catalog?: Record<string, string>;
  readonly catalogs?: Record<string, Record<string, string>>;
}

async function workspace(): Promise<WorkspaceFile> {
  return parse(
    await readFile(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8"),
  ) as WorkspaceFile;
}

/** Widest answers there are, so every optional dependency is present. */
const EVERYTHING: Answers = {
  ...DEFAULT_ANSWERS,
  projectName: "acme",
  businessModel: "both",
  adminShell: "full",
  includeAi: true,
  includeEmail: true,
};

describe("the workspace catalog", () => {
  it("declares a default range and a wider peer range for the same names", async () => {
    // Not a duplicate of each other. The peer range is the compatibility
    // promise made to consumers; the default is the single version this
    // workspace builds and tests against. Collapsing them into one entry would
    // silently narrow every published peer range, which breaks every consumer
    // one patch behind.
    const ws = await workspace();
    expect(ws.catalog).toBeDefined();
    expect(ws.catalogs?.["peers"]).toBeDefined();
    for (const [name, peerRange] of Object.entries(ws.catalogs?.["peers"] ?? {})) {
      expect(ws.catalog?.[name], `${name} missing from the default catalog`).toBeDefined();
      expect(peerRange, `${name} peer range equals the build range`).not.toBe(
        ws.catalog?.[name],
      );
    }
  });

  it("is adopted by every workspace manifest, not half of them", async () => {
    // A catalogued dependency that one package still spells out is a version
    // the catalog no longer controls, and nothing else would notice.
    const ws = await workspace();
    const catalogued = new Set(Object.keys(ws.catalog ?? {}));
    const manifests = ["package.json", ...WORKSPACE_PACKAGES];
    for (const relative of manifests) {
      const pkg = JSON.parse(
        await readFile(join(REPO_ROOT, relative), "utf8"),
      ) as Record<string, Record<string, string> | undefined>;
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
      ] as const) {
        for (const [name, range] of Object.entries(pkg[field] ?? {})) {
          if (!catalogued.has(name)) continue;
          expect(range, `${relative} -> ${field} -> ${name}`).toMatch(/^catalog:/);
        }
      }
    }
  });
});

describe("a generated project installs what the workspace built against", () => {
  it("pins every shared dependency to the catalog range, exactly", async () => {
    const ws = await workspace();
    const generated = JSON.parse(renderPackageJson(EVERYTHING)) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const declared = { ...generated.dependencies, ...generated.devDependencies };

    // Only the names that appear on both sides. The catalog also carries
    // `svix`, which is an internal dependency of @adminigloo/auth and
    // @adminigloo/email and is never installed by the generated app directly.
    const shared = Object.keys(ws.catalog ?? {}).filter((n) => n in declared);
    expect(shared.length, "no shared dependency found — has emit.ts drifted?").toBeGreaterThan(
      0,
    );

    for (const name of shared) {
      expect(declared[name], `emit.ts pins ${name} away from the catalog`).toBe(
        ws.catalog?.[name],
      );
    }
  });

  it("satisfies the peer range of the packages it installs", async () => {
    // The catalog default is always inside the peer range by construction; this
    // fails if somebody widens a peer range without moving the build range, or
    // narrows one past the version everything is built against.
    const ws = await workspace();
    for (const [name, peerRange] of Object.entries(ws.catalogs?.["peers"] ?? {})) {
      const build = ws.catalog?.[name] ?? "";
      const buildMajor = build.replace(/^[\^~]/, "").split(".")[0];
      const peerMajors = peerRange
        .split("||")
        .map((part) => part.trim().replace(/^[\^~>=]+/, "").split(".")[0]);
      expect(peerMajors, `${name}: built against ${build}, peers say ${peerRange}`).toContain(
        buildMajor,
      );
    }
  });
});

/**
 * Listed rather than globbed, so adding a package is a deliberate edit here.
 *
 * A glob would silently start covering a new package, which sounds like an
 * improvement until the day it silently stops — a typo in the pattern makes the
 * assertion vacuous, and a test that checks nothing passes.
 */
const WORKSPACE_PACKAGES: readonly string[] = [
  "packages/ai/package.json",
  "packages/auth/package.json",
  "packages/billing/package.json",
  "packages/catalog/package.json",
  "packages/commerce/package.json",
  "packages/create-app/package.json",
  "packages/db/package.json",
  "packages/email/package.json",
  "packages/env/package.json",
  "packages/observability/package.json",
  "packages/permissions/package.json",
  "packages/stripe/package.json",
  "packages/tenancy/package.json",
  "packages/testing/package.json",
  "packages/trpc/package.json",
];
