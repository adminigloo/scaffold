/**
 * The Tenancy 2a proofs (contract section 12): a companies project proves, in
 * its own unit suite on its own schema (PGlite, nothing to set up), that
 *
 *   - one company can't reach another's rows through ANY feature route — the
 *     packages' own fetch handlers, private and public, driven from the
 *     route tables the packages publish (feature-isolation.test.ts);
 *   - the crons serve every active company, skip a suspended one, and one
 *     company's failure doesn't stop the rest (company-crons.test.ts);
 *   - each company's email goes out under its own name and reply-to, and its
 *     office notices to its own inbox (company-email.test.ts).
 *
 * Each is generated per installed feature: a feature that isn't installed
 * contributes no suite, no rows and no imports. The rows each company gets
 * are planted by one emitted helper (src/test/company-rows.ts), so both
 * companies hold the same kinds of rows and "nothing of A" is a real check
 * against a non-empty answer, not an empty list.
 */

import { tenantLabel, tenantLabelPlural, type Answers } from "./answers.js";
import { teamTemplateKeys } from "./alerts-files-emit.js";

interface FeatureSuite {
  readonly feature: string;
  readonly glue: string;
  readonly adminBuilder: string;
  readonly adminRoutes: string;
  /** The emitted expression for the suite's admin routes, when it isn't the table itself. */
  readonly adminRoutesExpr?: string;
  readonly adminSegment: string;
  readonly publicBuilder: string | null;
  readonly publicRoutes: string | null;
  readonly publicSegment: string | null;
  readonly pkg: string;
  /** The package's permission fragment (its keys and each key's default roles), for the role pass. */
  readonly permissions: string;
  /**
   * Tenancy 2b-1: how the proof builds the admin handler, when it isn't the
   * builder as it is — storage's is built over the proof's own memory stores
   * (14.1). Absent: `<adminBuilder>` itself.
   */
  readonly adminExpr?: string;
  /**
   * Tenancy 2b-2a: how the proof builds the public handler, when it isn't the
   * builder as it is — feedback's is given an in-memory screenshot store, so
   * its upload route reaches its own checks in a project with no file store.
   */
  readonly publicExpr?: string;
  /**
   * Tenancy 2b-1: the public routes the GENERIC public pass drives. Storage's
   * public routes (signed links, public files) are not company-scoped by
   * address, so they have their own suite (14.1) and none here.
   */
  readonly genericPublic?: boolean;
}

/** The installed features, as the isolation proof drives them (contract 12.1). */
function suitesFor(answers: Answers): readonly FeatureSuite[] {
  const suites: FeatureSuite[] = [];
  if (answers.includeScheduling) {
    suites.push({
      feature: "scheduling",
      glue: "@/server/scheduling",
      adminBuilder: "buildSchedulingAdminHandlers",
      adminRoutes: "SCHEDULING_ADMIN_ROUTES",
      adminSegment: "schedule",
      publicBuilder: "buildSchedulingPublicHandlers",
      publicRoutes: "SCHEDULING_PUBLIC_ROUTES",
      publicSegment: "schedule",
      pkg: "scheduling",
      permissions: "schedulingPermissions",
    });
  }
  if (answers.includeEstimator) {
    suites.push({
      feature: "estimator",
      glue: "@/server/estimator",
      adminBuilder: "buildEstimatorAdminHandlers",
      adminRoutes: "ESTIMATOR_ADMIN_ROUTES",
      adminSegment: "estimator",
      publicBuilder: "buildEstimatorPublicHandlers",
      publicRoutes: "ESTIMATOR_PUBLIC_ROUTES",
      publicSegment: "estimator",
      pkg: "estimator",
      permissions: "estimatorPermissions",
    });
  }
  if (answers.includeInvoicing) {
    suites.push({
      feature: "invoicing",
      glue: "@/server/invoicing",
      adminBuilder: "buildInvoicingAdminHandlers",
      adminRoutes: "INVOICING_ADMIN_ROUTES",
      adminSegment: "invoices",
      publicBuilder: "buildInvoicingPublicHandlers",
      publicRoutes: "INVOICING_PUBLIC_ROUTES",
      publicSegment: "invoices",
      pkg: "invoicing",
      permissions: "invoicingPermissions",
    });
  }
  // GETTING PAID, PART 1: a company's payments screen (connect its own Stripe
  // account, see it, disconnect it). Admin routes only: the customer's "Pay
  // now" is invoicing's public pay route, driven with the invoicing suite —
  // and, since part 2, the store's Check out, driven with the store's.
  if (answers.includeInvoicing || answers.includeStore) {
    suites.push({
      feature: "stripe",
      glue: "@/server/payments",
      adminBuilder: "buildPaymentsAdminHandlers",
      adminRoutes: "STRIPE_CONNECT_ADMIN_ROUTES",
      adminSegment: "payments",
      publicBuilder: null,
      publicRoutes: null,
      publicSegment: null,
      pkg: "stripe",
      permissions: "stripeConnectPermissions",
    });
  }
  // GETTING PAID, PART 2: a company's own store — its products, orders and
  // what needs attention at /app/store, its store page and Check out at its
  // web address.
  if (answers.includeStore) {
    suites.push({
      feature: "commerce",
      glue: "@/server/store",
      adminBuilder: "buildStoreAdminHandlers",
      adminRoutes: "STORE_ADMIN_ROUTES",
      adminSegment: "store",
      publicBuilder: "buildStorePublicHandlers",
      publicRoutes: "STORE_PUBLIC_ROUTES",
      publicSegment: "store",
      pkg: "commerce",
      permissions: "storeCompanyPermissions",
    });
  }
  if (answers.includeComms) {
    suites.push({
      feature: "comms",
      glue: "@/server/comms",
      adminBuilder: "buildCommsAdminHandlers",
      adminRoutes: "COMMS_ADMIN_ROUTES",
      adminSegment: "messages",
      publicBuilder: null,
      publicRoutes: null,
      publicSegment: null,
      pkg: "comms",
      permissions: "commsPermissions",
    });
  }
  // TENANCY 2b-1 (14.1): the alert and file routes, from their route tables.
  if (answers.includeNotifications) {
    suites.push({
      feature: "notifications",
      glue: "@/server/alerts-routes",
      adminBuilder: "buildAlertsHandlers",
      adminRoutes: "NOTIFICATIONS_ADMIN_ROUTES",
      adminSegment: "alerts",
      publicBuilder: null,
      publicRoutes: null,
      publicSegment: null,
      pkg: "notifications",
      permissions: "notificationsPermissions",
    });
  }
  if (answers.includeStorage) {
    suites.push({
      feature: "storage",
      glue: "@/server/files-routes",
      adminBuilder: "buildFilesHandlers",
      adminRoutes: "STORAGE_ADMIN_ROUTES",
      // With no record type installed (no visits, estimates or invoices), the
      // record routes answer "not found" for every company alike: there is
      // nothing of A's for them to reach, so they are left out of the pass.
      ...(answers.includeScheduling || answers.includeEstimator || answers.includeInvoicing
        ? {}
        : {
            adminRoutesExpr:
              '/* no record type here: the record routes reach nothing of anyone\'s */ STORAGE_ADMIN_ROUTES.filter((route) => route.access?.scope !== "record")',
          }),
      adminSegment: "files",
      publicBuilder: "buildFileLinkHandlers",
      publicRoutes: "STORAGE_PUBLIC_ROUTES",
      // A fixed base, /api/files/, in both modes: its own suite below.
      publicSegment: null,
      pkg: "storage",
      permissions: "storagePermissions",
      adminExpr: "(overrides) => buildFilesHandlers({ ...overrides, storage: fx.storage })",
      genericPublic: false,
    });
  }
  // TENANCY 2b-2a: a company's feedback board and its public feedback page.
  if (answers.includeFeedback) {
    suites.push({
      feature: "feedback",
      glue: "@/server/feedback",
      adminBuilder: "buildFeedbackAdminHandlers",
      adminRoutes: "FEEDBACK_ADMIN_ROUTES",
      adminSegment: "feedback",
      publicBuilder: "buildFeedbackPublicHandlers",
      publicRoutes: "FEEDBACK_PUBLIC_ROUTES",
      publicSegment: "feedback",
      pkg: "feedback",
      permissions: "feedbackPermissions",
    });
  }
  // TENANCY 2b-3: a company's assistant — its chat, history, offered changes
  // and settings. Built with the proof's scripted model, so the chat route
  // reaches its own checks (and streams) without a key or a real call.
  if (answers.includeAssistant) {
    suites.push({
      feature: "assistant",
      glue: "@/server/assistant",
      adminBuilder: "buildAssistantHandlers",
      adminRoutes: "ASSISTANT_ADMIN_ROUTES",
      adminSegment: "assistant",
      publicBuilder: null,
      publicRoutes: null,
      publicSegment: null,
      pkg: "assistant",
      permissions: "assistantPermissions",
      adminExpr: "(overrides) => buildAssistantHandlers({ ...overrides, provider: proofAssistantModel })",
    });
  }
  // TENANCY 2b-4a: a company's website numbers and websites (and its pages'
  // beacon, at its web address), and who it leaves out of them.
  if (answers.includeAnalytics) {
    suites.push({
      feature: "analytics",
      glue: "@/server/website",
      adminBuilder: "buildAnalyticsAdminHandlers",
      adminRoutes: "ANALYTICS_ADMIN_ROUTES",
      adminSegment: "website",
      publicBuilder: "buildCompanyBeaconHandlers",
      publicRoutes: "ANALYTICS_PUBLIC_ROUTES",
      publicSegment: "website",
      pkg: "analytics",
      permissions: "analyticsPermissions",
    });
    suites.push({
      feature: "audience",
      glue: "@/server/website",
      adminBuilder: "buildAudienceAdminHandlers",
      adminRoutes: "AUDIENCE_ADMIN_ROUTES",
      adminSegment: "audience",
      publicBuilder: null,
      publicRoutes: null,
      publicSegment: null,
      pkg: "audience",
      permissions: "audiencePermissions",
    });
  }
  // TENANCY 2b-4b: a company's search checks and its AI mentions. The search
  // check is built on the proof's stand-in network (no page is ever fetched);
  // AI mentions with --ai on a scripted engine (no model is ever asked), its
  // answers metered on the real ledger.
  if (answers.includeSeoReports) {
    suites.push({
      feature: "seo-reports",
      glue: "@/server/search-check",
      adminBuilder: "buildSearchCheckHandlers",
      adminRoutes: "SEO_REPORTS_ADMIN_ROUTES",
      adminSegment: "search-check",
      publicBuilder: null,
      publicRoutes: null,
      publicSegment: null,
      pkg: "seo-reports",
      permissions: "seoReportsPermissions",
      adminExpr: "(overrides) => buildSearchCheckHandlers({ ...overrides, network: proofSearchNetwork })",
    });
  }
  // TENANCY 2b-4c: a company's calls (its people taking them, their hours,
  // holidays and call types) and its booking page at its web address.
  if (answers.includeBooking) {
    suites.push({
      feature: "booking",
      glue: "@/server/booking",
      adminBuilder: "buildBookingAdminHandlers",
      adminRoutes: "BOOKING_ADMIN_ROUTES",
      adminSegment: "calls",
      publicBuilder: "buildBookingPublicHandlers",
      publicRoutes: "BOOKING_PUBLIC_ROUTES",
      publicSegment: "calls",
      pkg: "booking",
      permissions: "bookingCompanyPermissions",
    });
  }
  // THE CUSTOMER LIST (create-app 0.35): a company's customers, one customer
  // and their timeline, edits, merge, import and export.
  if (answers.includeCustomers) {
    suites.push({
      feature: "customers",
      glue: "@/server/customers",
      adminBuilder: "buildCustomersAdminHandlers",
      adminRoutes: "CUSTOMERS_ADMIN_ROUTES",
      adminSegment: "customers",
      publicBuilder: null,
      publicRoutes: null,
      publicSegment: null,
      pkg: "customers",
      permissions: "customersCompanyPermissions",
    });
  }
  if (answers.includeAeo) {
    suites.push({
      feature: "aeo",
      glue: "@/server/ai-mentions",
      adminBuilder: "buildAiMentionsHandlers",
      adminRoutes: "AEO_ADMIN_ROUTES",
      adminSegment: "ai-mentions",
      publicBuilder: null,
      publicRoutes: null,
      publicSegment: null,
      pkg: "aeo",
      permissions: "aeoPermissions",
      ...(answers.includeAi ? { adminExpr: "(overrides) => buildAiMentionsHandlers({ ...overrides, engine: proofAnswerEngine })" } : {}),
    });
  }
  return suites;
}

/** The suites this project has, by feature (the generator's own view, for the tests). */
export function featureSuiteNames(answers: Answers): readonly string[] {
  return suitesFor(answers).map((suite) => suite.feature);
}

/** The entities each feature's route tables name (contract 3.1), in planting order. */
export const FEATURE_ENTITIES: Readonly<Record<string, readonly string[]>> = {
  scheduling: ["resource", "time-off", "visit", "visit-token"],
  estimator: ["product", "supply", "attachment", "option", "option-value", "estimate", "line", "photo", "key", "quote-token"],
  invoicing: ["invoice", "item", "payment", "invoice-token", "card-alert"],
  // Getting paid, part 1: the payments screen names no row; it acts on the company in the path.
  stripe: [],
  // Getting paid, part 2: a product, an order, a store payment that needs the
  // owner, and one Check out (the thank-you page's).
  commerce: ["store-product", "store-order", "store-alert", "store-checkout"],
  comms: ["template-key"],
  // Tenancy 2b-1 (3.1).
  notifications: ["alert", "person"],
  storage: ["file", "file-token", "public-key", "record-type", "record"],
  // Tenancy 2b-2a; feedback 0.11 adds the values its board's filters, New
  // ticket and the ticket editor take: a column's and a category's short name,
  // and the person a ticket is assigned to; 0.12 adds an epic.
  feedback: ["ticket", "column", "category", "feedback-key", "ticket-number", "ticket-token", "column-key", "category-key", "assignee", "epic"],
  // Tenancy 2b-3: a conversation, a change it offered, a house rule, a word and an answer.
  assistant: ["conversation", "action", "house-rule", "glossary-term", "faq"],
  // Tenancy 2b-4a: a website of the company's own, and a rule naming who is left out.
  analytics: ["website"],
  audience: ["rule"],
  // Tenancy 2b-4b: one of the company's search checks, and one of its tracked questions.
  "seo-reports": ["site-check"],
  aeo: ["question"],
  // Tenancy 2b-4c: a call, someone taking calls, a day off, a holiday, a call
  // type — and what a visitor holds: the type's key, a hold, the private link
  // and a host's calendar feed.
  booking: ["booking", "host", "exception", "holiday", "type", "type-key", "hold-token", "manage-token", "feed-token"],
  // create-app 0.35: a customer, one of their addresses, and a second
  // customer (the one a merge would fold in), and a notice on the first (new details from a form).
  customers: ["customer", "customer-address", "spare-customer", "customer-notice"],
};

// ---------------------------------------------------------------------------
// src/test/company-rows.ts
// ---------------------------------------------------------------------------

