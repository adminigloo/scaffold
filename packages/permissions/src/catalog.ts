export type Scope = "staff" | "tenant";
export type Effect = "allow" | "deny";

export interface PermissionDefinition {
  /** Shown in the checklist editor. */
  readonly label: string;
  readonly description?: string;
  /** Groups the checklist. */
  readonly category?: string;
  /**
   * When a role template denies this permission, no per-user override can
   * reopen it. Reserved for capabilities that must never be granted ad hoc:
   * impersonation, bulk PII export, ownership transfer.
   */
  readonly sealed?: boolean;
  /**
   * System template keys that receive this permission when the catalog is
   * seeded or upgraded. Applied to `is_system` templates ONLY — never to a
   * template a client has customised.
   */
  readonly defaultFor?: readonly string[];
}

export type PermissionMap = Record<string, PermissionDefinition>;

export interface Catalog<TKey extends string = string> {
  readonly scope: Scope;
  readonly permissions: Readonly<Record<TKey, PermissionDefinition>>;
  readonly keys: readonly TKey[];
  has(key: string): key is TKey;
  get(key: TKey): PermissionDefinition;
  isSealed(key: string): boolean;
  /** Keys a system template should receive on seed/upgrade. */
  defaultsFor(templateKey: string): readonly TKey[];
  /** Keys grouped by category, for rendering the checklist. */
  byCategory(): ReadonlyMap<string, readonly TKey[]>;
}

export class DuplicatePermissionError extends Error {
  readonly name = "DuplicatePermissionError";
  constructor(scope: Scope, key: string) {
    super(
      `Permission "${key}" is declared twice in the ${scope} catalog. Two packages ` +
        `claim the same key, so one would silently win. Rename one of them.`,
    );
  }
}

export class UnknownPermissionError extends Error {
  readonly name = "UnknownPermissionError";
  constructor(scope: Scope, key: string) {
    super(
      `Permission "${key}" is not in the ${scope} catalog. Either it was removed ` +
        `from a package and stored rows still reference it, or it is a typo. ` +
        `A typo must fail here rather than quietly resolving to denied.`,
    );
  }
}

/**
 * Declare a scope's permission catalog.
 *
 * Packages export plain `PermissionMap` records; the app spreads them into one
 * call per scope, the same composition pattern the env fragments use:
 *
 *   export const tenantCatalog = definePermissions("tenant", {
 *     ...tenancyPermissions,
 *     ...commercePermissions,
 *     "acme.reports.export": { label: "Export reports" },
 *   });
 *   export type TenantPermission = PermissionKeyOf<typeof tenantCatalog>;
 *
 * Spreading silently overwrites a duplicate key, so the guard below re-reads the
 * source records to catch collisions the spread would have hidden.
 */
export function definePermissions<const T extends PermissionMap>(
  scope: Scope,
  permissions: T,
  options: { readonly contributedBy?: readonly PermissionMap[] } = {},
): Catalog<Extract<keyof T, string>> {
  type K = Extract<keyof T, string>;

  if (options.contributedBy) {
    const seen = new Set<string>();
    for (const fragment of options.contributedBy) {
      for (const key of Object.keys(fragment)) {
        if (seen.has(key)) throw new DuplicatePermissionError(scope, key);
        seen.add(key);
      }
    }
  }

  const keys = Object.keys(permissions) as K[];
  const sealed = new Set(keys.filter((k) => permissions[k]?.sealed === true));

  return {
    scope,
    permissions,
    keys,
    has(key): key is K {
      return Object.prototype.hasOwnProperty.call(permissions, key);
    },
    get(key) {
      const def = permissions[key];
      if (!def) throw new UnknownPermissionError(scope, key);
      return def;
    },
    isSealed(key) {
      return sealed.has(key as K);
    },
    defaultsFor(templateKey) {
      return keys.filter((k) => permissions[k]?.defaultFor?.includes(templateKey));
    },
    byCategory() {
      const grouped = new Map<string, K[]>();
      for (const key of keys) {
        const category = permissions[key]?.category ?? "General";
        const bucket = grouped.get(category);
        if (bucket) bucket.push(key);
        else grouped.set(category, [key]);
      }
      return grouped;
    },
  };
}

export type PermissionKeyOf<TCatalog> =
  TCatalog extends Catalog<infer K> ? K : never;
