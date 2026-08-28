export interface TenantRoleTemplate {
  /** Stable key. Referenced by every `defaultFor` in a permission catalog. */
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** Higher outranks lower. Drives the privilege-escalation guard below. */
  readonly rank: number;
}

/**
 * The system templates seeded into `role_template` for every tenant.
 *
 * Ranks are spaced by ten so a template can be inserted between two shipped
 * ones — a "Billing admin" between admin and member, say — without an update
 * that rewrites ranks on rows clients have already been assigned to. Renumbering
 * live rows is how a rank comparison silently changes meaning mid-migration.
 *
 * These carry no permissions of their own. What each one grants comes from the
 * catalog's `defaultFor`, so a package that adds a permission also decides which
 * templates receive it, in one place, instead of here.
 */
export const TENANT_ROLE_TEMPLATES = [
  {
    key: "owner",
    name: "Owner",
    description: "Full control, including billing and ownership transfer.",
    rank: 40,
  },
  {
    key: "admin",
    name: "Admin",
    description: "Runs the organisation day to day. Cannot transfer ownership.",
    rank: 30,
  },
  {
    key: "member",
    name: "Member",
    description: "Does the work. No access to billing or member management.",
    rank: 20,
  },
  {
    key: "viewer",
    name: "Viewer",
    description: "Read-only access.",
    rank: 10,
  },
] as const satisfies readonly TenantRoleTemplate[];

export type TenantRoleTemplateKey = (typeof TENANT_ROLE_TEMPLATES)[number]["key"];

/** The rank of a shipped template, or `undefined` for a key we do not ship. */
export function templateRank(key: string): number | undefined {
  return TENANT_ROLE_TEMPLATES.find((t) => t.key === key)?.rank;
}

/**
 * May an actor of `actorRank` assign, change or remove a template of
 * `targetRank`?
 *
 * STRICTLY GREATER. Equal ranks fail, which is the whole point: two admins who
 * can each demote the other turn a disagreement into a race, and an admin who
 * can edit "admin" can grant themselves whatever that template grants — which
 * is the same rank they already hold, so nothing about the change looks like an
 * escalation in an audit log. Owner-on-owner is the case that actually bites:
 * co-owners removing each other during a founder dispute.
 *
 * The finiteness guard is not defensive noise. Ranks arrive from the database
 * and from `templateRank`, and NaN compares false against everything — so a
 * corrupted rank would already deny here, but it would also deny in the
 * *opposite* direction, which reads as a permissions bug rather than bad data.
 * Rejecting it explicitly keeps "no rank" from ever meaning "no restriction".
 */
export function canManageTemplate(actorRank: number, targetRank: number): boolean {
  if (!Number.isFinite(actorRank) || !Number.isFinite(targetRank)) return false;
  return actorRank > targetRank;
}

/**
 * The same guard, by template key.
 *
 * An unknown key on either side denies. A key that is not in the shipped table
 * is either a typo or a template from a future release; treating it as rank 0
 * would make every actor able to manage it, and treating the *actor's* unknown
 * key as rank 0 is the only reading that fails closed.
 */
export function canManageTemplateKey(actorKey: string, targetKey: string): boolean {
  const actorRank = templateRank(actorKey);
  const targetRank = templateRank(targetKey);
  if (actorRank === undefined || targetRank === undefined) return false;
  return canManageTemplate(actorRank, targetRank);
}
