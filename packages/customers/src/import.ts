import { newId } from "@adminigloo/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { hasReplacementCharacters, mapCsvHeader, parseCsv, type CsvColumn } from "./csv.js";
import { CustomersRefusal, type CustomersDb } from "./customers.js";
import { addressMatchKey, emailMatchKey, normaliseEmail, normalisePhone, oneLine } from "./normalise.js";
import { customerAddresses, customers, type CustomerRow } from "./schema.js";
import type { ImportApplyResponse, ImportPreviewResponse, ImportRowAction, ImportRowWire } from "./wire.js";

/**
 * CSV IMPORT (customers 0.1): preview first, then apply. Both read the same
 * file the same way, so what the preview promised is what apply does.
 *
 *   - At most 5,000 customers a file; a bigger one is refused whole.
 *   - Each row is checked on its own and told in plain words: no name, an
 *     email that isn't one, a phone that can't be read.
 *   - Deduped against the company's customers (by email, else phone) and
 *     within the file: a match gets what's new (emails, phones, the address,
 *     tags), never a new name. The preview names every email and phone a row
 *     adds — and any another customer already has, which is NOT added (the
 *     same rule as everywhere: one email or phone, one customer).
 *   - Apply works in batches of 500 rows, each saved whole or not at all, and
 *     at most 2,000 rows a call: the screen calls again from `nextRow` until
 *     the file is done ("1,500 of 5,000 done"). If a batch fails, the rows
 *     before it are saved and the answer says so; carrying on from `nextRow`
 *     adds nothing twice.
 *   - A spreadsheet's "'+14155550123" (the ' it adds to keep a number as
 *     text) reads as the phone.
 */
export const IMPORT_MAX_ROWS = 5_000;
/** Rows saved together (one transaction). */
export const IMPORT_BATCH_ROWS = 500;
/** Rows one apply call works through, so a call stays well inside a request's time limit. */
export const IMPORT_ROWS_PER_CALL = 2_000;

interface PlannedRow {
  readonly wire: ImportRowWire;
  readonly name: string;
  readonly companyName: string | null;
  /** The emails and phones this row adds to its customer (others are theirs already, or another customer's). */
  readonly addEmails: readonly string[];
  readonly addPhones: readonly string[];
  readonly address: string | null;
  readonly notes: string | null;
  readonly tags: readonly string[];
  /** The customer it goes to: an existing id, or "row:N" for the file's first row of this person. */
  readonly target: string | null;
}

interface Holder {
  readonly target: string;
  readonly name: string;
  readonly row: number | null;
}

