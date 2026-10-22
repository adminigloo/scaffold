import { join } from "node:path";
import { consumerProduct, tenantLabel, tenantLabelPlural, type Answers } from "./answers.js";
import { personalPlans } from "./personal-plans-emit.js";
import { plansEnforced, sellsPlans } from "./plans-emit.js";
import { companiesMode } from "./tenancy-emit.js";

/**
 * WHAT AN UPGRADE LOSES (review: answer switches deleted tables, companies
 * and plan checks with no warning, then said to run `pnpm db:migrate`).
 *
 * Three kinds of loss, and none of them is a file:
 *
 *   tables      a package that leaves src/db/schema.ts takes its tables with
 *               it — the next `pnpm db:generate` writes DROP TABLE … CASCADE
 *               for every one, and `pnpm db:migrate` deletes them and every
 *               row in them. Read off the two schema modules themselves (what
 *               the project had, what it gets), so a version upgrade that
 *               drops a package is caught exactly as a switch is.
 *   accounts    companies <-> one account per person: every company, its
 *               members and its plan stay in the database with nothing left
 *               to read them (or the other way round).
 *   plan check  a check that stops: a company's plan, a person's plans, the
 *               paid-feature questions code of yours asks, one person per
 *               account.
 *
 * `upgrade` refuses any of them unless `--allow-data-loss` says so, and lists
 * every one either way.
 */

/**
 * Every table each package's schema module exports — what drizzle-kit creates
 * for it, and DROPS when the package leaves src/db/schema.ts. Checked against
 * each package's built schema module (upgrade-losses.test.ts), so a table a
 * package adds can't be missing here.
 */
export const PACKAGE_TABLES: Readonly<Record<string, readonly string[]>> = {
  auth: ["identity_webhook_events", "users"],
  tenancy: ["tenant_invitations", "tenant_members", "tenant_retired_slugs", "tenant_slug_changes", "tenants"],
  permissions: ["principal_override", "principal_role", "role_template", "role_template_grant"],
  observability: ["audit_log", "error_log"],
  stripe: ["stripe_connected_accounts", "stripe_events"],
  catalog: ["product_grants", "product_variants", "products"],
  commerce: ["discount_codes", "order_items", "order_shipments", "orders", "store_alerts", "store_checkouts", "store_settings"],
  billing: ["entitlements", "plans", "subscriptions"],
  ai: ["ai_usage"],
  email: ["email_events"],
  // create-app 0.40: each person's email choices and the digests' ledger.
  digest: ["digest_preferences", "digest_subscriptions", "digest_sends"],
  feedback: [
    "feedback_boards",
    "feedback_categories",
    "feedback_client_keys",
    "feedback_epics",
    "feedback_messages",
    "feedback_statuses",
    "feedback_ticket_events",
    "feedback_tickets",
    "feedback_uploads",
  ],
  "seo-reports": ["seo_reports"],
  notifications: ["notification_choices", "notification_routing", "notifications"],
  storage: ["stored_files"],
  assistant: [
    "assistant_change_log",
    "assistant_config_version",
    "assistant_conversations",
    "assistant_drafts",
    "assistant_eval_results",
    "assistant_eval_runs",
    "assistant_glossary",
    "assistant_goldens",
    "assistant_messages",
    "assistant_page_doc_versions",
    "assistant_page_docs",
    "assistant_pending_actions",
    "assistant_section_versions",
    "assistant_sections",
    "assistant_tenant_rules",
  ],
  analytics: [
    "analytics_annotations",
    "analytics_crawler_hits",
    "analytics_events",
    "analytics_page_views",
    "analytics_rate",
    "analytics_salts",
    "analytics_sessions",
    "analytics_sites",
    "analytics_websites",
  ],
  audience: ["aig_audience_links", "aig_audience_marks", "aig_audience_rules", "aig_audience_runs"],
  estimator: [
    "estimator_client_keys",
    "estimator_components",
    "estimator_estimate_items",
    "estimator_estimates",
    "estimator_option_values",
    "estimator_options",
    "estimator_photos",
    "estimator_product_components",
    "estimator_products",
    "estimator_quote_tokens",
    "estimator_settings",
    "estimator_takeoffs",
  ],
  scheduling: [
    "scheduling_availability",
    "scheduling_bookings",
    "scheduling_drive_cache",
    "scheduling_resources",
    "scheduling_settings",
    "scheduling_visit_tokens",
  ],
  invoicing: ["invoice_card_alerts", "invoice_checkouts", "invoice_items", "invoice_payments", "invoices"],
  comms: ["comms_messages", "comms_scheduled", "comms_templates"],
  aeo: ["aeo_checks", "aeo_profiles", "aeo_queries"],
  booking: [
    "booking_availability",
    "booking_blackouts",
    "booking_bookings",
    "booking_events",
    "booking_exceptions",
    "booking_hosts",
    "booking_types",
  ],
  customers: ["customer_addresses", "customer_links", "customer_merges", "customer_notices", "customers"],
};