export function renderCompanyRows(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  const scheduling = answers.includeScheduling;
  const estimator = answers.includeEstimator;
  const invoicing = answers.includeInvoicing;
  const comms = answers.includeComms;
  const alerts = answers.includeNotifications;
  const storage = answers.includeStorage;
  const feedback = answers.includeFeedback;
  const assistant = answers.includeAssistant;
  // Tenancy 2b-1: alerts and files are planted FOR people (the owner, a
  // member), and files through the proof's own memory stores. Tenancy 2b-3:
  // and the assistant's conversation and offered change are the owner's.
  const withPeople = alerts || storage || assistant;
  const routed = scheduling || estimator || invoicing;
  const drizzle = [
    ...(scheduling || estimator || invoicing || alerts ? ["and", "eq"] : []),
    ...(scheduling ? ["isNotNull"] : []),
  ];
  const imports = [
    ...(drizzle.length > 0 ? [`import { ${drizzle.join(", ")} } from "drizzle-orm";`] : []),
    ...(alerts ? [`import { notificationTables } from "${scope}/notifications/schema";`] : []),
    ...(assistant
      ? [
          `import {
  appendMessage,
  createConversation,
  createGlossaryTerm,
  createPendingAction,
  createTenantRule,
  saveBusinessProfile,
  saveFaq,
} from "${scope}/assistant";`,
        ]
      : []),
    ...(storage ? [`import type { Storage } from "${scope}/storage";`] : []),
    ...(answers.includeAnalytics
      ? [
          `import { createAnalytics } from "${scope}/analytics";`,
          `import { createAudience, createDrizzleAudienceStore } from "${scope}/audience";`,
        ]
      : []),
    ...(answers.includeSeoReports ? [`import { saveSeoReport } from "${scope}/seo-reports";`] : []),
    ...(answers.includeAeo ? [`import { addQuestion, analyzeAnswer, recordCheck, saveProfile } from "${scope}/aeo";`] : []),
    ...(answers.includeBooking
      ? [
          `import {
  addBlackout as addCallHoliday,
  addException as addCallDayOff,
  book as bookCall,
  holdSlot as holdCall,
  listBookings as listCalls,
  rotateHostFeedToken as rotateCallFeed,
  setWeeklyAvailability as setCallHours,
  upsertHost as upsertCallHost,
  upsertType as upsertCallType,
} from "${scope}/booking";`,
        ]
      : []),
    ...(comms ? [`import { enqueueMessage, sendNow, upsertTemplate } from "${scope}/comms";`] : []),
    ...(answers.includeCustomers ? [`import { findOrCreateCustomer, getCustomer, linkCustomer, mergeCustomers } from "${scope}/customers/server";`] : []),
    ...(estimator
      ? [
          `import {
  attachComponent,
  createComponent,
  createEstimate,
  createOption,
  createOptionValue,
  createProduct,
  estimatorEstimateItems,
  estimatorPhotos,
  estimatorTakeoffs,
  issueClientKey,
  issueQuoteToken,
  sendQuote,
  updateEstimatorSettings,
} from "${scope}/estimator";`,
        ]
      : []),
    ...(invoicing
      ? [
          `import { createInvoice, invoiceCardAlerts, invoiceCheckouts, invoiceItems, recordPayment, setInvoiceStatus } from "${scope}/invoicing";`,
          `import { stripeConnectedAccounts } from "${scope}/stripe/schema";`,
        ]
      : []),
    ...(answers.includeStore
      ? [
          `import { orderItems, orders, storeAlerts, storeCheckouts } from "${scope}/commerce/schema";`,
          `import { createStoreProduct } from "${scope}/commerce/store";`,
          ...(invoicing ? [] : [`import { stripeConnectedAccounts } from "${scope}/stripe/schema";`]),
        ]
      : []),
    ...(feedback
      ? [
          `import {
  addTicketMessage,
  createCategory,
  createEpic,
  createStatus,
  createTicket,
  ensureFeedbackBoard,
  issueClientKey as issueFeedbackKey,
  setEpicTickets,
  submitPayloadSchema,
  updateTicket,
} from "${scope}/feedback";`,
        ]
      : []),
    ...(scheduling
      ? [
          `import {
  addTimeOff,
  bookVisit,
  createResource,
  issueManageToken,
  schedulingAvailability,
  setAvailability,
  updateSchedulingSettings,
} from "${scope}/scheduling";`,
        ]
      : []),
    `import type { db } from "@/db";`,
    ...(alerts ? [`import { ALERT_REGISTRY, alerts } from "@/server/alerts";`] : []),
  ];

  const blocks: string[] = [];
  if (scheduling) {
    blocks.push(`
  // SCHEDULING: online booking ON (so this ${noun}'s public routes really look
  // rows up), a crew with weekday hours, a day off, a confirmed visit and the
  // customer's manage link to it.
  await updateSchedulingSettings(database, tenantId, { publicBookingEnabled: true });
  const crew = await createResource(database, { tenantId, name: \`\${Label} crew\` });
  rows.resource = crew.id;
  strings.push(\`\${Label} crew\`);
  await setAvailability(database, {
    tenantId,
    resourceId: crew.id,
    blocks: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startTime: "08:00", endTime: "17:00" })),
  });
  await addTimeOff(database, { tenantId, resourceId: crew.id, from: "2031-03-10", to: "2031-03-10" });
  const [dayOff] = await database
    .select({ id: schedulingAvailability.id })
    .from(schedulingAvailability)
    .where(
      and(
        eq(schedulingAvailability.tenantId, tenantId),
        eq(schedulingAvailability.resourceId, crew.id),
        isNotNull(schedulingAvailability.specificDate),
      ),
    )
    .limit(1);
  if (!dayOff) throw new Error(\`no day off was planted for \${label}\`);
  rows["time-off"] = dayOff.id;
  const { visit } = await bookVisit(
    database,
    {
      tenantId,
      resourceId: crew.id,
      scheduledDate: "2031-03-04",
      startTime: "09:00",
      endTime: "10:00",
      customerName: customer.name,
      customerEmail: customer.email,
      address: \`1 \${Label} Way\`,
      status: "confirmed",
    },
    // A planted row, not a booking a person made: the slot rules (hours,
    // overlap, drive time) are the package's own tests' business.
    { skipValidation: true },
  );
  rows.visit = visit.id;
  strings.push(\`1 \${Label} Way\`);
  const manageToken = await issueManageToken(database, tenantId, visit.id);
  if (!manageToken) throw new Error(\`no manage link was planted for \${label}\`);
  rows["visit-token"] = manageToken;
  // Two more INSIDE the calendar's default window (today and the six days
  // after), so the list routes — the calendar and its requests inbox — have
  // this ${noun}'s rows in them to leak (review TB-1): with only a visit in
  // 2031 they answered empty whatever their tenant filter did. A confirmed
  // visit, and a REQUEST nobody has answered yet, two days out.
  const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await bookVisit(
    database,
    {
      tenantId,
      resourceId: crew.id,
      scheduledDate: soon,
      startTime: "09:00",
      endTime: "10:00",
      customerName: customer.name,
      customerEmail: customer.email,
      address: \`2 \${Label} Way\`,
      status: "confirmed",
    },
    { skipValidation: true },
  );
  await bookVisit(
    database,
    {
      tenantId,
      resourceId: crew.id,
      scheduledDate: soon,
      startTime: "11:00",
      endTime: "12:00",
      customerName: \`\${Label} Requester\`,
      customerEmail: \`request@\${label}.test\`,
      address: \`3 \${Label} Way\`,
      status: "pending",
    },
    { skipValidation: true },
  );
  strings.push(\`2 \${Label} Way\`, \`3 \${Label} Way\`, \`\${Label} Requester\`, \`request@\${label}.test\`);
`);
  }
  if (estimator) {
    blocks.push(`
  // THE ESTIMATOR: estimate settings saved once (so this ${noun}'s instant
  // estimates are open and its public routes really look rows up), a product
  // with a supply attached and an option with a choice, an estimate with a
  // line, a photo on it, a website key, and the quote sent with its link.
  await updateEstimatorSettings(database, tenantId, { businessName: \`\${Label} Estimates\`, taxRateBp: 725 });
  const product = await createProduct(database, { tenantId, name: \`\${Label} probe product\`, measurementMode: "unit" });
  rows.product = product.id;
  strings.push(\`\${Label} probe product\`);
  const supply = await createComponent(database, { tenantId, name: \`\${Label} probe supply\` });
  rows.supply = supply.id;
  strings.push(\`\${Label} probe supply\`);
  rows.attachment = await attachComponent(database, tenantId, { productId: product.id, componentId: supply.id });
  const option = await createOption(database, tenantId, { productId: product.id, name: \`\${Label} probe option\` });
  rows.option = option.id;
  const choice = await createOptionValue(database, tenantId, { optionId: option.id, label: \`\${Label} probe choice\` });
  rows["option-value"] = choice.id;
  strings.push(\`\${Label} probe option\`, \`\${Label} probe choice\`);
  const estimate = await createEstimate(database, {
    tenantId,
    customerName: customer.name,
    customerEmail: customer.email,
    items: [{ description: \`\${Label} probe line\`, quantity: 1, unitPrice: 25_000 }],
  });
  rows.estimate = estimate.id;
  strings.push(\`\${Label} probe line\`);
  const [line] = await database
    .select({ id: estimatorEstimateItems.id })
    .from(estimatorEstimateItems)
    .where(eq(estimatorEstimateItems.estimateId, estimate.id))
    .limit(1);
  if (!line) throw new Error(\`no estimate line was planted for \${label}\`);
  rows.line = line.id;
  // A photo on the estimate. Written to the table directly: the package keeps
  // a photo only through a photo store (the blob token), which a test has
  // none of — and the row is all the routes read.
  const [photo] = await database
    .insert(estimatorPhotos)
    .values({
      tenantId,
      estimateId: estimate.id,
      fileId: \`file_\${label}_probe\`,
      url: \`https://files.example/\${label}/probe.jpg\`,
      contentType: "image/jpeg",
      sizeBytes: 1024,
      width: 1,
      height: 1,
      sha256: \`\${label}\`.padEnd(64, "0"),
      source: "staff",
      linkedAt: new Date(),
    })
    .returning({ id: estimatorPhotos.id });
  if (!photo) throw new Error(\`no photo was planted for \${label}\`);
  rows.photo = photo.id;
  strings.push(\`https://files.example/\${label}/probe.jpg\`);
  const key = await issueClientKey(database, { tenantId, label: \`\${Label} website\` });
  rows.key = key.id;
  strings.push(key.key);
  // The plaintext website key. Not a route placeholder: the estimator embed
  // (/api/estimator/…) names its company by this key alone, so the isolation
  // proof calls every embed route with the OTHER ${noun}'s key.
  rows["embed-key"] = key.key;
  await sendQuote(database, tenantId, estimate.id, {});
  const quoteToken = await issueQuoteToken(database, tenantId, estimate.id);
  if (!quoteToken) throw new Error(\`no quote link was planted for \${label}\`);
  rows["quote-token"] = quoteToken;
  // A photo reading on the ledger (review TB-1), written to the table as the
  // photo is — the package records one only around a model call, which a test
  // has none of — so the spend and usage routes have this ${noun}'s readings
  // (and its model's name) to leak.
  await database.insert(estimatorTakeoffs).values({
    tenantId,
    productId: product.id,
    recipe: "count",
    photoHash: \`\${label}\`.padEnd(64, "1"),
    status: "read",
    model: \`\${label}-probe-model\`,
    costMicros: 1234,
    requesterHash: \`\${label}\`.padEnd(64, "2"),
  });
  strings.push(\`\${label}-probe-model\`);
`);
  }
  if (invoicing) {
    blocks.push(`
  // INVOICING: an invoice with a line, SENT (so its customer link is live and
  // money can be taken against it), with a payment recorded.
  const invoice = await createInvoice(database, {
    tenantId,
    customerName: customer.name,
    customerEmail: customer.email,
    items: [{ description: \`\${Label} probe work\`, quantity: 1, unitPrice: 50_000 }],
  });
  rows.invoice = invoice.id;
  rows["invoice-token"] = invoice.viewToken;
  strings.push(\`\${Label} probe work\`);
  const [item] = await database
    .select({ id: invoiceItems.id })
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoice.id))
    .limit(1);
  if (!item) throw new Error(\`no invoice line was planted for \${label}\`);
  rows.item = item.id;
  await setInvoiceStatus(database, { tenantId, id: invoice.id, status: "sent" });
  const payment = await recordPayment(database, { tenantId, invoiceId: invoice.id, amount: 1_000, method: "cash" });
  if (!payment) throw new Error(\`no payment was planted for \${label}\`);
  rows.payment = payment.paymentId;
  // GETTING PAID, PART 1: the ${noun}'s own Stripe account (connected, taking
  // charges) and a "Pay now" it started, so the payments screen and the
  // checkouts have rows of A's to leak or to move.
  await database.insert(stripeConnectedAccounts).values({ tenantId, accountId: \`acct_\${label}_probe\`, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true });
  strings.push(\`acct_\${label}_probe\`);
  await database.insert(invoiceCheckouts).values({ tenantId, invoiceId: invoice.id, accountId: \`acct_\${label}_probe\`, sessionId: \`cs_\${label}_probe\`, purpose: "balance", amount: 49_000, currency: "usd", status: "open" });
  strings.push(\`cs_\${label}_probe\`);
  // A card payment that needs the ${noun}'s owner ("Needs your attention").
  const [cardAlert] = await database
    .insert(invoiceCardAlerts)
    .values({ tenantId, kind: "amount_mismatch", message: \`\${Label} probe card alert\`, amount: 1_234, currency: "usd", invoiceId: invoice.id, paymentIntentId: \`pi_\${label}_probe\`, dedupeKey: \`probe:\${label}\` })
    .returning({ id: invoiceCardAlerts.id });
  if (!cardAlert) throw new Error(\`no card alert was planted for \${label}\`);
  rows["card-alert"] = cardAlert.id;
  strings.push(\`\${Label} probe card alert\`, \`pi_\${label}_probe\`);
`);
  }
  if (answers.includeStore) {
    blocks.push(`
  // A STORE OF ITS OWN (getting paid, part 2): a product with stock, a Check
  // out someone opened, the order a paid one became (with its line), and a
  // store payment that needs the owner.${invoicing ? "" : `
  await database.insert(stripeConnectedAccounts).values({ tenantId, accountId: \`acct_\${label}_probe\`, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true });
  strings.push(\`acct_\${label}_probe\`);`}
  const storeProduct = await createStoreProduct(database, tenantId, { name: \`\${Label} probe soap\`, priceMinor: 1_500, currency: "usd", stock: 9 });
  rows["store-product"] = storeProduct.id;
  const [storeCheckout] = await database
    .insert(storeCheckouts)
    .values({
      tenantId,
      accountId: \`acct_\${label}_probe\`,
      cartKey: \`\${label}-probe-cart\`,
      sessionId: \`cs_\${label}_store\`,
      sessionUrl: \`https://checkout.stripe.test/\${label}\`,
      amount: 1_500,
      currency: "usd",
      lines: [{ productId: storeProduct.id, variantId: storeProduct.id, name: \`\${Label} probe soap\`, quantity: 1, unitPriceMinor: 1_500, held: false }],
      status: "open",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning({ id: storeCheckouts.id });
  if (!storeCheckout) throw new Error(\`no store checkout was planted for \${label}\`);
  rows["store-checkout"] = storeCheckout.id;
  // The order NUMBER counts per ${noun} — both have the same first one — so it
  // is not something that identifies this ${noun}; its customer and payment are.
  const [storeOrder] = await database
    .insert(orders)
    .values({
      tenantId,
      idempotencyKey: \`checkout_session:cs_\${label}_paid\`,
      orderNumber: "ORD-20260101-000001-00",
      email: \`buyer@\${label}.test\`,
      status: "paid",
      subtotalMinor: 1_500n,
      shippingMinor: 0n,
      taxMinor: 0n,
      discountMinor: 0n,
      totalMinor: 1_500n,
      currency: "usd",
      stripePaymentIntentId: \`pi_\${label}_store\`,
      stripeCheckoutSessionId: \`cs_\${label}_paid\`,
      placedAt: new Date(),
    })
    .returning({ id: orders.id });
  if (!storeOrder) throw new Error(\`no store order was planted for \${label}\`);
  rows["store-order"] = storeOrder.id;
  await database.insert(orderItems).values({ orderId: storeOrder.id, productRef: storeProduct.id, name: \`\${Label} probe soap\`, quantity: 1, unitPriceMinor: 1_500n, totalMinor: 1_500n });
  const [storeAlert] = await database
    .insert(storeAlerts)
    .values({ tenantId, kind: "amount_mismatch", message: \`\${Label} probe store alert\`, amount: 999, currency: "usd", orderId: null, paymentIntentId: \`pi_\${label}_storealert\`, dedupeKey: \`probe:\${label}:store\` })
    .returning({ id: storeAlerts.id });
  if (!storeAlert) throw new Error(\`no store alert was planted for \${label}\`);
  rows["store-alert"] = storeAlert.id;
  strings.push(\`\${Label} probe soap\`, \`buyer@\${label}.test\`, \`cs_\${label}_store\`, \`pi_\${label}_store\`, \`\${Label} probe store alert\`, \`pi_\${label}_storealert\`);
`);
  }
  if (comms) {
    blocks.push(`
  // MESSAGES: a template only this ${noun} has, so "another ${noun}'s key is
  // not found" is a real check.
  rows["template-key"] = \`\${label}_only_note\`;
  await upsertTemplate(database, {
    tenantId,
    key: \`\${label}_only_note\`,
    channel: "email",
    subject: \`A note from \${Label}\`,
    body: \`Only \${Label} has this note, {{name}}.\`,
  });
  strings.push(\`A note from \${Label}\`);
  // A message in the delivery log, and one queued and DUE (review TB-1), so
  // the Messages log and "Send what's due now" have this ${noun}'s rows to
  // leak or to move. No senders: the log row says "skipped", and is a row.
  await sendNow(database, { tenantId, to: customer.email, templateKey: \`\${label}_only_note\`, vars: { name: customer.name } }, {});
  const due = await enqueueMessage(database, {
    tenantId,
    to: customer.email,
    templateKey: \`\${label}_only_note\`,
    sendAt: new Date(Date.now() - 60_000),
  });
  if (!due) throw new Error(\`no due message was planted for \${label}\`);
`);
  }

  if (feedback) {
    blocks.push(`
  // FEEDBACK (Tenancy 2b-2a): the ${noun}'s board (its default columns and
  // categories), a ticket from a customer with the team's reply on it, a
  // column and a category of its own, and a website key. The ticket's NUMBER
  // counts per ${noun} — both ${noun}s have an FB-00001 — so it is a route
  // value, not something that identifies this ${noun} (left out below); its
  // reporter's token is.
  await ensureFeedbackBoard(database, tenantId);
  const report = await createTicket(database, {
    tenantId,
    payload: submitPayloadSchema.parse({
      description: \`\${Label} feedback: the gate code doesn't work.\`,
      priority: "high",
      reporter: { name: customer.name, email: customer.email },
      clientMetadata: {
        browser: "Probe",
        os: "Probe",
        viewport: { width: 1, height: 1 },
        url: \`https://\${label}.test/feedback\`,
        pathname: \`/\${label}-feedback\`,
        clickTrail: [],
        sessionId: \`\${label}-session\`,
        capturedAt: 0,
      },
    }),
  });
  rows.ticket = report.id;
  rows["ticket-number"] = report.ticketNumber;
  rows["ticket-token"] = report.ticketToken;
  strings.push(\`\${Label} feedback: the gate code doesn't work.\`, \`/\${label}-feedback\`);
  await addTicketMessage(database, tenantId, {
    ticketId: report.id,
    senderType: "staff",
    senderName: \`\${Label} Office\`,
    body: \`\${Label} office reply\`,
  });
  strings.push(\`\${Label} Office\`, \`\${Label} office reply\`);
  const column = await createStatus(database, tenantId, { key: \`\${label}_waiting\`, label: \`\${Label} waiting\` });
  rows.column = column.id;
  strings.push(\`\${Label} waiting\`, \`\${label}_waiting\`);
  const category = await createCategory(database, tenantId, { key: \`\${label}_billing\`, label: \`\${Label} billing\` });
  rows.category = category.id;
  strings.push(\`\${Label} billing\`, \`\${label}_billing\`);
  // Feedback 0.11: the short names the board's filters, New ticket and the
  // editor take, and the ticket filed under the category and assigned to a
  // person of this ${noun}'s — so a filter or a search that forgot the
  // ${noun} finds it from the other one, and its activity trail has rows.
  rows["column-key"] = column.key;
  rows["category-key"] = category.key;
  rows.assignee = \`\${label}-assignee\`;
  await updateTicket(
    database,
    tenantId,
    { ticketId: report.id, category: category.key, assignee: { id: rows.assignee, name: \`\${Label} Assignee\` } },
    { id: null, name: \`\${Label} Office\` },
  );
  strings.push(\`\${Label} Assignee\`);
  // Feedback 0.12: an epic, led by that person, with the ticket in it — so an
  // epic route that forgot the ${noun} hands B A's epic, its name or its
  // ticket, and the mixed pass can put A's ticket into B's epic.
  const epic = await createEpic(
    database,
    tenantId,
    { name: \`\${Label} spring launch\`, description: \`\${Label} epic notes\`, owner: { id: rows.assignee, name: \`\${Label} Assignee\` } },
    { id: null, name: \`\${Label} Office\` },
  );
  await setEpicTickets(database, tenantId, epic.id, { add: [report.id] }, { id: null, name: \`\${Label} Office\` });
  rows.epic = epic.id;
  strings.push(\`\${Label} spring launch\`, \`\${Label} epic notes\`);
  const websiteKey = await issueFeedbackKey(database, { tenantId, label: \`\${Label} feedback website\` });
  rows["feedback-key"] = websiteKey.id;
  strings.push(\`\${Label} feedback website\`);
  // The plaintext website key. Not a route placeholder: the keyed intake
  // (/api/igloo) names its board by this key alone, so the isolation proof
  // calls every intake route with the OTHER ${noun}'s key.
  rows["feedback-website-key"] = websiteKey.key;
`);
  }
  if (assistant) {
    blocks.push(`
  // THE ASSISTANT (Tenancy 2b-3): the business profile (written, then edited,
  // so it has a version), a conversation of the owner's with a question and
  // an answer, a change the assistant offered (still waiting for "Yes, do
  // it"), a house rule, a word and an answer to a common question — each
  // naming this ${noun}, so an assistant route that forgot the ${noun} hands
  // B something of A's to catch.
  await saveBusinessProfile(database, tenantId, { content: \`\${Label} profile: we mow lawns.\` }, people.owner);
  await saveBusinessProfile(database, tenantId, { content: \`\${Label} profile: we mow and edge lawns.\` }, people.owner);
  const conversation = await createConversation(database, { tenantId, userId: people.owner, title: \`\${Label} assistant question\` });
  await appendMessage(database, { tenantId, conversationId: conversation.id, role: "user", blocks: [{ kind: "text", text: \`\${Label} asks about the yard\` }] });
  await appendMessage(database, { tenantId, conversationId: conversation.id, role: "assistant", blocks: [{ kind: "text", text: \`\${Label} assistant answer\` }] });
  rows.conversation = conversation.id;
  const offered = await createPendingAction(database, {
    tenantId,
    conversationId: conversation.id,
    toolName: "remember_answer",
    params: { question: \`\${Label} question?\`, answer: \`\${Label} answer.\` },
    summary: \`Save an answer to “\${Label} question?”\`,
    idempotencyKey: \`proof-\${label}-offer\`,
    expiresAt: new Date(Date.now() + 86_400_000),
    createdBy: people.owner,
  });
  rows.action = offered.id;
  const rule = await createTenantRule(database, { tenantId, label: \`\${Label} rule\`, instruction: \`\${Label} house rule.\` }, people.owner);
  if (!("id" in rule)) throw new Error(\`no house rule was planted for \${label}\`);
  rows["house-rule"] = rule.id;
  const term = await createGlossaryTerm(database, tenantId, { termKey: \`\${label}_yard\`, preferred: \`\${Label} yard\`, definition: \`\${Label} depot\` }, people.owner);
  rows["glossary-term"] = term.id;
  const answer = await saveFaq(database, tenantId, { question: \`\${Label} opening hours?\`, answer: \`\${Label} opens at nine.\` }, people.owner);
  if (!answer.saved) throw new Error(\`no answer was planted for \${label}\`);
  rows.faq = answer.faq.id;
  strings.push(
    \`\${Label} profile: we mow and edge lawns.\`,
    \`\${Label} assistant question\`,
    \`\${Label} asks about the yard\`,
    \`\${Label} assistant answer\`,
    \`\${Label} question?\`,
    \`\${Label} house rule.\`,
    \`\${Label} yard\`,
    \`\${Label} depot\`,
    \`\${Label} opening hours?\`,
    \`\${Label} opens at nine.\`,
  );
`);
  }
  if (answers.includeAnalytics) {
    blocks.push(`
  // WEBSITE VISITS (Tenancy 2b-4a): a website of the ${noun}'s own, with an
  // address and a public key that name this ${noun}; one visit to it, through
  // the package's own beacon handler (two pages, so the reports have this
  // ${noun}'s pages and sources to leak); and a rule naming someone it leaves
  // out of its numbers.
  const counting = createAnalytics({ db: database });
  const website = await counting.addWebsite({ tenantId, name: \`\${Label} website\`, domains: [\`www.\${label}-lawncare.com\`] });
  rows.website = website.id;
  // The website's public key. Not a route placeholder: the keyed beacon
  // (/api/w) names its website by this alone, so the proof sends A's from B's site.
  rows["site-key"] = website.siteKey;
  strings.push(\`\${Label} website\`, \`\${label}-lawncare.com\`, website.siteKey);
  const beacon = counting.createHandler({
    resolveSite: () => ({ tenantId, siteId: website.id, allowedHosts: website.domains }),
    clientIp: () => \`198.51.100.\${label.length}\`,
  });
  const pageView = (body: Record<string, unknown>) =>
    beacon.handle(
      new Request("http://localhost/api/w/v1/collect", {
        method: "POST",
        headers: { origin: \`https://www.\${label}-lawncare.com\`, "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36" },
        body: JSON.stringify(body),
      }),
    );
  await pageView({ t: "pageview", d: \`proof\${label}visit1\`, p: \`/\${label}-spring-cleanup\`, r: \`https://\${label}-referrer.com/\` });
  await pageView({ t: "pageview", d: \`proof\${label}visit1\`, p: \`/\${label}-prices\` });
  strings.push(\`/\${label}-spring-cleanup\`, \`/\${label}-prices\`, \`\${label}-referrer.com\`);
  const leaving = createAudience({
    store: createDrizzleAudienceStore({ db: database }),
    secret: "proof-audience-key-0123456789-abcdefghij",
    tenantId,
  });
  const rule = await leaving.addRule({ kind: "email", value: \`owner@\${label}-lawncare.com\`, reasonLabel: \`\${Label} owner\` });
  rows.rule = rule.rule.id;
  strings.push(\`owner@\${label}-lawncare.com\`, \`\${Label} owner\`);
`);
  }
  if (answers.includeSeoReports) {
    blocks.push(`
  // SEARCH CHECK (Tenancy 2b-4b): one finished check of the ${noun}'s own,
  // with a page and a finding that name it — the report a leaking route would
  // hand another ${noun}.
  const searchCheck = await saveSeoReport(database, tenantId, {
    baseUrl: \`https://www.\${label}-search.example\`,
    addresses: [\`\${Label} website — www.\${label}-search.example\`],
    startedAt: new Date(),
    finishedAt: new Date(),
    score: 70,
    seoScore: 60,
    aeoScore: 80,
    pageCount: 1,
    stopped: null,
    counts: { pass: 1, warn: 0, fail: 1 },
    siteChecks: [{ id: "site.llms-txt", label: "llms.txt", kind: "aeo", status: "fail", detail: \`\${Label} serves no llms.txt.\` }],
    pages: [{ path: \`/\${label}-search-page\`, checks: [{ id: "page.title", label: "Page title", kind: "seo", status: "pass", detail: \`“\${Label} lawn care” (20 characters).\` }] }],
  });
  rows["site-check"] = searchCheck;
  strings.push(\`\${label}-search.example\`, \`/\${label}-search-page\`, \`\${Label} serves no llms.txt.\`);
`);
  }
  if (answers.includeBooking) {
    blocks.push(`
  // BOOK A CALL (Tenancy 2b-4c): someone taking the ${noun}'s calls all week, a
  // day off, a holiday, a call type, a booked call and its private link, a held
  // time, and the host's calendar feed — every row a leaking route would hand
  // another ${noun}. Dates are days from today, inside the type's 60 days.
  const callCtx = { db: database, tenantId };
  const callDay = (offset: number) => {
    const today = new Date();
    return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset, 15));
  };
  const callHost = await upsertCallHost(callCtx, { displayName: \`\${Label} Call Host\`, email: \`calls@\${label}.test\`, timezone: "UTC" });
  rows.host = callHost.id;
  await setCallHours(callCtx, { hostId: callHost.id, windows: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startMinute: 0, endMinute: 1440 })) });
  const callDayOff = await addCallDayOff(callCtx, { hostId: callHost.id, date: callDay(10).toISOString().slice(0, 10), kind: "off", note: \`\${Label} dentist\` });
  rows.exception = callDayOff.id;
  const callHoliday = await addCallHoliday(callCtx, { date: callDay(20).toISOString().slice(0, 10), label: \`\${Label} closed day\` });
  rows.holiday = callHoliday.id;
  const callType = await upsertCallType(callCtx, { key: \`\${label}-call\`, name: \`\${Label} intro call\`, durationMinutes: 30, media: ["video"], horizonDays: 60 });
  rows.type = callType.id;
  rows["type-key"] = callType.key;
  const call = await bookCall(callCtx, { typeKey: callType.key, start: callDay(3).toISOString(), name: \`\${Label} Caller\`, email: \`caller@\${label}.test\`, medium: "video", timezone: "UTC" });
  rows["manage-token"] = call.manageToken;
  const [booked] = await listCalls(callCtx, {});
  if (!booked) throw new Error(\`no call was planted for \${label}\`);
  rows.booking = booked.id;
  rows["hold-token"] = (await holdCall(callCtx, { typeKey: callType.key, start: callDay(4).toISOString() })).holdToken;
  rows["feed-token"] = (await rotateCallFeed(callCtx, callHost.id)).feedToken;
  strings.push(\`\${Label} Call Host\`, \`calls@\${label}.test\`, \`\${Label} dentist\`, \`\${Label} closed day\`, \`\${label}-call\`, \`\${Label} intro call\`, \`\${Label} Caller\`, \`caller@\${label}.test\`);
`);
  }
  if (answers.includeCustomers) {
    blocks.push(`
  // THE CUSTOMER LIST (create-app 0.35): the ${noun}'s customer with an
  // address and a quote on their timeline, a second customer (the one a merge
  // would fold in), and a duplicate already merged into the first (the record
  // of merges).
  const listed = await findOrCreateCustomer(database, { tenantId, name: \`\${Label} Listed Customer\`, email: \`listed@\${label}.test\`, address: \`1 \${Label} Lane\` });
  rows.customer = listed.customer.id;
  const listedCard = await getCustomer(database, tenantId, listed.customer.id);
  const listedAddress = listedCard?.addresses[0]?.id;
  if (!listedAddress) throw new Error(\`no customer address was planted for \${label}\`);
  rows["customer-address"] = listedAddress;
  await linkCustomer(database, { tenantId, customerId: listed.customer.id, kind: "estimate", refId: \`\${label}-probe-estimate\`, action: "submitted", occurredAt: new Date(), summary: \`\${Label} probe quote\` });
  const spare = await findOrCreateCustomer(database, { tenantId, name: \`\${Label} Spare Customer\`, email: \`spare@\${label}.test\` });
  rows["spare-customer"] = spare.customer.id;
  const duplicate = await findOrCreateCustomer(database, { tenantId, name: \`\${Label} Duplicate\`, email: \`duplicate@\${label}.test\` });
  await mergeCustomers(database, tenantId, listed.customer.id, duplicate.customer.id);
  // A public form with the customer's email and an address they don't have:
  // nothing of theirs changes; it waits on their record (a notice).
  await findOrCreateCustomer(database, { tenantId, email: \`listed@\${label}.test\`, address: \`9 \${Label} Form Road\`, sourceLabel: \`\${Label} probe form\` });
  const notice = (await getCustomer(database, tenantId, listed.customer.id))?.notices[0]?.id;
  if (!notice) throw new Error(\`no customer notice was planted for \${label}\`);
  rows["customer-notice"] = notice;
  strings.push(\`\${Label} Listed Customer\`, \`listed@\${label}.test\`, \`1 \${Label} Lane\`, \`\${Label} probe quote\`, \`\${Label} Spare Customer\`, \`spare@\${label}.test\`, \`\${Label} Duplicate\`, \`duplicate@\${label}.test\`, \`9 \${Label} Form Road\`, \`\${Label} probe form\`);
`);
  }
  if (answers.includeAeo) {
    blocks.push(`
  // AI MENTIONS (Tenancy 2b-4b): who the ${noun} is, one question its
  // customers ask, and one answer to it as code read it.
  const mentionTarget = { brand: \`\${Label} Mowing Co\`, domain: \`\${label}-mowing.example\` };
  await saveProfile(database, tenantId, { ...mentionTarget, competitors: [\`\${Label} Rival\`] });
  const question = await addQuestion(database, tenantId, \`\${label} lawn mowing near me\`);
  rows.question = question.id;
  const mentionAnswer = { text: \`\${Label} Mowing Co mows lawns nearby; \${Label} Rival does too.\`, citedUrls: [\`https://\${label}-mowing.example/\`] };
  await recordCheck(database, {
    tenantId,
    queryId: question.id,
    engine: "claude",
    model: "claude-haiku-4-5",
    analysis: analyzeAnswer(mentionAnswer, mentionTarget, [\`\${Label} Rival\`]),
    answer: mentionAnswer.text,
    citedUrls: mentionAnswer.citedUrls,
  });
  strings.push(\`\${Label} Mowing Co\`, \`\${label}-mowing.example\`, \`\${label} lawn mowing near me\`, \`\${Label} Rival\`);
`);
  }
  if (alerts) {
    blocks.push(`
  // ALERTS (Tenancy 2b-1, 14.1): one alert for the ${noun}'s owner through
  // this project's own alerts (the registry's first kind), the owner's own
  // choice for that kind${routed ? ", and — so the routing answers have a row of this " + noun + " to\n  // leak — its first routing group set to the member, with an extra address" : ""}.
  const firstKind = ALERT_REGISTRY.kinds[0];
  if (!firstKind) throw new Error("the alert registry has no kinds to plant");
  await alerts.notify({
    tenantId,
    kind: firstKind.key,
    title: \`\${Label} probe alert\`,
    body: \`Only \${Label} has this alert.\`,
    href: null,
    dedupeKey: \`proof:\${label}\`,
    subject: null,
    actorUserId: null,
  });
  const t = notificationTables.alerts;
  const [alert] = await database
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.recipientId, people.owner), eq(t.dedupeKey, \`proof:\${label}\`)))
    .limit(1);
  if (!alert) throw new Error(\`no alert was planted for \${label}'s owner\`);
  rows.alert = alert.id;
  rows.person = people.member ?? people.owner;
  strings.push(\`\${Label} probe alert\`, \`Only \${Label} has this alert.\`);
  await alerts.setChoice({ tenantId, userId: people.owner, kind: firstKind.key, channel: "in_app" });${
    routed
      ? `
  const firstRouting = ALERT_REGISTRY.routings[0];
  if (!firstRouting) throw new Error("the alert registry has no routing group to plant");
  await alerts.setRouting({
    tenantId,
    routing: firstRouting.key,
    mode: "chosen",
    userIds: [people.member ?? people.owner],
    extraEmails: [\`office@\${label}.test\`],
    by: people.owner,
  });
  strings.push(\`office@\${label}.test\`);`
      : ""
  }
`);
  }
  if (storage) {
    const firstRecord = scheduling
      ? { type: "scheduling.visit", row: "unassigned-visit", what: "a visit on no crew" }
      : estimator
        ? { type: "estimator.estimate", row: "estimate", what: "an estimate" }
        : invoicing
          ? { type: "invoicing.invoice", row: "invoice", what: "an invoice" }
          : null;
    // 14.1: the role pass's crew member is NOT assigned to the planted
    // record. Joining puts a crew member on a company's one free crew, so the
    // visit above may become theirs; the photo goes on a visit on no crew.
    const unassignedVisit = scheduling
      ? `
  const { visit: unassigned } = await bookVisit(
    database,
    { tenantId, scheduledDate: "2031-03-05", startTime: "13:00", endTime: "14:00", customerName: customer.name, status: "confirmed" },
    { skipValidation: true },
  );
  rows["unassigned-visit"] = unassigned.id;`
      : "";
    blocks.push(`
  // FILES (Tenancy 2b-1, 14.1), through the proof's own files instance over
  // memory stores: a company file (with bytes that name this ${noun}, so a
  // handler answering with them is caught), a signed link to it made by the
  // owner, the logo (the one PUBLIC file)${firstRecord ? `, and a photo on ${firstRecord.what}` : ""}.
  // Every PRIVATE object key is handed back (\`privateKeys\`): no answer may
  // ever carry one. The logo's public address is the ${noun}'s to give out, so
  // it is handed back apart (\`publicStrings\`), checked against the OTHER
  // ${noun}'s answers only.
  const marker = new TextEncoder().encode(\`\${label}-probe-bytes\`);
  const libraryBytes = new Uint8Array(PROBE_PNG.length + marker.length);
  libraryBytes.set(PROBE_PNG);
  libraryBytes.set(marker, PROBE_PNG.length);
  const library = await people.storage.store({
    tenantId,
    purpose: "library",
    bytes: libraryBytes,
    declaredType: "image/png",
    filename: \`\${label}-probe.png\`,
    addedBy: people.owner,
  });
  rows.file = library.id;
  privateKeys.push(library.key);
  strings.push(\`\${label}-probe-bytes\`, \`\${label}-probe.png\`);
  const link = await people.storage.signedLink({ tenantId, fileId: library.id, userId: people.owner });
  if (!link) throw new Error(\`no signed link was planted for \${label} (no signing key?)\`);
  rows["file-token"] = decodeURIComponent(link.url.slice(link.url.lastIndexOf("/v1/f/") + "/v1/f/".length));
  const logos = people.storage.logoStore();
  if (!logos) throw new Error("the proof's files instance has no public store for the logo");
  const logo = await logos.put({ pathname: "logo.png", bytes: PROBE_PNG, contentType: "image/png", tenantId });
  rows["public-key"] = decodeURIComponent(logo.url.slice(logo.url.lastIndexOf("/v1/p/") + "/v1/p/".length));
  publicStrings.push(logo.url, rows["public-key"]);${
    firstRecord
      ? `${unassignedVisit}
  const record = rows[${JSON.stringify(firstRecord.row)}];
  if (!record) throw new Error(\`no ${firstRecord.row} was planted for \${label} to attach a file to\`);
  rows["record-type"] = ${JSON.stringify(firstRecord.type)};
  rows.record = record;
  const attached = await people.storage.store({
    tenantId,
    purpose: "attachment",
    bytes: PROBE_PNG,
    declaredType: "image/png",
    filename: \`\${label}-attachment.png\`,
    addedBy: people.owner,
    record: { type: ${JSON.stringify(firstRecord.type)}, id: record },
  });
  // Not a route placeholder: the role pass opens this file as each role.
  rows["record-file"] = attached.id;
  privateKeys.push(attached.key);
  strings.push(\`\${label}-attachment.png\`);`
      : ""
  }
`);
  }

  // The record TYPE is a word every ${noun} shares ("scheduling.visit"), not
  // something of this one's: it is left out of the strings that identify it.
  // So is a feedback ticket's NUMBER (Tenancy 2b-2a): numbers count per
  // ${noun}, so every ${noun}'s first ticket is FB-00001.
  const identifying = `  strings.push(...Object.entries(rows).filter(([entity]) => entity !== "record-type" && entity !== "ticket-number").map(([, value]) => value));`;
  const peopleParam = withPeople
    ? `,
  people: CompanyPeople`
    : "";
  const peopleType = withPeople
    ? `
/** Who the alerts and files are planted for, and (files) the proof's own files instance. */
export interface CompanyPeople {
  /** The ${noun}'s owner. */
  readonly owner: string;
  /** A member (the one picked for the routing group); null: the owner stands in. */
  readonly member: string | null;${storage ? `
  /** The proof's own files instance, over memory stores (14.1). */
  readonly storage: Storage;` : ""}
}
`
    : "";
  const png = storage
    ? `
/** A 1×1 PNG: the smallest file every purpose here takes. */
export const PROBE_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);
`
    : "";

  return `${imports.join("\n")}
${png}${peopleType}
/**
 * Plant one of every kind of row the installed features' routes read, for one
 * ${noun} — through the PACKAGE functions a ${noun}'s own screens use (never
 * raw SQL, except where a package has no writer: an estimator photo row).
 *
 * The project's isolation proof (src/server/__tests__/feature-isolation.test.ts)
 * plants company A AND company B with this, then calls every route as B with
 * A's rows. Planting B too is the point: B's own lists, configs and logs are
 * then NON-EMPTY, so "B's answer says nothing of A" is checked against real
 * answers rather than against empty arrays that would pass for any reason.
 *
 * GENERATED per installed feature. When a package adds an entity to its route
 * tables, the proof fails by name ("Plant a {entity} row for company A …")
 * until a row of it is planted here.
 */
export interface PlantedRows {
  /** Entity ("visit", "quote-token", …) → this ${noun}'s row id, or the plaintext token for a token entity. */
  readonly rows: Readonly<Record<string, string>>;
  /** Everything that identifies these rows: ids, tokens, the customer's name and email, names and keys. */
  readonly strings: readonly string[];
  /** The storage keys of this ${noun}'s PRIVATE files: no answer, its own included, may ever carry one (D10). */
  readonly privateKeys: readonly string[];
  /** Its PUBLIC logo's address and key: the ${noun}'s to give out, never another ${noun}'s to receive (review G8). */
  readonly publicStrings: readonly string[];
}

/** Any drizzle handle on this project's schema (the PGlite one in the tests). */
export type CompanyRowsDb = typeof db;

/**
 * \`label\` is lowercase and distinct per ${noun} ("alpha", "bravo"): every name,
 * address and key planted carries it, so one ${noun}'s strings can never be
 * another's by coincidence.
 */
export async function plantCompanyRows(database: CompanyRowsDb, tenantId: string, label: string${peopleParam}): Promise<PlantedRows> {
  const Label = label.charAt(0).toUpperCase() + label.slice(1);
  const rows: Record<string, string> = {};
  const customer = { name: \`\${Label} Customer\`, email: \`customer@\${label}.test\` };
  const strings: string[] = [customer.name, customer.email];
  const privateKeys: string[] = [];
  const publicStrings: string[] = [];
${blocks.join("")}
${identifying}
  return { rows, strings, privateKeys, publicStrings };
}
`;
}

// ---------------------------------------------------------------------------
// src/server/__tests__/feature-isolation.test.ts
// ---------------------------------------------------------------------------

/**
 * Without file storage the estimator's photo routes refuse ("photos can't be
 * kept") BEFORE they read a row — true, and proof of nothing. Found by running
 * the emitted proof against the 2a packages: photo-add answered 403
 * photos_disabled, not 404, in a project whose storage key was simply unset.
 * So the proof keeps photos in memory, and the photo routes reach the row
 * check in every project, with storage or without.
 */
/**
 * The proof's model (Tenancy 2b-3): a scripted one, so the assistant's chat
 * routes reach their own checks and stream without a key — and the proof
 * never calls a real model.
 */
const PROOF_ASSISTANT_MODEL = `
/** A scripted model: one short answer, the provider's usage reported. Never a real call. */
const proofAssistantModel: ProviderAdapter = {
  modelId: "claude-haiku-4-5",
  async *stream() {
    yield { type: "text-delta", delta: "Here is what I found." };
    yield { type: "step-end", stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, reported: true } };
  },
};
`;

/**
 * The proof's network for the search check (Tenancy 2b-4b): every name is a
 * public address and every page answers 404 at once, so Check now runs its
 * whole path — the plan, the lock, the row — without one real request.
 */
const PROOF_SEARCH_NETWORK = `
/** A stand-in internet: every page "not found", instantly. Never a real request. */
const proofSearchNetwork = {
  resolve: async () => ["93.184.216.34"],
  transport: async () => ({ status: 404, headers: {}, body: new Uint8Array(0), truncated: false }),
};
`;

/**
 * The proof's answer engine (Tenancy 2b-4b, with --ai): a scripted answer
 * that names nobody, with usage reported — held and settled on the real
 * ledger like any answer, and never a real call.
 */
const PROOF_ANSWER_ENGINE = `
/** A scripted answer engine: names nobody, reports its usage. Never a real call. */
const proofAnswerEngine: AnswerEngine = {
  key: "claude",
  label: "Claude",
  model: "claude-haiku-4-5",
  worstCaseMicros: 10_000n,
  feesMicros: () => 0n,
  ask: async () => ({
    text: "Several local businesses offer this service.",
    citedUrls: [],
    usage: { model: "claude-haiku-4-5", inputTokens: 12, outputTokens: 6, cachedInputTokens: 0, cachedWriteTokens: 0, webSearches: 0, reported: true },
  }),
};
`;

/**
 * A WEBSITE'S BEACON COUNTS ONLY FROM ITS OWN ADDRESSES, FOR ITS OWN COMPANY
 * (Tenancy 2b-4a): the keyed endpoint every company's own website calls
 * (/api/w) — A's key pasted on B's website, and B's on A's, count nothing for
 * anyone; and A's key on A's own website does count, for A, so the check can
 * fail.
 */
function websiteBeaconsSuite(answers: Answers): string {
  const noun = tenantLabel(answers).toLowerCase();
  const nouns = tenantLabelPlural(answers).toLowerCase();
  return `
describe("feature isolation: website beacons", () => {
  it("count a website's visit only from its own addresses, and only for its own ${noun}", async () => {
    const before = await snapshotOfA();
    const keyed = buildWebsiteBeaconHandlers();
    const send = (key: string, origin: string, doc: string) =>
      keyed.handle(
        new Request(\`http://localhost/api/w/v1/collect?site=\${encodeURIComponent(key)}\`, {
          method: "POST",
          headers: { origin, "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36" },
          body: JSON.stringify({ t: "pageview", d: doc, p: "/copied-snippet" }),
        }),
      );
    const aKey = fx.aRows["site-key"];
    const bKey = fx.bRows["site-key"];
    if (!aKey || !bKey) throw new Error("the ${nouns} have no website keys");
    const copied = async (tenantId: string) =>
      Number((await all(sql\`select count(*)::int as n from analytics_sessions where tenant_id = \${tenantId} and landing_path = '/copied-snippet'\`))[0]?.n ?? 0);
    // A's key on B's website (a copied snippet), and B's on A's: nothing, for anyone.
    expect((await send(aKey, "https://www.bravo-lawncare.com", "proofcopied00001")).status).toBe(204);
    expect((await send(bKey, "https://www.alpha-lawncare.com", "proofcopied00002")).status).toBe(204);
    expect(await snapshotOfA()).toBe(before);
    expect([await copied(fx.aId), await copied(fx.bId)]).toEqual([0, 0]);
    // The check can fail: A's key on A's own website counts — for A, never B.
    await send(aKey, "https://www.alpha-lawncare.com", "proofowned000001");
    expect([await copied(fx.aId), await copied(fx.bId)]).toEqual([1, 0]);
  });
});
`;
}

/**
 * A COMPANY CAN ONLY EVER NAME ITS OWN PEOPLE (Tenancy 2b-4a review): who a
 * company leaves out of its numbers is looked up among ITS members and
 * invitations only. B, previewing a rule in B's company for A's people (by
 * their email domain, or one of them by address), finds nobody and learns
 * nothing of whether they have accounts; A, in A's company, finds them — so
 * the check can fail.
 */
function audiencePeopleSuite(answers: Answers): string {
  const noun = tenantLabel(answers).toLowerCase();
  return `
describe("feature isolation: who a ${noun} can leave out", () => {
  it("finds only the ${noun}'s own people: another ${noun}'s are never found, counted or left out", async () => {
    const before = await snapshotOfA();
    const preview = async (who: Person, tenantId: string, body: Record<string, string>) => {
      const handlers = buildAudienceAdminHandlers({ principal: async () => ({ userId: who.id }) });
      const res = await handlers.handle(
        new Request(\`http://localhost/api/app/\${tenantId}/audience/v1/rules/preview\`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(res.status).toBe(200);
      return (await res.json()) as { subjects: { users: number; visitors: number } };
    };
    const domain = fx.A2.email.split("@")[1] ?? "";
    // B, in B's own ${noun}: A's people by their domain, and one of them by address — nobody.
    expect((await preview(fx.B, fx.bId, { kind: "email_domain", value: domain })).subjects).toMatchObject({ users: 0, visitors: 0 });
    expect((await preview(fx.B, fx.bId, { kind: "email", value: fx.A2.email })).subjects).toMatchObject({ users: 0, visitors: 0 });
    // The check can fail: A, in A's own ${noun}, finds A's people by their domain.
    expect((await preview(fx.A, fx.aId, { kind: "email_domain", value: domain })).subjects.users).toBeGreaterThan(0);
    expect(await snapshotOfA()).toBe(before);
  });
});
`;
}

/**
 * B'S ASSISTANT TOOLS NEVER RETURN A'S ROWS (Tenancy 2b-3): every read tool,
 * run as B in B's company, says nothing of A; and run as A in A's company,
 * at least one of them does return A's rows (so the check can fail).
 */
function assistantToolsSuite(answers: Answers): string {
  const readsPlanted = answers.includeScheduling || answers.includeEstimator;
  return `
describe("feature isolation: the assistant's tools", () => {
  it("run in the person's own company only: B's never return A's rows${readsPlanted ? ", and A's do" : ""}", async () => {
    const as = (tenantId: string, userId: string) => ({ tenantId, userId, conversationId: "proof", can: () => true });
    // Inputs that reach the planted rows: the day of A's and B's planted visit, every product.
    const inputs: Record<string, unknown> = { schedule_for_day: { day: "2031-03-04" }, overdue_invoices: {}, price_book_lookup: { search: "" } };
    let readsOfA = 0;
    const tools = companyAssistantTools.providerTools(() => true);
    expect(tools.length, "the assistant has no tools to check").toBeGreaterThan(0);
    for (const tool of tools) {
      const input = inputs[tool.name] ?? {};
      const asB = companyAssistantTools.resolve({ toolCallId: "b", name: tool.name, input }, as(fx.bId, fx.B.id));
      if (!asB) throw new Error(\`the \${tool.name} tool wasn't resolved for B\`);
      const out = await asB.execute();
      // A write is only ever offered (never run here), and says nothing of A either.
      expect(mentionsA(JSON.stringify(out)), \`\${tool.name} as B answered with A's data\`).toEqual([]);
      if (out.propose) continue;
      const asA = companyAssistantTools.resolve({ toolCallId: "a", name: tool.name, input }, as(fx.aId, fx.A.id));
      const forA = await asA!.execute();
      if (mentionsA(JSON.stringify(forA.result)).length > 0) readsOfA += 1;
    }
    ${readsPlanted ? `expect(readsOfA, "no tool read anything of A's for A, so the check proved nothing").toBeGreaterThan(0);` : `// No feature with planted rows to read here; only the offered change exists.
    void readsOfA;`}
  });
});
`;
}

const ESTIMATOR_PHOTO_STORE_MOCK = `
/**
 * Photos kept in memory, so the photo routes reach their row checks whether or
 * not this project has file storage connected — without it they refuse before
 * reading any row, which would prove nothing.
 */
vi.mock("@/server/estimator-services", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/estimator-services")>();
  let kept = 0;
  return {
    ...actual,
    estimatorPhotoStore: {
      put: async () => {
        kept += 1;
        return { fileId: "memory-photo-" + kept, url: "memory://photo/" + kept };
      },
      delete: async () => {},
    },
  };
});
`;

/**
 * Tenancy 2b-2a: without a screenshot store (no blob token on a laptop or in
 * CI) the keyed intake's upload route answers "can't be kept here yet" before
 * it reads anything — true, and proof of nothing. The proof hands it a store
 * that keeps nothing, so the upload route reaches its own checks in every
 * project. (A company's keyless feedback page refuses uploads outright.)
 */
const FEEDBACK_SCREENSHOT_STORE = `
/** A screenshot store that keeps nothing, so the keyed upload route reaches its checks. */
let memoryShots = 0;
const memoryScreenshots = {
  put: async () => ({ url: "https://memory.public.blob.vercel-storage.com/probe-" + (memoryShots += 1) + ".png", fileId: null }),
};
`;

// ---------------------------------------------------------------------------
// The Tenancy 2b-1 parts of the isolation proof (14.1): the helpers, the role
// pass over the file routes whose row decides, the public-files suite and the
// negative controls. Raw TypeScript as it is emitted; `${…}` are the
// generator's choices for this project.
// ---------------------------------------------------------------------------

function filesProofHelpers(recordTypeKey: string): string {
  return `
/** The proof's own key for signed links (14.1): at least 32 characters. */
const PROOF_SIGNING_SECRET = "proof-signing-secret-of-thirty-two-plus";

/** The first installed record type files can belong to, or null (the record rows of the role pass). GENERATED. */
const RECORD_TYPE_KEY: string | null = ${recordTypeKey};

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** A link token signed with the proof's own key, in storage's v1 format: v1.{payload}.{HMAC-SHA256 of "v1.{payload}"}. */
async function signLink(claims: { t: string; f: string; u: string; i: number; e: number }): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(PROOF_SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(\`v1.\${payload}\`)));
  return \`v1.\${payload}.\${base64url(mac)}\`;
}

/** The token part of a signed link's address. */
function tokenOf(url: string): string {
  return decodeURIComponent(url.slice(url.lastIndexOf("/v1/f/") + "/v1/f/".length));
}

/** A's PRIVATE object keys found anywhere in an answer: its body or any header (D10, review G8). */
function privateKeysIn(res: Response, text: string): string[] {
  const headers = [...res.headers.entries()].map(([name, value]) => \`\${name}: \${value}\`).join("\\n");
  return fx.aPrivateKeys.filter((key) => key.length > 0 && (text.includes(key) || headers.includes(key)));
}
`;
}

function filesRowDecidesSuite(crewRole: string, named: string, recordFile: string): string {
  return `
describe("feature isolation: where the file or the record decides (files)", () => {
  it("each role gets what the record's and the file's own rules give it by default, and 404 for the rest", async () => {
    // Reviews G14, BO-18: the file routes whose permission is "the row
    // decides" (permission null, with \`access\`) used to be skipped by the
    // role pass. HOW EACH CELL IS DERIVED (D12, in order): files.manage ->
    // everything; one of the record's manage list -> view and add; one of its
    // view list -> view; its assigned permission AND being assigned -> view
    // and add (the planted record has nobody assigned); a file on no record ->
    // files.view (and its purpose's own view list) to view, files.manage to
    // remove; anything else -> 404. Each role's keys are its DEFAULTS in the
    // packages' own permission fragments (the catalog this project seeds),
    // never the handler under test's answer.
    //
    // CONTRACT: 14.1 has the generator compute this table and emit it. It is
    // computed here, at test time, from the same fragments, so a package that
    // changes a default changes the table with it; the cells the contract
    // names are asserted below by name, so it can't quietly stop covering them.
    const defaults: Readonly<Record<string, { readonly defaultFor?: readonly string[] }>> = Object.assign(
      {},
      ...SUITES.map((suite) => suite.permissions),
    );
    const holds = (role: string, permission: string) => defaults[permission]?.defaultFor?.includes(role) ?? false;
    const any = (role: string, permissions: readonly string[]) => permissions.some((permission) => holds(role, permission));
    const record = RECORD_TYPE_KEY === null ? null : (fx.storage.records.get(RECORD_TYPE_KEY) ?? null);
    // The planted record has nobody assigned (14.1), checked, so the "view
    // only" rule below holds for a role whose defaults hold its assigned permission.
    if (record !== null) {
      const planted = (await record.find({ tenantId: fx.aId, ids: [fx.aRows.record ?? ""] })).get(fx.aRows.record ?? "");
      expect(planted?.assignedUserIds ?? [], "the planted record must have nobody assigned").toEqual([]);
    }
    const libraryView = fx.storage.purposes.get("library")?.view ?? ["files.view"];
    const allowed = (role: string, route: FeatureRoute): boolean => {
      const access = (route as { readonly access?: { readonly scope: "file" | "record"; readonly needs: "view" | "manage" | "add" } }).access;
      if (!access) throw new Error(\`\${route.kind} has no access rule (3.1)\`);
      if (holds(role, "files.manage")) return true;
      if (access.scope === "file") {
        // The planted company file: on no record.
        if (access.needs === "manage") return false;
        return holds(role, "files.view") && any(role, libraryView);
      }
      if (record === null) return false;
      if (any(role, record.manage)) return true;
      // View only: nobody is assigned to the planted record.
      return access.needs === "view" && any(role, record.view);
    };
    const rowRoutes = STORAGE_ADMIN_ROUTES.filter(
      (route) => route.permission === null && (RECORD_TYPE_KEY !== null || route.access?.scope !== "record"),
    );
    const roles: readonly { readonly role: string; readonly person: Person }[] = [
      { role: "member", person: fx.A2 },
      { role: "viewer", person: fx.A3 },${crewRole}
    ];
    const table = new Map<string, "allowed" | "not-found">();
    for (const { role } of roles) {
      for (const route of rowRoutes) table.set(\`\${role} \${route.kind}\`, allowed(role, route) ? "allowed" : "not-found");
    }

    // The cells the contract names (14.1), by name.
    const named: readonly string[] = ["viewer file-remove", "member file-remove"${named}];
    for (const cell of named) expect(table.get(cell), cell).toBe("not-found");

    const storageSuite = SUITES.find((suite) => suite.feature === "storage");
    if (!storageSuite) throw new Error("no storage suite");
    let driven = 0;
    for (const { role, person: who } of roles) {
      const admin = storageSuite.admin({ principal: async () => ({ userId: who.id }) });
      for (const route of rowRoutes) {
        const expected = table.get(\`\${role} \${route.kind}\`);
        // An allowed remove or attach would change A's rows; an allowed view
        // (and a link, which writes nothing) is driven.
        if (expected === "allowed" && route.method === "POST" && route.kind !== "file-link") continue;
        const res = await admin.handle(requestFor(storageSuite.adminBase(fx.aId), route, fx.aRows));
        const text = await res.text();
        expect(res.status, \`a \${role} of A on files \${route.kind} (\${expected}): \${text.slice(0, 200)}\`).toBe(expected === "allowed" ? 200 : 404);
        expect(privateKeysIn(res, text), \`files \${route.kind} as a \${role}\`).toEqual([]);
        driven += 1;
      }${recordFile}
    }
    expect(driven, "no row-decides route was driven").toBeGreaterThan(0);
  });
});
`;
}

function filesRecordFileCheck(): string {
  return `
      // The photo on the planted record, opened as this role: a role whose
      // defaults hold none of the record type's view or manage lists, nor
      // files.manage, gets 404 — files.view alone opens no record's files
      // (review G5).
      const contentRoute = STORAGE_ADMIN_ROUTES.find((route) => route.kind === "file-content");
      if (!contentRoute || record === null) throw new Error("no file-content route, or no record type");
      const opens = holds(role, "files.manage") || any(role, record.manage) || any(role, record.view);
      const photo = await admin.handle(
        requestFor(storageSuite.adminBase(fx.aId), contentRoute, { ...fx.aRows, file: fx.aRows["record-file"] ?? "" }),
      );
      expect(photo.status, \`a \${role} of A opening the photo on A's \${RECORD_TYPE_KEY}\`).toBe(opens ? 200 : 404);
      await photo.arrayBuffer();
`;
}

function filesPublicSuite(): string {
  return `
describe("feature isolation: signed links and public files (/api/files)", () => {
  it("opens A's own link, and refuses a tampered one, one signed for B, a removed file's, an expired one, a removed maker's and a suspended company's", async () => {
    // Every entity the public routes name has a planted row of A's.
    for (const route of STORAGE_PUBLIC_ROUTES) {
      for (const entity of entitiesOf(route)) {
        expect(fx.aRows[entity], \`Plant a \${entity} row for company A: the storage public "\${route.kind}" route reads one\`).toBeDefined();
      }
    }
    const open = buildFileLinkHandlers(fx.storage);
    const linkRoute = STORAGE_PUBLIC_ROUTES.find((route) => route.kind === "link");
    const publicRoute = STORAGE_PUBLIC_ROUTES.find((route) => route.kind === "public");
    if (!linkRoute || !publicRoute) throw new Error("storage's public route table changed");
    const get = async (route: FeatureRoute, rows: Readonly<Record<string, string>>): Promise<number> => {
      // Anonymous: no principal, no cookie, the fixed base /api/files/.
      const res = await open.handle(new Request(new URL("/api/files/" + fill(route.path, rows, true), "http://localhost")));
      const text = await res.text();
      // No body or header, A's own included, carries a PRIVATE key (review G8).
      expect(privateKeysIn(res, text), \`/api/files \${route.kind}\`).toEqual([]);
      return res.status;
    };
    const exercised = new Set<string>();

    // A's own link, anonymously: the file.
    expect(await get(linkRoute, fx.aRows), "A's own link").toBe(200);
    exercised.add("link");

    // A's token re-signed for B's company id: the payload changed, the MAC kept.
    const [version, payload, mac] = (fx.aRows["file-token"] ?? "").split(".");
    const claims = JSON.parse(new TextDecoder().decode(base64urlDecode(payload ?? ""))) as Record<string, unknown>;
    const tampered = \`\${version}.\${base64url(new TextEncoder().encode(JSON.stringify({ ...claims, t: fx.bId })))}.\${mac}\`;
    expect(await get(linkRoute, { "file-token": tampered }), "A's token re-signed for B").toBe(404);

    // CORRECTLY signed with the proof's own key, naming B's company with A's
    // file: the (company, file) lookup refuses it, not only the MAC (G2, G14).
    const now = Math.floor(Date.now() / 1000);
    const forged = await signLink({ t: fx.bId, f: fx.aRows.file ?? "", u: fx.B.id, i: now, e: now + 600 });
    expect(await get(linkRoute, { "file-token": forged }), "a correctly signed token naming B with A's file").toBe(404);

    // A removed file's link.
    const gone = await fx.storage.store({
      tenantId: fx.aId,
      purpose: "library",
      bytes: ONE_PIXEL,
      declaredType: "image/png",
      filename: "gone.png",
      addedBy: fx.A.id,
    });
    fx.aPrivateKeys.push(gone.key);
    const goneLink = await fx.storage.signedLink({ tenantId: fx.aId, fileId: gone.id, userId: fx.A.id });
    if (!goneLink) throw new Error("no link to the file about to be removed");
    await fx.storage.remove({ tenantId: fx.aId, fileId: gone.id });
    expect(await get(linkRoute, { "file-token": tokenOf(goneLink.url) }), "a removed file's link").toBe(404);

    // An expired link: the clock moved past its hour.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 61 * 60 * 1000);
      expect(await get(linkRoute, fx.aRows), "A's link an hour and a minute later").toBe(404);
    } finally {
      vi.useRealTimers();
    }

    // A link whose MAKER was removed (review G2): a member makes it, is
    // removed, and their copied link stops working on the next open.
    const leaver = await person("ext_feat_a5", "lee.alpha@alpha-lawn.test", "Lee Alpha");
    const asMember = await tenancy.sendInvitation({ actorUserId: fx.A.id, tenantId: fx.aId, email: leaver.email, roleKey: "member" });
    expect((await tenancy.acceptInvitation({ token: asMember.token, userId: leaver.id })).status).toBe("accepted");
    const theirs = await fx.storage.signedLink({ tenantId: fx.aId, fileId: fx.aRows.file ?? "", userId: leaver.id });
    if (!theirs) throw new Error("the member's link wasn't made");
    expect(await get(linkRoute, { "file-token": tokenOf(theirs.url) }), "a member's link while they are a member").toBe(200);
    await tenancy.removeMember({ actorUserId: fx.A.id, tenantId: fx.aId, targetUserId: leaver.id });
    await tenancy.settleEvents();
    expect(await get(linkRoute, { "file-token": tokenOf(theirs.url) }), "the removed member's link").toBe(404);

    // A SUSPENDED company's links stop, and work again once it is reactivated.
    await db.execute(sql\`update tenants set suspended_at = now(), suspended_reason = 'link test' where id = \${fx.aId}\`);
    try {
      expect(await get(linkRoute, fx.aRows), "A's owner's link while A is suspended").toBe(404);
    } finally {
      await db.execute(sql\`update tenants set suspended_at = null, suspended_reason = null where id = \${fx.aId}\`);
    }
    expect(await get(linkRoute, fx.aRows), "A's owner's link once A is active again").toBe(200);

    // The public route: A's logo by the random part of its key — and never a
    // PRIVATE file, whatever is asked.
    expect(await get(publicRoute, fx.aRows), "A's logo").toBe(200);
    exercised.add("public");
    const privateKey = fx.aPrivateKeys[0] ?? "";
    const privateRandom = privateKey.slice(privateKey.lastIndexOf("/") + 1);
    expect(await get(publicRoute, { "public-key": privateRandom }), "the random part of A's PRIVATE file's key").toBe(404);

    expect([...exercised].sort()).toEqual(STORAGE_PUBLIC_ROUTES.map((route) => route.kind).sort());
  });

  it("never puts a PRIVATE key in an answer to A itself either: every file route, as A's owner", async () => {
    // Review G8: the wire has no field for one, every private file is streamed
    // (never a redirect), and that holds for A's own answers too.
    const storageSuite = SUITES.find((suite) => suite.feature === "storage");
    if (!storageSuite) throw new Error("no storage suite");
    const asOwner = storageSuite.admin({ principal: async () => ({ userId: fx.A.id }) });
    let checked = 0;
    for (const route of STORAGE_ADMIN_ROUTES) {
      // A remove would delete A's file; everything else may run as the owner.
      if (route.kind === "file-remove") continue;
      if (route.access?.scope === "record" && RECORD_TYPE_KEY === null) continue;
      const res = await asOwner.handle(requestFor(storageSuite.adminBase(fx.aId), route, fx.aRows));
      const text = await res.text();
      expect(res.status, \`A's own files \${route.kind}: \${text.slice(0, 200)}\`).toBeLessThan(500);
      expect(privateKeysIn(res, text), \`A's own files \${route.kind}\`).toEqual([]);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
`;
}

function alertsFilesNegativeControl(negStorage: string, negAlerts: string): string {
  return `
  it("rejects the 2b-1 leaks too: a files handler answering B with A's bytes, an alerts handler answering B's list with A's alert", async () => {
    // Tenancy 2b-1 (14.1): the same check, over the two shapes a leak would
    // take on the new routes.${negStorage}${negAlerts}
  });
`;
}

export function renderFeatureIsolationTest(answers: Answers): string {
  const scope = answers.scope;
  const suites = suitesFor(answers);
  const noun = tenantLabel(answers).toLowerCase();
  // Tenancy 2b-1 (14.1).
  const alerts = answers.includeNotifications;
  const storage = answers.includeStorage;
  const assistant = answers.includeAssistant;
  const withPeople = alerts || storage || assistant;
  const records = answers.includeScheduling || answers.includeEstimator || answers.includeInvoicing;
  const routed = records;
  const firstRecordType = answers.includeScheduling
    ? "scheduling.visit"
    : answers.includeEstimator
      ? "estimator.estimate"
      : answers.includeInvoicing
        ? "invoicing.invoice"
        : null;
  const crewRoleLine = answers.includeScheduling ? '\n      { role: "crew", person: fx.A4 },' : "";
  const namedCells = [
    ...(firstRecordType ? ['"viewer attach"'] : []),
    ...(answers.includeScheduling
      ? ['"crew file-get"', '"crew file-content"', '"crew file-link"', '"crew attachments"', '"crew attach"']
      : []),
  ];
  const filesParts = storage
    ? {
        helpers: filesProofHelpers(firstRecordType ? JSON.stringify(firstRecordType) : "null"),
        suites:
          filesRowDecidesSuite(crewRoleLine, namedCells.map((cell) => `, ${cell}`).join(""), firstRecordType ? filesRecordFileCheck() : "") +
          filesPublicSuite(),
      }
    : { helpers: "", suites: "" };
  const negStorage = storage
    ? `
    // A files handler answering B's file-content with A's file, even as a 404:
    // only the "nothing of A" check can catch it.
    const stored = fx.privateStore.objects.get(fx.aPrivateKeys[0] ?? "");
    if (!stored) throw new Error("A's company file isn't in the proof's private store");
    await expect(
      expectIsolated(new Response(new Uint8Array(stored.bytes), { status: 404 }), "a files handler answering B with A's bytes", "not-found"),
    ).rejects.toThrow();`
    : "";
  const negAlerts = alerts
    ? `
    // An alerts handler answering B's list with A's alert.
    const leaked = Response.json({ alerts: [{ id: fx.aRows.alert, title: "Alpha probe alert" }], nextCursor: null, unread: 1, reachable: true });
    await expect(expectIsolated(leaked, "an alerts handler answering B's list with A's alert", "below-500")).rejects.toThrow();`
    : "";
  const negative2b1 = alerts || storage ? alertsFilesNegativeControl(negStorage, negAlerts) : "";

  // The estimator's embed is the one public entry that names its company by a
  // KEY rather than a path, so it gets its own pass (below) with its header.
  const embed = answers.includeEstimator;
  // Feedback's keyed intake (/api/igloo, Tenancy 2b-2a) is the other: a
  // website key names the board, so it gets a pass of its own with its header.
  const intake = answers.includeFeedback;
  // Scheduling's Crew role is one of the company's roles in this project: the
  // role pass checks it too.
  const crew = answers.includeScheduling;
  const routeImports = suites.map(
    (s) =>
      `import { ${[s.adminRoutes, ...(s.publicRoutes ? [s.publicRoutes] : []), s.permissions, ...(embed && s.feature === "estimator" ? ["ESTIMATOR_KEY_HEADER"] : []), ...(s.feature === "feedback" ? ["CLIENT_KEY_HEADER"] : [])].sort().join(", ")} } from "${scope}/${s.pkg}";`,
  );
  const glueImports = suites.map(
    (s) =>
      `import { ${[s.adminBuilder, ...(s.publicBuilder ? [s.publicBuilder] : []), ...(embed && s.feature === "estimator" ? ["buildEstimatorEmbedHandlers"] : []), ...(s.feature === "feedback" ? ["buildFeedbackIntakeHandlers"] : [])].join(", ")} } from "${s.glue}";`,
  );
  if (assistant) {
    routeImports.push(`import type { ProviderAdapter } from "${scope}/assistant";`);
    glueImports.push(`import { companyAssistantTools } from "@/server/assistant-tools";`);
  }
  if (storage) {
    routeImports.push(`import { createMemoryBlobStore, type MemoryBlobStore } from "${scope}/storage/testing";`);
    routeImports.push(`import type { Storage } from "${scope}/storage";`);
    glueImports.push(`import { createFilesStorage } from "@/server/files";`);
  }
  if (answers.includeAnalytics) {
    // The keyed beacon every company's own website calls (its own pass below).
    glueImports.push(`import { buildWebsiteBeaconHandlers } from "@/server/website";`);
  }
  if (answers.includeAeo && answers.includeAi) {
    routeImports.push(`import type { AnswerEngine } from "${scope}/aeo";`);
  }
  const suiteRows = suites
    .map((s) => {
      const pub = s.publicBuilder && s.genericPublic !== false
        ? `public: ${s.publicExpr ?? s.publicBuilder},
    publicRoutes: ${s.publicRoutes},
    publicBase: (slug: string) => \`/api/t/\${slug}/${s.publicSegment}/\`,`
        : `public: null,
    publicRoutes: [],
    publicBase: (_slug: string) => "",`;
      return `  {
    feature: "${s.feature}",
    permissions: ${s.permissions},
    admin: ${s.adminExpr ?? s.adminBuilder},
    adminRoutes: ${s.adminRoutesExpr ?? s.adminRoutes},
    adminBase: (tenantId: string) => \`/api/app/\${tenantId}/${s.adminSegment}/\`,
    ${pub}
  },`;
    })
    .join("\n");

  // A's rows of every installed feature's tables, for "A unchanged": every
  // table by tenant, and the child tables (no tenant column) by A's parents.
  const snapshot: string[] = [];
  if (answers.includeScheduling) {
    snapshot.push(
      `    scheduling_settings: await all(sql\`select * from scheduling_settings where tenant_id = \${a} order by id\`),`,
      `    scheduling_resources: await all(sql\`select * from scheduling_resources where tenant_id = \${a} order by id\`),`,
      `    scheduling_availability: await all(sql\`select * from scheduling_availability where tenant_id = \${a} order by id\`),`,
      `    scheduling_bookings: await all(sql\`select * from scheduling_bookings where tenant_id = \${a} order by id\`),`,
      `    scheduling_visit_tokens: await all(sql\`select * from scheduling_visit_tokens where tenant_id = \${a} order by id\`),`,
    );
  }
  if (answers.includeEstimator) {
    snapshot.push(
      `    estimator_settings: await all(sql\`select * from estimator_settings where tenant_id = \${a} order by id\`),`,
      `    estimator_products: await all(sql\`select * from estimator_products where tenant_id = \${a} order by id\`),`,
      `    estimator_components: await all(sql\`select * from estimator_components where tenant_id = \${a} order by id\`),`,
      `    estimator_product_components: await all(sql\`select * from estimator_product_components where product_id in (select id from estimator_products where tenant_id = \${a}) order by id\`),`,
      `    estimator_options: await all(sql\`select * from estimator_options where product_id in (select id from estimator_products where tenant_id = \${a}) order by id\`),`,
      `    estimator_option_values: await all(sql\`select * from estimator_option_values where option_id in (select o.id from estimator_options o join estimator_products p on p.id = o.product_id where p.tenant_id = \${a}) order by id\`),`,
      `    estimator_estimates: await all(sql\`select * from estimator_estimates where tenant_id = \${a} order by id\`),`,
      `    estimator_estimate_items: await all(sql\`select * from estimator_estimate_items where estimate_id in (select id from estimator_estimates where tenant_id = \${a}) order by id\`),`,
      `    estimator_client_keys: await all(sql\`select * from estimator_client_keys where tenant_id = \${a} order by id\`),`,
      `    estimator_quote_tokens: await all(sql\`select * from estimator_quote_tokens where tenant_id = \${a} order by id\`),`,
      `    estimator_photos: await all(sql\`select * from estimator_photos where tenant_id = \${a} order by id\`),`,
      `    estimator_takeoffs: await all(sql\`select * from estimator_takeoffs where tenant_id = \${a} order by id\`),`,
    );
  }
  if (answers.includeInvoicing) {
    snapshot.push(
      `    invoices: await all(sql\`select * from invoices where tenant_id = \${a} order by id\`),`,
      `    invoice_items: await all(sql\`select * from invoice_items where invoice_id in (select id from invoices where tenant_id = \${a}) order by id\`),`,
      `    invoice_payments: await all(sql\`select * from invoice_payments where invoice_id in (select id from invoices where tenant_id = \${a}) order by id\`),`,
      // Getting paid, part 1: A's Pay now checkouts and its own Stripe account.
      `    invoice_checkouts: await all(sql\`select * from invoice_checkouts where tenant_id = \${a} order by id\`),`,
      `    invoice_card_alerts: await all(sql\`select * from invoice_card_alerts where tenant_id = \${a} order by id\`),`,
      `    stripe_connected_accounts: await all(sql\`select * from stripe_connected_accounts where tenant_id = \${a}\`),`,
    );
  }
  // Getting paid, part 2: A's products (catalog rows under its id), checkouts, orders and store alerts.
  if (answers.includeStore) {
    snapshot.push(
      `    products: await all(sql\`select * from products where tenant_id = \${a} order by id\`),`,
      `    product_variants: await all(sql\`select * from product_variants where product_id in (select id from products where tenant_id = \${a}) order by id\`),`,
      `    store_checkouts: await all(sql\`select * from store_checkouts where tenant_id = \${a} order by id\`),`,
      `    orders: await all(sql\`select * from orders where tenant_id = \${a} order by id\`),`,
      `    order_items: await all(sql\`select * from order_items where order_id in (select id from orders where tenant_id = \${a}) order by id\`),`,
      `    store_alerts: await all(sql\`select * from store_alerts where tenant_id = \${a} order by id\`),`,
      ...(answers.includeInvoicing ? [] : [`    stripe_connected_accounts: await all(sql\`select * from stripe_connected_accounts where tenant_id = \${a}\`),`]),
    );
  }
  if (answers.includeComms) {
    snapshot.push(
      `    comms_templates: await all(sql\`select * from comms_templates where tenant_id = \${a} order by id\`),`,
      `    comms_messages: await all(sql\`select * from comms_messages where tenant_id = \${a} order by id\`),`,
      `    comms_scheduled: await all(sql\`select * from comms_scheduled where tenant_id = \${a} order by id\`),`,
    );
  }
  // Tenancy 2b-1 (14.1): A's alerts, choices, routing and files.
  if (alerts) {
    snapshot.push(
      `    notifications: await all(sql\`select * from notifications where tenant_id = \${a} order by id\`),`,
      `    notification_choices: await all(sql\`select * from notification_choices where tenant_id = \${a} order by user_id, kind\`),`,
      ...(routed ? [`    notification_routing: await all(sql\`select * from notification_routing where tenant_id = \${a} order by routing\`),`] : []),
    );
  }
  if (storage) {
    snapshot.push(`    stored_files: await all(sql\`select * from stored_files where tenant_id = \${a} order by id\`),`);
  }
  // Tenancy 2b-3: A's assistant — its personality (and a version of it), house
  // rules, words, change log, conversations and their messages, offered
  // changes, and its answers to common questions.
  if (assistant) {
    snapshot.push(
      `    assistant_sections: await all(sql\`select * from assistant_sections where tenant_id = \${a} order by id\`),`,
      `    assistant_section_versions: await all(sql\`select * from assistant_section_versions where section_id in (select id from assistant_sections where tenant_id = \${a}) order by id\`),`,
      `    assistant_tenant_rules: await all(sql\`select * from assistant_tenant_rules where tenant_id = \${a} order by id\`),`,
      `    assistant_glossary: await all(sql\`select * from assistant_glossary where tenant_id = \${a} order by id\`),`,
      `    assistant_change_log: await all(sql\`select * from assistant_change_log where tenant_id = \${a} order by id\`),`,
      `    assistant_conversations: await all(sql\`select * from assistant_conversations where tenant_id = \${a} order by id\`),`,
      `    assistant_messages: await all(sql\`select * from assistant_messages where tenant_id = \${a} order by id\`),`,
      `    assistant_pending_actions: await all(sql\`select * from assistant_pending_actions where tenant_id = \${a} order by id\`),`,
      `    assistant_page_docs: await all(sql\`select * from assistant_page_docs where tenant_id = \${a} order by id\`),`,
    );
  }
  // Tenancy 2b-4a: A's websites, its visits and pages read, and who it leaves out.
  if (answers.includeAnalytics) {
    snapshot.push(
      `    analytics_websites: await all(sql\`select * from analytics_websites where tenant_id = \${a} order by id\`),`,
      `    analytics_sessions: await all(sql\`select * from analytics_sessions where tenant_id = \${a} order by id\`),`,
      `    analytics_page_views: await all(sql\`select * from analytics_page_views where tenant_id = \${a} order by id\`),`,
      `    aig_audience_rules: await all(sql\`select * from aig_audience_rules where tenant_id = \${a} order by id\`),`,
    );
  }
  // Tenancy 2b-4b: A's search checks, and its AI mentions (who it is, its questions, the answers).
  if (answers.includeSeoReports) {
    snapshot.push(`    seo_reports: await all(sql\`select * from seo_reports where tenant_id = \${a} order by id\`),`);
  }
  // Tenancy 2b-4c: A's calls, people taking them, hours, days off, holidays, call types and history.
  if (answers.includeBooking) {
    snapshot.push(
      ...["booking_hosts", "booking_availability", "booking_exceptions", "booking_blackouts", "booking_types", "booking_bookings", "booking_events"].map(
        (table) => `    ${table}: await all(sql\`select * from ${table} where tenant_id = \${a} order by id\`),`,
      ),
    );
  }
  // create-app 0.35: A's customers, their addresses, timelines and merges.
  if (answers.includeCustomers) {
    snapshot.push(
      ...["customers", "customer_addresses", "customer_links", "customer_merges", "customer_notices"].map(
        (table) => `    ${table}: await all(sql\`select * from ${table} where tenant_id = \${a} order by id\`),`,
      ),
    );
  }
  if (answers.includeAeo) {
    snapshot.push(
      `    aeo_profiles: await all(sql\`select * from aeo_profiles where tenant_id = \${a}\`),`,
      `    aeo_queries: await all(sql\`select * from aeo_queries where tenant_id = \${a} order by id\`),`,
      `    aeo_checks: await all(sql\`select * from aeo_checks where tenant_id = \${a} order by id\`),`,
    );
  }
  // Tenancy 2b-2a: A's feedback board — its tickets, columns, categories,
  // website keys, and the messages on its tickets (by their ticket).
  if (intake) {
    snapshot.push(
      `    feedback_tickets: await all(sql\`select * from feedback_tickets where tenant_id = \${a} order by id\`),`,
      `    feedback_statuses: await all(sql\`select * from feedback_statuses where tenant_id = \${a} order by id\`),`,
      `    feedback_categories: await all(sql\`select * from feedback_categories where tenant_id = \${a} order by id\`),`,
      `    feedback_client_keys: await all(sql\`select * from feedback_client_keys where tenant_id = \${a} order by id\`),`,
      `    feedback_messages: await all(sql\`select * from feedback_messages where ticket_id in (select id from feedback_tickets where tenant_id = \${a}) order by id\`),`,
      // Feedback 0.11: each ticket's activity trail, with the company on every row.
      `    feedback_ticket_events: await all(sql\`select * from feedback_ticket_events where tenant_id = \${a} order by id\`),`,
      `    feedback_boards: await all(sql\`select * from feedback_boards where tenant_id = \${a}\`),`,
      // Feedback 0.12: A's epics.
      `    feedback_epics: await all(sql\`select * from feedback_epics where tenant_id = \${a} order by id\`),`,
    );
  }

  return `import { beforeAll, describe, expect, it, vi } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { users } from "${scope}/auth/schema";
${routeImports.join("\n")}
import { db } from "@/db";
import { seedPermissions } from "@/permissions/seed";
import { ensureCompanySetup } from "@/server/company-setup";
${glueImports.join("\n")}
import { tenancy } from "@/server/tenancy";
import { plantCompanyRows } from "@/test/company-rows";

/**
 * ONE ${noun.toUpperCase()} CAN'T REACH ANOTHER'S ROWS THROUGH ANY FEATURE ROUTE (Tenancy
 * 2a, D16) — proved on this project's own schema, in-process, on every
 * \`pnpm test\`, through the SAME fetch handlers the app/api routes mount.
 *
 * Two ${tenantLabel(answers) === "Company" ? "companies" : `${noun}s`}, A ("Alpha Lawn Care") and B ("Bravo Roofing"), each with one of
 * every kind of row the installed features read (src/test/company-rows.ts).
 * B even holds a stray owner role in A (no membership), so every refusal is
 * the membership gate's, not a missing grant's. Then, for every route of
 * every installed feature — read from the PACKAGES' OWN route tables, so a
 * route a package adds is checked here the day it ships:
 *
 *   private, as B, with A's id in the path        → 403 forbidden
 *   private, as B, in B's own ${noun}, with A's rows → 404 not_found for a row
 *     named in the path; below 500 for one named only in the body or query
 *   public, anonymous, at B's web address, with A's rows and tokens → the same${
    embed
      ? `
 *   the estimator embed (/api/estimator/…), with B's website KEY and A's rows
 *     and tokens → the same (a key names its ${noun}; a path can't override it)`
      : ""
  }
 *
 * and NOTHING B gets back mentions A — its ids, tokens, people, customers or
 * name — and afterwards every one of A's feature rows is exactly as it was.
 * A route or an entity this file has no plan for fails it by name, and the
 * check itself is shown to bite on a handler that leaks.
 *
 * Requests are same-origin JSON with no X-Forwarded-For, so the rate limiters
 * don't count them (a laptop's rule).
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});
${answers.includeEstimator ? ESTIMATOR_PHOTO_STORE_MOCK : ""}${intake ? FEEDBACK_SCREENSHOT_STORE : ""}${assistant ? PROOF_ASSISTANT_MODEL : ""}${answers.includeSeoReports ? PROOF_SEARCH_NETWORK : ""}${answers.includeAeo && answers.includeAi ? PROOF_ANSWER_ENGINE : ""}${filesParts.helpers}
interface FeatureRoute {
  readonly kind: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly permission: string | null;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

interface FeatureHandler {
  handle(req: Request): Promise<Response>;
}

interface Suite {
  readonly feature: string;
  /** The package's keys, each with the company roles that hold it by default (the role pass reads them). */
  readonly permissions: Readonly<Record<string, { readonly defaultFor?: readonly string[] }>>;
  readonly admin: (overrides: { readonly principal: (req: Request) => Promise<{ readonly userId: string } | null> }) => FeatureHandler;
  readonly adminRoutes: readonly FeatureRoute[];
  readonly adminBase: (tenantId: string) => string;
  readonly public: (() => FeatureHandler) | null;
  readonly publicRoutes: readonly FeatureRoute[];
  readonly publicBase: (slug: string) => string;
}

/** Every installed feature's handlers and route tables. GENERATED: one entry per installed feature. */
const SUITES: readonly Suite[] = [
${suiteRows}
];

interface Person {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

const fx = {} as {
  A: Person;
  A2: Person;
  B: Person;
  aId: string;
  bId: string;
  bSlug: string;
  /** Entity → A's row id (or plaintext token). */
  aRows: Record<string, string>;
  /** The same for B: the mixed-ownership pass puts B's own rows beside A's. */
  bRows: Record<string, string>;
  /** A viewer of A, for the role pass. */
  A3: Person;${crew ? `\n  /** A crew member of A, for the role pass. */\n  A4: Person;` : ""}
  /** Everything that identifies A: its ids, tokens, people, customers, names and web address. */
  aStrings: string[];${
    storage
      ? `
  /** A's PUBLIC logo address and key: checked against B's answers only (A's own Files list rightly shows it; review G8). */
  aStringsForB: string[];
  /** Every PRIVATE object key A's files are stored under: no answer anywhere, A's own included, may carry one (D10). */
  aPrivateKeys: string[];
  /** The proof's own files instance, over memory stores (14.1). */
  storage: Storage;
  privateStore: MemoryBlobStore;
  publicStore: MemoryBlobStore;`
      : ""
  }${
    embed
      ? `
  /** B's plaintext website key: the estimator embed's only way to name a ${noun}. */
  bKey: string;
  /** A's plaintext website key: used under B's web address, it must find nothing. */
  aKey: string;`
      : ""
  }${
    intake
      ? `
  /** B's plaintext feedback website key: the keyed intake's only way to name a board. */
  bFeedbackKey: string;
  /** A's: under B's web address, it must be refused. */
  aFeedbackKey: string;`
      : ""
  }
};

async function person(externalId: string, email: string, name: string): Promise<Person> {
  const [row] = await db.insert(users).values({ externalId, email, displayName: name }).returning();
  if (!row) throw new Error("could not create the test person");
  await tenancy.provisionUser({ userId: row.id, email });
  return { id: row.id, email, name };
}

async function companyOf(owner: Person, name: string): Promise<string> {
  const out = await tenancy.createCompany({
    userId: owner.id,
    name,
    requestKey: \`feature-iso-\${owner.id}\`.slice(0, 64),
    purpose: "onboarding",
  });
  return out.company.id;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

async function all(query: SQL): Promise<Record<string, unknown>[]> {
  return rowsOf(await db.execute(query));
}

/** Every feature row of company A, as JSON: what B must not be able to change. GENERATED per installed feature. */
async function snapshotOfA(): Promise<string> {
  const a = fx.aId;
  return JSON.stringify({
${snapshot.join("\n")}
  });
}

function mentionsA(text: string): string[] {
  return [...fx.aStrings${storage ? ", ...fx.aStringsForB" : ""}].filter((s) => s.length > 0 && text.includes(s));
}

const PLACEHOLDER = /\\{([a-z][a-z-]*)\\}/g;

function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1] ?? "");
}

/** Every placeholder a route names: in its path, its query and its body. */
function entitiesOf(route: FeatureRoute): string[] {
  const inQuery = Object.values(route.query ?? {}).flatMap(placeholdersIn);
  const inBody = placeholdersIn(JSON.stringify(route.body ?? null));
  return [...new Set([...placeholdersIn(route.path), ...inQuery, ...inBody])];
}

/** A row named in the PATH is a row the route reads: another company's must be "not found". */
function readsARow(route: FeatureRoute): boolean {
  return placeholdersIn(route.path).length > 0;
}

function fill(text: string, rows: Readonly<Record<string, string>>, encode: boolean): string {
  return text.replace(PLACEHOLDER, (_whole, entity: string) => {
    const value = rows[entity];
    if (value === undefined) throw new Error(\`no planted row for {\${entity}}\`);
    return encode ? encodeURIComponent(value) : value;
  });
}

function fillDeep(value: unknown, rows: Readonly<Record<string, string>>): unknown {
  if (typeof value === "string") return fill(value, rows, false);
  if (Array.isArray(value)) return value.map((item) => fillDeep(item, rows));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillDeep(item, rows)]));
  }
  return value;
}

/** A 1×1 PNG, for the upload routes (14.1: \`{ multipart: "file" }\` bodies). */
const ONE_PIXEL = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

/** A route whose body is a file upload (Tenancy 2b-1: storage's \`upload\` and \`attach\`). */
function isUpload(route: FeatureRoute): boolean {
  const body = route.body as { multipart?: unknown } | undefined;
  return typeof body === "object" && body !== null && body.multipart === "file";
}

function requestFor(
  base: string,
  route: FeatureRoute,
  rows: Readonly<Record<string, string>>,
  extraHeaders: Readonly<Record<string, string>> = {},
  /** The rows the PATH names, when they differ from the body's and query's (the mixed-ownership pass). */
  pathRows: Readonly<Record<string, string>> = rows,
): Request {
  const url = new URL(base + fill(route.path, pathRows, true), "http://localhost");
  for (const [key, value] of Object.entries(route.query ?? {})) url.searchParams.set(key, fill(value, rows, false));
  const headers = { "sec-fetch-site": "same-origin", ...extraHeaders };
  if (route.method === "GET") return new Request(url, { headers });
  if (isUpload(route)) {
    const form = new FormData();
    form.append("file", new Blob([ONE_PIXEL], { type: "image/png" }), "probe.png");
    return new Request(url, { method: "POST", headers, body: form });
  }
  return new Request(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(fillDeep(route.body ?? {}, rows)),
  });
}

type Expectation = "forbidden" | "not-found" | "below-500" | "refused";

/**
 * THE ONE CHECK every route's answer goes through: the status the case calls
 * for, and nothing of company A anywhere in the body. Throws (an expect
 * failure) when the answer leaks; the negative control below shows it does.
 */
async function expectIsolated(res: Response, label: string, expectation: Expectation): Promise<void> {
  const text = await res.text();
  let code: unknown;
  try {
    code = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code;
  } catch {
    code = undefined;
  }
  expect(mentionsA(text), \`\${label} answered with company A's own data: \${text.slice(0, 300)}\`).toEqual([]);
  if (expectation === "forbidden") {
    expect([res.status, code], \`\${label}: \${text.slice(0, 300)}\`).toEqual([403, "forbidden"]);
  } else if (expectation === "not-found") {
    expect([res.status, code], \`\${label}: \${text.slice(0, 300)}\`).toEqual([404, "not_found"]);
  } else if (expectation === "refused") {
    // A 4xx: not found, or invalid — never done, never a 500.
    expect(res.status >= 400 && res.status < 500, \`\${label} should be refused: \${res.status} \${text.slice(0, 300)}\`).toBe(true);
  } else {
    expect(res.status, \`\${label}: \${text.slice(0, 300)}\`).toBeLessThan(500);
  }
}

/**
 * MIXED OWNERSHIP (review TB-4): the ways one request can carry B's own rows
 * AND one of A's. B's rows in the path with A's in the body or query ("attach
 * A's supply to my product"); and, for a path naming two rows, A's in either
 * place among B's. Driving every placeholder from A alone never reached the
 * second lookup: the path's first row was already "not found".
 */
function mixesOf(route: FeatureRoute): { readonly label: string; readonly path: Record<string, string>; readonly other: Record<string, string> }[] {
  const inPath = placeholdersIn(route.path);
  if (inPath.length === 0) return [];
  const elsewhere = entitiesOf(route).filter((entity) => !inPath.includes(entity));
  const mixes: { label: string; path: Record<string, string>; other: Record<string, string> }[] = [];
  if (elsewhere.length > 0) {
    mixes.push({ label: \`B's rows in the path and A's \${elsewhere.join(", ")} in the body or query\`, path: fx.bRows, other: fx.aRows });
  }
  if (inPath.length > 1) {
    for (const entity of inPath) {
      mixes.push({ label: \`A's \${entity} among B's rows in the path\`, path: { ...fx.bRows, [entity]: fx.aRows[entity] ?? "" }, other: fx.bRows });
    }
  }
  return mixes;
}

beforeAll(async () => {
  await seedPermissions(db, { log: () => {} });
  fx.A = await person("ext_feat_a", "ada.alpha@alpha-lawn.test", "Ada Alpha");
  fx.A2 = await person("ext_feat_a2", "arlo.alpha@alpha-lawn.test", "Arlo Alpha");
  fx.B = await person("ext_feat_b", "ben.bravo@bravo-roofing.test", "Ben Bravo");
  fx.aId = await companyOf(fx.A, "Alpha Lawn Care");
  fx.bId = await companyOf(fx.B, "Bravo Roofing");

  const joined = await tenancy.sendInvitation({ actorUserId: fx.A.id, tenantId: fx.aId, email: fx.A2.email, roleKey: "member" });
  expect((await tenancy.acceptInvitation({ token: joined.token, userId: fx.A2.id })).status).toBe("accepted");

  // A STRAY ROLE ROW: B holds the owner role in A without being a member, so
  // every refusal below is the membership gate's, proved against the worst
  // case rather than the tidy one.
  await db.execute(sql\`insert into principal_role (principal_id, scope, tenant_id, template_id)
    select \${fx.B.id}, 'tenant', \${fx.aId}, id from role_template
    where scope = 'tenant' and key = 'owner' and tenant_id = '*'\`);

  // Each company's first-time setup (what its first feature request does),
  // then one of every row its features read.
  await ensureCompanySetup(fx.aId);
  await ensureCompanySetup(fx.bId);${
    storage
      ? `
  // The proof's OWN files instance (14.1): the project's purposes, records and
  // rules — and its real \`stillValid\`, over this test's tenancy — on memory
  // stores, with the proof's own signing key.
  fx.privateStore = createMemoryBlobStore({ access: "private" });
  fx.publicStore = createMemoryBlobStore({ access: "public" });
  fx.storage = createFilesStorage({ private: fx.privateStore, public: fx.publicStore }, { signingSecret: PROOF_SIGNING_SECRET });`
      : ""
  }
  const a = await plantCompanyRows(db, fx.aId, "alpha"${withPeople ? `, { owner: fx.A.id, member: fx.A2.id${storage ? ", storage: fx.storage" : ""} }` : ""});
  const b = await plantCompanyRows(db, fx.bId, "bravo"${withPeople ? `, { owner: fx.B.id, member: null${storage ? ", storage: fx.storage" : ""} }` : ""});
  fx.aRows = { ...a.rows };
  fx.bRows = { ...b.rows };${
    storage
      ? `
  fx.aStringsForB = [...a.publicStrings];
  fx.aPrivateKeys = [...a.privateKeys];`
      : ""
  }${
    embed
      ? `
  const bKey = b.rows["embed-key"];
  if (!bKey) throw new Error("company B has no website key to call the estimator embed with");
  fx.bKey = bKey;
  const aKey = a.rows["embed-key"];
  if (!aKey) throw new Error("company A has no website key");
  fx.aKey = aKey;`
      : ""
  }${
    intake
      ? `
  const bFeedbackKey = b.rows["feedback-website-key"];
  const aFeedbackKey = a.rows["feedback-website-key"];
  if (!bFeedbackKey || !aFeedbackKey) throw new Error("the companies have no feedback website keys");
  fx.bFeedbackKey = bFeedbackKey;
  fx.aFeedbackKey = aFeedbackKey;`
      : ""
  }

  // The role pass's people: a viewer${crew ? " and a crew member" : ""} of A, invited like anyone else.
  fx.A3 = await person("ext_feat_a3", "vera.alpha@alpha-lawn.test", "Vera Alpha");
  const asViewer = await tenancy.sendInvitation({ actorUserId: fx.A.id, tenantId: fx.aId, email: fx.A3.email, roleKey: "viewer" });
  expect((await tenancy.acceptInvitation({ token: asViewer.token, userId: fx.A3.id })).status).toBe("accepted");${crew ? `
  fx.A4 = await person("ext_feat_a4", "cole.alpha@alpha-lawn.test", "Cole Alpha");
  const asCrew = await tenancy.sendInvitation({ actorUserId: fx.A.id, tenantId: fx.aId, email: fx.A4.email, roleKey: "crew" });
  expect((await tenancy.acceptInvitation({ token: asCrew.token, userId: fx.A4.id })).status).toBe("accepted");` : ""}

  const companyA = await tenancy.companyFor(fx.aId);
  const companyB = await tenancy.companyFor(fx.bId);
  if (!companyA || !companyB) throw new Error("the two companies are missing");
  fx.bSlug = companyB.slug;
  fx.aStrings = [
    fx.A.id,
    fx.A2.id,
    fx.A3.id,
    fx.aId,
    fx.A.email,
    fx.A2.email,
    fx.A3.email,
    fx.A.name,
    fx.A2.name,
    fx.A3.name,${crew ? "\n    fx.A4.id,\n    fx.A4.email,\n    fx.A4.name," : ""}
    companyA.name,
    companyA.slug,
    ...a.strings,${storage ? "\n    // Every private object key of A's (D10): never in any answer of B's.\n    ...a.privateKeys," : ""}
  ];
});

describe("feature isolation: every route has a plan", () => {
  it("has a planted row of company A for every entity a route names", () => {
    for (const suite of SUITES) {
      for (const route of [...suite.adminRoutes, ...suite.publicRoutes]) {
        for (const entity of entitiesOf(route)) {
          expect(
            fx.aRows[entity],
            \`Plant a \${entity} row for company A in src/test/company-rows.ts: the \${suite.feature} "\${route.kind}" route reads one\`,
          ).toBeDefined();
        }
      }
    }
  });

  it("drives at least one route of every installed feature", () => {
    for (const suite of SUITES) expect(suite.adminRoutes.length, suite.feature).toBeGreaterThan(0);
  });

  it("has at least one of A's rows in EVERY table it checks, so a list route that leaks has something to leak", async () => {
    // Review TB-1: the calendar, its requests, the Messages log and the queue
    // answered empty for A whatever their tenant filter did, so dropping the
    // filter passed. An empty table here is a check that can't fail.
    const snapshot = JSON.parse(await snapshotOfA()) as Record<string, unknown[]>;
    for (const [table, rows] of Object.entries(snapshot)) {
      expect(rows.length, \`Plant a \${table} row for company A in src/test/company-rows.ts: an empty table proves nothing\`).toBeGreaterThan(0);
    }
  });
});

describe("feature isolation: the routes", () => {
  it("refuses every private route for a ${noun} the caller isn't in, and every row of another ${noun} — and changes nothing of A's", async () => {
    const before = await snapshotOfA();
    const exercised = new Set<string>();
    const asB = { principal: async () => ({ userId: fx.B.id }) };

    for (const suite of SUITES) {
      const admin = suite.admin(asB);
      for (const route of suite.adminRoutes) {
        // A's company in the path: refused as "not part of this company".
        await expectIsolated(
          await admin.handle(requestFor(suite.adminBase(fx.aId), route, fx.aRows)),
          \`\${suite.feature} \${route.kind} with A's company in the path\`,
          "forbidden",
        );
        // B's own company, A's rows: not found, or nothing of A.
        await expectIsolated(
          await admin.handle(requestFor(suite.adminBase(fx.bId), route, fx.aRows)),
          \`\${suite.feature} \${route.kind} in B's company with A's rows\`,
          readsARow(route) ? "not-found" : "below-500",
        );
        exercised.add(\`admin:\${suite.feature}:\${route.kind}\`);
      }

      if (suite.public) {
        const open = suite.public();
        for (const route of suite.publicRoutes) {
          await expectIsolated(
            await open.handle(requestFor(suite.publicBase(fx.bSlug), route, fx.aRows)),
            \`\${suite.feature} public \${route.kind} at B's web address with A's rows\`,
            readsARow(route) ? "not-found" : "below-500",
          );
          exercised.add(\`public:\${suite.feature}:\${route.kind}\`);
        }
      }
    }
${
    embed
      ? `
    // THE ESTIMATOR EMBED (/api/estimator/…, what a ${noun}'s own website
    // calls): no web address in the path — the website KEY names the ${noun}.
    // With B's key, every public route with A's rows and tokens is "not
    // found" or says nothing of A.
    const embedded = buildEstimatorEmbedHandlers();
    for (const route of ESTIMATOR_PUBLIC_ROUTES) {
      await expectIsolated(
        await embedded.handle(requestFor("/api/estimator/", route, fx.aRows, { [ESTIMATOR_KEY_HEADER]: fx.bKey })),
        \`estimator embed \${route.kind} with B's website key and A's rows\`,
        readsARow(route) ? "not-found" : "below-500",
      );
      exercised.add(\`embed:estimator:\${route.kind}\`);
    }
`
      : ""
  }
${
    intake
      ? `
    // FEEDBACK'S KEYED INTAKE (/api/igloo, what a ${noun}'s own website and
    // this site's own button call): no web address — the website KEY names
    // the board. With B's key, every route with A's ticket number and
    // reporter token is "not found" or says nothing of A.
    const keyed = buildFeedbackIntakeHandlers({ screenshots: memoryScreenshots });
    for (const route of FEEDBACK_PUBLIC_ROUTES) {
      await expectIsolated(
        await keyed.handle(requestFor("/api/igloo/", route, fx.aRows, { [CLIENT_KEY_HEADER]: fx.bFeedbackKey })),
        \`feedback intake \${route.kind} with B's website key and A's rows\`,
        readsARow(route) ? "not-found" : "below-500",
      );
      exercised.add(\`intake:feedback:\${route.kind}\`);
    }
    // A's website key under B's web address: the address decides, and a key
    // of another ${noun} is refused there, never read as A's.
    const atBravo = buildFeedbackPublicHandlers();
    for (const route of FEEDBACK_PUBLIC_ROUTES) {
      await expectIsolated(
        await atBravo.handle(requestFor(\`/api/t/\${fx.bSlug}/feedback/\`, route, fx.aRows, { [CLIENT_KEY_HEADER]: fx.aFeedbackKey })),
        \`feedback public \${route.kind} with A's website key under B's web address\`,
        "refused",
      );
    }
`
      : ""
  }
    // Every route kind of every table was driven: none skipped.
    const expected = [
      ...SUITES.flatMap((suite) => [
        ...suite.adminRoutes.map((route) => \`admin:\${suite.feature}:\${route.kind}\`),
        ...suite.publicRoutes.map((route) => \`public:\${suite.feature}:\${route.kind}\`),
      ]),${embed ? `
      ...ESTIMATOR_PUBLIC_ROUTES.map((route) => \`embed:estimator:\${route.kind}\`),` : ""}${intake ? `
      ...FEEDBACK_PUBLIC_ROUTES.map((route) => \`intake:feedback:\${route.kind}\`),` : ""}
    ];
    expect([...exercised].sort()).toEqual([...new Set(expected)].sort());

    // MIXED OWNERSHIP (review TB-4): B's own rows beside one of A's — in the
    // body or query, or among two rows in the path. Every one is refused and
    // says nothing of A.
    let mixed = 0;
    for (const suite of SUITES) {
      const admin = suite.admin(asB);
      const open = suite.public ? suite.public() : null;
      const targets = [
        ...suite.adminRoutes.map((route) => ({ route, base: suite.adminBase(fx.bId), handler: admin, where: "admin" })),
        ...(open ? suite.publicRoutes.map((route) => ({ route, base: suite.publicBase(fx.bSlug), handler: open, where: "public" })) : []),
      ];
      for (const { route, base, handler, where } of targets) {
        for (const mix of mixesOf(route)) {
          await expectIsolated(
            await handler.handle(requestFor(base, route, mix.other, {}, mix.path)),
            \`\${suite.feature} \${where} \${route.kind} with \${mix.label}\`,
            "refused",
          );
          mixed += 1;
        }
      }
    }
    ${
      // Only scheduling's, the estimator's and feedback's tables have a route
      // naming two rows; invoicing's, messages', alerts', files' and the
      // assistant's name one each. A project with none of the three has no
      // mixed pass to count (an invoicing-only project used to fail here).
      answers.includeScheduling || answers.includeEstimator || answers.includeFeedback
        ? `expect(mixed, "no route mixes two rows, so the mixed pass checked nothing").toBeGreaterThan(0);`
        : `// No installed feature's routes name two rows (scheduling, the estimator
    // and feedback are the ones that do), so this project has no mixed pass to count.
    void mixed;`
    }${embed ? `

    // A's website key under B's web address (review SEC-2A-04): the address
    // decides, never the key — every public route is "not found".
    const estimatorPublic = SUITES.find((suite) => suite.feature === "estimator")?.public;
    if (!estimatorPublic) throw new Error("the estimator suite has no public handler");
    const atB = estimatorPublic();
    for (const route of ESTIMATOR_PUBLIC_ROUTES) {
      await expectIsolated(
        await atB.handle(requestFor(\`/api/t/\${fx.bSlug}/estimator/\`, route, fx.aRows, { [ESTIMATOR_KEY_HEADER]: fx.aKey })),
        \`estimator public \${route.kind} with A's website key under B's web address\`,
        "not-found",
      );
    }` : ""}

    // And nothing of A's changed.
    expect(await snapshotOfA()).toBe(before);
  });
});

describe("feature isolation: each role is refused what it doesn't hold", () => {
  it("a member, a viewer${crew ? " and a crew member" : ""} of A get 403 from every route whose permission their role doesn't hold by default", async () => {
    // Review TB-4: the routes' permissions were proved only against
    // strangers; a route asking a WEAKER key than its table says (a viewer
    // editing estimates, a crew member reading the whole calendar) passed
    // every check. The defaults come from the PACKAGES' own fragments, not
    // from the handler under test. A route a role may use is not driven here:
    // it would change A's rows.
    const roles: readonly { readonly role: string; readonly person: Person }[] = [
      { role: "member", person: fx.A2 },
      { role: "viewer", person: fx.A3 },${crew ? "\n      { role: \"crew\", person: fx.A4 }," : ""}
    ];
    let refused = 0;
    for (const { role, person: who } of roles) {
      for (const suite of SUITES) {
        const admin = suite.admin({ principal: async () => ({ userId: who.id }) });
        for (const route of suite.adminRoutes) {
          if (route.permission === null) continue;
          if (suite.permissions[route.permission]?.defaultFor?.includes(role)) continue;
          const res = await admin.handle(requestFor(suite.adminBase(fx.aId), route, fx.aRows));
          const text = await res.text();
          let code: unknown;
          try {
            code = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code;
          } catch {
            code = undefined;
          }
          expect([res.status, code], \`a \${role} of A on \${suite.feature} \${route.kind} (needs \${route.permission}): \${text.slice(0, 200)}\`).toEqual([403, "forbidden"]);
          refused += 1;
        }
      }
    }
    expect(refused, "no role was refused anything, so the pass checked nothing").toBeGreaterThan(0);
  });
});
${filesParts.suites}${assistant ? assistantToolsSuite(answers) : ""}${answers.includeAnalytics ? websiteBeaconsSuite(answers) + audiencePeopleSuite(answers) : ""}
describe("feature isolation: the check bites (negative control)", () => {
  it("rejects a handler that answers with company A's row, for a row route and for a reference route", async () => {
    const routes = SUITES.flatMap((suite) => [...suite.adminRoutes, ...suite.publicRoutes]);
    const rowRoute = routes.find(readsARow);
    const referenceRoute = routes.find((route) => !readsARow(route));
    // THE LEAK 2a EXISTS TO PREVENT: a handler that answers every request
    // with company A's planted rows.
    const leak = (status: number) => new Response(JSON.stringify({ row: fx.aRows }), { status });
    if (rowRoute) {
      await expect(expectIsolated(leak(200), "a leaking row route", "not-found")).rejects.toThrow();
      await expect(expectIsolated(leak(404), "a row route whose 404 leaks", "not-found")).rejects.toThrow();
    }
    if (referenceRoute) {
      await expect(expectIsolated(leak(200), "a leaking reference route", "below-500")).rejects.toThrow();
    }
    expect(rowRoute ?? referenceRoute, "no route at all to control against").toBeDefined();
    // And an honest answer passes the same check.
    await expect(
      expectIsolated(Response.json({ error: { code: "not_found", message: "Not here." } }, { status: 404 }), "an honest 404", "not-found"),
    ).resolves.toBeUndefined();
  });
${negative2b1}});
`;
}

// ---------------------------------------------------------------------------
// src/server/__tests__/company-alerts.test.ts (companies, with notifications)
// ---------------------------------------------------------------------------

/**
 * The alerts proof (Tenancy 2b-1, 14.2): through the project's own glue, per
 * installed feature — a lead is A's, twice is once, the crew, choices,
 * routing, suspended, the cron, an email that didn't go, a demotion, a failed
 * office email retried once, the team's own allowance, a removal while an
 * email waited, and an email switched off in Messages. Each case is written
 * only where the features it needs are installed.
 */
export function renderCompanyAlertsTest(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  const NOUN = noun.toUpperCase();
  const nouns = tenantLabelPlural(answers).toLowerCase();
  const est = answers.includeEstimator;
  const sched = answers.includeScheduling;
  const inv = answers.includeInvoicing;
  const comms = answers.includeComms;
  const storage = answers.includeStorage;
  const mail = comms && answers.includeEmail;
  const commsNoMail = comms && !answers.includeEmail;
  const mailEst = mail && est;
  const sweeps = sched || inv;
  const demote = est && sched;
  // A CUSTOMER template of an installed package: what "an email didn't go" is about.
  const customerTemplate = sched ? "visit_confirmed" : est ? "estimate_lead_customer" : inv ? "invoice_sent" : "";
  const customerTpl = comms && customerTemplate !== "";
  const mailCustomer = mail && customerTpl;
  const demotedTo = "crew";
  const sweepWords = [...(sched ? ["a visit request about to lapse"] : []), ...(inv ? ["an invoice gone overdue"] : [])].join(" and ");
  void storage;
  const cases = `${est ? `  it("1. a lead is A's: A's owner has the alert, nobody in B does${mail ? ` — and exactly one office email, under A's name, at the business email once it is set` : ""}", async () => {
    const { estimateId } = await leadForA();
    const mine = await alertsFor(fx.aId, fx.A.id, "estimator.lead");
    expect(mine.map((row) => row.dedupe_key)).toEqual([\`estimator.lead:\${estimateId}\`]);
    expect(String(mine[0]?.title)).toContain("Lena Lead");
    const inB = await all(sql\`select id from notifications where tenant_id = \${fx.bId}\`);
    expect(inB.filter((row) => String(row.id) === String(mine[0]?.id))).toEqual([]);
    expect(await alertsFor(fx.bId, fx.B.id, "estimator.lead")).toEqual([]);${mail ? `
    // ONE office email (D6): the estimator's own, rich one, to the owner's
    // copies' address, from A — and no second copy from the alerts.
    const office = await messages(fx.aId, "estimate_lead_staff");
    expect(office.map((m) => m.to)).toEqual([await ownersCopiesTo(fx.aId)]);
    expect(office[0]?.fromName).toBe("Alpha Lawn Care");
    expect(office[0]?.status).toBe("sent");
    expect(await messages(fx.aId, "team_alert")).toEqual([]);

    // With a business email in A's settings, the owner's copy goes THERE
    // (review BO-01), once, and not to the owner's own sign-in address.
    await tenancy.updateSettings({ actorUserId: fx.A.id, tenantId: fx.aId, section: "company", values: { contactEmail: "office@alpha.test" } });
    await leadForA("Second Lead");
    const after = await messages(fx.aId, "estimate_lead_staff");
    expect(after.length).toBe(2);
    expect(after[1]?.to).toBe("office@alpha.test");
    expect(after.filter((m) => m.to === fx.A.email).length).toBe(1);` : ""}
  });

  it("2. twice is once: the same lead handed to the listeners again writes no second alert${mail ? ` and sends no second email` : ""}", async () => {
    const { event } = await leadForA("Replay Lead");
    const before = (await alertsFor(fx.aId, fx.A.id, "estimator.lead")).length;${mail ? `
    const sent = (await messages(fx.aId, "estimate_lead_staff")).length;` : ""}
    await onEstimatorEvent(event);
    expect((await alertsFor(fx.aId, fx.A.id, "estimator.lead")).length).toBe(before);${mail ? `
    expect((await messages(fx.aId, "estimate_lead_staff")).length).toBe(sent);` : ""}
  });
` : ""}${sched ? `
  it("3. the crew: only the crew on the visit hears of a customer's move${mail ? `, by their own team alert` : ""} — today's move opens their day, another day's ${storage ? `its photos and files` : ""}${!storage ? `nothing` : ""}", async () => {
    const crewMember = await memberOfA("ext_alerts_crew", "cam@alpha-crew.test", "crew");
    const north = await crewOfA("North", crewMember.id);
    const south = await crewOfA("South", null);
    const today = await todayThere(fx.aId);

    // A customer moves a visit on the crew's own crew to TODAY.
    const visit = await requestVisit(north, 3);${comms ? `
    const officeTo = await ownersCopiesTo(fx.aId);
    const noticesBefore = (await messages(fx.aId, "visit_staff_notice")).filter((m) => m.to === officeTo).length;` : ""}
    await customerMoves(visit, today, "20:00");${comms ? `
    // A's owner gets exactly one office notice for the move.
    expect((await messages(fx.aId, "visit_staff_notice")).filter((m) => m.to === officeTo).length).toBe(noticesBefore + 1);` : ""}
    const crewAlerts = await alertsFor(fx.aId, crewMember.id);
    expect(crewAlerts.map((row) => row.kind)).toEqual(["scheduling.visit.moved"]);
    expect(crewAlerts[0]?.reached_via).toBe("assigned");
    expect(crewAlerts[0]?.href).toBe("/app/schedule/today");
    // The office still hears (the owner, the visits group's default).
    expect((await alertsFor(fx.aId, fx.A.id, "scheduling.visit.moved")).length).toBe(1);${mail ? `
    // The crew's email is notifications' team alert, linking to their day —
    // never the office notice, written for the office (review BO-03).
    expect((await messages(fx.aId, "visit_staff_notice")).filter((m) => m.to === crewMember.email)).toEqual([]);
    expect((await messages(fx.aId, "team_alert")).filter((m) => m.to === crewMember.email).map((m) => m.status)).toEqual(["sent"]);
    // Its link opens their day, through the switch route.
    expect(mail.outbox.filter((m) => m.to === crewMember.email).at(-1)?.text ?? "").toContain(encodeURIComponent("/app/schedule/today"));` : ""}

    // A move to ANOTHER day (review BO-04): the crew's route is today-only.
    const later = await requestVisit(north, 5, "11:00", "12:00");
    const day = new Date(\`\${today}T12:00:00Z\`);
    day.setUTCDate(day.getUTCDate() + 6);
    await customerMoves(later, day.toISOString().slice(0, 10), "13:00");
    const moved = (await alertsFor(fx.aId, crewMember.id)).at(-1);
    expect(moved?.href ?? null).toBe(${storage ? `\`/app/schedule/visits/\${encodeURIComponent(later)}/files\`` : ""}${!storage ? `null` : ""});

    // A move on the OTHER crew: the crew member hears nothing of it.
    const theirs = (await alertsFor(fx.aId, crewMember.id)).length;
    const other = await requestVisit(south, 4, "08:00", "09:00");
    await customerMoves(other, day.toISOString().slice(0, 10), "15:00");
    expect((await alertsFor(fx.aId, crewMember.id)).length).toBe(theirs);
  });

  it("4. choices: the owner sets \\"A customer moves a visit\\" to In the app — the next move still alerts, and emails nobody", async () => {
    await alerts.setChoice({ tenantId: fx.aId, userId: fx.A.id, kind: "scheduling.visit.moved", channel: "in_app" });
    const crewless = await crewOfA("West", null);
    const visit = await requestVisit(crewless, 8, "09:00", "10:00");${comms ? `
    const before = (await messages(fx.aId, "visit_staff_notice")).length;
    const teamBefore = (await messages(fx.aId, "team_alert")).length;` : ""}
    const day = new Date(\`\${await todayThere(fx.aId)}T12:00:00Z\`);
    day.setUTCDate(day.getUTCDate() + 9);
    await customerMoves(visit, day.toISOString().slice(0, 10), "10:00");
    const moved = (await alertsFor(fx.aId, fx.A.id, "scheduling.visit.moved")).at(-1);
    expect(moved?.email_status).toBe("none");${comms ? `
    // The move's office email stopped (the request's went before it).
    expect((await messages(fx.aId, "visit_staff_notice")).length).toBe(before);
    expect((await messages(fx.aId, "team_alert")).length).toBe(teamBefore);` : ""}
  });

  it("5. routing: the owner chooses a member for visit requests; removed, the owner hears again (never nobody), their alerts go and their bell refuses them", async () => {
    const mia = await memberOfA("ext_alerts_mia", "mia@alpha-office.test", "member");
    await alerts.setRouting({ tenantId: fx.aId, routing: "visits", mode: "chosen", userIds: [mia.id], extraEmails: [], by: fx.A.id });
    const ownerBefore = (await alertsFor(fx.aId, fx.A.id, "scheduling.visit.requested")).length;
    await requestVisit(null, 10);
    expect((await alertsFor(fx.aId, mia.id, "scheduling.visit.requested")).length).toBe(1);
    expect((await alertsFor(fx.aId, fx.A.id, "scheduling.visit.requested")).length).toBe(ownerBefore);

    await tenancy.removeMember({ actorUserId: fx.A.id, tenantId: fx.aId, targetUserId: mia.id });
    await tenancy.settleEvents();
    await requestVisit(null, 11);
    expect((await alertsFor(fx.aId, fx.A.id, "scheduling.visit.requested")).length).toBe(ownerBefore + 1);
    expect(await alertsFor(fx.aId, mia.id)).toEqual([]);
    expect((await asReader(mia, "v1/admin/count")).status).toBe(403);
  });

  it("6. suspended: a request event for a suspended ${noun} writes nothing${comms ? ", emails nobody" : ""} and reports nothing — a quiet skip", async () => {
    const { log } = await import("@/server/logger");
    const errors = vi.spyOn(log, "error");
    await db.execute(sql\`update tenants set suspended_at = now(), suspended_reason = 'alerts test' where id = \${fx.aId}\`);
    try {
      const before = (await all(sql\`select id from notifications where tenant_id = \${fx.aId}\`)).length;${comms ? `
      const noticesBefore = (await messages(fx.aId, "visit_staff_notice")).length;` : ""}
      await requestVisit(null, 12);
      expect((await all(sql\`select id from notifications where tenant_id = \${fx.aId}\`)).length).toBe(before);${comms ? `
      expect((await messages(fx.aId, "visit_staff_notice")).length).toBe(noticesBefore);` : ""}
      // Nothing "failed": a suspended ${noun} is skipped on purpose (D9).
      expect(errors.mock.calls.map((call) => String(call[1] ?? call[0]))).toEqual([]);
    } finally {
      errors.mockRestore();
      await db.execute(sql\`update tenants set suspended_at = null, suspended_reason = null where id = \${fx.aId}\`);
    }
  });
` : ""}${sweeps ? `
  it("7. the cron: ${sweepWords} — one alert each, none more on the next run${mail ? `, and an alert email that failed goes on a later run` : ""}", async () => {${sched ? `
    // A request made 30 hours ago, about to lapse (its deadline is within the day).
    const { visit } = await bookVisit(
      db,
      { tenantId: fx.aId, scheduledDate: "2031-05-06", startTime: "09:00", endTime: "10:00", customerName: "Ezra Expiring", customerEmail: "ezra@customer.test", status: "pending" },
      { now: new Date(Date.now() - 30 * 60 * 60 * 1000), skipValidation: true },
    );
    // The row's own clock says when it was made (the database sets it), so it
    // is moved back too: the sweep warns only about requests over six hours old.
    await db.execute(sql\`update scheduling_bookings set created_at = \${new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString()}::timestamptz where id = \${visit.id}\`);` : ""}${inv ? `
    // An invoice due two days ago, sent and unpaid.
    const invoice = await createInvoice(db, {
      tenantId: fx.aId,
      customerName: "Olive Overdue",
      customerEmail: "olive@customer.test",
      items: [{ description: "Spring clean-up", quantity: 1, unitPrice: 30_000 }],
      dueDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });
    await setInvoiceStatus(db, { tenantId: fx.aId, id: invoice.id, status: "sent" });` : ""}${mail ? `
    // The first alert email the run sends fails, as a provider that's down would.
    mail.failOnceTo = await ownersCopiesTo(fx.aId);` : ""}
    await runCron();${sched ? `
    expect((await alertsFor(fx.aId, fx.A.id, "scheduling.request.expiring")).filter((row) => String(row.dedupe_key).includes(visit.id)).length).toBe(1);` : ""}${inv ? `
    expect((await alertsFor(fx.aId, fx.A.id, "invoicing.invoice.overdue")).filter((row) => String(row.dedupe_key).includes(invoice.id)).length).toBe(1);` : ""}
    const afterFirst = (await all(sql\`select id from notifications where tenant_id = \${fx.aId}\`)).length;
    await runCron();
    expect((await all(sql\`select id from notifications where tenant_id = \${fx.aId}\`)).length).toBe(afterFirst);${mail ? `
    // The failed copy waits for a retry; once its wait is over, the cron sends it.
    const waiting = await all(sql\`select id from notifications where tenant_id = \${fx.aId} and email_status = 'pending'\`);
    expect(waiting.length).toBeGreaterThan(0);
    await makeRetriesDue(fx.aId);
    await runCron();
    expect(await all(sql\`select id from notifications where tenant_id = \${fx.aId} and email_status = 'pending' and id in (\${sql.join(waiting.map((row) => sql\`\${String(row.id)}\`), sql\`, \`)})\`)).toEqual([]);` : ""}
  });
` : ""}${customerTpl ? `
  it("8. an email didn't go: a customer's email that fails for good alerts whoever manages messages (never by email) — and a failing team alert alerts nobody", async () => {
    await upsertTemplate(db, { tenantId: fx.aId, key: "${customerTemplate}", channel: "email", subject: "Probe", body: "A probe for the alerts test." });
    mail.failNext = 1;
    const failed = await sendNow(db, { tenantId: fx.aId, to: "faye@customer.test", templateKey: "${customerTemplate}" }, commsSenders);${mail ? `
    expect(failed.status).toBe("failed");` : ""}
    const told = await alertsFor(fx.aId, fx.A.id, "comms.message.failed");${mail ? `
    expect(told.length).toBe(1);
    expect(String(told[0]?.title)).toContain("faye@customer.test");
    expect(told[0]?.email_status).toBe("none");

    // A team alert that fails is the alerts' own retry's job: no alert about it.
    // With a body, so it fails AT THE PROVIDER (the case this is about) and
    // uses up the failure it was given — an empty body was refused before the
    // provider, and the unused failure failed the next test's customer email.
    mail.failNext = 1;
    await sendNow(db, { tenantId: fx.aId, to: fx.A.email, templateKey: "team_alert", vars: { title: "Probe", body: "A probe team alert.", linkLine: "", settingsLine: "", businessName: "Alpha Lawn Care" } }, commsSenders);
    expect(mail.failNext).toBe(0);
    expect((await alertsFor(fx.aId, fx.A.id, "comms.message.failed")).length).toBe(1);` : ""}${!mail ? `
    // Without the email package nothing is sent at all — a skip, never a failure — so nothing is told.
    expect(failed.status).toBe("skipped");
    expect(told).toEqual([]);` : ""}
  });
` : ""}${demote ? `
  it("9. demoted (review G4): an admin on the estimates list loses those alerts — and the list — the moment their role is changed to ${demotedTo}", async () => {
    const dana = await memberOfA("ext_alerts_dana", "dana@alpha-office.test", "admin");
    await alerts.setRouting({ tenantId: fx.aId, routing: "estimates", mode: "chosen", userIds: [dana.id], extraEmails: [], by: fx.A.id });
    await leadForA("Demotion Lead");
    expect((await alertsFor(fx.aId, dana.id, "estimator.lead")).length).toBe(1);

    await tenancy.changeMemberRole({ actorUserId: fx.A.id, tenantId: fx.aId, targetUserId: dana.id, roleKey: "${demotedTo}" });
    await tenancy.settleEvents();
    const list = (await (await asReader(dana, "v1/admin/alerts?limit=50")).json()) as { alerts: { kind: string; read: boolean }[] };
    expect(list.alerts.filter((alert) => alert.kind.startsWith("estimator."))).toEqual([]);
    const count = (await (await asReader(dana, "v1/admin/count")).json()) as { unread: number };
    expect(count.unread).toBe(list.alerts.filter((alert) => !alert.read).length);
    const routing = await all(sql\`select user_ids from notification_routing where tenant_id = \${fx.aId} and routing = 'estimates'\`);
    expect(JSON.stringify(routing[0]?.user_ids ?? [])).not.toContain(dana.id);
  });
` : ""}${mailEst ? `
  it("10. a failed office email is sent again once, as a team alert, by the cron (review BO-02)", async () => {
    await alerts.setRouting({ tenantId: fx.aId, routing: "estimates", mode: "owner", userIds: [], extraEmails: [], by: fx.A.id });
    // Anything already waiting from the cases before goes first, so the count
    // below is this lead's alone.
    await makeRetriesDue(fx.aId);
    await runCron();
    const before = (await messages(fx.aId, "team_alert")).filter((m) => m.status === "sent").length;
    // The OFFICE email fails (the customer's own copy goes first, and goes).
    mail.failOnceTo = await ownersCopiesTo(fx.aId);
    await leadForA("Flaky Lead");
    const office = (await messages(fx.aId, "estimate_lead_staff")).at(-1);
    expect(office?.status).toBe("failed");
    await makeRetriesDue(fx.aId);
    await runCron();
    const sent = (await messages(fx.aId, "team_alert")).filter((m) => m.status === "sent");
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)?.to).toBe(await ownersCopiesTo(fx.aId));
    await makeRetriesDue(fx.aId);
    await runCron();
    expect((await messages(fx.aId, "team_alert")).filter((m) => m.status === "sent").length).toBe(before + 1);
  });
` : ""}${mailCustomer ? `
  it("11. team mail doesn't hold customer mail (review BO-10): 25 team emails in an hour, then a customer's still goes; the team's own allowance holds the 61st", async () => {
    const owner = await person("ext_alerts_d", "di@delta-owner.test", "Di Delta");
    const delta = await companyOf(owner, "Delta Cleaning");
    for (let i = 0; i < 25; i++) expect(await companySendAllowance({ tenantId: delta, templateKey: "team_alert" }), \`team email \${i + 1}\`).toBe(true);
    await upsertTemplate(db, { tenantId: delta, key: "${customerTemplate}", channel: "email", subject: "Probe", body: "A customer's email." });
    const customer = await sendNow(db, { tenantId: delta, to: "carl@customer.test", templateKey: "${customerTemplate}" }, commsSenders);
    expect(customer.status).toBe("sent");
    for (let i = 25; i < COMMS_SEND_ALLOWANCE.team.hour; i++) expect(await companySendAllowance({ tenantId: delta, templateKey: "team_alert" }), \`team email \${i + 1}\`).toBe(true);
    expect(await companySendAllowance({ tenantId: delta, templateKey: "team_alert" }), "the 61st team email in the hour").toBe(false);
    // A customer's allowance is its own.
    expect(await companySendAllowance({ tenantId: delta, templateKey: "${customerTemplate}" })).toBe(true);
  });
` : ""}${mail ? `
  it("12. removed while their email waited (review G3): the cron sends it to nobody, and the row ends skipped", async () => {
    const rae = await memberOfA("ext_alerts_rae", "rae@alpha-office.test", "admin");
    const firstTeamKind = ALERT_REGISTRY.kinds.find((kind) => kind.key === "tenancy.member.joined");
    if (!firstTeamKind) throw new Error("no team alert kind");
    await alerts.setChoice({ tenantId: fx.aId, userId: rae.id, kind: firstTeamKind.key, channel: "email" });
    mail.failOnceTo = rae.email;
    await alerts.notify({
      tenantId: fx.aId,
      kind: firstTeamKind.key,
      title: "Someone joined the team",
      body: null,
      href: "/settings/team",
      dedupeKey: "proof:removed-while-waiting",
      subject: null,
      actorUserId: null,
    });
    // Rae's copy failed and waits for the cron (the owner's choice is in-app).
    const [waiting] = await all(sql\`select id, email_status from notifications where tenant_id = \${fx.aId} and recipient_id = \${rae.id} and dedupe_key = 'proof:removed-while-waiting'\`);
    expect(waiting?.email_status).toBe("pending");
    // Removed WITHOUT the alerts' forget step (the membership row itself goes).
    await db.execute(sql\`delete from tenant_members where tenant_id = \${fx.aId} and user_id = \${rae.id}\`);
    await makeRetriesDue(fx.aId);
    const sentToRae = mail.outbox.filter((m) => m.to === rae.email).length;
    await runCron();
    expect(mail.outbox.filter((m) => m.to === rae.email).length).toBe(sentToRae);
    const [after] = await all(sql\`select email_status from notifications where id = \${String(waiting?.id)}\`);
    expect(after?.email_status).toBe("skipped");
  });
` : ""}${mailEst ? `
  it("13. switched off in Messages (review BO-11): the lead email off, Alert settings says where to turn it back on, and the next lead emails nobody", async () => {
    expect(await setTemplateActive(db, fx.aId, "estimate_lead_staff", false)).toBe(true);
    const prefs = (await (await asReader(fx.A, "v1/admin/preferences")).json()) as {
      choices: { kind: string; emailOffInMessages: boolean; emailNote: string | null }[];
      links: { messages: string | null };
    };
    const lead = prefs.choices.find((choice) => choice.kind === "estimator.lead");
    expect(lead?.emailOffInMessages).toBe(true);
    expect(prefs.links.messages).toBe("/app/messages");
    const routing = (await (await asReader(fx.A, "v1/admin/routing")).json()) as { groups: { key: string; emailNote: string | null }[] };
    expect(routing.groups.find((group) => group.key === "estimates")?.emailNote).toBeTruthy();
    const before = (await messages(fx.aId, "estimate_lead_staff")).length;
    const teamBefore = (await messages(fx.aId, "team_alert")).length;
    await leadForA("Quiet Lead");
    expect((await alertsFor(fx.aId, fx.A.id, "estimator.lead")).at(-1)?.email_status).toBe("none");
    expect((await messages(fx.aId, "estimate_lead_staff")).length).toBe(before);
    expect((await messages(fx.aId, "team_alert")).length).toBe(teamBefore);
    await setTemplateActive(db, fx.aId, "estimate_lead_staff", true);
  });
` : ""}
  it("the team's own alerts: a teammate joining is told to the owner, and to nobody in B", async () => {
    await memberOfA("ext_alerts_join", "joy@alpha-office.test", "member");
    const joined = await alertsFor(fx.aId, fx.A.id, "tenancy.member.joined");
    expect(joined.some((row) => String(row.title).includes("joined the team"))).toBe(true);
    expect(await alertsFor(fx.bId, fx.B.id, "tenancy.member.joined")).toEqual([]);
  });

  it("14. one person in two ${nouns} (review BUY-03): an alert of one is never in the other's count or list, and can't be marked read from there", async () => {
    // Pat owns Pine Gardens and is an admin of Quarry Paving: the same person,
    // the same kind of alert, in both.
    const pat = await person("ext_alerts_pat", "pat@pine-owner.test", "Pat Pine");
    const quinn = await person("ext_alerts_quinn", "quinn@quarry-owner.test", "Quinn Quarry");
    const pine = await companyOf(pat, "Pine Gardens");
    const quarry = await companyOf(quinn, "Quarry Paving");
    const invited = await tenancy.sendInvitation({ actorUserId: quinn.id, tenantId: quarry, email: pat.email, roleKey: "admin" });
    expect((await tenancy.acceptInvitation({ token: invited.token, userId: pat.id })).status).toBe("accepted");
    await tenancy.settleEvents();
    const asPatIn = (tenantId: string, path: string, method = "GET") =>
      buildAlertsHandlers({ principal: async () => ({ userId: pat.id }) }).handle(
        new Request(\`http://localhost/api/app/\${tenantId}/alerts/\${path}\`, {
          method,
          headers: { "sec-fetch-site": "same-origin", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
          ...(method === "POST" ? { body: "{}" } : {}),
        }),
      );
    const unread = async (tenantId: string) => ((await (await asPatIn(tenantId, "v1/admin/count")).json()) as { unread: number }).unread;
    const listed = async (tenantId: string) =>
      ((await (await asPatIn(tenantId, "v1/admin/alerts?limit=50")).json()) as { alerts: { id: string; title: string }[] }).alerts;
    const draft = (tenantId: string, label: string) => ({
      tenantId,
      kind: "tenancy.member.joined",
      title: \`\${label} joined the team\`,
      body: null,
      href: "/settings/team",
      dedupeKey: \`proof:two-${nouns.replace(/[^a-z]/g, "")}:\${label}\`,
      subject: null,
      actorUserId: null,
    });

    // The control: an alert of this kind for Pat IN QUARRY is in Quarry's count and list.
    const quarryBefore = await unread(quarry);
    await alerts.notify(draft(quarry, "Rae Quarry"));
    expect(await unread(quarry)).toBe(quarryBefore + 1);
    expect((await listed(quarry)).map((alert) => alert.title)).toContain("Rae Quarry joined the team");

    // An alert for Pat in PINE: in Pine's bell, and nowhere in Quarry's.
    await alerts.notify(draft(pine, "Sol Pine"));
    const [mine] = await all(sql\`select id from notifications where tenant_id = \${pine} and recipient_id = \${pat.id} and title = 'Sol Pine joined the team'\`);
    expect(mine, "Pat's alert in Pine Gardens").toBeDefined();
    const id = String(mine?.id);
    expect((await listed(pine)).map((alert) => alert.id)).toContain(id);
    expect(await unread(quarry)).toBe(quarryBefore + 1);
    const inQuarry = await listed(quarry);
    expect(inQuarry.map((alert) => alert.id)).not.toContain(id);
    expect(JSON.stringify(inQuarry)).not.toContain("Sol Pine");

    // Marked read through Quarry's routes: not found there, still unread in Pine.
    expect((await asPatIn(quarry, \`v1/admin/alerts/\${encodeURIComponent(id)}/read\`, "POST")).status).toBe(404);
    expect((await asPatIn(quarry, "v1/admin/read-all", "POST")).status).toBeLessThan(300);
    expect(await unread(quarry)).toBe(0);
    const [still] = await all(sql\`select read_at from notifications where id = \${id}\`);
    expect(still?.read_at ?? null).toBeNull();
    expect((await listed(pine)).find((alert) => alert.id === id)).toBeDefined();
  });
`;
  return `import { beforeAll, describe, expect, it, vi } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { users } from "${scope}/auth/schema";
${comms ? `import { sendNow, setTemplateActive, upsertTemplate } from "${scope}/comms";
` : ""}${est ? `import { buildEvents as buildEstimatorEvents, createEstimate } from "${scope}/estimator";
` : ""}${inv ? `import { createInvoice, setInvoiceStatus } from "${scope}/invoicing";
` : ""}${sched ? `import { bookVisit, createResource, getSchedulingSettings, rescheduleBooking, setAvailability, setBookingStatus } from "${scope}/scheduling";
` : ""}import { db } from "@/db";
import { seedPermissions } from "@/permissions/seed";
import { ALERT_REGISTRY, alerts } from "@/server/alerts";
import { buildAlertsHandlers } from "@/server/alerts-routes";
${mail ? `import { COMMS_SEND_ALLOWANCE, commsSenders, companySendAllowance } from "@/server/comms-senders";
` : ""}${commsNoMail ? `import { commsSenders } from "@/server/comms-senders";
` : ""}import { ensureCompanySetup } from "@/server/company-setup";
${est ? `import { onEstimatorEvent } from "@/server/estimator-notify";
` : ""}${sched ? `import { onSchedulingEvent } from "@/server/scheduling-notify";
` : ""}import { tenancy } from "@/server/tenancy";
import { GET as alertsCron } from "../../../app/api/cron/alerts/route";

/**
 * EACH ${NOUN}'S ALERTS ARE ITS OWN (Tenancy 2b-1, 14.2) — through this
 * project's own glue: the alerts instance, the listeners the features hand
 * their events to, the alerts cron${mail ? `, and the comms senders over a
 * capturing transport (so what is checked is exactly what the provider would
 * be handed)` : ""}.
 *
 * Two ${nouns}, A ("Alpha Lawn Care", owner Ada) and B ("Bravo Roofing",
 * owner Ben), and A's people as each case needs them. PGlite, so it runs on
 * every \`pnpm test\` with nothing configured.
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

// Hoisted with the mocks: read while the modules under test import.
const mail = vi.hoisted(() => ({
  outbox: [] as { to: string; from: string; subject: string; text: string }[],
  /** The next this many sends throw, as a provider that's down would (a retryable failure). */
  failNext: 0,
  /** The next send TO this address throws, once (the others go). */
  failOnceTo: null as string | null,
}));

/** The cron secret set, this site's sending identity, and no real email key. */
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === "CRON_SECRET") return "cron-test-secret";
        if (prop === "EMAIL_FROM") return "Igloo Platform <messages@igloo-platform.test>";
        if (prop === "RESEND_API_KEY") return undefined;
        return Reflect.get(target, prop);
      },
    }),
  };
});
${mail ? `
/**
 * Every email this project sends goes to the outbox instead of Resend: the
 * project's own comms senders are built over this transport (an injected
 * transport counts as configured, so emails really "leave").
 */
vi.mock("${scope}/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("${scope}/email")>();
  return {
    ...actual,
    createEmailSender: (options: Parameters<typeof actual.createEmailSender>[0]) =>
      actual.createEmailSender({
        ...options,
        send: async (message) => {
          if (mail.failNext > 0 || (mail.failOnceTo !== null && message.to === mail.failOnceTo)) {
            if (mail.failNext > 0) mail.failNext -= 1;
            else mail.failOnceTo = null;
            throw new Error("the email provider is down (on purpose)");
          }
          mail.outbox.push({ to: message.to, from: message.from, subject: message.subject, text: message.text ?? "" });
          return { id: \`captured_\${mail.outbox.length}\` };
        },
      }),
  };
});
` : ""}
interface Person {
  readonly id: string;
  readonly email: string;
}

const fx = {} as { A: Person; B: Person; aId: string; bId: string };

async function person(externalId: string, email: string, name: string): Promise<Person> {
  const [row] = await db.insert(users).values({ externalId, email, displayName: name }).returning();
  if (!row) throw new Error("could not create the test person");
  await tenancy.provisionUser({ userId: row.id, email });
  return { id: row.id, email };
}

async function companyOf(owner: Person, name: string): Promise<string> {
  const out = await tenancy.createCompany({ userId: owner.id, name, requestKey: \`alerts-\${owner.id}\`.slice(0, 64), purpose: "onboarding" });
  await ensureCompanySetup(out.company.id);
  return out.company.id;
}

/** Someone invited into A with a role, who accepted. */
async function memberOfA(externalId: string, email: string, roleKey: string): Promise<Person> {
  const someone = await person(externalId, email, email.split("@")[0] ?? "Someone");
  const invited = await tenancy.sendInvitation({ actorUserId: fx.A.id, tenantId: fx.aId, email, roleKey });
  expect((await tenancy.acceptInvitation({ token: invited.token, userId: someone.id })).status).toBe("accepted");
  await tenancy.settleEvents();
  return someone;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

async function all(query: SQL): Promise<Record<string, unknown>[]> {
  return rowsOf(await db.execute(query));
}

/** The alert rows written for one person in one ${noun} (what the bell reads, before any filter). */
async function alertsFor(tenantId: string, userId: string, kind?: string): Promise<Record<string, unknown>[]> {
  return all(
    kind
      ? sql\`select id, kind, title, href, email_status, reached_via, dedupe_key from notifications where tenant_id = \${tenantId} and recipient_id = \${userId} and kind = \${kind} order by created_at, id\`
      : sql\`select id, kind, title, href, email_status, reached_via, dedupe_key from notifications where tenant_id = \${tenantId} and recipient_id = \${userId} order by created_at, id\`,
  );
}
${comms ? `
/** The delivery log: what went out, to whom, under which template, in one ${noun}. */
async function messages(tenantId: string, templateKey: string): Promise<{ to: string; status: string; fromName: string | null }[]> {
  const rows = await all(
    sql\`select to_address, status, from_name from comms_messages where tenant_id = \${tenantId} and template_key = \${templateKey} order by created_at, id\`,
  );
  return rows.map((row) => ({ to: String(row.to_address), status: String(row.status), fromName: (row.from_name as string | null) ?? null }));
}

/** Where A's owner's copies of new work go right now: the business email, else the owner's own (review BO-01). */
async function ownersCopiesTo(tenantId: string): Promise<string> {
  const profile = await tenancy.companyProfile(tenantId);
  const to = profile?.inbox[0];
  if (!to) throw new Error("the ${noun} has nowhere for its owner's copies to go");
  return to;
}
` : ""}
/** The alerts cron, exactly as the scheduler calls it. */
async function runCron(): Promise<void> {
  const res = await alertsCron(new Request("http://localhost/api/cron/alerts", { headers: { "x-cron-secret": "cron-test-secret" } }));
  expect(res.status).toBe(200);
}

/** Every pending alert email of A due now, as if the wait between tries had passed. */
async function makeRetriesDue(tenantId: string): Promise<void> {
  await db.execute(sql\`update notifications set email_next_at = now() - interval '1 second' where tenant_id = \${tenantId} and email_status = 'pending'\`);
}

/** A person's alerts routes, as the bell calls them (\`count\`, \`list\`, \`preferences\`, \`routing\`). */
async function asReader(who: Person, path: string): Promise<Response> {
  const { handle } = buildAlertsHandlers({ principal: async () => ({ userId: who.id }) });
  return handle(new Request(\`http://localhost/api/app/\${fx.aId}/alerts/\${path}\`, { headers: { "sec-fetch-site": "same-origin" } }));
}
${sched ? `
/** Today's date where the ${noun}'s schedule is (a crew's route is today's, in its own zone). */
async function todayThere(tenantId: string): Promise<string> {
  const { timeZone } = await getSchedulingSettings(db, tenantId);
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** A crew of A working every day, all day, with \`userId\` linked (or nobody). */
async function crewOfA(name: string, userId: string | null): Promise<string> {
  const crew = await createResource(db, { tenantId: fx.aId, name, userId, workStartTime: "00:00", workEndTime: "23:00", maxJobsPerDay: 50 });
  await setAvailability(db, {
    tenantId: fx.aId,
    resourceId: crew.id,
    blocks: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startTime: "00:00", endTime: "23:00" })),
  });
  return crew.id;
}

const CUSTOMER = { type: "customer", id: null } as const;

/** A visit a customer asked for, on a crew, \`daysAhead\` from today in the ${noun}'s zone — told to the listeners. */
async function requestVisit(resourceId: string | null, daysAhead: number, start = "09:00", end = "10:00"): Promise<string> {
  const today = await todayThere(fx.aId);
  const date = new Date(\`\${today}T12:00:00Z\`);
  date.setUTCDate(date.getUTCDate() + daysAhead);
  const { visit } = await bookVisit(
    db,
    {
      tenantId: fx.aId,
      resourceId,
      scheduledDate: date.toISOString().slice(0, 10),
      startTime: start,
      endTime: end,
      customerName: "Pat Rivera",
      customerEmail: "pat@customer.test",
      address: "12 Elm St",
      status: "pending",
    },
    { skipValidation: true, actor: CUSTOMER, onEvent: onSchedulingEvent },
  );
  return visit.id;
}

/** The customer moves a visit (the same visit, a new time), told to the listeners. */
async function customerMoves(visitId: string, date: string, startTime: string): Promise<void> {
  const moved = await rescheduleBooking(db, fx.aId, { id: visitId, date, startTime }, { actor: CUSTOMER, onEvent: onSchedulingEvent });
  expect(moved, "the move").not.toBeNull();
}
` : ""}${est ? `
/** A lead a customer sent A, told to the listeners — and the event, to hand over again. */
async function leadForA(customerName = "Lena Lead") {
  const estimate = await createEstimate(db, {
    tenantId: fx.aId,
    customerName,
    customerEmail: "lena@customer.test",
    items: [{ description: "Front step ramp", quantity: 1, unitPrice: 48_000 }],
  });
  const [event] = await buildEstimatorEvents(db, fx.aId, [{ type: "lead.received", estimateId: estimate.id, actor: { type: "customer", id: null } }], {
    now: new Date(),
  });
  if (!event) throw new Error("no lead.received event was built");
  await onEstimatorEvent(event);
  return { estimateId: estimate.id, event };
}
` : ""}
beforeAll(async () => {
  await seedPermissions(db, { log: () => {} });
  fx.A = await person("ext_alerts_a", "ada@alpha-owner.test", "Ada Alpha");
  fx.B = await person("ext_alerts_b", "ben@bravo-owner.test", "Ben Bravo");
  fx.aId = await companyOf(fx.A, "Alpha Lawn Care");
  fx.bId = await companyOf(fx.B, "Bravo Roofing");
});

describe("each ${noun}'s alerts are its own (Tenancy 2b-1)", () => {
${cases}
});
`;
}

// ---------------------------------------------------------------------------
// src/server/__tests__/company-files.test.ts (companies, with storage)
// ---------------------------------------------------------------------------

/**
 * The files proof (Tenancy 2b-1, 14.3): through the project's own files
 * routes, its tenancy (the logo) and its estimator (the customer's photo),
 * over in-memory stores. Each case is written only where the features it needs
 * are installed.
 */
export function renderCompanyFilesTest(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  const NOUN = noun.toUpperCase();
  const nouns = tenantLabelPlural(answers).toLowerCase();
  const est = answers.includeEstimator;
  const sched = answers.includeScheduling;
  const inv = answers.includeInvoicing;
  const alerts = answers.includeNotifications;
  const records = sched || est || inv;
  // A record of the "full" ${noun} a member may add files to (case 3).
  const recordForFull = sched
    ? '{ type: "scheduling.visit", id: (await bookVisit(db, { tenantId: full, scheduledDate: "2031-06-03", startTime: "09:00", endTime: "10:00", status: "confirmed" }, { skipValidation: true })).visit.id }'
    : est
      ? '{ type: "estimator.estimate", id: (await createEstimate(db, { tenantId: full, customerName: "Full Customer", items: [{ description: "Probe", quantity: 1, unitPrice: 1_000 }] })).id }'
      : inv
        ? '{ type: "invoicing.invoice", id: (await createInvoice(db, { tenantId: full, customerName: "Full Customer", items: [{ description: "Probe", quantity: 1, unitPrice: 1_000 }] })).id }'
        : "null as never";
  const cases = `  it("1. A's owner adds a file; it opens for A (with nosniff and a CSP), is refused to B in A's ${noun}, and is not found in B's", async () => {
    const asA = filesAs(fx.A, fx.aId);
    const added = await asA.upload(PNG, "yard.png");
    expect(added.status).toBe(201);
    const id = await idOf(added);
    const content = await asA.get(\`v1/admin/files/\${encodeURIComponent(id)}/content\`);
    expect(content.status).toBe(200);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(PNG);
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    expect(content.headers.get("content-security-policy")).toBeTruthy();
    // B with A's ${noun} in the path: not a member.
    expect((await filesAs(fx.B, fx.aId).get(\`v1/admin/files/\${encodeURIComponent(id)}/content\`)).status).toBe(403);
    // B in B's own ${noun}, with A's file id: nothing there.
    expect((await filesAs(fx.B, fx.bId).get(\`v1/admin/files/\${encodeURIComponent(id)}/content\`)).status).toBe(404);
  });

  it("2. the bytes decide the type: a PNG named .pdf is kept as a PNG, and an SVG is refused", async () => {
    const asA = filesAs(fx.A, fx.aId);
    const renamed = await asA.upload(PNG, "report.pdf", "application/pdf");
    expect(renamed.status).toBe(201);
    const body = (await renamed.json()) as { file: { contentType: string; name: string } };
    expect(body.file.contentType).toBe("image/png");
    expect(body.file.name).toBe("report.png");
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await asA.upload(svg, "logo.svg", "image/svg+xml")).status).toBe(415);
  });

  it("3. the allowance: a full ${noun}'s upload is refused in the owner's words${records ? ` (and a member's in theirs)` : ""}; the logo still goes${est ? `, and so does a customer's estimate photo` : ""}${alerts ? `; one \\"storage is full\\" alert a day` : ""}", async () => {
    const owner = await person("ext_files_full", "fay@full-owner.test", "Fay Full");
    const full = await companyOf(owner, "Full Lawn Care");
    world.allowanceMb = 1;
    try {
      const asOwner = filesAs(owner, full);
      expect((await asOwner.upload(pngOf(600), "first.png")).status).toBe(201);
      const refused = await asOwner.upload(pngOf(500), "second.png");
      expect(refused.status).toBe(409);
      const said = (await refused.json()) as { error: { code: string; message: string } };
      expect(said.error.code).toBe("storage_full");
      expect(said.error.message).toContain("Delete files you no longer need");${records ? `

      // A member who can add files to a record, told to ask the owner.
      const member = await memberOf(full, owner, "ext_files_full_m", "max@full-office.test", "member");
      const record = ${recordForFull};
      const theirs = await filesAs(member, full).attach(record, pngOf(500), "job.png");
      expect(theirs.status).toBe(409);
      expect(((await theirs.json()) as { error: { message: string } }).error.message).toBe(
        "Full Lawn Care's storage is full, so this wasn't added. Ask the owner to make room.",
      );` : ""}

      // The logo is exempt: a full ${noun} can still fix its logo.
      const logo = await tenancy.setLogo({ actorUserId: owner.id, tenantId: full, file: { bytes: PNG, contentType: "image/png", filename: "logo.png" } });
      expect(logo.logoUrl).toBeTruthy();${est ? `

      // A customer's estimate photo is a lead: counted, never refused for a full ${noun} (review BO-06).
      const { estimatorPhotoStore } = await import("@/server/files");
      if (!estimatorPhotoStore) throw new Error("no estimator photo store");
      const photo = await estimatorPhotoStore.put({ tenantId: full, bytes: PNG, contentType: "image/png", filename: "step.png" });
      expect(photo.fileId).toBeTruthy();` : ""}${alerts ? `

      // The owner hears once a day that a file was refused (review BO-07).
      const told = async () =>
        (await all(sql\`select id from notifications where tenant_id = \${full} and recipient_id = \${owner.id} and kind = 'storage.files.full'\`)).length;
      expect(await told()).toBe(1);
      expect((await asOwner.upload(pngOf(500), "third.png")).status).toBe(409);
      expect(await told()).toBe(1);` : ""}
    } finally {
      world.allowanceMb = undefined;
    }
  });
${est ? `
  it("3b. the share (review G6): customers' photos stop at a fifth of the room, with the estimator's own sentence (never a 500), while staff files still go", async () => {
    const owner = await person("ext_files_share", "sam@share-owner.test", "Sam Share");
    const shared = await companyOf(owner, "Share Ramps");
    await updateEstimatorSettings(db, shared, { businessName: "Share Ramps", taxRateBp: 0 });
    const company = await tenancy.companyFor(shared);
    if (!company) throw new Error("no company");
    const probe = ESTIMATOR_PUBLIC_ROUTES.find((route) => route.kind === "photo")?.body as { imageBase64: string; mediaType: string };
    const jpeg = Uint8Array.from(atob(probe.imageBase64), (c) => c.charCodeAt(0));
    const photoOf = (kb: number) => {
      const bytes = new Uint8Array(jpeg.length + kb * 1024);
      bytes.set(jpeg);
      bytes.set(new TextEncoder().encode(\`pad-\${Math.random()}\`), jpeg.length);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    };
    const { handle } = buildEstimatorPublicHandlers();
    const send = (kb: number) =>
      handle(
        new Request(\`http://localhost/api/t/\${company.slug}/estimator/v1/photo\`, {
          method: "POST",
          headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
          body: JSON.stringify({ imageBase64: photoOf(kb), mediaType: "image/jpeg" }),
        }),
      );
    world.allowanceMb = 1;
    try {
      expect((await send(150)).status).toBe(201);
      const second = await send(150);
      expect(second.status).toBeGreaterThanOrEqual(400);
      expect(second.status).toBeLessThan(500);
      const said = (await second.json()) as { error: { code: string; message: string } };
      expect(said.error.code).toBe("photo_limit");
      expect(said.error.message).toBe(PHOTO_CAP_MESSAGE);
      // The crew's room is still there.
      expect((await filesAs(owner, shared).upload(pngOf(50), "plan.png")).status).toBe(201);
    } finally {
      world.allowanceMb = undefined;
    }
  });
` : ""}
  it("3c. uploads per person (review BO-09): two people's 70 each in an hour both go; one person's 121st is too many", async () => {
    const owner = await person("ext_files_busy", "bo@busy-owner.test", "Bo Busy");
    const busy = await companyOf(owner, "Busy Crews");
    const admin = await memberOf(busy, owner, "ext_files_busy_admin", "al@busy-office.test", "admin");
    for (const who of [owner, admin]) {
      const as = filesAs(who, busy);
      for (let i = 0; i < 70; i++) expect((await as.upload(PNG, \`p\${i}.png\`)).status, \`upload \${i + 1}\`).toBe(201);
    }
    const asOwner = filesAs(owner, busy);
    for (let i = 70; i < 120; i++) expect((await asOwner.upload(PNG, \`q\${i}.png\`)).status, \`upload \${i + 1}\`).toBe(201);
    expect((await asOwner.upload(PNG, "one-too-many.png")).status).toBe(429);
  });

  it("4. deleting removes the stored copy — and when the store fails, the files cron removes it later", async () => {
    const asA = filesAs(fx.A, fx.aId);
    const first = await idOf(await asA.upload(PNG, "old.png"));
    const firstKey = await keyOf(first);
    expect(world.privateStore.objects.has(firstKey)).toBe(true);
    expect((await asA.post(\`v1/admin/files/\${encodeURIComponent(first)}/remove\`)).status).toBe(200);
    expect(world.privateStore.objects.has(firstKey)).toBe(false);
    expect(await all(sql\`select id from stored_files where id = \${first}\`)).toEqual([]);

    const second = await idOf(await asA.upload(PNG, "stuck.png"));
    const secondKey = await keyOf(second);
    world.privateStore.failNext("delete");
    await asA.post(\`v1/admin/files/\${encodeURIComponent(second)}/remove\`);
    // Gone from every list and from the usage at once; the bytes wait for the cron.
    const listed = (await (await asA.get("v1/admin/files")).json()) as { files: { id: string }[] };
    expect(listed.files.map((file) => file.id)).not.toContain(second);
    expect(world.privateStore.objects.has(secondKey)).toBe(true);
    await runFilesCron();
    expect(world.privateStore.objects.has(secondKey)).toBe(false);
    expect(await all(sql\`select id from stored_files where id = \${second}\`)).toEqual([]);
  });
${sched ? `
  it("5. a crew member adds photos to their own crew's visit, and is told \\"not found\\" for another crew's — and lists only their own", async () => {
    const crewMember = await memberOf(fx.aId, fx.A, "ext_files_crew", "cam@alpha-crew.test", "crew");
    const north = await createResource(db, { tenantId: fx.aId, name: "North", userId: crewMember.id });
    const south = await createResource(db, { tenantId: fx.aId, name: "South" });
    const visit = async (resourceId: string) =>
      (
        await bookVisit(
          db,
          { tenantId: fx.aId, resourceId, scheduledDate: "2031-06-03", startTime: "09:00", endTime: "10:00", customerName: "Pat Rivera", status: "confirmed" },
          { skipValidation: true },
        )
      ).visit.id;
    const mine = { type: "scheduling.visit", id: await visit(north.id) };
    const other = { type: "scheduling.visit", id: await visit(south.id) };
    const asCrew = filesAs(crewMember, fx.aId);
    expect((await asCrew.attach(mine, PNG, "done.png")).status).toBe(201);
    expect((await asCrew.attach(other, PNG, "not-mine.png")).status).toBe(404);
    const listed = (await (await asCrew.get(\`v1/admin/attachments?record=scheduling.visit&id=\${encodeURIComponent(mine.id)}\`)).json()) as {
      files: { name: string }[];
    };
    expect(listed.files.map((file) => file.name)).toEqual(["done.png"]);
    expect((await asCrew.get(\`v1/admin/attachments?record=scheduling.visit&id=\${encodeURIComponent(other.id)}\`)).status).toBe(404);
  });
` : ""}${est ? `
  it("6. a customer's estimate photo is kept privately with its estimate, opens through the ${noun}'s route, and is listed with its estimate once the lead is sent (review BO-13)", async () => {
    await updateEstimatorSettings(db, fx.aId, { businessName: "Alpha Lawn Care", taxRateBp: 0 });
    const product = await createProduct(db, { tenantId: fx.aId, name: "Ramp", measurementMode: "unit", basePrice: 50_000 });
    const probe = ESTIMATOR_PUBLIC_ROUTES.find((route) => route.kind === "photo")?.body as { imageBase64: string; mediaType: string };
    const { handle } = buildEstimatorPublicHandlers();
    const post = (path: string, body: unknown) =>
      handle(
        new Request(\`http://localhost/api/t/\${fx.aSlug}/estimator/\${path}\`, {
          method: "POST",
          headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const publicBefore = world.publicStore.objects.size;
    const privateBefore = world.privateStore.objects.size;
    const kept = await post("v1/photo", probe);
    expect(kept.status).toBe(201);
    const { photoId } = (await kept.json()) as { photoId: string };
    expect(world.publicStore.objects.size).toBe(publicBefore);
    expect(world.privateStore.objects.size).toBe(privateBefore + 1);

    // Before the lead is sent, the Files screen doesn't list it.
    const asA = filesAs(fx.A, fx.aId);
    const before = (await (await asA.get("v1/admin/files")).json()) as { files: { purpose: string }[] };
    expect(before.files.filter((file) => file.purpose === "estimator.photo")).toEqual([]);

    const sent = await post("v1/submit", {
      name: "Pat Rivera",
      email: "pat@customer.test",
      items: [{ productId: product.id, quantity: 1 }],
      photoIds: [photoId],
      fillMs: 5000,
    });
    expect(sent.status).toBeLessThan(300);
    const [row] = await all(sql\`select p.file_id, p.url, e.estimate_number from estimator_photos p join estimator_estimates e on e.id = p.estimate_id where p.id = \${photoId}\`);
    expect(String(row?.url)).toBe(\`/api/app/\${fx.aId}/files/v1/admin/files/\${encodeURIComponent(String(row?.file_id))}/content\`);
    const after = (await (await asA.get("v1/admin/files")).json()) as { files: { purpose: string; record: { label: string } | null }[] };
    const listed = after.files.find((file) => file.purpose === "estimator.photo");
    expect(listed?.record?.label).toBe(\`Estimate \${String(row?.estimate_number)} · Pat Rivera\`);
  });
` : ""}
  it("7. the logo: uploaded, it is public under an unguessable address; replaced, the old one is deleted — a 2a logo's stored copy too (review G11)", async () => {
    // A 2a logo, kept where 2a kept it and named as 2a named it ({uuid}.{ext}), as the company's current one.
    const legacy = \`tenancy/logos/\${fx.aId}/\${crypto.randomUUID()}.png\`;
    world.publicStore.plant(legacy, PNG, "image/png");
    await db.execute(sql\`update tenants set branding = branding || \${JSON.stringify({ logoUrl: "https://blob.example/old-2a-logo.png", logoKey: legacy })}::jsonb where id = \${fx.aId}\`);

    const first = await tenancy.setLogo({ actorUserId: fx.A.id, tenantId: fx.aId, file: { bytes: PNG, contentType: "image/png", filename: "logo.png" } });
    const keys = [...world.publicStore.objects.keys()].filter((key) => key.startsWith("p/"));
    expect(keys.length).toBeGreaterThan(0);
    expect(first.logoUrl ?? "").toContain("/v1/p/");
    expect(world.publicStore.objects.has(legacy)).toBe(false);

    const firstKey = keys.find((key) => (first.logoUrl ?? "").endsWith(key.slice(2)));
    expect(firstKey).toBeDefined();
    await tenancy.setLogo({ actorUserId: fx.A.id, tenantId: fx.aId, file: { bytes: PNG, contentType: "image/png", filename: "logo2.png" } });
    expect(world.publicStore.objects.has(firstKey ?? "")).toBe(false);
  });
${inv ? `
  it("8. the record decides (review G5): files.view alone opens no invoice's files; files.manage removes one whose invoice is gone, and the usage drops", async () => {
    const invoice = await createInvoice(db, { tenantId: fx.aId, customerName: "Ivy Invoice", items: [{ description: "Mowing", quantity: 1, unitPrice: 4_000 }] });
    const asA = filesAs(fx.A, fx.aId);
    const id = await idOf(await asA.attach({ type: "invoicing.invoice", id: invoice.id }, PNG, "receipt.png"));

    // A member whose invoices.view AND invoices.manage are taken away (two
    // overrides; either opens an invoice's files), keeping files.view.
    for (const permission of ["invoices.view", "invoices.manage"]) {
      await db.execute(sql\`insert into principal_override (principal_id, scope, tenant_id, permission, effect, reason) values (\${fx.A2.id}, 'tenant', \${fx.aId}, \${permission}, 'deny', 'files test')\`);
    }
    const asMember = filesAs(fx.A2, fx.aId);
    expect((await asMember.get(\`v1/admin/files/\${encodeURIComponent(id)}/content\`)).status).toBe(404);
    const theirList = (await (await asMember.get("v1/admin/files")).json()) as { files: { id: string }[] };
    expect(theirList.files.map((file) => file.id)).not.toContain(id);

    // The invoice is deleted: the owner sees "Attached to something that was removed" and removes it.
    await db.execute(sql\`delete from invoices where id = \${invoice.id}\`);
    const usage = async () => ((await (await asA.get("v1/admin/usage")).json()) as { usedBytes: number }).usedBytes;
    const before = await usage();
    const listed = (await (await asA.get("v1/admin/files")).json()) as { files: { id: string; record: { label: string } | null }[] };
    expect(listed.files.find((file) => file.id === id)?.record?.label).toBe("Attached to something that was removed");
    expect((await asA.post(\`v1/admin/files/\${encodeURIComponent(id)}/remove\`)).status).toBe(200);
    expect(await usage()).toBe(before - PNG.length);
  });
` : ""}
  it("9. one person in two ${nouns} (review BUY-03): a file of one is never in the other's list, and doesn't open from there", async () => {
    const pat = await person("ext_files_pat", "pat@pine-owner.test", "Pat Pine");
    const quinn = await person("ext_files_quinn", "quinn@quarry-owner.test", "Quinn Quarry");
    const pine = await companyOf(pat, "Pine Gardens");
    const quarry = await companyOf(quinn, "Quarry Paving");
    const patInQuarry = await (async () => {
      const invited = await tenancy.sendInvitation({ actorUserId: quinn.id, tenantId: quarry, email: pat.email, roleKey: "admin" });
      expect((await tenancy.acceptInvitation({ token: invited.token, userId: pat.id })).status).toBe("accepted");
      await tenancy.settleEvents();
      return filesAs(pat, quarry);
    })();
    // The control: a file Pat adds in Quarry is in Quarry's list.
    const theirs = await idOf(await patInQuarry.upload(PNG, "quarry-plan.png"));
    const names = async (as: ReturnType<typeof filesAs>) => ((await (await as.get("v1/admin/files")).json()) as { files: { id: string; name: string }[] }).files;
    expect((await names(patInQuarry)).map((file) => file.id)).toContain(theirs);

    // A file Pat adds in Pine: in Pine's list, nowhere in Quarry's, and not found there.
    const asPatInPine = filesAs(pat, pine);
    const mine = await idOf(await asPatInPine.upload(PNG, "pine-yard.png"));
    expect((await names(asPatInPine)).map((file) => file.id)).toContain(mine);
    const inQuarry = await names(patInQuarry);
    expect(inQuarry.map((file) => file.id)).not.toContain(mine);
    expect(inQuarry.map((file) => file.name)).not.toContain("pine-yard.png");
    expect((await patInQuarry.get(\`v1/admin/files/\${encodeURIComponent(mine)}\`)).status).toBe(404);
    expect((await patInQuarry.get(\`v1/admin/files/\${encodeURIComponent(mine)}/content\`)).status).toBe(404);
    expect((await patInQuarry.post(\`v1/admin/files/\${encodeURIComponent(mine)}/remove\`)).status).toBe(404);
    expect((await asPatInPine.get(\`v1/admin/files/\${encodeURIComponent(mine)}/content\`)).status).toBe(200);
  });
${inv || est ? `
  it("10. a copied link ends with its maker's access to the file (review SEC-03): ${sched ? "demoted to Crew" : "their access taken away"}, their link to ${inv ? "an invoice's" : "an estimate's"} file stops at once", async () => {
    const record = ${inv ? `{ type: "invoicing.invoice", id: (await createInvoice(db, { tenantId: fx.aId, customerName: "Lia Link", items: [{ description: "Edging", quantity: 1, unitPrice: 2_000 }] })).id }` : `{ type: "estimator.estimate", id: (await createEstimate(db, { tenantId: fx.aId, customerName: "Lia Link", items: [{ description: "Ramp", quantity: 1, unitPrice: 2_000 }] })).id }`};
    const fileId = await idOf(await filesAs(fx.A, fx.aId).attach(record, PNG, "terms.png"));
    const mo = await memberOf(fx.aId, fx.A, "ext_files_mo", "mo@alpha-office.test", "member");
    const url = await linkOf(mo, fx.aId, fileId);
    expect((await openLink(url)).status).toBe(200);

${
      sched
        ? `    await tenancy.changeMemberRole({ actorUserId: fx.A.id, tenantId: fx.aId, targetUserId: mo.id, roleKey: "crew" });
    await tenancy.settleEvents();`
        : `    // No Crew role here (no scheduling): their access to ${inv ? "invoices" : "estimates"} is taken away instead.
    for (const permission of ${JSON.stringify(inv ? ["invoices.view", "invoices.manage"] : ["estimator.view", "estimator.estimates.manage"])}) {
      await db.execute(sql\`insert into principal_override (principal_id, scope, tenant_id, permission, effect, reason) values (\${mo.id}, 'tenant', \${fx.aId}, \${permission}, 'deny', 'link test')\`);
    }`
    }
    // The screens already refuse them…
    expect((await filesAs(mo, fx.aId).get(\`v1/admin/files/\${encodeURIComponent(fileId)}/content\`)).status).toBe(404);
    // …and so does the link they copied.
    expect((await openLink(url)).status).toBe(404);
    // The owner's own link to the same file still opens: the file is fine, the maker isn't.
    expect((await openLink(await linkOf(fx.A, fx.aId, fileId))).status).toBe(200);
  });
` : ""}${sched ? `
  it("10b. a crew member's link to a visit's photo stops once the visit moves to another crew (review SEC-03)", async () => {
    const cam = await memberOf(fx.aId, fx.A, "ext_files_cam_link", "cam@alpha-link.test", "crew");
    const north = await createResource(db, { tenantId: fx.aId, name: "North Link", userId: cam.id });
    const south = await createResource(db, { tenantId: fx.aId, name: "South Link" });
    const visitId = (
      await bookVisit(
        db,
        { tenantId: fx.aId, resourceId: north.id, scheduledDate: "2031-06-04", startTime: "09:00", endTime: "10:00", customerName: "Pat Rivera", status: "confirmed" },
        { skipValidation: true },
      )
    ).visit.id;
    const fileId = await idOf(await filesAs(cam, fx.aId).attach({ type: "scheduling.visit", id: visitId }, PNG, "front-door.png"));
    const url = await linkOf(cam, fx.aId, fileId);
    expect((await openLink(url)).status).toBe(200);
    await db.execute(sql\`update scheduling_bookings set resource_id = \${south.id} where id = \${visitId}\`);
    expect((await filesAs(cam, fx.aId).get(\`v1/admin/files/\${encodeURIComponent(fileId)}/content\`)).status).toBe(404);
    expect((await openLink(url)).status).toBe(404);
  });
` : ""}
`;
  return `import { beforeAll, describe, expect, it, vi } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { users } from "${scope}/auth/schema";
${est ? `import { createEstimate, createProduct, ESTIMATOR_PUBLIC_ROUTES, PHOTO_CAP_MESSAGE, updateEstimatorSettings } from "${scope}/estimator";
` : ""}${inv ? `import { createInvoice } from "${scope}/invoicing";
` : ""}${sched ? `import { bookVisit, createResource } from "${scope}/scheduling";
` : ""}import type { MemoryBlobStore } from "${scope}/storage/testing";
import { db } from "@/db";
import { seedPermissions } from "@/permissions/seed";
import { ensureCompanySetup } from "@/server/company-setup";
${est ? `import { buildEstimatorPublicHandlers } from "@/server/estimator";
` : ""}import { buildFileLinkHandlers, buildFilesHandlers } from "@/server/files-routes";
import { tenancy } from "@/server/tenancy";
import { GET as filesCron } from "../../../app/api/cron/files/route";

/**
 * EACH ${NOUN}'S FILES ARE ITS OWN, AND PRIVATE (Tenancy 2b-1, 14.3) — through
 * this project's own files routes, its tenancy (the logo) and its estimator
 * (the customer's photo), over in-memory stores: the files instance this
 * project builds (src/server/files.ts), with the stores swapped for memory
 * ones before anything loads. PGlite, so it runs on every \`pnpm test\` with
 * nothing configured.
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

// Hoisted with the mocks: the stores the files instance is built over, and
// what the env reads (the allowance is changed per case).
const world = vi.hoisted(() => ({
  privateStore: null as unknown as MemoryBlobStore,
  publicStore: null as unknown as MemoryBlobStore,
  allowanceMb: undefined as number | undefined,
}));

vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === "CRON_SECRET") return "cron-test-secret";
        if (prop === "FILES_ALLOWANCE_MB") return world.allowanceMb;
        return Reflect.get(target, prop);
      },
    }),
  };
});

// The room here is FILES_ALLOWANCE_MB, set per case above. In a project that
// sells plans, a company's plan would decide it instead; that is proved in
// company-plans.test.ts, so here the plan always defers to the setting.
vi.mock("@/server/plan-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/plan-gate")>()),
  storageAllowanceBytes: async (_tenantId: string, fallback: number | null) => fallback,
}));

/**
 * THE PROJECT'S FILES, over memory stores: the same purposes, records, rules
 * and member check (createFilesStorage), so the routes, the logo and the
 * estimator's photos all run exactly as deployed.
 */
vi.mock("@/server/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/files")>();
  const { createMemoryBlobStore } = await import("${scope}/storage/testing");
  world.privateStore = createMemoryBlobStore({ access: "private" });
  world.publicStore = createMemoryBlobStore({ access: "public" });
  const files = actual.createFilesStorage({ private: world.privateStore, public: world.publicStore }, { signingSecret: "files-test-signing-secret-thirty-two" });
  return {
    ...actual,
    files,
    filesLogoStore: files.logoStore(),
    estimatorPhotoStore: files.purposeStore("estimator.photo"),
    estimatorStaffPhotoStore: files.purposeStore("estimator.staff-photo"),
  };
});

const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

/** A PNG of about \`kb\` kilobytes (the 1×1 picture, then bytes no reader looks at), different every time. */
function pngOf(kb: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(PNG.length + kb * 1024);
  out.set(PNG);
  out.set(new TextEncoder().encode(\`pad-\${Math.random()}\`), PNG.length);
  return out;
}

interface Person {
  readonly id: string;
  readonly email: string;
}

const fx = {} as { A: Person; A2: Person; B: Person; aId: string; bId: string; aSlug: string };

async function person(externalId: string, email: string, name: string): Promise<Person> {
  const [row] = await db.insert(users).values({ externalId, email, displayName: name }).returning();
  if (!row) throw new Error("could not create the test person");
  await tenancy.provisionUser({ userId: row.id, email });
  return { id: row.id, email };
}

async function companyOf(owner: Person, name: string): Promise<string> {
  const out = await tenancy.createCompany({ userId: owner.id, name, requestKey: \`files-\${owner.id}\`.slice(0, 64), purpose: "onboarding" });
  await ensureCompanySetup(out.company.id);
  return out.company.id;
}

async function memberOf(tenantId: string, owner: Person, externalId: string, email: string, roleKey: string): Promise<Person> {
  const someone = await person(externalId, email, email.split("@")[0] ?? "Someone");
  const invited = await tenancy.sendInvitation({ actorUserId: owner.id, tenantId, email, roleKey });
  expect((await tenancy.acceptInvitation({ token: invited.token, userId: someone.id })).status).toBe("accepted");
  await tenancy.settleEvents();
  return someone;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

async function all(query: SQL): Promise<Record<string, unknown>[]> {
  return rowsOf(await db.execute(query));
}

/** A person's files routes in a ${noun} (the id in the path decides). */
function filesAs(who: Person, tenantId: string) {
  const { handle } = buildFilesHandlers({ principal: async () => ({ userId: who.id }) });
  const base = \`http://localhost/api/app/\${tenantId}/files/\`;
  const headers = { "sec-fetch-site": "same-origin" };
  const upload = (path: string, bytes: Uint8Array<ArrayBuffer>, name: string, type: string) => {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type }), name);
    return handle(new Request(base + path, { method: "POST", headers, body: form }));
  };
  return {
    get: (path: string) => handle(new Request(base + path, { headers })),
    post: (path: string, body: unknown = {}) =>
      handle(new Request(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) })),
    upload: (bytes: Uint8Array<ArrayBuffer>, name = "photo.png", type = "image/png") => upload("v1/admin/files", bytes, name, type),
    attach: (record: { type: string; id: string }, bytes: Uint8Array<ArrayBuffer>, name = "photo.png", type = "image/png") =>
      upload(\`v1/admin/attachments?record=\${encodeURIComponent(record.type)}&id=\${encodeURIComponent(record.id)}\`, bytes, name, type),
  };
}

async function idOf(res: Response): Promise<string> {
  const body = (await res.json()) as { file?: { id?: string } };
  if (!body.file?.id) throw new Error(\`no file in the answer: \${JSON.stringify(body).slice(0, 200)}\`);
  return body.file.id;
}

async function keyOf(fileId: string): Promise<string> {
  const [row] = await all(sql\`select pathname from stored_files where id = \${fileId}\`);
  return String(row?.pathname ?? "");
}

async function runFilesCron(): Promise<void> {
  const res = await filesCron(new Request("http://localhost/api/cron/files", { headers: { "x-cron-secret": "cron-test-secret" } }));
  expect(res.status).toBe(200);
}

/** A copied link, opened as anyone would: no sign-in, through the site's own /api/files route. */
async function openLink(url: string): Promise<Response> {
  const { handle } = buildFileLinkHandlers();
  return handle(new Request(\`http://localhost\${new URL(url).pathname}\`));
}

/** A link to one file, made by \`who\` through the ${noun}'s route. */
async function linkOf(who: Person, tenantId: string, fileId: string): Promise<string> {
  const made = await filesAs(who, tenantId).post(\`v1/admin/files/\${encodeURIComponent(fileId)}/link\`);
  expect(made.status).toBe(200);
  return ((await made.json()) as { url: string }).url;
}

beforeAll(async () => {
  await seedPermissions(db, { log: () => {} });
  fx.A = await person("ext_files_a", "ada@alpha-owner.test", "Ada Alpha");
  fx.B = await person("ext_files_b", "ben@bravo-owner.test", "Ben Bravo");
  fx.aId = await companyOf(fx.A, "Alpha Lawn Care");
  fx.bId = await companyOf(fx.B, "Bravo Roofing");
  fx.A2 = await memberOf(fx.aId, fx.A, "ext_files_a2", "arlo@alpha-office.test", "member");
  const company = await tenancy.companyFor(fx.aId);
  if (!company) throw new Error("company A is missing");
  fx.aSlug = company.slug;
});

describe("each ${noun}'s files are its own, and private (Tenancy 2b-1)", () => {
${cases}
});
`;
}

// ---------------------------------------------------------------------------
// src/server/__tests__/files-staff.test.ts (single business, with storage)
// ---------------------------------------------------------------------------

/**
 * The single-business half of review SEC-03, proved in the project: a staff
 * member's copied link stops once they lose what lets them see the file, a
 * removed staff member's stops, and (with scheduling) a crew member's stops
 * once the visit moves to another crew. company-files.test.ts proves the
 * same for companies; a single business has no companies, so its files run
 * on the staff ladder and the member check in src/server/files.ts is a
 * different function — without this file, deleting its `mayView` left every
 * test of the project passing.
 *
 * Which file the first case uses is a question about the other answers: an
 * invoice's (a customer service agent doesn't see invoices, so the move to
 * that role takes it away), else an estimate's or a visit's (both are the
 * agent's too, so a per-person override takes the record's own keys away),
 * else a file on no record (the agent doesn't see the business's files).
 */
export function renderStaffFilesTest(answers: Answers): string {
  const scope = answers.scope;
  const est = answers.includeEstimator;
  const sched = answers.includeScheduling;
  const inv = answers.includeInvoicing;
  type Subject = {
    /** What the file is on, in the first case's name. */
    readonly what: string;
    /** The emitted expression for its record, or null: a file on no record. */
    readonly record: string | null;
    /** How the maker loses it: moved to a role that lacks it, or overrides on the record's own permissions. */
    readonly lose:
      | { readonly role: string; readonly lacks: string; readonly said: string }
      | { readonly permissions: readonly string[]; readonly said: string };
  };
  const subject: Subject = inv
    ? {
        what: "an invoice's file",
        record: `{ type: "invoicing.invoice", id: (await createInvoice(db, { tenantId: FILES_TENANT, customerName: "Lia Link", items: [{ description: "Edging", quantity: 1, unitPrice: 2_000 }] })).id }`,
        lose: { role: "cs_agent", lacks: "invoices", said: "moved to a role that doesn't see invoices" },
      }
    : est
      ? {
          what: "an estimate's file",
          record: `{ type: "estimator.estimate", id: (await createEstimate(db, { tenantId: FILES_TENANT, customerName: "Lia Link", items: [{ description: "Ramp", quantity: 1, unitPrice: 2_000 }] })).id }`,
          lose: { permissions: ["estimator.view", "estimator.estimates.manage"], said: "whose access to estimates is taken away" },
        }
      : sched
        ? {
            what: "a visit's file",
            record: `{ type: "scheduling.visit", id: (await bookVisit(db, { tenantId: FILES_TENANT, scheduledDate: "2031-06-03", startTime: "09:00", endTime: "10:00", customerName: "Lia Link", status: "confirmed" }, { skipValidation: true })).visit.id }`,
            lose: { permissions: ["schedule.view", "schedule.manage"], said: "whose access to the schedule is taken away" },
          }
        : {
            what: "one of the business's files",
            record: null,
            lose: { role: "cs_agent", lacks: "the business's files", said: "moved to a role that doesn't see the business's files" },
          };
  const overrides = "permissions" in subject.lose;
  const loseStep =
    "role" in subject.lose
      ? `    // Customer service agent: still staff, but doesn't see ${subject.lose.lacks}.
    await staffRole(lee, ${JSON.stringify(subject.lose.role)});`
      : `    // Still a customer service lead (still staff); a per-person override
    // takes away the record's own permissions, as the files routes map them.
    const keys = filesStaffKeyFor();
    for (const permission of ${JSON.stringify(subject.lose.permissions)}) {
      const key = keys[permission];
      if (!key) throw new Error(\`no staff key for \${permission}\`);
      await db.insert(principalOverride).values({ principalId: lee.id, scope: "staff", permission: key, effect: "deny", reason: "files link test" });
    }`;
  const fileHelper = subject.record
    ? `/** ${subject.what.charAt(0).toUpperCase()}${subject.what.slice(1)}, added by the owner (who holds every key). */
async function aFile(name: string): Promise<string> {
  const record = ${subject.record};
  const added = await filesAs(fx.owner).attach(record, name);
  expect(added.status).toBe(201);
  return idOf(added);
}`
    : `/** A file on no record, added by the owner (who holds every key). */
async function aFile(name: string): Promise<string> {
  const added = await filesAs(fx.owner).upload(name);
  expect(added.status).toBe(201);
  return idOf(added);
}`;
  const crewCase = sched
    ? `

  it("a crew member's link to a visit's photo stops once the visit moves to another crew", async () => {
    // The crew role exists once scheduling has run its first-time setup.
    await ensureSchedulingSetup();
    const cam = await person("ext_files_staff_cam", "cam@greenblade.test", "Cam Crew");
    await staffRole(cam, "crew");
    const north = await createResource(db, { tenantId: FILES_TENANT, name: "North Link", userId: cam.id });
    const south = await createResource(db, { tenantId: FILES_TENANT, name: "South Link" });
    const visitId = (
      await bookVisit(
        db,
        { tenantId: FILES_TENANT, resourceId: north.id, scheduledDate: "2031-06-04", startTime: "09:00", endTime: "10:00", customerName: "Pat Rivera", status: "confirmed" },
        { skipValidation: true },
      )
    ).visit.id;
    const added = await filesAs(cam).attach({ type: "scheduling.visit", id: visitId }, "front-door.png");
    expect(added.status).toBe(201);
    const fileId = await idOf(added);
    const url = await linkOf(cam, fileId);
    expect((await openLink(url)).status).toBe(200);

    await db.execute(sql\`update scheduling_bookings set resource_id = \${south.id} where id = \${visitId}\`);
    expect((await contentAs(cam, fileId)).status).toBe(404);
    expect((await openLink(url)).status).toBe(404);
  });`
    : "";
  const imports = [
    `import { beforeAll, describe, expect, it, vi } from "vitest";`,
    ...(sched ? [`import { sql } from "drizzle-orm";`] : []),
    `import { users } from "${scope}/auth/schema";`,
    ...(overrides ? [`import { principalOverride } from "${scope}/permissions/schema";`] : []),
    `import { assignRoleTemplate } from "${scope}/permissions/server";`,
    ...(est && !inv ? [`import { createEstimate } from "${scope}/estimator";`] : []),
    ...(inv ? [`import { createInvoice } from "${scope}/invoicing";`] : []),
    ...(sched ? [`import { bookVisit, createResource } from "${scope}/scheduling";`] : []),
    `import { db } from "@/db";`,
    `import { seedPermissions } from "@/permissions/seed";`,
    `import { FILES_TENANT } from "@/server/files";`,
    `import { buildFileLinkHandlers, buildFilesHandlers${overrides ? ", filesStaffKeyFor" : ""} } from "@/server/files-routes";`,
    ...(sched ? [`import { ensureSchedulingSetup } from "@/server/scheduling";`] : []),
    `import { tenancy } from "@/server/tenancy";`,
  ];
  return `${imports.join("\n")}

/**
 * A COPIED LINK ENDS WITH ITS MAKER'S ACCESS TO THE FILE (Tenancy 2b-1, review
 * SEC-03), in this single-business project: through its own files routes,
 * staff keys and member check (src/server/files.ts), over in-memory stores.
 * "Copy link" makes a link anyone can open for an hour; every open asks again
 * whether the staff member who made it still holds a staff role AND may still
 * see THIS file (\`mayView\`). Without the second question, a staff member
 * who lost what lets them see a file${sched ? `, or a crew member whose visit went to
 * another crew,` : ""} would keep opening it through the link they copied
 * while the screens already refused them.
 *
 * PGlite, so it runs on every \`pnpm test\` with nothing configured. Clerk is
 * the one thing stood in for, at its own module boundary.
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

/** Clerk keys present, so the files routes ask who is signed in instead of answering "signed out". */
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === "CLERK_SECRET_KEY") return "sk_test_files_staff";
        if (prop === "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY") return "pk_test_files_staff";
        return Reflect.get(target, prop);
      },
    }),
  };
});

// Hoisted with the mocks: who Clerk says is signed in, per request.
const clerk = vi.hoisted(() => ({ externalId: null as string | null }));

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ userId: clerk.externalId }),
  currentUser: () => Promise.resolve(null),
}));

/**
 * THE PROJECT'S FILES, over memory stores: the same purposes, records, staff
 * keys and member check (createFilesStorage), with a signing key so "Copy
 * link" is on.
 */
vi.mock("@/server/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/files")>();
  const { createMemoryBlobStore } = await import("${scope}/storage/testing");
  const files = actual.createFilesStorage(
    { private: createMemoryBlobStore({ access: "private" }), public: createMemoryBlobStore({ access: "public" }) },
    { signingSecret: "files-staff-test-signing-secret-thirty-two" },
  );
  return {
    ...actual,
    files,
    filesLogoStore: files.logoStore(),${est ? `
    estimatorPhotoStore: files.purposeStore("estimator.photo"),
    estimatorStaffPhotoStore: files.purposeStore("estimator.staff-photo"),` : ""}
  };
});

const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

interface Person {
  readonly id: string;
  readonly externalId: string;
}

const fx = {} as { owner: Person };

async function person(externalId: string, email: string, name: string): Promise<Person> {
  const [row] = await db.insert(users).values({ externalId, email, displayName: name }).returning();
  if (!row) throw new Error("could not create the test person");
  await tenancy.provisionUser({ userId: row.id, email });
  return { id: row.id, externalId };
}

/** Give someone a staff role, change it, or (null) take it away: the People screen's one write path. */
async function staffRole(who: Person, templateKey: string | null): Promise<void> {
  await assignRoleTemplate(db, { scope: "staff", principalId: who.id, templateKey, actor: { system: "test" } });
}

/** A person's files routes, signed in as them. */
function filesAs(who: Person) {
  const { handle } = buildFilesHandlers();
  const base = "http://localhost/api/admin/files/";
  const headers = { "sec-fetch-site": "same-origin" };
  const send = (req: Request) => {
    clerk.externalId = who.externalId;
    return handle(req);
  };
  const withFile = (path: string, name: string) => {
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), name);
    return send(new Request(base + path, { method: "POST", headers, body: form }));
  };
  return {
    get: (path: string) => send(new Request(base + path, { headers })),
    post: (path: string) =>
      send(new Request(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" })),
    upload: (name: string) => withFile("v1/admin/files", name),
    attach: (record: { type: string; id: string }, name: string) =>
      withFile(\`v1/admin/attachments?record=\${encodeURIComponent(record.type)}&id=\${encodeURIComponent(record.id)}\`, name),
  };
}

async function idOf(res: Response): Promise<string> {
  const body = (await res.json()) as { file?: { id?: string } };
  if (!body.file?.id) throw new Error(\`no file in the answer: \${JSON.stringify(body).slice(0, 200)}\`);
  return body.file.id;
}

/** "Copy link" on one file, as \`who\`. */
async function linkOf(who: Person, fileId: string): Promise<string> {
  const made = await filesAs(who).post(\`v1/admin/files/\${encodeURIComponent(fileId)}/link\`);
  expect(made.status).toBe(200);
  return ((await made.json()) as { url: string }).url;
}

/** A copied link, opened as anyone would: nobody signed in, through the site's own /api/files route. */
async function openLink(url: string): Promise<Response> {
  clerk.externalId = null;
  const { handle } = buildFileLinkHandlers();
  return handle(new Request(\`http://localhost\${new URL(url).pathname}\`));
}

/** The file's content route, as \`who\`: what the screens open. */
function contentAs(who: Person, fileId: string): Promise<Response> {
  return filesAs(who).get(\`v1/admin/files/\${encodeURIComponent(fileId)}/content\`);
}

${fileHelper}

beforeAll(async () => {
  await seedPermissions(db, { log: () => {} });
  fx.owner = await person("ext_files_staff_owner", "olivia@greenblade.test", "Olivia Owner");
  await staffRole(fx.owner, "admin");
});

describe("a copied link ends with its maker's access to the file (review SEC-03)", () => {
  it(${JSON.stringify(`a staff member ${subject.lose.said}: their link to ${subject.what} stops at once`)}, async () => {
    const fileId = await aFile("terms.png");
    const lee = await person("ext_files_staff_lee", "lee@greenblade.test", "Lee Lead");
    await staffRole(lee, "cs_lead");
    const url = await linkOf(lee, fileId);
    expect((await openLink(url)).status).toBe(200);

${loseStep}
    // The screens already refuse them…
    expect((await contentAs(lee, fileId)).status).toBe(404);
    // …and so does the link they copied.
    expect((await openLink(url)).status).toBe(404);
    // The owner's own link to the same file still opens: the file is fine, the maker isn't.
    expect((await openLink(await linkOf(fx.owner, fileId))).status).toBe(200);
  });

  it("a staff member removed from the staff: their link stops", async () => {
    const fileId = await aFile("plan.png");
    const ray = await person("ext_files_staff_ray", "ray@greenblade.test", "Ray Removed");
    await staffRole(ray, "cs_lead");
    const url = await linkOf(ray, fileId);
    expect((await openLink(url)).status).toBe(200);
    await staffRole(ray, null);
    expect((await openLink(url)).status).toBe(404);
  });${crewCase}
});
`;
}

// ---------------------------------------------------------------------------
// src/server/__tests__/glue-imports.test.ts (with notifications or storage)
// ---------------------------------------------------------------------------

/** The glue modules this project has, in the import chains 13.10 names. */
function glueModules(answers: Answers): string[] {
  const companies = answers.tenantNoun !== "none";
  return [
    ...(answers.includeNotifications ? ["@/server/alerts", "@/server/alerts-routes"] : []),
    ...(answers.includeStorage ? ["@/server/files", "@/server/files-routes"] : []),
    "@/server/tenancy",
    "@/server/tenancy-logo",
    ...(companies ? ["@/server/company-routes", "@/server/company-setup", "@/server/company-links"] : []),
    ...(answers.includeScheduling ? ["@/server/scheduling", "@/server/scheduling-notify"] : []),
    ...(answers.includeEstimator ? ["@/server/estimator", "@/server/estimator-notify", "@/server/estimator-services"] : []),
    ...(answers.includeInvoicing ? ["@/server/invoicing"] : []),
    ...(answers.includeComms ? ["@/server/comms-senders", "@/server/comms", "@/server/comms-hooks"] : []),
  ];
}

/**
 * EVERY GLUE MODULE LOADS FIRST AND ALONE (13.10): each is imported into a
 * fresh module graph, so a cycle where one module reads another
 * half-initialised fails here, by name, instead of in production.
 */
export function renderGlueImportsTest(answers: Answers): string {
  const modules = glueModules(answers);
  const cases = modules
    .map(
      (path) => `  it(${JSON.stringify(path)}, async () => {
    vi.resetModules();
    const loaded: Record<string, unknown> = await import(${JSON.stringify(path)});
    expect(Object.keys(loaded).length).toBeGreaterThan(0);
    // A first, cold load transforms the whole chain: allowed its time.
  }, 60_000);`,
    )
    .join("\n\n");
  return `import { describe, expect, it, vi } from "vitest";

/**
 * EVERY GLUE MODULE LOADS FIRST AND ALONE (Tenancy 2b-1, 13.10). The modules
 * below form two import chains — company-routes → company-setup → the feature
 * glue → the listeners → alerts, and tenancy → tenancy-logo → files — that
 * stay safe only while every cross-module use happens inside a function. Each
 * is loaded here into a fresh module graph, first and alone: one that reads
 * another half-initialised at load fails by name.
 *
 * No database: nothing may query at load, so a stand-in that answers nothing
 * is enough — and a module that did query at load would fail here too.
 */
vi.mock("@/db", () => ({ db: {} }));

describe("every glue module loads first and alone", () => {
${cases}
});
`;
}

// ---------------------------------------------------------------------------
// src/server/__tests__/company-crons.test.ts
// ---------------------------------------------------------------------------

export function renderCompanyCronsTest(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  const scheduling = answers.includeScheduling;
  const estimator = answers.includeEstimator;
  const comms = answers.includeComms;
  // Which cron proves "one company's failure doesn't stop the rest": the
  // scheduling one when installed, else the estimator's. (The comms drain is
  // one call over every active company; its per-row isolation is comms' own.)
  const failingCron = scheduling ? "scheduling" : estimator ? "estimator" : null;

  const imports = [
    `import { beforeAll, describe, expect, it, vi } from "vitest";`,
    `import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";`,
    `import { users } from "${scope}/auth/schema";`,
    ...(comms ? [`import { commsMessages, commsScheduled, enqueueMessage, upsertTemplate } from "${scope}/comms";`] : []),
    ...(estimator
      ? [`import { createEstimate, getEstimateRow, sendQuote, updateEstimatorSettings } from "${scope}/estimator";`]
      : []),
    ...(scheduling ? [`import { bookVisit, getBooking } from "${scope}/scheduling";`] : []),
    `import { db } from "@/db";`,
    `import { seedPermissions } from "@/permissions/seed";`,
    `import { ensureCompanySetup } from "@/server/company-setup";`,
    `import { tenancy } from "@/server/tenancy";`,
    ...(scheduling ? [`import { GET as schedulingCron } from "../../../app/api/cron/scheduling/route";`] : []),
    ...(estimator ? [`import { GET as estimatorCron } from "../../../app/api/cron/estimator/route";`] : []),
    ...(comms ? [`import { GET as commsCron } from "../../../app/api/cron/comms/route";`] : []),
  ];

  // The package function the failing company's run breaks in. Mocked at the
  // PACKAGE, not at the glue module: a partial mock of the glue would load the
  // real glue inside its own factory, and the glue imports modules that import
  // it back (company-setup), which a mock factory can't resolve.
  const failMock =
    failingCron === "scheduling"
      ? `
// CONTRACT: the failure is injected at the package function the cron calls
// (expirePendingRequests), not with vi.spyOn on the glue module: mocking the
// glue would load the real glue inside its own mock factory, and the glue
// imports modules that import it back. The cron still runs exactly as
// deployed for every company but the one told to fail.
vi.mock("${scope}/scheduling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("${scope}/scheduling")>();
  return {
    ...actual,
    expirePendingRequests: (...args: Parameters<typeof actual.expirePendingRequests>) =>
      breaking.tenants.has(args[1])
        ? Promise.reject(new Error("this company's run broke on purpose"))
        : actual.expirePendingRequests(...args),
  };
});`
      : failingCron === "estimator"
        ? `
// CONTRACT: the failure is injected at the package function the cron calls
// (expireQuotes), not with vi.spyOn on the glue module — see the scheduling
// variant of this file for why.
vi.mock("${scope}/estimator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("${scope}/estimator")>();
  return {
    ...actual,
    expireQuotes: (...args: Parameters<typeof actual.expireQuotes>) =>
      breaking.tenants.has(args[1])
        ? Promise.reject(new Error("this company's run broke on purpose"))
        : actual.expireQuotes(...args),
  };
});`
        : "";

  const plant: string[] = [];
  if (scheduling) {
    plant.push(`
  // An online request nobody answered: made three days ago, so its 48-hour
  // wait ran out yesterday.
  const { visit } = await bookVisit(
    db,
    {
      tenantId,
      scheduledDate: "2031-03-04",
      startTime: "09:00",
      endTime: "10:00",
      customerName: \`\${label} customer\`,
      customerEmail: \`customer@\${domain}.test\`,
      status: "pending",
    },
    { now: daysAgo(3), skipValidation: true },
  );
  planted.visit = visit.id;`);
  }
  if (estimator) {
    plant.push(`
  // A quote sent three days ago, good for one day: past its date.
  await updateEstimatorSettings(db, tenantId, { businessName: label, taxRateBp: 0 });
  const estimate = await createEstimate(db, {
    tenantId,
    customerName: \`\${label} customer\`,
    customerEmail: \`customer@\${domain}.test\`,
    items: [{ description: "Probe line", quantity: 1, unitPrice: 10_000 }],
  });
  await sendQuote(db, tenantId, estimate.id, { validDays: 1 }, { now: daysAgo(3) });
  planted.estimate = estimate.id;`);
  }
  if (comms) {
    plant.push(`
  // A message due a minute ago.
  await upsertTemplate(db, { tenantId, key: "cron_probe", channel: "email", subject: "Probe", body: "A queued probe." });
  const queued = await enqueueMessage(db, {
    tenantId,
    to: \`queued@\${domain}.test\`,
    templateKey: "cron_probe",
    sendAt: new Date(Date.now() - 60_000),
  });
  if (!queued) throw new Error("the due message wasn't queued");
  planted.queued = queued;`);
  }

  const tests: string[] = [];
  if (scheduling) {
    tests.push(`
  it("the scheduling cron releases every active ${noun}'s overdue request — and not a suspended one's", async () => {
    const res = await schedulingCron(cronRequest("scheduling"));
    expect(res.status).toBe(200);
    const report = (await res.json()) as Report;
    expect(report.ran.map((r) => r.tenantId).sort()).toEqual([fx.A.tenantId, fx.B.tenantId].sort());
    expect(report.failed).toEqual([]);
    for (const company of [fx.A, fx.B]) {
      expect((await getBooking(db, company.tenantId, company.visit!))?.status, company.name).toBe("expired");
    }
    // Suspended: not in the list, so its request still waits.
    expect((await getBooking(db, fx.C.tenantId, fx.C.visit!))?.status).toBe("pending");
  });`);
  }
  if (estimator) {
    tests.push(`
  it("the estimator cron expires every active ${noun}'s past-date quote — and not a suspended one's", async () => {
    const res = await estimatorCron(cronRequest("estimator"));
    expect(res.status).toBe(200);
    const report = (await res.json()) as Report;
    expect(report.ran.map((r) => r.tenantId).sort()).toEqual([fx.A.tenantId, fx.B.tenantId].sort());
    for (const company of [fx.A, fx.B]) {
      expect((await getEstimateRow(db, company.tenantId, company.estimate!))?.status, company.name).toBe("expired");
    }
    expect((await getEstimateRow(db, fx.C.tenantId, fx.C.estimate!))?.status).toBe("sent");
  });`);
  }
  if (comms) {
    tests.push(`
  it("the comms cron drains every active ${noun}'s due messages — and leaves a suspended one's waiting", async () => {
    const res = await commsCron(cronRequest("comms"));
    expect(res.status).toBe(200);
    for (const company of [fx.A, fx.B]) {
      // No RESEND_API_KEY here: the message is logged "skipped" — but logged,
      // which is the drain having reached it.
      const logged = await db
        .select({ id: commsMessages.id })
        .from(commsMessages)
        .where(and(eq(commsMessages.tenantId, company.tenantId), eq(commsMessages.templateKey, "cron_probe")));
      expect(logged.length, company.name).toBe(1);
    }
    const [waiting] = await db
      .select({ status: commsScheduled.status })
      .from(commsScheduled)
      .where(eq(commsScheduled.id, fx.C.queued!));
    expect(waiting?.status).toBe("pending");
  });`);
  }
  if (failingCron) {
    const cronFn = failingCron === "scheduling" ? "schedulingCron" : "estimatorCron";
    tests.push(`
  it("one ${noun}'s failure doesn't stop the others: it is reported, and the rest still run", async () => {
    breaking.tenants.add(fx.A.tenantId);
    try {
      const res = await ${cronFn}(cronRequest("${failingCron}"));
      expect(res.status).toBe(200);
      const report = (await res.json()) as Report;
      expect(report.failed.map((f) => f.tenantId)).toEqual([fx.A.tenantId]);
      expect(report.failed[0]?.error).toContain("broke on purpose");
      expect(report.ran.map((r) => r.tenantId)).toEqual([fx.B.tenantId]);
    } finally {
      breaking.tenants.delete(fx.A.tenantId);
    }
  });`);
  }
  if (comms) {
    // LAST: it makes two more companies, which the runs above must not see.
    tests.push(`
  it("a ${noun} with hundreds of due messages doesn't hold back another ${noun}'s one: they take turns (review SEC-2A-01)", async () => {
    // NOISY has 210 messages due, every one older than QUIET's one (its
    // planted cron probe, due a minute ago). Oldest first across the site,
    // QUIET's would wait behind all of them — past the old 200-row limit, to
    // the next day's run.
    const noisy = await companyWithWork("ext-cron-noisy", "owner@noisy-cron.test", "Noisy Co");
    const quiet = await companyWithWork("ext-cron-quiet", "owner@quiet-cron.test", "Quiet Co");
    await db.insert(commsScheduled).values(
      Array.from({ length: 210 }, (_, i) => ({
        tenantId: noisy.tenantId,
        channel: "email",
        toAddress: \`n\${i}@noisy-cron.test\`,
        templateKey: "cron_probe",
        vars: {},
        sendAt: new Date(Date.now() - 10 * 60_000 - i * 1000),
      })),
    );
    const res = await commsCron(cronRequest("comms"));
    expect(res.status).toBe(200);
    // QUIET's message went out in this run…
    const [mine] = await db
      .select({ status: commsScheduled.status, claimedAt: commsScheduled.claimedAt })
      .from(commsScheduled)
      .where(eq(commsScheduled.id, quiet.queued!));
    expect(mine?.status).not.toBe("pending");
    // …in the FIRST round: claimed no later than NOISY's second message.
    const noisyClaims = (
      await db
        .select({ claimedAt: commsScheduled.claimedAt })
        .from(commsScheduled)
        .where(and(inArray(commsScheduled.tenantId, [noisy.tenantId]), isNotNull(commsScheduled.claimedAt)))
    )
      .map((row) => row.claimedAt!.getTime())
      .sort((x, y) => x - y);
    expect(noisyClaims.length).toBeGreaterThan(1);
    expect(mine!.claimedAt!.getTime()).toBeLessThanOrEqual(noisyClaims[1]!);
  });`);
  }

  return `${imports.join("\n")}

/**
 * EVERY CRON SERVES EVERY ACTIVE ${noun.toUpperCase()} (Tenancy 2a, D10) — through this
 * project's own cron routes, with the secret, exactly as the scheduler calls
 * them. Three ${noun === "company" ? "companies" : `${noun}s`}: A and B active, C SUSPENDED, each holding
 * the same overdue work. A's and B's is done; C's waits untouched; and when
 * one ${noun}'s run throws, it is reported in \`failed\` and the others still
 * run.
 *
 * PGlite, so it runs on every \`pnpm test\` with nothing configured.
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

/** The cron secret set, and no RESEND_API_KEY whatever this laptop's .env.local says. */
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === "CRON_SECRET") return "cron-test-secret";
        if (prop === "RESEND_API_KEY") return undefined;
        return Reflect.get(target, prop);
      },
    }),
  };
});

const breaking = vi.hoisted(() => ({ tenants: new Set<string>() }));
${failMock}

interface Planted {
  readonly name: string;
  readonly tenantId: string;
  visit?: string;
  estimate?: string;
  queued?: string;
}

interface Report {
  readonly companies: number;
  readonly ran: readonly { readonly tenantId: string }[];
  readonly failed: readonly { readonly tenantId: string; readonly error: string }[];
  readonly deferred: readonly string[];
}

const fx = {} as { A: Planted; B: Planted; C: Planted };

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function cronRequest(name: string): Request {
  return new Request(\`http://localhost/api/cron/\${name}\`, { headers: { "x-cron-secret": "cron-test-secret" } });
}

async function companyWithWork(externalId: string, email: string, label: string): Promise<Planted> {
  const [row] = await db.insert(users).values({ externalId, email, displayName: \`\${label} Owner\` }).returning();
  if (!row) throw new Error("could not create the owner");
  await tenancy.provisionUser({ userId: row.id, email });
  // A request key is letters, digits and hyphens — hence the hyphenated ids.
  const { company } = await tenancy.createCompany({ userId: row.id, name: label, requestKey: \`cron-\${externalId}\`, purpose: "onboarding" });
  const tenantId = company.id;
  await ensureCompanySetup(tenantId);
  const planted: Planted = { name: label, tenantId };
  // "Alpha Lawn Care" → "alpha-lawn-care": an email domain can't hold a space.
  const domain = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
${plant.join("\n")}
  return planted;
}

beforeAll(async () => {
  await seedPermissions(db, { log: () => {} });
  fx.A = await companyWithWork("ext-cron-a", "owner@alpha-cron.test", "Alpha Lawn Care");
  fx.B = await companyWithWork("ext-cron-b", "owner@bravo-cron.test", "Bravo Roofing");
  fx.C = await companyWithWork("ext-cron-c", "owner@cedar-cron.test", "Cedar Pools");
  // C is SUSPENDED: what the operator console's Suspend writes.
  await db.execute(sql\`update tenants set suspended_at = now(), suspended_reason = 'cron test' where id = \${fx.C.tenantId}\`);
});

describe("the crons serve every active ${noun}", () => {
  it("refuses a call without the secret", async () => {
    const res = await ${scheduling ? "schedulingCron" : estimator ? "estimatorCron" : "commsCron"}(new Request("http://localhost/api/cron/probe"));
    expect(res.status).toBe(401);
  });
${tests.join("\n")}
});
`;
}

// ---------------------------------------------------------------------------
// src/server/__tests__/company-email.test.ts (with comms and email)
// ---------------------------------------------------------------------------

export function renderCompanyEmailTest(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  const scheduling = answers.includeScheduling;
  // Tenancy 2b-1 (14.4): with alerts installed, the office notice goes to the
  // people Alert settings name (the owner's copy at the business email).
  const officeByAlerts = scheduling && answers.includeNotifications;
  // The team's own template the allowance case sends as (review BO-10); none
  // when no installed package sends the team anything.
  const teamKey = teamTemplateKeys(answers)[0] ?? null;
  const teamTest = teamKey
    ? `

  it("counts a ${noun}'s TEAM emails apart (review BO-10): a morning of office notices never holds a customer's email, and the team has its own ceiling", async () => {
    const fresh = await company("ext-mail-e", "eve@echo-owner.test", "Echo Pools", null);
    // The team's whole hour first…
    for (let i = 0; i < COMMS_SEND_ALLOWANCE.team.hour; i++) {
      expect(await companySendAllowance({ tenantId: fresh.tenantId, templateKey: ${JSON.stringify(teamKey)} }), \`team email \${i + 1}\`).toBe(true);
    }
    expect(await companySendAllowance({ tenantId: fresh.tenantId, templateKey: ${JSON.stringify(teamKey)} }), "one team email over the hour").toBe(false);
    // …and the customer's email still goes: the two are counted apart.
    expect(await companySendAllowance({ tenantId: fresh.tenantId, templateKey: "identity_probe" })).toBe(true);
  });`
    : "";
  const imports = [
    `import { beforeAll, describe, expect, it, vi } from "vitest";`,
    `import { and, eq } from "drizzle-orm";`,
    `import { users } from "${scope}/auth/schema";`,
    `import { commsMessages, sendNow, upsertTemplate } from "${scope}/comms";`,
    `import type { EmailTransport } from "${scope}/email";`,
    ...(scheduling ? [`import { bookVisit, expirePendingRequests } from "${scope}/scheduling";`] : []),
    `import { db } from "@/db";`,
    `import { seedPermissions } from "@/permissions/seed";`,
    `import { buildCommsSenders, COMMS_SEND_ALLOWANCE, companySendAllowance } from "@/server/comms-senders";`,
    `import { ensureCompanySetup } from "@/server/company-setup";`,
    ...(officeByAlerts ? [`import { alerts } from "@/server/alerts";`] : []),
    ...(scheduling ? [`import { onSchedulingEvent } from "@/server/scheduling-notify";`] : []),
    `import { tenancy } from "@/server/tenancy";`,
  ];
  const officeMock = officeByAlerts
    ? `
/**
 * WITH ALERTS (Tenancy 2b-1, D6): an office notice goes only where email
 * really leaves — Alert settings say "this site doesn't send email yet"
 * otherwise, and the office hears in the app. So this project's OWN senders
 * (the ones the listeners and the alerts use) are pointed at a capturing
 * transport here; everything else about them is the real module.
 */
const OFFICE = vi.hoisted(() => ({ outbox: [] as unknown[] }));
vi.mock("@/server/comms-senders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/comms-senders")>();
  return {
    ...actual,
    commsEmailConfigured: true,
    commsSenders: actual.buildCommsSenders(async (message) => {
      OFFICE.outbox.push(message);
      return { id: \`office_\${OFFICE.outbox.length}\` };
    }),
  };
});
`
    : "";
  const lapse = `
/** A request the ${noun} never answered, made three days ago, lapsed now: the office is told ("Request expired"). */
async function lapsedRequest(tenantId: string, customerName: string): Promise<string> {
  const { visit } = await bookVisit(
    db,
    {
      tenantId,
      scheduledDate: "2031-03-04",
      startTime: "09:00",
      endTime: "10:00",
      customerName,
      customerEmail: "customer@alpha.test",
      status: "pending",
    },
    { now: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), skipValidation: true },
  );
  await expirePendingRequests(db, tenantId, { onEvent: onSchedulingEvent });
  return visit.id;
}

/** The office notices a ${noun} has sent, oldest first. */
async function officeNotices(tenantId: string) {
  return db
    .select({ to: commsMessages.toAddress, fromName: commsMessages.fromName, replyTo: commsMessages.replyTo })
    .from(commsMessages)
    .where(and(eq(commsMessages.tenantId, tenantId), eq(commsMessages.templateKey, "visit_staff_notice")))
    .orderBy(commsMessages.createdAt, commsMessages.id);
}
`;
  const alertsOfficeTest = `

  it("sends a ${noun}'s office notices to the people Alert settings name (the owner's copy at the business email) — never to the platform owner", async () => {
    // Alert settings' visits list is on "The owner" (the default): the
    // owner's copy goes to the business email in ${noun} settings (review BO-01).
    await lapsedRequest(fx.A.tenantId, "Alpha Customer");
    const first = await officeNotices(fx.A.tenantId);
    expect(first.map((n) => n.to)).toEqual([fx.A.contact]);
    expect(first[0]?.fromName).toBe(fx.A.name);
    // Reply on the office's notice reaches the customer it is about (review T2A-BO-12).
    expect(first[0]?.replyTo).toBe("customer@alpha.test");

    // The owner names who hears about visits: themself, by name, and the front
    // desk's address. The next notice goes to exactly those (the owner, now
    // chosen by name, at their own address).
    const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.email, fx.A.owner));
    if (!owner) throw new Error("A's owner is missing");
    await alerts.setRouting({ tenantId: fx.A.tenantId, routing: "visits", mode: "chosen", userIds: [owner.id], extraEmails: ["frontdesk@alpha-lawn.test"], by: owner.id });
    await lapsedRequest(fx.A.tenantId, "Second Customer");
    const after = await officeNotices(fx.A.tenantId);
    expect(after.length).toBe(3);
    expect(after.slice(1).map((n) => n.to).sort()).toEqual([fx.A.owner, "frontdesk@alpha-lawn.test"].sort());
    expect(after.at(-1)?.fromName).toBe(fx.A.name);

    // Not to the platform owner, by any ${noun}'s email.
    const toPlatform = await db.select({ id: commsMessages.id }).from(commsMessages).where(eq(commsMessages.toAddress, PLATFORM.owner));
    expect(toPlatform).toEqual([]);
  });`;
  const schedulingTest = officeByAlerts
    ? alertsOfficeTest
    : scheduling
    ? `

  it("sends a ${noun}'s office notices to its own inbox — never to the platform owner", async () => {
    // A request the ${noun} never answered lapses: the office is told
    // ("Request expired"), and the customer is told too.
    const { visit } = await bookVisit(
      db,
      {
        tenantId: fx.A.tenantId,
        scheduledDate: "2031-03-04",
        startTime: "09:00",
        endTime: "10:00",
        customerName: "Alpha Customer",
        customerEmail: "customer@alpha.test",
        status: "pending",
      },
      { now: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), skipValidation: true },
    );
    await expirePendingRequests(db, fx.A.tenantId, { onEvent: onSchedulingEvent });
    const notices = await db
      .select({ to: commsMessages.toAddress, fromName: commsMessages.fromName, replyTo: commsMessages.replyTo })
      .from(commsMessages)
      .where(and(eq(commsMessages.tenantId, fx.A.tenantId), eq(commsMessages.templateKey, "visit_staff_notice")));
    expect(notices.map((n) => n.to)).toEqual([fx.A.contact]);
    expect(notices[0]?.fromName).toBe(fx.A.name);
    // Reply on the office's notice reaches the customer it is about (review T2A-BO-12).
    expect(notices[0]?.replyTo).toBe("customer@alpha.test");
    expect(visit.id).toBeTruthy();
    // Not to the platform owner, by any ${noun}'s email.
    const toPlatform = await db.select({ id: commsMessages.id }).from(commsMessages).where(eq(commsMessages.toAddress, PLATFORM.owner));
    expect(toPlatform).toEqual([]);
  });`
    : "";
  return `${imports.join("\n")}

/**
 * A ${noun.toUpperCase()}'S EMAILS GO OUT AS THE ${noun.toUpperCase()} (Tenancy 2a, D8) — through
 * this project's own senders (src/server/comms-senders.ts) over a capturing
 * transport, so what is checked is exactly what the provider would be handed:
 *
 *   - From: "{${noun} name}" on this site's sending address (EMAIL_FROM's);
 *   - Reply-To: the ${noun}'s contact email, else its owner's address — never
 *     this site's EMAIL_REPLY_TO while the ${noun} has either;
 *   - neither ${noun}'s email carries the other's name or address;
 *   - the delivery log records the From name and Reply-To each one went out
 *     under${officeByAlerts ? ";\n *   - office notices go to the people Alert settings name (the owner's copy\n *     at the " + noun + "'s business email), never to the platform owner\n *     (BOOTSTRAP_ADMIN_EMAIL)" : scheduling ? ";\n *   - office notices go to the " + noun + "'s own inbox, never to the platform\n *     owner (BOOTSTRAP_ADMIN_EMAIL)" : ""}.
 *
 * PGlite, so it runs on every \`pnpm test\` with nothing configured.
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

// Hoisted with the mocks: the env mock below is read while the modules under
// test are still importing, before a plain const here would exist.
const PLATFORM = vi.hoisted(() => ({
  from: "messages@igloo-platform.test",
  replyTo: "help@igloo-platform.test",
  owner: "owner@igloo-platform.test",
}));

/** This site's own sending identity, as a deployment sets it — and no real email key. */
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === "EMAIL_FROM") return \`Igloo Platform <\${PLATFORM.from}>\`;
        if (prop === "EMAIL_REPLY_TO") return PLATFORM.replyTo;
        if (prop === "BOOTSTRAP_ADMIN_EMAIL") return PLATFORM.owner;
        if (prop === "RESEND_API_KEY") return undefined;
        return Reflect.get(target, prop);
      },
    }),
  };
});
${officeMock}
interface Company {
  readonly name: string;
  readonly tenantId: string;
  readonly owner: string;
  readonly contact: string | null;
}

/** What the provider was handed, message by message. */
const outbox: Parameters<EmailTransport>[0][] = [];
const capture: EmailTransport = async (message) => {
  outbox.push(message);
  return { id: \`captured_\${outbox.length}\` };
};
const senders = buildCommsSenders(capture);

const fx = {} as { A: Company; B: Company; C: Company };

async function company(externalId: string, owner: string, name: string, contact: string | null): Promise<Company> {
  const [row] = await db.insert(users).values({ externalId, email: owner, displayName: \`\${name} Owner\` }).returning();
  if (!row) throw new Error("could not create the owner");
  await tenancy.provisionUser({ userId: row.id, email: owner });
  const created = await tenancy.createCompany({ userId: row.id, name, requestKey: \`email-\${externalId}\`, purpose: "onboarding" });
  const tenantId = created.company.id;
  if (contact) {
    await tenancy.updateSettings({ actorUserId: row.id, tenantId, section: "company", values: { contactEmail: contact } });
  }
  await ensureCompanySetup(tenantId);
  await upsertTemplate(db, { tenantId, key: "identity_probe", channel: "email", subject: "Hello from us", body: "A note, {{name}}." });
  return { name, tenantId, owner, contact };
}

async function sendFor(c: Company, to: string): Promise<Parameters<EmailTransport>[0]> {
  const before = outbox.length;
  await sendNow(db, { tenantId: c.tenantId, to, templateKey: "identity_probe" }, senders);
  expect(outbox.length, \`\${c.name}'s email reached the transport\`).toBe(before + 1);
  return outbox[outbox.length - 1]!;
}
${officeByAlerts ? lapse : ""}
beforeAll(async () => {
  await seedPermissions(db, { log: () => {} });
  fx.A = await company("ext-mail-a", "ada@alpha-owner.test", "Alpha Lawn Care", "office@alpha-lawn.test");
  fx.B = await company("ext-mail-b", "ben@bravo-owner.test", "Bravo Roofing", "office@bravo-roofing.test");
  fx.C = await company("ext-mail-c", "cy@cedar-owner.test", "Cedar Pools", null);
});

describe("each ${noun}'s email goes out as the ${noun}", () => {
  it("carries the ${noun}'s name on this site's address, and the ${noun}'s reply-to", async () => {
    const a = await sendFor(fx.A, "customer@alpha.test");
    const b = await sendFor(fx.B, "customer@bravo.test");
    for (const [sent, mine, theirs] of [
      [a, fx.A, fx.B],
      [b, fx.B, fx.A],
    ] as const) {
      expect(sent.from, mine.name).toContain(mine.name);
      expect(sent.from, mine.name).toContain(\`<\${PLATFORM.from}>\`);
      expect(sent.replyTo, mine.name).toBe(mine.contact);
      // Never the other ${noun}'s, and never the platform's reply-to.
      expect(\`\${sent.from} \${sent.replyTo}\`, mine.name).not.toContain(theirs.name);
      expect(\`\${sent.from} \${sent.replyTo}\`, mine.name).not.toContain(theirs.contact!);
      expect(sent.replyTo, mine.name).not.toBe(PLATFORM.replyTo);
    }
  });

  it("with no contact email, replies go to the ${noun}'s owner — still never to the platform", async () => {
    const c = await sendFor(fx.C, "customer@cedar.test");
    expect(c.from).toContain(fx.C.name);
    expect(c.replyTo).toBe(fx.C.owner);
  });

  it("holds a ${noun} to its sending allowance: a new ${noun}'s emails stop at its hourly cap (review SEC-2A-03)", async () => {
    // A ${noun} made just now, that has sent nothing: the new-${noun} allowance.
    const fresh = await company("ext-mail-d", "di@delta-owner.test", "Delta Cleaning", null);
    const cap = COMMS_SEND_ALLOWANCE.newCompany.hour;
    for (let i = 0; i < cap; i++) expect(await companySendAllowance({ tenantId: fresh.tenantId }), \`email \${i + 1}\`).toBe(true);
    expect(await companySendAllowance({ tenantId: fresh.tenantId })).toBe(false);
    // Another ${noun}'s allowance is its own.
    expect(await companySendAllowance({ tenantId: fx.B.tenantId })).toBe(true);
    // And a held email is logged as held, never sent.
    const before = outbox.length;
    const row = await sendNow(db, { tenantId: fresh.tenantId, to: "customer@delta.test", templateKey: "identity_probe" }, senders);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/^held:/);
    expect(outbox.length).toBe(before);
  });

  it("records in the delivery log who each email went out as, and where replies go", async () => {
    for (const c of [fx.A, fx.B]) {
      const [logged] = await db
        .select({ fromName: commsMessages.fromName, replyTo: commsMessages.replyTo })
        .from(commsMessages)
        .where(and(eq(commsMessages.tenantId, c.tenantId), eq(commsMessages.templateKey, "identity_probe")));
      expect(logged, c.name).toEqual({ fromName: c.name, replyTo: c.contact });
    }
  });${teamTest}${schedulingTest}
});
`;
}
