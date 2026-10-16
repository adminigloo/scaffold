/**
 * This package's permission keys (0.10.0), for the app to spread into its own
 * `definePermissions("tenant", { ... })` call beside the other packages'
 * fragments.
 *
 * TENANT, because each company works its own feedback board: its owner
 * decides who answers customers and who changes the board itself. Three keys
 * because there are three jobs:
 *
 *   feedback.view             see the board, open a ticket and read its
 *                             conversation (everyone in the office)
 *   feedback.manage           answer reporters, move, assign and archive
 *                             tickets (the people who work the board)
 *   feedback.settings.manage  change the columns and categories, and issue or
 *                             switch off website keys (the owner or an admin:
 *                             a revoked key silences the company's website
 *                             widget, and a column change reshapes everyone's
 *                             board)
 *
 * The defaults name the company roles a project seeds (owner, admin, member,
 * viewer). Crew holds none: a crew member opens their route, not the
 * company's customer feedback. A single-business site (and the platform's own
 * board) maps the same keys onto its STAFF keys instead.
 *
 * Every key is under `feedback.*` and nothing else: two packages declaring one
 * key means whichever spread runs last silently wins.
 *
 * Typed structurally, not against @adminigloo/permissions' `PermissionMap`, so
 * this package doesn't depend on the permissions package to describe three
 * strings; `definePermissions` accepts the shape as is.
 */

export interface FeedbackPermissionDefinition {
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly sealed?: boolean;
  readonly defaultFor?: readonly string[];
}

export const feedbackPermissions = {
  "feedback.view": {
    label: "See customer feedback",
    description: "The feedback board: every ticket, what the customer sent, and the conversation on it.",
    category: "Feedback",
    defaultFor: ["owner", "admin", "member", "viewer"],
  },
  "feedback.manage": {
    label: "Answer and sort feedback",
    description: "Reply to customers (they're emailed), move tickets between columns, assign them and archive finished ones.",
    category: "Feedback",
    defaultFor: ["owner", "admin", "member"],
  },
  "feedback.settings.manage": {
    label: "Change feedback settings",
    description: "The board's columns and the categories customers choose from, and the website keys that put the feedback button on your own site.",
    category: "Feedback",
    // Not member: switching off a website key silences the company's own
    // site's feedback button, and a column change reshapes everyone's board.
    defaultFor: ["owner", "admin"],
  },
} as const satisfies Record<string, FeedbackPermissionDefinition>;

export type FeedbackPermission = keyof typeof feedbackPermissions;
