/**
 * ONE CUSTOMER LIST (create-app 0.35), through @adminigloo/customers.
 *
 *   companies     each company's customers at /app/customers over
 *                 /api/app/{company id}/customers, on its own keys
 *                 (customers.view, customers.manage).
 *   one business  /admin/customers over /api/admin/customers, on staff keys.
 *
 * THE GLUE. Every installed feature tells src/server/customer-activity.ts what
 * happened — an estimate asked for, sent, accepted; a visit asked for, booked,
 * moved; an invoice raised, opened, paid; a call booked; a store order paid; a
 * message sent — through the seam it already has (the estimator's and
 * scheduling's LISTENERS, invoicing's `onEvent`, booking's `onEvent`, the
 * store's `onOrder`, comms' `onSent`), and the customer is found (by email,
 * else phone) or created INSIDE THAT COMPANY and the record linked to them.
 *
 * Emitted variants: every file below is one mode's or the other's, and lists
 * only the features this project has — never an `if` about the answers. Only
 * with --customers.
 */

import { tenantLabel, type Answers } from "./answers.js";
import { companiesMode } from "./tenancy-emit.js";

/** The feature records a customer's timeline links to, in this project. */
function linkedKinds(answers: Answers): string[] {
  return [
    ...(answers.includeEstimator ? ["estimate"] : []),
    ...(answers.includeScheduling ? ["visit"] : []),
    ...(answers.includeInvoicing ? ["invoice"] : []),
    ...(answers.includeBooking ? ["booking"] : []),
    ...(answers.includeStore ? ["order"] : []),
    ...(answers.includeComms ? ["message"] : []),
  ];
}

/** Where each kind of record opens, for the timeline's links. */
function recordHrefs(answers: Answers): string {
  const companies = companiesMode(answers);
  const base = companies ? "/app" : "/admin";
  const entries = [
    ...(answers.includeEstimator ? [`estimate: "${base}/estimates/{id}"`] : []),
    ...(answers.includeScheduling ? [`visit: "${base}/schedule"`] : []),
    ...(answers.includeInvoicing ? [`invoice: "${base}/invoices/{id}"`] : []),
    ...(answers.includeBooking ? [`booking: "${base}/calls"`] : []),
    ...(answers.includeStore ? [`order: "${base}/store"`] : []),
    ...(answers.includeComms ? [`message: "${companies ? "/app/messages" : "/admin/comms"}"`] : []),
  ];
  return `{ ${entries.join(", ")} }`;
}

// ---------------------------------------------------------------------------
// The seams the other emitters call (empty without --customers)
// ---------------------------------------------------------------------------

/** The scheduling / estimator LISTENERS entry, after the alerts and before the comms listener. */
export function customersListener(answers: Answers, feature: "Scheduling" | "Estimator"): string[] {
  return answers.includeCustomers ? [`(event) => customerOn${feature}Event(event)`] : [];
}

/** The import a notify module needs for its listener. */
export function customersListenerImport(answers: Answers, feature: "Scheduling" | "Estimator"): string {
  return answers.includeCustomers ? `import { customerOn${feature}Event } from "@/server/customer-activity";\n` : "";
}

/**
 * Invoicing's `onEvent`, as one expression: the alerts (when installed) and
 * then the customer list. Kept as `(event) => alertOnInvoicingEvent(event)…`
 * so the alerts producer's wiring reads as it always has.
 */
export function invoicingOnEvent(answers: Answers, param = "event"): string | null {
  const alerts = answers.includeNotifications;
  const customers = answers.includeCustomers;
  if (alerts && customers) return `(${param}) => alertOnInvoicingEvent(${param}).finally(() => customerOnInvoicingEvent(${param}))`;
  if (alerts) return `(${param}) => alertOnInvoicingEvent(${param})`;
  if (customers) return `(${param}) => customerOnInvoicingEvent(${param})`;
  return null;
}

