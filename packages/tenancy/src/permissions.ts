import type { PermissionMap } from "@adminigloo/permissions";

/**
 * The tenant-scope permissions this package contributes.
 *
 * A plain record, not a catalog: the app spreads this together with every other
 * package's fragment into one `definePermissions("tenant", ...)` call, so there
 * is a single catalog per scope and duplicate keys are caught at boot rather
 * than resolved by whichever spread happened to run last.
 *
 * `defaultFor` names role *template keys* from `TENANT_ROLE_TEMPLATES`, and is
 * applied to system templates only — a client who has customised "Admin" never
 * has their edits overwritten by a catalog upgrade.
 *
 * The keys say `tenant.*` and never change (a key is permanent: stored grants
 * reference it). The labels and descriptions are what an owner reads on the
 * access checklist, so they say "company".
 */
export const tenancyPermissions = {
  "members.view": {
    label: "View members",
    description: "See who belongs to this company.",
    category: "Team",
    // Everyone, including viewers: hiding the member list from people already
    // inside the tenant protects nothing and breaks every "who do I ask" flow.
    defaultFor: ["owner", "admin", "member", "viewer"],
  },
  "members.invite": {
    label: "Invite members",
    description: "Send invitations to join this company.",
    category: "Team",
    defaultFor: ["owner", "admin"],
  },
  "members.remove": {
    label: "Remove members",
    description: "Take away a member's access to this company.",
    category: "Team",
    // Separate from `members.invite` because the blast radius is not
    // comparable: the worst an invite does is add a seat, and removal is how a
    // takeover locks everyone else out.
    defaultFor: ["owner", "admin"],
  },
  "members.role.change": {
    label: "Change roles",
    description: "Change what a member can do here. Never above your own role.",
    category: "Team",
    // Separate from removal: changing a role is how an admin is made, and the
    // rank guard (strictly greater) still applies on top of holding this key.
    defaultFor: ["owner", "admin"],
  },
  "tenant.view": {
    label: "View company",
    description: "See the company's name, web address, branding and details.",
    category: "Company",
    defaultFor: ["owner", "admin", "member", "viewer"],
  },
  "tenant.edit": {
    label: "Edit company",
    description: "Change the company's name, web address, branding and details.",
    category: "Company",
    defaultFor: ["owner", "admin"],
  },
  "tenant.transfer": {
    label: "Transfer ownership",
    description: "Hand ownership of this company to another member.",
    category: "Danger",
    /**
     * SEALED. Transfer hands over the power to remove the previous owner, so
     * it is a complete takeover in one call. Sealing means a template that
     * denies it cannot be reopened for one person "just this once" — the exact
     * request that, granted quietly, leaves no trace of who authorised it.
     */
    sealed: true,
    defaultFor: ["owner"],
  },
  // Billing keys deliberately live in @adminigloo/stripe, not here.
  //
  // This package briefly shipped `billing.view` / `billing.manage` alongside
  // stripe's `billing.portal.open` / `billing.invoices.view` /
  // `billing.refund.issue`. definePermissions only rejects byte-identical keys,
  // so all five coexisted happily and whichever key a given route happened to
  // check decided the answer. `billing.manage` even carried defaultFor:["owner"]
  // while stripe's portal key carried none, so a seeded owner would be told they
  // could change their payment method and then be refused by the portal route.
  // One capability, one key, owned by the package that implements it.
} as const satisfies PermissionMap;

export type TenancyPermission = keyof typeof tenancyPermissions;

/**
 * Staff keys the operator handlers check. create-app declares them in its
 * staff catalog with noun-aware labels ("Suspend and reactivate companies"),
 * and a generator test asserts each one is declared — a key the handlers check
 * that no catalog declares can never be granted, so the screen would refuse
 * everyone with nothing in the access editor to fix it.
 *
 * `staff.tenants.transfer` (hand a company to a new owner) is separate from
 * suspension on purpose: moving ownership is a takeover-shaped act, so an
 * operator who may suspend for non-payment doesn't automatically get it.
 */
export const TENANCY_STAFF_PERMISSION_KEYS = [
  "staff.tenants.view",
  "staff.tenants.suspend",
  "staff.tenants.transfer",
  "staff.people.view",
  "staff.roles.view",
  "staff.roles.manage",
] as const;

export type TenancyStaffPermission = (typeof TENANCY_STAFF_PERMISSION_KEYS)[number];
