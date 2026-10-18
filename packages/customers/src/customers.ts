import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { toCsv } from "./csv.js";
import { addressMatchKey, emailMatchKey, normaliseEmail, normalisePhone, oneLine, phoneMatchKey, phoneSearchDigits } from "./normalise.js";
import {
  customerAddresses,
  customerLinks,
  customerMerges,
  customerNotices,
  customers,
  type CustomerAddressRow,
  type CustomerNoticeDetails,
  type CustomerNoticeKind,
  type CustomerNoticeRow,
  type CustomerRow,
} from "./schema.js";
import type {
  CustomerLinkKind,
  CustomerListResponse,
  CustomerNoticeWire,
  CustomerSummaryWire,
  CustomerWire,
  TimelineEntryWire,
  TimelineResponse,
} from "./wire.js";
import { CUSTOMER_LINK_KINDS } from "./wire.js";

/**
 * THE CUSTOMER LIST'S RULES (customers 0.1). Every function takes the
 * company (`tenantId`) and reads and writes inside it only: a customer, an
 * address or a link of another company is "not found", exactly like one that
 * doesn't exist, and the same email in two companies is two customers.
 *
 * WHO MAY CHANGE A CUSTOMER. Details come from two kinds of source:
 *
 *   staff   a staff-made invoice, an edit, an import: matched by email, else
 *           phone, and what's new about the customer is added.
 *   public  anything a stranger can send — an estimate request, a booking, a
 *           store order: matched by EMAIL ONLY, and it never changes the
 *           customer it matched. What it brought that they didn't have waits
 *           on their record ("New details from a form …": Add or Ignore). A
 *           form that matches only by phone makes a new customer, flagged
 *           "Might be the same person as …" on both records.
 *
 * From any source, an email or phone another of the company's customers
 * already has is never added; the record says who has it instead.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CustomersDb = PgDatabase<any, any, any>;

/** Where details came from: staff (trusted) or a public form (never changes a customer). */
export type CustomerSource = "staff" | "public";

export type CustomersRefusalCode = "not_found" | "invalid" | "exists" | "busy";

