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
      "Invitations are served by the package's handlers (send, resend, revoke, " +
      "accept, preview) through the ONE construction site, and the invite page " +
      "renders the package's accept screen. The 0.3 tRPC router is retired: a " +
      "second write path into the same rows would be two places to keep the " +
      "rank rules right.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "tenancy-handlers.ts"], "createTenancyHandlers(") &&
      mentions(plan, ["app", "api", "tenancy", "[...path]", "route.ts"], "buildTenancyHandlers(") &&
      mentions(plan, ["app", "(site)", "invite", "[token]", "page.tsx"], "<AcceptInvitation"),
  },
  {
    capability: "tenancy.personal-workspace",
    why:
      "The personal variant of the one construction site: every person gets " +
      "their own workspace from `provisionUser`, from the webhook or the first " +
      "page, whichever arrives first.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "tenancy.ts"], 'mode: "personal"'),
  },
  {
    capability: "tenancy.organizations",
    why:
      "A company is something a person creates, switches between and runs: " +
      "the onboarding form, the header switcher, the company settings and team " +
      "pages, and the routes they talk to. Each page renders the package " +
      "component, so the evidence is the component on the page.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "tenancy.ts"], 'mode: "companies"') &&
      mentions(plan, ["app", "(site)", "onboarding", "page.tsx"], "<Onboarding") &&
      mentions(plan, ["src", "components", "CompanySwitcherSlot.tsx"], "<CompanySwitcher") &&
      mentions(plan, ["app", "(site)", "settings", "company", "page.tsx"], "<CompanySettings") &&
      mentions(plan, ["app", "(site)", "settings", "team", "page.tsx"], "<TeamManager") &&
      mentions(plan, ["src", "server", "tenancy-handlers.ts"], "createTenancyHandlers("),
  },
  {
    capability: "tenancy.first-run",
    why:
      "The permission catalog is seeded on every deploy, right after the " +
      "migrations (PC-09), and a locked-out owner has a recovery command. " +
      "Without the deploy step production never gets its roles and the first " +
      "administrator is never made.",
    provenBy: (plan) =>
      mentions(plan, ["scripts", "seed-deploy.ts"], "seedPermissions(") &&
      mentions(plan, ["src", "permissions", "seed.ts"], "seedPermissionCatalog(") &&
      mentions(plan, [".github", "workflows", "deploy.yml"], "db:seed:deploy") &&
      exists(plan, "scripts", "admin-grant.ts"),
  },
  {
    capability: "tenancy.isolation-proof",
    why:
      "The project proves, in its own unit suite on an in-process Postgres, " +
      "that one company can't read or change another's rows through any " +
      "tenant procedure or company route, and that every procedure sits on the " +
      "rung it was meant to.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "__tests__", "tenant-isolation.test.ts"], "ISOLATION_BODIES") &&
      mentions(plan, ["src", "server", "__tests__", "procedure-scopes.test.ts"], "auditBuiltProcedures("),
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
    capability: "admin.operator-console",
    why:
      "Every company, searchable, with suspend, reactivate and a new owner " +
      "for one whose owner closed their account; and People, where staff " +
      "roles are given. Both are package components on admin pages.",
    provenBy: (plan) =>
      mentions(plan, ["app", "admin", "companies", "page.tsx"], "<CompaniesConsole") &&
      mentions(plan, ["app", "admin", "people", "page.tsx"], "<StaffPeople"),
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
    // Tenancy 2b-2a: the route mounts the glue's builder, and the glue builds
    // the package's handlers — both, or the route posts into nothing.
    provenBy: (plan) =>
      mentions(
        plan,
        ["app", "api", "igloo", "[...path]", "route.ts"],
        "buildFeedbackIntakeHandlers(",
      ) &&
      mentions(plan, ["src", "server", "feedback.ts"], "createFeedbackHandlers(") &&
      exists(plan, "src", "components", "FeedbackWidget.tsx"),
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
  // ALERTS AND FILES (Tenancy 2b-1, 13.9). Each server half proven by the
  // call that does the work, each screen by the package component on it, in
  // either mode's shape.
  {
    capability: "notifications.fanout",
    why:
      "The alerts instance (createNotifications over the package's named " +
      "tables, fanning out at write time) AND the routes that read it back " +
      "(the package's handlers, behind the project's own sign-in): " +
      "/api/app/{id}/alerts for each company, /api/admin/alerts for one " +
      "business. 0.1's notify helper and tRPC router are retired.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "alerts.ts"], "createNotifications(", "tables: notificationTables") &&
      mentions(plan, ["src", "server", "alerts-routes.ts"], "createNotificationHandlers(") &&
      (exists(plan, "app", "api", "app", "[tenantId]", "alerts", "[...path]", "route.ts") ||
        exists(plan, "app", "api", "admin", "alerts", "[...path]", "route.ts")),
  },
  {
    capability: "notifications.bell",
    why:
      "The bell in the header: the AlertsBellSlot the header renders is the " +
      "notifications widget's <AlertsBell> (it is null in a project without " +
      "alerts).",
    provenBy: (plan) => mentions(plan, ["src", "components", "AlertsBellSlot.tsx"], "<AlertsBell"),
  },
  {
    capability: "notifications.inbox",
    why:
      "The alerts page, the notifications widget's <AlertsInbox>: each " +
      "company's /app/alerts, or a single business's /admin/alerts under the " +
      "shell.",
    provenBy: (plan) =>
      mentions(plan, ["app", "(site)", "app", "alerts", "page.tsx"], "<AlertsInbox") ||
      mentions(plan, ["app", "admin", "alerts", "page.tsx"], "<AlertsInbox"),
  },
  {
    capability: "notifications.producers",
    why:
      "Every installed feature's events reach the alerts: the alerts module " +
      "builds the instance and glues each installed producer to it, and the " +
      "scheduling and estimator listeners list the alerts FIRST (before the " +
      "comms listener), so the office email finds the rows to claim.",
    provenBy: (plan) => {
      const alerts = file(plan, "src", "server", "alerts.ts");
      if (alerts === undefined || !alerts.includes("createNotifications(")) return false;
      const producers: Array<[readonly string[], string, string]> = [
        [["src", "server", "scheduling-notify.ts"], "alertOnSchedulingEvent", "LISTENERS: readonly SchedulingEventListener[] = [(event) => alertOnSchedulingEvent(event)"],
        [["src", "server", "estimator-notify.ts"], "alertOnEstimatorEvent", "LISTENERS: readonly EstimatorEventListener[] = [(event) => alertOnEstimatorEvent(event)"],
        [["src", "server", "invoicing.ts"], "alertOnInvoicingEvent", "onEvent: (event) => alertOnInvoicingEvent(event)"],
        [["src", "server", "comms-senders.ts"], "alertOnCommsFailure", "m.alertOnCommsFailure(failure)"],
      ];
      const present = producers.filter(([path]) => exists(plan, ...path));
      return (
        present.length > 0 &&
        present.every(([path, producer, wiring]) => alerts.includes(`export async function ${producer}(`) && mentions(plan, path, wiring))
      );
    },
  },
  {
    capability: "storage.files",
    why:
      "The files instance (createStorage over the package's named table, two " +
      "stores, the records and the allowance) AND the public route that serves " +
      "signed links and the logo (/api/files). The Files screen is the other " +
      "key.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "files.ts"], "createStorage(", "tables: storageTables") &&
      exists(plan, "app", "api", "files", "[...path]", "route.ts"),
  },
  {
    capability: "storage.library",
    why:
      "The Files screen, the storage widget's <FilesManager>: each company's " +
      "/app/files, or a single business's /admin/files under the shell.",
    provenBy: (plan) =>
      mentions(plan, ["app", "(site)", "app", "files", "page.tsx"], "<FilesManager") ||
      mentions(plan, ["app", "admin", "files", "page.tsx"], "<FilesManager"),
  },
  {
    capability: "storage.attachments",
    why:
      "Photos and files on a visit, an estimate or an invoice: the " +
      "RecordFilesSlot the record pages render is the storage widget's " +
      "<RecordFiles> (it is null in a project without storage), and the " +
      "files instance knows the records.",
    provenBy: (plan) =>
      mentions(plan, ["src", "components", "RecordFilesSlot.tsx"], "<RecordFiles") &&
      mentions(plan, ["src", "server", "files.ts"], "FileRecords(db"),
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
    capability: "assistant.chat",
    why:
      "The assistant answers with a model (Tenancy 2b-3): the glue builds the " +
      "Anthropic provider with prompt caching, checks the monthly allowance and " +
      "records each question's AI use. Needs --ai.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "assistant.ts"], "createAnthropicProvider(", "checkAiAllowance(", "recordAiUsage("),
  },
  {
    capability: "assistant.companies",
    why:
      "Each company has its own assistant (Tenancy 2b-3): its route under " +
      "/api/app/{id}/assistant, its settings at /app/assistant, and the button " +
      "on its pages.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "assistant.ts"], "buildAssistantHandlers", "companyAuthorizer(") &&
      exists(plan, "app", "api", "app", "[tenantId]", "assistant", "[...path]", "route.ts") &&
      mentions(plan, ["app", "(site)", "app", "assistant", "page.tsx"], "<AssistantSettings"),
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
  // that does the work; each staff half by its screen. TWO SHAPES, one per
  // mode (Tenancy 2a): a single business's routes and pages at the root and
  // under /admin, and a companies project's under /api/app/{id}, /api/t/{web
  // address}, /app and /t/{web address}, built in the feature glue. A row
  // passes on either shape — and only a project that has the feature has
  // either, so the exclusivity check still bites.
  {
    capability: "estimator.pricing",
    why:
      "The instant estimate: the PUBLIC route mounting the package's handler " +
      "(createEstimatorHandlers — prices from the business's price book, the " +
      "questions each product asks, never a cost) and the estimate page " +
      "rendering <EstimateTool> against it — /estimate for a single business, " +
      "each company's /t/{web address}/estimate in a companies project. The " +
      "staff factory may be called nowhere in a public route file: a public " +
      "route mounting the staff handler would put the price book's costs on " +
      "the open internet.",
    provenBy: (plan) =>
      (mentions(plan, ["app", "api", "estimator", "[...path]", "route.ts"], "createEstimatorHandlers(") &&
        !mentions(plan, ["app", "api", "estimator", "[...path]", "route.ts"], "createEstimatorAdminHandlers(") &&
        mentions(plan, ["app", "(site)", "estimate", "page.tsx"], "<EstimateTool")) ||
      (mentions(plan, ["src", "server", "estimator.ts"], "export function buildEstimatorPublicHandlers", "createEstimatorHandlers(") &&
        mentions(plan, ["app", "api", "t", "[slug]", "estimator", "[...path]", "route.ts"], "buildEstimatorPublicHandlers()") &&
        !mentions(plan, ["app", "api", "t", "[slug]", "estimator", "[...path]", "route.ts"], "Admin") &&
        mentions(plan, ["app", "(company)", "t", "[slug]", "estimate", "page.tsx"], "<EstimateTool")),
  },
  {
    capability: "estimator.embed",
    why:
      "The estimate on the business's OTHER website: the public handler " +
      "answers a request carrying an embed key (checked against the key's " +
      "allowed websites, with CORS for that page), and the 0.2 embed address " +
      "/api/estimator/embed re-exports it so a widget already pasted keeps " +
      "working. In a companies project the embed route is keyed-only " +
      "(buildEstimatorEmbedHandlers): the key names the company.",
    provenBy: (plan) =>
      (mentions(plan, ["app", "api", "estimator", "[...path]", "route.ts"], "createEstimatorHandlers(") ||
        mentions(plan, ["app", "api", "estimator", "[...path]", "route.ts"], "buildEstimatorEmbedHandlers()")) &&
      mentions(plan, ["app", "api", "estimator", "embed", "[...path]", "route.ts"], 'from "../../[...path]/route"'),
  },
  {
    capability: "estimator.quotes",
    why:
      "A quote the customer accepts or declines online: the staff route " +
      "mounting createEstimatorAdminHandlers (where staff edit the estimate " +
      "and send the quote) with the quote link it emails, and the quote page " +
      "rendering <QuoteView> — /quote/[token] for a single business, each " +
      "company's /t/{web address}/quote/[token] in a companies project.",
    provenBy: (plan) =>
      (mentions(plan, ["app", "api", "admin", "estimator", "[...path]", "route.ts"], "createEstimatorAdminHandlers(", "quoteUrl:") &&
        mentions(plan, ["app", "(site)", "quote", "[token]", "page.tsx"], "<QuoteView")) ||
      (mentions(plan, ["src", "server", "estimator.ts"], "createEstimatorAdminHandlers(", "quoteUrl:") &&
        mentions(plan, ["app", "(company)", "t", "[slug]", "quote", "[token]", "page.tsx"], "<QuoteView")),
  },
  {
    capability: "estimator.builder",
    why:
      "The staff screens: the price book (<PriceBook>), the leads and quotes " +
      "queue (<EstimatesQueue>) and one estimate's editor (<EstimateEditor>) " +
      "— under the shell for a single business (estimator-admin), in each " +
      "company's own area (/app) in a companies project.",
    provenBy: (plan) =>
      (mentions(plan, ["app", "admin", "estimator", "page.tsx"], "<PriceBook") &&
        mentions(plan, ["app", "admin", "estimates", "page.tsx"], "<EstimatesQueue") &&
        mentions(plan, ["app", "admin", "estimates", "[id]", "page.tsx"], "<EstimateEditor")) ||
      (mentions(plan, ["app", "(site)", "app", "price-book", "page.tsx"], "<PriceBook") &&
        mentions(plan, ["app", "(site)", "app", "estimates", "page.tsx"], "<EstimatesQueue") &&
        mentions(plan, ["app", "(site)", "app", "estimates", "[id]", "page.tsx"], "<EstimateEditor")),
  },
  {
    capability: "estimator.photos",
    why:
      "A customer's photo kept PRIVATELY with their estimate (Tenancy 2b-1): " +
      "the files module's estimator photo purpose store, re-exported by the " +
      "generated services module and handed to the estimator's handlers (in " +
      "the route, or in the companies glue that builds them). Staff's own " +
      "photos are kept apart, under their own purpose (review SEC-02).",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "files.ts"], 'purposeStore("estimator.photo")') &&
      mentions(plan, ["src", "server", "files.ts"], 'purposeStore("estimator.staff-photo")') &&
      mentions(plan, ["src", "server", "estimator-services.ts"], 'export { estimatorPhotoStore, estimatorStaffPhotoStore } from "@/server/files"') &&
      (mentions(plan, ["app", "api", "estimator", "[...path]", "route.ts"], "photoStore: estimatorPhotoStore") ||
        mentions(plan, ["src", "server", "estimator.ts"], "photoStore: estimatorPhotoStore")),
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
      "<VisitPicker> and <ManageVisit> — over the route that mounts the " +
      "package's PUBLIC handler: /book-visit and /visit/[token] over " +
      "/api/schedule for a single business, each company's /t/{web " +
      "address}/book-visit and /visit/[token] over /api/t/{web " +
      "address}/schedule in a companies project. The staff finder and the " +
      "staff handler may be called nowhere in a public route file: 0.2's " +
      "public route returned the previous customer's street address from the " +
      "staff finder.",
    provenBy: (plan) =>
      (mentions(plan, ["app", "api", "schedule", "[...path]", "route.ts"], "createSchedulingHandlers(") &&
        !mentions(plan, ["app", "api", "schedule", "[...path]", "route.ts"], "findAvailableSlots(") &&
        !mentions(plan, ["app", "api", "schedule", "[...path]", "route.ts"], "createSchedulingAdminHandlers(") &&
        mentions(plan, ["app", "(site)", "book-visit", "page.tsx"], "<VisitPicker") &&
        mentions(plan, ["app", "(site)", "visit", "[token]", "page.tsx"], "<ManageVisit")) ||
      (mentions(plan, ["src", "server", "scheduling.ts"], "export function buildSchedulingPublicHandlers", "createSchedulingHandlers(") &&
        mentions(plan, ["app", "api", "t", "[slug]", "schedule", "[...path]", "route.ts"], "buildSchedulingPublicHandlers()") &&
        !mentions(plan, ["app", "api", "t", "[slug]", "schedule", "[...path]", "route.ts"], "Admin") &&
        !mentions(plan, ["app", "api", "t", "[slug]", "schedule", "[...path]", "route.ts"], "findAvailableSlots(") &&
        mentions(plan, ["app", "(company)", "t", "[slug]", "book-visit", "page.tsx"], "<VisitPicker") &&
        mentions(plan, ["app", "(company)", "t", "[slug]", "visit", "[token]", "page.tsx"], "<ManageVisit")),
  },
  {
    capability: "scheduling.calendar",
    why:
      "The staff calendar — <ScheduleCalendar> — and Schedule settings beside " +
      "it, over the staff handler that checks permissions on every call: " +
      "/admin/schedule for a single business (scheduling-admin), each " +
      "company's /app/schedule in a companies project.",
    provenBy: (plan) =>
      (mentions(plan, ["app", "admin", "schedule", "page.tsx"], "<ScheduleCalendar") &&
        mentions(plan, ["app", "admin", "schedule", "settings", "page.tsx"], "<SchedulingSettings") &&
        mentions(plan, ["app", "api", "admin", "schedule", "[...path]", "route.ts"], "createSchedulingAdminHandlers(")) ||
      (mentions(plan, ["app", "(site)", "app", "schedule", "page.tsx"], "<ScheduleCalendar") &&
        mentions(plan, ["app", "(site)", "app", "schedule", "settings", "page.tsx"], "<SchedulingSettings") &&
        mentions(plan, ["app", "api", "app", "[tenantId]", "schedule", "[...path]", "route.ts"], "buildSchedulingAdminHandlers()") &&
        mentions(plan, ["src", "server", "scheduling.ts"], "createSchedulingAdminHandlers(")),
  },
  {
    capability: "scheduling.route",
    why:
      "Today's route for a crew on a phone — <CrewDay>: stops in order with " +
      "directions and Start/Complete — at /admin/schedule/today for a single " +
      "business, at each company's /app/schedule/today (the Crew role's one " +
      "key) in a companies project.",
    provenBy: (plan) =>
      mentions(plan, ["app", "admin", "schedule", "today", "page.tsx"], "<CrewDay") ||
      mentions(plan, ["app", "(site)", "app", "schedule", "today", "page.tsx"], "<CrewDay"),
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
      "Invoices on the package's own handlers (Tenancy 2a, D3 — the tRPC " +
      "router is retired) and the customer's invoice page, opened without an " +
      "account: /invoice/[token] for a single business, each company's " +
      "/t/{web address}/invoice/[token] in a companies project. The staff " +
      "ledger is the other key.",
    provenBy: (plan) =>
      mentions(plan, ["src", "server", "invoicing.ts"], "createInvoicingAdminHandlers(", "createInvoicingHandlers(") &&
      (mentions(plan, ["app", "(site)", "invoice", "[token]", "page.tsx"], "<InvoiceView") ||
        mentions(plan, ["app", "(company)", "t", "[slug]", "invoice", "[token]", "page.tsx"], "<InvoiceView")),
  },
  {
    capability: "invoicing.ledger",
    why:
      "The staff invoice ledger, the invoicing widget's <InvoicesLedger>: " +
      "/admin/invoices under the shell for a single business " +
      "(invoicing-admin), each company's /app/invoices in a companies project.",
    provenBy: (plan) =>
      mentions(plan, ["app", "admin", "invoices", "page.tsx"], "<InvoicesLedger") ||
      mentions(plan, ["app", "(site)", "app", "invoices", "page.tsx"], "<InvoicesLedger"),
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
    why:
      "The Messages console, the comms widget's <MessagesConsole>: " +
      "/admin/comms under the shell for a single business (comms-admin), each " +
      "company's /app/messages in a companies project.",
    provenBy: (plan) =>
      mentions(plan, ["app", "admin", "comms", "page.tsx"], "<MessagesConsole") ||
      mentions(plan, ["app", "(site)", "app", "messages", "page.tsx"], "<MessagesConsole"),
  },

  // EACH COMPANY RUNS THE FEATURES ITSELF (Tenancy 2a).
  {
    capability: "companies.feature-area",
    why:
      "Each company's own screens for the features this project installed, " +
      "under /app: the schedule (<ScheduleCalendar>), estimates " +
      "(<EstimatesQueue>), invoices (<InvoicesLedger>) and messages " +
      "(<MessagesConsole>) — every installed one — each over a route that " +
      "names the company in its path (/api/app/[tenantId]/…).",
    provenBy: (plan) => {
      const pages: Array<[readonly string[], string]> = [
        [["app", "(site)", "app", "schedule", "page.tsx"], "<ScheduleCalendar"],
        [["app", "(site)", "app", "estimates", "page.tsx"], "<EstimatesQueue"],
        [["app", "(site)", "app", "invoices", "page.tsx"], "<InvoicesLedger"],
        [["app", "(site)", "app", "messages", "page.tsx"], "<MessagesConsole"],
      ];
      const present = pages.filter(([path]) => exists(plan, ...path));
      return (
        present.length > 0 &&
        present.every(([path, component]) => mentions(plan, path, component, "/api/app/${company.id}/")) &&
        mentions(plan, ["src", "server", "company-routes.ts"], "createCompanyRouteSeams(")
      );
    },
  },
  {
    capability: "companies.public-pages",
    why:
      "Each company's public pages under /t/{web address}, through the " +
      "emitted PublicCompanyGate (brand bar; a suspended company says it " +
      "isn't taking requests): its booking page (<VisitPicker>), estimate " +
      "page (<EstimateTool>) and invoice page (<InvoiceView>) — every one the " +
      "project's features have.",
    provenBy: (plan) => {
      const pages: Array<[readonly string[], string]> = [
        [["app", "(company)", "t", "[slug]", "book-visit", "page.tsx"], "<VisitPicker"],
        [["app", "(company)", "t", "[slug]", "estimate", "page.tsx"], "<EstimateTool"],
        [["app", "(company)", "t", "[slug]", "invoice", "[token]", "page.tsx"], "<InvoiceView"],
      ];
      const present = pages.filter(([path]) => exists(plan, ...path));
      return (
        present.length > 0 &&
        present.every(([path, component]) => mentions(plan, path, component, "<PublicCompanyGate")) &&
        mentions(plan, ["src", "components", "PublicCompanyGate.tsx"], "<CompanyUnavailable", "resolvePublicCompany(")
      );
    },
  },
  {
    capability: "companies.feature-isolation-proof",
    why:
      "The project proves, in its own unit suite on PGlite, that one company " +
      "can't reach another's rows through ANY feature route — every private " +
      "and public route of every installed feature, driven from the " +
      "packages' own route tables, with a negative control that shows the " +
      "check bites.",
    provenBy: (plan) =>
      mentions(
        plan,
        ["src", "server", "__tests__", "feature-isolation.test.ts"],
        "_ADMIN_ROUTES",
        "expectIsolated(",
        "createAppPglite",
      ) && mentions(plan, ["src", "test", "company-rows.ts"], "export async function plantCompanyRows("),
  },
  {
    capability: "companies.crons",
    why:
      "Every daily job serves EVERY active company and skips a suspended one: " +
      "the scheduling and estimator crons through runForEachCompany (one " +
      "company's failure never stops the rest), the comms drain over the " +
      "active companies' ids — each installed one.",
    provenBy: (plan) => {
      const crons: Array<[readonly string[], string]> = [
        [["app", "api", "cron", "scheduling", "route.ts"], "runForEachCompany("],
        [["app", "api", "cron", "estimator", "route.ts"], "runForEachCompany("],
        [["app", "api", "cron", "comms", "route.ts"], "tenantIds: await tenancy.activeCompanyIds()"],
      ];
      const present = crons.filter(([path]) => exists(plan, ...path));
      return present.length > 0 && present.every(([path, call]) => mentions(plan, path, call));
    },
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
