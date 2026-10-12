/**
 * Every capability `adminigloo.json` claims, and the emitted file that proves
 * it.
 *
 * A MANIFEST THAT CLAIMS SOMETHING NOTHING PROVIDES IS WORSE THAN NO MANIFEST,
 * because the matrix CI, the component registry and any future `doctor`
 * command will believe it. `ai.streaming` was exactly that: `--ai` contributed
 * `aiServer()` to the environment, `aiPermissions` to the catalog and
 * `ai_usage` to the schema, and not one emitted file called a model. The
 * manifest said the project could stream from an assistant; nothing in the
 * project could.
 *
 * The fix is not vigilance. It is that a capability without a row in this table
 * cannot be claimed at all: `assertCapabilitiesAreProvable` runs at the end of
 * every `planEmit`, over the files that were actually written, and throws
 * before anything reaches disk. Reading the OUTPUT rather than the answers is
 * the load-bearing half — a predicate over `answers` would restate
 * `capabilitiesFor` and pass for ever, which is the same tautology
 * `assertPermissionScopes` exists to avoid.
 *
 * Evidence is deliberately shallow: a path that exists, a binding the file
 * mentions. It is a claim that the mechanism is PRESENT, never that it is
 * correct — correctness is what the generated project's own tests are for. A
 * predicate that tried to prove behaviour would be a second implementation of
 * the feature, and it would rot.
 */

import type { EmitPlan } from "./emit.js";

export interface CapabilityEvidence {
  /** The key as `capabilitiesFor` emits it. */
  readonly capability: string;
  /** What in the emitted project provides it, and why that file is the proof. */
  readonly why: string;
  /** True when the plan contains that evidence. */
  provenBy(plan: EmitPlan): boolean;
}

/** `src/nav.ts` on any platform: the plan's keys use the host separator. */
function file(plan: EmitPlan, ...segments: readonly string[]): string | undefined {
  for (const [path, contents] of plan.files) {
    const parts = path.split(/[\\/]/);
    if (
      parts.length === segments.length &&
      parts.every((part, i) => part === segments[i])
    ) {
      return contents;
    }
  }
  return undefined;
}

/** The named file exists and contains every fragment. */
function mentions(
  plan: EmitPlan,
  path: readonly string[],
  ...fragments: readonly string[]
): boolean {
  const source = file(plan, ...path);
  if (source === undefined) return false;
  return fragments.every((fragment) => source.includes(fragment));
}

/** The named file was emitted at all. */
function exists(plan: EmitPlan, ...path: readonly string[]): boolean {
  return file(plan, ...path) !== undefined;
}