/** A refusal the owner reads as is (plain words). */
export class CustomersRefusal extends Error {
  readonly name = "CustomersRefusal";
  constructor(
    readonly code: CustomersRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

const NAME_MAX = 200;
const NOTES_MAX = 5_000;
const SUMMARY_MAX = 200;
const MAX_EMAILS = 10;
const MAX_PHONES = 10;
const MAX_TAGS = 20;

/** Only rows of this company that weren't merged away. */
function active(tenantId: string): SQL {
  return and(eq(customers.tenantId, tenantId), isNull(customers.mergedInto))!;
}

function holdsKey(key: string): SQL {
  return sql`${customers.matchKeys} @> ${JSON.stringify([key])}::jsonb`;
}

function isUniqueViolation(error: unknown): boolean {
  for (let at: unknown = error, depth = 0; at && depth < 4; depth += 1) {
    const code = (at as { code?: unknown }).code;
    if (code === "23505") return true;
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

/** The company's customer holding this match key ("e:…" or "p:…"), or null. */
async function findByKey(db: CustomersDb, tenantId: string, key: string): Promise<CustomerRow | null> {
  const column = key.startsWith("e:") ? customers.emailKey : customers.phoneKey;
  const [row] = (await db
    .select()
    .from(customers)
    .where(and(active(tenantId), sql`(${column} = ${key} or ${holdsKey(key)})`))
    .orderBy(sql`case when ${column} = ${key} then 0 else 1 end`, asc(customers.createdAt))
    .limit(1)) as CustomerRow[];
  return row ?? null;
}

/** Who else of the company holds this key (not `except`), or null. */
async function holderOf(db: CustomersDb, tenantId: string, key: string, except: string | null): Promise<CustomerRow | null> {
  const [row] = (await db
    .select()
    .from(customers)
    .where(and(active(tenantId), holdsKey(key), ...(except ? [sql`${customers.id} <> ${except}`] : [])))
    .limit(1)) as CustomerRow[];
  return row ?? null;
}

/** The customer of this company who has this email or phone (the email first), or null. */
export async function findCustomer(
  db: CustomersDb,
  input: { readonly tenantId: string; readonly email?: string | null; readonly phone?: string | null; readonly defaultCountry?: string },
): Promise<CustomerRow | null> {
  const keys = [emailMatchKey(input.email), phoneMatchKey(input.phone, input.defaultCountry)].filter((key): key is string => key !== null);
  for (const key of keys) {
    const row = await findByKey(db, input.tenantId, key);
    if (row) return row;
  }
  return null;
}

/**
 * The ONE customer with exactly this email (as written, lower case) — else
 * exactly this phone — or null when nobody has it or more than one does. For
 * a message that went out: it links only where there's no doubt whose it is.
 */
export async function findUniqueCustomer(
  db: CustomersDb,
  input: { readonly tenantId: string; readonly email?: string | null; readonly phone?: string | null; readonly defaultCountry?: string },
): Promise<CustomerRow | null> {
  const email = normaliseEmail(input.email);
  const phone = normalisePhone(input.phone, input.defaultCountry);
  const probes: SQL[] = [
    ...(email ? [sql`${customers.emails} @> ${JSON.stringify([email])}::jsonb`] : []),
    ...(phone ? [sql`${customers.phones} @> ${JSON.stringify([phone])}::jsonb`] : []),
  ];
  for (const probe of probes) {
    const rows = (await db.select().from(customers).where(and(active(input.tenantId), probe)).limit(2)) as CustomerRow[];
    if (rows.length === 1) return rows[0]!;
    if (rows.length > 1) return null;
  }
  return null;
}

export interface FindOrCreateInput {
  readonly tenantId: string;
  readonly name?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly companyName?: string | null;
  /** One line. Added to the customer's addresses when it's new to them (staff), or offered (public). */
  readonly address?: string | null;
  /** Where a new customer came from ("estimate", "visit", …). Default "staff". */
  readonly createdFrom?: string;
  /** Reads a phone written without "+". Default "US". */
  readonly defaultCountry?: string;
  /** Staff (trusted) or a public form. Default "public": a form never changes a customer it matched. */
  readonly source?: CustomerSource;
  /** Where it came from, in words, for the record's notices: "Quote Q-0012 asked for online". */
  readonly sourceLabel?: string | null;
}

/** A name to show when the feature gave none: the email's name part, else the phone, else "Customer". */
function nameFor(input: FindOrCreateInput): string {
  const name = oneLine(input.name, NAME_MAX);
  if (name) return name;
  const company = oneLine(input.companyName, NAME_MAX);
  if (company) return company;
  const email = normaliseEmail(input.email);
  if (email) return email.slice(0, email.indexOf("@"));
  return normalisePhone(input.phone, input.defaultCountry) ?? "Customer";
}

async function addAddress(db: CustomersDb, tenantId: string, customerId: string, text: string | null | undefined, label: string | null = null): Promise<CustomerAddressRow | null> {
  const line = oneLine(text, 500);
  const key = addressMatchKey(line);
  if (!key) return null;
  const [row] = (await db
    .insert(customerAddresses)
    .values({ tenantId, customerId, text: line, matchKey: key, label: oneLine(label, 80) || null })
    .onConflictDoNothing()
    .returning()) as CustomerAddressRow[];
  return row ?? null;
}

// --- Notices --------------------------------------------------------------------

async function addNotice(
  db: CustomersDb,
  notice: {
    readonly tenantId: string;
    readonly customerId: string;
    readonly kind: CustomerNoticeKind;
    readonly otherCustomerId?: string | null;
    readonly details?: CustomerNoticeDetails;
    readonly sourceLabel?: string | null;
    readonly dedupeKey: string;
  },
): Promise<void> {
  await db
    .insert(customerNotices)
    .values({
      tenantId: notice.tenantId,
      customerId: notice.customerId,
      kind: notice.kind,
      otherCustomerId: notice.otherCustomerId ?? null,
      details: notice.details ?? {},
      sourceLabel: oneLine(notice.sourceLabel, 200) || null,
      dedupeKey: notice.dedupeKey.slice(0, 500),
    })
    .onConflictDoNothing();
}

/** "Mr Kim also has this phone": the detail wasn't added to `row`. */
async function noteSharedKey(db: CustomersDb, row: CustomerRow, holder: CustomerRow, detail: { readonly email?: string; readonly phone?: string }): Promise<void> {
  await addNotice(db, {
    tenantId: row.tenantId,
    customerId: row.id,
    kind: "shared-key",
    otherCustomerId: holder.id,
    details: detail.email ? { emails: [detail.email] } : { phones: [detail.phone!] },
    dedupeKey: `shared:${holder.id}:${detail.email ?? detail.phone}`,
  });
}

/** "Might be the same person as …", on both records. */
async function notePossibleDuplicate(db: CustomersDb, tenantId: string, a: CustomerRow, b: CustomerRow, phone: string | null, sourceLabel: string | null | undefined): Promise<void> {
  for (const [self, other] of [
    [a, b],
    [b, a],
  ] as const) {
    await addNotice(db, {
      tenantId,
      customerId: self.id,
      kind: "possible-duplicate",
      otherCustomerId: other.id,
      details: phone ? { phones: [phone] } : {},
      sourceLabel,
      dedupeKey: `duplicate:${other.id}`,
    });
  }
}

/**
 * STAFF: add what we were just told to a customer we already have — an email
 * or phone they hadn't used with us (unless another customer has it: then
 * the record says so), their company name if we had none, a new address.
 * Never their name: what the owner typed stays.
 */
async function learn(db: CustomersDb, row: CustomerRow, input: FindOrCreateInput): Promise<CustomerRow> {
  const email = normaliseEmail(input.email);
  const phone = normalisePhone(input.phone, input.defaultCountry);
  const keys = new Set(row.matchKeys);
  const emails = [...row.emails];
  const phones = [...row.phones];
  const eKey = emailMatchKey(email);
  const pKey = phoneMatchKey(phone, input.defaultCountry);
  if (email && eKey && !keys.has(eKey) && emails.length < MAX_EMAILS) {
    const holder = await holderOf(db, row.tenantId, eKey, row.id);
    if (holder) await noteSharedKey(db, row, holder, { email });
    else {
      emails.push(email);
      keys.add(eKey);
    }
  }
  if (phone && pKey && !keys.has(pKey) && phones.length < MAX_PHONES) {
    const holder = await holderOf(db, row.tenantId, pKey, row.id);
    if (holder) await noteSharedKey(db, row, holder, { phone });
    else {
      phones.push(phone);
      keys.add(pKey);
    }
  }
  const company = row.companyName ?? (oneLine(input.companyName, NAME_MAX) || null);
  let next: CustomerRow | undefined = row;
  if (emails.length !== row.emails.length || phones.length !== row.phones.length || company !== row.companyName) {
    const values = { emails, phones, matchKeys: [...keys], companyName: company, updatedAt: new Date() };
    const guarded = {
      ...values,
      emailKey: row.emailKey ?? (eKey && keys.has(eKey) ? eKey : null),
      phoneKey: row.phoneKey ?? (pKey && keys.has(pKey) ? pKey : null),
    };
    try {
      [next] = (await db.update(customers).set(guarded).where(and(eq(customers.id, row.id), eq(customers.tenantId, row.tenantId))).returning()) as CustomerRow[];
    } catch (error) {
      // Another customer took that key between our read and this write: keep the detail, not the key.
      if (!isUniqueViolation(error)) throw error;
      [next] = (await db.update(customers).set(values).where(and(eq(customers.id, row.id), eq(customers.tenantId, row.tenantId))).returning()) as CustomerRow[];
    }
  }
  await addAddress(db, row.tenantId, row.id, input.address);
  return next ?? row;
}

/**
 * PUBLIC: a form matched this customer by email. Nothing of theirs changes;
 * what the form brought that they don't have waits on their record.
 */
async function offerDetails(db: CustomersDb, row: CustomerRow, input: FindOrCreateInput): Promise<void> {
  const phone = normalisePhone(input.phone, input.defaultCountry);
  const pKey = phoneMatchKey(phone, input.defaultCountry);
  const details: { phones?: string[]; addresses?: string[]; companyName?: string } = {};
  if (phone && pKey && !row.matchKeys.includes(pKey)) details.phones = [phone];
  const line = oneLine(input.address, 500);
  const key = addressMatchKey(line);
  if (key) {
    const [known] = (await db
      .select({ id: customerAddresses.id })
      .from(customerAddresses)
      .where(and(eq(customerAddresses.tenantId, row.tenantId), eq(customerAddresses.customerId, row.id), eq(customerAddresses.matchKey, key)))
      .limit(1)) as Array<{ id: string }>;
    if (!known) details.addresses = [line];
  }
  const company = oneLine(input.companyName, NAME_MAX);
  if (company && !row.companyName) details.companyName = company;
  if (!details.phones && !details.addresses && !details.companyName) return;
  await addNotice(db, {
    tenantId: row.tenantId,
    customerId: row.id,
    kind: "new-details",
    details,
    sourceLabel: input.sourceLabel,
    dedupeKey: `details:${JSON.stringify([details.phones ?? [], (details.addresses ?? []).map(addressMatchKey), details.companyName?.toLowerCase() ?? ""])}`,
  });
}

/**
 * THE ONE WAY A FEATURE GETS ITS CUSTOMER, inside one company only.
 *
 *   staff   the customer with this email (folded for matching), else this
 *           phone (E.164) — and what's new about them is added — else a new one.
 *   public  the customer with this email; what the form brought waits on
 *           their record. No email match: a new customer. If the phone is
 *           another customer's, the new one doesn't get it and both records
 *           say "Might be the same person as …".
 *
 * Two requests for the same new customer at once make ONE customer: both
 * insert, the unique partial indexes let one win, the other's insert does
 * nothing and the loop reads the winner back.
 */
export async function findOrCreateCustomer(db: CustomersDb, input: FindOrCreateInput): Promise<{ readonly customer: CustomerRow; readonly created: boolean }> {
  if (!input.tenantId) throw new CustomersRefusal("invalid", "Which business is this customer for?");
  const source: CustomerSource = input.source ?? "public";
  const email = normaliseEmail(input.email);
  const phone = normalisePhone(input.phone, input.defaultCountry);
  const eKey = emailMatchKey(email);
  const pKey = phoneMatchKey(phone, input.defaultCountry);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let phoneHolder: CustomerRow | null = null;
    if (source === "staff") {
      const existing = eKey || pKey ? await findCustomer(db, { tenantId: input.tenantId, email, phone, defaultCountry: input.defaultCountry }) : null;
      if (existing) return { customer: await learn(db, existing, input), created: false };
    } else {
      const byEmail = eKey ? await findByKey(db, input.tenantId, eKey) : null;
      if (byEmail) {
        await offerDetails(db, byEmail, input);
        return { customer: byEmail, created: false };
      }
      phoneHolder = pKey ? await findByKey(db, input.tenantId, pKey) : null;
    }
    const withPhone = Boolean(phone && pKey && !phoneHolder);
    const keys = [eKey, withPhone ? pKey : null].filter((key): key is string => key !== null);
    const [row] = (await db
      .insert(customers)
      .values({
        tenantId: input.tenantId,
        name: nameFor(input),
        companyName: oneLine(input.companyName, NAME_MAX) || null,
        emails: email ? [email] : [],
        phones: withPhone && phone ? [phone] : [],
        matchKeys: keys,
        emailKey: eKey,
        phoneKey: withPhone ? pKey : null,
        createdFrom: oneLine(input.createdFrom, 40) || "staff",
      })
      .onConflictDoNothing()
      .returning()) as CustomerRow[];
    if (row) {
      await addAddress(db, input.tenantId, row.id, input.address);
      if (phoneHolder) await notePossibleDuplicate(db, input.tenantId, row, phoneHolder, phone, input.sourceLabel);
      return { customer: row, created: true };
    }
    // Someone else created this customer a moment ago: read theirs back.
  }
  throw new CustomersRefusal("busy", "That customer is being saved by someone else right now. Please try again.");
}

/** Follow a merged customer to the one kept (a link told to a merged id lands on the kept one). */
export async function keptCustomer(db: CustomersDb, tenantId: string, customerId: string): Promise<CustomerRow | null> {
  let id = customerId;
  for (let hop = 0; hop < 5; hop += 1) {
    const [row] = (await db
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.tenantId, tenantId)))
      .limit(1)) as CustomerRow[];
    if (!row) return null;
    if (!row.mergedInto) return row;
    id = row.mergedInto;
  }
  return null;
}

