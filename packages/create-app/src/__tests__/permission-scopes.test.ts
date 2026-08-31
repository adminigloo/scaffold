/**
 * THE ASSERTION THAT MAKES A FOURTH TIME IMPOSSIBLE.
 *
 * A permission key in the wrong catalog is the quietest defect this scaffold
 * produces. `requireStaff("orders.view")` against a key declared for the tenant
 * catalog matches nothing: the feature is invisible to everybody, forever, and
 * nothing throws, nothing logs, and no test in the generated project turns red.
 * It has now happened three times — the catalog keys, then commerce, then
 * billing — and only the first was caught, by accident, when the nav was wired.
 *
 * IT SURVIVED BECAUSE "admin" IS A TEMPLATE IN BOTH LADDERS. The generated
 * project's own conformance test checks `defaultFor` against the templates of
 * the catalog a key ended up in, so a misplaced fragment keeps granting most of
 * its keys to the admin of the wrong ladder and looks entirely healthy. Only
 * the owner-only and cs_agent-only keys reach nobody, and those surface as an
 * anonymous "unreachable key" line that reads like a missing default rather
 * than a package in the wrong catalog. `plans.manage` and
 * `subscriptions.manage` sat like that through a release.
 *
 * So this reads the PACKAGES rather than the generated project. Every fragment
 * `PACKAGE_PERMISSION_FRAGMENTS` names is opened on disk, every `defaultFor` in
 * it is extracted, and every template it names must belong to the ladder of the
 * scope the table declares. `owner`, `member` and `viewer` exist only in
 * `TENANT_ROLE_TEMPLATES`; `cs_lead` and `cs_agent` only in the staff ladder
 * `scripts/seed-roles.ts` seeds. A fragment whose defaults name the other
 * ladder is in the wrong catalog, and the ambiguity of `admin` cannot hide it,
 * because a fragment has to be consistent about which ladder it is written for.
 *
 * A generated project cannot run this check. It only ever sees the merged
 * catalog, by which point the scope decision has already been made and the
 * evidence for what the package intended has been spread away.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertPermissionScopes,
  PACKAGE_PERMISSION_FRAGMENTS,
  PermissionScopeMismatchError,
  renderPermissionsCatalog,
  type PermissionScope,
} from "../emit.js";
import { DEFAULT_ANSWERS, type Answers } from "../answers.js";

const PACKAGES_DIR = join(__dirname, "..", "..", "..");
const TENANCY_TEMPLATES = join(PACKAGES_DIR, "tenancy", "src", "templates.ts");
const SEED_ROLES = join(
  PACKAGES_DIR,
  "create-app",
  "template",
  "scripts",
  "seed-roles.ts",
);

/** Widest answers there are, so every fragment in the table is installed. */
const EVERYTHING: Answers = {
  ...DEFAULT_ANSWERS,
  projectName: "acme",
  businessModel: "both",
  adminShell: "full",
  includeAi: true,
  includeEmail: true,
};

/**
 * The template keys of each ladder, READ FROM THE CODE THAT DEFINES THEM.
 *
 * Retyping them here would make this file agree with itself and with nothing
 * else, which is the failure mode of every hand-copied list: a template renamed
 * in `seed-roles.ts` would leave this test happily validating against a ladder
 * that no longer exists.
 */
async function tenantLadder(): Promise<string[]> {
  const source = await readFile(TENANCY_TEMPLATES, "utf8");
  const block = source.slice(source.indexOf("TENANT_ROLE_TEMPLATES"));
  return [...block.matchAll(/key:\s*"([^"]+)"/g)].flatMap((m) => m[1] ?? []);
}

async function staffLadder(): Promise<string[]> {
  const source = await readFile(SEED_ROLES, "utf8");
  const block = source.slice(source.indexOf("STAFF_TEMPLATES"));
  return [
    ...block.slice(0, block.indexOf("] as const")).matchAll(/key:\s*"([^"]+)"/g),
  ].flatMap((m) => m[1] ?? []);
}

/** `{ "orders.view": ["owner", "admin"] }` for one package's fragment file. */
async function defaultsIn(pkg: string): Promise<Record<string, string[]>> {
  const source = await readFile(
    join(PACKAGES_DIR, pkg, "src", "permissions.ts"),
    "utf8",
  );
  const out: Record<string, string[]> = {};
  let key: string | null = null;

  // Line-oriented on purpose. A parser would be more precise and would also be
  // a second implementation of TypeScript in a test file; what matters here is
  // that a `defaultFor` is attributed to the key above it, and these files are
  // formatted one declaration per line.
  for (const line of source.split("\n")) {
    const declaration = /^\s{2}"([^"]+)":\s*\{/.exec(line);
    if (declaration?.[1]) key = declaration[1];
    const defaults = /defaultFor:\s*\[([^\]]*)\]/.exec(line);
    if (defaults && key) {
      out[key] = [...(defaults[1] ?? "").matchAll(/"([^"]+)"/g)].flatMap(
        (m) => m[1] ?? [],
      );
    }
  }
  return out;
}

