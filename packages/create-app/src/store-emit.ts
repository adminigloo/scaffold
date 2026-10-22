/**
 * GETTING PAID, PART 2 (create-app 0.34): each business sells its own
 * products online, through @adminigloo/commerce's store (`/store`, the
 * server half; `/widget`, the screens).
 *
 *   companies   each company's products and orders at /app/store, its store
 *               at /t/{web address}/store with the cart, and the thank-you
 *               page; paid on the company's own connected Stripe account
 *               (direct charges, PLATFORM_FEE_BPS), recorded by the Connect
 *               webhook (src/server/payments-webhook.ts) for the company that
 *               owns the account.
 *   one business  /admin/store and /store, on the business's own Stripe keys,
 *               recorded by its own payments webhook.
 *
 * Emitted variants: every file below is one mode's or the other's, never an
 * `if` about the answers. Only with --store.
 */

import { tenantLabel, type Answers } from "./answers.js";
import { plansEnforced } from "./plans-emit.js";
import { companiesMode } from "./tenancy-emit.js";

/** "Products" is sold by plan only where plans are enforced and the store exists. */
export function storeProductsQuota(answers: Answers): boolean {
  return plansEnforced(answers) && answers.includeStore;
}

/** Every file the store writes, by path (POSIX separators; emit.ts joins them). */
export function storeFiles(answers: Answers): ReadonlyArray<readonly [string, string]> {
  if (!answers.includeStore) return [];
  const companies = companiesMode(answers);
  const files: Array<readonly [string, string]> = [["src/server/store.ts", companies ? renderCompanyStoreGlue(answers) : renderSingleStoreGlue(answers)]];
  if (companies) {
    files.push(
      ["app/api/app/[tenantId]/store/[...path]/route.ts", adminRoute(answers)],
      ["app/api/t/[slug]/store/[...path]/route.ts", publicRoute(answers)],
      ["app/(site)/app/store/page.tsx", renderCompanyStorePage(answers)],
      ["app/(company)/t/[slug]/store/page.tsx", renderCompanyStorefrontPage(answers)],
      ["app/(company)/t/[slug]/store/thanks/[checkout]/page.tsx", renderCompanyThanksPage(answers)],
    );
  } else {
    files.push(
      ["app/api/admin/store/[...path]/route.ts", adminRoute(answers)],
      ["app/api/store/[...path]/route.ts", publicRoute(answers)],
      ["app/admin/store/page.tsx", renderAdminStorePage(answers)],
      ["app/(site)/store/page.tsx", renderSingleStorefrontPage(answers)],
      ["app/(site)/store/thanks/[checkout]/page.tsx", renderSingleThanksPage(answers)],
    );
  }
  return files;
}

// ---------------------------------------------------------------------------
// src/server/store.ts
// ---------------------------------------------------------------------------

const RATE_LIMITS = `/**
 * How often one visitor may use the store's API, on the shared limiter, by
 * the caller's address as the nearest proxy saw it:
 *
 *   read      120 a minute   the store page, the thank-you page
 *   checkout   20 an hour    "Check out" presses (the package itself allows
 *                            each visitor 3 open pages and 5 opened an hour)
 */
const STORE_RATE_LIMITS = {
  read: { limit: 120, windowMs: 60_000 },
  checkout: { limit: 20, windowMs: 60 * 60_000 },
} as const;

/**
 * The caller (\`storeVisitorKey\`: the nearest proxy's address, an IPv6 /64).
 * A request with none — a laptop, a proxy that forwards nothing — shares ONE
 * "unknown" caller with every other such request: a shared budget, never no
 * limit.
 */
async function storeRateLimit(req: Request, bucket: "read" | "checkout"): Promise<boolean> {
  const caller = storeVisitorKey(req) ?? "unknown";
  return (await limiter.limit({ key: \`store:\${bucket}:\${caller}\`, policy: STORE_RATE_LIMITS[bucket] })).allowed;
}

/** Photo uploads: 30 an hour per business (each one is a file in its storage). */
const STORE_PHOTO_POLICY = { limit: 30, windowMs: 60 * 60_000 } as const;

async function storePhotoRateLimit(tenantId: string): Promise<boolean> {
  return (await limiter.limit({ key: \`store-photo:\${tenantId}\`, policy: STORE_PHOTO_POLICY })).allowed;
}

/** This deployment's address, without a trailing slash (links in emails). */
function appUrl(): string {
  return (env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\\/+$/, "");
}

/** An error the handlers didn't expect: a fixed sentence for the caller, the error in /admin/errors. */
function reportStoreError(error: unknown, context: { tenantId: string | null; route: string }): void {
  void reportError({ error, source: "route", tenantId: context.tenantId, context: { feature: "store", route: context.route } });
}`;

