import type { PermissionMap } from "@adminigloo/permissions";

/**
 * This package's contribution to the tenant catalog. The app spreads it into
 * its own `definePermissions("tenant", { ... })` call.
 *
 * Scoped to `ai.*`. Nothing here touches `billing.*`, which `@adminigloo/stripe`
 * owns, even though AI spend ends up on the same invoice — two packages
 * declaring one key means whichever spread runs last wins, silently.
 */
export const aiPermissions = {
  "ai.chat.use": {
    label: "Use AI chat",
    description: "Send prompts to the assistant and receive streamed replies.",
    category: "AI",
    // Not `viewer`. Viewer is the read-only template, and every turn of a chat
    // spends money against the tenant's bill — a read-only role that can run up
    // a five-figure invoice is not read-only, it is just unaudited.
    defaultFor: ["owner", "admin", "member"],
  },
  "ai.chat.history.view": {
    label: "View chat history",
    description: "Read past conversations belonging to this organisation.",
    category: "AI",
    // Narrower than `ai.chat.use` on purpose. Prompts are the least redacted
    // text in most products — people paste contracts, customer emails and
    // credentials into them — so reading OTHER members' conversations is a
    // different capability from having your own, however similar the two look
    // in a checklist.
    defaultFor: ["owner", "admin"],
  },
  "ai.config.manage": {
    label: "Manage AI settings",
    description:
      "Choose models, edit system prompts and set spend limits for this organisation.",
    category: "AI",
    // Owner only: the model choice IS the unit price, and the spend limit is
    // the only thing standing between a loop bug and an unbounded bill.
    defaultFor: ["owner"],
  },
} as const satisfies PermissionMap;
