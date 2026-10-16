/**
 * THE WIRE TYPES — what @adminigloo/notifications's `createNotificationHandlers`
 * sends and accepts, as JSON (Tenancy 2b-1 contract, 4.8).
 *
 * SHARED WITH @adminigloo/notifications (its src/wire.ts declares the same
 * region); change both or neither. The widget never imports the server
 * package at runtime, so the wire-parity test reads BOTH files from disk and
 * fails the build if the region between the WIRE markers differs by a single
 * byte.
 *
 * A user id is on the wire only to tick a box; no screen shows it.
 */

// WIRE:BEGIN
export type Instant = string;
export type AlertsErrorCode = "invalid" | "not_found" | "forbidden" | "cross_site" | "rate_limited" | "internal";
export interface WireIssue { path: (string | number)[]; message: string }
export interface WireErrorBody { error: { code: AlertsErrorCode; message: string; issues?: WireIssue[] } }

export interface AlertWire {
  id: string;
  kind: string;
  /** Its kind's category, for the icon and the group heading: "Estimates", "Visits", … */
  category: string;
  title: string;
  body: string | null;
  /** A path on this site; null = nothing to open. */
  href: string | null;
  at: Instant;
  read: boolean;
}
export interface AlertCountWire {
  unread: number;
  /** False: this person is on no alert list and gets no kind directly (review BO-12); the bell's empty state says so. */
  reachable: boolean;
}
export interface AlertListWire {
  alerts: AlertWire[];
  nextCursor: string | null;
  unread: number;
  reachable: boolean;
  links: { inbox: string | null; settings: string | null };
}

export type AlertChannelWire = "in_app" | "email";
export interface AlertChoiceWire {
  kind: string;
  label: string;
  description: string | null;
  category: string;
  channel: AlertChannelWire;
  /** False: only "In the app" can be picked, and `emailNote` says why. */
  emailOffered: boolean;
  emailNote: string | null;
  /** True when the email is switched off in Messages: the widget links `emailNote` to `links.messages` (review BO-11). */
  emailOffInMessages: boolean;
  /**
   * A routed kind: the group's label, whether this person is on its list, and
   * whether they get it through assignment (crew on their own visits; review
   * BO-12). null = not routed.
   */
  routed: { group: string; onList: boolean; viaAssigned: boolean } | null;
  /** False: they can't get this kind now; listed under "Not on your list", no radios (review BO-12). */
  receives: boolean;
  /**
   * Where this person's email copies of this kind go: the business email from
   * company settings while they get it as the owner of a list on "The owner",
   * else their own address (review BO-1). null = no address.
   */
  emailTo: string | null;
}
export interface PreferencesWire {
  /** Where this person's alert emails go; null = no address. */
  emailAddress: string | null;
  emailAvailable: boolean;
  emailOffReason: string | null;
  categories: string[];
  choices: AlertChoiceWire[];
  canManageRouting: boolean;
  reachable: boolean;
  links: { messages: string | null };
}
export interface PreferenceBody { kind: string; channel: AlertChannelWire }

export interface RoutingPersonWire { userId: string; name: string | null; email: string | null; isOwner: boolean }
export interface RoutingGroupWire {
  key: string;
  label: string;
  description: string | null;
  /** The labels of the alerts it carries ("This covers: …"). */
  covers: string[];
  mode: "owner" | "chosen";
  userIds: string[];
  extraEmails: string[];
  /** Who may be picked: members holding the group's permission. */
  candidates: RoutingPersonWire[];
  /** Where the owner's email copies go while this group is on "The owner" (the business email, else the owner's own; review BO-01). null: no address. */
  ownerEmail: string | null;
  /** True when ownerEmail is the business email from company settings, not the owner's own sign-in address. */
  ownerEmailIsBusiness: boolean;
  /** The kinds' emails are switched off in Messages: the sentence to show (review BO-11). null = not. */
  emailNote: string | null;
  /**
   * The labels of the kinds it covers that the owner gets "In the app" only
   * (their own choice, or the kind's default): while the list is on "The
   * owner", no email goes to `ownerEmail` for them (review BO-1).
   */
  ownerInAppOnly: string[];
  /** True when the person reading is that owner ("your choice"), false for an admin ("the owner's choice"). */
  ownerIsYou: boolean;
}
export interface RoutingWire { groups: RoutingGroupWire[] }
export interface RoutingBody { key: string; mode: "owner" | "chosen"; userIds: string[]; extraEmails: string[] }
// WIRE:END
