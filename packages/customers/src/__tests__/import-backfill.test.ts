import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backfillCustomers, type BackfillRecord } from "../backfill.js";
import { customerTimeline, exportCustomersCsv, findOrCreateCustomer, getCustomer, listCustomers } from "../customers.js";
import { decodeCsvBytes } from "../csv.js";
import { createDrizzleCustomerDirectory } from "../directory.js";
import { applyCustomerImport, IMPORT_MAX_ROWS, previewCustomerImport } from "../import.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});

const FILE = [
  "Name,Email,Phone,Address,Tags,Favourite colour",
  "May Lee,may@example.com,(415) 555-0123,12 Elm St,vip,red",
  "Bo Diaz,bo@,415 555 0199,,,",
  ",nobody@example.com,,,,",
  "Mrs Lee,,415.555.0123,,repeat,",
  "Kim Park,KIM@example.com,,,,",
  "Ana Ruiz,ana@example.com; ana.work@example.com,12,,,",
].join("\n");

describe("CSV import", () => {
  it("previews row by row in plain words, deduping against the list and within the file, and writes nothing", async () => {
    const a = tenant();
    await findOrCreateCustomer(t.db, { tenantId: a, name: "Kimberly Park", email: "kim@example.com" });
    const preview = await previewCustomerImport(t.db, a, FILE);
    expect(preview.ignoredColumns).toEqual(["Favourite colour"]);
    expect(preview.counts).toEqual({ create: 1, update: 1, "same-as-row": 1, error: 3 });
    const byRow = new Map(preview.rows.map((row) => [row.row, row]));
    expect(byRow.get(2)).toMatchObject({ action: "create", message: "New customer." });
    expect(byRow.get(3)?.message).toBe('Row 3: "bo@" isn\'t an email address. Fix it in the file and preview again, or leave the row out.');
    expect(byRow.get(4)?.message).toContain("there's no name");
    expect(byRow.get(5)).toMatchObject({ action: "same-as-row", message: "Same customer as row 2 (May Lee): their details are added together." });
    expect(byRow.get(6)).toMatchObject({ action: "update" });
    expect(byRow.get(6)?.message).toContain("Already a customer: Kimberly Park");
    expect(byRow.get(7)?.message).toContain('we couldn\'t read "12" as a phone number');
    expect((await listCustomers(t.db, a)).customers).toHaveLength(1);
  });

  it("applies what the preview said: each person once, matches get what's new, problems handed back", async () => {
    const a = tenant();
    const kim = await findOrCreateCustomer(t.db, { tenantId: a, name: "Kimberly Park", email: "kim@example.com" });
    const done = await applyCustomerImport(t.db, a, FILE);
    expect(done).toMatchObject({ created: 1, updated: 1, skipped: 3 });
    expect(done.errors.map((row) => row.row)).toEqual([3, 4, 7]);
    const list = (await listCustomers(t.db, a)).customers;
    expect(list.map((row) => row.name).sort()).toEqual(["Kimberly Park", "May Lee"]);
    const may = list.find((row) => row.name === "May Lee")!;
    expect(await getCustomer(t.db, a, may.id)).toMatchObject({ phones: ["+14155550123"], tags: ["vip", "repeat"], createdFrom: "import" });
    expect((await getCustomer(t.db, a, kim.customer.id))?.name).toBe("Kimberly Park");
    // Again: nothing new.
    expect(await applyCustomerImport(t.db, a, FILE)).toMatchObject({ created: 0 });
    expect((await listCustomers(t.db, a)).customers).toHaveLength(2);
  });

  it(`refuses a file of more than ${IMPORT_MAX_ROWS} customers, and one with no columns it can read`, async () => {
    const big = ["Name", ...Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `Person ${i}`)].join("\n");
    await expect(previewCustomerImport(t.db, tenant(), big)).rejects.toThrow("Import at most 5,000 at a time");
    await expect(previewCustomerImport(t.db, tenant(), "Colour,Size\nred,9")).rejects.toThrow("couldn't find a Name, Email or Phone column");
    await expect(previewCustomerImport(t.db, tenant(), "")).rejects.toThrow("empty");
  });
});

