/**
 * This package's permission keys (0.9.0), for the app to spread into its own
 * `definePermissions("tenant", { ... })` beside the other packages' fragments.
 *
 * TENANT keys, because each company has its own assistant. Two jobs:
 *
 *   assistant.use               ask the assistant, see your own conversations,
 *                               and say yes or no to a change it proposes. The
 *                               assistant can only read and propose what the
 *                               person's OWN permissions allow — a member who
 *                               can't see invoices gets no invoice answers.
 *   assistant.settings.manage   write what the assistant knows about the
 *                               business (its profile, FAQs, house rules,
 *                               glossary) and see the month's AI usage.
 *
 * Not `viewer`: every question spends part of the company's monthly AI
 * allowance, and a read-only role that spends money isn't read-only.
 *
 * A single-business site maps the same keys onto its STAFF catalog; the keys
 * are the contract, the defaults a starting point. Typed structurally so the
 * assistant installs without @adminigloo/permissions.
 */

export interface AssistantPermissionDefinition {
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly sealed?: boolean;
  readonly defaultFor?: readonly string[];
}

export const assistantPermissions = {
  "assistant.use": {
    label: "Use the assistant",
    description: "Ask the assistant questions, see your own conversations with it, and confirm the changes it offers to make.",
    category: "Assistant",
    defaultFor: ["owner", "admin", "member"],
  },
  "assistant.settings.manage": {
    label: "Manage the assistant",
    description: "Write what the assistant knows about the business — its profile, answers to common questions, house rules and words — and see this month's AI usage.",
    category: "Assistant",
    defaultFor: ["owner", "admin"],
  },
} as const satisfies Record<string, AssistantPermissionDefinition>;

export type AssistantPermission = keyof typeof assistantPermissions;