function mailBlock(answers: Answers, companies: boolean): string {
  const noun = tenantLabel(answers).toLowerCase();
  if (!answers.includeEmail) {
    return `
/**
 * NO EMAIL SENDER: ${answers.projectName} was generated without the email
 * package, so no receipt or "new order" email is sent — the order is on the
 * orders screen, and Stripe sends the customer its own receipt when receipts
 * are on in the Stripe dashboard. \`create-app add email\` wires Resend in.
 */
async function sendOrderEmails(_order: StoreOrderPlaced, _owed: StoreEmailsOwed): Promise<StoreEmailsOwed> {
  // Nothing to send: both are done.
  return { receipt: true, notice: true };
}

async function emailOwnerAbout(_alert: StoreAlert): Promise<void> {}
`;
  }
  return `
/**
 * EMAIL THROUGH the email package (Resend). With no RESEND_API_KEY every send
 * is "skipped" (logged), never an error.${companies ? ` No site-wide Reply-To: each
 * message names its own — the ${noun} owner's verified sign-in address.` : ""}
 */
const mailer = createEmailSender({
  apiKey: env.RESEND_API_KEY,
  from: env.EMAIL_FROM ?? "store@example.invalid",${companies ? "" : `
  replyTo: env.EMAIL_REPLY_TO,`}
});

${companies ? `/** A trial company's store receipts a day (booking's rule: anyone can start a trial). */
const TRIAL_EMAIL_POLICY = { limit: 20, windowMs: 24 * 60 * 60_000 } as const;

` : ""}/** Did it go (or was it deliberately skipped)? Only a failure is retried. */
async function deliver(tenantId: string, fromName: string, mail: StoreEmail, template: string): Promise<boolean> {${companies ? `
  if (template === "store:order_receipt" && (await companyOnTrial(tenantId))) {
    // A trial company sends at most 20 receipts a day (booking's rule): anyone can start a trial.
    const verdict = await failClosedLimiter.limit({ key: \`store-mail:\${tenantId}\`, policy: TRIAL_EMAIL_POLICY });
    if (!verdict.allowed) {
      log.warn({ tenantId, template }, "store: a trial company reached its 20 receipts today; this one isn't sent (Stripe's own receipt still goes when it's on)");
      return true;
    }
  }` : ""}
  const outcome = await mailer.send({ to: mail.to, subject: mail.subject, text: mail.text, template, tenantId, fromName, replyTo: mail.replyTo });
  try {
    await db.insert(emailEvents).values(outcome.log);
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error), template }, "store: an email's delivery couldn't be recorded");
  }
  if (outcome.status === "failed") reportStoreError(outcome.error, { tenantId, route: "email" });
  return outcome.status !== "failed";
}
${
  companies
    ? `
/** Where a customer's replies go, and the owner's notices: the ${noun} OWNER'S verified sign-in address. */
async function ownerAddress(tenantId: string): Promise<string | null> {
  const people = await tenancy.listMemberPeople(tenantId);
  return people.find((person) => person.roleKey === "owner")?.email ?? null;
}

/** The receipt to the customer and "new order" to the owner, From "{${noun}} via {this site}". */
async function sendOrderEmails(order: StoreOrderPlaced, owed: StoreEmailsOwed): Promise<StoreEmailsOwed> {
  const profile = await tenancy.companyProfile(order.tenantId);
  if (!profile) return { receipt: true, notice: true };
  const owner = await ownerAddress(order.tenantId);
  const mail = storeOrderEmails(order, {
    businessName: profile.name,
    appName: SITE_NAME,
    replyTo: owner,
    ownerEmail: owner,
    ordersUrl: companyLinksFor(profile.slug).app("/app/store"),
  });
  // Each only while owed: a retry never sends one twice.
  const receipt = !owed.receipt || !mail.customer ? true : await deliver(order.tenantId, mail.fromName, mail.customer, "store:order_receipt");
  const notice = !owed.notice || !mail.owner ? true : await deliver(order.tenantId, mail.fromName, mail.owner, "store:order_notice");
  return { receipt, notice };
}

/** A store payment that needs the owner: an email to them, with the payment's page in Stripe. */
async function emailOwnerAbout(alert: StoreAlert): Promise<void> {
  const owner = await ownerAddress(alert.tenantId);
  const profile = await tenancy.companyProfile(alert.tenantId);
  if (!owner || !profile) return;
  const text = [alert.message, "", ...(alert.stripeUrl ? [\`Open it in Stripe: \${alert.stripeUrl}\`, ""] : []), \`See what needs your attention: \${companyLinksFor(profile.slug).app("/app/payments")}\`].join("\\n");
  void await deliver(alert.tenantId, \`\${profile.name} via \${SITE_NAME}\`.slice(0, 64), { to: owner, subject: "A store payment needs your attention", text, replyTo: null }, \`store:\${alert.kind}\`);
}
`
    : `
/** The receipt to the customer and "new order" to the business (EMAIL_REPLY_TO, else EMAIL_FROM). */
async function sendOrderEmails(order: StoreOrderPlaced, owed: StoreEmailsOwed): Promise<StoreEmailsOwed> {
  const office = env.EMAIL_REPLY_TO ?? null;
  const mail = storeOrderEmails(order, { businessName: SITE_NAME, replyTo: office, ownerEmail: office, ordersUrl: \`\${appUrl()}/admin/store\` });
  // Each only while owed: a retry never sends one twice.
  const receipt = !owed.receipt || !mail.customer ? true : await deliver(order.tenantId, mail.fromName, mail.customer, "store:order_receipt");
  const notice = !owed.notice || !mail.owner ? true : await deliver(order.tenantId, mail.fromName, mail.owner, "store:order_notice");
  return { receipt, notice };
}

/** A store payment that needs the business: an email to its office address. */
async function emailOwnerAbout(alert: StoreAlert): Promise<void> {
  const office = env.EMAIL_REPLY_TO;
  if (!office) return;
  const text = [alert.message, "", ...(alert.stripeUrl ? [\`Open it in Stripe: \${alert.stripeUrl}\`, ""] : []), \`See the store: \${appUrl()}/admin/store\`].join("\\n");
  void await deliver(alert.tenantId, SITE_NAME, { to: office, subject: "A store payment needs your attention", text, replyTo: null }, \`store:\${alert.kind}\`);
}
`
}`;
}

function webhookOptions(answers: Answers): string {
  return `
