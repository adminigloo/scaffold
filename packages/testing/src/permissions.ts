import {
  createPermissionSet,
  type Catalog,
  type PermissionRule,
  type PermissionSet,
} from "@adminigloo/permissions";

/**
 * A resolved permission set, straight from the keys.
 *
 * A router test needs the ANSWER the resolver produced, not the rows it
 * produced it from, so this skips `role_template_grant` / `principal_override`
 * entirely and hands the procedure a set. No database, no seeding, and the
 * ninety tests that only care about "member cannot refund" stop depending on
 * the shape of two tables they never assert on.
 *
 * `resolvePermissionSet` stays under test in @adminigloo/permissions, where the
 * template/override/seal interaction is the subject. Re-deriving it here would
 * only prove that two copies of the same fold agree.
 *
 * `NoInfer` on the argument so the key type comes from the project's union —
 * `withPermissions<TenantPermission>([...])`, where a misspelled fixture key is
 * a compile error — and never from the two keys this call happened to pass.
 * Inferring from the argument would type the result as
 * `PermissionSet<"members.view">`, and then `set.can("members.remove")` — the
 * negative assertion every permission test is built around — would not compile.
 */
export function withPermissions<TKey extends string = string>(
  keys: Iterable<NoInfer<TKey>>,
): PermissionSet<TKey> {
  return createPermissionSet<TKey>(keys);
}

/**
 * Nothing granted.
 *
 * The state every procedure must be tested against, and the one that gets
 * skipped: a suite that only ever builds an allowed principal proves the happy
 * path and leaves "does the middleware actually run" unasserted — which is
 * exactly the bug a copied procedure introduces, since it looks correct and
 * passes every positive test.
 */
export function denyAll(): PermissionSet {
  return createPermissionSet([]);
}

/**
 * Everything the catalog declares, and nothing else.
 *
 * Takes the catalog rather than returning a set whose `can()` is `() => true`.
 * A blanket-yes double passes for a procedure that checks `"billing.refund"`,
 * because the typo is never compared against anything — and the typo denies in
 * production, where the catalog is real. Grounding the "allow everything" case
 * in the catalog means a misspelled key fails in the test that was supposed to
 * be the easy one.
 */
export function allowAll<TKey extends string>(
  catalog: Catalog<TKey>,
): PermissionSet<TKey> {
  return createPermissionSet<TKey>(catalog.keys);
}

/** A permission key as some part of the app refers to it. */
export type ReferencedPermission =
  | string
  | {
      readonly permission: string;
      /** Where the reference lives: a procedure path, a component, a job. */
      readonly where?: string;
    };

export interface ConformanceTemplate {
  /** `role_template.key`, e.g. `owner`. */
  readonly key: string;
  /**
   * Rows from `role_template_grant`. Pass what the database holds, or
   * `catalog.defaultsFor(key)` mapped to `allow` for a pre-seed check.
   */
  readonly grants: readonly PermissionRule[];
}

export interface StoredOverride {
  readonly permission: string;
  /** For the problem report — which row to go and fix. */
  readonly principalId?: string;
}

export interface CatalogConformanceInput<TKey extends string = string> {
  readonly catalog: Catalog<TKey>;
  /** Every key any `requirePermission` / `.can()` / UI gate names. */
  readonly referenced?: readonly ReferencedPermission[];
  /** The system templates, with the grants they carry. */
  readonly templates?: readonly ConformanceTemplate[];
  /** Rows from `principal_override`, if the check runs against a database. */
  readonly overrides?: readonly StoredOverride[];
  /**
   * Keys that intentionally reach nobody until an operator grants them.
   *
   * `billing.refund.issue` is the shipped example: it is sealed and carries no
   * `defaultFor`, so no template grants it and check 2 would report it forever.
   * Listing it here is the project writing down "yes, refunds are granted by
   * hand per deployment" — which is a decision that should be visible in the
   * repository rather than inferred from the absence of a grant.
   */
  readonly deliberatelyUnreachable?: readonly string[];
}

export type ConformanceProblemKind =
  | "unknown-reference"
  | "unreachable"
  | "stale-template-grant"
  | "stale-override";

export interface ConformanceProblem {
  readonly kind: ConformanceProblemKind;
  readonly permission: string;
  /** The procedure path, template key or principal id that carries it. */
  readonly where: string;
  readonly reason: string;
}

