import type { RoleKey } from "./wire.js";

/**
 * What the company lifecycle tells `onEvent`, after commit.
 *
 * ROOT-SAFE ON PURPOSE (Tenancy 2b-1, 8.4): the type moved here from
 * `server/types.ts` (re-exported by `./server`, so no import changes) because
 * `tenancyAlertsFor` lives in the ROOT — it only formats an event — and the
 * root must never reach a table or a driver (barrel.test.ts). Types only;
 * nothing here runs.
 *
 * TENANCY 2b-1: every event carries `id` (a uuidv7, unique per event) and
 * `occurredAt` (ISO, the service's `now`), stamped in ONE place, `ctx.emit`.
 * Why: an alert's dedupe key must come from a durable fact (2b-1 D7), and a
 * member joining has no fact of its own to key on (the same person may join,
 * leave and join again), so the event's own id is the key. The three member
 * events also name the PERSON, read where they are emitted, so a listener can
 * say "Cam Rivera joined the team" without a query of its own (and a removed
 * member is no longer a member to look up).
 */

/** The person a member event is about. A deleted user gives `{ name: null, email: null }`. */
export interface TenancyEventPerson {
  readonly name: string | null;
  readonly email: string | null;
}

/** The fields every event carries (Tenancy 2b-1). */
interface Stamped {
  /** uuidv7, unique per event. */
  readonly id: string;
  /** ISO 8601, the service's `now` when it was emitted. */
  readonly occurredAt: string;
}

export type TenancyEvent = Stamped &
  (
    | { readonly type: "company.created"; readonly tenantId: string; readonly userId: string }
    | {
        readonly type: "member.joined";
        readonly tenantId: string;
        readonly userId: string;
        readonly via: "invitation" | "verified-email";
        /** Tenancy 2b-1: who joined. */
        readonly person: TenancyEventPerson;
        /** Tenancy 2b-1: the role they joined with, in words ("Crew member"). */
        readonly roleName: string;
      }
    | {
        readonly type: "member.removed" | "member.left";
        readonly tenantId: string;
        readonly userId: string;
        readonly by: string;
        /** Tenancy 2b-1: who was removed, or left. */
        readonly person: TenancyEventPerson;
      }
    | {
        readonly type: "member.role.changed";
        readonly tenantId: string;
        readonly userId: string;
        readonly from: RoleKey | null;
        readonly to: RoleKey;
        readonly by: string;
      }
    | { readonly type: "ownership.transferred"; readonly tenantId: string; readonly from: string; readonly to: string }
    | { readonly type: "company.suspended" | "company.reactivated"; readonly tenantId: string; readonly by: string }
    /** Tenancy 0.8: deleted for good by staff. Nothing of it is left to read; a listener only tidies what's outside the database. */
    | { readonly type: "company.deleted"; readonly tenantId: string; readonly by: string }
    | { readonly type: "invitation.sent"; readonly tenantId: string; readonly invitationId: string; readonly by: string }
    /**
     * Tenancy 2a: a settings section saved (`changed`: the same field list as
     * its audit row). Scheduling's zone convergence listens for section
     * "company" with "timeZone" in `changed` (D5).
     */
    | {
        readonly type: "company.settings.updated";
        readonly tenantId: string;
        readonly section: string;
        readonly changed: readonly string[];
        readonly by: string;
      }
    | { readonly type: "company.profile.updated"; readonly tenantId: string; readonly changed: readonly ("name" | "slug")[]; readonly by: string }
    | { readonly type: "company.branding.updated"; readonly tenantId: string; readonly by: string }
  );

export type TenancyEventListener = (event: TenancyEvent) => void | Promise<void>;

/** `Omit` that keeps a union a union (each member loses the keys on its own). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * An event as the lifecycle code hands it to `ctx.emit`, before the stamp:
 * everything but `id` and `occurredAt`, which `emit` adds (one place, so no
 * call site can forget them or make its own).
 */
export type TenancyEventInput = DistributiveOmit<TenancyEvent, "id" | "occurredAt">;
