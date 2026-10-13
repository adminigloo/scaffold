/**
 * Role-template specs and the shipped staff ladder. Client-safe: no tables,
 * no query builder.
 */

/** A role template as shipped in code: what `seedPermissionCatalog` writes. */
export interface RoleTemplateSpec {
  /** Stable key. Referenced by every `defaultFor` in a permission catalog. */
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  /** Higher outranks lower. Drives the privilege-escalation guards. */
  readonly rank: number;
}

/**
 * The internal (platform staff) ladder, moved here from create-app's
 * `scripts/seed-roles.ts` so the seed, the bootstrap and the People screen
 * all read one list.
 *
 * Ranks are spaced by ten, like the tenant templates, so a role can be slotted
 * between two shipped ones without renumbering rows people already hold.
 */
export const STAFF_ROLE_TEMPLATES = [
  {
    key: "admin",
    name: "Administrator",
    description: "Runs the platform: every staff screen, staff roles and settings.",
    rank: 30,
  },
  {
    key: "cs_lead",
    name: "Customer service lead",
    description: "Helps customers and sees their companies and people.",
    rank: 20,
  },
  {
    key: "cs_agent",
    name: "Customer service agent",
    description: "Helps customers day to day.",
    rank: 10,
  },
] as const satisfies readonly RoleTemplateSpec[];

export type StaffRoleTemplateKey = (typeof STAFF_ROLE_TEMPLATES)[number]["key"];

/**
 * Who becomes the first platform administrator (`ensureBootstrapAdmin`).
 *
 *   first-user  local development: whoever is first while no admin exists
 *   email       a deployment: only this (verified) address
 *   off         a deployment with no BOOTSTRAP_ADMIN_EMAIL: nobody automatically
 */
export type BootstrapPolicy =
  | { readonly mode: "first-user" }
  | { readonly mode: "email"; readonly email: string }
  | { readonly mode: "off" };
