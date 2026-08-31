import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { definePermissions, DuplicatePermissionError } from "__SCOPE__/permissions";
import type { Catalog, PermissionRule } from "__SCOPE__/permissions";
import { assertCatalogConformance } from "__SCOPE__/testing/permissions";
import type { ConformanceResult } from "__SCOPE__/testing/permissions";
import { TENANT_ROLE_TEMPLATES, tenancyPermissions } from "__SCOPE__/tenancy";
import { staffCatalog, tenantCatalog } from "@/permissions/catalog";

/**
 * THIS IS THE TEST THAT MAKES RENAMING A PERMISSION SAFE.
 *
 * A permission key is a string in three unrelated places: the catalog that
 * declares it, the `requireTenant("…")` that checks it, and the
 * `role_template_grant` rows that hand it out. Rename it in one and the other
 * two do not break — they resolve to "denied", silently, for everybody, and the
 * first anyone hears about it is a customer saying a button stopped working.
 * There is no stack trace to search for.
 *
 * So this file refuses to take a hand-written list of "keys the app uses". It
 * reads the source tree and extracts every key the code actually checks. Add a
 * `requireStaff("staff.exports.run")` for a key nobody declared and this test
 * fails in the same commit, naming the file and the line.
 */

// src/permissions/__tests__/ -> project root
const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCANNED_DIRS = ["src", "app"];

interface Reference {
  readonly permission: string;
  /** `src/server/routers/_app.ts:24`, so a failure is one click from the fix. */
  readonly where: string;
}

/**
 * A permission check, as it is written.
 *
 * Only string literals are captured. `can(permissionFromInput)` matches the
 * call and yields no key, which is the right answer: a dynamic key cannot be
 * compared against the catalog here, and guessing one from the variable name
 * would report a problem that does not exist.
 *
 * `[^)]*` does not survive a nested call inside the parentheses. That is
 * acceptable — every sanctioned check takes a literal or a variable — and it
 * fails by matching NOTHING rather than by matching the wrong thing. The
 * "finds the checks" test below is what stops a silent nothing.
 */
const CHECK_CALL = /\b(requireTenant|requireStaff|can|canAll|canAny)\(([^)]*)\)/g;
const STRING_LITERAL = /"([^"\n]+)"/g;

function sourceFiles(): readonly string[] {
  return SCANNED_DIRS.flatMap((dir) => {
    const root = join(PROJECT_ROOT, dir);
    if (!existsSync(root)) return [];
    return readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((entry) => /\.tsx?$/.test(entry))
      // Tests write permission keys as fixtures. Feeding this file's own
      // deliberately-invalid keys back in would make it fail on itself.
      .filter((entry) => !entry.includes("__tests__"))
      .map((entry) => join(root, entry));
  });
}

const SOURCE_FILES = sourceFiles();

interface Scan {
  /** From `requireTenant(…)` — must be in the tenant catalog. */
  readonly tenant: readonly Reference[];
  /** From `requireStaff(…)` — must be in the staff catalog. */
  readonly staff: readonly Reference[];
  /**
   * From `can(…)` / `canAll(…)` / `canAny(…)`, where the scope is not visible
   * at the call site. Must exist in one catalog or the other.
   */
  readonly either: readonly Reference[];
}

function scanForChecks(): Scan {
  const tenant: Reference[] = [];
  const staff: Reference[] = [];
  const either: Reference[] = [];

  for (const file of SOURCE_FILES) {
    const source = readFileSync(file, "utf8");
    const path = relative(PROJECT_ROOT, file).replaceAll("\\", "/");

    for (const match of source.matchAll(CHECK_CALL)) {
      const [, fn = "", args = ""] = match;
      const line = source.slice(0, match.index ?? 0).split("\n").length;
      const bucket =
        fn === "requireTenant" ? tenant : fn === "requireStaff" ? staff : either;

      for (const literal of args.matchAll(STRING_LITERAL)) {
        const [, permission] = literal;
        if (permission) bucket.push({ permission, where: `${path}:${line}` });
      }
    }
  }

  return { tenant, staff, either };
}

const scan = scanForChecks();

/**
 * The grants `scripts/seed-roles.ts` writes for one template.
 *
 * Only `allow` rows: a `deny` row is a seal, and a seal grants nothing, so
 * counting one as reachability would report a key as handed out by a template
 * that in fact forbids it.
 */
function seededGrants<TKey extends string>(
  catalog: Catalog<TKey>,
  templateKey: string,
): PermissionRule[] {
  return catalog
    .defaultsFor(templateKey)
    .map((permission) => ({ permission, effect: "allow" as const }));
}

