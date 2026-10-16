import type { SubscriptionStatus } from "./status.js";

/**
 * Where a company stands with its plan, in the words its screens use.
 *
 * WHY THIS EXISTS (billing 0.3). Until now nothing in the suite asked whether a
 * company had paid: the estimator, the schedule, invoices, messages, alerts and
 * files all served a company that had cancelled, never subscribed, or stopped
 * paying months ago. Every company request already passes through one of three
 * checkpoints — the tRPC company rung, the feature routes' company seams and
 * the public pages' admit — so ONE answer, computed here, is asked from all
 * three, and every package is covered at once instead of package by package.
 *
 *   trial   no subscription yet, inside the free trial
 *   active  paid (or trialing at Stripe) and renewing
 *   ending  cancelled, but paid up until `until`
 *   grace   a payment failed; still open until `until` while the card is retried
 *   ended   cancelled and past its end, or the grace ran out
 *   none    never had a plan, and the trial is over
 *
 * `open` is the only field a gate reads. The rest is for the sentence.
 */
export type PlanStandingState = "trial" | "active" | "ending" | "grace" | "ended" | "none";

export interface PlanStanding {
  readonly state: PlanStandingState;
  /** May the company use its features right now? */
  readonly open: boolean;
  /** When an open standing stops by itself (trial end, period end, grace end). NULL: it doesn't. */
  readonly until: Date | null;
  /** The plan's tier key (`pro`), when the company has or had one. */
  readonly tierKey: string | null;
}

/** The company's most recent subscription row, as far as standing needs it. */
export interface StandingSubscription {
  readonly status: SubscriptionStatus;
  readonly cancelAtPeriodEnd: boolean;
  readonly currentPeriodEnd: Date | null;
  readonly tierKey: string | null;
}

