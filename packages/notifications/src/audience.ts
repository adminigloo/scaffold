import { and, eq, inArray } from "drizzle-orm";
import type { AlertChannel, AlertKindSpec, AlertRegistry } from "./registry.js";
import type { NotificationTables } from "./schema.js";
import type { AlertEmailDelivery, AlertPerson, CreateNotificationsOptions, NotificationsDb, RoutingChoice } from "./types.js";

/**
 * WHO GETS IT (Tenancy 2b-1, 4.4; D4). Internal, shared by `notify` (who gets
 * a row and an email copy), `claimEmails` (the office addresses still owed,
 * when no row was written) and the retry's re-check (D9).
 *
 * The host answers "who holds a permission" (`people`), so a foreign host's
 * own roles decide. The routing groups are the owner's ONE place for "who
 * hears about new work": with nothing saved, the owner (the CURRENT owner,
 * so it follows a transfer). A saved list with no person left on it is the
 * owner again: an empty list is never "nobody", and a lead is never only in a
 * mailbox no bell shows (2a review T2A-BO-14; review BO-20).
 */

/** The engine's view of the options, after defaults. */
export interface Deps {
  readonly db: NotificationsDb;
  readonly tables: NotificationTables;
  readonly registry: AlertRegistry;
  readonly people: CreateNotificationsOptions["people"];
  readonly ownerEmail: CreateNotificationsOptions["ownerEmail"];
  readonly email: CreateNotificationsOptions["email"];
  readonly emailIdempotent: boolean;
  readonly emailDelivery: CreateNotificationsOptions["emailDelivery"];
  readonly sendTimeoutMs: number;
  readonly clock: () => Date;
  readonly report: (error: unknown, context: { readonly tenantId: string | null; readonly kind?: string; readonly step: string }) => void;
}

export interface Delivery {
  readonly available: boolean;
  readonly offReason: string | null;
  readonly offKinds: Readonly<Record<string, string>>;
}

export const NO_EMAIL_REASON = "This site doesn't send email yet, so alerts stay in the app.";

/**
 * How the handlers reach the instance's seams (who holds a permission, the
 * business email, whether email is on) without widening the public
 * `Notifications` interface. `Symbol.for`, so a project that ends up with the
 * ESM and the CJS build side by side still finds it.
 */
export const INTERNALS: unique symbol = Symbol.for("@adminigloo/notifications/internals");

export interface Internals {
  readonly deps: Deps;
}

/** A loose email check: something@something.tld, no spaces or brackets. The host's provider is the real judge. */
export const EMAIL_ADDRESS = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/;

