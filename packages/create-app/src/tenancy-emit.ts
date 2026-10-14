/**
 * The Tenancy 1 renderers: the files that wire @adminigloo/tenancy and
 * @adminigloo/tenancy-widget into a generated project.
 *
 * In their own module because emit.ts is long enough already, and because
 * these files are one subject — companies — whose variants are all chosen by
 * the same two answers: the tenant noun (`none` is the single-business mode,
 * anything else is companies) and whether there is an admin shell.
 *
 * THE GENERATOR'S RULES APPLY HERE AS EVERYWHERE (README "Rules"):
 *
 *   - No emitted `if` asks whether a feature or a mode is installed. Where a
 *     file differs by mode, the generator writes the variant; where only a
 *     value differs, the value is a constant in `src/tenancy.ts`.
 *   - The pages are thin wrappers around package components, so a fix to who
 *     may remove whom reaches every project by `npm update`.
 *
 * DECISION: the construction site is split in two files rather than the one
 * the contract (12.2) sketches. `src/server/tenancy.ts` builds the SERVICE and
 * imports nothing that reads the request; `src/server/tenancy-handlers.ts`
 * builds the HTTP handlers, which need `currentPrincipal` from auth.ts. auth.ts
 * itself needs the service (provisioning), so one file would be an import
 * cycle between auth.ts and tenancy.ts in which each module reads the other
 * at load time.
 */

import { tenantLabel, tenantLabelPlural, type Answers } from "./answers.js";

/** True for every noun except `none`: the customer is a company somebody names. */
export function companiesMode(answers: Answers): boolean {
  return answers.tenantNoun !== "none";
}

/**
 * The project's own name, as web addresses nobody else may take (review
 * T1-07): "igloo-back-office" and its first word, "igloo". A customer naming
 * their company after the platform would otherwise get the platform's brand as
 * their public address.
 */
export function projectReservedSlugs(answers: Answers): readonly string[] {
  const whole = answers.projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const words = new Set<string>();
  if (whole.length >= 3) words.add(whole);
  const first = whole.split("-")[0] ?? "";
  if (first.length >= 3) words.add(first);
  return [...words];
}

// ---------------------------------------------------------------------------
// src/tenancy.ts — client-safe constants, both modes
// ---------------------------------------------------------------------------