/** Where every project's schema module lives, as a plan's file map keys it. */
export const SCHEMA_MODULE_PATH = join("src", "db", "schema.ts");

/**
 * The packages a schema module hands drizzle-kit, read off the module itself:
 * one `export * from "<scope>/<package>/schema";` line each. Every create-app
 * since the first writes them this way; the clash re-export (`export {
 * InvalidTableNameError } from …`) is not a package's tables and isn't read.
 */
export function schemaOwnersIn(schemaModule: string | undefined, scope: string): readonly string[] {
  if (schemaModule === undefined) return [];
  const owners: string[] = [];
  const prefix = `${scope}/`;
  for (const match of schemaModule.matchAll(/^export \* from "([^"]+)\/schema";\s*$/gm)) {
    const spec = match[1] ?? "";
    if (spec.startsWith(prefix)) owners.push(spec.slice(prefix.length));
  }
  return owners;
}

export interface DroppedTables {
  /** The package that leaves src/db/schema.ts. */
  readonly owner: string;
  readonly tables: readonly string[];
}

export type AccountKind = "companies" | "people";

export interface UpgradeLosses {
  /** What `pnpm db:generate` will DROP, by package. */
  readonly droppedTables: readonly DroppedTables[];
  /** Companies <-> one account per person; null when it doesn't change. */
  readonly accounts: { readonly from: AccountKind; readonly to: AccountKind } | null;
  /** Each check that stops, in plain words (empty when none does). */
  readonly planCheck: readonly string[];
}

export const NO_LOSSES: UpgradeLosses = { droppedTables: [], accounts: null, planCheck: [] };

export function losesAnything(losses: UpgradeLosses): boolean {
  return losses.droppedTables.length > 0 || losses.accounts !== null || losses.planCheck.length > 0;
}

/** Every table the upgrade drops, flat and sorted. */
export function droppedTableNames(losses: UpgradeLosses): readonly string[] {
  return losses.droppedTables.flatMap((each) => each.tables).sort();
}

/**
 * What going from `stored` (and the schema module the project was made with)
 * to `answers` (and this version's) loses. `oldSchema`/`newSchema` are the two
 * generated src/db/schema.ts files; a package that leaves it is dropped
 * whether a switch or the version took it out.
 */