describe("backfill", () => {
  const records = (n: number): BackfillRecord[] =>
    Array.from({ length: n }, (_, i) => ({
      kind: i % 2 === 0 ? "estimate" : "invoice",
      refId: `r-${i}`,
      action: i % 2 === 0 ? "submitted" : "raised",
      occurredAt: new Date(Date.UTC(2025, 0, 1, 0, i)),
      summary: `Record ${i}`,
      name: `Person ${i % 5}`,
      email: i % 7 === 6 ? null : `person${i % 5}@example.com`,
    }));

  it("links a company's existing records in chunks, and running it again changes nothing", async () => {
    const a = tenant();
    const directory = createDrizzleCustomerDirectory(t.db);
    const progress: number[] = [];
    const first = await backfillCustomers(directory, a, records(23), { chunkSize: 5, onProgress: (p) => progress.push(p.seen) });
    expect(first).toEqual({ seen: 23, linked: 23, alreadyLinked: 0, skipped: 0, failed: 0 });
    expect(progress).toEqual([5, 10, 15, 20, 23]);
    const customers = (await listCustomers(t.db, a)).customers;
    // Five emailed people, plus the records with a name and no email (each its own customer, by name).
    expect(customers.filter((row) => row.email)).toHaveLength(5);
    const again = await backfillCustomers(directory, a, records(23), { chunkSize: 5 });
    expect(again).toEqual({ seen: 23, linked: 0, alreadyLinked: 23, skipped: 0, failed: 0 });
    expect((await listCustomers(t.db, a)).customers).toHaveLength(customers.length);
    const person0 = customers.find((row) => row.email === "person0@example.com")!;
    expect((await customerTimeline(t.db, a, person0.id))?.entries.length).toBeGreaterThan(0);
  });

  it("skips a record with nobody to belong to, and reads a stream", async () => {
    const a = tenant();
    async function* stream() {
      yield { kind: "order", refId: "o1", action: "paid", occurredAt: new Date(), summary: "Order" } satisfies BackfillRecord;
      yield { kind: "order", refId: "o2", action: "paid", occurredAt: new Date(), summary: "Order", email: "buyer@example.com" } satisfies BackfillRecord;
    }
    expect(await backfillCustomers(createDrizzleCustomerDirectory(t.db), a, stream())).toEqual({ seen: 2, linked: 1, alreadyLinked: 0, skipped: 1, failed: 0 });
  });
});