export interface ConformanceResult {
  readonly ok: boolean;
  readonly problems: readonly ConformanceProblem[];
}

/**
 * The conformance check every project runs in CI.
 *
 * Three questions, and each one catches a different half of a rename:
 *
 *   1. Does every permission the code asks for exist in the catalog? A key that
 *      does not exist resolves to denied, so the failure is a 403 on a route
 *      that used to work — reported by a user, weeks later, with no error
 *      anywhere in the logs.
 *   2. Can any template reach every catalog key? A key nobody grants is a
 *      feature that shipped switched off, and the checklist UI shows it as an
 *      unticked box that no role will ever tick.
 *   3. Do the stored rows still reference keys the catalog declares? This is
 *      the other half of the rename — the half that lives in the database and
 *      that a code search cannot find. `resolveAgainstCatalog` already throws
 *      on such a row, so leaving it in place means the next resolution for that
 *      principal fails hard, in a request, in production.
 *
 * RETURNS PROBLEMS, DOES NOT THROW. Renaming a key touches all three at once,
 * and a check that threw on the first one would hand back a third of the work
 * per run — three CI cycles to learn what one could have said. The caller
 * decides what a problem costs; `ok` is there so the caller can assert on one
 * value.
 */
export function assertCatalogConformance<TKey extends string>(
  input: CatalogConformanceInput<TKey>,
): ConformanceResult {
  const { catalog } = input;
  const problems: ConformanceProblem[] = [];

  // 1. Referenced but not declared.
  for (const reference of input.referenced ?? []) {
    const permission =
      typeof reference === "string" ? reference : reference.permission;
    const where =
      typeof reference === "string"
        ? "referenced by the app"
        : (reference.where ?? "referenced by the app");

    if (!catalog.has(permission)) {
      problems.push({
        kind: "unknown-reference",
        permission,
        where,
        reason:
          `"${permission}" is checked by the app but is not in the ` +
          `${catalog.scope} catalog. It resolves to denied for everyone, ` +
          `silently — a typo and a deleted key are indistinguishable from here.`,
      });
    }
  }

  const templates = input.templates ?? [];

  // 2. Declared but unreachable.
  //
  // Only `allow` grants count. A key that appears solely as a `deny` is sealed
  // by every template that mentions it and granted by none, which reads like
  // coverage in a grep and is the strongest possible denial in the resolver.
  const reachable = new Set<string>();
  for (const template of templates) {
    for (const grant of template.grants) {
      if (grant.effect === "allow") reachable.add(grant.permission);
    }
  }

  const exempt = new Set(input.deliberatelyUnreachable ?? []);
  if (templates.length > 0) {
    for (const key of catalog.keys) {
      if (reachable.has(key) || exempt.has(key)) continue;
      problems.push({
        kind: "unreachable",
        permission: key,
        where: `${catalog.scope} catalog`,
        reason:
          `"${key}" is declared but no template grants it, so no role can ever ` +
          `hold it. Add it to a template's grants, give it a \`defaultFor\`, or ` +
          `list it in \`deliberatelyUnreachable\` to record that it is granted ` +
          `by hand.`,
      });
    }
  }

  // 3. Stored rows referencing keys the catalog dropped.
  for (const template of templates) {
    for (const grant of template.grants) {
      if (catalog.has(grant.permission)) continue;
      problems.push({
        kind: "stale-template-grant",
        permission: grant.permission,
        where: `template "${template.key}"`,
        reason:
          `template "${template.key}" grants "${grant.permission}", which the ` +
          `${catalog.scope} catalog no longer declares. ` +
          `resolveAgainstCatalog throws on this row, so every request by anyone ` +
          `holding this template fails until the row is migrated.`,
      });
    }
  }

  for (const override of input.overrides ?? []) {
    if (catalog.has(override.permission)) continue;
    const principal = override.principalId ?? "unknown principal";
    problems.push({
      kind: "stale-override",
      permission: override.permission,
      where: `principal_override for ${principal}`,
      reason:
        `an override for ${principal} references "${override.permission}", which ` +
        `the ${catalog.scope} catalog no longer declares. A code search cannot ` +
        `find this row — the rename needs a migration, not a find-and-replace.`,
    });
  }

  return { ok: problems.length === 0, problems };
}