function cellsOf(value: string): string[] {
  return value
    .split(/[;\n]|,(?=\s*[^\s@,]+@)|\s+\/\s+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** A phone as a spreadsheet may hand it back: "'+14155550123" is the phone. */
function phoneCell(part: string, country: string): string | null {
  const phone = normalisePhone(part, country);
  if (phone) return phone;
  return part.startsWith("'") ? normalisePhone(part.slice(1), country) : null;
}

function plan(csv: string, existing: ReadonlyMap<string, { readonly id: string; readonly name: string }>, defaultCountry: string): { rows: PlannedRow[]; ignored: string[] } {
  if (hasReplacementCharacters(csv)) {
    throw new CustomersRefusal(
      "invalid",
      "Some letters in that file couldn't be read (they show as �). In your spreadsheet, choose Save As → \"CSV UTF-8\", then import that file.",
    );
  }
  const table = parseCsv(csv);
  if (table.length === 0) throw new CustomersRefusal("invalid", "That file is empty. Choose a CSV file with a heading row and one customer on each row after it.");
  const header = table[0]!;
  const columns = mapCsvHeader(header);
  const has = (column: CsvColumn) => columns.includes(column);
  if (!has("name") && !has("firstName") && !has("lastName") && !has("companyName") && !has("email") && !has("phone")) {
    throw new CustomersRefusal("invalid", "We couldn't find a Name, Email or Phone column. The first row should be the headings, like: Name, Email, Phone, Address.");
  }
  const body = table.slice(1);
  if (body.length > IMPORT_MAX_ROWS) {
    throw new CustomersRefusal(
      "invalid",
      `That file has ${body.length.toLocaleString("en-US")} customers. Import at most ${IMPORT_MAX_ROWS.toLocaleString("en-US")} at a time: split the file and import each part.`,
    );
  }
  const ignored = header.filter((heading, index) => columns[index] === null && heading.trim() !== "").map((heading) => oneLine(heading, 60));
  const known = (key: string): Holder | null => {
    const found = existing.get(key);
    return found ? { target: found.id, name: found.name, row: null } : null;
  };
  const seen = new Map<string, Holder>();
  const rows: PlannedRow[] = [];
  body.forEach((cells, index) => {
    const row = index + 2;
    const cell = (column: CsvColumn) => {
      const at = columns.indexOf(column);
      return at >= 0 ? (cells[at] ?? "").trim() : "";
    };
    const companyName = oneLine(cell("companyName"), 200) || null;
    const name = oneLine(cell("name") || [cell("firstName"), cell("lastName")].filter(Boolean).join(" ") || companyName || "", 200);
    const problems: string[] = [];
    const emails: string[] = [];
    for (const raw of cellsOf(cell("email"))) {
      const email = normaliseEmail(raw);
      if (email) {
        if (!emails.some((kept) => emailMatchKey(kept) === emailMatchKey(email))) emails.push(email);
      } else problems.push(`"${oneLine(raw, 60)}" isn't an email address`);
    }
    const phones: string[] = [];
    for (const raw of cellsOf(cell("phone"))) {
      const phone = phoneCell(raw, defaultCountry);
      if (phone) {
        if (!phones.includes(phone)) phones.push(phone);
      } else problems.push(`we couldn't read "${oneLine(raw, 40)}" as a phone number (include the area code)`);
    }
    if (!name) problems.unshift("there's no name (add the customer's name, or their company)");
    const base = { row, name, email: emails[0] ?? null, phone: phones[0] ?? null };
    const fields = {
      name,
      companyName,
      address: oneLine(cell("address"), 500) || null,
      notes: cell("notes").slice(0, 5_000) || null,
      tags: cellsOf(cell("tags").replace(/,/g, ";")).map((tag) => oneLine(tag, 40)).slice(0, 20),
    };
    if (problems.length > 0) {
      const message = `Row ${row}: ${problems.join("; ")}. Fix it in the file and preview again, or leave the row out.`;
      rows.push({ wire: { ...base, action: "error", message, adds: [], conflicts: [] }, ...fields, addEmails: [], addPhones: [], target: null });
      return;
    }
    const keyed = [...emails.map((email) => ({ key: emailMatchKey(email)!, label: `email ${email}`, email, phone: null })), ...phones.map((phone) => ({ key: `p:${phone}`, label: `phone ${phone}`, email: null, phone }))];
    const holderOf = (key: string) => known(key) ?? seen.get(key) ?? null;
    // Whose row this is: the customer with its email, else its phone (import is staff: phones match too).
    const owner = keyed.map(({ key }) => holderOf(key)).find((holder): holder is Holder => holder !== null) ?? null;
    const target = owner?.target ?? `row:${row}`;
    const adds: string[] = [];
    const conflicts: string[] = [];
    const addEmails: string[] = [];
    const addPhones: string[] = [];
    for (const entry of keyed) {
      const holder = holderOf(entry.key);
      if (holder && holder.target !== target) {
        conflicts.push(`${entry.label} is already ${holder.name}'s${holder.row ? ` (row ${holder.row})` : ""}, so it isn't added`);
        continue;
      }
      if (holder) continue; // theirs already
      adds.push(entry.label);
      if (entry.email) addEmails.push(entry.email);
      if (entry.phone) addPhones.push(entry.phone);
      seen.set(entry.key, { target, name: owner?.name ?? name, row: owner?.row ?? (owner ? null : row) });
    }
    let action: ImportRowAction = "create";
    let message = "New customer.";
    if (owner && owner.row !== null && owner.target.startsWith("row:")) {
      action = "same-as-row";
      message = `Same customer as row ${owner.row} (${owner.name}): their details are added together.`;
    } else if (owner) {
      action = "update";
      message = `Already a customer: ${owner.name}. New emails, phones, the address and tags are added; the name stays as it is.`;
    }
    rows.push({ wire: { ...base, action, message, adds, conflicts }, ...fields, addEmails, addPhones, target });
  });
  return { rows, ignored };
}

/** Every email and phone of the company's customers, as matched → who has it. */
async function existingKeys(db: CustomersDb, tenantId: string): Promise<Map<string, { id: string; name: string }>> {
  const rows = (await db
    .select({ id: customers.id, name: customers.name, matchKeys: customers.matchKeys })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), isNull(customers.mergedInto)))) as Array<{ id: string; name: string; matchKeys: string[] }>;
  const map = new Map<string, { id: string; name: string }>();
  for (const row of rows) for (const key of row.matchKeys) if (!map.has(key)) map.set(key, { id: row.id, name: row.name });
  return map;
}

