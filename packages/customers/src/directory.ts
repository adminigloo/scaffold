import {
  findOrCreateCustomer,
  findUniqueCustomer,
  linkCustomer,
  linkedCustomer,
  linkedRefs,
  type CustomerSource,
  type CustomersDb,
  type FindOrCreateInput,
  type LinkInput,
} from "./customers.js";
import type { CustomerLinkKind } from "./wire.js";

/**
 * THE SEAM BETWEEN THE FEATURES AND A CUSTOMER LIST (customers 0.1).
 *
 * Every feature's glue (an estimate submitted, a visit booked, an invoice
 * raised, a call booked, an order paid, a message sent) talks to a
 * `CustomerDirectory`, never to tables. `createDrizzleCustomerDirectory` is
 * this package's own list; an app that already keeps its customers somewhere
 * else implements these five calls over its own table and hands that in
 * instead — the features' glue doesn't change.
 *
 * Every call is inside one company (`tenantId`): an implementation must
 * never match, link or return a customer of another company, and a public
 * source must never change a customer it matched (see customers.ts).
 */
export interface CustomerRef {
  readonly id: string;
  readonly name: string;
}

export interface CustomerDirectory {
  /** The company's customer for these details (by the source's rules), or a new one. */
  findOrCreate(input: FindOrCreateInput): Promise<CustomerRef & { readonly created: boolean }>;
  /** The ONE customer with exactly this email, else this phone — null when nobody or more than one has it. Never a new one. */
  findUnique(input: { readonly tenantId: string; readonly email?: string | null; readonly phone?: string | null }): Promise<CustomerRef | null>;
  /** Put one thing that happened on a customer's timeline. Idempotent per (kind, ref, action, occurrence). */
  link(input: LinkInput): Promise<{ readonly linked: boolean }>;
  /** The customer a record is linked to, or null. */
  linkedTo(tenantId: string, kind: CustomerLinkKind, refId: string): Promise<CustomerRef | null>;
  /** Which of these records already have which actions on a timeline, as `refActionKey(ref, action)` (the backfill's skip list). */
  linkedRefs(tenantId: string, kind: CustomerLinkKind, refIds: readonly string[]): Promise<ReadonlySet<string>>;
}

export interface DrizzleCustomerDirectoryOptions {
  /** Reads a phone written without "+", per company. Default "US". */
  readonly defaultCountry?: (tenantId: string) => string | Promise<string>;
}

/** This package's own customer list, over its tables. */
export function createDrizzleCustomerDirectory(db: CustomersDb, options: DrizzleCustomerDirectoryOptions = {}): CustomerDirectory {
  const country = async (tenantId: string) => (options.defaultCountry ? await options.defaultCountry(tenantId) : "US");
  return {
    async findOrCreate(input) {
      const { customer, created } = await findOrCreateCustomer(db, { ...input, defaultCountry: input.defaultCountry ?? (await country(input.tenantId)) });
      return { id: customer.id, name: customer.name, created };
    },
    async findUnique(input) {
      const row = await findUniqueCustomer(db, { ...input, defaultCountry: await country(input.tenantId) });
      return row ? { id: row.id, name: row.name } : null;
    },
    async link(input) {
      const { linked } = await linkCustomer(db, input);
      return { linked };
    },
    linkedTo: (tenantId, kind, refId) => linkedCustomer(db, tenantId, kind, refId),
    linkedRefs: (tenantId, kind, refIds) => linkedRefs(db, tenantId, kind, refIds),
  };
}

/** One thing that happened to one record of a feature, with whatever the feature knows about the customer. */
export interface CustomerActivity {
  readonly tenantId: string;
  readonly kind: CustomerLinkKind;
  readonly refId: string;
  readonly action: string;
  /** Which time it happened, for an action that can happen again (see `LinkInput`). */
  readonly occurrence?: string;
  readonly occurredAt: Date;
  readonly summary: string;
  readonly name?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly companyName?: string | null;
  readonly address?: string | null;
  /**
   * Who the details came from. "public" (the default): a stranger could have
   * typed them — an estimate request, a booking, a store order — so they never
   * change a customer they match (see customers.ts). "staff": a staff member
   * entered or vouched for them.
   */
  readonly source?: CustomerSource;
  /**
   * "find": only a customer who is exactly, and only, this email or phone is
   * linked; nobody is made (a message: an office notice to the owner makes
   * nobody a customer). Default "create".
   */
  readonly mode?: "create" | "find";
}

/**
 * WHAT EVERY FEATURE'S GLUE CALLS. The record's customer is, in order:
 *
 *   1. the customer this record is already linked to (an invoice paid lands
 *      on the customer it was raised for, whatever the payment says) — and
 *      nothing about them changes;
 *   2. `mode: "find"`: the one customer with exactly this email or phone;
 *   3. otherwise found or made by `findOrCreate`, under the source's rules.
 *
 * Then the activity goes on their timeline, once. Returns the customer, or
 * null when there was nobody to link.
 */
export async function recordCustomerActivity(directory: CustomerDirectory, activity: CustomerActivity): Promise<CustomerRef | null> {
  let customer: CustomerRef | null = await directory.linkedTo(activity.tenantId, activity.kind, activity.refId);
  const hasContact = Boolean(activity.email?.trim() || activity.phone?.trim());
  if (!customer && activity.mode === "find") {
    if (hasContact) customer = await directory.findUnique({ tenantId: activity.tenantId, email: activity.email, phone: activity.phone });
  } else if (!customer && (hasContact || activity.name?.trim())) {
    customer = await directory.findOrCreate({
      tenantId: activity.tenantId,
      name: activity.name,
      email: activity.email,
      phone: activity.phone,
      companyName: activity.companyName,
      address: activity.address,
      createdFrom: activity.kind,
      source: activity.source ?? "public",
      sourceLabel: activity.summary,
    });
  }
  if (!customer) return null;
  await directory.link({
    tenantId: activity.tenantId,
    customerId: customer.id,
    kind: activity.kind,
    refId: activity.refId,
    action: activity.action,
    occurrence: activity.occurrence,
    occurredAt: activity.occurredAt,
    summary: activity.summary,
  });
  return customer;
}
