import { commsMessages, commsTemplates, type CommsSenders, type OutboundEmail } from "@adminigloo/comms";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInvoicingComms, INVOICE_EMAIL_TEMPLATES, invoiceEmailVars, HELD_MESSAGE } from "../comms.js";
import { resolveInvoicingBusiness } from "../business.js";
import { createInvoice, createInvoicingAdminHandlers, setInvoiceStatus, type InvoicingBusiness } from "../index.js";
import type { SendResponse } from "../wire.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The invoice email (Tenancy 2a, 10.6) through the REAL comms package on one
 * database: the wording's variables worked out by code, the company's name
 * and reply-to on the message (comms' identity), the token scrubbed from the
 * delivery log right after the send and by the sweep, and one idempotency
 * key per deliberate send.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ comms: true });
});
afterAll(async () => {
  await t.close();
});

const GREEN: InvoicingBusiness = {
  name: "Green Acres",
  timeZone: "America/Denver",
  contactEmail: "gail@greenacres.test",
  contactPhone: "(801) 555-0100",
  logoUrl: null,
  brandColor: null,
  paymentInstructions: "Pay by check to Green Acres LLC.",
  dueDays: 14,
  footer: null,
};

function capture() {
  const sent: OutboundEmail[] = [];
  return {
    sent,
    senders: {
      email: async (m: OutboundEmail) => {
        sent.push(m);
        return { id: `em_${sent.length}` };
      },
      identity: () => ({ name: "Green Acres", replyTo: "gail@greenacres.test" }),
    } satisfies CommsSenders,
  };
}

async function sentInvoice(tenantId: string, extra: Record<string, unknown> = {}) {
  const created = await createInvoice(t.db, {
    tenantId,
    customerName: "Pat Customer",
    customerEmail: "pat@example.com",
    dueDate: new Date("2026-11-03T06:59:59.999Z"),
    items: [{ description: "Fall cleanup", quantity: 1, unitPrice: 42_000 }],
    ...extra,
  });
  await setInvoiceStatus(t.db, { tenantId, id: created.id, status: "sent" });
  return created;
}

describe("invoiceEmailVars", () => {
  it("formats money, the due date in the zone, and the optional phrases", () => {
    const business = resolveInvoicingBusiness(GREEN);
    const vars = invoiceEmailVars(
      { invoiceNumber: "INV-2026-0007", customerName: "  ", total: 123_456, dueDate: new Date("2026-11-03T06:59:59.999Z") },
      business,
      "https://app.test/t/green-acres/invoice/inv_x",
    );
    expect(vars).toEqual({
      invoiceNumber: "INV-2026-0007",
      businessName: "Green Acres",
      customerName: "there",
      total: "$1,234.56",
      dueLine: ", due Nov 2, 2026",
      invoiceUrl: "https://app.test/t/green-acres/invoice/inv_x",
      paymentInstructions: "Pay by check to Green Acres LLC.",
      phoneLine: " or call (801) 555-0100",
    });
    const bare = invoiceEmailVars({ invoiceNumber: "N", customerName: "Lee", total: 100, dueDate: null }, resolveInvoicingBusiness({ ...GREEN, contactPhone: null, paymentInstructions: null }), null);
    expect(bare).toMatchObject({ dueLine: "", phoneLine: "", paymentInstructions: "", invoiceUrl: "", customerName: "Lee" });
  });
});