export const CAPABILITY_EVIDENCE: readonly CapabilityEvidence[] = [
  {
    capability: "auth.clerk",
    why:
      "The proxy hydrates a Clerk session and `currentPrincipal` mirrors the " +
      "Clerk user into the local users table. Both, because either alone is " +
      "a project that half-authenticates.",
    provenBy: (plan) =>
      mentions(plan, ["proxy.ts"], "clerkMiddleware") &&
      mentions(plan, ["src", "server", "auth.ts"], "@clerk/nextjs/server"),
  },
  {
    capability: "permissions.two-layer",
    why:
      "One `definePermissions` call per scope in the generated catalog. The " +
      "two layers ARE the two calls: a project with one is not this shape.",
    provenBy: (plan) =>
      mentions(
        plan,
        ["src", "permissions", "catalog.ts"],
        'definePermissions(\n  "staff"',
        'definePermissions(\n  "tenant"',
      ),
  },
  {
    capability: "trpc.procedure-ladder",
    why:
      "`createProcedures` builds the rungs. An app that spelled its own " +
      "middleware out would not call it, and the scope audit could not see it.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "trpc.ts"], "createProcedures("),
  },
  {
    capability: "tenancy.invitations",
    why:
      "The router exists AND `_app.ts` mounts it. A router nothing mounts is " +
      "a file, not a capability — which is how this whole class of lie starts.",
    provenBy: (plan) =>
      exists(plan, "src", "server", "routers", "invitations.ts") &&
      mentions(
        plan,
        ["src", "server", "routers", "_app.ts"],
        "invitations: invitationsRouter",
      ),
  },
  {
    capability: "tenancy.personal-workspace",
    why:
      "`currentPrincipal` mints a personal workspace for every mirrored user. " +
      "See UNDISTINGUISHED_CAPABILITIES: this evidence cannot separate the " +
      "personal-workspace shape from the organisations one.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "auth.ts"], "personalWorkspaceId("),
  },
  {
    capability: "tenancy.organizations",
    why:
      "The same tenancy machinery, with a customer-visible noun on it. See " +
      "UNDISTINGUISHED_CAPABILITIES.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "auth.ts"], "personalWorkspaceId("),
  },
  {
    capability: "observability.audit-log",
    why:
      "`defineAuditedActions` is the only way to name an action in this " +
      "scaffold, so the generated registry is where the vocabulary exists.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "audit.ts"], "defineAuditedActions("),
  },
  {
    capability: "observability.error-log",
    why:
      "The reporter is constructed AND the browser has somewhere to post to. " +
      "Without the route, every error caught by a client boundary is lost, " +
      "and those are the ones a real person actually saw.",
    provenBy: (plan) =>
      mentions(
        plan,
        ["src", "server", "error-reporter.ts"],
        "createErrorReporter(",
      ) && exists(plan, "app", "api", "error-report", "route.ts"),
  },
  {
    capability: "observability.rate-limit",
    why:
      "A limiter that is CONSTRUCTED and INSTALLED. The second half is the " +
      "one that was missing: `createRateLimiter`, `RATE_LIMIT_POLICIES` and " +
      "the ladder's `rateLimit` option all existed, and `createProcedures` " +
      "was called with two arguments, so no procedure in any generated " +
      "project was measured against any budget.",
    provenBy: (plan) =>
      mentions(
        plan,
        ["src", "server", "rate-limit.ts"],
        "createRateLimiter(",
      ) && mentions(plan, ["src", "server", "trpc.ts"], "rateLimit: { limiter }"),
  },
  {
    capability: "seo.metadata",
    why:
      "A metadataBase for relative Open Graph URLs to resolve against, and a " +
      "/robots.txt that refuses everything outside production. BOTH, because " +
      "either alone is a project with one of the two invisible failures still " +
      "open: a shared link that renders as a grey box, or a preview " +
      "deployment competing with the client's own site for their brand terms.",
    provenBy: (plan) =>
      mentions(plan, ["src", "seo.ts"], "metadataBase", "INDEXABLE") &&
      mentions(plan, ["app", "robots.ts"], "INDEXABLE"),
  },
  {
    capability: "marketing.landing",
    why:
      "A section component from the marketing overlay. NOT `app/(site)/page.tsx`, " +
      "which every project emits — that path holds the developer's orientation " +
      "page in a project with no marketing site, so it would prove this " +
      "capability everywhere and therefore nowhere.",
    provenBy: (plan) =>
      exists(plan, "src", "components", "marketing", "Hero.tsx"),
  },
  {
    capability: "marketing.pricing",
    why:
      "The public pricing page, which needs both a marketing site and a plan " +
      "record to read.",
    provenBy: (plan) => exists(plan, "app", "(site)", "pricing", "page.tsx"),
  },
  {
    capability: "legal.policies",
    why:
      "The privacy policy AND the generated record behind it. The page alone " +
      "would be prose; what makes the claim worth anything is that the " +
      "subprocessor list is derived from the packages this project installed, " +
      "which is the paragraph every copied legal template gets wrong.",
    provenBy: (plan) =>
      exists(plan, "app", "(site)", "privacy", "page.tsx") &&
      mentions(plan, ["src", "legal.ts"], "SUBPROCESSORS"),
  },
  {
    capability: "admin.shell",
    why: "The panel's index page, from the admin-minimal overlay.",
    provenBy: (plan) => exists(plan, "app", "admin", "page.tsx"),
  },
  {
    capability: "admin.support-tools",
    why: "The customer-lookup page, which only admin-full copies in.",
    provenBy: (plan) => exists(plan, "app", "admin", "support", "page.tsx"),
  },
  {
    capability: "admin.product-builder",
    why: "The product list, from catalog-admin — an admin surface for a shop.",
    provenBy: (plan) => exists(plan, "app", "admin", "products", "page.tsx"),
  },
  {
    capability: "payments.stripe",
    why:
      "The webhook route. Money arriving is the only event that matters here, " +
      "and this is the file that hears about it.",
    provenBy: (plan) =>
      exists(plan, "app", "api", "webhooks", "stripe", "route.ts"),
  },
  {
    capability: "catalog.products",
    why: "The staff-scoped router that authors what is for sale.",
    provenBy: (plan) => exists(plan, "src", "server", "routers", "catalog.ts"),
  },
  {
    capability: "storefront",
    why: "A public page that lists what is for sale.",
    provenBy: (plan) => exists(plan, "app", "(site)", "products", "page.tsx"),
  },
  {
    capability: "commerce.orders",
    why:
      "`fulfilPurchase` writes the order row. One canonical writer, shared by " +
      "the webhook and the simulate button.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "fulfilment.ts"], "orders"),
  },
  {
    capability: "commerce.customer-account",
    why:
      "The signed-in overview a buyer lands on, from the account overlay. THE " +
      "READ HALF OF `commerce.orders`, which claimed only the write: every " +
      "order, licence key and entitlement `fulfilPurchase` produced was " +
      "reachable from one page keyed on a reference in a URL the buyer was " +
      "about to navigate away from, and the manifest said the project had " +
      "orders.",
    provenBy: (plan) => exists(plan, "app", "(site)", "account", "page.tsx"),
  },
  {
    capability: "billing.entitlements",
    why: "The same function grants the entitlement that the order paid for.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "fulfilment.ts"], "entitlement"),
  },
  {
    capability: "commerce.one-time-checkout",
    why:
      "The checkout router creates the payment intent. See " +
      "UNDISTINGUISHED_CAPABILITIES: the emitted project is identical across " +
      "the three money-taking models.",
    provenBy: (plan) => exists(plan, "src", "server", "routers", "checkout.ts"),
  },
  {
    capability: "billing.subscriptions",
    why:
      "The same checkout router and the same fulfilment path. See " +
      "UNDISTINGUISHED_CAPABILITIES.",
    provenBy: (plan) => exists(plan, "src", "server", "routers", "checkout.ts"),
  },
  {
    capability: "email.transactional",
    why:
      "A sender that is constructed AND a template for it to send. With no " +
      "key the send is recorded as skipped, which is still transactional mail " +
      "— the absent thing would be the module, not the credential.",
    provenBy: (plan) =>
      mentions(
        plan,
        ["src", "server", "invitation-mail.ts"],
        "createEmailSender(",
      ) && exists(plan, "src", "emails", "invitation.ts"),
  },
  {
    capability: "feedback.intake",
    why:
      "The key-authenticated API route AND the widget mount that feeds it. " +
      "Both, because either alone is half a capability: handlers nobody can " +
      "reach from a page, or a button posting into a 404.",
    provenBy: (plan) =>
      mentions(
        plan,
        ["app", "api", "igloo", "[...path]", "route.ts"],
        "createFeedbackHandlers(",
      ) && exists(plan, "src", "components", "FeedbackWidget.tsx"),
  },
  {
    capability: "feedback.triage",
    why:
      "The staff queue page, from the feedback-admin overlay — copied only " +
      "when the project has both the feedback answer and an admin shell to " +
      "render it in, the same two-condition shape as the product builder.",
    provenBy: (plan) => exists(plan, "app", "admin", "feedback", "page.tsx"),
  },
  {
    capability: "seo.audits",
    why:
      "The staff router whose mutation actually crawls the deployment and " +
      "stores the report — audits can run over tRPC (or a cron) whether or " +
      "not a shell renders them.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "routers", "seo.ts"], "runSeoReport("),
  },
  {
    capability: "seo.reports",
    why:
      "The report page under the shell, from the seo-admin overlay — the " +
      "same two-condition shape as feedback.triage.",
    provenBy: (plan) => exists(plan, "app", "admin", "seo", "page.tsx"),
  },
  {
    capability: "notifications.fanout",
    why:
      "The notify helper that fans out at write time AND the recipient-scoped " +
      "router that reads it back. The inbox PAGE is the other key; a project " +
      "without a shell can still write and read rows over tRPC.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "notify.ts"], "notify(") &&
      exists(plan, "src", "server", "routers", "notifications.ts"),
  },
  {
    capability: "notifications.inbox",
    why: "The inbox page under the shell, from the notifications-admin overlay.",
    provenBy: (plan) => exists(plan, "app", "admin", "inbox", "page.tsx"),
  },
  {
    capability: "storage.files",
    why:
      "The upload route handler AND the adapter that owns the vendor choice. " +
      "Files can arrive over HTTP whether or not a shell lists them — the " +
      "library page is the other key.",
    provenBy: (plan) =>
      mentions(plan, ["app", "api", "files", "route.ts"], "storeFile(") &&
      exists(plan, "src", "server", "blob-store.ts"),
  },
  {
    capability: "storage.library",
    why: "The staff library page under the shell, from the storage-admin overlay.",
    provenBy: (plan) => exists(plan, "app", "admin", "files", "page.tsx"),
  },
  {
    capability: "assistant.brain",
    why:
      "The router whose procedures publish and version the personality, over " +
      "tRPC whether or not a shell renders an editor. The editor page is the " +
      "other key.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "routers", "assistant.ts"], "publishSection"),
  },
  {
    capability: "assistant.editor",
    why: "The staff personality editor under the shell, from the assistant-admin overlay.",
    provenBy: (plan) => exists(plan, "app", "admin", "assistant", "page.tsx"),
  },
  {
    capability: "ai.streaming",
    why:
      "A route that opens a stream through `createStreamRoute`. THE CLAIM " +
      "THIS TABLE WAS BUILT FOR: for several releases `--ai` emitted an env " +
      "fragment, a permission fragment and a table, and nothing that called a " +
      "model, while adminigloo.json said the project could stream.",
    provenBy: (plan) =>
      mentions(
        plan,
        ["app", "api", "ai", "chat", "route.ts"],
        "createStreamRoute(",
      ),
  },

  // FIELD SERVICE. Each server half proven by a load-bearing call in the file
  // that does the work; each admin half by the staff page under the shell.
  {
    capability: "estimator.pricing",
    why:
      "The instant estimate: the PUBLIC route mounting the package's handler " +
      "(createEstimatorHandlers — prices from the business's price book, the " +
      "questions each product asks, never a cost) and /estimate rendering " +
      "<EstimateTool> against it. Proven by the handler factory being called " +
      "there and the staff factory being called nowhere in that file: a " +
      "public route mounting the staff handler would put the price book's " +
      "costs on the open internet.",
    provenBy: (plan) =>
      mentions(plan, ["app", "api", "estimator", "[...path]", "route.ts"], "createEstimatorHandlers(") &&
      !mentions(plan, ["app", "api", "estimator", "[...path]", "route.ts"], "createEstimatorAdminHandlers(") &&
      mentions(plan, ["app", "(site)", "estimate", "page.tsx"], "<EstimateTool"),
  },
  {
    capability: "estimator.embed",
    why:
      "The estimate on the business's OTHER website: the same public handler " +
      "answers a request carrying an embed key (checked against the key's " +
      "allowed websites, with CORS for that page), and the 0.2 embed address " +
      "/api/estimator/embed re-exports it so a widget already pasted keeps " +
      "working.",
    provenBy: (plan) =>
      mentions(plan, ["app", "api", "estimator", "[...path]", "route.ts"], "createEstimatorHandlers(") &&
      mentions(plan, ["app", "api", "estimator", "embed", "[...path]", "route.ts"], 'from "../../[...path]/route"'),
  },
  {
    capability: "estimator.quotes",
    why:
      "A quote the customer accepts or declines online: the staff route " +
      "mounting createEstimatorAdminHandlers (where staff edit the estimate " +
      "and send the quote) with the quote link it emails, and /quote/[token] " +
      "rendering <QuoteView>.",
    provenBy: (plan) =>
      mentions(plan, ["app", "api", "admin", "estimator", "[...path]", "route.ts"], "createEstimatorAdminHandlers(", "quoteUrl:") &&
      mentions(plan, ["app", "(site)", "quote", "[token]", "page.tsx"], "<QuoteView"),
  },
  {
    capability: "estimator.builder",
    why:
      "The staff screens under the shell, from estimator-admin: the price book " +
      "(<PriceBook>), the leads and quotes queue (<EstimatesQueue>) and one " +
      "estimate's editor (<EstimateEditor>).",
    provenBy: (plan) =>
      mentions(plan, ["app", "admin", "estimator", "page.tsx"], "<PriceBook") &&
      mentions(plan, ["app", "admin", "estimates", "page.tsx"], "<EstimatesQueue") &&
      mentions(plan, ["app", "admin", "estimates", "[id]", "page.tsx"], "<EstimateEditor"),
  },
  {
    capability: "estimator.photos",
    why:
      "A customer's photo kept with their estimate: the generated services " +
      "module building the photo store over the storage package's storeFile, " +
      "handed to both estimator routes.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "estimator-services.ts"], "storeFile(db, blobStore") &&
      mentions(plan, ["app", "api", "estimator", "[...path]", "route.ts"], "photoStore: estimatorPhotoStore"),
  },
  {
    capability: "estimator.photo-reading",
    why:
      "A photo read by a model — observations only, metered: the generated " +
      "services module building createAnthropicTakeoffRunner and recording " +
      "every call's spend through the app's ai_usage writer.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "estimator-services.ts"], "createAnthropicTakeoffRunner(", "recordAiUsage("),
  },
  {
    capability: "estimator.followups",
    why:
      "The estimate emails and the follow-up on an unanswered quote: the " +
      "estimator comms listener wired as the routes' onEvent, and the comms " +
      "cron consulting it at send time (the hook that drops a follow-up whose " +
      "quote was answered and puts a fresh link in the one it sends).",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "estimator-notify.ts"], "createEstimatorCommsListener(") &&
      mentions(plan, ["src", "server", "comms-hooks.ts"], "estimatorComms") &&
      mentions(plan, ["app", "api", "cron", "comms", "route.ts"], "beforeSend: commsBeforeSend"),
  },
  {
    capability: "estimator.book-visit",
    why:
      "An accepted quote one click from booking the visit: the generated " +
      "services module's bookVisitUrl into scheduling's booking page with the " +
      "estimate, and the visits booked from it read back for the estimate's page.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "estimator-services.ts"], "bookVisitUrl:", "schedulingBookings.estimateId"),
  },
  {
    capability: "estimator.invoicing",
    why:
      "An accepted quote one click from an invoice: the generated services " +
      "module's convertToInvoice — invoicing's own bridge, createInvoice and " +
      "the estimate claimed as converted in one transaction.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "estimator-services.ts"], "invoiceInputFromEstimate(", "markEstimateConverted(tx"),
  },
  {
    capability: "scheduling.booking",
    why:
      "The public booking page and the customer's own visit page — a ready-made " +
      "<VisitPicker> on /book-visit and <ManageVisit> on /visit/[token] — over " +
      "the route that mounts the package's PUBLIC handler. Proven by the " +
      "handler factory being called there and the staff finder and staff " +
      "handler being called nowhere in that file: 0.2's public route returned " +
      "the previous customer's street address from the staff finder, and a " +
      "route that merely mentioned the right names proved nothing.",
    provenBy: (plan) =>
      mentions(plan, ["app", "api", "schedule", "[...path]", "route.ts"], "createSchedulingHandlers(") &&
      !mentions(plan, ["app", "api", "schedule", "[...path]", "route.ts"], "findAvailableSlots(") &&
      !mentions(plan, ["app", "api", "schedule", "[...path]", "route.ts"], "createSchedulingAdminHandlers(") &&
      mentions(plan, ["app", "(site)", "book-visit", "page.tsx"], "<VisitPicker") &&
      mentions(plan, ["app", "(site)", "visit", "[token]", "page.tsx"], "<ManageVisit"),
  },
  {
    capability: "scheduling.calendar",
    why:
      "The staff calendar under the shell — <ScheduleCalendar> on " +
      "/admin/schedule, from scheduling-admin — and Schedule settings beside " +
      "it, over the staff handler that checks this project's permissions on " +
      "every call.",
    provenBy: (plan) =>
      mentions(plan, ["app", "admin", "schedule", "page.tsx"], "<ScheduleCalendar") &&
      mentions(plan, ["app", "admin", "schedule", "settings", "page.tsx"], "<SchedulingSettings") &&
      mentions(plan, ["app", "api", "admin", "schedule", "[...path]", "route.ts"], "createSchedulingAdminHandlers("),
  },
  {
    capability: "scheduling.route",
    why:
      "Today's route for a crew on a phone — <CrewDay> on " +
      "/admin/schedule/today, from scheduling-admin: stops in order with " +
      "directions and Start/Complete.",
    provenBy: (plan) => mentions(plan, ["app", "admin", "schedule", "today", "page.tsx"], "<CrewDay"),
  },
  {
    capability: "scheduling.reminders",
    why:
      "The visit emails and the reminder before each visit: the scheduling " +
      "comms listener wired as the routes' onEvent, and the comms cron " +
      "consulting it at send time (the hook that re-checks a reminder and " +
      "puts the customer's link in it). Either half alone sends nothing " +
      "useful — a listener nobody drains queues reminders that never go.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "scheduling-notify.ts"], "createSchedulingCommsListener(") &&
      mentions(plan, ["src", "server", "comms-hooks.ts"], "schedulingComms") &&
      mentions(plan, ["app", "api", "cron", "comms", "route.ts"], "beforeSend: commsBeforeSend"),
  },
  {
    capability: "invoicing.invoices",
    why:
      "The invoicing router plus the public pay-by-token page a customer views " +
      "without an account. The staff ledger is the other key.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "routers", "invoicing.ts"], "createInvoice") &&
      exists(plan, "app", "(site)", "invoice", "[token]", "page.tsx"),
  },
  {
    capability: "invoicing.ledger",
    why: "The staff invoice ledger page under the shell, from invoicing-admin.",
    provenBy: (plan) => exists(plan, "app", "admin", "invoices", "page.tsx"),
  },
  {
    capability: "comms.messaging",
    why:
      "The cron route that drains the queue through the injected senders — the " +
      "mechanism that actually delivers, whether or not a shell lists it — AND " +
      "the vercel.json schedule that calls it: a drain nothing calls delivered " +
      "nothing, which is how every comms project shipped until 2026-09-23. The " +
      "console page is the other key.",
    provenBy: (plan) =>
      mentions(plan, ["app", "api", "cron", "comms", "route.ts"], "runDueMessages(") &&
      mentions(plan, ["vercel.json"], '"/api/cron/comms"'),
  },
  {
    capability: "comms.console",
    why: "The staff templates/messages console under the shell, from comms-admin.",
    provenBy: (plan) => exists(plan, "app", "admin", "comms", "page.tsx"),
  },
  {
    capability: "aeo.citations",
    why:
      "The router that runs citation checks against the injected asker, over " +
      "tRPC whether or not a shell renders the dashboard. The dashboard is the " +
      "other key.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "routers", "aeo.ts"], "runCitationChecks("),
  },
  {
    capability: "aeo.dashboard",
    why: "The staff citation-tracking dashboard under the shell, from aeo-admin.",
    provenBy: (plan) => exists(plan, "app", "admin", "aeo", "page.tsx"),
  },
];

/**
 * Capability keys whose evidence cannot tell them apart from a sibling.
 *
 * A recorded debt, not a design. Each key here is claimed under one answer and
 * not another, while the emitted project is byte-for-byte the same either way —
 * so `provenBy` is true even in the configuration that does not claim it, and
 * the exclusivity half of the check has to be waived.
 *
 * `capabilities.test.ts` keeps the list honest in the direction that matters:
 * every entry must still be genuinely indistinguishable. The day the generator
 * makes one of these real, the exemption stops being needed and the test says
 * so — which is the only mechanism that gets a list like this pruned.
 */
export const UNDISTINGUISHED_CAPABILITIES: Readonly<Record<string, string>> = {
  "tenancy.personal-workspace":
    "a `--tenant none` project and a `--tenant Workspace` project are the same " +
    "bytes. Every project mints a personal workspace in `currentPrincipal`; " +
    "the answer changes only the noun the UI prints, and `Workspace` is also " +
    "the fallback noun. Real, but presentational.",
  "tenancy.organizations":
    "the other half of the same pair. Distinguishing them means the generator " +
    "emitting something structural for an organisation — a switcher, a create " +
    "form — that it does not emit today.",
  "commerce.one-time-checkout":
    "`--model one-time`, `--model subscription` and `--model both` select the " +
    "same overlays, the same packages and the same router. The answer reaches " +
    "the manifest and SCAFFOLD.md and nothing else, so a one-time project " +
    "ships the identical subscription code and merely declines to claim it.",
  "billing.subscriptions":
    "the other half of that trio, and the more misleading direction: a " +
    "`--model one-time` project does not claim subscriptions and contains " +
    "every line of the subscription path.",
};

export class UnprovableCapabilityError extends Error {
  readonly name = "UnprovableCapabilityError";
  constructor(
    readonly capability: string,
    reason: string,
  ) {
    super(
      `adminigloo.json would claim "${capability}", and ${reason} A manifest ` +
        `that claims a capability nothing provides is worse than no manifest: ` +
        `the matrix CI and any doctor command will trust it. Either emit the ` +
        `thing, stop claiming it in capabilitiesFor, or — if it is genuinely ` +
        `provided by something new — add a row to CAPABILITY_EVIDENCE naming ` +
        `the emitted file that proves it.`,
    );
  }
}

/**
 * Check the manifest's claims against the files this plan actually contains.
 *
 * Called from `planEmit` before anything is written, on every generation rather
 * than only under test, because the cost is a handful of substring checks over
 * files already in memory and the failure it prevents is silent for ever.
 */
export function assertCapabilitiesAreProvable(
  plan: EmitPlan,
  capabilities: readonly string[],
  evidence: readonly CapabilityEvidence[] = CAPABILITY_EVIDENCE,
): void {
  const byKey = new Map(evidence.map((row) => [row.capability, row]));

  for (const capability of capabilities) {
    const row = byKey.get(capability);
    if (row === undefined) {
      throw new UnprovableCapabilityError(
        capability,
        "no row in CAPABILITY_EVIDENCE says what in the emitted project " +
          "provides it.",
      );
    }
    if (!row.provenBy(plan)) {
      throw new UnprovableCapabilityError(
        capability,
        `its evidence is absent from the plan — ${row.why}`,
      );
    }
  }
}