export interface LinkInput {
  readonly tenantId: string;
  readonly customerId: string;
  readonly kind: CustomerLinkKind;
  readonly refId: string;
  /** What happened to the record: "submitted", "booked", "raised", "paid", "sent", … Default "linked". */
  readonly action?: string;
  /**
   * Which time it happened, from the event, for an action that can happen
   * again (a visit's sequence after a move, an invoice's paid time). Default
   * "": it happens once.
   */
  readonly occurrence?: string;
  readonly occurredAt: Date;
  /** One line for the timeline: "Quote Q-0012 · $480". */
  readonly summary: string;
}

/**
 * Put one thing that happened on a customer's timeline. Told twice (a retry,
 * a backfill run again), it is one row: `(kind, ref, action, occurrence)` is
 * unique per company. A customer of another company is "not found".
 */
export async function linkCustomer(db: CustomersDb, input: LinkInput): Promise<{ readonly linked: boolean; readonly customerId: string }> {
  if (!CUSTOMER_LINK_KINDS.includes(input.kind)) throw new CustomersRefusal("invalid", `"${String(input.kind)}" isn't something a customer can be linked to.`);
  const refId = oneLine(input.refId, 200);
  if (!refId) throw new CustomersRefusal("invalid", "Which record is this?");
  const customer = await keptCustomer(db, input.tenantId, input.customerId);
  if (!customer) throw new CustomersRefusal("not_found", "That customer isn't here.");
  const occurredAt = Number.isNaN(input.occurredAt.getTime()) ? new Date() : input.occurredAt;
  const [row] = (await db
    .insert(customerLinks)
    .values({
      tenantId: input.tenantId,
      customerId: customer.id,
      kind: input.kind,
      refId,
      action: oneLine(input.action, 40) || "linked",
      occurrence: oneLine(input.occurrence, 200),
      occurredAt,
      summary: oneLine(input.summary, SUMMARY_MAX) || input.kind,
    })
    .onConflictDoNothing()
    .returning({ id: customerLinks.id })) as Array<{ id: string }>;
  if (row) {
    await db
      .update(customers)
      .set({ lastActivityAt: sql`greatest(coalesce(${customers.lastActivityAt}, ${occurredAt.toISOString()}::timestamptz), ${occurredAt.toISOString()}::timestamptz)` })
      .where(and(eq(customers.id, customer.id), eq(customers.tenantId, input.tenantId)));
  }
  return { linked: Boolean(row), customerId: customer.id };
}