describe("every package fragment is declared for the ladder its defaults name", () => {
  it("finds a ladder on both sides", async () => {
    // Guards everything below. Both readers are regexes over source files, and
    // a regex that matches nothing makes every assertion under it vacuously
    // true — a green suite checking the empty set.
    expect(await tenantLadder()).toEqual(
      expect.arrayContaining(["owner", "admin", "member", "viewer"]),
    );
    expect(await staffLadder()).toEqual(
      expect.arrayContaining(["admin", "cs_lead", "cs_agent"]),
    );
  });

  it.each(PACKAGE_PERMISSION_FRAGMENTS.map((f) => [f.package, f] as const))(
    "%s",
    async (_name, fragment) => {
      const ladders: Record<PermissionScope, string[]> = {
        tenant: await tenantLadder(),
        staff: await staffLadder(),
      };
      const ladder = new Set(ladders[fragment.scope]);
      const defaults = await defaultsIn(fragment.package);

      expect(
        Object.keys(defaults).length,
        `no defaultFor found in packages/${fragment.package}/src/permissions.ts ` +
          `— either the file moved or the scan no longer matches it, and this ` +
          `test is now checking nothing for that package`,
      ).toBeGreaterThan(0);

      const wrong = Object.entries(defaults).flatMap(([key, templates]) =>
        templates
          .filter((template) => !ladder.has(template))
          .map(
            (template) =>
              `  ${fragment.binding} is spread into the ${fragment.scope} ` +
              `catalog, and "${key}" grants to "${template}", which is not a ` +
              `${fragment.scope} template (${[...ladder].join(", ")})`,
          ),
      );

      expect(
        wrong.join("\n"),
        `A defaultFor naming a template of the other ladder means the FRAGMENT ` +
          `is in the wrong catalog, not that the default is wrong: the defaults ` +
          `are the record of which scope the package was written for. Move the ` +
          `row in PACKAGE_PERMISSION_FRAGMENTS.`,
      ).toBe("");
    },
  );

  it("names a fragment file that exists for every row", async () => {
    // A typo in `package` would make `defaultsIn` throw rather than pass, but
    // only for the rows the matrix above happens to reach. This is the whole
    // table, once, so a row added for a package with no permissions.ts fails
    // here with a readable path rather than inside a parameterised case.
    for (const fragment of PACKAGE_PERMISSION_FRAGMENTS) {
      const source = await readFile(
        join(PACKAGES_DIR, fragment.package, "src", "permissions.ts"),
        "utf8",
      );
      expect(
        source,
        `packages/${fragment.package}/src/permissions.ts does not export ` +
          `${fragment.binding}`,
      ).toContain(`export const ${fragment.binding} =`);
    }
  });
});

/**
 * The `...binding` names inside one `definePermissions("<scope>", { … })` call.
 *
 * Bounded at the closing brace of the object literal rather than at the end of
 * the file. Slicing from one call to the end reads the OTHER catalog too, and a
 * "not in the staff catalog" assertion written that way passes whatever the
 * generator does.
 */
function spreadsInto(source: string, scope: PermissionScope): string[] {
  const call = new RegExp(
    `definePermissions\\(\\s*"${scope}",\\s*\\{([^}]*)\\}`,
  ).exec(source);
  return [...(call?.[1] ?? "").matchAll(/\.\.\.(\w+)/g)].flatMap((m) => m[1] ?? []);
}

describe("the generated catalog spreads each fragment into its declared scope", () => {
  it("puts the money fragments where their defaults can reach a role", () => {
    // The specific regression. `commercePermissions` and `billingPermissions`
    // were spread into the staff catalog while every default in them named the
    // tenant ladder, so `plans.manage` and `subscriptions.manage` — owner-only —
    // were granted to nobody at all, and twelve more keys named a template the
    // staff ladder does not have.
    const source = renderPermissionsCatalog(EVERYTHING);
    const tenant = spreadsInto(source, "tenant");
    const staff = spreadsInto(source, "staff");

    for (const binding of ["commercePermissions", "billingPermissions"]) {
      expect(tenant, `${binding} belongs in the tenant catalog`).toContain(binding);
      expect(staff, `${binding} must not be in the staff catalog`).not.toContain(
        binding,
      );
    }

    // The other side of the same coin: authoring the shop IS staff work, and
    // moving commerce out must not drag the catalog keys with it.
    expect(staff).toContain("catalogPermissions");
    expect(tenant).not.toContain("catalogPermissions");
  });

  it("holds for every configuration the generator can produce", () => {
    // `renderPermissionsCatalog` runs `assertPermissionScopes` on its own output
    // before returning it, so a mis-grouped fragment throws at generation rather
    // than shipping. This is that guarantee, exercised across the matrix.
    for (const businessModel of ["none", "one-time", "subscription", "both"] as const) {
      for (const includeAi of [true, false]) {
        expect(() =>
          renderPermissionsCatalog({ ...EVERYTHING, businessModel, includeAi }),
        ).not.toThrow();
      }
    }
  });

  it("throws when a fragment is spread into the other catalog", () => {
    // The assertion reads the emitted TEXT, so this can hand it text the table
    // disagrees with — which is exactly the hand-edit it exists to catch, and
    // the reason it is not a comparison of the inputs with themselves.
    expect(() =>
      assertPermissionScopes(
        'export const staffCatalog = definePermissions(\n  "staff",\n' +
          "  { ...billingPermissions, ...appStaffPermissions },\n);",
      ),
    ).toThrow(PermissionScopeMismatchError);
  });

  it("says nothing about the app's own records", () => {
    // `appStaffPermissions` and `appTenantPermissions` are written by this
    // generator into the file itself. They have no package to disagree with, so
    // they are deliberately absent from the table and must not be reported.
    expect(() =>
      assertPermissionScopes(
        'definePermissions(\n  "tenant",\n  { ...appTenantPermissions },\n);',
      ),
    ).not.toThrow();
  });
});