/**
 * What the payments webhook hands the store's rules (src/server/payments-webhook.ts):
 * a new order's emails, and every store payment that needs the owner — kept
 * under "Needs your attention" by the package, logged, reported to
 * /admin/errors, and emailed to the owner.
 */
export function storeEventOptions(tenantId: string): StoreEventOptions {
  return {
    onOrder: ${
      answers.includeCustomers
        ? `async (order, owed) => {
      // The order on its buyer's timeline first (create-app 0.35), then its emails.
      await customerOnStoreOrder(order);
      return sendOrderEmails(order, owed);
    }`
        : "(order, owed) => sendOrderEmails(order, owed)"
    },
    onAlert: async (alert) => {
      log.error({ tenantId: alert.tenantId, kind: alert.kind, orderId: alert.orderId, paymentIntentId: alert.paymentIntentId }, \`store: \${alert.message}\`);
      void reportError({ error: new Error(alert.message), source: "webhook", tenantId: alert.tenantId, context: { feature: "store", kind: alert.kind, paymentIntentId: alert.paymentIntentId } });
      await emailOwnerAbout(alert);
    },
    report: (error) => void reportError({ error, source: "webhook", tenantId, context: { feature: "store" } }),
  };
}
`;
}

function renderCompanyStoreGlue(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  const email = answers.includeEmail;
  const quota = storeProductsQuota(answers);
  const imports = [
    `import {\n  createStoreAdminHandlers,\n  createStorePublicHandlers,${email ? "\n  storeOrderEmails," : ""}\n  storeVisitorKey,\n  type StoreAlert,${email ? "\n  type StoreEmail," : ""}\n  type StoreEmailsOwed,\n  type StoreEventOptions,\n  type StoreOrderPlaced,\n} from "${scope}/commerce/store";`,
    ...(email ? [`import { createEmailSender } from "${scope}/email";`, `import { emailEvents } from "${scope}/email/schema";`] : []),
    `import { db } from "@/db";`,
    `import { env } from "@/env";`,
    ...(email ? [`import { SITE_NAME } from "@/seo";`] : []),
    `import { companyLinks${email ? ", companyLinksFor" : ""} } from "@/server/company-links";`,
    `import { admitPublic, companyAuthorizer, companyRoutes, resolvePublicTenant, type FeatureHandlerOverrides } from "@/server/company-routes";`,
    ...(answers.includeCustomers ? [`import { customerOnStoreOrder } from "@/server/customer-activity";`] : []),
    `import { reportError } from "@/server/error-reporter";`,
    ...(answers.includeStorage ? [`import { storePhotoStore } from "@/server/files";`] : []),
    `import { log } from "@/server/logger";`,
    `import { storeCardPayments } from "@/server/payments";`,
    ...(quota || email ? [`import { ${[...(email ? ["companyOnTrial"] : []), ...(quota ? ["storeProductLimit"] : [])].join(", ")} } from "@/server/plan-gate";`] : []),
    `import { ${email ? "failClosedLimiter, " : ""}limiter } from "@/server/rate-limit";`,
    `import { tenancy } from "@/server/tenancy";`,
  ];
  return `${imports.join("\n")}

/**
 * A ${noun.toUpperCase()}'S OWN STORE (getting paid, part 2): its products and
 * orders at /app/store, its store at /t/{web address}/store, paid on its own
 * Stripe account (src/server/payments.ts). Every price is read from the
 * ${noun}'s product rows when "Check out" is pressed; stock is held for the
 * hour the page is open; the order is written by the Connect webhook, only
 * for the ${noun} that owns the account, in exactly the amount asked.
 */

${RATE_LIMITS}
${mailBlock(answers, true)}${webhookOptions(answers)}
/** The ${noun}'s currency for new products: its Stripe account's country decides payouts; prices start in dollars. */
const DEFAULT_CURRENCY = "usd";

/**
 * The ${noun}'s store screen (/app/store over /api/app/{${noun} id}/store):
 * store.view to look, store.manage to change products and mark orders sent.
 * Another ${noun}'s product, order or alert is "not found". \`overrides\` is
 * how the project's isolation proof calls it as somebody else.
 */
export function buildStoreAdminHandlers(overrides: FeatureHandlerOverrides = {}) {
  return createStoreAdminHandlers({
    db,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer(overrides),
    payments: storeCardPayments,${answers.includeStorage ? `
    // Product photos: the company's own files (public, counted in its storage allowance), 30 an hour.
    photoStore: storePhotoStore,
    photoRateLimit: storePhotoRateLimit,` : ""}${quota ? `
    // Its plan's number of products (src/plans.ts); none when the plan doesn't say.
    productLimit: (tenantId) => storeProductLimit(tenantId),` : ""}
    currency: () => DEFAULT_CURRENCY,
    notTakingOrders: "Customers can see your store but can't pay yet: connect Stripe at Card payments.",
    // A sale staff record by hand (commerce 0.4): the same order hook as the
    // webhook's orders — the buyer's timeline, and the receipt when asked.
    onOrder: (order, owed) => storeEventOptions(order.tenantId).onOrder?.(order, owed),
    onError: reportStoreError,
  });
}

/**
 * A ${noun}'s store page API (/t/{web address}/store over
 * /api/t/{web address}/store): the ${noun} whose web address is in the path.
 * A suspended ${noun}, or one whose plan ended, takes no new order (it says
 * so by name). Another ${noun}'s product or checkout is "not found".
 */
export function buildStorePublicHandlers() {
  return createStorePublicHandlers({
    db,
    resolveTenant: resolvePublicTenant,
    admit: admitPublic,
    payments: storeCardPayments,
    business: async (tenantId) => {
      const profile = await tenancy.companyProfile(tenantId);
      return profile ? { name: profile.name, logoUrl: profile.logoUrl } : null;
    },
    thanksUrl: async (checkoutId, tenantId) => \`\${(await companyLinks(tenantId)).home}/store/thanks/\${encodeURIComponent(checkoutId)}\`,
    storeUrl: async (tenantId) => \`\${(await companyLinks(tenantId)).home}/store\`,
    rateLimit: storeRateLimit,
    onError: reportStoreError,
  });
}
`;
}

function renderSingleStoreGlue(answers: Answers): string {
  const scope = answers.scope;
  const email = answers.includeEmail;
  const imports = [
    `import { storePermissions, type StorePermission } from "${scope}/commerce";`,
    `import {\n  createStoreAdminHandlers,\n  createStorePublicHandlers,${email ? "\n  storeOrderEmails," : ""}\n  storeVisitorKey,\n  type StoreAlert,${email ? "\n  type StoreEmail," : ""}\n  type StoreEmailsOwed,\n  type StoreEventOptions,\n  type StoreOrderPlaced,\n} from "${scope}/commerce/store";`,
    ...(email ? [`import { createEmailSender } from "${scope}/email";`, `import { emailEvents } from "${scope}/email/schema";`] : []),
    `import { db } from "@/db";`,
    `import { env } from "@/env";`,
    `import { SITE_NAME } from "@/seo";`,
    ...(answers.includeCustomers ? [`import { customerOnStoreOrder } from "@/server/customer-activity";`] : []),
    `import { reportError } from "@/server/error-reporter";`,
    ...(answers.includeStorage ? [`import { storePhotoStore } from "@/server/files";`] : []),
    `import { log } from "@/server/logger";`,
    `import { storeCardPayments } from "@/server/payments";`,
    `import { limiter } from "@/server/rate-limit";`,
    `import { authorizeStaffFor } from "@/server/staff-access";`,
  ];
  return `${imports.join("\n")}

/**
 * THE BUSINESS'S OWN STORE (getting paid, part 2): its products and orders at
 * /admin/store, its store at /store, paid on its OWN Stripe account
 * (STRIPE_SECRET_KEY, no Connect, no fee) and recorded by its payments
 * webhook. Every price is read from the product rows when "Check out" is
 * pressed; stock is held for the hour the page is open.
 */

/** The one business's store: every product, checkout and order row of the store is written for it. */
export const STORE_TENANT = "primary";

/** The staff keys the store is asked against: the package's own two (see src/permissions). */
const STORE_STAFF_KEYS: Readonly<Record<StorePermission, string>> = Object.fromEntries(
  Object.keys(storePermissions).map((key) => [key, key]),
) as Record<StorePermission, string>;

${RATE_LIMITS}
${mailBlock(answers, false)}${webhookOptions(answers)}
/** The store, for this business's staff (/admin/store over /api/admin/store). */
export function buildStoreAdminHandlers() {
  return createStoreAdminHandlers({
    db,
    tenantId: STORE_TENANT,
    authorize: authorizeStaffFor(STORE_STAFF_KEYS, "Sign in to see the store."),
    payments: storeCardPayments,${answers.includeStorage ? `
    photoStore: storePhotoStore,
    photoRateLimit: storePhotoRateLimit,` : ""}
    currency: () => "usd",
    notTakingOrders: "Customers can see your store but can't pay yet: set STRIPE_SECRET_KEY and the payments webhook's secret (see DEPLOYMENT.md, Taking card payments).",
    // A sale staff record by hand (commerce 0.4): the same order hook as the
    // webhook's orders — the buyer's timeline, and the receipt when asked.
    onOrder: (order, owed) => storeEventOptions(order.tenantId).onOrder?.(order, owed),
    onError: reportStoreError,
  });
}

/** The store page API (/store over /api/store). */
export function buildStorePublicHandlers() {
  return createStorePublicHandlers({
    db,
    tenantId: STORE_TENANT,
    payments: storeCardPayments,
    business: () => ({ name: SITE_NAME }),
    thanksUrl: (checkoutId) => \`\${appUrl()}/store/thanks/\${encodeURIComponent(checkoutId)}\`,
    storeUrl: () => \`\${appUrl()}/store\`,
    rateLimit: storeRateLimit,
    onError: reportStoreError,
  });
}
`;
}

// ---------------------------------------------------------------------------
// Routes and pages
// ---------------------------------------------------------------------------

function adminRoute(answers: Answers): string {
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  return `import { buildStoreAdminHandlers } from "@/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ${companies ? `A ${noun}'s store: /app/store calls /api/app/{${noun} id}/store/v1/admin/…` : "The store: /admin/store calls /api/admin/store/v1/admin/…"} —
 * products, orders and what needs attention (STORE_ADMIN_ROUTES). ${companies ? `The ${noun} is
 * the one in the path, asked on every call.` : "On the staff ladder (store.view, store.manage)."} Never cross-origin.
 */
const { handle } = buildStoreAdminHandlers();

export const GET = handle;
export const POST = handle;
`;
}

function publicRoute(answers: Answers): string {
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  return `import { buildStorePublicHandlers } from "@/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ${companies ? `A ${noun}'s store page API: /t/{web address}/store calls /api/t/{web address}/store/v1/…` : "The store page API: /store calls /api/store/v1/…"} —
 * the products, "Check out" (the cart names products and quantities; every
 * price is the server's) and the thank-you page's question. A cross-site POST is refused.
 */
const { handle } = buildStorePublicHandlers();

export const GET = handle;
export const POST = handle;
`;
}

function renderCompanyStorePage(answers: Answers): string {
  const noun = tenantLabel(answers).toLowerCase();
  return `import { StoreAdmin } from "${answers.scope}/commerce/widget";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader, WORK_MAIN, buttonClass } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The ${noun}'s store (getting paid, part 2): its products — name, price,
 * photo, for sale or not, stock — and the orders its customers placed. The
 * package's screen over /api/app/{id}/store, which checks the person's
 * permission on every call (and someone who may only look, without
 * store.manage, isn't offered changes). "See your store" sits in the page
 * header, beside the title, like every work page's actions (polish 3).
 */
export default async function CompanyStorePage() {
  return (
    <CompanyGate path="/app/store" permission="store.view">
      {({ company, can, locale }) => (
        <main className={WORK_MAIN}>
          <PageHeader
            title="Store"
            description="Sell your own products online. Customers pay by card into your own Stripe account, and every order lands here."
            actions={
              <a href={\`\${company.publicPath}/store\`} target="_blank" rel="noopener noreferrer" className={buttonClass("secondary")}>
                See your store ↗<span className="sr-only"> (opens in a new tab)</span>
              </a>
            }
          />
          <StoreAdmin
            baseUrl={\`/api/app/\${company.id}/store\`}
            storefrontUrl={\`\${company.publicPath}/store\`}
            canManage={can.includes("store.manage")}
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

function renderCompanyStorefrontPage(answers: Answers): string {
  const noun = tenantLabel(answers).toLowerCase();
  return `import type { Metadata } from "next";
import { Storefront } from "${answers.scope}/commerce/widget";
import { PublicCompanyGate, publicCompanyMetadata } from "@/components/PublicCompanyGate";

/** The tab title and link preview are the ${noun}'s: "Store · {name}". */
export async function generateMetadata({ params }: { readonly params: Promise<{ readonly slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return publicCompanyMetadata(slug, "Store", { path: "/store" });
}

export const dynamic = "force-dynamic";

/**
 * A ${noun}'s store (getting paid, part 2): its products, a cart kept in the
 * customer's browser, and "Check out" on Stripe's page — paid into the
 * ${noun}'s own Stripe account. A suspended ${noun}, or one whose plan ended,
 * says it isn't taking orders, by name.
 */
export default async function CompanyStorefrontPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  return (
    <PublicCompanyGate slug={slug} path="/store" query={query}>
      {(company) => (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold text-ink">{company.name}&rsquo;s store</h1>
          <Storefront baseUrl={\`/api/t/\${company.slug}/store\`} />
        </section>
      )}
    </PublicCompanyGate>
  );
}
`;
}

function renderCompanyThanksPage(answers: Answers): string {
  const noun = tenantLabel(answers).toLowerCase();
  return `import type { Metadata } from "next";
import { StoreThanks } from "${answers.scope}/commerce/widget";
import { PublicCompanyGate, publicCompanyMetadata } from "@/components/PublicCompanyGate";

/** Never indexed, never handing its address on: the checkout id is in the URL. */
export async function generateMetadata({ params }: { readonly params: Promise<{ readonly slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return publicCompanyMetadata(slug, "Thank you", { noReferrer: true });
}

export const dynamic = "force-dynamic";

/**
 * Where Stripe sends a customer after paying a ${noun}'s store: the order
 * number once the webhook has written it (usually within seconds). Read
 * INSIDE the ${noun} whose web address is in the URL.
 */
export default async function CompanyStoreThanksPage({
  params,
}: {
  readonly params: Promise<{ readonly slug: string; readonly checkout: string }>;
}) {
  const { slug, checkout } = await params;
  return (
    <PublicCompanyGate slug={slug} path={\`/store/thanks/\${encodeURIComponent(checkout)}\`}>
      {(company) => <StoreThanks baseUrl={\`/api/t/\${company.slug}/store\`} checkoutId={checkout} storeHref={\`\${company.publicPath}/store\`} />}
    </PublicCompanyGate>
  );
}
`;
}

function renderAdminStorePage(answers: Answers): string {
  const scope = answers.scope;
  return `import { isDbConfigured } from "${scope}/db";
import { StoreAdmin } from "${scope}/commerce/widget";
import { db } from "@/db";
import { EmptyState, Notice, PageHeader } from "@/components/ui";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";

export const dynamic = "force-dynamic";

/**
 * THE STORE (getting paid, part 2): the products for sale at /store and the
 * orders customers placed. The package's screen over /api/admin/store; the
 * page checks the staff key first so someone without it gets a sentence, and
 * the routes check again on every call.
 */
export default async function StorePage() {
  if (!isDbConfigured(db)) {
    return (
      <>
        <PageHeader title="Store" />
        <EmptyState title="No database yet">
          Products and orders are kept in this site&rsquo;s own database. Set DATABASE_URL and run the migrations.
        </EmptyState>
      </>
    );
  }
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("store.view")) {
    return (
      <>
        <PageHeader title="Store" />
        <Notice tone="warn">You don&rsquo;t have permission to see the store.</Notice>
      </>
    );
  }
  return <StoreAdmin baseUrl="/api/admin/store" storefrontUrl="/store" canManage={can.can("store.manage")} />;
}
`;
}

function renderSingleStorefrontPage(answers: Answers): string {
  return `import type { Metadata } from "next";
import { Storefront } from "${answers.scope}/commerce/widget";
import { metadataFor } from "@/seo";

export const metadata: Metadata = metadataFor({ path: "/store", title: "Store", description: "Buy from us online. You pay on Stripe's secure page." });

export const dynamic = "force-dynamic";

/** The store (getting paid, part 2): the products, the cart, and Check out on Stripe's page. */
export default function StorefrontPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-16">
      <h1 className="mb-6 text-2xl font-semibold">Store</h1>
      <Storefront baseUrl="/api/store" />
    </main>
  );
}
`;
}

function renderSingleThanksPage(answers: Answers): string {
  return `import type { Metadata } from "next";
import { StoreThanks } from "${answers.scope}/commerce/widget";

export const metadata: Metadata = {
  title: "Thank you",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/** Where Stripe sends a customer after paying: the order number once the webhook has written it. */
export default async function StoreThanksPage({ params }: { readonly params: Promise<{ readonly checkout: string }> }) {
  const { checkout } = await params;
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-16">
      <StoreThanks baseUrl="/api/store" checkoutId={checkout} storeHref="/store" />
    </main>
  );
}
`;
}