export function upgradeLosses(input: {
  readonly stored: Answers;
  readonly answers: Answers;
  readonly oldSchema: string | undefined;
  readonly newSchema: string | undefined;
}): UpgradeLosses {
  const { stored, answers } = input;
  const before = schemaOwnersIn(input.oldSchema, stored.scope);
  const after = new Set(schemaOwnersIn(input.newSchema, answers.scope));
  const droppedTables: DroppedTables[] = [];
  for (const owner of before) {
    if (after.has(owner)) continue;
    // A package this version doesn't know: its tables can't be named, but it
    // still goes — say so rather than drop it silently.
    droppedTables.push({ owner, tables: PACKAGE_TABLES[owner] ?? [`every table of ${stored.scope}/${owner}`] });
  }

  const kindOf = (a: Answers): AccountKind => (companiesMode(a) ? "companies" : "people");
  const accounts = kindOf(stored) === kindOf(answers) ? null : { from: kindOf(stored), to: kindOf(answers) };

  const noun = tenantLabel(stored).toLowerCase();
  const planCheck: string[] = [];
  if (plansEnforced(stored) && !plansEnforced(answers)) {
    planCheck.push(
      `each ${noun}'s plan stops being checked: the free trial, the plan's limits (people, storage and the rest) and pausing a ${noun} whose plan ended all go`,
    );
  }
  if (personalPlans(stored) && !personalPlans(answers)) {
    planCheck.push("each person's plans stop being checked: what someone pays for no longer decides what they may use");
  }
  if (sellsPlans(stored) && !sellsPlans(answers)) {
    planCheck.push(
      "requireEntitlement, withEntitlement and <Entitled> (src/server/access.ts, src/components/Entitled.tsx) are removed, so any page or procedure of yours that asks them stops building",
    );
  }
  if (consumerProduct(stored) && !consumerProduct(answers)) {
    planCheck.push(
      "accounts can be shared again: the limit of one person per account goes, and each account's owner can invite people into it — and onto what it pays for",
    );
  }
  return { droppedTables, accounts, planCheck };
}

/**
 * The sentences that say what an upgrade loses — the refusal's body, and
 * (with --allow-data-loss) what `upgrade` prints before anything else.
 */
export function describeLosses(stored: Answers, answers: Answers, losses: UpgradeLosses): string[] {
  const out: string[] = [];
  if (losses.droppedTables.length > 0) {
    const names = droppedTableNames(losses);
    out.push(
      `It DROPS ${names.length} table${names.length === 1 ? "" : "s"}, and every row in them: \`pnpm db:generate\` writes a migration ` +
        `with DROP TABLE … CASCADE for each, and \`pnpm db:migrate\` runs it — ` +
        losses.droppedTables.map((each) => `${each.owner} (${each.tables.join(", ")})`).join("; ") +
        ".",
    );
    const shopGone = losses.droppedTables.some((each) => each.owner === "catalog" || each.owner === "commerce");
    if (shopGone && answers.businessModel === "subscription") {
      out.push(
        "Those are the shop's: its products, orders, discounts and shipments. If anything was ever sold through it, keep the shop " +
          "instead (`--set businessModel=both`).",
      );
    }
  }
  if (losses.accounts !== null) {
    const noun = tenantLabel(losses.accounts.from === "companies" ? stored : answers).toLowerCase();
    const plural = tenantLabelPlural(losses.accounts.from === "companies" ? stored : answers).toLowerCase();
    out.push(
      losses.accounts.from === "companies"
        ? `It ends the ${plural}: from here each person signs in to an account of their own. Every ${noun} stays in the database — ` +
            `its members, its settings, its plan and what it made — with nothing left to read it: the ${noun} pages (/app, /dashboard, ` +
            `/onboarding, /settings/company, /t/<web address>) are removed, and nobody can open a ${noun} again. A ${noun} that pays ` +
            "for a plan keeps being charged at Stripe until you cancel it there."
        : `It brings in ${plural}: from here each person signs up into a ${noun} they name or are invited to, and plans are a ` +
            `${noun}'s. Each person's own account stays, with what it holds and what it pays for — but nothing reads a personal ` +
            `account's plan any more, so anyone paying on one keeps being charged at Stripe until you move or cancel it there.`,
    );
  }
  for (const check of losses.planCheck) out.push(`The plan check changes: ${check}.`);
  return out;
}

/** Why `upgrade` stopped, and how to go ahead (nothing was written). */
export function lossRefusal(stored: Answers, answers: Answers, losses: UpgradeLosses, switching: boolean): string {
  return [
    `This ${switching ? "switch" : "upgrade"} loses things that can't be undone, so it stopped before writing anything:`,
    "",
    ...describeLosses(stored, answers, losses).map((line) => `  - ${line}`),
    "",
    "Nothing was changed. If that is what you want, run it again with --allow-data-loss — and export anything you want to keep " +
      "before `pnpm db:migrate`, which can't be undone.",
  ].join("\n");
}
