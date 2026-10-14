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

import { tenantLabel, type Answers } from "./answers.js";

interface FeatureSuite {
  readonly feature: string;
  readonly glue: string;
  readonly adminBuilder: string;
  readonly adminRoutes: string;
  readonly adminSegment: string;
  readonly publicBuilder: string | null;
  readonly publicRoutes: string | null;
  readonly publicSegment: string | null;
  readonly pkg: string;
  /** The package's permission fragment (its keys and each key's default roles), for the role pass. */
  readonly permissions: string;
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
  return suites;
}

/** The entities each feature's route tables name (contract 3.1), in planting order. */
export const FEATURE_ENTITIES: Readonly<Record<string, readonly string[]>> = {
  scheduling: ["resource", "time-off", "visit", "visit-token"],
  estimator: ["product", "supply", "attachment", "option", "option-value", "estimate", "line", "photo", "key", "quote-token"],
  invoicing: ["invoice", "item", "payment", "invoice-token"],
  comms: ["template-key"],
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
  const drizzle = [
    ...(scheduling || estimator || invoicing ? ["and", "eq"] : []),
    ...(scheduling ? ["isNotNull"] : []),
  ];
  const imports = [
    ...(drizzle.length > 0 ? [`import { ${drizzle.join(", ")} } from "drizzle-orm";`] : []),
    ...(comms ? [`import { enqueueMessage, sendNow, upsertTemplate } from "${scope}/comms";`] : []),
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
      ? [`import { createInvoice, invoiceItems, recordPayment, setInvoiceStatus } from "${scope}/invoicing";`]
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

  return `${imports.join("\n")}

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
}

/** Any drizzle handle on this project's schema (the PGlite one in the tests). */
export type CompanyRowsDb = typeof db;

/**
 * \`label\` is lowercase and distinct per ${noun} ("alpha", "bravo"): every name,
 * address and key planted carries it, so one ${noun}'s strings can never be
 * another's by coincidence.
 */
export async function plantCompanyRows(database: CompanyRowsDb, tenantId: string, label: string): Promise<PlantedRows> {
  const Label = label.charAt(0).toUpperCase() + label.slice(1);
  const rows: Record<string, string> = {};
  const customer = { name: \`\${Label} Customer\`, email: \`customer@\${label}.test\` };
  const strings: string[] = [customer.name, customer.email];
${blocks.join("")}
  strings.push(...Object.values(rows));
  return { rows, strings };
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

export function renderFeatureIsolationTest(answers: Answers): string {
  const scope = answers.scope;
  const suites = suitesFor(answers);
  const noun = tenantLabel(answers).toLowerCase();

  // The estimator's embed is the one public entry that names its company by a
  // KEY rather than a path, so it gets its own pass (below) with its header.
  const embed = answers.includeEstimator;
  // Scheduling's Crew role is one of the company's roles in this project: the
  // role pass checks it too.
  const crew = answers.includeScheduling;
  const routeImports = suites.map(
    (s) =>
      `import { ${[s.adminRoutes, ...(s.publicRoutes ? [s.publicRoutes] : []), s.permissions, ...(embed && s.feature === "estimator" ? ["ESTIMATOR_KEY_HEADER"] : [])].sort().join(", ")} } from "${scope}/${s.pkg}";`,
  );
  const glueImports = suites.map(
    (s) =>
      `import { ${[s.adminBuilder, ...(s.publicBuilder ? [s.publicBuilder] : []), ...(embed && s.feature === "estimator" ? ["buildEstimatorEmbedHandlers"] : [])].join(", ")} } from "${s.glue}";`,
  );
  const suiteRows = suites
    .map((s) => {
      const pub = s.publicBuilder
        ? `public: ${s.publicBuilder},
    publicRoutes: ${s.publicRoutes},
    publicBase: (slug: string) => \`/api/t/\${slug}/${s.publicSegment}/\`,`
        : `public: null,
    publicRoutes: [],
    publicBase: (_slug: string) => "",`;
      return `  {
    feature: "${s.feature}",
    permissions: ${s.permissions},
    admin: ${s.adminBuilder},
    adminRoutes: ${s.adminRoutes},
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
    );
  }
  if (answers.includeComms) {
    snapshot.push(
      `    comms_templates: await all(sql\`select * from comms_templates where tenant_id = \${a} order by id\`),`,
      `    comms_messages: await all(sql\`select * from comms_messages where tenant_id = \${a} order by id\`),`,
      `    comms_scheduled: await all(sql\`select * from comms_scheduled where tenant_id = \${a} order by id\`),`,
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
${answers.includeEstimator ? ESTIMATOR_PHOTO_STORE_MOCK : ""}
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
    embed
      ? `
  /** B's plaintext website key: the estimator embed's only way to name a ${noun}. */
  bKey: string;
  /** A's plaintext website key: used under B's web address, it must find nothing. */
  aKey: string;`
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
  return fx.aStrings.filter((s) => s.length > 0 && text.includes(s));
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
  await ensureCompanySetup(fx.bId);
  const a = await plantCompanyRows(db, fx.aId, "alpha");
  const b = await plantCompanyRows(db, fx.bId, "bravo");
  fx.aRows = { ...a.rows };
  fx.bRows = { ...b.rows };${
    embed
      ? `
  const bKey = b.rows["embed-key"];
  if (!bKey) throw new Error("company B has no website key to call the estimator embed with");
  fx.bKey = bKey;
  const aKey = a.rows["embed-key"];
  if (!aKey) throw new Error("company A has no website key");
  fx.aKey = aKey;`
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
    ...a.strings,
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
    // Every route kind of every table was driven: none skipped.
    const expected = [
      ...SUITES.flatMap((suite) => [
        ...suite.adminRoutes.map((route) => \`admin:\${suite.feature}:\${route.kind}\`),
        ...suite.publicRoutes.map((route) => \`public:\${suite.feature}:\${route.kind}\`),
      ]),${embed ? `
      ...ESTIMATOR_PUBLIC_ROUTES.map((route) => \`embed:estimator:\${route.kind}\`),` : ""}
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
    expect(mixed, "no route mixes two rows, so the mixed pass checked nothing").toBeGreaterThan(0);${embed ? `

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
    ...(scheduling ? [`import { onSchedulingEvent } from "@/server/scheduling-notify";`] : []),
    `import { tenancy } from "@/server/tenancy";`,
  ];
  const schedulingTest = scheduling
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
 *     under${scheduling ? ";\n *   - office notices go to the " + noun + "'s own inbox, never to the platform\n *     owner (BOOTSTRAP_ADMIN_EMAIL)" : ""}.
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
  });${schedulingTest}
});
`;
}