/**
 * Mirrors STAFF_TEMPLATES in scripts/seed-roles.ts.
 *
 * Duplicated on purpose, and the duplication IS the assertion: `defaultFor:
 * ["cs_led"]` is a typo no compiler catches, and it produces a permission that
 * every seeding run skips and every role checklist shows as a permanently
 * unticked box. Comparing the catalog's opinion of which templates exist
 * against the list the seed script actually writes is the only thing that
 * notices.
 */
const STAFF_TEMPLATE_KEYS = ["admin", "cs_lead", "cs_agent"];
const TENANT_TEMPLATE_KEYS = TENANT_ROLE_TEMPLATES.map((template) => template.key);

/**
 * Keys that intentionally reach nobody until an operator grants them by hand.
 *
 * Written down here so an unreachable key is either a recorded decision or a
 * bug — never "probably fine". Check 2 of `assertCatalogConformance` reports
 * every catalog key no template grants, and the money keys below carry no
 * `defaultFor` on purpose, so without this list they report on every run
 * forever. That is how a suite acquires failures people learn to scroll past,
 * and a suite nobody reads catches nothing.
 *
 * ONE LIST FOR BOTH SCOPES, deliberately not two. The exemption records a fact
 * about the capability — "refunds are granted per deployment, by hand" — not
 * about which catalog this project's generator happened to spread the key into.
 * A name the project does not install is inert: `assertCatalogConformance`
 * only ever asks the set about keys the catalog already declares. So the same
 * list serves a project generated with no business model and one generated with
 * all of them, and it does not turn red for a reason that has nothing to do
 * with granting when a package fragment moves scope.
 */
const DELIBERATELY_UNREACHABLE: readonly string[] = [
  // staff. Sealed and granted by no template, so every seeded staff role
  // carries an explicit deny for it. Reading a customer's own screen is not a
  // capability anyone should acquire by being promoted.
  "staff.tenants.impersonate",
  // tenant, from __SCOPE__/stripe. Sealed, and carries no `defaultFor`:
  // refunds move money out of the account and cannot be taken back, so which
  // role may issue one is a decision each deployment makes against its own
  // finance process, not something a fresh install starts already holding.
  "billing.refund.issue",
  // From __SCOPE__/commerce, and a SEPARATE capability from the one above
  // rather than a duplicate of it: this refunds a one-time purchase and is the
  // storefront ops job, that one refunds a subscription invoice and is
  // finance's. Same reasoning, same deliberate absence of a `defaultFor`.
  "orders.refund",
];

/**
 * Every problem, in one message, with the reason the library wrote.
 *
 * Compared against `""` rather than asserted through `result.ok` so that the
 * diff IS the report. A rename breaks all three checks at once, and a test that
 * printed "expected true, got false" would hand back none of the work.
 */
function report(label: string, result: ConformanceResult): string {
  if (result.ok) return "";
  return [
    `${label}: ${result.problems.length} problem(s)`,
    ...result.problems.map(
      (problem) =>
        `  [${problem.kind}] ${problem.permission}\n` +
        `    at ${problem.where}\n` +
        `    ${problem.reason}`,
    ),
  ].join("\n");
}

describe("permission catalog conformance", () => {
  /**
   * Guards every other assertion in this file.
   *
   * If the scanner matches nothing — a refactor renames `requireTenant`, the
   * regex rots, the directory list goes stale — then "every referenced key
   * exists" is vacuously true, and this file goes green forever while checking
   * nothing at all. A silent no-op is worse than a missing test, because it
   * occupies the slot where somebody would otherwise write one.
   */
  it("finds the permission checks in the source tree", () => {
    const found = scan.tenant.length + scan.staff.length + scan.either.length;

    expect(
      found,
      `Scanned ${SOURCE_FILES.length} files under ${SCANNED_DIRS.join(", ")} ` +
        `and found no permission checks. Either the app really gates nothing ` +
        `(unlikely once it has a second feature), or CHECK_CALL no longer ` +
        `matches how checks are written — in which case this whole file is ` +
        `now a no-op.`,
    ).toBeGreaterThan(0);
  });

  it("declares every tenant key the app checks, and grants every key it declares", () => {
    const result = assertCatalogConformance({
      catalog: tenantCatalog,
      referenced: scan.tenant,
      templates: TENANT_TEMPLATE_KEYS.map((key) => ({
        key,
        grants: seededGrants(tenantCatalog, key),
      })),
      deliberatelyUnreachable: DELIBERATELY_UNREACHABLE,
    });

    expect(report("tenant catalog", result)).toBe("");
  });

  it("declares every staff key the app checks, and grants every key it declares", () => {
    const result = assertCatalogConformance({
      catalog: staffCatalog,
      referenced: scan.staff,
      templates: STAFF_TEMPLATE_KEYS.map((key) => ({
        key,
        grants: seededGrants(staffCatalog, key),
      })),
      deliberatelyUnreachable: DELIBERATELY_UNREACHABLE,
    });

    expect(report("staff catalog", result)).toBe("");
  });

  it("declares every key a bare can()/canAll()/canAny() asks for", () => {
    // The scope is not visible at the call site, so either catalog will do —
    // the middleware already decided which set `ctx.can` holds.
    const unknown = scan.either.filter(
      ({ permission }) =>
        !tenantCatalog.has(permission) && !staffCatalog.has(permission),
    );

    expect(
      unknown
        .map(
          ({ permission, where }) =>
            `  "${permission}" at ${where} is in neither catalog, so can() ` +
            `answers false for everyone — a typo and a deleted key look ` +
            `identical from here.`,
        )
        .join("\n"),
    ).toBe("");
  });
});