export function invoicingCustomersImport(answers: Answers): string {
  return answers.includeCustomers ? `import { customerOnInvoicingEvent } from "@/server/customer-activity";\n` : "";
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Every file the customer list writes, by path (POSIX separators). */
export function customersFiles(answers: Answers): ReadonlyArray<readonly [string, string]> {
  if (!answers.includeCustomers) return [];
  const companies = companiesMode(answers);
  const files: Array<readonly [string, string]> = [
    ["src/server/customer-activity.ts", renderCustomerActivity(answers)],
    ["src/server/customers.ts", companies ? renderCompanyCustomersGlue(answers) : renderSingleCustomersGlue(answers)],
    ["scripts/customers-backfill.ts", renderBackfillScript(answers)],
  ];
  // The cross-feature proof: one customer's quote, visit, invoice raised and
  // paid, in order, inside one company only — through THIS project's hooks.
  if (companies && answers.includeEstimator && answers.includeScheduling && answers.includeInvoicing) {
    files.push(["src/server/__tests__/customer-timeline.test.ts", renderTimelineTest(answers)]);
  }
  if (companies) {
    files.push(["app/api/app/[tenantId]/customers/[...path]/route.ts", renderRoute(answers)], ["app/(site)/app/customers/page.tsx", renderCompanyPage(answers)]);
  } else {
    files.push(["app/api/admin/customers/[...path]/route.ts", renderRoute(answers)], ["app/admin/customers/page.tsx", renderAdminPage(answers)]);
  }
  return files;
}

/** Record pages that show "Customer: … →" exist (an estimate's, an invoice's). */
export function hasCustomerLinkPages(answers: Answers): boolean {
  return answers.includeEstimator || answers.includeInvoicing;
}

function renderCustomerActivity(answers: Answers): string {
  const scope = answers.scope;
  const noun = companiesMode(answers) ? tenantLabel(answers).toLowerCase() : "business";
  const est = answers.includeEstimator;
  const sched = answers.includeScheduling;
  const inv = answers.includeInvoicing;
  const booking = answers.includeBooking;
  const store = answers.includeStore;
  const comms = answers.includeComms;
  const imports = [
    ...(est && inv ? [`import { and, eq } from "drizzle-orm";`] : []),
    ...(booking ? [`import type { BookingEvent } from "${scope}/booking";`] : []),
    ...(comms ? [`import type { CommsSent } from "${scope}/comms";`] : []),
    ...(store ? [`import type { StoreOrderPlaced } from "${scope}/commerce/store";`] : []),
    `import { createDrizzleCustomerDirectory, recordCustomerActivity, type CustomerActivity } from "${scope}/customers/server";`,
    ...(est ? [`import type { EstimatorEvent } from "${scope}/estimator";`] : []),
    ...(inv ? [`import { ${est ? "invoices, " : ""}type InvoicingEvent } from "${scope}/invoicing";`] : []),
    ...(sched ? [`import type { SchedulingEvent } from "${scope}/scheduling";`] : []),
    `import { db } from "@/db";`,
    `import { reportError } from "@/server/error-reporter";`,
    `import { log } from "@/server/logger";`,
  ];
  const parts: string[] = [];
  if (est) {
    parts.push(`
/** What happened to an estimate, as its timeline says it. Other estimate events add nothing. */
const ESTIMATE_STEPS: Partial<Record<EstimatorEvent["type"], readonly [action: string, words: string]>> = {
  "lead.received": ["submitted", "asked for online"],
  "quote.sent": ["sent", "sent"],
  "quote.accepted": ["accepted", "accepted"],
  "quote.declined": ["declined", "declined"],
};

/**
 * The estimator's listener (src/server/estimator-notify.ts): the customer the
 * estimate names, found or created, and the estimate on their timeline.${inv ? `
 * When a quote becomes an invoice (\`estimate.converted\`), the invoice goes on
 * the same customer's timeline as raised.` : ""}
 */
export async function customerOnEstimatorEvent(event: EstimatorEvent): Promise<void> {
  const estimate = event.data.estimate;
  const step = ESTIMATE_STEPS[event.type];
  if (step) {
    await note({
      tenantId: event.tenantId,
      kind: "estimate",
      refId: event.estimateId,
      action: step[0],
      // A quote sent again is a new entry; the same event told twice is not.
      occurrence: event.type === "quote.sent" ? String(estimate.quoteSequence) : "",
      // What a customer typed on the form never changes a customer it matches (staff vouch for their own).
      source: event.actor.type === "staff" ? "staff" : "public",
      occurredAt: new Date(event.occurredAt),
      summary: \`Quote \${estimate.number} \${step[1]} · \${money(estimate.total, estimate.currency)}\`,
      name: estimate.customerName,
      email: estimate.customerEmail,
      phone: estimate.customerPhone,
      address: estimate.jobAddress,
    });
  }${inv ? `
  if (event.type === "estimate.converted") {
    try {
      const [invoice] = await db
        .select({ id: invoices.id, number: invoices.invoiceNumber, total: invoices.total })
        .from(invoices)
        .where(and(eq(invoices.tenantId, event.tenantId), eq(invoices.estimateId, event.estimateId)))
        .limit(1);
      // The invoice is the quote's customer's: linked to them, and nothing about them changes.
      const owner = invoice ? await customerDirectory.linkedTo(event.tenantId, "estimate", event.estimateId) : null;
      if (invoice && owner) {
        await customerDirectory.link({
          tenantId: event.tenantId,
          customerId: owner.id,
          kind: "invoice",
          refId: invoice.id,
          action: "raised",
          occurredAt: new Date(event.occurredAt),
          summary: \`Invoice \${invoice.number} raised · \${money(Number(invoice.total), estimate.currency)}\`,
        });
      }
    } catch (error) {
      failed(error, event.tenantId, "invoice");
    }
  }` : ""}
}
`);
  }
  if (sched) {
    parts.push(`
const VISIT_STEPS: Partial<Record<SchedulingEvent["type"], readonly [action: string, words: string]>> = {
  "visit.requested": ["requested", "asked for"],
  "visit.confirmed": ["booked", "booked for"],
  "visit.rescheduled": ["moved", "moved to"],
  "visit.declined": ["declined", "declined for"],
  "visit.cancelled": ["cancelled", "cancelled for"],
  "visit.completed": ["completed", "done on"],
};

/** "Tue, Mar 3" from the visit's own date (its wall clock, so no zone maths). */
function visitDay(date: string): string {
  const day = new Date(\`\${date}T12:00:00Z\`);
  return Number.isNaN(day.getTime()) ? date : day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Scheduling's listener (src/server/scheduling-notify.ts): the visit on its customer's timeline. */
export async function customerOnSchedulingEvent(event: SchedulingEvent): Promise<void> {
  const step = VISIT_STEPS[event.type];
  if (!step) return;
  const visit = event.data.visit;
  await note({
    tenantId: event.tenantId,
    kind: "visit",
    refId: event.visitId,
    action: step[0],
    // A visit moved twice is two entries (its sequence after each change).
    occurrence: String(visit.sequence),
    source: event.actor.type === "staff" ? "staff" : "public",
    occurredAt: new Date(event.occurredAt),
    summary: \`\${visit.serviceName} \${step[1]} \${visitDay(visit.date)} at \${visit.startTime}\`,
    name: visit.customerName,
    email: visit.customerEmail,
    phone: visit.customerPhone,
    address: visit.address,
  });
}
`);
  }
  if (inv) {
    parts.push(`
const INVOICE_STEPS: Readonly<Record<InvoicingEvent["type"], readonly [action: string, words: string]>> = {
  "invoice.created": ["raised", "raised"],
  "invoice.viewed": ["opened", "opened by the customer"],
  "invoice.paid": ["paid", "paid"],
};

/**
 * Invoicing's \`onEvent\` (src/server/invoicing.ts${answers.includeInvoicing ? ", and the card payments webhook" : ""}):
 * an invoice raised, opened or paid, on its customer's timeline. A payment
 * lands on the customer the invoice was raised for.
 */
export async function customerOnInvoicingEvent(event: InvoicingEvent): Promise<void> {
  const invoice = event.data.invoice;
  const step = INVOICE_STEPS[event.type];
  if (!step) return;
  await note({
    tenantId: event.tenantId,
    kind: "invoice",
    refId: event.invoiceId,
    action: step[0],
    // Paid, reversed and paid again is two entries; the same payment told twice is one.
    occurrence: event.type === "invoice.paid" ? (invoice.paidAt ?? event.occurredAt) : "",
    source: event.actor.type === "staff" ? "staff" : "public",
    occurredAt: new Date(event.occurredAt),
    summary: \`Invoice \${invoice.number} \${step[1]} · \${money(invoice.total, event.data.format.currency, event.data.format.locale)}\`,
    name: invoice.customerName,
    email: invoice.customerEmail,
    phone: invoice.customerPhone ?? null,
  });
}
`);
  }
  if (booking) {
    parts.push(`
/** A call's start, in the customer's zone (else the host's): "Tue, Mar 3, 9:00 AM". */
function callTime(start: Date, zone: string): string {
  try {
    return start.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone });
  } catch {
    return start.toISOString();
  }
}

/**
 * Booking's \`onEvent\` (src/server/booking.ts): a call booked, moved,
 * confirmed or cancelled, on the caller's timeline. Never logs the event: a
 * new booking's carries its private manage link.
 */
export async function customerOnBookingEvent(event: BookingEvent): Promise<void> {
  const call = event.booking;
  const words =
    event.event === "booking.created" ? ["booked", "booked for"] : event.event === "booking.rescheduled" ? ["moved", "moved to"] : event.event === "booking.cancelled" ? ["cancelled", "cancelled for"] : ["confirmed", "confirmed for"];
  await note({
    tenantId: event.tenantId,
    kind: "booking",
    refId: call.id,
    action: words[0]!,
    occurrence: String(call.sequence),
    // The caller typed these on the booking page: public.
    source: "public",
    occurredAt: new Date(),
    summary: \`\${call.typeName ?? "Call"} \${words[1]} \${callTime(call.start, call.inviteeTimezone ?? call.hostTimezone)}\`,
    name: call.inviteeName,
    email: call.inviteeEmail,
    phone: call.inviteePhone,
    companyName: call.inviteeCompany,
  });
}
`);
  }
  if (store) {
    parts.push(`
/** The store's \`onOrder\` (src/server/store.ts): a paid order on its buyer's timeline. Told again on a retry; linked once. */
export async function customerOnStoreOrder(order: StoreOrderPlaced): Promise<void> {
  const to = order.shipTo;
  const address = to ? [to.line1, to.line2, to.city, to.region, to.postalCode, to.country].filter(Boolean).join(", ") : null;
  await note({
    tenantId: order.tenantId,
    kind: "order",
    refId: order.orderId,
    action: "paid",
    // The buyer typed these at checkout: public.
    source: "public",
    occurredAt: order.placedAt,
    summary: \`Order \${order.orderNumber} paid · \${money(order.totalMinor, order.currency)}\`,
    name: to?.name ?? null,
    email: order.email,
    phone: to?.phone ?? null,
    address: address || null,
  });
}
`);
  }
  if (comms) {
    parts.push(`
/**
 * comms' \`onSent\` (src/server/comms-senders.ts): a message that went, on the
 * timeline of the customer it went to. Only a customer the ${noun} already
 * has: an office notice to the owner makes nobody a customer.
 */
export async function customerOnMessageSent(sent: CommsSent): Promise<void> {
  await note({
    tenantId: sent.tenantId,
    kind: "message",
    refId: sent.messageId,
    action: "sent",
    occurredAt: sent.at,
    summary: sent.channel === "sms" ? "Text sent" : \`Email sent: \${sent.subject ?? "a message"}\`,
    ...(sent.channel === "sms" ? { phone: sent.to } : { email: sent.to }),
    mode: "find",
  });
}
`);
  }
  return `${imports.join("\n")}

/**
 * WHAT EACH FEATURE TELLS THE CUSTOMER LIST (create-app 0.35). Generated for
 * the features this project has: ${linkedKinds(answers).join(", ") || "none"}.
 *
 * Each hook finds the customer the record names — the one it's already
 * linked to, else by email (and, for what staff entered, by phone), else a
 * new one — INSIDE THE
 * ${noun.toUpperCase()} THE EVENT IS FOR (\`tenantId\`, never anything the
 * customer sent), and puts the record on their timeline once. What a
 * customer typed on a public form (an estimate request, a booking, a store
 * order) NEVER changes a customer it matches: new details wait on their
 * record for Add or Ignore, and a form that matches only by phone makes a new
 * customer flagged "Might be the same person as …". A message links only to
 * the one customer who is exactly its address. A hook never
 * throws: a customer that couldn't be linked is logged and reported to
 * /admin/errors, and the feature's own work (the quote, the visit, the
 * payment) is never undone by it.
 *
 * \`customerDirectory\` is the seam: replace it with your own
 * \`CustomerDirectory\` to keep customers in a table of your own.
 */
export const customerDirectory = createDrizzleCustomerDirectory(db);

function failed(error: unknown, tenantId: string, kind: string): void {
  log.error({ err: error instanceof Error ? error.message : String(error), tenantId, kind }, "customers: a record couldn't be linked to its customer");
  void reportError({ error, source: "route", tenantId, context: { feature: "customers", kind } });
}

async function note(activity: CustomerActivity): Promise<void> {
  try {
    await recordCustomerActivity(customerDirectory, activity);
  } catch (error) {
    failed(error, activity.tenantId, activity.kind);
  }
}

/** An amount in minor units (cents), in its currency. */
function money(minor: number, currency: string, locale = "en-US"): string {
  try {
    const format = new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() });
    return format.format(minor / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
  } catch {
    return \`\${(minor / 100).toFixed(2)} \${currency.toUpperCase()}\`;
  }
}
${parts.join("")}`;
}

function renderCompanyCustomersGlue(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  return `import { createCustomersAdminHandlers, type CustomerRef } from "${scope}/customers/server";
import type { CustomerLinkKind } from "${scope}/customers";
import { db } from "@/db";
import { companyAuthorizer, companyRoutes, type FeatureHandlerOverrides } from "@/server/company-routes";
import { customerDirectory } from "@/server/customer-activity";
import { reportError } from "@/server/error-reporter";

/**
 * A ${noun.toUpperCase()}'S CUSTOMERS (create-app 0.35): /app/customers over
 * /api/app/{${noun} id}/customers — customers.view to look, customers.manage
 * to change, merge, import and export. The ${noun} is the one in the path,
 * asked on every call; another ${noun}'s customer is "not found".
 * \`overrides\` is how the project's isolation proof calls it as somebody else.
 */
export function buildCustomersAdminHandlers(overrides: FeatureHandlerOverrides = {}) {
  return createCustomersAdminHandlers({
    db,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer(overrides),
    onError: reportCustomersError,
  });
}

function reportCustomersError(error: unknown, context: { tenantId: string | null; route: string }): void {
  void reportError({ error, source: "route", tenantId: context.tenantId, context: { feature: "customers", route: context.route } });
}

/** The customer a record of this ${noun} is linked to ("Customer: Mrs Lee →"), or null. */
export async function customerForRecord(tenantId: string, kind: CustomerLinkKind, refId: string): Promise<CustomerRef | null> {
  try {
    return await customerDirectory.linkedTo(tenantId, kind, refId);
  } catch (error) {
    reportCustomersError(error, { tenantId, route: "record-link" });
    return null;
  }
}
`;
}

function renderSingleCustomersGlue(answers: Answers): string {
  const scope = answers.scope;
  return `import { customersPermissions, type CustomerLinkKind, type CustomersPermission } from "${scope}/customers";
import { createCustomersAdminHandlers, type CustomerRef } from "${scope}/customers/server";
import { db } from "@/db";
import { customerDirectory } from "@/server/customer-activity";
import { reportError } from "@/server/error-reporter";
import { authorizeStaffFor } from "@/server/staff-access";

/**
 * THE BUSINESS'S CUSTOMERS (create-app 0.35): /admin/customers over
 * /api/admin/customers, on the staff ladder (customers.view, customers.manage).
 */

/** The one business: every customer and link is written for it ("primary", like every feature's). */
export const CUSTOMERS_TENANT = "primary";

/** The staff keys the customer list is asked against: the package's own two. */
const CUSTOMERS_STAFF_KEYS: Readonly<Record<CustomersPermission, string>> = Object.fromEntries(
  Object.keys(customersPermissions).map((key) => [key, key]),
) as Record<CustomersPermission, string>;

export function buildCustomersAdminHandlers() {
  return createCustomersAdminHandlers({
    db,
    tenantId: CUSTOMERS_TENANT,
    authorize: authorizeStaffFor(CUSTOMERS_STAFF_KEYS, "Sign in to see customers."),
    onError: reportCustomersError,
  });
}

function reportCustomersError(error: unknown, context: { tenantId: string | null; route: string }): void {
  void reportError({ error, source: "route", tenantId: context.tenantId, context: { feature: "customers", route: context.route } });
}

/** The customer a record is linked to ("Customer: Mrs Lee →"), or null. */
export async function customerForRecord(_tenantId: string | undefined, kind: CustomerLinkKind, refId: string): Promise<CustomerRef | null> {
  try {
    return await customerDirectory.linkedTo(CUSTOMERS_TENANT, kind, refId);
  } catch (error) {
    reportCustomersError(error, { tenantId: CUSTOMERS_TENANT, route: "record-link" });
    return null;
  }
}
`;
}

function renderRoute(answers: Answers): string {
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  return `import { buildCustomersAdminHandlers } from "@/server/customers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** An import saves up to 2,000 rows a call (the screen carries on from where it stopped): well inside a minute. */
export const maxDuration = 60;

/**
 * ${companies ? `A ${noun}'s customers: /app/customers calls /api/app/{${noun} id}/customers/v1/admin/…` : "The customers: /admin/customers calls /api/admin/customers/v1/admin/…"} —
 * the list, one customer and their timeline, edits, merge, import and export
 * (CUSTOMERS_ADMIN_ROUTES). Never cross-origin.
 */
const { handle } = buildCustomersAdminHandlers();

export const GET = handle;
export const POST = handle;
`;
}

function renderCompanyPage(answers: Answers): string {
  const noun = tenantLabel(answers).toLowerCase();
  return `import { CustomersActions, CustomersAdmin } from "${answers.scope}/customers/admin";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader, WORK_MAIN, buttonClass } from "@/components/ui";

export const dynamic = "force-dynamic";

/** Where each record on a customer's timeline opens. */
const RECORD_HREFS = ${recordHrefs(answers)};

/**
 * The ${noun}'s customers (create-app 0.35): the list with search, and one
 * customer (?customer={id}) with everything of theirs on one timeline. The
 * package's screen over /api/app/{id}/customers, which checks the person's
 * permission on every call. Add customer, Import and Export sit in the page
 * header, beside the title, like every work page's actions (polish 3).
 */
export default async function CompanyCustomersPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const customerId = typeof query.customer === "string" ? query.customer : null;
  return (
    <CompanyGate path="/app/customers" permission="customers.view">
      {({ company, can, locale }) => (
        <main className={WORK_MAIN}>
          {/* The list gets the shared page header; one customer's page is
              headed by their own name, drawn by the widget. */}
          {customerId ? null : (
            <PageHeader
              title="Customers"
              description="Everyone who has asked for a quote, booked, been invoiced or bought from you, each with their whole history."
              actions={
                can.includes("customers.manage") ? (
                  <CustomersActions
                    baseUrl={\`/api/app/\${company.id}/customers\`}
                    primaryClassName={buttonClass("primary")}
                    secondaryClassName={buttonClass("secondary")}
                  />
                ) : null
              }
            />
          )}
          <CustomersAdmin
            baseUrl={\`/api/app/\${company.id}/customers\`}
            pageHref="/app/customers"
            customerId={customerId}
            recordHrefs={RECORD_HREFS}
            canManage={can.includes("customers.manage")}
            actionsInHeader
            title={false}
            locale={locale}
          />
        </main>
      )}
    </CompanyGate>
  );
}
`;
}

function renderAdminPage(answers: Answers): string {
  const scope = answers.scope;
  return `import { isDbConfigured } from "${scope}/db";
import { CustomersAdmin } from "${scope}/customers/admin";
import { db } from "@/db";
import { EmptyState, Notice, PageHeader } from "@/components/ui";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";

export const dynamic = "force-dynamic";

/** Where each record on a customer's timeline opens. */
const RECORD_HREFS = ${recordHrefs(answers)};

/**
 * THE CUSTOMERS (create-app 0.35): the list with search, and one customer
 * (?customer={id}) with everything of theirs on one timeline. The page checks
 * the staff key first so someone without it gets a sentence; the routes
 * check again on every call.
 */
export default async function CustomersPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!isDbConfigured(db)) {
    return (
      <>
        <PageHeader title="Customers" />
        <EmptyState title="No database yet">
          Customers are kept in this site&rsquo;s own database. Set DATABASE_URL and run the migrations.
        </EmptyState>
      </>
    );
  }
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("customers.view")) {
    return (
      <>
        <PageHeader title="Customers" />
        <Notice tone="warn">You don&rsquo;t have permission to see customers.</Notice>
      </>
    );
  }
  const query = await searchParams;
  return (
    <CustomersAdmin
      baseUrl="/api/admin/customers"
      pageHref="/admin/customers"
      customerId={typeof query.customer === "string" ? query.customer : null}
      recordHrefs={RECORD_HREFS}
      canManage={can.can("customers.manage")}
    />
  );
}
`;
}

/** src/components/CustomerLinkSlot.tsx: "Customer: Mrs Lee →" on a record's page, or nothing. */
export function renderCustomerLinkSlot(answers: Answers): string {
  const props = `props: {
  /** The ${companiesMode(answers) ? tenantLabel(answers).toLowerCase() : "business"} the record is in (a company's page passes its id; one business's pages leave it out). */
  readonly tenantId?: string;
  readonly kind: "estimate" | "invoice";
  readonly refId: string;
}`;
  if (!answers.includeCustomers) {
    return `import type { ReactNode } from "react";

/**
 * "Customer: … →" above an estimate or an invoice. Nothing: ${answers.projectName}
 * was generated without the customer list (--no-customers). \`create-app add
 * customers\` writes the link in here. (GENERATED in two variants; this is the
 * one without.)
 */
export async function CustomerLinkSlot(_${props}): Promise<ReactNode> {
  return null;
}
`;
  }
  const page = companiesMode(answers) ? "/app/customers" : "/admin/customers";
  return `import type { ReactNode } from "react";
import { customerForRecord } from "@/server/customers";

/**
 * "Customer: Mrs Lee →" above an estimate or an invoice: the customer it is
 * linked to, opening their page with everything else of theirs. Nothing when
 * the record isn't linked to anyone yet. A slot so the record pages render it
 * without an \`if\` about the customer list (GENERATED in two variants; this
 * is the one with it).
 */
export async function CustomerLinkSlot(${props}): Promise<ReactNode> {
  const customer = await customerForRecord(${companiesMode(answers) ? "props.tenantId ?? \"\"" : "props.tenantId"}, props.kind, props.refId);
  if (!customer) return null;
  return (
    <p className="mb-4 text-sm">
      <a className="font-medium underline underline-offset-2" href={\`${page}?customer=\${encodeURIComponent(customer.id)}\`}>
        Customer: {customer.name} &rarr;
      </a>
    </p>
  );
}
`;
}

// ---------------------------------------------------------------------------
// scripts/customers-backfill.ts
// ---------------------------------------------------------------------------

function renderBackfillScript(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const est = answers.includeEstimator;
  const sched = answers.includeScheduling;
  const inv = answers.includeInvoicing;
  const booking = answers.includeBooking;
  const store = answers.includeStore;
  const comms = answers.includeComms;
  const imports = [
    `import { and, asc, eq, gt${store && companies ? ", ne" : ""} } from "drizzle-orm";`,
    ...(booking ? [`import { bookingBookings } from "${scope}/booking/schema";`] : []),
    ...(comms ? [`import { commsMessages } from "${scope}/comms";`] : []),
    ...(store ? [`import { orders } from "${scope}/commerce/schema";`] : []),
    `import { backfillCustomers, createDrizzleCustomerDirectory, type BackfillRecord } from "${scope}/customers/server";`,
    ...(est ? [`import { estimatorEstimates } from "${scope}/estimator";`] : []),
    ...(inv ? [`import { invoices, resolveInvoicingBusiness } from "${scope}/invoicing";`] : []),
    ...(sched ? [`import { schedulingBookings } from "${scope}/scheduling";`] : []),
    `import { db } from "../src/db";`,
    ...(inv ? [`import { invoicingBusiness } from "../src/server/invoicing";`] : []),
  ];
  const sources: string[] = [];
  if (est) {
    sources.push(`  estimates: async function* (tenantId) {
    for await (const row of pages((after) => db.select().from(estimatorEstimates).where(and(eq(estimatorEstimates.tenantId, tenantId), gt(estimatorEstimates.id, after))).orderBy(asc(estimatorEstimates.id)).limit(PAGE))) {
      yield {
        kind: "estimate",
        refId: row.id,
        // An online request was "submitted" (the word the live hook uses); one staff wrote, "created".
        action: row.source === "staff" ? "created" : "submitted",
        // What a customer typed never changes a customer it matches.
        source: row.source === "staff" ? "staff" : "public",
        occurredAt: row.createdAt,
        summary: \`Quote \${row.estimateNumber} · \${money(Number(row.total), row.currency)}\`,
        name: row.customerName,
        email: row.customerEmail,
        phone: row.customerPhone,
        address: row.jobAddress,
      };
    }
  },`);
  }
  if (sched) {
    sources.push(`  visits: async function* (tenantId) {
    for await (const row of pages((after) => db.select().from(schedulingBookings).where(and(eq(schedulingBookings.tenantId, tenantId), gt(schedulingBookings.id, after))).orderBy(asc(schedulingBookings.id)).limit(PAGE))) {
      yield {
        kind: "visit",
        refId: row.id,
        action: row.status === "pending" ? "requested" : row.status === "cancelled" ? "cancelled" : "booked",
        source: row.origin === "staff" ? "staff" : "public",
        occurredAt: row.createdAt,
        summary: \`Visit \${row.status} for \${row.scheduledDate.toISOString().slice(0, 10)} at \${row.startTime}\`,
        name: row.customerName,
        email: row.customerEmail,
        phone: row.customerPhone,
        address: row.address,
      };
    }
  },`);
  }
  if (inv) {
    sources.push(`  invoices: async function* (tenantId) {
    // The company's own currency, as its invoices show it.
    const currency = resolveInvoicingBusiness(await invoicingBusiness(${companies ? "tenantId" : ""})).currency;
    for await (const row of pages((after) => db.select().from(invoices).where(and(eq(invoices.tenantId, tenantId), gt(invoices.id, after))).orderBy(asc(invoices.id)).limit(PAGE))) {
      // Staff made every invoice: their details are the business's own.
      const who = { name: row.customerName, email: row.customerEmail, phone: row.customerPhone, address: row.billingAddress, source: "staff" as const };
      yield { kind: "invoice", refId: row.id, action: "raised", occurredAt: row.createdAt, summary: \`Invoice \${row.invoiceNumber} raised · \${money(Number(row.total), currency)}\`, ...who };
      if (row.paidAt) yield { kind: "invoice", refId: row.id, action: "paid", occurredAt: row.paidAt, summary: \`Invoice \${row.invoiceNumber} paid · \${money(Number(row.total), currency)}\`, occurrence: row.paidAt.toISOString(), ...who };
    }
  },`);
  }
  if (booking) {
    sources.push(`  calls: async function* (tenantId) {
    for await (const row of pages((after) => db.select().from(bookingBookings).where(and(eq(bookingBookings.tenantId, tenantId), gt(bookingBookings.id, after))).orderBy(asc(bookingBookings.id)).limit(PAGE))) {
      if (row.status === "hold") continue;
      yield {
        kind: "booking",
        refId: row.id,
        action: row.status === "cancelled" ? "cancelled" : "booked",
        occurredAt: row.createdAt,
        summary: \`Call \${row.status === "cancelled" ? "cancelled" : "booked"} for \${row.startUtc.toISOString().slice(0, 16).replace("T", " ")} UTC\`,
        name: row.inviteeName,
        email: row.inviteeEmail,
        phone: row.inviteePhone,
        companyName: row.inviteeCompany,
        // The caller typed these on the booking page.
        source: "public",
      };
    }
  },`);
  }
  if (store) {
    sources.push(`  orders: async function* (tenantId) {
    for await (const row of pages((after) => db.select().from(orders).where(and(eq(orders.tenantId, tenantId), gt(orders.id, after))).orderBy(asc(orders.id)).limit(PAGE))) {
      if (row.status === "pending" || row.status === "cancelled") continue;
      const to = row.shippingAddress;
      yield {
        kind: "order",
        refId: row.id,
        action: "paid",
        occurredAt: row.placedAt ?? row.createdAt,
        summary: \`Order \${row.orderNumber} paid · \${money(Number(row.totalMinor), row.currency)}\`,
        name: to?.name ?? null,
        email: row.email,
        phone: to?.phone ?? null,
        address: to ? [to.line1, to.line2, to.city, to.region, to.postalCode, to.country].filter(Boolean).join(", ") || null : null,
        // The buyer typed these at checkout.
        source: "public",
      };
    }
  },`);
  }
  if (comms) {
    sources.push(`  messages: async function* (tenantId) {
    for await (const row of pages((after) => db.select().from(commsMessages).where(and(eq(commsMessages.tenantId, tenantId), gt(commsMessages.id, after))).orderBy(asc(commsMessages.id)).limit(PAGE))) {
      if (row.status !== "sent") continue;
      yield {
        kind: "message",
        refId: row.id,
        action: "sent",
        occurredAt: row.createdAt,
        summary: row.channel === "sms" ? "Text sent" : \`Email sent: \${row.subject ?? "a message"}\`,
        ...(row.channel === "sms" ? { phone: row.toAddress } : { email: row.toAddress }),
        // Only a customer the business already has: an office notice makes nobody a customer.
        mode: "find",
      };
    }
  },`);
  }
  const tables = [
    ...(est ? ["estimatorEstimates"] : []),
    ...(sched ? ["schedulingBookings"] : []),
    ...(inv ? ["invoices"] : []),
    ...(booking ? ["bookingBookings"] : []),
    ...(store ? ["orders"] : []),
    ...(comms ? ["commsMessages"] : []),
  ];
  return `/**
 * FILL THE CUSTOMER LIST FROM WHAT ${companies ? `EACH ${tenantLabel(answers).toUpperCase()}` : "THE BUSINESS"} ALREADY HAS (create-app 0.35).
 *
 *   pnpm customers:backfill${companies ? `                 every ${tenantLabel(answers).toLowerCase()}
 *   pnpm customers:backfill <${tenantLabel(answers).toLowerCase()} id>      just one` : ""}
 *
 * Reads every ${linkedKinds(answers).join(", ")} already in the database,
 * finds or creates its customer (by email, else phone, inside its own
 * ${companies ? tenantLabel(answers).toLowerCase() : "business"}), and puts it on their timeline. Safe to run again, and
 * safe while the app is running: a record already on a timeline is skipped,
 * so a second run changes nothing. Messages are linked only to customers who
 * already exist (it runs them last), and what a customer typed on a public
 * form never changes a customer it matches. Each record's action is checked
 * on its own: an invoice linked live as paid still gets its "raised". Works
 * in chunks of 200.
 *
 * WHICH DATABASE: DATABASE_URL from the environment, else .env.local.
 */
${imports.join("\n")}

try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local — the normal case in CI.
}

const directory = createDrizzleCustomerDirectory(db);
const PAGE = 500;

/** An amount in cents, as money. */
function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(minor / 100);
  } catch {
    return (minor / 100).toFixed(2);
  }
}

/** Every row a page reader gives, a page at a time, in id order. */
async function* pages<R extends { readonly id: string }>(page: (after: string) => Promise<R[]>): AsyncGenerator<R> {
  let after = "";
  for (;;) {
    const rows = await page(after);
    if (rows.length === 0) return;
    yield* rows;
    after = rows[rows.length - 1]!.id;
  }
}

/** Each feature's rows, as records the backfill links. Messages last: they only link to customers that exist. */
const SOURCES: Readonly<Record<string, (tenantId: string) => AsyncIterable<BackfillRecord>>> = {
${sources.join("\n")}
};

/** The ${companies ? "companies" : "business"} to fill: ${companies ? "the one named, else every one that has a record" : "the one business (\"primary\")"}. */
async function tenantsToFill(): Promise<string[]> {${companies ? `
  const named = process.argv[2]?.trim();
  if (named) return [named];
  const found = new Set<string>();
  const lists = await Promise.all([
${tables.map((table) => `    db.selectDistinct({ tenantId: ${table}.tenantId }).from(${table})${table === "orders" ? `.where(ne(orders.tenantId, "*"))` : ""},`).join("\n")}
  ]);
  for (const rows of lists) for (const row of rows) found.add(row.tenantId);
  return [...found].sort();` : `
  return ["primary"];`}
}

for (const tenantId of await tenantsToFill()) {
  for (const [name, source] of Object.entries(SOURCES)) {
    const result = await backfillCustomers(directory, tenantId, source(tenantId), {
      onError: (error, record) => console.error(\`  \${name} \${record.refId}: \${error instanceof Error ? error.message : String(error)}\`),
    });
    console.log(\`\${tenantId} · \${name}: \${result.linked} linked, \${result.alreadyLinked} already on a timeline, \${result.skipped} with nobody to link\${result.failed ? \`, \${result.failed} failed\` : ""}\`);
  }
}
process.exit(0);
`;
}

// ---------------------------------------------------------------------------
// src/server/__tests__/customer-timeline.test.ts (companies, estimator +
// scheduling + invoicing)
// ---------------------------------------------------------------------------

function renderTimelineTest(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  return `import { describe, expect, it, vi } from "vitest";
import { customerTimeline, getCustomer, listCustomers } from "${scope}/customers/server";
import type { EstimatorEvent } from "${scope}/estimator";
import type { InvoicingEvent } from "${scope}/invoicing";
import type { SchedulingEvent } from "${scope}/scheduling";

/**
 * ONE CUSTOMER, EVERY FEATURE, ONE ${noun.toUpperCase()} (create-app 0.35): a
 * customer asks for a quote, the visit is booked, an invoice is raised and
 * paid — each told to THIS project's hooks (src/server/customer-activity.ts),
 * as each feature's seam tells them — and the timeline shows all four in
 * order, inside ${noun} A only. ${noun.charAt(0).toUpperCase() + noun.slice(1)} B, with the same email and the same
 * invoice id, has a customer of its own and sees nothing of A's.
 *
 * PGlite on this project's own schema: nothing to set up.
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

const { db } = await import("@/db");
const { customerOnEstimatorEvent, customerOnInvoicingEvent, customerOnSchedulingEvent } = await import("@/server/customer-activity");

const A = "company-a-timeline";
const B = "company-b-timeline";
const at = (minutes: number) => new Date(Date.UTC(2026, 2, 3, 9, minutes)).toISOString();

function estimateEvent(tenantId: string): EstimatorEvent {
  return {
    id: \`evt-est-\${tenantId}\`,
    type: "lead.received",
    tenantId,
    estimateId: \`est-1\`,
    occurredAt: at(0),
    actor: { type: "customer", id: null },
    data: {
      estimate: { number: "Q-0001", quoteSequence: 0, total: 48_000, currency: "usd", customerName: "Mrs Lee", customerEmail: "May.Lee@example.com", customerPhone: "(415) 555-0123", jobAddress: "12 Elm St" } as unknown as EstimatorEvent["data"]["estimate"],
      notify: true,
    },
  };
}

function visitEvent(tenantId: string): SchedulingEvent {
  return {
    id: \`evt-visit-\${tenantId}\`,
    type: "visit.confirmed",
    tenantId,
    visitId: "visit-1",
    occurredAt: at(10),
    actor: { type: "staff", id: null },
    data: {
      visit: { serviceName: "Window cleaning", date: "2026-03-10", startTime: "09:00", sequence: 1, customerName: "May Lee", customerEmail: null, customerPhone: "+1 415 555 0123", address: "12 Elm St" } as unknown as SchedulingEvent["data"]["visit"],
      notify: true,
    },
  };
}

function invoiceEvent(tenantId: string, type: InvoicingEvent["type"], minutes: number, customer: boolean): InvoicingEvent {
  return {
    id: \`evt-inv-\${type}-\${tenantId}\`,
    type,
    tenantId,
    invoiceId: "inv-1",
    occurredAt: at(minutes),
    actor: { type: "staff", id: null },
    data: {
      invoice: {
        id: "inv-1",
        number: "INV-0001",
        status: type === "invoice.paid" ? "paid" : "draft",
        // The payment's event names nobody: it lands on the customer the invoice was raised for.
        customerName: customer ? "May Lee" : null,
        customerEmail: customer ? "may.lee@example.com" : null,
        total: 48_000,
        amountPaid: type === "invoice.paid" ? 48_000 : 0,
        balanceDue: type === "invoice.paid" ? 0 : 48_000,
        dueDate: null,
        viewedAt: null,
        paidAt: type === "invoice.paid" ? at(minutes) : null,
      },
      format: { currency: "USD", locale: "en-US", timeZone: "UTC" } as unknown as InvoicingEvent["data"]["format"],
    },
  };
}

describe("one customer's timeline, across the features (create-app 0.35)", () => {
  it("shows the quote, the visit, the invoice raised and paid, in order, inside ${noun} A only", async () => {
    await customerOnEstimatorEvent(estimateEvent(A));
    await customerOnSchedulingEvent(visitEvent(A));
    await customerOnInvoicingEvent(invoiceEvent(A, "invoice.created", 20, true));
    await customerOnInvoicingEvent(invoiceEvent(A, "invoice.paid", 30, false));
    // ${noun.charAt(0).toUpperCase() + noun.slice(1)} B: the same email, the same invoice id.
    await customerOnInvoicingEvent(invoiceEvent(B, "invoice.created", 25, true));

    const inA = (await listCustomers(db, A)).customers;
    expect(inA.map((customer) => customer.name)).toEqual(["Mrs Lee"]);
    const timeline = await customerTimeline(db, A, inA[0]!.id, { order: "oldest" });
    expect(timeline?.entries.map((entry) => [entry.kind, entry.action])).toEqual([
      ["estimate", "submitted"],
      ["visit", "booked"],
      ["invoice", "raised"],
      ["invoice", "paid"],
    ]);
    expect(timeline?.entries[0]?.summary).toBe("Quote Q-0001 asked for online · $480.00");

    const inB = (await listCustomers(db, B)).customers;
    expect(inB).toHaveLength(1);
    expect(inB[0]!.id).not.toBe(inA[0]!.id);
    expect(await customerTimeline(db, B, inA[0]!.id)).toBeNull();
    expect((await customerTimeline(db, B, inB[0]!.id))?.entries.map((entry) => entry.action)).toEqual(["raised"]);
  });

  it("tells the same thing twice as one entry", async () => {
    await customerOnEstimatorEvent(estimateEvent(A));
    const [lee] = (await listCustomers(db, A)).customers;
    expect((await customerTimeline(db, A, lee!.id))?.entries).toHaveLength(4);
  });

  it("a stranger's form with her email links the quote but changes nothing of hers", async () => {
    const stranger = estimateEvent(A);
    const form = {
      ...stranger,
      id: "evt-est-stranger",
      estimateId: "est-stranger",
      data: { ...stranger.data, estimate: { ...stranger.data.estimate, number: "Q-0666", customerName: "Evil", customerPhone: "212-555-0199", jobAddress: "666 Evil St" } },
    } as EstimatorEvent;
    await customerOnEstimatorEvent(form);
    const [lee] = (await listCustomers(db, A)).customers;
    const card = await getCustomer(db, A, lee!.id);
    expect(card?.name).toBe("Mrs Lee");
    expect(card?.phones).toEqual(["+14155550123"]);
    expect(card?.addresses.map((address) => address.text)).toEqual(["12 Elm St"]);
    expect(card?.notices.map((notice) => notice.kind)).toEqual(["new-details"]);
  });
});
`;
}
