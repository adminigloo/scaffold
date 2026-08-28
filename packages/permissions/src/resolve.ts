import type { Catalog, Effect } from "./catalog.js";

export interface PermissionRule {
  readonly permission: string;
  readonly effect: Effect;
}

export interface ResolveInput {
  /** Rows from `role_template_grant` for the principal's assigned template. */
  readonly templateGrants: readonly PermissionRule[];
  /** Rows from `principal_override` for this principal, scope and tenant. */
  readonly overrides: readonly PermissionRule[];
}

export type DenialReason =
  | "not-granted"
  | "sealed-by-template"
  | "denied-by-override";

export interface Decision {
  readonly allowed: boolean;
  readonly reason: "granted-by-template" | "granted-by-override" | DenialReason;
}

/**
 * Resolve a principal's effective permissions.
 *
 *   1. deny by default          nothing is implicit
 *   2. + template grants        `allow` adds; `deny` SEALS
 *   3. ± per-user overrides     `allow` adds; `deny` removes
 *   4. any deny wins            a sealed key stays denied
 *
 * Because omission already denies, a template rarely needs `deny` rows at all.
 * That frees `deny` to mean something stronger — sealed, and an override cannot
 * reopen it. It is the mechanism for capabilities that must never be handed out
 * one person at a time.
 *
 * Returns a Set, computed once per request. Never a query per check.
 */
export function resolvePermissionSet(input: ResolveInput): ReadonlySet<string> {
  const sealed = new Set<string>();
  const allowed = new Set<string>();

  for (const rule of input.templateGrants) {
    if (rule.effect === "deny") sealed.add(rule.permission);
    else allowed.add(rule.permission);
  }

  for (const rule of input.overrides) {
    if (rule.effect === "allow") allowed.add(rule.permission);
    else allowed.delete(rule.permission);
  }

  // Step 4. A sealed permission is denied no matter what an override said.
  for (const key of sealed) allowed.delete(key);

  return allowed;
}

/**
 * Why a permission resolved the way it did.
 *
 * The admin checklist needs this: "you cannot grant this to one person, the
 * role template seals it" is a very different message from "nobody has granted
 * it yet", and showing the same greyed-out checkbox for both is how support
 * tickets get written.
 */
export function explainPermission(
  permission: string,
  input: ResolveInput,
): Decision {
  const sealedByTemplate = input.templateGrants.some(
    (r) => r.permission === permission && r.effect === "deny",
  );
  if (sealedByTemplate) {
    return { allowed: false, reason: "sealed-by-template" };
  }

  const override = input.overrides.find((r) => r.permission === permission);
  if (override) {
    return override.effect === "allow"
      ? { allowed: true, reason: "granted-by-override" }
      : { allowed: false, reason: "denied-by-override" };
  }

  const granted = input.templateGrants.some(
    (r) => r.permission === permission && r.effect === "allow",
  );
  return granted
    ? { allowed: true, reason: "granted-by-template" }
    : { allowed: false, reason: "not-granted" };
}

export interface PermissionSet<TKey extends string = string> {
  /** Server-resolved answer. The client is handed this, never the rules. */
  can(permission: TKey): boolean;
  canAll(permissions: readonly TKey[]): boolean;
  canAny(permissions: readonly TKey[]): boolean;
  /** Serialisable form, for handing to the browser. */
  toArray(): readonly TKey[];
}

export function createPermissionSet<TKey extends string = string>(
  granted: Iterable<string>,
): PermissionSet<TKey> {
  const set = new Set<string>(granted);
  return {
    can: (permission) => set.has(permission),
    canAll: (permissions) => permissions.every((p) => set.has(p)),
    canAny: (permissions) => permissions.some((p) => set.has(p)),
    toArray: () => [...set] as TKey[],
  };
}

/**
 * Resolve against a catalog, rejecting stored rows that reference permissions
 * the catalog no longer declares.
 *
 * A removed key must fail loudly. If it silently resolved to denied, deleting a
 * permission from a package would quietly revoke access across every client and
 * look like a bug in the app rather than a missing migration.
 */
export function resolveAgainstCatalog(
  catalog: Catalog,
  input: ResolveInput,
): ReadonlySet<string> {
  for (const rule of [...input.templateGrants, ...input.overrides]) {
    if (!catalog.has(rule.permission)) {
      throw new (class extends Error {
        readonly name = "StaleStoredPermissionError";
      })(
        `Stored rule references "${rule.permission}", which is not in the ` +
          `${catalog.scope} catalog. A permission was removed or renamed without a ` +
          `migration rewriting the stored rows.`,
      );
    }
  }
  return resolvePermissionSet(input);
}