describe("catalog composition", () => {
  it("keeps the two scopes disjoint", () => {
    const shared = tenantCatalog.keys.filter((key) => staffCatalog.has(key));

    expect(
      shared.join(", "),
      `A key in both scopes cannot be read without knowing which scope the ` +
        `reader meant. Grants are stored per scope, so one string names two ` +
        `different capabilities, and an audit row, a checklist label and a ` +
        `support answer all end up ambiguous. Prefix staff keys with "staff.".`,
    ).toBe("");
  });

  it("keeps each package's own definition of the keys it contributed", () => {
    // A spread lets an app key silently overwrite a package key of the same
    // name; `contributedBy` in catalog.ts is what turns that into a throw at
    // import. This asserts the outcome rather than the mechanism, so it still
    // holds if the guard is ever restructured.
    for (const [key, definition] of Object.entries(tenancyPermissions)) {
      // `undefined` when the key is missing entirely, which fails the same
      // assertion with the same message rather than throwing UnknownPermissionError
      // and hiding which key it was.
      const declared = tenantCatalog.has(key) ? tenantCatalog.get(key) : undefined;

      expect(
        declared?.label,
        `"${key}" resolves to a different definition than the one ` +
          `__SCOPE__/tenancy contributed — an app key of the same name won the ` +
          `spread, and the package's own route now checks a permission that ` +
          `the checklist describes as something else.`,
      ).toBe(definition.label);
    }
  });

  it("refuses two fragments that claim the same key", () => {
    const fromPackage = { "reports.export": { label: "Export reports" } };
    const fromApp = { "reports.export": { label: "Download the CSV" } };

    expect(() =>
      definePermissions(
        "tenant",
        { ...fromPackage, ...fromApp },
        { contributedBy: [fromPackage, fromApp] },
      ),
    ).toThrow(DuplicatePermissionError);
  });
});

/**
 * The keys sealing has been signed off for, in either scope.
 *
 * Sealing is not a label. A sealed key gets an explicit `deny` row in every
 * template that does not already grant it, and a per-person override CANNOT
 * reopen it — that is the whole mechanism behind "you may not hand this to one
 * person quietly". Adding or removing `sealed: true` therefore changes who can
 * hold a capability without changing a single grant, which is why the set is
 * written down and moving a key in or out has to be a deliberate edit here.
 *
 * SEALED AND `defaultFor` ARE NOT OPPOSITES, and this is the part that reads
 * wrong the first time. `scripts/seed-roles.ts` writes a `deny` row only for
 * the sealed keys a template's own defaults do NOT already include:
 *
 *   const sealed = staffCatalog.keys.filter(
 *     (k) => staffCatalog.isSealed(k) && !staffCatalog.defaultsFor(t.key).includes(k),
 *   );
 *
 * So `catalog.products.publish`, which is sealed AND carries
 * `defaultFor: ["admin"]`, gives the admin template an `allow` row and every
 * other staff template a `deny` row. An admin publishes; a cs_lead is refused;
 * and no per-person override can make that cs_lead a publisher for the
 * afternoon. Sealing says "only a role hands this out", never "nobody has it" —
 * which is why a sealed key with a `defaultFor` is not a contradiction and
 * must not be "fixed" by deleting one of the two.
 *
 * A NAME HERE IS NOT AN ASSERTION THAT THE KEY EXISTS. Which packages
 * contribute depends on what was installed, so a name this project does not
 * declare is simply not checked. What is checked is that nothing seals itself
 * without appearing here, and that nothing here has quietly lost its seal.
 */