function countsOf(rows: readonly PlannedRow[]): Record<ImportRowAction, number> {
  const counts: Record<ImportRowAction, number> = { create: 0, update: 0, "same-as-row": 0, error: 0 };
  for (const row of rows) counts[row.wire.action] += 1;
  return counts;
}

/** What importing this file would do, row by row — what each adds, and what it can't. Writes nothing. */
export async function previewCustomerImport(db: CustomersDb, tenantId: string, csv: string, options: { readonly defaultCountry?: string } = {}): Promise<ImportPreviewResponse> {
  const { rows, ignored } = plan(csv, await existingKeys(db, tenantId), options.defaultCountry ?? "US");
  return { rows: rows.map((row) => row.wire), counts: countsOf(rows), ignoredColumns: ignored };
}

function addAll(into: string[], more: readonly string[], max: number): boolean {
  let changed = false;
  for (const item of more) {
    if (!into.includes(item) && into.length < max) {
      into.push(item);
      changed = true;
    }
  }
  return changed;
}

/** One batch, in one transaction: new customers in one insert, matches updated from one read, addresses in one insert. */
async function applyBatch(db: CustomersDb, tenantId: string, batch: readonly PlannedRow[], resolved: Map<string, string>): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  await db.transaction(async (tx) => {
    // 1. The file's new customers: the first row of each person, in one insert.
    const fresh = new Map<string, PlannedRow>();
    const inserted = new Set<PlannedRow>();
    for (const row of batch) if (row.target?.startsWith("row:") && !resolved.has(row.target) && !fresh.has(row.target)) fresh.set(row.target, row);
    if (fresh.size > 0) {
      const values = [...fresh.entries()].map(([target, row]) => ({
        id: newId(),
        target,
        tenantId,
        name: row.name,
        companyName: row.companyName,
        emails: [...row.addEmails],
        phones: [...row.addPhones],
        matchKeys: [...row.addEmails.map((email) => emailMatchKey(email)!), ...row.addPhones.map((phone) => `p:${phone}`)],
        emailKey: row.addEmails[0] ? emailMatchKey(row.addEmails[0]) : null,
        phoneKey: row.addPhones[0] ? `p:${row.addPhones[0]}` : null,
        notes: row.notes,
        tags: [...row.tags],
        createdFrom: "import",
      }));
      const insertedIds = (await tx
        .insert(customers)
        .values(values.map(({ target: _target, ...value }) => value))
        .onConflictDoNothing()
        .returning({ id: customers.id })) as Array<{ id: string }>;
      const made = new Set(insertedIds.map((row) => row.id));
      for (const value of values) {
        if (made.has(value.id)) {
          resolved.set(value.target, value.id);
          inserted.add(fresh.get(value.target)!);
          created += 1;
          continue;
        }
        // Someone saved this customer a moment ago: theirs, by its email or phone.
        const key = value.emailKey ?? value.phoneKey;
        if (!key) continue;
        const [theirs] = (await tx
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.tenantId, tenantId), isNull(customers.mergedInto), key.startsWith("e:") ? eq(customers.emailKey, key) : eq(customers.phoneKey, key)))
          .limit(1)) as Array<{ id: string }>;
        if (theirs) resolved.set(value.target, theirs.id);
      }
    }
    // 2. Every row that adds to a customer who exists (or was just made): one read, changes in memory, one write each.
    const targetOf = (row: PlannedRow) => (row.target ? (resolved.get(row.target) ?? (row.target.startsWith("row:") ? null : row.target)) : null);
    const ids = [...new Set(batch.map(targetOf).filter((id): id is string => id !== null))];
    const current = ids.length
      ? ((await tx.select().from(customers).where(and(eq(customers.tenantId, tenantId), inArray(customers.id, ids)))) as CustomerRow[])
      : [];
    const byId = new Map(current.map((row) => [row.id, { row, emails: [...row.emails], phones: [...row.phones], keys: [...row.matchKeys], tags: [...row.tags], notes: row.notes, changed: false }]));
    const addresses: Array<{ tenantId: string; customerId: string; text: string; matchKey: string }> = [];
    for (const row of batch) {
      const id = targetOf(row);
      const draft = id ? byId.get(id) : undefined;
      if (!id || !draft) continue;
      if (row.wire.action === "update") updated += 1;
      if (!inserted.has(row)) {
        draft.changed = addAll(draft.emails, row.addEmails, 10) || draft.changed;
        draft.changed = addAll(draft.phones, row.addPhones, 10) || draft.changed;
        draft.changed = addAll(draft.keys, [...row.addEmails.map((email) => emailMatchKey(email)!), ...row.addPhones.map((phone) => `p:${phone}`)], 40) || draft.changed;
        const before = draft.tags.length;
        for (const tag of row.tags) if (tag && !draft.tags.some((kept) => kept.toLowerCase() === tag.toLowerCase()) && draft.tags.length < 20) draft.tags.push(tag);
        if (draft.tags.length !== before) draft.changed = true;
        if (row.notes && !(draft.notes ?? "").includes(row.notes)) {
          draft.notes = [draft.notes, row.notes].filter(Boolean).join("\n\n").slice(0, 5_000);
          draft.changed = true;
        }
      }
      const key = addressMatchKey(row.address);
      if (row.address && key) addresses.push({ tenantId, customerId: id, text: row.address, matchKey: key });
    }
    for (const draft of byId.values()) {
      if (!draft.changed) continue;
      await tx
        .update(customers)
        .set({
          emails: draft.emails,
          phones: draft.phones,
          matchKeys: draft.keys,
          emailKey: draft.row.emailKey ?? (draft.emails[0] ? emailMatchKey(draft.emails[0]) : null),
          phoneKey: draft.row.phoneKey ?? (draft.phones[0] ? `p:${draft.phones[0]}` : null),
          tags: draft.tags,
          notes: draft.notes,
          updatedAt: new Date(),
        })
        .where(and(eq(customers.id, draft.row.id), eq(customers.tenantId, tenantId)));
    }
    if (addresses.length > 0) await tx.insert(customerAddresses).values(addresses).onConflictDoNothing();
  });
  return { created, updated };
}

