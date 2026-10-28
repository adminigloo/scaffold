/**
 * social 0.1: WHO MAY SEE AND WRITE A COMPANY'S POSTS. Two keys, on a
 * company's own roles (owner, admin, member, viewer), shaped like every
 * AdminIgloo permission fragment (`label`, `description`, `category`,
 * `defaultFor`) so an app spreads it into its tenant catalog as it is:
 *
 *   social.view    the queue: drafts, what's ready to post, history, the
 *                  posting-session list and the card formats
 *   social.manage  write a post from the business's facts, edit, approve,
 *                  skip, and mark posted with its link
 *
 * Not viewers: drafts are words the business hasn't said yet. Members see
 * them (the person who posts by hand is often one); owners and admins decide
 * what goes out under the business's name. A project where the site posts
 * for itself maps these two onto its own staff keys (create-app:
 * staff.social.view and staff.social.manage).
 */
export interface SocialPermissionDefinition {
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly defaultFor: readonly string[];
}

export const socialPermissions = {
  "social.view": {
    label: "See posts",
    description: "The posts drafted for the business's own social accounts, the ones ready to post, and what was posted, with the list for a posting session.",
    category: "Posts",
    defaultFor: ["owner", "admin", "member"],
  },
  "social.manage": {
    label: "Write and approve posts",
    description: "Write a post from the business's own facts, edit, approve and skip drafts, and mark them posted with their link.",
    category: "Posts",
    defaultFor: ["owner", "admin"],
  },
} as const satisfies Readonly<Record<string, SocialPermissionDefinition>>;

export type SocialPermission = keyof typeof socialPermissions;

export const SOCIAL_PERMISSION_KEYS: readonly SocialPermission[] = Object.keys(socialPermissions) as SocialPermission[];
