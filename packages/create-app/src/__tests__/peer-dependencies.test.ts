/**
 * A peer this generator installs and does not declare is a build that only
 * works by accident.
 *
 * `pino` was one. It is a peerDependency of @adminigloo/observability, which is
 * in the base package set, and `createLogger` imports it at the top of the
 * module — so every generated project reaches it through the tRPC context on
 * every server render. It was absent from the generated `package.json`
 * entirely. It resolved anyway, because pnpm and npm both auto-install peers by
 * default; set `auto-install-peers=false`, as plenty of teams do, and a freshly
 * generated project fails at the first `next build` on a module the app never
 * named.
 *
 * That is a defect of the generator rather than of the package. A peer says
 * "the APP owns this dependency, and every package that needs it will share the
 * app's single copy" — which is precisely the arrangement `drizzle-orm`, `zod`
 * and `@trpc/server` are already in here, all three declared. `pino` was the
 * one nobody noticed, and nothing looked.
 *
 * This walks every package a project can install, in every configuration the
 * CLI can produce, and requires each of their peers to be named in the
 * generated manifest. It reads the workspace manifests rather than a list,
 * because a list is a thing that goes stale on the day somebody adds the peer
 * this test was written to catch.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderPackageJson } from "../emit.js";
import { DEFAULT_ANSWERS, packagesFor, type Answers } from "../answers.js";

const PACKAGES_DIR = join(__dirname, "..", "..", "..");
const REPO_ROOT = join(PACKAGES_DIR, "..");

/**
 * Peers a generated project deliberately does not declare, and why.
 *
 * AN ALLOWLIST WITH REASONS, not a suppression. An undeclared peer is sometimes
 * the right answer, and when it is, that is a decision somebody should have to
 * write down next to the name — the alternative is a test that gets an
 * exception added to it every time it fires, which is a test nobody trusts.
 */
const UNDECLARED_BY_DESIGN: Readonly<Record<string, string>> = {
  "@adminigloo/testing:stripe":
    "@adminigloo/testing is a devDependency of EVERY project, and its `stripe` " +
    "peer is used only by the `@adminigloo/testing/stripe` subpath, as a " +
    "type-only import. No generated test imports that subpath in a project " +
    "with no business model, so nothing fails to build — but with " +
    "auto-install-peers=false the install does print an unmet-peer warning. " +
    "Declaring the Stripe SDK as a dependency of a project that takes no money " +
    "would be the wrong correction; the right one is " +
    "`peerDependenciesMeta: { stripe: { optional: true } }` in that package, " +
    "which is outside this package's remit.",
};