export function renderTenancyConstants(answers: Answers): string {
  const companies = companiesMode(answers);
  const title = { singular: tenantLabel(answers), plural: tenantLabelPlural(answers) };
  const noun = { singular: title.singular.toLowerCase(), plural: title.plural.toLowerCase() };
  const shell = answers.adminShell !== "none";
  const onboarding = companies ? "/onboarding" : "/";
  return `/**
 * Companies, as this project names and routes them. Client-safe constants —
 * no server import — read by the pages, the header and the widget props.
 *
 * GENERATED, and the reason is the generator's rule: where the two modes
 * differ only by a VALUE, the value lives here and every file that uses it is
 * the same in both. ${companies ? `This project's customers are ${noun.plural} somebody names (--tenant-noun ${answers.tenantNoun}).` : "This is a single-business project (--tenant-noun none): each person has one workspace, made for them at sign-up."}
 */

/** What a customer is called, lowercase, for sentences: "Invite people to your ${noun.singular}". */
export const NOUN = { singular: "${noun.singular}", plural: "${noun.plural}" } as const;
/** The same, capitalised, for titles. */
export const NOUN_TITLE = { singular: "${title.singular}", plural: "${title.plural}" } as const;

/**
 * Where someone lands after signing in or up with nowhere else to go. ${companies ? `The ${noun.singular} dashboard, which sends a new owner on to onboarding ("What's your ${noun.singular} called?").` : "The home page: a single-business project has no company dashboard."}
 */
export const AFTER_AUTH_PATH = "${companies ? "/dashboard" : "/"}";

/**
 * Where someone signed in with no ${noun.singular} is sent. ${companies ? "Onboarding." : "A single-business project never gets here — every person's workspace is made at sign-up — so it is the home page."}
 */
export const ONBOARDING_HREF = "${onboarding}";

/**
 * Where a member of the platform's staff with no ${noun.singular} of their own
 * is sent instead of onboarding (review T1-09): the admin console${shell ? "" : " — and this project has none, so it is the same as ONBOARDING_HREF"}.
 * The platform owner signing in to their own site should not be nudged into
 * creating a fake customer.
 */
export const STAFF_HOME = "${shell ? "/admin" : onboarding}";

/** The "Go to the admin console" link onboarding shows staff, or null without an admin shell. */
export const STAFF_CONSOLE_HREF: string | null = ${shell ? '"/admin"' : "null"};

/** The package handlers' mount points (app/api/tenancy, app/api/admin/tenancy). */
export const TENANCY_API = "/api/tenancy";
export const TENANCY_ADMIN_API = "/api/admin/tenancy";

/** Each ${noun.singular}'s reserved public address: /t/{web-address}. */
export const PUBLIC_COMPANY_PREFIX = "/t/";

/**
 * Which ${noun.plural} the operator console lists first. ${companies ? `"org": the ${noun.plural} customers named; personal workspaces are people, not customers, and are one click away.` : `"all": in a single-business project the personal workspaces ARE the customers.`}
 */
export const ADMIN_COMPANIES_DEFAULT_KIND = "${companies ? "org" : "all"}" as const;

/**
 * A pattern, not a function: the console is a client component rendered from
 * a server page, and a function can't cross that line.
 */
export const ADMIN_COMPANY_DETAIL_HREF = "/admin/companies/{id}";
${companies ? renderCompanyPageConstants(answers) : ""}`;
}

/**
 * The companies-only constants Tenancy 2a adds: the public pages every
 * company gets (a generated list — a feature this project doesn't have
 * contributes no entry), and where a feature's settings screen sends the owner
 * to change the company-owned fields it shows read-only.
 */
function renderCompanyPageConstants(answers: Answers): string {
  const noun = tenantLabel(answers).toLowerCase();
  const pages = [
    ...(answers.includeEstimator ? [`  { path: "/estimate", label: "Get an instant estimate" },`] : []),
    ...(answers.includeScheduling ? [`  { path: "/book-visit", label: "Book a visit" },`] : []),
  ];
  return `
/**
 * The public pages every ${noun} has under its web address (Tenancy 2a), as the
 * buttons on /t/{web address}. Generated from what this project installed: a
 * feature it doesn't have contributes no entry, so no page asks whether one
 * exists.
 */
export const PUBLIC_COMPANY_PAGES: readonly { readonly path: string; readonly label: string }[] = ${
    pages.length === 0 ? "[]" : `[\n${pages.join("\n")}\n]`
  };

/**
 * Where a feature's settings screen sends the owner to change what belongs to
 * the ${noun} — its name, time zone and contact — which every feature shows
 * read-only and reads from one place (Tenancy 2a, D5–D6).
 */
export const COMPANY_DETAILS_HREF = "/settings/company#details";
`;
}

// ---------------------------------------------------------------------------
// src/server/tenant-settings.ts and src/server/setup-checklist.ts
// ---------------------------------------------------------------------------

export function renderTenantSettings(answers: Answers): string {
  const noun = tenantLabel(answers).toLowerCase();
  // Invoicing's details are the one feature section (Tenancy 2a, D15): flat
  // fields an owner fills once, and invoicing has no settings table of its
  // own. Scheduling's and the estimator's settings are lists (services, crews,
  // the price book's rules) with their own screens. Companies only: a single
  // business has no company settings page to show it on.
  const invoicing = companiesMode(answers) && answers.includeInvoicing;
  const imports = invoicing
    ? `import { companySettings, defineSettingsFragment, defineTenantSettings } from "${answers.scope}/tenancy";
import { invoicingSettingsFragment } from "${answers.scope}/invoicing";`
    : `import { companySettings, defineTenantSettings } from "${answers.scope}/tenancy";`;
  const sections = invoicing ? "companySettings, defineSettingsFragment(invoicingSettingsFragment)" : "companySettings";
  return `${imports}

/**
 * Every settings section a ${noun} has — the TYPED registry other packages add
 * sections to, all shown on the ${noun} settings page and filled in once.
 *
 *   company    time zone, contact email, phone and address (Tenancy 1). Every
 *              feature READS these — the schedule, the estimate page, the
 *              invoices and every email show the ${noun}'s own details — so
 *              nothing is typed twice and nothing drifts (Tenancy 2a, D5).${
    invoicing
      ? `
 *   invoicing  "How customers pay you", how many days until an invoice is
 *              due, and a footer note: shown on every invoice and in the
 *              invoice email (/settings/company#invoicing).`
      : ""
  }
 *
 * Generated, like the permission catalog: which sections exist depends on
 * which packages were installed, and an emitted file holding an \`if\` about a
 * package it can't see is exactly what the generator refuses to write.
 */
export const tenantSettings = defineTenantSettings([${sections}]);
`;
}

export function renderSetupChecklist(answers: Answers): string {
  if (!companiesMode(answers)) {
    // Single-business mode has no dashboard, no checklist and no
    // /settings/company (D6), so its items would link to a page that isn't
    // there (review R2 TB2-07). An empty list, said plainly.
    return `import { defineSetupChecklist } from "${answers.scope}/tenancy";

/**
 * The setup checklist. Empty in this single-business project: there is no
 * company dashboard to show it on, and no company settings page for its
 * items to link to. (A companies project lists "add your business details",
 * "invite your team" and "add your logo and colour" here.)
 */
export const setupChecklist = defineSetupChecklist([]);
`;
  }
  const scope = answers.scope;
  // Each installed feature adds its own items (Tenancy 2a), linking to the
  // card on its own screen that does the job. Ordered by each item's own
  // `order`: business details 10, team 20, logo and colour 30, booking 40,
  // crews 50, prices 60, estimate settings 70, invoice details 80, website
  // embed 90.
  const featureImports = [
    ...(answers.includeScheduling ? [`import { schedulingChecklistItems } from "${scope}/scheduling";`] : []),
    ...(answers.includeEstimator ? [`import { estimatorChecklistItems } from "${scope}/estimator";`] : []),
    ...(answers.includeInvoicing ? [`import { invoicingChecklistItems } from "${scope}/invoicing";`] : []),
  ];
  const featureLines = [
    ...(answers.includeScheduling
      ? [
          `  // What customers can book, and a crew with hours (a booking page offers no time until one works).`,
          `  ...schedulingChecklistItems({ booking: "/app/schedule/settings#booking", crews: "/app/schedule/settings#crews" }),`,
        ]
      : []),
    ...(answers.includeEstimator
      ? [
          `  // Prices, the tax rate and quote rules (instant estimates stay closed until saved once), the website embed.`,
          `  ...estimatorChecklistItems({ priceBook: "/app/price-book", settings: "/app/estimates/settings", embed: "/app/estimates/settings#embed" }),`,
        ]
      : []),
    ...(answers.includeInvoicing
      ? [
          `  // How customers pay — on every invoice and in the invoice email.`,
          `  ...invoicingChecklistItems({ details: "/settings/company#invoicing" }),`,
        ]
      : []),
  ];
  return `import { defineSetupChecklist } from "${scope}/tenancy";
import { tenancyChecklistItems } from "${scope}/tenancy/server";
${featureImports.length > 0 ? `${featureImports.join("\n")}\n` : ""}
/**
 * The setup checklist a new owner sees on their dashboard: add your business
 * details, invite your team, add your logo and colour${
    featureLines.length > 0 ? " — and what each feature needs before customers can use it (Tenancy 2a)" : ""
  }.
 *
 * Each item knows when it is done by itself (a row in the ${tenantLabel(answers).toLowerCase()}'s own
 * tables); the owner can mark one "not needed" and undo that; a hidden list
 * comes back on its own when a new item is added. Someone whose role can't do
 * an item doesn't see it (a crew member sees none). Generated, for the
 * settings registry's reason: each line is here only with its feature.
 */
export const setupChecklist = defineSetupChecklist([
  ...tenancyChecklistItems({ companySettings: "/settings/company", team: "/settings/team" }),
${featureLines.length > 0 ? `${featureLines.join("\n")}\n` : ""}]);
`;
}