export interface PlanStandingInput {
  /** The newest subscription row for the company, or null when it has never had one. */
  readonly subscription: StandingSubscription | null;
  /**
   * The expiry of every `plan`-sourced entitlement row the company holds.
   * NULL in the list is "never". These rows are what `applySubscription`
   * already keeps in step with Stripe — including the 14-day grace after a
   * failed payment and the end of a cancelled period — so they, not the
   * status, decide `open` once a subscription exists.
   */
  readonly planRowExpiries: readonly (Date | null)[];
  /**
   * When the free trial started: the company's creation, or the day plans were
   * first enforced on an existing project, whichever is later. NULL: no trial.
   */
  readonly trialStartedAt: Date | null;
  /** Length of the free trial. 0: no trial. */
  readonly trialDays: number;
  readonly now: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Statuses where a checkout was started but nothing was ever paid: the company is still "before its first plan". */
const NEVER_PAID: readonly SubscriptionStatus[] = ["incomplete"];

const GRACE_MS = 14 * DAY_MS;

/** When a subscription with no plan rows stops serving, from its status alone (null: it doesn't). */
function statusWindowEnd(sub: StandingSubscription): Date | null {
  const end = sub.currentPeriodEnd;
  switch (sub.status) {
    case "active":
    case "trialing":
      return sub.cancelAtPeriodEnd ? end ?? new Date(0) : null;
    case "past_due":
    case "unpaid":
      return end ? new Date(end.getTime() + GRACE_MS) : new Date(0);
    default:
      // Cancelled: served until the end of the period it paid for, if any.
      return end ?? new Date(0);
  }
}

/**
 * Work out the standing. Pure: the same rows and the same `now` always give
 * the same answer, which is what lets every checkpoint agree.
 */
export function planStanding(input: PlanStandingInput): PlanStanding {
  const now = input.now.getTime();
  const sub = input.subscription;

  if (sub && !NEVER_PAID.includes(sub.status)) {
    // Closed boundary, as `resolveEntitlements`: a row is dead AT its expiry.
    // A plan whose features are all options (or a host with no quota
    // features) writes NO plan rows (review M1): then the subscription's own
    // window decides — open while paid up, for the grace after a failed
    // payment, and until the end of a cancelled period.
    const rows = input.planRowExpiries.length > 0 ? input.planRowExpiries : [statusWindowEnd(sub)];
    const serving = rows.filter((at) => at === null || at.getTime() > now);
    const open = serving.length > 0;
    const until = open && serving.every((at) => at !== null)
      ? new Date(Math.min(...serving.map((at) => (at as Date).getTime())))
      : null;
    const tierKey = sub.tierKey;
    if (!open) return { state: "ended", open: false, until: null, tierKey };
    switch (sub.status) {
      case "past_due":
      case "unpaid":
        return { state: "grace", open: true, until, tierKey };
      case "canceled":
        return { state: "ending", open: true, until, tierKey };
      case "active":
      case "trialing":
        return { state: sub.cancelAtPeriodEnd ? "ending" : "active", open: true, until, tierKey };
      default:
        return { state: "active", open: true, until, tierKey };
    }
  }

  // No plan yet (or a checkout that never finished): the free trial decides.
  const tierKey = sub?.tierKey ?? null;
  if (input.trialStartedAt !== null && input.trialDays > 0) {
    const ends = input.trialStartedAt.getTime() + input.trialDays * DAY_MS;
    if (ends > now) return { state: "trial", open: true, until: new Date(ends), tierKey };
  }
  return { state: "none", open: false, until: null, tierKey };
}

/**
 * What stays usable while a company's plan is closed: everything needed to
 * see its own work and to come back. Reading (`*.view`, and a crew member's
 * `schedule.route`), its plan and billing, its team, and its company settings.
 * Everything that DOES work — new estimates, booking, sending, uploading —
 * waits until there's a plan again. Nothing is deleted.
 */
export function openWhilePlanClosed(permission: string): boolean {
  if (permission.endsWith(".view") || permission === "schedule.route") return true;
  return /^(subscriptions|plans|billing|members|tenant)\./.test(permission);
}

/** The sentence a refused action shows, for a company whose plan is closed. */
export function planClosedMessage(standing: PlanStanding, noun = "company"): string {
  if (standing.state === "none") {
    return `This ${noun}'s free trial has ended. An owner can choose a plan in Billing to keep using this.`;
  }
  return `This ${noun}'s plan has ended. An owner can choose a plan in Billing to keep using this.`;
}

/** The sentence a customer sees on a closed company's public pages. */
export function planClosedPublicMessage(companyName: string): string {
  return `${companyName} isn't taking requests online right now.`;
}

export interface PlanGate {
  /** The company's standing (memoised per gate for `cacheMs`). */
  standing(tenantId: string): Promise<PlanStanding>;
  /** May someone who holds `permission` in this company use it now, as far as the plan goes? */
  allows(tenantId: string, permission: string): Promise<boolean>;
  /** Are the company's features (and its public pages) open? */
  isOpen(tenantId: string): Promise<boolean>;
  /** The refusal sentence for this company, when its plan is closed. */
  closedMessage(tenantId: string): Promise<string>;
}

export interface CreatePlanGateOptions {
  /** Read the company's standing (e.g. `loadPlanStanding` from `@adminigloo/billing/server`). */
  readonly standing: (tenantId: string) => Promise<PlanStanding>;
  /** What stays usable while the plan is closed. Default `openWhilePlanClosed`. */
  readonly openWhileClosed?: (permission: string) => boolean;
  /** The word for a company in sentences. Default "company". */
  readonly noun?: string;
  /**
   * How long one company's standing is reused, in ms. Default 0 (every ask
   * reads). A page that asks ten times in one render is better served by a
   * short cache; a plan change shows up when it expires.
   */
  readonly cacheMs?: number;
  /** For tests. */
  readonly now?: () => number;
}

export function createPlanGate(options: CreatePlanGateOptions): PlanGate {
  if (typeof options?.standing !== "function") {
    throw new TypeError("createPlanGate needs `standing(tenantId)`: where the company stands with its plan.");
  }
  const openWhileClosed = options.openWhileClosed ?? openWhilePlanClosed;
  const noun = options.noun ?? "company";
  const cacheMs = Math.max(0, options.cacheMs ?? 0);
  const clock = options.now ?? Date.now;
  const cache = new Map<string, { at: number; value: Promise<PlanStanding> }>();

  function standing(tenantId: string): Promise<PlanStanding> {
    if (cacheMs > 0) {
      const hit = cache.get(tenantId);
      if (hit && clock() - hit.at < cacheMs) return hit.value;
    }
    const value = options.standing(tenantId);
    if (cacheMs > 0) {
      cache.set(tenantId, { at: clock(), value });
      // A failed read must not be served from the cache for the whole window.
      value.catch(() => cache.delete(tenantId));
      if (cache.size > 5000) cache.delete(cache.keys().next().value as string);
    }
    return value;
  }

  return {
    standing,
    async allows(tenantId, permission) {
      if (openWhileClosed(permission)) return true;
      return (await standing(tenantId)).open;
    },
    async isOpen(tenantId) {
      return (await standing(tenantId)).open;
    },
    async closedMessage(tenantId) {
      return planClosedMessage(await standing(tenantId), noun);
    },
  };
}

/** The shape of a permission set this needs: what `@adminigloo/permissions` resolves. */
interface PermissionSetLike {
  can(permission: string): boolean;
  canAll(permissions: readonly string[]): boolean;
  canAny(permissions: readonly string[]): boolean;
  toArray(): readonly string[];
}

/** A set that only grants what's still open while the plan is closed. Unchanged when the plan is open. */
export function gatePermissionSet<S extends PermissionSetLike>(
  set: S,
  open: boolean,
  openWhileClosed: (permission: string) => boolean = openWhilePlanClosed,
): S {
  if (open) return set;
  const allowed = (permission: string) => openWhileClosed(permission) && set.can(permission);
  return {
    ...set,
    can: allowed,
    canAll: (permissions: readonly string[]) => permissions.every(allowed),
    canAny: (permissions: readonly string[]) => permissions.some(allowed),
    toArray: () => set.toArray().filter(allowed),
  };
}

/**
 * Wrap an app's permission loaders so the tRPC company rung, the page gates and
 * anything else that reads `loadTenantPermissions` sees a plan-closed company's
 * permissions trimmed to `openWhilePlanClosed`. Staff permissions are untouched:
 * the platform owner is never locked out by a customer's plan.
 */
export function gatePermissionLoaders<
  L extends {
    loadTenantPermissions(input: { readonly principal: { readonly userId: string }; readonly tenantId: string }): Promise<PermissionSetLike | null>;
  },
>(loaders: L, gate: Pick<PlanGate, "isOpen">, openWhileClosed: (permission: string) => boolean = openWhilePlanClosed): L {
  return {
    ...loaders,
    async loadTenantPermissions(input: { readonly principal: { readonly userId: string }; readonly tenantId: string }) {
      const set = await loaders.loadTenantPermissions(input);
      if (set === null) return null;
      return gatePermissionSet(set, await gate.isOpen(input.tenantId), openWhileClosed);
    },
  } as L;
}
