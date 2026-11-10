import type { PermissionMap } from "@adminigloo/permissions";

/**
 * This package's contribution to the STAFF catalog. The app spreads it into
 * its own `definePermissions("staff", { ... })` call, beside catalog's.
 *
 * STAFF ONLY. A person's own balance needs no permission: the account page
 * reads the signed-in person's wallet and nobody else's, and spending happens
 * in the app's own code on the app's own rules. These two keys are for the
 * people who answer "where did my crowns go?" and who can put them back.
 *
 * EVERY KEY IS UNDER `credits.*`. Not `billing.*`, which @adminigloo/stripe
 * owns outright, and not `catalog.*`, which authors what is for sale: selling
 * a pack of credits is the catalog's, holding them afterwards is this
 * package's. `definePermissions` only rejects byte-identical keys, so a borrowed
 * namespace would coexist silently with its owner's keys.
 */
export const walletPermissions = {
  "credits.balances.view": {
    label: "View credit balances",
    description:
      "See every person's balance of each kind of credit, and the ledger of " +
      "what was granted, spent, refunded and adjusted.",
    category: "Credits",
    // Support reads this first when somebody writes in about a missing pack,
    // so every staff role holds it. A balance is less private than an order:
    // it names no card, no address and nothing that was bought.
    defaultFor: ["admin", "cs_lead", "cs_agent"],
  },
  "credits.balances.adjust": {
    label: "Adjust credit balances",
    description:
      "Add credits to someone's balance or take them away, with a note saying " +
      "why. Every adjustment is a sensitive audit row.",
    category: "Credits",
    // Admin only by default. An adjustment is money created or destroyed by
    // hand, and the person granted it should be a decision someone made on
    // /admin/roles, not a default a support lead inherited.
    defaultFor: ["admin"],
  },
} as const satisfies PermissionMap;

export type WalletPermission = keyof typeof walletPermissions;
