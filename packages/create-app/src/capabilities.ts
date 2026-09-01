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