/** The customer a record is linked to (any of its actions), or null. */
export async function linkedCustomer(db: CustomersDb, tenantId: string, kind: CustomerLinkKind, refId: string): Promise<{ readonly id: string; readonly name: string } | null> {
  const [row] = (await db
    .select({ id: customers.id, name: customers.name })
    .from(customerLinks)
    .innerJoin(customers, and(eq(customers.id, customerLinks.customerId), eq(customers.tenantId, tenantId)))
    .where(and(eq(customerLinks.tenantId, tenantId), eq(customerLinks.kind, kind), eq(customerLinks.refId, refId)))
    .orderBy(asc(customerLinks.occurredAt))
    .limit(1)) as Array<{ id: string; name: string }>;
  return row ?? null;
}

/** The key `linkedRefs` answers in: one record's one action. */
export function refActionKey(refId: string, action: string): string {
  return `${refId}\u0000${action}`;
}

/** Which of these records already have which actions on a timeline, as `refActionKey`s (the backfill's skip list). */
export async function linkedRefs(db: CustomersDb, tenantId: string, kind: CustomerLinkKind, refIds: readonly string[]): Promise<Set<string>> {
  if (refIds.length === 0) return new Set();
  const rows = (await db
    .selectDistinct({ refId: customerLinks.refId, action: customerLinks.action })
    .from(customerLinks)
    .where(and(eq(customerLinks.tenantId, tenantId), eq(customerLinks.kind, kind), inArray(customerLinks.refId, [...refIds])))) as Array<{ refId: string; action: string }>;
  return new Set(rows.map((row) => refActionKey(row.refId, row.action)));
}

// --- What the screens read ------------------------------------------------------

