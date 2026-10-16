/**
 * The audit vocabulary of Alert settings (review SEC-04). Structurally an
 * observability `AuditedActionMap`, like tenancy's, so the project spreads it
 * into its audit registry; notifications doesn't depend on observability.
 *
 * A KEY IS PERMANENT: rows written today are read back with these labels for
 * as long as the audit log is kept, so a key is never renamed or reused.
 *
 * `sensitive`: an outside address that starts getting the company's work
 * alerts gets every lead's customer name, phone and address from then on.
 */
export const notificationsAuditedActions = {
  "alerts.routing.changed": { label: "Changed who hears about new work" },
  "alerts.routing.address-added": { label: "Added an outside email address to an alert list", sensitive: true },
} as const satisfies Readonly<Record<string, { readonly label: string; readonly sensitive?: boolean }>>;

export type NotificationsAuditAction = keyof typeof notificationsAuditedActions;

/** One saved change to a list in "Who hears about new work", handed to the handlers' `audit` seam after it is saved. */
export interface NotificationsAuditEvent {
  /** `alerts.routing.address-added` when an address starts getting the emails, else `alerts.routing.changed`. */
  readonly action: NotificationsAuditAction;
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly resourceType: "alerts_routing";
  /** The list's key ("estimates"). */
  readonly resourceId: string;
  readonly metadata: {
    /** The list's name as the owner sees it. */
    readonly group: string;
    readonly mode: "owner" | "chosen";
    /** How many people are ticked (0 on "The owner"). */
    readonly people: number;
    /** The addresses getting the emails now (none on "The owner"). */
    readonly addresses: readonly string[];
    /** Addresses that start getting the emails with this change. */
    readonly addedAddresses: readonly string[];
    /** Addresses that stop getting them. */
    readonly removedAddresses: readonly string[];
  };
}