export function cleanAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length <= 254 && EMAIL_ADDRESS.test(trimmed) ? trimmed : null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The per-call memo (4.4: `emailDelivery` and `ownerEmail` are asked at most
 * once per company per call; `people` once per company and permission; the
 * routing rows once per company).
 *
 * `strict` (claimEmails): a failed read THROWS, so the claim can answer
 * AlertsUnavailableError and the producer falls back to its business
 * address. Otherwise (notify, the cron) a failed routing or choice read is
 * reported and the safe default used (the owner; the kind's default channel).
 */
export function createLookups(deps: Deps, strict: boolean) {
  const peopleMemo = new Map<string, Promise<readonly AlertPerson[]>>();
  const routingMemo = new Map<string, Promise<ReadonlyMap<string, RoutingChoice>>>();
  const ownerMemo = new Map<string, Promise<string | null>>();
  const deliveryMemo = new Map<string, Promise<Delivery>>();

  /** The host's answer, normalised: a person needs a non-empty id; a bad address is no address. */
  async function people(tenantId: string, permission: string): Promise<readonly AlertPerson[]> {
    const key = `${tenantId}\u0000${permission}`;
    let found = peopleMemo.get(key);
    if (!found) {
      found = (async () => {
        const raw = await deps.people(tenantId, permission);
        const out: AlertPerson[] = [];
        const seen = new Set<string>();
        for (const person of Array.isArray(raw) ? raw : []) {
          const userId = person && (typeof person.userId === "string" || typeof person.userId === "number") ? String(person.userId) : "";
          if (userId === "" || seen.has(userId)) continue;
          seen.add(userId);
          out.push({
            userId,
            name: typeof person.name === "string" && person.name.trim() !== "" ? person.name.trim() : null,
            email: cleanAddress(person.email),
            isOwner: person.isOwner === true,
          });
        }
        return out;
      })();
      peopleMemo.set(key, found);
      // A failed answer isn't remembered: the next draft asks again.
      found.catch(() => peopleMemo.delete(key));
    }
    return found;
  }

  async function routingRows(tenantId: string): Promise<ReadonlyMap<string, RoutingChoice>> {
    let found = routingMemo.get(tenantId);
    if (!found) {
      found = (async () => {
        const t = deps.tables.routing;
        try {
          const rows = (await deps.db
            .select({ routing: t.routing, mode: t.mode, userIds: t.userIds, extraEmails: t.extraEmails, updatedAt: t.updatedAt })
            .from(t)
            .where(eq(t.tenantId, tenantId))) as {
            routing: string;
            mode: string;
            userIds: string[] | null;
            extraEmails: string[] | null;
            updatedAt: Date | null;
          }[];
          return new Map(
            rows.map((row) => [
              row.routing,
              {
                mode: row.mode === "chosen" ? "chosen" : "owner",
                userIds: [...(row.userIds ?? [])],
                extraEmails: [...(row.extraEmails ?? [])],
                updatedAt: row.updatedAt ?? null,
              } satisfies RoutingChoice,
            ]),
          );
        } catch (error) {
          if (strict) throw error;
          deps.report(error, { tenantId, step: "routing" });
          return new Map<string, RoutingChoice>();
        }
      })();
      routingMemo.set(tenantId, found);
      found.catch(() => routingMemo.delete(tenantId));
    }
    return found;
  }

  /** The business email for the owner's routed copies (review BO-01). A throw: the owner's own address, reported. */
  async function ownerEmail(tenantId: string): Promise<string | null> {
    if (!deps.ownerEmail) return null;
    let found = ownerMemo.get(tenantId);
    if (!found) {
      found = (async () => {
        try {
          return cleanAddress(await deps.ownerEmail!(tenantId));
        } catch (error) {
          deps.report(error, { tenantId, step: "owner-email" });
          return null;
        }
      })();
      ownerMemo.set(tenantId, found);
    }
    return found;
  }

  /**
   * Is email leaving for this company (D5)? Never without the `email` seam,
   * whatever `emailDelivery` says. A throw: not available, reported (strict:
   * thrown).
   */
  async function delivery(tenantId: string): Promise<Delivery> {
    let found = deliveryMemo.get(tenantId);
    if (!found) {
      found = (async (): Promise<Delivery> => {
        if (!deps.email) return { available: false, offReason: NO_EMAIL_REASON, offKinds: {} };
        if (!deps.emailDelivery) return { available: true, offReason: null, offKinds: {} };
        let answer: AlertEmailDelivery;
        try {
          answer = await deps.emailDelivery(tenantId);
        } catch (error) {
          if (strict) throw error;
          deps.report(error, { tenantId, step: "email-delivery" });
          return { available: false, offReason: NO_EMAIL_REASON, offKinds: {} };
        }
        const offKinds: Record<string, string> = {};
        for (const [kind, label] of Object.entries(answer?.offKinds ?? {})) {
          if (typeof label === "string") offKinds[kind] = label;
        }
        const available = answer?.available === true;
        return {
          available,
          offReason: available ? null : typeof answer?.offReason === "string" && answer.offReason.trim() !== "" ? answer.offReason : NO_EMAIL_REASON,
          offKinds,
        };
      })();
      deliveryMemo.set(tenantId, found);
      found.catch(() => deliveryMemo.delete(tenantId));
    }
    return found;
  }

  /** The stored choices of `userIds` for one kind (D5: only explicit choices are stored). */
  async function choicesFor(tenantId: string, kind: string, userIds: readonly string[]): Promise<ReadonlyMap<string, AlertChannel>> {
    if (userIds.length === 0) return new Map();
    const t = deps.tables.choices;
    try {
      const rows = (await deps.db
        .select({ userId: t.userId, channel: t.channel })
        .from(t)
        .where(and(eq(t.tenantId, tenantId), eq(t.kind, kind), inArray(t.userId, [...userIds])))) as { userId: string; channel: string }[];
      return new Map(rows.map((row) => [row.userId, row.channel === "email" ? "email" : "in_app"] as const));
    } catch (error) {
      if (strict) throw error;
      deps.report(error, { tenantId, kind, step: "choices" });
      return new Map();
    }
  }

  return { people, routingRows, ownerEmail, delivery, choicesFor };
}

export type Lookups = ReturnType<typeof createLookups>;

/** One person an alert reaches. */
export interface Recipient {
  readonly userId: string;
  readonly name: string | null;
  readonly isOwner: boolean;
  /** `audience`: step 3 chose them; `assigned`: only through the record's assigned people (crew). */
  readonly reachedVia: "audience" | "assigned";
  /** The address 4.4 gives them for THIS kind: the business email for the owner of a group on "The owner", else their own. */
  readonly emailTo: string | null;
  readonly channel: AlertChannel;
  /** They get an email copy (step 6). */
  readonly emailCopy: boolean;
}

/** One email-only address the owner added to a group (D2). */
export interface AddressRecipient {
  readonly address: string;
  readonly emailCopy: boolean;
}

export interface Audience {
  readonly people: readonly Recipient[];
  readonly addresses: readonly AddressRecipient[];
  /** The owner fallback found no owner and took everyone permitted (review G13). */
  readonly noOwner: boolean;
}

/**
 * A routed group's choice → who it reaches right now, from `permitted`
 * (members holding the kind's permission). `fallback`: the owner fallback is
 * in force (no row, mode `owner`, or a chosen list with no person left on it).
 */
export function routedPeople(
  permitted: readonly AlertPerson[],
  choice: RoutingChoice | undefined,
): { readonly chosen: readonly AlertPerson[]; readonly fallback: boolean; readonly noOwner: boolean; readonly extraEmails: readonly string[] } {
  const extraEmails = choice?.mode === "chosen" ? choice.extraEmails : [];
  if (choice?.mode === "chosen") {
    const listed = new Set(choice.userIds);
    const chosen = permitted.filter((person) => listed.has(person.userId));
    if (chosen.length > 0) return { chosen, fallback: false, noOwner: false, extraEmails };
  }
  const owners = permitted.filter((person) => person.isOwner);
  if (owners.length > 0) return { chosen: owners, fallback: true, noOwner: false, extraEmails };
  // Never nobody, for any host (review G13): a host with no "owner" concept,
  // or a single-business project where no staff member holds the admin
  // template, gets everyone who holds the permission.
  return { chosen: permitted, fallback: true, noOwner: permitted.length > 0, extraEmails };
}

/**
 * The recipients of one alert (4.4 steps 1–7). `people` failing throws (the
 * caller decides: notify reports "people" and alerts nobody for that draft;
 * the claim answers AlertsUnavailableError). The `assigned` lookup failing in
 * a lenient run is reported and the office still gets theirs.
 */
export async function resolveAudience(
  deps: Deps,
  lookups: Lookups,
  input: {
    readonly tenantId: string;
    readonly spec: AlertKindSpec;
    readonly actorUserId: string | null;
    readonly assignedUserIds: readonly string[];
  },
  strict: boolean,
): Promise<Audience> {
  const { tenantId, spec } = input;
  const permitted = await lookups.people(tenantId, spec.audience.permission);

  // Step 3: the audience (routed, or everyone permitted).
  type Picked = { person: AlertPerson; emailTo: string | null };
  const picked: Picked[] = [];
  let extraEmails: readonly string[] = [];
  let noOwner = false;
  if (spec.audience.routing) {
    const rows = await lookups.routingRows(tenantId);
    const routed = routedPeople(permitted, rows.get(spec.audience.routing));
    extraEmails = routed.extraEmails;
    noOwner = routed.noOwner;
    const business = routed.fallback ? await lookups.ownerEmail(tenantId) : null;
    for (const person of routed.chosen) {
      // Review BO-01: while the group is on "The owner", the owner's copies go
      // to the business email (the office reads office@…), else their own.
      picked.push({ person, emailTo: routed.fallback && person.isOwner ? (business ?? person.email) : person.email });
    }
  } else {
    for (const person of permitted) picked.push({ person, emailTo: person.email });
  }

  // Step 4: the people assigned to the record (crew), as `assigned`.
  const assigned: AlertPerson[] = [];
  if (spec.audience.assigned && input.assignedUserIds.length > 0) {
    try {
      const holders = await lookups.people(tenantId, spec.audience.assigned.permission);
      const wanted = new Set(input.assignedUserIds);
      for (const person of holders) if (wanted.has(person.userId)) assigned.push(person);
    } catch (error) {
      if (strict) throw error;
      deps.report(error, { tenantId, kind: spec.key, step: "people" });
    }
  }

  // Step 5: never the actor; one entry per person (the audience wins).
  const seen = new Set<string>();
  const entries: { person: AlertPerson; emailTo: string | null; reachedVia: "audience" | "assigned" }[] = [];
  for (const { person, emailTo } of picked) {
    if (person.userId === input.actorUserId || seen.has(person.userId)) continue;
    seen.add(person.userId);
    entries.push({ person, emailTo, reachedVia: "audience" });
  }
  for (const person of assigned) {
    if (person.userId === input.actorUserId || seen.has(person.userId)) continue;
    seen.add(person.userId);
    entries.push({ person, emailTo: person.email, reachedVia: "assigned" });
  }

  // Step 6: each person's channel, and whether an email copy goes.
  const delivery = await lookups.delivery(tenantId);
  const kindEmails = spec.email !== false && delivery.available && delivery.offKinds[spec.key] === undefined;
  const choices = kindEmails ? await lookups.choicesFor(tenantId, spec.key, entries.map((entry) => entry.person.userId)) : new Map();
  const people: Recipient[] = entries.map(({ person, emailTo, reachedVia }) => {
    const channel: AlertChannel = choices.get(person.userId) ?? spec.defaultChannel;
    return {
      userId: person.userId,
      name: person.name,
      isOwner: person.isOwner,
      reachedVia,
      emailTo,
      channel,
      emailCopy: kindEmails && channel === "email" && emailTo !== null,
    };
  });

  // Step 7: the group's extra addresses, under the same conditions on the
  // kind and the company. An address equal to a person's address (as step 3
  // worked it out, the business email included) is dropped when that person
  // gets an email copy: their own copy covers it.
  // CONTRACT: 4.4 step 7 drops it "(that person's own copy covers it)"; when
  // that person chose "In the app" there is no copy to cover it, so the
  // owner's added address keeps its email rather than going silent.
  const covered = new Set(people.filter((p) => p.reachedVia === "audience" && p.emailCopy && p.emailTo).map((p) => p.emailTo!.toLowerCase()));
  const addresses: AddressRecipient[] = [];
  const seenAddresses = new Set<string>();
  for (const raw of extraEmails) {
    const address = cleanAddress(raw);
    if (!address) continue;
    const key = address.toLowerCase();
    if (seenAddresses.has(key) || covered.has(key)) continue;
    seenAddresses.add(key);
    addresses.push({ address, emailCopy: kindEmails });
  }
  return { people, addresses, noOwner };
}

export { same as sameAddress };