function summaryWire(row: CustomerRow): CustomerSummaryWire {
  return {
    id: row.id,
    name: row.name,
    companyName: row.companyName ?? null,
    email: row.emails[0] ?? null,
    phone: row.phones[0] ?? null,
    tags: row.tags,
    lastActivityAt: row.lastActivityAt ? row.lastActivityAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function detailWords(details: CustomerNoticeDetails): string[] {
  return [
    ...(details.emails ?? []).map((email) => `email ${email}`),
    ...(details.phones ?? []).map((phone) => `phone ${phone}`),
    ...(details.addresses ?? []),
    ...(details.companyName ? [`company ${details.companyName}`] : []),
  ];
}

function noticeWire(notice: CustomerNoticeRow, other: { id: string; name: string } | null): CustomerNoticeWire {
  const details = notice.details ?? {};
  const from = notice.sourceLabel ? ` (${notice.sourceLabel})` : "";
  let message: string;
  if (notice.kind === "new-details") message = `New details from a form${from}: ${detailWords(details).join(", ")}`;
  else if (notice.kind === "possible-duplicate")
    message = `Might be the same person as ${other?.name ?? "another customer"}${details.phones?.[0] ? ` (the same phone, ${details.phones[0]})` : ""}`;
  else message = `${other?.name ?? "Another customer"} also has this ${details.emails?.length ? `email, ${details.emails[0]}` : `phone, ${details.phones?.[0] ?? ""}`}. It wasn't added here.`;
  return { id: notice.id, kind: notice.kind, message, other, createdAt: notice.createdAt.toISOString() };
}

async function noticesOf(db: CustomersDb, row: CustomerRow): Promise<CustomerNoticeWire[]> {
  const rows = (await db
    .select()
    .from(customerNotices)
    .where(and(eq(customerNotices.tenantId, row.tenantId), eq(customerNotices.customerId, row.id), isNull(customerNotices.resolvedAt)))
    .orderBy(asc(customerNotices.createdAt), asc(customerNotices.id))) as CustomerNoticeRow[];
  const otherIds = [...new Set(rows.map((notice) => notice.otherCustomerId).filter((id): id is string => Boolean(id)))];
  const others = otherIds.length
    ? ((await db
        .select({ id: customers.id, name: customers.name, mergedInto: customers.mergedInto })
        .from(customers)
        .where(and(eq(customers.tenantId, row.tenantId), inArray(customers.id, otherIds)))) as Array<{ id: string; name: string; mergedInto: string | null }>)
    : [];
  const byId = new Map(others.map((other) => [other.id, other]));
  return rows.flatMap((notice) => {
    const other = notice.otherCustomerId ? (byId.get(notice.otherCustomerId) ?? null) : null;
    // A duplicate that has since been merged away is no longer a question.
    if (notice.kind === "possible-duplicate" && (!other || other.mergedInto)) return [];
    return [noticeWire(notice, other ? { id: other.id, name: other.name } : null)];
  });
}

async function wireOf(db: CustomersDb, row: CustomerRow): Promise<CustomerWire> {
  const addresses = (await db
    .select()
    .from(customerAddresses)
    .where(and(eq(customerAddresses.tenantId, row.tenantId), eq(customerAddresses.customerId, row.id)))
    .orderBy(asc(customerAddresses.createdAt), asc(customerAddresses.id))) as CustomerAddressRow[];
  return {
    ...summaryWire(row),
    emails: row.emails,
    phones: row.phones,
    notes: row.notes ?? null,
    createdFrom: row.createdFrom,
    addresses: addresses.map((address) => ({ id: address.id, label: address.label ?? null, text: address.text })),
    notices: await noticesOf(db, row),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function activeRow(db: CustomersDb, tenantId: string, id: string): Promise<CustomerRow | null> {
  const [row] = (await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, id), active(tenantId)))
    .limit(1)) as CustomerRow[];
  return row ?? null;
}

/** One customer with their addresses and notices, or null (another company's, merged away, or none). */
export async function getCustomer(db: CustomersDb, tenantId: string, id: string): Promise<CustomerWire | null> {
  const row = await activeRow(db, tenantId, id);
  return row ? wireOf(db, row) : null;
}

const PAGE = 50;

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The customer list, most recently active first, searched by name, company,
 * email, phone (however it's typed: "(415) 555" finds +1415555…) or
 * address. Paged 50 at a time.
 */
export async function listCustomers(
  db: CustomersDb,
  tenantId: string,
  options: { readonly q?: string | null; readonly cursor?: string | null; readonly defaultCountry?: string } = {},
): Promise<CustomerListResponse> {
  const q = oneLine(options.q, 200);
  const offset = options.cursor && /^\d{1,7}$/.test(options.cursor) ? Number(options.cursor) : 0;
  const conditions: SQL[] = [active(tenantId)];
  if (q) {
    const like = likePattern(q);
    const either: SQL[] = [
      sql`${customers.name} ilike ${like}`,
      sql`coalesce(${customers.companyName}, '') ilike ${like}`,
      sql`${customers.emails}::text ilike ${like}`,
      sql`${customers.phones}::text ilike ${like}`,
      sql`exists (select 1 from ${customerAddresses} where ${customerAddresses.customerId} = ${customers.id} and ${customerAddresses.tenantId} = ${tenantId} and ${customerAddresses.text} ilike ${like})`,
    ];
    const eKey = emailMatchKey(q);
    const pKey = phoneMatchKey(q, options.defaultCountry);
    const digits = phoneSearchDigits(q);
    if (eKey) either.push(holdsKey(eKey));
    if (pKey) either.push(holdsKey(pKey));
    if (digits) either.push(sql`${customers.phones}::text like ${`%${digits}%`}`);
    conditions.push(sql`(${sql.join(either, sql` or `)})`);
  }
  const rows = (await db
    .select()
    .from(customers)
    .where(and(...conditions))
    .orderBy(sql`coalesce(${customers.lastActivityAt}, ${customers.createdAt}) desc`, desc(customers.id))
    .limit(PAGE + 1)
    .offset(offset)) as CustomerRow[];
  return {
    customers: rows.slice(0, PAGE).map(summaryWire),
    nextCursor: rows.length > PAGE ? String(offset + PAGE) : null,
  };
}

// --- What staff change ------------------------------------------------------------

function listOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return value.split(/[;,\n]/);
  return [];
}

function emailsFrom(value: unknown): string[] {
  const out: string[] = [];
  for (const raw of listOf(value)) {
    if (raw.trim() === "") continue;
    const email = normaliseEmail(raw);
    if (!email) throw new CustomersRefusal("invalid", `"${oneLine(raw, 80)}" doesn't look like an email address.`);
    if (!out.some((kept) => emailMatchKey(kept) === emailMatchKey(email))) out.push(email);
  }
  if (out.length > MAX_EMAILS) throw new CustomersRefusal("invalid", `A customer can have up to ${MAX_EMAILS} email addresses.`);
  return out;
}

function phonesFrom(value: unknown, country: string | undefined): string[] {
  const out: string[] = [];
  for (const raw of listOf(value)) {
    if (raw.trim() === "") continue;
    const phone = normalisePhone(raw, country);
    if (!phone) throw new CustomersRefusal("invalid", `We couldn't read "${oneLine(raw, 40)}" as a phone number. Include the area code, like (415) 555-0123, or start with + and the country code.`);
    if (!out.includes(phone)) out.push(phone);
  }
  if (out.length > MAX_PHONES) throw new CustomersRefusal("invalid", `A customer can have up to ${MAX_PHONES} phone numbers.`);
  return out;
}

function tagsFrom(value: unknown): string[] {
  const out: string[] = [];
  for (const raw of listOf(value)) {
    const tag = oneLine(raw, 40);
    if (tag && !out.some((kept) => kept.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  if (out.length > MAX_TAGS) throw new CustomersRefusal("invalid", `A customer can have up to ${MAX_TAGS} tags.`);
  return out;
}

function keysOf(emails: readonly string[], phones: readonly string[]): string[] {
  return [...emails.map((email) => emailMatchKey(email)!), ...phones.map((phone) => `p:${phone}`)];
}

/** Refuse when another of this company's customers already has one of these emails or phones. */
async function assertKeysFree(db: CustomersDb, tenantId: string, keys: readonly string[], except: string | null): Promise<void> {
  for (const key of keys) {
    const other = await holderOf(db, tenantId, key, except);
    if (other) {
      const what = key.startsWith("e:") ? "That email" : "That phone number";
      throw new CustomersRefusal("exists", `${what} is already ${other.name}'s. Open them instead, or merge the two.`);
    }
  }
}

export interface CustomerBody {
  readonly name?: unknown;
  readonly companyName?: unknown;
  readonly emails?: unknown;
  readonly phones?: unknown;
  readonly email?: unknown;
  readonly phone?: unknown;
  readonly notes?: unknown;
  readonly tags?: unknown;
  readonly address?: unknown;
}

function nameFrom(value: unknown): string {
  const name = oneLine(typeof value === "string" ? value : "", NAME_MAX);
  if (!name) throw new CustomersRefusal("invalid", "Give the customer a name.");
  return name;
}

function notesFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const notes = value.replace(/\r\n/g, "\n").trim();
  if (notes.length > NOTES_MAX) throw new CustomersRefusal("invalid", `Notes can be up to ${NOTES_MAX.toLocaleString("en-US")} characters.`);
  return notes === "" ? null : notes;
}

/** "Add customer": a new customer the owner typed. An email or phone another customer has is refused by name. */
export async function createCustomer(db: CustomersDb, tenantId: string, body: CustomerBody, options: { readonly defaultCountry?: string } = {}): Promise<CustomerWire> {
  const name = nameFrom(body.name);
  const emails = emailsFrom(body.emails ?? body.email);
  const phones = phonesFrom(body.phones ?? body.phone, options.defaultCountry);
  const keys = keysOf(emails, phones);
  await assertKeysFree(db, tenantId, keys, null);
  const [row] = (await db
    .insert(customers)
    .values({
      tenantId,
      name,
      companyName: oneLine(typeof body.companyName === "string" ? body.companyName : "", NAME_MAX) || null,
      emails,
      phones,
      matchKeys: keys,
      emailKey: emails[0] ? emailMatchKey(emails[0]) : null,
      phoneKey: phones[0] ? `p:${phones[0]}` : null,
      notes: notesFrom(body.notes),
      tags: tagsFrom(body.tags),
      createdFrom: "staff",
    })
    .onConflictDoNothing()
    .returning()) as CustomerRow[];
  if (!row) throw new CustomersRefusal("exists", "A customer with that email or phone was just added. Search for them instead.");
  if (typeof body.address === "string") await addAddress(db, tenantId, row.id, body.address);
  return wireOf(db, row);
}

/** Change a customer: only the fields sent. Returns null when the customer isn't this company's. */
export async function updateCustomer(db: CustomersDb, tenantId: string, id: string, body: CustomerBody, options: { readonly defaultCountry?: string } = {}): Promise<CustomerWire | null> {
  const row = await activeRow(db, tenantId, id);
  if (!row) return null;
  const emails = body.emails !== undefined || body.email !== undefined ? emailsFrom(body.emails ?? body.email) : row.emails;
  const phones = body.phones !== undefined || body.phone !== undefined ? phonesFrom(body.phones ?? body.phone, options.defaultCountry) : row.phones;
  const keys = keysOf(emails, phones);
  await assertKeysFree(db, tenantId, keys, row.id);
  const values = {
    ...(body.name !== undefined ? { name: nameFrom(body.name) } : {}),
    ...(body.companyName !== undefined ? { companyName: oneLine(typeof body.companyName === "string" ? body.companyName : "", NAME_MAX) || null } : {}),
    ...(body.notes !== undefined ? { notes: notesFrom(body.notes) } : {}),
    ...(body.tags !== undefined ? { tags: tagsFrom(body.tags) } : {}),
    emails,
    phones,
    matchKeys: keys,
    emailKey: emails[0] ? emailMatchKey(emails[0]) : null,
    phoneKey: phones[0] ? `p:${phones[0]}` : null,
    updatedAt: new Date(),
  };
  let next: CustomerRow | undefined;
  try {
    [next] = (await db.update(customers).set(values).where(and(eq(customers.id, row.id), active(tenantId))).returning()) as CustomerRow[];
  } catch (error) {
    if (isUniqueViolation(error)) throw new CustomersRefusal("exists", "Another customer was just given that email or phone. Search for them, or merge the two.");
    throw error;
  }
  return next ? wireOf(db, next) : null;
}

/** Add an address to a customer. Null when the customer isn't this company's. */
export async function addCustomerAddress(db: CustomersDb, tenantId: string, id: string, body: { readonly text?: unknown; readonly label?: unknown }): Promise<CustomerWire | null> {
  const row = await activeRow(db, tenantId, id);
  if (!row) return null;
  const text = oneLine(typeof body.text === "string" ? body.text : "", 500);
  if (!text) throw new CustomersRefusal("invalid", "Type the address.");
  await addAddress(db, tenantId, row.id, text, typeof body.label === "string" ? body.label : null);
  return wireOf(db, row);
}

/** Remove one of a customer's addresses. Null when either isn't this company's. */
export async function removeCustomerAddress(db: CustomersDb, tenantId: string, id: string, addressId: string): Promise<CustomerWire | null> {
  const row = await activeRow(db, tenantId, id);
  if (!row) return null;
  const removed = (await db
    .delete(customerAddresses)
    .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, row.id), eq(customerAddresses.tenantId, tenantId)))
    .returning({ id: customerAddresses.id })) as Array<{ id: string }>;
  if (removed.length === 0) return null;
  return wireOf(db, row);
}