// ---------------------------------------------------------------------------
// src/server/tenancy.ts — the ONE construction site of the service
// ---------------------------------------------------------------------------

export function renderTenancyServer(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const mode = companies ? "companies" : "personal";
  const reserved = projectReservedSlugs(answers);
  // TENANCY 2a, companies only: the project's own role set (Crew with
  // scheduling), and the hook that gives each new company its features'
  // first settings and email templates. Behind a DYNAMIC import, on purpose:
  // company-setup imports the feature glue, which imports this module, and a
  // static import would be a load-time cycle in which one side reads the
  // other half-initialised.
  const companyOptions = companies
    ? `
  // The roles a company's people can hold: tenancy's four, plus any a
  // feature adds (src/permissions/roles.ts — Crew, with scheduling).
  roles: TENANT_ROLES,
  // After each change commits: a new company gets its features' first
  // settings and email templates; a new time zone moves its schedule's
  // reminders at once. Imported when first needed, NOT at the top of this
  // file — company-setup imports the feature glue, which imports this module,
  // and a static import would be a load-time cycle in which one side reads
  // the other half-initialised. Never throws (onCompanyEvent logs).
  onEvent: (event) => import("./company-setup").then((m) => m.onCompanyEvent(event)),`
    : "";
  return `import { resolveAppEnv } from "${scope}/env";
import { auditEntry } from "${scope}/observability";
import { auditLog } from "${scope}/observability/schema";
import type { BootstrapPolicy } from "${scope}/permissions";
import { createTenancyService, type TenancyAuditSink } from "${scope}/tenancy/server";
import { db } from "@/db";
import { env } from "@/env";
import { tenantCatalog } from "@/permissions/catalog";${companies ? `\nimport { TENANT_ROLES } from "@/permissions/roles";` : ""}
import { NOUN } from "@/tenancy";
import { auditRegistry } from "./audit";
import { log } from "./logger";
import { setupChecklist } from "./setup-checklist";
import { tenancyLogoStore } from "./tenancy-logo";
import { tenantSettings } from "./tenant-settings";

/**
 * Companies for ${answers.projectName}: the ONE place the tenancy service is
 * built. Everything that sets a person up, makes or changes a company, or
 * checks who belongs where goes through \`tenancy\`.
 *
 * ${companies ? `MODE "companies": a person signs up, names their ${tenantLabel(answers).toLowerCase()} in onboarding and owns it; invitations bring the team in; someone can belong to several and switch between them.` : `MODE "personal": a single-business project. Every person gets their own workspace at sign-up (named after them, so two in one menu can be told apart), and invitations bring people into someone else's.`}
 *
 * Generated (the mode is a literal here, never a runtime check), and the
 * request-facing half — the HTTP handlers — is in tenancy-handlers.ts so this
 * file never imports auth.ts, which imports it.
 */

/** How long an invitation link works. A week: long enough for a holiday, short enough to go stale. */
export const INVITATION_EXPIRY_HOURS = 24 * 7;

/**
 * Who becomes the first administrator.
 *
 * On a laptop, the first person to sign in — there is no one else. On a
 * deployment, only BOOTSTRAP_ADMIN_EMAIL, and only once that address is
 * VERIFIED with Clerk; unset, nobody is made one automatically (the sign-up
 * page is public). Retried whenever no administrator exists, not only at the
 * first sign-in, so signing in before the roles were installed no longer
 * locks /admin for good.
 *
 * A runtime ENVIRONMENT check (which deployment is this?), the one the 0.21
 * bootstrap made — not a feature switch.
 */
export function bootstrapPolicy(): BootstrapPolicy {
  if (resolveAppEnv() === "local") return { mode: "first-user" };
  const email = env.BOOTSTRAP_ADMIN_EMAIL?.trim();
  return email ? { mode: "email", email } : { mode: "off" };
}

/**
 * Every company-lifecycle event, written to the audit log ON THE SAME
 * TRANSACTION as the change it records — a role change without its audit row
 * is exactly the change somebody asks about six months later.
 */
export const auditSink: TenancyAuditSink = async (tx, event) => {
  await tx.insert(auditLog).values(
    auditEntry(auditRegistry, {
      action: event.action,
      actor: event.actorUserId ? { userId: event.actorUserId } : null,
      scope: event.scope,
      tenantId: event.tenantId,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      request: event.request,
      metadata: { ...event.metadata },
    }),
  );
};

export const tenancy = createTenancyService({
  db,
  mode: "${mode}",
  tenantCatalog,
  noun: NOUN,
  settings: tenantSettings,
  checklist: setupChecklist,
  bootstrap: bootstrapPolicy(),
  // Undefined without file storage (or without its token): the settings page
  // then says logo uploads aren't switched on, before anyone picks a file.
  logos: tenancyLogoStore,
  // The platform's own name is not a customer's web address (review T1-07).
  reservedSlugs: ${JSON.stringify(reserved)},
  invitations: { expiresInHours: INVITATION_EXPIRY_HOURS },
  audit: auditSink,${companyOptions}
  onEventError: (error, event) => {
    log.error({ err: error, event: event.type }, "a tenancy event listener failed");
  },
});
`;
}

// ---------------------------------------------------------------------------
// src/server/tenancy-handlers.ts — the HTTP half
// ---------------------------------------------------------------------------

export function renderTenancyHandlers(answers: Answers): string {
  const scope = answers.scope;
  return `import { desc, eq } from "drizzle-orm";
import { users } from "${scope}/auth/schema";
import { auditLog } from "${scope}/observability/schema";
import { clientIpFromHeaders, resolveRequestId } from "${scope}/observability/request";
import { describeTenancyAuditEntry } from "${scope}/tenancy";
import {
  createTenancyHandlers,
  createTenancyOperatorHandlers,
  TENANCY_RATE_LIMITS,
  type AuditLineWire,
  type CreateTenancyHandlersOptions,
  type RateLimiter,
  type RequestFacts,
  type TenancyHandlers,
  type TenancyPrincipal,
} from "${scope}/tenancy/server";
import { db } from "@/db";
import { env } from "@/env";
import { invitePath } from "@/invitations";
import { auditRegistry } from "./audit";
import { currentPrincipal, verifiedEmails } from "./auth";
import { reportError } from "./error-reporter";
import { invitationEmailsConfigured, sendInvitationEmail } from "./invitation-mail";
import { limiter } from "./rate-limit";
import { tenancy } from "./tenancy";

/**
 * The company routes (app/api/tenancy) and the operator routes
 * (app/api/admin/tenancy), wired to this project's database, mailer, rate
 * limiter and error log.
 *
 * The handlers themselves live in ${scope}/tenancy, where every rule
 * is: a company route names its company in the path and is authorised against
 * that id; a POST must be same-origin JSON; a company's invite and logo
 * budgets are charged only once the caller is shown to be one of its members.
 * This file only says where things are.
 */

/** Who is calling, as the handlers need it. Provisions on first sight (see auth.ts). */
export async function requestPrincipal(): Promise<TenancyPrincipal | null> {
  const principal = await currentPrincipal();
  return principal ? { userId: principal.userId, email: principal.email } : null;
}

/**
 * The absolute link an invitation email carries. Built from NEXT_PUBLIC_APP_URL,
 * which on production falls back to the project's production domain, never a
 * per-deployment *.vercel.app address an invitee would meet a login wall on.
 */
export function invitationUrl(token: string): string {
  return new URL(invitePath(token), env.NEXT_PUBLIC_APP_URL).toString();
}

/** The package's buckets on this project's limiter (Upstash when configured). */
const limit: RateLimiter = async ({ bucket, key }) => {
  const policy = TENANCY_RATE_LIMITS[bucket];
  const verdict = await limiter.limit({ key: \`tenancy:\${bucket}:\${key}\`, policy });
  if (verdict.allowed) return { allowed: true };
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((verdict.resetAt.getTime() - Date.now()) / 1000)),
  };
};

function requestFacts(req: Request): RequestFacts {
  return { ipAddress: clientIpFromHeaders(req.headers), userAgent: req.headers.get("user-agent") };
}

async function onError(error: unknown, req: Request): Promise<void> {
  await reportError({
    error,
    source: "route",
    url: req.url,
    requestId: resolveRequestId(req.headers),
  });
}

/** What a test swaps: who is calling, and which addresses they've verified. */
export interface TenancyHandlerOverrides {
  readonly principal?: (req: Request) => Promise<TenancyPrincipal | null>;
  readonly verifiedEmails?: (req: Request) => Promise<readonly string[]>;
}

/**
 * After the invitation is saved: a failed email never un-sends it — the team
 * page hands the inviter the link to copy instead. Only "sent" counts as an
 * email (the package's per-address limits, and the inviter's "We emailed …",
 * are read from those alone); "skipped", "failed" or a throw frees the
 * address at once.
 */
const deliverInvitation: NonNullable<CreateTenancyHandlersOptions["deliverInvitation"]> = async (input) => {
  const outcome = await sendInvitationEmail({
    to: input.to,
    tenantId: input.tenantId,
    tenantName: input.companyName,
    invitedBy: input.invitedBy,
    roleName: input.roleName,
    url: input.url,
    expiresAt: input.expiresAt,
    invitationId: input.invitationId,
  });
  return { status: outcome.status };
};

export function buildTenancyHandlers(overrides: TenancyHandlerOverrides = {}): TenancyHandlers {
  return createTenancyHandlers({
    tenancy,
    principal: overrides.principal ?? (() => requestPrincipal()),
    verifiedEmails: overrides.verifiedEmails ?? (() => verifiedEmails()),
    invitationUrl,
    // Only when this project can send mail (the email package AND a
    // RESEND_API_KEY): one that can't is never told it emails, so no
    // invitation ever waits on an email that was never going to go — the
    // inviter gets the link, every time.
    ...(invitationEmailsConfigured ? { deliverInvitation } : {}),
    limit,
    requestFacts,
    onError,
  });
}

/**
 * A company's recent activity for the operator console, newest first, in
 * plain words: the action's label, who did it, and what it changed ("Jake:
 * Member → Admin") — the words come from the tenancy package, which wrote
 * the metadata.
 */
async function recentAudit(input: { readonly tenantId: string; readonly limit: number }): Promise<readonly AuditLineWire[]> {
  const rows = await db
    .select({
      at: auditLog.createdAt,
      action: auditLog.action,
      sensitive: auditLog.isSensitive,
      metadata: auditLog.metadata,
      actorName: users.displayName,
      actorEmail: users.email,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(eq(auditLog.tenantId, input.tenantId))
    .orderBy(desc(auditLog.createdAt))
    .limit(input.limit);
  return rows.map((row) => ({
    at: row.at.toISOString(),
    action: row.action,
    label: auditRegistry.has(row.action) ? auditRegistry.get(row.action).label : row.action,
    actor: row.actorName ?? row.actorEmail ?? null,
    sensitive: row.sensitive,
    detail: describeTenancyAuditEntry(row.action, row.metadata),
  }));
}

export function buildTenancyOperatorHandlers(
  overrides: Pick<TenancyHandlerOverrides, "principal"> = {},
): TenancyHandlers {
  return createTenancyOperatorHandlers({
    tenancy,
    principal: overrides.principal ?? (() => requestPrincipal()),
    recentAudit,
    limit,
    requestFacts,
    onError,
  });
}
`;
}

// ---------------------------------------------------------------------------
// src/server/tenancy-logo.ts — where a company's logo is kept
// ---------------------------------------------------------------------------

export function renderTenancyLogo(answers: Answers): string {
  const scope = answers.scope;
  if (!answers.includeStorage) {
    return `import type { LogoStore } from "${scope}/tenancy/server";

/**
 * Where a ${tenantLabel(answers).toLowerCase()}'s logo would be kept. Nowhere:
 * ${answers.projectName} was generated without file storage, so the settings page says
 * logo uploads aren't switched on — before anyone picks a file — and the
 * rest of the branding (the colour) works as normal. \`create-app add storage\`
 * wires it in.
 */
export const tenancyLogoStore: LogoStore | undefined = undefined;
`;
  }
  return `import type { LogoStore } from "${scope}/tenancy/server";
import { getBlobStore } from "./blob-store";

/**
 * Where a ${tenantLabel(answers).toLowerCase()}'s logo is kept: the project's blob store (the same one
 * the file library uses). Undefined until BLOB_READ_WRITE_TOKEN is set — the
 * settings page then says uploads aren't switched on yet instead of failing
 * after someone picked a file. The tenancy package checks the caller, the
 * size and the file's real type before anything is stored here.
 */
const blobStore = getBlobStore();

export const tenancyLogoStore: LogoStore | undefined = blobStore
  ? {
      put: async ({ pathname, bytes, contentType }) => {
        const stored = await blobStore.put(pathname, bytes, { contentType });
        return { url: stored.url, key: stored.pathname };
      },
      delete: async (key) => {
        await blobStore.delete(key);
      },
    }
  : undefined;
`;
}

// ---------------------------------------------------------------------------
// src/components/CompanySwitcherSlot.tsx and src/components/CompanyGate.tsx
// ---------------------------------------------------------------------------

export function renderCompanySwitcherSlot(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const props = companies
    ? `session={session} baseUrl={TENANCY_API} noun={NOUN} reloadHref={AFTER_AUTH_PATH}`
    : `session={session} baseUrl={TENANCY_API} noun={NOUN} reloadHref={AFTER_AUTH_PATH} createHref={null} settingsHref={null}`;
  return `import type { Principal } from "${scope}/auth";
import { CompanySwitcher } from "${scope}/tenancy-widget";
import { sessionToWire, type SessionState } from "${scope}/tenancy/server";
import { currentPrincipal } from "@/server/auth";
import { tenancy } from "@/server/tenancy";
import { AFTER_AUTH_PATH, NOUN, TENANCY_API } from "@/tenancy";

/**
 * The ${tenantLabel(answers).toLowerCase()} switcher in the header: which one you're in, and the others
 * you belong to. The choice is remembered per person; a ${tenantLabel(answers).toLowerCase()} they were
 * removed from drops out of the list on their next request.
 *
 * A SERVER component that reads the session and hands it to the package's
 * <CompanySwitcher>, so the header renders without a loading flash.
 * ${companies ? `Companies mode: the menu also offers "Create another ${tenantLabel(answers).toLowerCase()}" and the settings link.` : "Single-business mode: no \"create another\" and no company settings — and the switcher renders nothing at all for someone with one workspace, so most people never see it."}
 *
 * Asking for the principal on every signed-in page view is deliberate: the
 * first page after sign-up is what sets a person up (see auth.ts). And the
 * whole thing is in a try/catch — the header must never fail a page, so a
 * database that can't answer renders no switcher rather than an error.
 */
export async function CompanySwitcherSlot({
  principal: given,
  session: resolved,
}: {
  /** The header has usually loaded the principal already; pass it to save the query. */
  readonly principal?: Principal | null;
  /**
   * The header resolves the session ONCE (it needs the active ${tenantLabel(answers).toLowerCase()} for its
   * own permission-filtered links); pass it so this slot doesn't resolve it
   * again. Absent: the slot resolves it itself.
   */
  readonly session?: SessionState | null;
} = {}) {
  try {
    const principal = given === undefined ? await currentPrincipal() : given;
    if (!principal) return null;
    const session = sessionToWire(resolved ?? (await tenancy.resolveSession({ userId: principal.userId })));
    return <CompanySwitcher ${props} />;
  } catch {
    return null;
  }
}
`;
}

export function renderCompanyGate(answers: Answers): string {
  const scope = answers.scope;
  return `import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import type { Principal } from "${scope}/auth";
import { CompanySuspended, type CompanyWire } from "${scope}/tenancy-widget";
import { companyChoiceToWire, companyToWire } from "${scope}/tenancy/server";
import { Notice } from "@/components/ui";
import { env } from "@/env";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions, loadTenantPermissions } from "@/server/permissions";
import { tenancy } from "@/server/tenancy";
import { NOUN, ONBOARDING_HREF, STAFF_HOME, TENANCY_API } from "@/tenancy";

/** What a page inside the gate gets: who, which ${tenantLabel(answers).toLowerCase()}, and what they may do there. */
export interface CompanyGateContext {
  readonly principal: Principal;
  readonly company: CompanyWire;
  readonly can: readonly string[];
}

/**
 * Every ${tenantLabel(answers).toLowerCase()} page starts here, and in this order:
 *
 *   1. Signed out → sign in, and come back to this page.
 *   2. No ${tenantLabel(answers).toLowerCase()} → onboarding (staff with no ${tenantLabel(answers).toLowerCase()} of their own go to
 *      the admin console instead — the platform owner shouldn't be nudged into
 *      creating a fake customer). Onboarding tells someone who was removed
 *      which ${tenantLabel(answers).toLowerCase()} they were removed from.
 *   3. Suspended → the package's suspended screen: "This ${tenantLabel(answers).toLowerCase()} is
 *      suspended", where to write (SUPPORT_EMAIL, else BOOTSTRAP_ADMIN_EMAIL),
 *      and a way into any other ${tenantLabel(answers).toLowerCase()} they belong to.
 *   4. Missing the page's permission → a plain notice saying who can change it.
 *   5. Otherwise, the page — given the ${tenantLabel(answers).toLowerCase()} the SESSION chose. A page
 *      never reads a ${tenantLabel(answers).toLowerCase()} id from the URL.
 *
 * EVERY ${tenantLabel(answers).toUpperCase()} PAGE CALLS THIS ITSELF. Don't put it in a layout: a
 * layout doesn't re-render on client navigation, and "the parent checked" is
 * not something anything enforces. The routes the page's components call check
 * again on every request.
 */
export async function CompanyGate(props: {
  /** This page's path, for the sign-in round trip. */
  readonly path: string;
  /** The tenant permission the page needs, e.g. "tenant.view". */
  readonly permission?: string;
  readonly children: (ctx: CompanyGateContext) => ReactNode;
}): Promise<ReactNode> {
  const principal = await currentPrincipal();
  if (!principal) redirect(\`/sign-in?redirect_url=\${encodeURIComponent(props.path)}\`);

  const session = await tenancy.resolveSession({ userId: principal.userId });

  if (session.state === "needs-onboarding") {
    const isStaff = (await loadStaffPermissions({ principal })) !== null;
    redirect(isStaff ? STAFF_HOME : ONBOARDING_HREF);
  }

  if (session.state === "suspended") {
    return (
      <main className="mx-auto max-w-2xl px-6 py-10">
        <CompanySuspended
          companyName={session.company.name}
          companies={session.companies.map(companyChoiceToWire)}
          baseUrl={TENANCY_API}
          supportEmail={env.SUPPORT_EMAIL ?? env.BOOTSTRAP_ADMIN_EMAIL ?? null}
          noun={NOUN}
        />
      </main>
    );
  }

  const company = companyToWire(session.company);
  const can = (await loadTenantPermissions({ principal, tenantId: company.id }))?.toArray() ?? [];
  if (props.permission !== undefined && !can.includes(props.permission)) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-10">
        <Notice tone="warn" title="You don't have access to this page">
          {\`Ask the owner of \${company.name} to change your role.\`}
        </Notice>
      </main>
    );
  }

  return props.children({ principal, company, can });
}
`;
}