describe("import, the review's fixes (M3, M4, M5, L1)", () => {
  it("M3: works in batches and in calls, carrying on from nextRow, each person once across calls", async () => {
    const a = tenant();
    const lines = ["Name,Email,Phone"];
    for (let i = 0; i < 1_200; i += 1) lines.push(`Person ${i},person${i % 1_000}@example.com,`);
    const csv = lines.join("\n");
    const first = await applyCustomerImport(t.db, a, csv, { maxRows: 700, batchRows: 250 });
    expect(first).toMatchObject({ created: 700, done: 700, total: 1_200, nextRow: 700, problem: null });
    const second = await applyCustomerImport(t.db, a, csv, { fromRow: 700, maxRows: 700, batchRows: 250 });
    expect(second).toMatchObject({ created: 300, done: 1_200, nextRow: null });
    // Rows 1,000+ repeat the first 1,000 people: matched, not made again.
    let count = 0;
    for (let cursor: string | null = null; ; ) {
      const page = await listCustomers(t.db, a, { cursor });
      count += page.customers.length;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(count).toBe(1_000);
  });

  it("M3: a batch that fails says which rows were saved, and carrying on adds nothing twice", async () => {
    const a = tenant();
    const csv = ["Name,Email", ...Array.from({ length: 10 }, (_, i) => `P${i},p${i}@example.com`)].join("\n");
    let calls = 0;
    // A database that fails the SECOND batch's transaction.
    const flaky = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return (fn: (tx: unknown) => Promise<unknown>) => {
            calls += 1;
            if (calls === 2) return Promise.reject(new Error("connection lost"));
            return target.transaction(fn as never);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const broken = await applyCustomerImport(flaky, a, csv, { batchRows: 4 });
    expect(broken).toMatchObject({ created: 4, done: 4, nextRow: 4 });
    expect(broken.problem).toBe("Rows 2 to 5 were saved. Saving rows 6 to 9 didn't work. Press Continue to try again from row 6; nothing already saved is added twice.");
    const resumed = await applyCustomerImport(t.db, a, csv, { fromRow: broken.nextRow!, batchRows: 4 });
    expect(resumed).toMatchObject({ created: 6, nextRow: null, problem: null });
    expect((await listCustomers(t.db, a)).customers).toHaveLength(10);
  });

  it("M4: an export imports back as the same customers, phones and all", async () => {
    const a = tenant();
    const b = tenant();
    await findOrCreateCustomer(t.db, { tenantId: a, name: "May Lee", email: "may@example.com", phone: "415 555 0123", address: "12 Elm St, Apt 4", source: "staff" });
    await findOrCreateCustomer(t.db, { tenantId: a, name: "May Lee", phone: "415 555 0199", email: "may@example.com", source: "staff" });
    await findOrCreateCustomer(t.db, { tenantId: a, name: "Bo, Diaz", email: "bo@example.com", phone: "+44 20 7946 0958", source: "staff" });
    const exported = await exportCustomersCsv(t.db, a);
    expect(exported).toContain("+14155550123; +14155550199");
    expect(exported).not.toContain("'+");
    await applyCustomerImport(t.db, b, exported);
    const shape = async (tenantId: string) =>
      Promise.all((await listCustomers(t.db, tenantId)).customers.map(async (row) => {
        const card = (await getCustomer(t.db, tenantId, row.id))!;
        return { name: card.name, emails: card.emails, phones: card.phones, addresses: card.addresses.map((x) => x.text) };
      })).then((rows) => rows.sort((x, y) => x.name.localeCompare(y.name)));
    expect(await shape(b)).toEqual(await shape(a));
    // A spreadsheet's "'+1…" (kept as text) is still the phone.
    const quoted = await previewCustomerImport(t.db, tenant(), "Name,Phone\nQ,'+14155550123");
    expect(quoted.rows[0]).toMatchObject({ action: "create", phone: "+14155550123" });
  });

  it("M5: the preview names what each row adds, and a detail another customer has isn't added", async () => {
    const a = tenant();
    await findOrCreateCustomer(t.db, { tenantId: a, name: "May Lee", email: "may@example.com", source: "staff" });
    await findOrCreateCustomer(t.db, { tenantId: a, name: "Mr Kim", phone: "212 555 0199", source: "staff" });
    const csv = "Name,Email,Phone\nMay L,may@example.com; may.work@example.com,212-555-0199";
    const preview = await previewCustomerImport(t.db, a, csv);
    expect(preview.rows[0]).toMatchObject({
      action: "update",
      adds: ["email may.work@example.com"],
      conflicts: ["phone +12125550199 is already Mr Kim's, so it isn't added"],
    });
    await applyCustomerImport(t.db, a, csv);
    const may = (await listCustomers(t.db, a, { q: "may@example.com" })).customers[0]!;
    expect((await getCustomer(t.db, a, may.id))!).toMatchObject({ emails: ["may@example.com", "may.work@example.com"], phones: [] });
  });

  it("L1: a Windows-1252 file reads as itself, and text read the wrong way is refused with what to do", async () => {
    const bytes = Uint8Array.from([0x4e, 0x61, 0x6d, 0x65, 0x0a, 0x4a, 0x6f, 0x73, 0xe9]);
    expect(decodeCsvBytes(bytes)).toBe("Name\nJosé");
    expect(decodeCsvBytes(new TextEncoder().encode("Name\nJosé"))).toBe("Name\nJosé");
    await expect(previewCustomerImport(t.db, tenant(), `Name\nJos${String.fromCharCode(0xfffd)}`)).rejects.toThrow('"CSV UTF-8"');
  });
});