export type NoticeAction = "add" | "ignore" | "dismiss";

/**
 * Staff decide a notice on a customer's record:
 *
 *   add      (new details) the form's details go on the customer — each
 *            email or phone only if no other customer has it (else the record
 *            says who does)
 *   ignore   (new details) left off, and not asked again
 *   dismiss  (a possible duplicate: "not the same person", on both records;
 *            a detail another customer has: "understood")
 *
 * Null when the customer or the notice isn't this company's (or it was decided already).
 */
export async function resolveCustomerNotice(
  db: CustomersDb,
  tenantId: string,
  customerId: string,
  noticeId: string,
  action: NoticeAction,
  resolvedBy: string | null = null,
): Promise<CustomerWire | null> {
  const row = await activeRow(db, tenantId, customerId);
  if (!row) return null;
  const [notice] = (await db
    .select()
    .from(customerNotices)
    .where(and(eq(customerNotices.id, noticeId), eq(customerNotices.tenantId, tenantId), eq(customerNotices.customerId, row.id), isNull(customerNotices.resolvedAt)))
    .limit(1)) as CustomerNoticeRow[];
  if (!notice) return null;
  if (action === "add" && notice.kind !== "new-details") throw new CustomersRefusal("invalid", "Only new details from a form can be added.");
  if (action === "ignore" && notice.kind !== "new-details") action = "dismiss";
  const close = (where: SQL, resolution: string) =>
    db.update(customerNotices).set({ resolvedAt: new Date(), resolution, resolvedBy }).where(and(eq(customerNotices.tenantId, tenantId), isNull(customerNotices.resolvedAt), where));
  let current = row;
  if (action === "add") {
    const details = notice.details ?? {};
    current = await learn(db, current, { tenantId, companyName: details.companyName ?? null, source: "staff" });
    for (const phone of details.phones ?? []) current = await learn(db, current, { tenantId, phone, source: "staff" });
    for (const email of details.emails ?? []) current = await learn(db, current, { tenantId, email, source: "staff" });
    for (const address of details.addresses ?? []) await addAddress(db, tenantId, current.id, address);
    await close(eq(customerNotices.id, notice.id), "added");
  } else {
    await close(eq(customerNotices.id, notice.id), action === "ignore" ? "ignored" : "dismissed");
    if (notice.kind === "possible-duplicate" && notice.otherCustomerId) {
      // "Not the same person": the other record stops asking too.
      await close(and(eq(customerNotices.customerId, notice.otherCustomerId), eq(customerNotices.kind, "possible-duplicate"), eq(customerNotices.otherCustomerId, row.id))!, "dismissed");
    }
  }
  const after = await activeRow(db, tenantId, row.id);
  return after ? wireOf(db, after) : null;
}

