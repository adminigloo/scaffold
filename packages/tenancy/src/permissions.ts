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
 */
export const tenancyPermissions = {
  "members.view": {
    label: "View members",
    description: "See who belongs to this organisation.",
    category: "Team",
    // Everyone, including viewers: hiding the member list from people already
    // inside the tenant protects nothing and breaks every "who do I ask" flow.
    defaultFor: ["owner", "admin", "member", "viewer"],
  },
  "members.invite": {
    label: "Invite members",
    description: "Send invitations to join this organisation.",
    category: "Team",
    defaultFor: ["owner", "admin"],
  },
  "members.remove": {
    label: "Remove members",
    description: "Revoke a member's access to this organisation.",
    category: "Team",
    // Separate from `members.invite` because the blast radius is not
    // comparable: the worst an invite does is add a seat, and removal is how a
    // takeover locks everyone else out.
    defaultFor: ["owner", "admin"],
  },
  "tenant.view": {
    label: "View organisation",
    description: "See the organisation's name, branding and settings.",
    category: "Organisation",
    defaultFor: ["owner", "admin", "member", "viewer"],
  },
  "tenant.edit": {
    label: "Edit organisation",
    description: "Change the organisation's name, slug, branding and settings.",
    category: "Organisation",
    defaultFor: ["owner", "admin"],
  },
  "tenant.transfer": {
    label: "Transfer ownership",
    description: "Hand ownership of this organisation to another member.",
    category: "Danger",
    /**
     * SEALED. Transfer hands over billing and the power to remove the previous
     * owner, so it is a complete takeover in one call. Sealing means a template
     * that denies it cannot be reopened for one person "just this once" — the
     * exact request that, granted quietly, leaves no trace of who authorised it.
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