describe("createInvoicingComms", () => {
  it("sends as the company, with the link, and scrubs the token from the log right after", async () => {
    const a = tenant();
    const inv = await sentInvoice(a);
    const c = capture();
    const comms = createInvoicingComms({
      db: t.db,
      senders: c.senders,
      invoiceUrl: (token) => `https://app.test/t/green-acres/invoice/${token}`,
      business: () => GREEN,
    });
    const outcome = await comms.sendInvoice({ tenantId: a, invoiceId: inv.id, userId: "u1" });
    expect(outcome).toEqual({ status: "sent", message: "Emailed to pat@example.com." });
    const mail = c.sent[0]!;
    expect(mail).toMatchObject({ tenantId: a, fromName: "Green Acres", replyTo: "gail@greenacres.test", to: "pat@example.com" });
    expect(mail.subject).toBe(`Invoice ${inv.invoiceNumber} from Green Acres`);
    expect(mail.body).toContain(`See it here: https://app.test/t/green-acres/invoice/${inv.viewToken}`);
    expect(mail.body).toContain("for $420.00, due Nov 2, 2026.");
    expect(mail.body).toContain("Questions? Just reply to this email or call (801) 555-0100.");
    expect(mail.idempotencyKey).toBe(`invoice:${inv.id}:sent:0`);
    const [row] = await t.db.select().from(commsMessages).where(eq(commsMessages.tenantId, a));
    expect(row?.body).not.toContain(inv.viewToken);
    expect(row?.body).toContain("https://app.test/t/green-acres/invoice/:token");
    expect(row).toMatchObject({ fromName: "Green Acres", replyTo: "gail@greenacres.test", templateKey: "invoice_sent" });
  });

  it("an email the company's sending allowance holds back says so in plain words (review SEC-2A-03)", async () => {
    const a = tenant();
    const inv = await sentInvoice(a);
    const c = capture();
    const comms = createInvoicingComms({
      db: t.db,
      senders: { ...c.senders, allowance: () => false },
      invoiceUrl: (x) => `https://app.test/i/${x}`,
      business: () => GREEN,
    });
    const outcome = await comms.sendInvoice({ tenantId: a, invoiceId: inv.id, userId: null });
    expect(outcome).toEqual({ status: "failed", message: HELD_MESSAGE });
    expect(c.sent).toHaveLength(0);
  });

  it("a blank line folds away in the HTML part when there are no payment instructions", async () => {
    const a = tenant();
    const inv = await sentInvoice(a);
    const c = capture();
    const comms = createInvoicingComms({ db: t.db, senders: c.senders, invoiceUrl: (x) => `https://app.test/i/${x}`, business: () => ({ ...GREEN, paymentInstructions: null }) });
    await comms.sendInvoice({ tenantId: a, invoiceId: inv.id, userId: null });
    const html = c.sent[0]!.html;
    expect(html).not.toMatch(/<p>\s*<\/p>/);
    expect(html.split("<p>").length - 1).toBe(5);
  });

  it("a double click is one key; a deliberate resend later is a new one", async () => {
    const a = tenant();
    const inv = await sentInvoice(a);
    const c = capture();
    const comms = createInvoicingComms({ db: t.db, senders: c.senders, invoiceUrl: (x) => `https://app.test/i/${x}`, business: () => GREEN });
    await Promise.all([
      comms.sendInvoice({ tenantId: a, invoiceId: inv.id, userId: null }),
      comms.sendInvoice({ tenantId: a, invoiceId: inv.id, userId: null }),
    ]);
    await comms.sendInvoice({ tenantId: a, invoiceId: inv.id, userId: null });
    const keys = c.sent.map((m) => m.idempotencyKey);
    // The two at once both count 0 before either is logged: one key, so the
    // provider drops the second. Both rows are then in the log, so the
    // deliberate resend counts 2: a new key, and it goes.
    expect(keys[0]).toBe(`invoice:${inv.id}:sent:0`);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(`invoice:${inv.id}:sent:2`);
  });

  it("another invoice whose number starts the same doesn't count", async () => {
    const a = tenant();
    const inv = await sentInvoice(a);
    // A log row for a DIFFERENT invoice number that begins with this one.
    await t.db.insert(commsMessages).values({
      tenantId: a,
      channel: "email",
      toAddress: "pat@example.com",
      templateKey: "invoice_sent",
      subject: `Invoice ${inv.invoiceNumber}0 from Green Acres`,
      body: `Here's invoice ${inv.invoiceNumber}0`,
      status: "sent",
    });
    const c = capture();
    const comms = createInvoicingComms({ db: t.db, senders: c.senders, invoiceUrl: (x) => `https://app.test/i/${x}`, business: () => GREEN });
    await comms.sendInvoice({ tenantId: a, invoiceId: inv.id, userId: null });
    expect(c.sent[0]!.idempotencyKey).toBe(`invoice:${inv.id}:sent:0`);
  });

  it("no customer email: no-email, nothing logged", async () => {
    const a = tenant();
    const inv = await sentInvoice(a, { customerEmail: null });
    const c = capture();
    const comms = createInvoicingComms({ db: t.db, senders: c.senders, invoiceUrl: (x) => x, business: () => GREEN });
    expect(await comms.sendInvoice({ tenantId: a, invoiceId: inv.id, userId: null })).toEqual({
      status: "no-email",
      message: "This invoice has no customer email. Copy the link and send it yourself.",
    });
    expect(c.sent).toHaveLength(0);
    expect(await t.db.select().from(commsMessages).where(eq(commsMessages.tenantId, a))).toEqual([]);
  });

  it("no email provider: skipped, logged as who it would have been", async () => {
    const a = tenant();
    const inv = await sentInvoice(a);
    const comms = createInvoicingComms({
      db: t.db,
      senders: { identity: () => ({ name: "Green Acres", replyTo: "gail@greenacres.test" }) },
      invoiceUrl: (x) => `https://app.test/i/${x}`,
      business: () => GREEN,
    });
    expect((await comms.sendInvoice({ tenantId: a, invoiceId: inv.id, userId: null })).status).toBe("skipped");
    const [row] = await t.db.select().from(commsMessages).where(eq(commsMessages.tenantId, a));
    expect(row).toMatchObject({ status: "skipped", fromName: "Green Acres" });
    expect(row?.body).not.toContain(inv.viewToken);
  });

  it("another company's invoice id is not sent (it isn't there)", async () => {
    const a = tenant();
    const b = tenant();
    const inv = await sentInvoice(a);
    const c = capture();
    const comms = createInvoicingComms({ db: t.db, senders: c.senders, invoiceUrl: (x) => x, business: () => GREEN });
    expect((await comms.sendInvoice({ tenantId: b, invoiceId: inv.id, userId: null })).status).toBe("failed");
    expect(c.sent).toHaveLength(0);
  });

  it("ensureTemplates inserts once and never over an owner's edit", async () => {
    const a = tenant();
    const comms = createInvoicingComms({ db: t.db, senders: {}, invoiceUrl: (x) => x });
    expect(await comms.ensureTemplates(a)).toBe(1);
    await t.db.update(commsTemplates).set({ body: "Owner's own words" }).where(and(eq(commsTemplates.tenantId, a), eq(commsTemplates.key, "invoice_sent")));
    expect(await comms.ensureTemplates(a)).toBe(0);
    const [row] = await t.db.select().from(commsTemplates).where(eq(commsTemplates.tenantId, a));
    expect(row?.body).toBe("Owner's own words");
    expect(INVOICE_EMAIL_TEMPLATES.map((x) => x.key)).toEqual(["invoice_sent"]);
  });

  it("redactSent sweeps a token a crashed send left in the log", async () => {
    const a = tenant();
    const token = `inv_${"0123456789abcdef".repeat(2)}0123`;
    await t.db.insert(commsMessages).values({
      tenantId: a,
      channel: "email",
      toAddress: "pat@example.com",
      templateKey: "invoice_sent",
      subject: "Invoice",
      body: `See it here: https://app.test/i/${token}`,
      status: "sent",
    });
    const comms = createInvoicingComms({ db: t.db, senders: {}, invoiceUrl: (x) => x });
    expect(await comms.redactSent()).toBeGreaterThanOrEqual(1);
    const [row] = await t.db.select().from(commsMessages).where(eq(commsMessages.tenantId, a));
    expect(row?.body).toBe("See it here: https://app.test/i/:token");
  });

  it("wired into the admin handlers' Send", async () => {
    const a = tenant();
    const created = await createInvoice(t.db, { tenantId: a, customerName: "Pat", customerEmail: "pat@example.com", items: [{ description: "x", quantity: 1, unitPrice: 100 }] });
    const c = capture();
    const comms = createInvoicingComms({ db: t.db, senders: c.senders, invoiceUrl: (x) => `https://app.test/i/${x}`, business: () => GREEN });
    const h = createInvoicingAdminHandlers({
      db: t.db,
      tenantId: a,
      authorize: () => ({ userId: "u1" }),
      invoiceUrl: (x) => `https://app.test/i/${x}`,
      sendInvoiceEmail: comms.sendInvoice,
    });
    const res = await h.handle(new Request(`https://app.test/api/x/v1/admin/invoices/${created.id}/send`, { method: "POST", body: "{}" }));
    const body = (await res.json()) as SendResponse;
    expect(body).toMatchObject({ delivery: "sent", message: "Emailed to pat@example.com." });
    expect(body.invoice.storedStatus).toBe("sent");
    expect(c.sent).toHaveLength(1);
  });
});