// --- The timeline ------------------------------------------------------------------

const TIMELINE_PAGE = 30;

function cursorOf(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}~${id}`, "utf8").toString("base64url");
}

function readCursor(cursor: string | null | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("~");
    if (!at || !id || Number.isNaN(new Date(at).getTime())) return null;
    return { at: new Date(at).toISOString(), id };
  } catch {
    return null;
  }
}

/**
 * Everything that is the customer's, from every feature, in one list — the
 * newest first (or `order: "oldest"`), 30 at a time. Null when the customer
 * isn't this company's.
 */
export async function customerTimeline(
  db: CustomersDb,
  tenantId: string,
  id: string,
  options: { readonly cursor?: string | null; readonly order?: "newest" | "oldest"; readonly limit?: number } = {},
): Promise<TimelineResponse | null> {
  const row = await activeRow(db, tenantId, id);
  if (!row) return null;
  const limit = Math.min(Math.max(options.limit ?? TIMELINE_PAGE, 1), 100);
  const oldest = options.order === "oldest";
  const after = readCursor(options.cursor);
  const conditions: SQL[] = [eq(customerLinks.tenantId, tenantId), eq(customerLinks.customerId, row.id)];
  if (after) {
    conditions.push(
      oldest
        ? sql`(${customerLinks.occurredAt}, ${customerLinks.id}) > (${after.at}::timestamptz, ${after.id})`
        : sql`(${customerLinks.occurredAt}, ${customerLinks.id}) < (${after.at}::timestamptz, ${after.id})`,
    );
  }
  const rows = (await db
    .select()
    .from(customerLinks)
    .where(and(...conditions))
    .orderBy(...(oldest ? [asc(customerLinks.occurredAt), asc(customerLinks.id)] : [desc(customerLinks.occurredAt), desc(customerLinks.id)]))
    .limit(limit + 1)) as Array<typeof customerLinks.$inferSelect>;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const entries: TimelineEntryWire[] = page.map((link) => ({
    id: link.id,
    kind: link.kind as CustomerLinkKind,
    refId: link.refId,
    action: link.action,
    occurredAt: link.occurredAt.toISOString(),
    summary: link.summary,
  }));
  return { entries, nextCursor: rows.length > limit && last ? cursorOf(last.occurredAt, last.id) : null };
}

// --- Merge -------------------------------------------------------------------------

function union(a: readonly string[], b: readonly string[], max: number): string[] {
  const out = [...a];
  for (const item of b) if (!out.includes(item) && out.length < max) out.push(item);
  return out;
}

/**
 * Two customers who are one person: everything of `mergeId` — its timeline,
 * addresses, emails, phones, tags, notes and open notices — moves to
 * `keepId`, and `mergeId` is kept, marked merged, never matched again (its
 * old link opens the kept customer). The merge itself is kept too
 * (customer_merges: who, when, and the merged customer as it was). Null when
 * either isn't this company's.
 */
export async function mergeCustomers(
  db: CustomersDb,
  tenantId: string,
  keepId: string,
  mergeId: string,
  mergedBy: string | null = null,
): Promise<{ readonly customer: CustomerWire; readonly linksMoved: number } | null> {
  if (keepId === mergeId) throw new CustomersRefusal("invalid", "Choose a different customer: a customer can't be merged into themselves.");
  const done = await db.transaction(async (tx) => {
    const both = (await tx
      .select()
      .from(customers)
      .where(and(active(tenantId), inArray(customers.id, [keepId, mergeId])))
      .orderBy(asc(customers.id))
      .for("update")) as CustomerRow[];
    const keep = both.find((row) => row.id === keepId);
    const gone = both.find((row) => row.id === mergeId);
    if (!keep || !gone) return null;
    // First the merged one lets go of its keys (the partial indexes skip merged rows anyway).
    await tx
      .update(customers)
      .set({ mergedInto: keep.id, emailKey: null, phoneKey: null, updatedAt: new Date() })
      .where(and(eq(customers.id, gone.id), eq(customers.tenantId, tenantId)));
    await tx
      .update(customers)
      .set({ mergedInto: keep.id })
      .where(and(eq(customers.tenantId, tenantId), eq(customers.mergedInto, gone.id)));
    const moved = (await tx
      .update(customerLinks)
      .set({ customerId: keep.id })
      .where(and(eq(customerLinks.tenantId, tenantId), eq(customerLinks.customerId, gone.id)))
      .returning({ id: customerLinks.id })) as Array<{ id: string }>;
    const addresses = (await tx
      .select()
      .from(customerAddresses)
      .where(and(eq(customerAddresses.tenantId, tenantId), eq(customerAddresses.customerId, gone.id)))) as CustomerAddressRow[];
    for (const address of addresses) {
      await tx
        .insert(customerAddresses)
        .values({ tenantId, customerId: keep.id, text: address.text, label: address.label, matchKey: address.matchKey })
        .onConflictDoNothing();
    }
    await tx.delete(customerAddresses).where(and(eq(customerAddresses.tenantId, tenantId), eq(customerAddresses.customerId, gone.id)));
    // Notices: "might be the same person" between the two is answered; the merged one's others move over.
    const between = or(
      and(eq(customerNotices.customerId, keep.id), eq(customerNotices.otherCustomerId, gone.id)),
      and(eq(customerNotices.customerId, gone.id), eq(customerNotices.otherCustomerId, keep.id)),
    )!;
    await tx
      .update(customerNotices)
      .set({ resolvedAt: new Date(), resolution: "merged", resolvedBy: mergedBy })
      .where(and(eq(customerNotices.tenantId, tenantId), isNull(customerNotices.resolvedAt), between));
    const goneNotices = (await tx
      .select()
      .from(customerNotices)
      .where(and(eq(customerNotices.tenantId, tenantId), eq(customerNotices.customerId, gone.id), isNull(customerNotices.resolvedAt)))) as CustomerNoticeRow[];
    for (const notice of goneNotices) {
      await tx
        .insert(customerNotices)
        .values({ tenantId, customerId: keep.id, kind: notice.kind, otherCustomerId: notice.otherCustomerId, details: notice.details, sourceLabel: notice.sourceLabel, dedupeKey: notice.dedupeKey })
        .onConflictDoNothing();
    }
    await tx.delete(customerNotices).where(and(eq(customerNotices.tenantId, tenantId), eq(customerNotices.customerId, gone.id), isNull(customerNotices.resolvedAt)));
    await tx
      .update(customerNotices)
      .set({ otherCustomerId: keep.id })
      .where(and(eq(customerNotices.tenantId, tenantId), eq(customerNotices.otherCustomerId, gone.id), sql`${customerNotices.customerId} <> ${keep.id}`));
    const emails = union(keep.emails, gone.emails, MAX_EMAILS);
    const phones = union(keep.phones, gone.phones, MAX_PHONES);
    const notes = [keep.notes, gone.notes].filter((note): note is string => Boolean(note && note.trim())).join("\n\n").slice(0, NOTES_MAX) || null;
    const lastActivity = [keep.lastActivityAt, gone.lastActivityAt].filter((at): at is Date => at instanceof Date).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const [kept] = (await tx
      .update(customers)
      .set({
        emails,
        phones,
        matchKeys: union(keep.matchKeys, gone.matchKeys, MAX_EMAILS + MAX_PHONES + 20),
        emailKey: keep.emailKey ?? gone.emailKey,
        phoneKey: keep.phoneKey ?? gone.phoneKey,
        companyName: keep.companyName ?? gone.companyName,
        tags: union(keep.tags, gone.tags, MAX_TAGS),
        notes,
        lastActivityAt: lastActivity,
        updatedAt: new Date(),
      })
      .where(and(eq(customers.id, keep.id), eq(customers.tenantId, tenantId)))
      .returning()) as CustomerRow[];
    const { createdAt: created, updatedAt: updated, lastActivityAt: last, ...rest } = gone;
    await tx.insert(customerMerges).values({
      tenantId,
      keptId: keep.id,
      mergedId: gone.id,
      mergedBy,
      snapshot: { ...rest, createdAt: created.toISOString(), updatedAt: updated.toISOString(), lastActivityAt: last ? last.toISOString() : null, addresses: addresses.map((a) => a.text) },
      linksMoved: moved.length,
    });
    return { row: kept ?? keep, linksMoved: moved.length };
  });
  if (!done) return null;
  return { customer: await wireOf(db, done.row), linksMoved: done.linksMoved };
}

// --- Export ------------------------------------------------------------------------

export const EXPORT_HEADER = ["Name", "Company", "Email", "Phone", "Address", "Tags", "Notes", "Customer since"] as const;

/** The company's whole customer list as CSV (the merged-away ones left out). */
export async function exportCustomersCsv(db: CustomersDb, tenantId: string): Promise<string> {
  const rows = (await db.select().from(customers).where(active(tenantId)).orderBy(asc(customers.name), asc(customers.id))) as CustomerRow[];
  const addresses = (await db
    .select({ customerId: customerAddresses.customerId, text: customerAddresses.text })
    .from(customerAddresses)
    .where(eq(customerAddresses.tenantId, tenantId))
    .orderBy(asc(customerAddresses.createdAt))) as Array<{ customerId: string; text: string }>;
  const firstAddress = new Map<string, string>();
  for (const address of addresses) if (!firstAddress.has(address.customerId)) firstAddress.set(address.customerId, address.text);
  return toCsv([
    [...EXPORT_HEADER],
    ...rows.map((row) => [
      row.name,
      row.companyName ?? "",
      row.emails.join("; "),
      row.phones.join("; "),
      firstAddress.get(row.id) ?? "",
      row.tags.join("; "),
      row.notes ?? "",
      row.createdAt.toISOString().slice(0, 10),
    ]),
  ]);
}

export { addAddress as addCustomerAddressLine, learn as learnAboutCustomer, holderOf as customerHoldingKey };