const SEALED_BY_DECISION: readonly string[] = [
  // tenant, from __SCOPE__/tenancy. Transfer hands over billing and the power
  // to remove the previous owner: a complete takeover in one call.
  "tenant.transfer",
  // tenant, from __SCOPE__/stripe. Money out of the account, unrecoverable once
  // the refund clears.
  "billing.refund.issue",
  // From __SCOPE__/commerce. The storefront half of the same money path, held
  // by different people from the subscription half.
  "orders.refund",
  // From __SCOPE__/catalog. Publishing is the moment a row stops being a form
  // somebody is filling in and becomes something a card is charged for, and a
  // price with the decimal point in the wrong place is cheaper to prevent than
  // to refund. Granted to `admin` by default and sealed shut for everyone
  // else — see the note above on why those two coexist.
  "catalog.products.publish",
  // staff. Reading a customer's own screen, written to the audit log as
  // sensitive access.
  "staff.tenants.impersonate",
];

/**
 * Where a catalog's seals and the signed-off list disagree, both ways round.
 *
 * Both directions matter and they fail for opposite reasons. A seal nobody
 * recorded means somebody made a capability ungrantable per person as a side
 * effect of adding a key. A recorded key that is no longer sealed means the
 * protection came off: the next seed stops writing its `deny` rows and an
 * override can quietly hand it out again.
 */
function sealingDrift<TKey extends string>(catalog: Catalog<TKey>): string[] {
  const signedOff = new Set(SEALED_BY_DECISION);

  return [
    ...catalog.keys
      .filter((key) => catalog.isSealed(key) && !signedOff.has(key))
      .map(
        (key) =>
          `  ${catalog.scope}: "${key}" is sealed and nobody wrote down why. A ` +
          `seal makes the key ungrantable to one person, so it belongs in ` +
          `SEALED_BY_DECISION with its reason — or the seal belongs off it.`,
      ),
    ...SEALED_BY_DECISION.filter(
      (key) => catalog.has(key) && !catalog.isSealed(key),
    ).map(
      (key) =>
        `  ${catalog.scope}: "${key}" is in SEALED_BY_DECISION but is no longer ` +
        `sealed. The next seed stops writing its deny rows, and a per-person ` +
        `override can hand it out again with nothing to stop it.`,
    ),
  ];
}

describe("sealed keys", () => {
  it("seals exactly the tenant keys we have signed off for", () => {
    expect(sealingDrift(tenantCatalog).join("\n")).toBe("");
  });

  it("seals exactly the staff keys we have signed off for", () => {
    expect(sealingDrift(staffCatalog).join("\n")).toBe("");
  });
});

/**
 * `defaultFor` entries naming a template this catalog's scope does not have.
 *
 * PER SCOPE, and the per-scope part IS the assertion. Checking against the two
 * template ladders merged into one set passes anything that names a template
 * either side ships, and "admin" exists in both — so a package fragment spread
 * into the wrong catalog keeps granting most of its keys to the admin of the
 * wrong ladder and looks entirely healthy. Only its owner-only or
 * cs_agent-only keys reach nobody, and those surface as an anonymous
 * "unreachable" line that reads like a missing default rather than a misplaced
 * package.
 */
function templatesNamedBy<TKey extends string>(
  catalog: Catalog<TKey>,
  known: readonly string[],
): string[] {
  const ladder = new Set(known);

  return catalog.keys.flatMap((key) =>
    (catalog.get(key).defaultFor ?? [])
      .filter((template) => !ladder.has(template))
      .map(
        (template) =>
          `  ${catalog.scope}: ${key} -> defaultFor "${template}", which is not a ` +
          `${catalog.scope} template (${known.join(", ")})`,
      ),
  );
}

describe("role templates", () => {
  it("only names templates of its own scope that the seed script creates", () => {
    const unknown = [
      ...templatesNamedBy(tenantCatalog, TENANT_TEMPLATE_KEYS),
      ...templatesNamedBy(staffCatalog, STAFF_TEMPLATE_KEYS),
    ];

    expect(
      unknown.join("\n"),
      `A defaultFor naming a template nobody seeds grants nothing at all. The ` +
        `permission is never handed out, and the role checklist shows it as a ` +
        `box no role will ever tick.\n` +
        `When every key a package contributes names the OTHER scope's templates, ` +
        `the fragment itself is in the wrong catalog. Fix which catalog ` +
        `src/permissions/catalog.ts spreads it into — not the defaults, because ` +
        `the defaults are the record of which scope the package was written for.`,
    ).toBe("");
  });
});
