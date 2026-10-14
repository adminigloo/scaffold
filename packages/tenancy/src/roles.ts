import { canManageTemplate, TENANT_ROLE_TEMPLATES, type TenantRoleTemplate } from "./templates.js";

/**
 * The company roles a PROJECT offers (Tenancy 2a, D9): Tenancy 1's four, plus
 * whatever its installed packages contribute. Scheduling contributes Crew
 * (`SCHEDULING_CREW_ROLE`): a seasonal mower who opens his own route on a
 * phone and sees nothing else. A generic tenancy never names a field-service
 * role itself; the project composes the set once (create-app's
 * `src/permissions/roles.ts`) and hands it to the service and the seed.
 *
 * Client-safe: no database code here, so a team page can import it.
 */

export interface TenantRoleSet {
  /** The four core templates plus the project's extras, highest rank first. */
  readonly templates: readonly TenantRoleTemplate[];
  readonly keys: readonly string[];
  has(key: string): boolean;
  rankOf(key: string): number | undefined;
  /** `canManageTemplate` on this set's ranks. An unknown key on either side denies. */
  canManage(actorKey: string, targetKey: string): boolean;
  /** Every key an invitation or a role change may carry: all but "owner", highest rank first. */
  readonly assignable: readonly string[];
}

export class InvalidTenantRoleError extends Error {
  readonly name = "InvalidTenantRoleError";
}

/** What a role key looks like on the wire and in a database row. */
export const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

const CORE_KEYS: ReadonlySet<string> = new Set(TENANT_ROLE_TEMPLATES.map((t) => t.key));
const CORE_RANKS: ReadonlySet<number> = new Set(TENANT_ROLE_TEMPLATES.map((t) => t.rank));
const ADMIN_RANK = TENANT_ROLE_TEMPLATES.find((t) => t.key === "admin")!.rank;

/**
 * The core four plus `extra`. Throws `InvalidTenantRoleError` at DEFINITION
 * (at boot, in front of the developer) for a bad spec:
 *
 * - a key not matching /^[a-z][a-z0-9_]{1,31}$/, a core key, or a duplicate;
 * - a rank that isn't a whole number from 1 to 29, that ties a core rank (10
 *   or 20), or that another extra already has;
 * - a name outside 1–40 characters, or a description outside 1–200.
 *
 * WHY BELOW ADMIN. Extras rank below admin (30) so the owner and the admins
 * manage them: an owner who adds a crew member must be able to change or
 * remove them. A TIE would mean two roles that can't manage each other (the
 * rank guard is strictly-greater), which nobody would guess from the team
 * page: a member who couldn't touch a crew member, or the reverse, with no
 * visible reason.
 */
export function defineTenantRoles(extra: readonly TenantRoleTemplate[] = []): TenantRoleSet {
  const seenKeys = new Set<string>();
  const seenRanks = new Set<number>();
  for (const role of extra) {
    const key = typeof role?.key === "string" ? role.key : "";
    if (!ROLE_KEY_PATTERN.test(key)) {
      throw new InvalidTenantRoleError(
        `Role key "${key}" must be 2-32 characters of lowercase letters, digits and underscores, starting with a letter.`,
      );
    }
    if (CORE_KEYS.has(key)) throw new InvalidTenantRoleError(`"${key}" is one of the four core roles; an extra role needs its own key.`);
    if (seenKeys.has(key)) throw new InvalidTenantRoleError(`The role "${key}" is listed twice.`);
    seenKeys.add(key);
    const rank = role.rank;
    if (typeof rank !== "number" || !Number.isInteger(rank) || rank < 1 || rank >= ADMIN_RANK) {
      throw new InvalidTenantRoleError(
        `Role "${key}" has rank ${String(rank)}; an extra role ranks from 1 to ${ADMIN_RANK - 1}, below admin, so the owner and admins can manage it.`,
      );
    }
    if (CORE_RANKS.has(rank)) {
      throw new InvalidTenantRoleError(
        `Role "${key}" has rank ${rank}, the same as a core role; two roles of one rank can't manage each other. Pick a rank between them.`,
      );
    }
    if (seenRanks.has(rank)) throw new InvalidTenantRoleError(`Two extra roles share rank ${rank}; give each its own.`);
    seenRanks.add(rank);
    const name = typeof role.name === "string" ? role.name.trim() : "";
    if (name.length < 1 || name.length > 40) throw new InvalidTenantRoleError(`Role "${key}" needs a name of 1 to 40 characters.`);
    const description = typeof role.description === "string" ? role.description.trim() : "";
    if (description.length < 1 || description.length > 200) {
      throw new InvalidTenantRoleError(`Role "${key}" needs a description of 1 to 200 characters.`);
    }
  }

  const templates: readonly TenantRoleTemplate[] = Object.freeze(
    [...TENANT_ROLE_TEMPLATES, ...extra.map((r) => ({ key: r.key, name: r.name.trim(), description: r.description.trim(), rank: r.rank }))]
      .map((t) => Object.freeze({ ...t }))
      .sort((a, b) => b.rank - a.rank),
  );
  const keys = Object.freeze(templates.map((t) => t.key));
  const ranks = new Map(templates.map((t) => [t.key, t.rank] as const));
  return Object.freeze({
    templates,
    keys,
    has: (key: string) => ranks.has(key),
    rankOf: (key: string) => ranks.get(key),
    canManage(actorKey: string, targetKey: string): boolean {
      const actor = ranks.get(actorKey);
      const target = ranks.get(targetKey);
      if (actor === undefined || target === undefined) return false;
      return canManageTemplate(actor, target);
    },
    assignable: Object.freeze(keys.filter((k) => k !== "owner")),
  });
}

/** `defineTenantRoles([])`: exactly Tenancy 1's roles. */
export const DEFAULT_TENANT_ROLES: TenantRoleSet = defineTenantRoles([]);