/**
 * Import the file, from data row `fromRow` (0, the first after the heading),
 * at most IMPORT_ROWS_PER_CALL rows: the rows the preview said "create"
 * become customers (each person once), the rest add to who they match. Rows
 * with a problem are left out and handed back. Call again from `nextRow`
 * until it is null.
 */
export async function applyCustomerImport(
  db: CustomersDb,
  tenantId: string,
  csv: string,
  options: { readonly defaultCountry?: string; readonly fromRow?: number; readonly maxRows?: number; readonly batchRows?: number } = {},
): Promise<ImportApplyResponse> {
  const { rows } = plan(csv, await existingKeys(db, tenantId), options.defaultCountry ?? "US");
  const from = Math.min(Math.max(Math.floor(options.fromRow ?? 0), 0), rows.length);
  const to = Math.min(rows.length, from + Math.max(1, options.maxRows ?? IMPORT_ROWS_PER_CALL));
  const size = Math.max(1, options.batchRows ?? IMPORT_BATCH_ROWS);
  const resolved = new Map<string, string>();
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (let start = from; start < to; start += size) {
    const batch = rows.slice(start, Math.min(to, start + size));
    try {
      const done = await applyBatch(db, tenantId, batch, resolved);
      created += done.created;
      updated += done.updated;
      skipped += batch.filter((row) => row.wire.action === "error").length;
    } catch {
      const saved = start === 0 ? "No rows were saved." : `Rows 2 to ${(start + 1).toLocaleString("en-US")} were saved.`;
      return {
        created,
        updated,
        skipped,
        errors: rows.slice(from, start).filter((row) => row.wire.action === "error").map((row) => row.wire),
        done: start,
        total: rows.length,
        nextRow: start,
        problem: `${saved} Saving rows ${(start + 2).toLocaleString("en-US")} to ${(Math.min(to, start + size) + 1).toLocaleString("en-US")} didn't work. Press Continue to try again from row ${(start + 2).toLocaleString("en-US")}; nothing already saved is added twice.`,
      };
    }
  }
  return {
    created,
    updated,
    skipped,
    errors: rows.slice(from, to).filter((row) => row.wire.action === "error").map((row) => row.wire),
    done: to,
    total: rows.length,
    nextRow: to < rows.length ? to : null,
    problem: null,
  };
}