interface Manifest {
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

interface Workspace {
  readonly catalog?: Record<string, string>;
  readonly catalogs?: Record<string, Record<string, string>>;
}

/**
 * `catalog:` and `catalog:peers` resolve to a real range when pnpm packs the
 * tarball, so a consumer never sees the protocol. What matters here is only the
 * NAME, but the ranges are resolved anyway: a `catalog:` entry naming a catalog
 * that does not exist would otherwise pass unnoticed.
 */
async function workspace(): Promise<Workspace> {
  return parse(
    await readFile(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8"),
  ) as Workspace;
}

function resolveRange(range: string, ws: Workspace, name: string): string {
  if (!range.startsWith("catalog:")) return range;
  const which = range.slice("catalog:".length);
  const resolved =
    which === ""
      ? ws.catalog?.[name]
      : (ws.catalogs?.[which] ?? {})[name];
  if (!resolved) {
    throw new Error(
      `${name} is declared as "${range}" and the workspace has no such entry. ` +
        `pnpm would fail to pack the package, and this test would otherwise ` +
        `report a peer with a protocol string for a range.`,
    );
  }
  return resolved;
}

async function peersOf(scopedName: string): Promise<string[]> {
  const bare = scopedName.replace(/^@[^/]+\//, "");
  const manifest = JSON.parse(
    await readFile(join(PACKAGES_DIR, bare, "package.json"), "utf8"),
  ) as Manifest;
  const ws = await workspace();

  return Object.entries(manifest.peerDependencies ?? {})
    // An optional peer is a peer the package explicitly says it can live
    // without, which is a different promise from one it needs and did not get.
    .filter(([name]) => manifest.peerDependenciesMeta?.[name]?.optional !== true)
    .map(([name, range]) => {
      resolveRange(range, ws, name);
      return name;
    });
}

const CONFIGURATIONS = (
  ["none", "one-time", "subscription", "both"] as const
).flatMap((businessModel) =>
  [true, false].flatMap((includeAi) =>
    [true, false].map(
      (includeEmail) =>
        [
          `--model ${businessModel}${includeAi ? " --ai" : ""}${includeEmail ? " --email" : ""}`,
          { businessModel, includeAi, includeEmail },
        ] as const,
    ),
  ),
) as readonly (readonly [string, Partial<Answers>])[];

function answers(overrides: Partial<Answers>): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "acme", ...overrides };
}

describe("a generated project declares every peer of every package it installs", () => {
  it.each(CONFIGURATIONS)("%s", async (_label, overrides) => {
    const a = answers(overrides);
    const generated = JSON.parse(renderPackageJson(a)) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(generated.dependencies),
      ...Object.keys(generated.devDependencies),
    ]);

    // The devDependency as well as the dependencies. It is installed in every
    // project, so its peers are the project's problem exactly like the rest.
    const installed = [...packagesFor(a), `${a.scope}/testing`];
    const missing: string[] = [];
    let checked = 0;

    for (const pkg of installed) {
      for (const peer of await peersOf(pkg)) {
        checked += 1;
        if (declared.has(peer)) continue;
        if (
          Object.prototype.hasOwnProperty.call(
            UNDECLARED_BY_DESIGN,
            `${pkg}:${peer}`,
          )
        ) {
          continue;
        }
        missing.push(
          `  ${pkg} needs "${peer}" and the generated package.json does not ` +
            `name it. It resolves today only because pnpm and npm auto-install ` +
            `peers; with auto-install-peers=false the project does not build.`,
        );
      }
    }

    // Guards the loop: a rename in `packagesFor` or a manifest that stopped
    // declaring peers would make the assertion below vacuously true.
    expect(checked, "no peer dependency found at all — has the scan rotted?").toBeGreaterThan(0);
    expect(missing.join("\n")).toBe("");
  });

  it("keeps the exemption list honest", async () => {
    // An allowlist nobody prunes eventually excuses a peer that is now declared
    // everywhere, and the next genuinely missing one slips in under an entry
    // written for something else. An entry earns its place only while BOTH
    // halves still hold: the package still requires the peer, and there is
    // still at least one configuration that installs the package without it.
    for (const key of Object.keys(UNDECLARED_BY_DESIGN)) {
      const [pkg = "", peer = ""] = key.split(":");

      expect(
        (await peersOf(pkg)).includes(peer),
        `${key} is exempted and ${pkg} no longer requires that peer — delete ` +
          `the entry rather than leaving a reason nobody reads`,
      ).toBe(true);

      const stillBites = CONFIGURATIONS.some(([, overrides]) => {
        const a = answers(overrides);
        if (![...packagesFor(a), `${a.scope}/testing`].includes(pkg)) return false;
        const generated = JSON.parse(renderPackageJson(a)) as {
          dependencies: Record<string, string>;
          devDependencies: Record<string, string>;
        };
        return !(peer in generated.dependencies || peer in generated.devDependencies);
      });

      expect(
        stillBites,
        `${key} is exempted and every configuration that installs ${pkg} now ` +
          `declares ${peer} anyway. The exemption is dead; remove it.`,
      ).toBe(true);
    }
  });

  it("declares pino, which is the one that was missing", async () => {
    // Named, not merely covered by the sweep above. The sweep would go quiet if
    // observability ever stopped declaring the peer, and pino would then be
    // dropped from the manifest by whoever tidied it — while `createLogger`
    // went on importing it.
    for (const [, overrides] of CONFIGURATIONS) {
      const generated = JSON.parse(renderPackageJson(answers(overrides))) as {
        dependencies: Record<string, string>;
      };
      expect(generated.dependencies["pino"], "every project logs").toBeDefined();
    }
    expect(await peersOf("@adminigloo/observability")).toContain("pino");
  });
});
