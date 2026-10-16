import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  assertAnswersCompatible,
  deferredUntilDeployedFor,
  isPersonalWorkspaceOnly,
  optionalEnvFor,
  overlayNamesFor,
  packagesFor,
  requiredEnvFor,
  tenantLabel,
  tenantLabelPlural,
  type Answers,
} from "./answers.js";
import {
  buildManifest,
  MANIFEST_FILENAME,
  renderManifest,
  type ProjectManifest,
} from "./manifest.js";
import { versionRangeFor } from "./versions.js";
import { assertCapabilitiesAreProvable } from "./capabilities.js";
import {
  renderCompanyGate,
  renderCompanySwitcherSlot,
  renderSetupChecklist,
  renderTenancyConstants,
  renderTenancyHandlers,
  renderTenancyLogo,
  renderTenancyServer,
  renderTenantSettings,
} from "./tenancy-emit.js";
import {
  renderProcedureScopesTest,
  renderInviteAcceptRouteTest,
  renderInviteEmailRouteTest,
  renderProvisioningTest,
  renderTenantIsolationTest,
} from "./tenancy-proofs-emit.js";
import { renderProjectReadme } from "./readme-emit.js";
import { renderDeploymentUpgradeNotes, UPGRADE_NOTES_MARKER } from "./upgrade-notes.js";
import { assertNoPrerenderedAuthRoutes } from "./prerender.js";
import {
  COMPANY_CRONS_MARKER,
  COMPANY_EMAIL_MARKER,
  DEPLOYMENT_SINGLE_REGIONS,
  PRO_CRONS_MARKER,
  replaceDeploymentRegion,
  hasFieldService,
  renderDeploymentCompanyNotes,
  renderCommsCron,
  renderCommsGlue,
  renderCompanyLinks,
  renderCompanyRoutes,
  renderCompanySetup,
  renderEstimatorFeaturesCompanies,
  renderEstimatorNotifyCompanies,
  renderInvoicingGlue,
  renderPublicCompanyGate,
  renderSchedulingNotifyCompanies,
  renderStaffAccess,
  renderTenantRoles,
} from "./features-emit.js";
import {
  renderCompanyAlertsTest,
  renderCompanyCronsTest,
  renderCompanyEmailTest,
  renderCompanyFilesTest,
  renderCompanyRows,
  renderFeatureIsolationTest,
  renderGlueImportsTest,
  renderStaffFilesTest,
} from "./feature-proofs-emit.js";
import {
  ALERTS_FILES_MARKER,
  renderDeploymentAlertsFiles,
  hasFileRecords,
  renderAlerts,
  renderAlertsBellSlot,
  renderAlertsCron,
  renderAlertsLinks,
  renderAlertsRoutes,
  renderFiles,
  renderFilesRoutes,
  renderRecordFilesSlot,
  renderSetupFilesSlot,
  renderVisitFiles,
  teamTemplateKeys,
} from "./alerts-files-emit.js";

/** A companies project (`--tenant-noun` anything but `none`): each company runs the features itself. */
function isCompanies(answers: Answers): boolean {
  return answers.tenantNoun !== "none";
}

export interface EmitPlan {
  readonly targetDir: string;
  /** Relative path -> file contents. Everything the generator will write. */
  readonly files: ReadonlyMap<string, string>;
}

export class TargetNotEmptyError extends Error {
  readonly name = "TargetNotEmptyError";
  constructor(dir: string, offenders: readonly string[]) {
    super(
      `${dir} already contains ${offenders.join(", ")}. Generating here would ` +
        `overwrite work. Pick an empty directory, or delete those first.`,
    );
  }
}

/**
 * Files that may exist in the target without blocking generation.
 *
 * Running `git init` before generating is a normal thing to do, and so is a
 * README written while deciding on a name. Refusing those would push people
 * toward a --force flag, which is how the check stops meaning anything.
 */
const HARMLESS = new Set([".git", ".gitkeep", "README.md", ".DS_Store"]);

export async function assertTargetUsable(targetDir: string): Promise<void> {
  if (!existsSync(targetDir)) return;
  const entries = await readdir(targetDir);
  const offenders = entries.filter((e) => !HARMLESS.has(e));
  if (offenders.length > 0) throw new TargetNotEmptyError(targetDir, offenders);
}

/**
 * Token substitution over template files.
 *
 * Deliberately not a templating language. Every token is a value the CLI asked
 * for, and a template that can branch is a template that will grow branches —
 * the thing the additive-packages design exists to avoid.
 */
export function renderTokens(source: string, answers: Answers): string {
  const tokens: Record<string, string> = {
    __PROJECT_NAME__: answers.projectName,
    __SCOPE__: answers.scope,
    __SCOPE_NAME__: answers.scope.replace(/^@/, ""),
    __TENANT_LABEL__: tenantLabel(answers),
    __TENANT_LABEL_LOWER__: tenantLabel(answers).toLowerCase(),
    // From the lookup in answers.ts, never `${label}s`. "Companys" was on
    // screen in the admin sidebar, in the /admin/tenants heading and in its
    // empty state, because a suffix is not a pluralisation rule.
    __TENANT_LABEL_PLURAL__: tenantLabelPlural(answers),
    // The lowercase form exists because template copy needs it mid-sentence
    // and the only way to write it before was `__TENANT_LABEL_LOWER__s`, which
    // is the same broken suffix spelled in a template file where no test could
    // see it. It produced "No companys yet".
    __TENANT_LABEL_PLURAL_LOWER__: tenantLabelPlural(answers).toLowerCase(),
  };
  let out = source;
  for (const [token, value] of Object.entries(tokens)) {
    out = out.split(token).join(value);
  }
  return out;
}

/**
 * npm strips a literal `.gitignore` from a published tarball, and has done
 * forever. Template files that must land as dotfiles ship with a leading
 * underscore and are renamed on the way out — the alternative is a generated
 * project with no ignore file, which nobody notices until node_modules is
 * committed.
 *
 * AN ALLOWLIST, not a rule about leading underscores. Renaming every leading
 * underscore turned `src/server/routers/_app.ts` into `.app.ts` — a hidden file
 * that the app then failed to import, and that nobody would think to look for.
 * A missing entry here leaves a file named `_foo`, which is visible and
 * obviously wrong; the general rule failed silently in the other direction.
 */
const DOTFILE_TEMPLATES = new Set([
  "_gitignore",
  "_gitattributes",
  "_npmrc",
  "_github",
  "_vscode",
  "_editorconfig",
  "_nvmrc",
]);

export function targetNameFor(templateRelativePath: string): string {
  return templateRelativePath
    .split(sep)
    .map((segment) =>
      DOTFILE_TEMPLATES.has(segment) ? `.${segment.slice(1)}` : segment,
    )
    .join(sep);
}

export class OverlayCollisionError extends Error {
  readonly name = "OverlayCollisionError";
  constructor(path: string) {
    super(
      `An overlay tried to overwrite ${path}, which the base template owns. ` +
        `Overlays must be purely additive — silently replacing a base file is ` +
        `how two templates drift apart without anyone noticing.`,
    );
  }
}

export class OverlayMissingError extends Error {
  readonly name = "OverlayMissingError";
  constructor(name: string, dir: string) {
    super(
      `The answers selected the ${name} overlay and ${dir} is not there. ` +
        `This is a broken install of the generator rather than a bad answer: ` +
        `the overlays directory has to be in the published tarball's files ` +
        `list. ` +
        `Generating anyway would produce a project quietly missing a feature ` +
        `it asked for, and adminigloo.json would claim it has it.`,
    );
  }
}

/**
 * Resolve the selected overlay names to directories on disk.
 *
 * The selection itself is `overlayNamesFor` in answers.ts, so the manifest can
 * record the same list without this module having to be involved.
 */
async function overlayDirsFor(
  templateDir: string,
  answers: Answers,
): Promise<string[]> {
  const overlaysRoot = join(templateDir, "..", "overlays");
  return overlayNamesFor(answers).map((name) => {
    const dir = join(overlaysRoot, name);
    // Absent used to be skipped silently. That was survivable while the only
    // record of what a project had was the project, and is not now that
    // adminigloo.json states it: a skipped overlay would make the manifest
    // assert a capability that nothing on disk provides.
    if (!existsSync(dir)) throw new OverlayMissingError(name, dir);
    return dir;
  });
}

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(relative(base, full));
  }
  return out;
}

/** Where DEPLOYMENT.md's generated "Vercel needs these" table goes. */
export const DEPLOY_REQUIRED_ENV_MARKER = "<!-- adminigloo:deploy-required-env -->";

const DEPLOY_ENV_VALUES: Readonly<Record<string, readonly [preview: string, production: string]>> = {
  DATABASE_URL: ["Neon `staging` branch, pooled string", "Neon `production` branch, pooled string"],
  DATABASE_URL_UNPOOLED: ["Neon `staging` branch, direct string (no `-pooler`)", "Neon `production` branch, direct string"],
  CLERK_SECRET_KEY: ["Clerk Development instance, `sk_test_…`", "Clerk Production instance, `sk_live_…`"],
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: ["Clerk Development instance, `pk_test_…`", "Clerk Production instance, `pk_live_…`"],
  EMAIL_FROM: [
    "an address on your sending domain (needed even before Resend is set up)",
    "the same",
  ],
};

/** The table itself, one row per variable a deployment refuses to start without. */
export function renderDeployRequiredEnv(answers: Answers): string {
  const rows = deferredUntilDeployedFor(answers).map((name) => {
    const [preview, production] = DEPLOY_ENV_VALUES[name] ?? ["staging value", "production value"];
    return `| \`${name}\` | ${preview} | ${production} |`;
  });
  return ["| Variable | Preview scope (staging) | Production scope |", "| --- | --- | --- |", ...rows].join("\n");
}

/**
 * Build the complete set of files before writing any of them.
 *
 * Planning first means a failure halfway through leaves an empty directory
 * rather than a half-generated project that looks plausible enough to start
 * editing.
 */
export async function planEmit(
  templateDir: string,
  targetDir: string,
  answers: Answers,
): Promise<EmitPlan> {
  // A combination that would ship a broken business is refused before
  // anything is planned (see `assertAnswersCompatible`).
  assertAnswersCompatible(answers);
  const files = new Map<string, string>();

  // Base first, then overlays. An overlay ADDS files; it never rewrites one the
  // base owns, and `assertOverlaysAreAdditive` enforces that rather than
  // trusting it. Selecting the admin shell copies a directory — it does not
  // switch a flag that some emitted file then branches on.
  for (const dir of [templateDir, ...(await overlayDirsFor(templateDir, answers))]) {
    for (const relPath of await walk(dir)) {
      const target = targetNameFor(relPath);
      if (dir !== templateDir && files.has(target)) {
        throw new OverlayCollisionError(target);
      }
      const source = await readFile(join(dir, relPath), "utf8");
      files.set(target, renderTokens(source, answers));
    }
  }

  // DEPLOYMENT.md's "Vercel needs these or the build refuses to start" table,
  // from the env module's own deferred list (review R2 TB2-02): the only
  // other place a buyer met it was the generator's terminal output.
  const deployment = files.get("DEPLOYMENT.md");
  if (deployment !== undefined) {
    // And what a companies project's crons and emails do (Tenancy 2a): every
    // active company per run, and each company's emails under its own name —
    // generated, so a single business's copy says nothing about companies.
    const notes = renderDeploymentCompanyNotes(answers);
    // And, in a companies project, its own words in place of the template's
    // single-business paragraphs (/admin paths, the staff Crew role, the zone
    // variables), so the file never contradicts itself (review TB-6).
    let text = deployment
      .split(DEPLOY_REQUIRED_ENV_MARKER)
      .join(renderDeployRequiredEnv(answers))
      .split(COMPANY_CRONS_MARKER)
      .join(notes.crons)
      .split(COMPANY_EMAIL_MARKER)
      .join(notes.email)
      .split(PRO_CRONS_MARKER)
      .join(notes.proCrons)
      // Tenancy 2b-1: the alerts cron, the two Blob stores, the allowance,
      // the link key and what files cost — generated, empty without them.
      .split(ALERTS_FILES_MARKER)
      .join(renderDeploymentAlertsFiles(answers))
      // What a project made by an earlier create-app has to do by hand when
      // it runs `upgrade` (review BUY-01), for THIS project's features.
      .split(UPGRADE_NOTES_MARKER)
      .join(renderDeploymentUpgradeNotes(answers));
    for (const region of DEPLOYMENT_SINGLE_REGIONS) text = replaceDeploymentRegion(text, region, notes.regions[region]);
    files.set("DEPLOYMENT.md", text);
  }

  files.set("package.json", renderPackageJson(answers));
  // Not a template file, unlike every other config in the project root. What
  // Next must be told never to bundle depends on which packages were installed
  // — see `renderNextConfig` — and a static file could only carry that as an
  // `if`.
  files.set("next.config.ts", renderNextConfig(answers));
  // Generated for its crons — see `renderVercelJson`.
  files.set("vercel.json", renderVercelJson(answers));
  // Generated for the feedback mount, and only for it — see `renderRootLayout`
  // for why the one file that wraps every page cannot stay a template file
  // once any answer changes what wraps the pages.
  files.set(join("app", "layout.tsx"), renderRootLayout(answers));
  files.set(join("src", "env.ts"), renderEnvModule(answers));
  files.set(join("src", "db", "schema.ts"), renderSchemaModule(answers));
  files.set(
    join("src", "permissions", "catalog.ts"),
    renderPermissionsCatalog(answers),
  );
  files.set(join("src", "server", "routers", "_app.ts"), renderAppRouter(answers));
  // The audit vocabulary and the invitation mailer. Both generated for the same
  // reason `_app.ts` is: the fragments that exist and the packages that can send
  // mail depend on what was installed, and the alternative is an emitted file
  // holding an `if` about a feature it cannot see.
  files.set(join("src", "server", "audit.ts"), renderAuditRegistry(answers));
  files.set(
    join("src", "server", "invitation-mail.ts"),
    renderInvitationMail(answers),
  );
  // Only the --email variant talks to a provider and a log table, so only it
  // has a verdict to keep honest (a sent email stays "sent" when the log write
  // fails). The no-mail variant is a constant "skipped" with nothing to test.
  if (answers.includeEmail) {
    files.set(
      join("src", "server", "__tests__", "invitation-mail.test.ts"),
      renderInvitationMailTest(answers),
    );
  }
  // THE COMMS SENDERS AND THE COMMS CRON'S HOOKS. Generated, not copied, for
  // the invitation mailer's reason: whether a sender exists depends on
  // `--email`, and what the queue drain has to consult at send time depends
  // on which features queue messages. The senders used to be a static overlay
  // file shipping `commsSenders = {}` with the wiring in a comment — so a
  // project generated with --comms --email logged every message "skipped"
  // until a developer read a comment and typed it in (MN-04).
  if (answers.includeComms) {
    files.set(join("src", "server", "comms-senders.ts"), renderCommsSenders(answers));
    files.set(join("src", "server", "comms-hooks.ts"), renderCommsHooks(answers));
    // The Messages console's glue and the queue drain (Tenancy 2a). Both
    // generated: the console runs on the package's handlers in both modes
    // (D3) with a different authorize per mode, and the cron drains every
    // active company in a companies project and the one business otherwise.
    files.set(join("src", "server", "comms.ts"), renderCommsGlue(answers));
    files.set(join("app", "api", "cron", "comms", "route.ts"), renderCommsCron(answers));
  }
  // The ledger's glue (Tenancy 2a, D3): the package's handlers in both modes,
  // with the business per company or the fixed one, and the invoice email
  // only where comms is there to send it — so it is rendered, not copied.
  if (answers.includeInvoicing) {
    files.set(join("src", "server", "invoicing.ts"), renderInvoicingGlue(answers));
  }
  // The staff ladder invoicing and messages climb in a single-business
  // project: one key per job (D12) — and, since Tenancy 2b-1, alerts and
  // files. A companies project checks company roles instead
  // (src/server/company-routes.ts), so it never gets this file.
  if (
    !isCompanies(answers) &&
    (answers.includeInvoicing || answers.includeComms || answers.includeNotifications || answers.includeStorage)
  ) {
    files.set(join("src", "server", "staff-access.ts"), renderStaffAccess(answers));
  }
  // ALERTS AND FILES (Tenancy 2b-1, 13.5), both modes, generated: who the
  // people are, which packages produce alerts, which records files belong
  // to, and where each opens are all questions about OTHER answers, and the
  // route files and pages that import these modules carry no `if` about them.
  // See alerts-files-emit.ts.
  if (answers.includeNotifications) {
    files.set(join("src", "server", "alerts.ts"), renderAlerts(answers));
    files.set(join("src", "server", "alerts-routes.ts"), renderAlertsRoutes(answers));
    files.set(join("app", "api", "cron", "alerts", "route.ts"), renderAlertsCron(answers));
  }
  if (answers.includeStorage) {
    files.set(join("src", "server", "files.ts"), renderFiles(answers));
    files.set(join("src", "server", "files-routes.ts"), renderFilesRoutes(answers));
  }
  // The slots, in EVERY project (or every project with a record files can
  // belong to): the header renders the bell, /setup its file-store rows and
  // the record pages their "Photos and files" without an `if` — each slot is
  // the real thing or null, chosen here.
  files.set(join("src", "components", "AlertsBellSlot.tsx"), renderAlertsBellSlot(answers));
  files.set(join("src", "components", "SetupFilesSlot.tsx"), renderSetupFilesSlot(answers));
  if (hasFileRecords(answers)) {
    files.set(join("src", "components", "RecordFilesSlot.tsx"), renderRecordFilesSlot(answers));
  }
  if (answers.includeScheduling) {
    files.set(join("src", "server", "visit-files.ts"), renderVisitFiles(answers));
  }
  if (answers.includeScheduling || answers.includeEstimator) {
    files.set(join("src", "server", "alerts-links.ts"), renderAlertsLinks(answers));
  }
  // Who hears about each visit. Generated because the answer is "the comms
  // listener" with --comms and "nobody" without it, and the routes that call
  // it must not carry an `if` about which.
  if (answers.includeScheduling) {
    files.set(join("src", "server", "scheduling-notify.ts"), renderSchedulingNotify(answers));
  }
  // The estimator's glue, on the same footing. Who hears about an estimate
  // (the comms listener with --comms, nobody without), where a customer's photo
  // is kept (storage), what reads it (the --ai model), and what an accepted
  // quote turns into (a visit with --scheduling, an invoice with --invoicing)
  // are each a question about ANOTHER answer — so the modules that answer them
  // are rendered, and the static overlay's routes import them without an `if`.
  if (answers.includeEstimator) {
    files.set(join("src", "server", "estimator-notify.ts"), renderEstimatorNotify(answers));
    files.set(join("src", "server", "estimator-services.ts"), renderEstimatorServices(answers));
    files.set(join("src", "server", "estimator-features.ts"), renderEstimatorFeatures(answers));
  }
  // COMPANIES (Tenancy 1), in every project. Generated rather than copied
  // because each file differs by mode (companies or single-business), by the
  // project's noun, by whether there is file storage for logos, or by which
  // routers and tenant procedures are installed — and an emitted `if` about
  // any of those is what the generator refuses to write. See tenancy-emit.ts.
  files.set(join("src", "tenancy.ts"), renderTenancyConstants(answers));
  files.set(join("src", "server", "tenant-settings.ts"), renderTenantSettings(answers));
  files.set(join("src", "server", "setup-checklist.ts"), renderSetupChecklist(answers));
  files.set(join("src", "server", "tenancy.ts"), renderTenancyServer(answers));
  files.set(join("src", "server", "tenancy-handlers.ts"), renderTenancyHandlers(answers));
  files.set(join("src", "server", "tenancy-logo.ts"), renderTenancyLogo(answers));
  files.set(join("src", "components", "CompanySwitcherSlot.tsx"), renderCompanySwitcherSlot(answers));
  files.set(join("src", "components", "CompanyGate.tsx"), renderCompanyGate(answers));
  // The roles a company's people can hold, composed once (Tenancy 2a, D9):
  // the four core roles, plus Crew from scheduling in a companies project.
  // Read by the tenancy service AND by the seed, in both modes.
  files.set(join("src", "permissions", "roles.ts"), renderTenantRoles(answers));
  // EACH COMPANY RUNS THE FEATURES ITSELF (Tenancy 2a), companies only: whose
  // request a feature route is (the company id or web address in its path),
  // each company's links on this deployment, its first-time setup, and the
  // gate every public company page renders through. A single-business project
  // has none of these — its features run for the one business.
  if (isCompanies(answers)) {
    files.set(join("src", "server", "company-routes.ts"), renderCompanyRoutes(answers));
    files.set(join("src", "server", "company-links.ts"), renderCompanyLinks(answers));
    files.set(join("src", "server", "company-setup.ts"), renderCompanySetup(answers));
    files.set(join("src", "components", "PublicCompanyGate.tsx"), renderPublicCompanyGate(answers));
  }
  // The feature proofs (Tenancy 2a, section 12), companies only and per
  // installed feature: every feature ROUTE refuses another company's ids,
  // every cron serves every active company and skips a suspended one, and
  // each company's email goes out under its own name and reply-to.
  // Tenancy 2b-1: the isolation proof covers the alert and file routes too
  // (D17), so a companies project with either has it even with no
  // field-service feature.
  if (isCompanies(answers) && (hasFieldService(answers) || answers.includeNotifications || answers.includeStorage)) {
    files.set(join("src", "test", "company-rows.ts"), renderCompanyRows(answers));
    files.set(
      join("src", "server", "__tests__", "feature-isolation.test.ts"),
      renderFeatureIsolationTest(answers),
    );
  }
  // The alerts and files proofs (Tenancy 2b-1, 14.2–14.3), through the
  // project's own glue.
  if (isCompanies(answers) && answers.includeNotifications) {
    files.set(join("src", "server", "__tests__", "company-alerts.test.ts"), renderCompanyAlertsTest(answers));
  }
  if (isCompanies(answers) && answers.includeStorage) {
    files.set(join("src", "server", "__tests__", "company-files.test.ts"), renderCompanyFilesTest(answers));
  }
  // The single business's half of review SEC-03: its files run on the staff
  // ladder, so its member check (src/server/files.ts) is a different function
  // from a company's, and only this proof notices when that check stops
  // asking whether the link's maker may still see the file.
  if (!isCompanies(answers) && answers.includeStorage) {
    files.set(join("src", "server", "__tests__", "files-staff.test.ts"), renderStaffFilesTest(answers));
  }
  // Every glue module loads first and alone (13.10): a cycle read
  // half-initialised fails here, by name, instead of in production.
  if (answers.includeNotifications || answers.includeStorage) {
    files.set(join("src", "server", "__tests__", "glue-imports.test.ts"), renderGlueImportsTest(answers));
  }
  if (isCompanies(answers) && (answers.includeScheduling || answers.includeEstimator || answers.includeComms)) {
    files.set(join("src", "server", "__tests__", "company-crons.test.ts"), renderCompanyCronsTest(answers));
  }
  if (isCompanies(answers) && answers.includeComms && answers.includeEmail) {
    files.set(join("src", "server", "__tests__", "company-email.test.ts"), renderCompanyEmailTest(answers));
  }
  // The proofs every project runs on itself, in `pnpm test` (PGlite, no
  // database to set up): procedure scopes, company isolation, provisioning.
  files.set(
    join("src", "server", "__tests__", "procedure-scopes.test.ts"),
    renderProcedureScopesTest(answers),
  );
  files.set(
    join("src", "server", "__tests__", "tenant-isolation.test.ts"),
    renderTenantIsolationTest(answers),
  );
  files.set(
    join("src", "server", "__tests__", "provisioning.test.ts"),
    renderProvisioningTest(answers),
  );
  // Accepting by the link through the project's own route and Clerk wiring
  // (review R3 TB2-10): the verified addresses reach the package.
  files.set(
    join("src", "server", "__tests__", "invite-accept-route.test.ts"),
    renderInviteAcceptRouteTest(answers),
  );
  // "We emailed" only about an email that went, through the project's own
  // handlers and mailer, with and without the email package (review R4 SEC-T1-B).
  files.set(
    join("src", "server", "__tests__", "invite-email-route.test.ts"),
    renderInviteEmailRouteTest(answers),
  );
  // The nav and the landing page that reads it. Generated together and for the
  // same reason: /products exists only in a project that sells something and
  // /admin only in one with an admin shell, so neither the lists nor the page
  // can be a static file — and the overlays that own those routes are forbidden
  // from editing either.
  files.set(join("src", "nav.ts"), renderSiteNav(answers));
  // The admin sidebar, on the same footing as `src/nav.ts` and for the same
  // reason. It used to ship inside admin-minimal, where it could see neither
  // the admin-full pages layered on top of it nor the catalog-admin pages
  // beside it — so it linked to routes that were not there and omitted routes
  // that were. Written only when there is a shell to put it in: with
  // `--admin none` no layout imports it and an unused admin component in a
  // project that declined an admin panel is a file with nothing to say.
  if (answers.adminShell !== "none") {
    files.set(
      join("src", "components", "admin", "AdminNav.tsx"),
      renderAdminNav(answers),
    );
    // The panel's index, on the same footing as the sidebar beside it and for
    // the same reason. It counts orders, shipments and products in a project
    // that sells, and cannot so much as import those tables in one that does
    // not — so no single file in `admin-minimal` could have been right for
    // both, and the version that shipped there dodged the problem by counting
    // nothing at all and listing the viewer's permission keys instead.
    files.set(join("app", "admin", "page.tsx"), renderAdminDashboard(answers));
  }
  // The plan record — what a tier includes, what it costs, and what the `plans`
  // table has to hold for it. Written only where there is billing to describe:
  // it imports @scope/billing, which a `--model none` project never installs, so
  // a copy in `template/` would emit a module that cannot resolve its own
  // import. It is not in an overlay either, and that is the deliberate half —
  // the pricing page next to it is copied source, and a runtime package cannot
  // import from copied source, so a record living there would be invisible to
  // the entitlement check that has to honour what the page advertises.
  if (answers.businessModel !== "none") {
    files.set(join("src", "plans.ts"), renderPlanCatalog(answers));
  }
  // THE ORIENTATION PAGE, AND WHERE IT GOES.
  //
  // Under `(site)` either way, so it gets the same header and footer as every
  // other public page. The group is a routing no-op and it is the base template
  // that owns `app/(site)/layout.tsx`, which is what keeps the storefront and
  // marketing overlays additive while their pages inherit the chrome.
  //
  // WHICH PATH depends on whether this project has a public face. Two files
  // cannot both be `/`, and when a client is going to be shown this site the
  // page that belongs there is the landing page, not a list of file paths. So
  // the marketing overlay owns `app/(site)/page.tsx` and this moves next to
  // /setup — the other developer surface, footer-linked, and the one somebody
  // deletes at launch along with it. It is MOVED rather than dropped because it
  // is the only index of where anything is, including `src/plans.ts`, and a file
  // nothing points at is a file whose contents get retyped somewhere else.
  //
  // Written with `files.set` in both cases, so the overlay never has its page
  // silently overwritten by this line — which is the one failure the additive
  // check cannot see, because `OverlayCollisionError` compares an overlay
  // against the base template and everything below runs after both.
  files.set(
    answers.includeMarketing
      ? join("app", "(site)", "setup", "start", "page.tsx")
      : join("app", "(site)", "page.tsx"),
    renderHomePage(answers),
  );
  // What every page inherits — the base URL relative OG links resolve against,
  // the title template, and the one decision about whether this deployment may
  // be indexed. In EVERY project rather than behind the marketing answer: a
  // shared link that renders as a grey box and a staging preview that outranks
  // the client's real site are harms, and a harm must not be opt-in.
  files.set(join("src", "seo.ts"), renderSeoModule(answers));
  files.set(join("app", "llms.txt", "route.ts"), renderLlmsTxt(answers));
  files.set(join("app", "robots.ts"), renderRobots(answers));
  files.set(join("app", "sitemap.ts"), renderSitemap(answers));
  // The derived half of the legal pages: who else sees a customer's data, and
  // which clauses follow from what this project does. Written on the same
  // condition that copies the pages, because nothing else imports it — and that
  // condition is a disjunction rather than the marketing answer alone, since
  // Stripe will not activate an account without a public privacy policy and
  // terms whether or not there is a marketing site in front of them.
  if (answers.includeMarketing || answers.businessModel !== "none") {
    files.set(join("src", "legal.ts"), renderLegalRecord(answers));
  }
  files.set(".env.example", renderEnvExample(answers));
  // Written directly, not just as an example. It is gitignored, and it carries
  // the one value that is not a credential — so `pnpm install && pnpm dev`
  // works with no setup at all, which is the whole point of deferring the rest.
  files.set(".env.local", renderEnvLocal(answers));

  // The manifest, and then the human-readable view OF the manifest. In that
  // order and from that one object, so the two cannot disagree: SCAFFOLD.md
  // used to be built from `answers` alongside adminigloo.json rather than from
  // it, which is two derivations of the same facts and therefore two chances to
  // drift.
  const manifest = buildManifest(answers, await readGeneratorVersion(templateDir));
  files.set(MANIFEST_FILENAME, renderManifest(manifest));
  files.set("SCAFFOLD.md", renderScaffoldRecord(manifest));
  // What a buyer reads first (CA-10): what this is, the quick start, first run
  // and recovery, what the companies (or single-business) mode does and does
  // not include, and the packages. From the manifest, for SCAFFOLD.md's reason.
  files.set("README.md", renderProjectReadme(manifest));

  const plan: EmitPlan = { targetDir, files };

  // Every capability the manifest is about to claim, checked against the files
  // this plan actually contains. On EVERY generation rather than only under
  // test, for the same reason `assertPermissionScopes` runs here: the cost is a
  // handful of substring checks over files already in memory, and the failure
  // it prevents — a manifest asserting something no emitted file provides — is
  // silent in every project that ships with it. `ai.streaming` was that
  // failure for several releases.
  assertCapabilitiesAreProvable(plan, manifest.capabilities);

  // AND THAT EVERY PAGE IT CONTAINS CAN ACTUALLY BE BUILT BY THE PERSON WHO
  // RECEIVES IT. Here rather than in a test for the same reason as the line
  // above: a page under `app/(site)` that forces static rendering fails
  // `next build` only once Clerk is configured, so a check that runs against a
  // credential-free project — which is every check this repository had — cannot
  // see it. This one reads the plan, so credentials are not part of the
  // question. See `prerender.ts`.
  assertNoPrerenderedAuthRoutes(plan);

  return plan;
}

export class GeneratorVersionUnreadableError extends Error {
  readonly name = "GeneratorVersionUnreadableError";
  constructor(path: string, cause: unknown) {
    super(
      `Could not read the generator's own version from ${path}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        `Refusing to write a manifest that cannot say what produced it — ` +
        `an unattributed record is worse than none, because the whole point ` +
        `is diffing a copied file against the version it was copied from.`,
    );
  }
}

/**
 * The generator's own version, read from the package.json beside `template/`.
 *
 * Read rather than hardcoded, unlike the base package versions. Those describe
 * OTHER packages and can only be checked against the workspace by a test; this
 * one is right here, and a constant would need editing on every release —
 * a chore that gets skipped, after which every generated project claims to have
 * come from whichever version somebody last remembered to type in.
 */
async function readGeneratorVersion(templateDir: string): Promise<string> {
  const path = join(templateDir, "..", "package.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      version?: unknown;
    };
    if (typeof parsed.version !== "string" || parsed.version.length === 0) {
      throw new Error("no version field");
    }
    return parsed.version;
  } catch (error) {
    throw new GeneratorVersionUnreadableError(path, error);
  }
}

export async function writePlan(plan: EmitPlan): Promise<void> {
  for (const [relPath, contents] of plan.files) {
    const full = join(plan.targetDir, relPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents, "utf8");
  }
}

// The package version table moved to versions.ts, where the manifest can read
// it too. Re-exported so `emit.js` stays the one import path for everything the
// generator emits.
export {
  packageVersions,
  UnknownPackageVersionError,
  versionRangeFor,
} from "./versions.js";

/**
 * `pnpm dev` for a project that takes money.
 *
 * A SCRIPT RATHER THAN A COMMAND LINE, and the reason is a port. The line this
 * replaced was
 *
 *   concurrently -k "next dev" "stripe listen --forward-to localhost:3000/…"
 *
 * which writes the port down twice and lets one of them move. `next dev` with
 * no `--port` takes the next free port when 3000 is busy, so a second project
 * already running quietly relocates the app to 3001 while the listener keeps
 * forwarding to 3000: Stripe reports every delivery as delivered, nothing
 * arrives, and no order is ever written. `-k` compounded it — a machine with no
 * Stripe CLI exited that half instantly and took `next dev` down with it, so
 * `pnpm dev` did not start the app at all on a freshly generated project.
 *
 * `scripts/dev.ts` ships in the stripe overlay, resolves the port ONCE from
 * NEXT_PUBLIC_APP_URL and passes it to both halves, and treats the listener as
 * the optional half it is. It replaces `concurrently`, which is why that
 * dependency is gone.
 */
const STRIPE_DEV_SCRIPT = "tsx scripts/dev.ts";

/**
 * Third-party versions a generated project pins that a TEST holds to the
 * workspace, so the two can't drift.
 *
 * `pnpm` — the generated package.json's `packageManager` (TB-DEPLOY-02). Every
 * emitted workflow uses `pnpm/action-setup@v4` with no `version:`, and that
 * action stops with "No pnpm version is specified" when the project names
 * none. The scaffold's own root package.json names one, which is why the
 * scaffold's CI passed and a generated project's failed on its first push:
 * nothing deployed, nothing migrated, and the deploy-time seed never ran.
 * Pinned to the workspace root's `packageManager` by a test.
 *
 * `pglite` — the in-process Postgres the generated project's own isolation
 * and provisioning tests run on (src/server/__tests__). A devDependency, never
 * shipped; pinned to the workspace packages' devDependency by a test.
 */
export const THIRD_PARTY_PINS = {
  pnpm: "10.28.0",
  pglite: "^0.5.8",
} as const;

export function renderPackageJson(answers: Answers): string {
  const sells = answers.businessModel !== "none";
  const deps: Record<string, string> = {
    "@clerk/nextjs": "^7.6.4",
    "@neondatabase/serverless": "^1.1.0",
    "@t3-oss/env-nextjs": "^0.13.11",
    "@tanstack/react-query": "^5.90.16",
    // In lockstep, and pinned to the range the workspace catalog builds the
    // packages against rather than to @adminigloo/trpc's peer floor. The floor
    // says what still works; this says what was actually tested. A generated
    // project resolving an older 11.x than the one the .d.ts files were emitted
    // from is a mismatch nobody would think to look for.
    "@trpc/client": "^11.18.0",
    "@trpc/react-query": "^11.18.0",
    "@trpc/server": "^11.18.0",
    "drizzle-orm": "^0.45.2",
    next: "16.2.12",
    // A PEER OF @adminigloo/observability, which every project installs, and it
    // was missing from this list entirely. `createLogger` imports pino at the
    // top of the module, and observability is reachable from every server page
    // through the tRPC context — so the build resolves it or it does not build.
    // It resolved anyway, because pnpm and npm auto-install peers by default;
    // set `auto-install-peers=false`, which plenty of teams do, and a freshly
    // generated project fails at the first `next build` with a module it never
    // asked for by name. A peer is a dependency the app is required to declare,
    // not one somebody else's default setting happens to supply.
    pino: "^10.3.1",
    react: "19.2.4",
    "react-dom": "19.2.4",
    "server-only": "^0.0.1",
    superjson: "^2.2.1",
    zod: "^4.5.1",
  };
  if (answers.includeAi) {
    // The provider SDK, and the only new runtime dependency `--ai` adds. Not
    // hand-rolled over fetch like the Upstash adapter: a model API is a moving
    // surface with streaming, retries, typed events and a wire format that
    // changes, and the vendor's own client is the thing that stays in step with
    // it. Pinned to the major the route's event handling is written against —
    // `content_block_delta` narrowing and `finalMessage()` are both typed.
    deps["@anthropic-ai/sdk"] = "^0.122.0";
  }
  if (answers.includeFeedback) {
    // Screenshot storage for the intake route. The APP declares it, not
    // @__SCOPE_NAME__/feedback — the package takes an injected `storeFile` so
    // it never chooses a storage vendor, and the emitted route is the caller
    // that chose Vercel Blob. A package imported by an emitted file is a
    // package the manifest has to name; that is the pino rule.
    deps["@vercel/blob"] = "^2.8.0";
  }
  if (answers.includeStorage) {
    // The SDK src/server/files.ts hands to @__SCOPE_NAME__/storage's Vercel Blob
    // adapter (its `blobSdk` bridge, 6.2) — same rule and same vendor as
    // feedback's screenshots, declared by the app because the storage
    // package never imports an SDK. Assigning the same range twice when both
    // features are on is a no-op by design.
    deps["@vercel/blob"] = "^2.8.0";
  }
  if (answers.businessModel !== "none") {
    deps["stripe"] = "^22.6.0";
    // The Payment Element runs in the browser, so checkout needs the client SDK
    // as well as the server one.
    deps["@stripe/stripe-js"] = "^9.13.0";
    deps["@stripe/react-stripe-js"] = "^6.8.0";
  }
  for (const pkg of packagesFor(answers)) deps[pkg] = versionRangeFor(pkg);

  const devDeps: Record<string, string> = {
    // The isolation proof and the provisioning tests run the project's real
    // schema on an in-process Postgres — no database to set up, so they run in
    // `pnpm test` on every laptop and in CI.
    "@electric-sql/pglite": THIRD_PARTY_PINS.pglite,
    "@types/node": "^26.4.0",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    // Through `versionRangeFor` like every other package, not spelled out. It
    // was the one @adminigloo range written inline, so it was also the one the
    // drift test never looked at — a version pinned in a second place is a
    // version that will eventually be wrong in exactly one of them.
    [`${answers.scope}/testing`]: versionRangeFor(`${answers.scope}/testing`),
    "drizzle-kit": "^0.31.10",
    // Tailwind v4 folds in postcss and autoprefixer. Adding autoprefixer back
    // double-prefixes. These two ship in lockstep — a mismatched pair fails at
    // PostCSS load, before any page renders.
    tailwindcss: "^4.1.14",
    "@tailwindcss/postcss": "^4.1.14",
    // The seed script is TypeScript and is run directly, not built.
    tsx: "^4.23.5",
    typescript: "^5.9.3",
    vitest: "^4.1.11",
  };

  const manifest = {
    name: answers.projectName,
    version: "0.1.0",
    private: true,
    type: "module",
    // What `pnpm/action-setup` installs in every emitted workflow — see
    // THIRD_PARTY_PINS. Corepack reads it locally too.
    packageManager: `pnpm@${THIRD_PARTY_PINS.pnpm}`,
    scripts: {
      // The Stripe listener runs alongside `next dev` by default. Webhooks that
      // are only exercised in production are webhooks nobody has tested — and
      // it degrades to just the app on a machine with no Stripe CLI, rather
      // than refusing to start. See STRIPE_DEV_SCRIPT.
      dev: answers.businessModel === "none" ? "next dev" : STRIPE_DEV_SCRIPT,
      build: "next build",
      start: "next start",
      typecheck: "tsc --noEmit",
      test: "vitest run",
      "db:generate": "drizzle-kit generate",
      "db:migrate": "drizzle-kit migrate",
      "db:studio": "drizzle-kit studio",
      // Idempotent: re-run it after adding a permission to the catalog. It only
      // touches templates it created, never one you have customised.
      // --env-file because tsx, like drizzle-kit, does not read .env.local.
      "db:seed": "tsx --env-file=.env.local scripts/seed-roles.ts",
      // THE SAME SEED, FOR A DEPLOYED DATABASE: run by deploy.yml after every
      // migration (PC-09). No --env-file, for db:migrate:deploy's reason — the
      // file doesn't exist in CI and Node treats a missing one as fatal.
      "db:seed:deploy": "tsx scripts/seed-deploy.ts",
      // The way back in when nobody can open /admin: `pnpm admin:grant
      // you@example.com`. On a laptop it reaches the database in .env.local;
      // for production, run the "Admin grant" workflow in GitHub Actions.
      "admin:grant": "tsx scripts/admin-grant.ts",
      // Local-only demo data: a tenant, members on different templates, an
      // override and a sealed permission, so the checklist shows all three states.
      //
      // CHAINED WITH THE SHOP SEED in a project that sells something, rather
      // than left as a second command somebody has to know about. A generated
      // project had no products at all, which made /products an empty page,
      // /checkout unreachable and the simulated purchase button unclickable —
      // a whole capability behind a command nobody had been told to run. Two
      // scripts because `scripts/seed-shop.ts` imports the catalog and commerce
      // packages, which a `--model none` project never installs; one entry
      // point because the person seeding wants the demo, not a list of parts.
      //
      // THE PLAN CATALOGUE IS CHAINED IN AHEAD OF THE SHOP, and it is the one
      // link in this chain that is not a fixture: it writes the projection of
      // `src/plans.ts` into the `plans` table, so the pricing page and the
      // subscription screens have something to read. A generated project had an
      // empty `plans` table, which makes every one of them a blank page.
      "db:seed:demo": sells
        ? "tsx --env-file=.env.local scripts/seed-demo.ts && tsx --env-file=.env.local scripts/seed-plans.ts && tsx --env-file=.env.local scripts/seed-shop.ts"
        : "tsx --env-file=.env.local scripts/seed-demo.ts",
      // Separately runnable, because the catalogue is the half you re-seed
      // after buying everything in it, and re-running the people fixture to get
      // it back is a bigger hammer than the job needs.
      //
      // `db:seed:plans` is separate for a stronger reason than convenience. It
      // is the only script here that is safe — and intended — to run against a
      // deployed database: it writes no fictional people and books no orders,
      // it applies the record every environment already ships in its own source,
      // and the alternative is editing prices by hand in production. The other
      // two refuse outright unless they are pointed at localhost.
      ...(sells
        ? {
            "db:seed:plans": "tsx --env-file=.env.local scripts/seed-plans.ts",
            "db:seed:shop": "tsx --env-file=.env.local scripts/seed-shop.ts",
          }
        : {}),
      // The licence artifact of the feedback feature: creates the tenant if
      // its slug is new, prints the plaintext key exactly once, stores only
      // the hash. A script entry rather than a documented `pnpm tsx` line,
      // because the widget stays dark until this runs and a command nobody is
      // told about is a feature nobody has.
      ...(answers.includeFeedback
        ? {
            "feedback:issue-key":
              "tsx --env-file=.env.local scripts/issue-feedback-key.ts",
          }
        : {}),
      // No --env-file: this runs in CI where .env.local does not exist, and Node
      // treats a missing --env-file as fatal. The script loads it in a try/catch.
      "db:migrate:deploy": "tsx scripts/migrate.ts",
      "test:integration": "vitest run --project=integration",
    },
    dependencies: Object.fromEntries(Object.entries(deps).sort()),
    devDependencies: Object.fromEntries(Object.entries(devDeps).sort()),
    // pnpm 10 stopped running dependency install scripts unless they are named
    // here. Without it Next's image optimiser has no sharp binary and esbuild
    // has no platform binary, and both fail at the first build rather than at
    // install — where the warning that explains it has already scrolled past.
    pnpm: { onlyBuiltDependencies: ["esbuild", "sharp"] },
  };

  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * `vercel.json` for this project.
 *
 * GENERATED RATHER THAN COPIED FROM `template/`, for its `crons`. A project
 * with comms queues reminders that only a scheduled drain sends; the static
 * template shipped `"crons": []`, an overlay may not rewrite a base file, and so
 * every generated comms project queued reminders that nothing ever sent (the
 * 2026-09-23 sweep against gs-glass, which registered its drain). Daily, because
 * that is the one schedule Vercel's Hobby plan accepts — DEPLOYMENT.md says how
 * to tighten it on Pro. Byte-identical to the old template file when there is
 * nothing to schedule.
 *
 * Scheduling adds its own: the sweep that releases booking requests nobody
 * answered in time and tells the customer. It runs without comms too — an
 * expired request must stop showing as waiting whether or not anybody is
 * emailed about it.
 *
 * The estimator adds one for the same reason: quotes past their validity are
 * marked expired (and, with comms, the customer and the office are told), and
 * photos a customer uploaded but never sent are deleted after two days. The
 * follow-up on an unanswered quote is a comms message, so it goes out from the
 * comms drain.
 */
/**
 * When the comms cron runs on Vercel Hobby (once a day, in UTC): 14:00 UTC is
 * 7 AM Mountain Standard Time, early in a field-service business's day. It is
 * written into vercel.json AND into the scheduling listener's `reminderRuns`
 * (src/server/scheduling-notify.ts) from this one value, because the listener
 * queues each reminder for the last run at or before its time: a reminder
 * queued for 9 AM on a cron that runs at 7 AM used to go out the NEXT day — the
 * morning of the visit, past the change cutoff.
 */
export const COMMS_CRON_DAILY_AT_UTC = { hour: 14, minute: 0 } as const;

export function renderVercelJson(answers: Answers): string {
  const crons: Array<{ path: string; schedule: string }> = [];
  if (answers.includeComms) {
    crons.push({ path: "/api/cron/comms", schedule: `${COMMS_CRON_DAILY_AT_UTC.minute} ${COMMS_CRON_DAILY_AT_UTC.hour} * * *` });
  }
  if (answers.includeScheduling) {
    crons.push({ path: "/api/cron/scheduling", schedule: "0 13 * * *" });
  }
  if (answers.includeEstimator) {
    crons.push({ path: "/api/cron/estimator", schedule: "30 13 * * *" });
  }
  // Tenancy 2b-1 (13.8): the alerts cron (the time-based alerts, the email
  // retries, clean-up) after the features' own, and the files cron (the
  // purge, the move to private, the private-store check).
  if (answers.includeNotifications) {
    crons.push({ path: "/api/cron/alerts", schedule: "15 14 * * *" });
  }
  if (answers.includeStorage) {
    crons.push({ path: "/api/cron/files", schedule: "45 14 * * *" });
  }
  const config = {
    $schema: "https://openapi.vercel.sh/vercel.json",
    framework: "nextjs",
    git: { deploymentEnabled: { main: false, staging: false } },
    crons,
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * `next.config.ts` for this project.
 *
 * GENERATED RATHER THAN COPIED FROM `template/`, for one line of it. Every
 * other setting is the same in every project; `serverExternalPackages` is not,
 * because what has to be kept out of the bundler depends on which packages were
 * installed — and the emitted file has to state the answer as a literal list
 * rather than compute it, which is the rule this generator exists to hold.
 */
export function renderNextConfig(answers: Answers): string {
  const scope = answers.scope;

  // The order is the order they are explained in below. Sorting would put the
  // paragraph about email above the entry it describes.
  const external = ["@neondatabase/serverless"];
  if (answers.includeEmail) external.push(`${scope}/email`);

  const emailNote = answers.includeEmail
    ? `
  //
  // ${scope}/email, because \`${scope}/email/emails\` renders the message
  // bodies with React Email — which means \`react-dom/server\`. React ships a
  // \`react-server\` export condition for that module whose entire body is
  // \`throw new Error("react-dom/server is not supported in React Server
  // Components")\`, and everything Next bundles into the React Server
  // Component graph — server components AND route handlers — resolves under
  // that condition. From this project the renderer is reached through
  // \`src/emails/invitation.ts\`, the invitations router and \`_app.ts\` into
  // \`src/trpc/server.ts\`, which every server component calling \`api()\`
  // imports, so it is not one email that is at stake.
  //
  // WITHOUT THIS LINE IT STILL BUILDS, and that is the reason the line is
  // here rather than the reason it is not. Turbopack applies its
  // react-dom/server rule to project source and exempts anything under
  // node_modules, so an installed ${scope}/email is bundled into the RSC
  // chunks with the real Node build of the renderer inside it. The result
  // works, and it works because the bundler declined to look — a heuristic
  // about a path, one Next release away from being tightened. Naming the
  // package here makes it deliberate: \`renderToStaticMarkup\` leaves
  // .next/server entirely and Node loads the module at request time.
  //
  // It is not a way of stopping the render happening on the server. Composing
  // an email IS server work, it stays there, and it stays synchronous, exactly
  // as \`src/server/invitation-mail.ts\` calls it. What changes is only WHO
  // loads the module: Node, under node conditions where \`react-dom/server\`
  // is the real renderer, instead of the bundler under \`react-server\` where
  // it is a throw.
  //
  // An external has to be INSTALLED. Next matches on a resolved path
  // containing \`node_modules/${scope}/email/\`, so a package symlinked out of
  // a checkout — a \`link:\` dependency, a workspace on the side — is not
  // externalised, IS treated as project source, and fails the build with
  // "You're importing a component that imports react-dom/server".
  // \`transpilePackages\` does not rescue it either, because transpiling is
  // bundling. Install the package, or point at a packed tarball; do not link
  // it.`
    : "";

  return `import type { NextConfig } from "next";

// Importing the env module here is deliberate: it runs Zod validation during
// \`next build\`, so a missing or malformed variable fails the build rather than
// the first request that happens to touch it.
import "./src/env";

const config: NextConfig = {
  reactStrictMode: true,
  // Packages Next must NOT bundle, and must \`require\` from node_modules at
  // request time instead.
  //
  // @neondatabase/serverless, because the driver decides between a WebSocket
  // and an HTTP fetch by looking at the runtime it finds itself in, and a
  // bundled copy has already had that decision made for it.${emailNote}
  serverExternalPackages: [${external.map((name) => JSON.stringify(name)).join(", ")}],
  turbopack: {
    // Pin the workspace root to THIS project. Next walks up looking for a
    // lockfile, so a project generated anywhere below another one — a scratch
    // directory, a monorepo you happen to be sitting in — infers the wrong root
    // and warns on every build.
    root: import.meta.dirname,
  },
};

export default config;
`;
}

/**
 * `app/layout.tsx` for this project.
 *
 * GENERATED RATHER THAN COPIED FROM `template/`, for one mount. The feedback
 * widget has to wrap every page — reports come from the admin shell as much as
 * from the public site — and the root layout is the only file that wraps
 * everything. An overlay cannot patch it: overlays are strictly additive and
 * this is a base file, which is exactly what `OverlayCollisionError` exists to
 * prevent. So the layout joins `next.config.ts` in being written here, where
 * the one line that differs between projects can be a literal rather than a
 * conditional some emitted file carries forever.
 *
 * The widget WRAPPER ships in the feedback overlay (`src/components/
 * FeedbackWidget.tsx`); this file only decides whether to import and mount it.
 * A project generated without `--feedback` gets a layout with no trace of the
 * feature — no import of a package it never installed, no flag asking whether
 * one exists.
 */
export function renderRootLayout(answers: Answers): string {
  const feedbackImport = answers.includeFeedback
    ? `import { FeedbackWidget } from "@/components/FeedbackWidget";\n`
    : "";
  // Inside TRPCProvider, because the wrapper is a configuration check around
  // provider components and belongs with the other providers rather than
  // around them — and outside `children` either way, so every route group and
  // page in the project renders under it.
  const children = answers.includeFeedback
    ? "<FeedbackWidget>{children}</FeedbackWidget>"
    : "{children}";

  return `import { ClerkProvider } from "@clerk/nextjs";
${feedbackImport}import type { Metadata } from "next";
import type { ReactNode } from "react";
import { TRPCProvider } from "@/trpc/client";
import { env } from "@/env";
import { siteMetadata } from "@/seo";
import { AFTER_AUTH_PATH } from "@/tenancy";
import "./globals.css";

/**
 * Everything every page inherits: the base URL relative Open Graph links
 * resolve against, the title template, the social card defaults, and whether
 * this deployment may be indexed at all.
 *
 * FROM \`src/seo.ts\` RATHER THAN WRITTEN HERE, because two of those are derived
 * from the environment and one of them is a decision \`app/robots.ts\` has to
 * take identically. A \`title\` spelled out in this file was the whole of the
 * metadata for a long time, which meant every relative OG URL resolved against
 * localhost in production — a shared link rendered as a grey box, and nothing
 * inside the product could show you that.
 *
 * A page overrides a field by exporting its own \`metadata\`; anything it leaves
 * out falls through to this.
 */
export const metadata: Metadata = siteMetadata;

/**
 * ClerkProvider is mounted only when Clerk is actually configured.
 *
 * Not a feature flag — a runtime configuration check, and the two are different
 * things. ClerkProvider decodes the publishable key into a frontend API domain
 * and throws when it cannot, so on a laptop with no Clerk account yet EVERY
 * page 500s, including the setup page that would tell you what to do about it.
 * The first thing you would see after generating a project is a stack trace.
 *
 * On a deployment this branch is unreachable: \`env.ts\` marks the Clerk keys as
 * required once deployed, so a preview build without them fails at boot rather
 * than quietly rendering an app with no authentication.
 *
 * THE SIGN-IN AND SIGN-UP ADDRESSES ARE THIS SITE'S (TB-DEPLOY-11). Without
 * them, the "Sign up" link inside Clerk's sign-in card goes wherever the Clerk
 * dashboard's Paths point — by default Clerk's hosted page — and a new owner
 * then lands on the dashboard's after-sign-up address instead of
 * AFTER_AUTH_PATH, so they never meet onboarding. Every Clerk component in the
 * app inherits these.
 */
function AuthProvider({ children }: { children: ReactNode }) {
  if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) return <>{children}</>;
  return (
    <ClerkProvider
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl={AFTER_AUTH_PATH}
      signUpFallbackRedirectUrl={AFTER_AUTH_PATH}
    >
      {children}
    </ClerkProvider>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // \`suppressHydrationWarning\` on <html> only: the dark theme is pure CSS
    // (prefers-color-scheme), so nothing here reads the theme at runtime — but
    // browser extensions routinely stamp attributes on <html> before React
    // hydrates, and the resulting warning trains people to ignore the console.
    <html lang="en" suppressHydrationWarning>
      {/* Explicit background, from a token. A transparent body borrows whatever
          the browser paints, which in dark mode is white behind a dark page —
          visible as a flash on navigation and as white gutters on short pages,
          neither of which points at its own cause. */}
      <body className="min-h-dvh bg-canvas text-ink antialiased">
        <AuthProvider>
          <TRPCProvider>${children}</TRPCProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
`;
}

/**
 * A ready-to-run `.env.local`.
 *
 * Every credential is present but commented out, with where to get it. An empty
 * file would boot equally well and tell you nothing; a file listing what is
 * missing turns "read the README" into "uncomment the line".
 */
export function renderEnvLocal(answers: Answers): string {
  const port = 3000;
  const lines = [
    "# Local development. Gitignored, and already valid — `pnpm dev` runs as is.",
    "#",
    "# Everything below is commented out. Uncomment and fill one in whenever you",
    "# want the feature it unlocks; visit /setup to see what is on and what is off.",
    "# A malformed value still fails at boot, so a half-pasted key is caught here",
    "# rather than three screens later.",
    "",
    `NEXT_PUBLIC_APP_URL=http://localhost:${port}`,
    "",
    "# APP_ENV names the environment on any host that is not Vercel. Deliberately",
    "# NOT set here: `pnpm dev` is already recognised as local from NODE_ENV, and",
    "# a value in this file would follow a `next start` you ran to check the",
    "# production build. Set it in the DEPLOYMENT's own configuration —",
    "# APP_ENV=production or APP_ENV=staging on Docker, Fly, Railway, Render, ECS",
    "# or a VPS. A deployment that names itself gets deferred credentials",
    "# enforced, the localhost-URL guard, live-key acceptance on production, and",
    "# the first-admin grant bound to BOOTSTRAP_ADMIN_EMAIL. One that does not is",
    "# treated as an unlabelled deployment: safe, but with all of that off.",
    "",
    "# --- Neon -----------------------------------------------------------------",
    "# console.neon.tech -> your STAGING project -> Connection Details.",
    "# Two different strings: the pooled host contains `-pooler`, the direct one",
    "# does not. They are not interchangeable and boot validation checks which is",
    "# which, so a swap fails immediately instead of hanging drizzle-kit later.",
    "# DATABASE_URL=",
    "# DATABASE_URL_UNPOOLED=",
    "",
    "# --- Clerk ----------------------------------------------------------------",
    "# dashboard.clerk.com -> API keys. Test mode.",
    "# The webhook secret is only needed once you have a public URL; on localhost",
    "# the user row is created from the session instead.",
    "# NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=",
    "# CLERK_SECRET_KEY=",
    "# CLERK_WEBHOOK_SIGNING_SECRET=",
    "",
    "# Who becomes the first administrator once DEPLOYED. On localhost the first",
    "# person to open /admin gets it automatically; on a deployment the sign-up",
    "# page is public, so it grants nobody unless their VERIFIED email matches",
    "# this. Keep \"verify email at sign-up\" on in both Clerk instances.",
    "# BOOTSTRAP_ADMIN_EMAIL=",
    "",
    "# Where a suspended company is told to write. Without it they're pointed at",
    "# BOOTSTRAP_ADMIN_EMAIL, and with neither they're told to contact support",
    "# with no address.",
    "# SUPPORT_EMAIL=",
    "",
    "# --- Observability ----------------------------------------------------------",
    "# Both optional, and both change behaviour rather than switching a feature",
    "# off. Without SENTRY_DSN, errors are still fingerprinted into `error_log` and",
    "# listed in the admin panel. Without the Upstash pair, every rate limit counts",
    "# in one process's memory — exactly right for one dev server, and wrong on a",
    "# fleet, where N instances means N counters and every cold start resets them.",
    "# The URL is the REST one (https://…upstash.io), NOT the redis:// string.",
    "# SENTRY_DSN=",
    "# UPSTASH_REDIS_REST_URL=",
    "# UPSTASH_REDIS_REST_TOKEN=",
  ];

  if (answers.businessModel !== "none") {
    lines.push(
      "",
      "# --- Stripe ---------------------------------------------------------------",
      "# dashboard.stripe.com -> Developers -> API keys, with Test mode ON.",
      "# STRIPE_WEBHOOK_SECRET is printed by `stripe listen`, which `pnpm dev`",
      "# starts for you — it is NOT the one in the dashboard.",
      "# NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=",
      "# STRIPE_SECRET_KEY=",
      "# STRIPE_WEBHOOK_SECRET=",
      "",
      "# Books orders with no payment, so the whole funnel works before Stripe",
      "# exists. Needed NOWHERE locally — `pnpm dev` already qualifies — and it",
      "# is never available on production. Set it to true only on a staging",
      "# deployment you are about to demo.",
      "# ALLOW_SIMULATED_CHECKOUT=true",
    );
  }
  if (answers.includeEmail) {
    lines.push(
      "",
      "# --- Resend ---------------------------------------------------------------",
      "# Without RESEND_API_KEY, sends are recorded as `skipped` and logged, so you",
      "# can see exactly what would have gone out. Invitations aren't handed to the",
      "# mailer at all then: the team page gives the inviter the link to send.",
      "# RESEND_API_KEY=",
      "# EMAIL_FROM=Your Name <hello@yourdomain.com>",
    );
  }
  if (answers.includeAi) {
    lines.push(
      "",
      "# --- AI ---------------------------------------------------------------------",
      "# ANTHROPIC_API_KEY=",
    );
  }
  if (answers.includeFeedback) {
    lines.push(
      "",
      "# --- Feedback ---------------------------------------------------------------",
      "# The widget mounts once a client key is here. Issue one — after the",
      "# database exists and migrations have run — with:",
      "#   pnpm feedback:issue-key <tenant-slug>",
      "# It is printed exactly once; only its hash is stored.",
      "# ADMINIGLOO_FEEDBACK_KEY=",
      "# Screenshot storage (Vercel -> Storage -> Blob). Without it, reports",
      "# still arrive — just without images.",
      "# BLOB_READ_WRITE_TOKEN=",
    );
  }

  if (answers.includeScheduling) {
    lines.push(
      "",
      "# --- Scheduling ---------------------------------------------------------------",
      "# Real drive times and address lookup. Without a key, drive times are",
      "# straight-line estimates (marked as estimates) and addresses are kept as",
      "# typed. Google Cloud console -> APIs & Services: enable the Geocoding API",
      "# and the Distance Matrix API, create an API key, and restrict it to those",
      "# two APIs. It is a SERVER key — it never reaches a browser.",
      "# GOOGLE_MAPS_API_KEY=",
      "# The zone the business starts in the first time scheduling runs. After",
      "# that the owner changes it in /admin/schedule/settings.",
      "# SCHEDULING_TIME_ZONE=America/Denver",
    );
  }
  if (answers.includeEstimator) {
    lines.push(
      "",
      "# --- Estimator ----------------------------------------------------------------",
      "# The zone the dates on quotes start in, the first time the estimator runs.",
      "# After that the owner changes it in /admin/estimator/settings.",
      "# ESTIMATOR_TIME_ZONE=America/Denver",
      ...(answers.includeAi
        ? [
            "# The model that counts the steps in a customer's photo. Unset is Claude",
            "# Haiku 4.5 (claude-haiku-4-5), the cheapest capable one; another model",
            "# needs its price in MODEL_RATES (src/server/ai.ts) or reading stays off.",
            "# ESTIMATOR_TAKEOFF_MODEL=claude-haiku-4-5",
          ]
        : []),
    );
  }
  if (
    answers.includeComms ||
    answers.includeScheduling ||
    answers.includeEstimator ||
    answers.includeNotifications ||
    answers.includeStorage
  ) {
    lines.push(
      "",
      "# --- Cron -------------------------------------------------------------------",
      "# Not needed locally. On a deployment, the /api/cron/* routes refuse every",
      "# call until this is set (Vercel Cron sends it as a Bearer token).",
      "# CRON_SECRET=",
    );
  }

  if (answers.includeStorage) {
    lines.push(
      "",
      "# --- Photos and files -------------------------------------------------------",
      "# Nothing needed locally: with neither token set, `pnpm dev` keeps files on",
      "# this computer (.data/files, git-ignored).",
      "# TWO Blob stores on a deployment, because a Vercel Blob store is private or",
      "# public as a whole: the PRIVATE one for photos and files (Vercel -> Storage",
      "# -> Create -> Blob, access Private, connected with the prefix BLOB_PRIVATE),",
      "# and the public one for company logos. They must be different tokens.",
      "# BLOB_PRIVATE_READ_WRITE_TOKEN=",
      ...(answers.includeFeedback ? [] : ["# BLOB_READ_WRITE_TOKEN="]),
      "# How much each company may store, in MB (default 5120, 5 GB).",
      "# FILES_ALLOWANCE_MB=5120",
      "# The key \"Copy link\" signs with (32+ characters). Without it one is made",
      "# from CLERK_SECRET_KEY.",
      "# FILES_LINK_SECRET=",
    );
  }

  return `${lines.join("\n")}\n`;
}

/**
 * The one-line why for an optional variable whose name doesn't say it. Kept
 * short: .env.local carries the long form, and /setup the full story.
 */
const OPTIONAL_ENV_NOTES: Readonly<Record<string, readonly string[]>> = {
  SUPPORT_EMAIL: [
    "Where a suspended company is told to write. Without it they're told to",
    "contact support with no link (BOOTSTRAP_ADMIN_EMAIL is used if set).",
  ],
  BOOTSTRAP_ADMIN_EMAIL: [
    "Becomes the first administrator on a deployment, once they sign in with",
    "this address verified. Also set it as a GitHub variable for the deploy seed.",
  ],
};

export function renderEnvExample(answers: Answers): string {
  const lines = [
    "# Copy to .env.local and fill in. Every value is validated at boot;",
    "# a missing or malformed one stops the server rather than failing later.",
    "#",
    "# TEST-MODE KEYS ONLY, here and in the Vercel Preview scope. A live key",
    "# outside production throws KeyModeMismatchError at boot, by design, and",
    "# no environment variable can switch that check off.",
    "",
  ];
  for (const name of requiredEnvFor(answers)) lines.push(`${name}=`);

  // Listed, not omitted. These are the variables an app can read and does not
  // need, and a variable absent from this file is one nobody discovers exists —
  // which is how a project runs for a year with a rate limiter counting in one
  // process's memory because nothing ever mentioned UPSTASH_REDIS_REST_URL.
  // Empty counts as unset, so copying this file wholesale still produces a
  // working .env.local.
  lines.push(
    "",
    "# Optional. The app boots and runs without every line below; each one is a",
    "# documented behaviour rather than a switched-off feature, and /setup says",
    "# what each one changes. An empty value counts as unset.",
    "",
  );
  for (const name of optionalEnvFor(answers)) {
    const note = OPTIONAL_ENV_NOTES[name];
    if (note !== undefined) lines.push(...note.map((line) => `# ${line}`));
    lines.push(`${name}=`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * What was generated, and from what — the readable view of `adminigloo.json`.
 *
 * Copied source stops receiving upstream fixes the moment it is copied. A year
 * later the only way to tell a deliberate edit from a stale default is to diff
 * against the version that produced it, which requires knowing that version.
 *
 * TAKES THE MANIFEST, not the answers. Both files state the same facts, and
 * deriving each of them separately from `answers` is two implementations of one
 * truth: the day somebody adds a question and updates one renderer, the two
 * disagree and the human-readable one is the copy people believe. Reading the
 * manifest means this file cannot say anything the manifest does not.
 *
 * The exception is the fork list at the bottom, which is the one thing here
 * that no tool can know and the one thing a person is asked to maintain. It is
 * in this file rather than the manifest precisely so the manifest can stay
 * entirely derived and therefore rebuildable.
 */
/** The SCAFFOLD.md label for each answer. A missing one falls back to the key. */
const ANSWER_LABELS: Partial<Record<keyof Answers, string>> = {
  tenantNoun: "Customer organisation",
  businessModel: "Business model",
  adminShell: "Admin shell",
  includeAi: "AI routes",
  includeEmail: "Transactional email",
  includeFeedback: "In-app feedback",
  includeSeoReports: "SEO & AEO reports",
  includeNotifications: "In-app notifications",
  includeStorage: "File storage",
  includeAssistant: "AI assistant",
  includeMarketing: "Public marketing site",
  includeEstimator: "Estimator",
  includeScheduling: "Scheduling",
  includeInvoicing: "Invoicing",
  includeComms: "Customer messages",
  includeAeo: "AI citation tracking",
};

export function renderScaffoldRecord(manifest: ProjectManifest): string {
  const answers = manifest.answers;
  return [
    `# ${answers.projectName}`,
    "",
    `Generated by \`${manifest.generator.name}\` ${manifest.generator.version}.`,
    "",
    "Everything above the fork list is read from `adminigloo.json`, which the",
    "generator wrote and tooling reads. Do not edit either by hand — change an",
    "answer by regenerating.",
    "",
    "| Answer | Value |",
    "| --- | --- |",
    // EVERY ANSWER, by iterating them (CA-10): the hand-written list stopped at
    // the marketing site, so a project generated with --estimator or
    // --scheduling had a record that never said so. A key with no label here
    // falls back to its own name rather than being left out.
    ...(Object.keys(answers) as (keyof Answers)[])
      .filter((key) => key !== "scope" && key !== "projectName")
      .map((key) => {
        const value = answers[key];
        return `| ${ANSWER_LABELS[key] ?? key} | ${typeof value === "boolean" ? (value ? "yes" : "no") : String(value)} |`;
      }),
    `| Personal-workspace only | ${isPersonalWorkspaceOnly(answers) ? "yes" : "no"} |`,
    "",
    "## Installed packages",
    "",
    ...Object.entries(manifest.packages).map(
      ([name, range]) => `- \`${name}\` ${range}`,
    ),
    "",
    "## Overlays applied",
    "",
    "Copied source. These files are yours now and receive no upstream fixes,",
    "which is why the generator version above matters.",
    "",
    ...(manifest.overlays.length === 0
      ? ["_none — this project is the base template only_"]
      : manifest.overlays.map((name) => `- \`${name}\``)),
    "",
    "## Capabilities",
    "",
    "What tooling will assume this project has. Derived from the answers, not",
    "declared separately.",
    "",
    ...manifest.capabilities.map((key) => `- \`${key}\``),
    "",
    "## Forked modules",
    "",
    "THE ONE SECTION A PERSON MAINTAINS. Record any base module copied into this",
    "repo and no longer imported, with the version it was forked from. Forking",
    "is legitimate; forking silently is what turns the next upgrade into a",
    "negotiation. It is not in `adminigloo.json` because nothing can infer it,",
    "and a manifest with one hand-written field can no longer be rebuilt and",
    "compared against itself.",
    "",
    "_none yet_",
    "",
  ].join("\n");
}

/**
 * `src/env.ts` for this project.
 *
 * Derived rather than templated because the fragments an app composes are
 * exactly the packages it installed. A static file would either demand a Stripe
 * key from a project with no Stripe, or omit it from one that needs it — and
 * the second failure only surfaces at the first payment.
 */
/**
 * The env check that refuses ONE token in both Blob slots (Tenancy 2b-1,
 * 13.7; review G9). A Vercel Blob store is public or private as a whole, so
 * the public store's token pasted where the private one belongs would publish
 * every photo and file. Written after `defineEnv` because Zod checks each
 * variable alone; an environment check, not a feature switch.
 */
const TWO_STORES_CHECK = `
/**
 * TWO BLOB STORES, TWO TOKENS (Tenancy 2b-1, review G9). A Vercel Blob store
 * is public or private as a whole: the same token in both would keep every
 * private photo and file in the public store. Refused at boot (and so at
 * \`next build\`), in words.
 */
if (env.BLOB_PRIVATE_READ_WRITE_TOKEN !== undefined && env.BLOB_PRIVATE_READ_WRITE_TOKEN === env.BLOB_READ_WRITE_TOKEN) {
  throw new Error(
    "BLOB_PRIVATE_READ_WRITE_TOKEN is the same as BLOB_READ_WRITE_TOKEN. The private store needs its own token: connect a second Blob store with access Private.",
  );
}
`;

export function renderEnvModule(answers: Answers): string {
  const takesMoney = answers.businessModel !== "none";
  const scope = answers.scope;

  const imports = [
    `import { authClient, authServer, AUTH_MODE_BOUND_KEYS } from "${scope}/auth";`,
    `import { dbServer, DB_OPTIONAL_UNTIL_DEPLOYED } from "${scope}/db";`,
    `import { coreClient, coreServer, defineEnv } from "${scope}/env";`,
    // Unconditional, because observability is in the base package set. It was
    // the one installed package whose fragment was never spread, so SENTRY_DSN
    // and the Upstash pair existed in no project's contract: /setup could not
    // report on them and the rate limiter had no way to be pointed at a shared
    // store. OBSERVABILITY_ENV_GROUPS travels with it so the /setup rows name
    // the same members the package checks, rather than a retyped copy of them.
    `import { observabilityServer, OBSERVABILITY_ENV_GROUPS } from "${scope}/observability";`,
    `import { z } from "zod";`,
  ];
  if (takesMoney) {
    imports.push(
      `import { stripeClient, stripeServer, STRIPE_MODE_BOUND_KEYS } from "${scope}/stripe";`,
    );
  }
  if (answers.includeAi) imports.push(`import { aiServer } from "${scope}/ai";`);
  if (answers.includeEmail) imports.push(`import { emailServer } from "${scope}/email";`);

  const serverSpreads = [
    "...coreServer()",
    "...dbServer()",
    "...authServer()",
    "...observabilityServer()",
    // Who becomes the first administrator on a DEPLOYED environment. Optional:
    // unset means a deployment grants nobody automatically, which is the safe
    // default when the sign-up page is reachable from the public internet.
    "BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional()",
    // Where a suspended company is told to write (Tenancy 1). Optional; the
    // suspended screen falls back to BOOTSTRAP_ADMIN_EMAIL, and with neither
    // it says "contact support" with no address.
    "SUPPORT_EMAIL: z.string().email().optional()",
  ];
  const clientSpreads = ["...coreClient()", "...authClient()"];
  const modeBound = ["...AUTH_MODE_BOUND_KEYS"];
  const runtime = [
    "NODE_ENV: process.env.NODE_ENV",
    "LOG_LEVEL: process.env.LOG_LEVEL",
    "DATABASE_URL: process.env.DATABASE_URL",
    "DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED",
    "CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY",
    "CLERK_WEBHOOK_SIGNING_SECRET: process.env.CLERK_WEBHOOK_SIGNING_SECRET",
    // Falls back to an address Vercel knows. A Preview URL is not known until
    // the deployment exists, so requiring the variable to be set by hand makes
    // every preview either fail the localhost guard or need a value nobody can
    // know in advance. Both are injected at build time, which is when
    // NEXT_PUBLIC_* is inlined, so the two line up.
    //
    // ON PRODUCTION, THE PROJECT'S PRODUCTION DOMAIN — NEVER THE PER-DEPLOYMENT
    // URL (TB-DEPLOY-05). Invitation links and the company's public address are
    // built from this, and a *.vercel.app deployment URL is behind Vercel's
    // login wall by default and changes on every deploy: an invitee would land
    // on Vercel's sign-in. Set NEXT_PUBLIC_APP_URL to your domain to be sure.
    "NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? (process.env.VERCEL_ENV === \"production\" && process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined)",
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "BOOTSTRAP_ADMIN_EMAIL: process.env.BOOTSTRAP_ADMIN_EMAIL",
    "SUPPORT_EMAIL: process.env.SUPPORT_EMAIL",
    // All three optional. Absent, the logger writes to stdout and the rate
    // limiter counts in one process's memory — both real behaviours rather than
    // disabled ones, which is why none of them is deferred-until-deployed.
    "SENTRY_DSN: process.env.SENTRY_DSN",
    "UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN",
  ];

  // Required on a deployment, deferrable on a laptop. Everything a service
  // account issues belongs here; NEXT_PUBLIC_APP_URL does not, because you
  // already know it and nothing has to be signed up for.
  const deferred = [
    "...DB_OPTIONAL_UNTIL_DEPLOYED",
    // The rest of the one list (deferredUntilDeployedFor), which the CLI's
    // next steps print too, so the two can't disagree.
    ...deferredUntilDeployedFor(answers)
      .filter((name) => name !== "DATABASE_URL" && name !== "DATABASE_URL_UNPOOLED")
      .map((name) => `"${name}"`),
  ];

  const features = [
    `{ name: "Database", vars: [...DB_OPTIONAL_UNTIL_DEPLOYED], disables: "Anything that reads or writes data." }`,
    `{ name: "Sign-in", vars: ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_WEBHOOK_SIGNING_SECRET"], disables: "Signing in, and every permission check. Without the webhook secret alone, sign-in works but deleting someone in Clerk never takes their access away here." }`,
    `{ name: "First administrator", vars: ["BOOTSTRAP_ADMIN_EMAIL"], disables: "Nothing locally (the first person to open /admin becomes one). On a deployment, nobody is made an administrator automatically — use pnpm admin:grant or the Admin grant workflow." }`,
    `{ name: "Support address", vars: ["SUPPORT_EMAIL"], disables: "Nothing. Where a suspended company is told to write; without it they're pointed at BOOTSTRAP_ADMIN_EMAIL, and with neither they're told to contact support with no address." }`,
  ];

  if (takesMoney) {
    serverSpreads.push("...stripeServer()");
    clientSpreads.push("...stripeClient()");
    modeBound.push("...STRIPE_MODE_BOUND_KEYS");
    // The one variable that authorises handing out paid goods without taking a
    // payment. Declared here rather than in @__SCOPE_NAME__/stripe's fragment
    // because it is not a Stripe credential — it is a statement about THIS
    // deployment, and `src/server/checkout-mode.ts` is the only reader.
    //
    // An enum with a default rather than `.optional()`. Unset means off, which
    // is what a deployment nobody configured must mean; and a value that is
    // neither "true" nor "false" fails at boot instead of being read as one of
    // them, because `ALLOW_SIMULATED_CHECKOUT=1` silently meaning "off" is how
    // somebody demos a shop that refuses every click.
    serverSpreads.push(
      'ALLOW_SIMULATED_CHECKOUT: z.enum(["true", "false"]).default("false")',
    );
    runtime.push(
      "STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET",
      "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
      "ALLOW_SIMULATED_CHECKOUT: process.env.ALLOW_SIMULATED_CHECKOUT",
    );
    features.push(
      `{ name: "Payments", vars: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"], disables: "Checkout, subscriptions and the webhook ledger." }`,
      `{ name: "Simulated checkout", vars: ["ALLOW_SIMULATED_CHECKOUT"], disables: "Nothing. Set it to true on a staging deployment that has no Stripe key, to record orders without taking a payment. Locally it is not needed, and on production the simulated checkout is never available." }`,
    );
  }

  if (answers.includeAi) {
    serverSpreads.push("...aiServer()");
    runtime.push(
      "ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY",
      "OPENAI_API_KEY: process.env.OPENAI_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY",
    );
    features.push(
      `{ name: "AI", vars: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"], disables: "Nothing else. /api/ai/chat answers 503 with the empty provider list; every other route is unaffected, and the rate limits still apply." }`,
    );
  }

  if (answers.includeEmail) {
    serverSpreads.push("...emailServer()");
    runtime.push(
      "RESEND_API_KEY: process.env.RESEND_API_KEY",
      "EMAIL_FROM: process.env.EMAIL_FROM",
      "EMAIL_REPLY_TO: process.env.EMAIL_REPLY_TO",
      "RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET",
    );
    features.push(
      `{ name: "Email", vars: ["RESEND_API_KEY", "EMAIL_FROM"], disables: "Sending mail. Sends are recorded as skipped instead." }`,
    );
  }

  if (answers.includeFeedback) {
    // Declared here rather than in an env fragment of @__SCOPE_NAME__/feedback,
    // the way ALLOW_SIMULATED_CHECKOUT is: neither is a credential the package
    // consumes. The key is a statement about THIS deployment — which tenant's
    // widget this app mounts — and the blob token belongs to the storage the
    // emitted route chose, which the package deliberately knows nothing about.
    //
    // Both optional EVERYWHERE, including deployed. A key cannot exist before
    // the database it is issued against, so hard-requiring it on deployment
    // would make the first deploy impossible in the exact order the setup
    // instructions give.
    serverSpreads.push(
      "ADMINIGLOO_FEEDBACK_KEY: z.string().min(1).optional()",
      "BLOB_READ_WRITE_TOKEN: z.string().min(1).optional()",
    );
    runtime.push(
      "ADMINIGLOO_FEEDBACK_KEY: process.env.ADMINIGLOO_FEEDBACK_KEY",
      "BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN",
    );
    features.push(
      `{ name: "Feedback widget", vars: ["ADMINIGLOO_FEEDBACK_KEY"], disables: "Mounting the widget in this app. The intake API still answers, so any other app holding a key can still submit. Issue a key with pnpm feedback:issue-key." }`,
      `{ name: "Feedback screenshots", vars: ["BLOB_READ_WRITE_TOKEN"], disables: "Storing screenshots. Uploads answer 503 and reports still arrive, without images — the widget says so rather than failing the submit." }`,
    );
  }

  if (answers.includeStorage) {
    // The public store's token is the one feedback's screenshots use — one
    // public store per project. Guarded so a project with both features
    // declares the variable once: Zod would not mind the duplicate key, but
    // the person reading the file would rightly ask which one wins.
    if (!answers.includeFeedback) {
      serverSpreads.push("BLOB_READ_WRITE_TOKEN: z.string().min(1).optional()");
      runtime.push("BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN");
    }
    // TENANCY 2b-1 (13.7): the PRIVATE store's own token (photos and files),
    // how much each company may store, and the key signed links are made
    // with. All optional: a laptop keeps files on its own disk, the allowance
    // has a default, and the link key falls back to one made from Clerk's.
    serverSpreads.push(
      "BLOB_PRIVATE_READ_WRITE_TOKEN: z.string().min(1).optional()",
      'FILES_ALLOWANCE_MB: z.coerce.number().int("a whole number of megabytes").min(1).max(1048576).optional()',
      'FILES_LINK_SECRET: z.string().min(32, "at least 32 characters").optional()',
    );
    runtime.push(
      "BLOB_PRIVATE_READ_WRITE_TOKEN: process.env.BLOB_PRIVATE_READ_WRITE_TOKEN",
      "FILES_ALLOWANCE_MB: process.env.FILES_ALLOWANCE_MB",
      "FILES_LINK_SECRET: process.env.FILES_LINK_SECRET",
    );
    features.push(
      `{ name: "Photos and files", vars: ["BLOB_PRIVATE_READ_WRITE_TOKEN"], disables: "Photos and files on visits, estimates and invoices, and customers' estimate photos. Without it they can't be added, and the screens say so. While developing, files are kept on this computer (.data/files) until a Blob store is connected." }`,
      `{ name: "Company logos", vars: ["BLOB_READ_WRITE_TOKEN"], disables: "Company logos (and feedback screenshots): the one public store. It must be a different store from the private one, with its own token." }`,
      `{ name: "Storage allowance", vars: ["FILES_ALLOWANCE_MB"], disables: "Nothing. How much each company may store, in MB (5120, 5 GB, when unset). The billing chunk will set this per plan." }`,
      `{ name: "File links", vars: ["FILES_LINK_SECRET"], disables: "Nothing while CLERK_SECRET_KEY is set: Copy link signs with a key made from it. With neither, links to files can't be made; everything else works." }`,
    );
  }

  if (
    answers.includeComms ||
    answers.includeScheduling ||
    answers.includeEstimator ||
    answers.includeNotifications ||
    answers.includeStorage
  ) {
    // The shared secret the cron routes check. Declared here rather than in an
    // env fragment of @__SCOPE_NAME__/comms or /scheduling because it is not a
    // credential either package consumes — it is a statement about THIS
    // deployment, and the /api/cron/* routes are the only readers. ONE secret
    // for however many cron routes there are, because Vercel Cron sends one.
    // Optional: unset, every cron route refuses every caller (401), so an
    // unconfigured deployment cannot be driven by a stranger.
    serverSpreads.push("CRON_SECRET: z.string().min(1).optional()");
    runtime.push("CRON_SECRET: process.env.CRON_SECRET");
  }
  if (answers.includeNotifications) {
    features.push(
      `{ name: "Alerts cron", vars: ["CRON_SECRET"], disables: "The daily alerts run: /api/cron/alerts answers 401 until the secret is set. Alerts in the app still arrive the moment something happens; an alert email that couldn't go at once, the 'about to lapse' and 'overdue' alerts, and the clean-up of old read alerts wait for it." }`,
    );
  }
  if (answers.includeStorage) {
    features.push(
      `{ name: "Files cron", vars: ["CRON_SECRET"], disables: "The daily files run: /api/cron/files answers 401 until the secret is set. A deleted file whose stored copy couldn't be removed at once is removed by it, old public photos are moved to the private store, and the private store is checked." }`,
    );
  }
  if (answers.includeComms) {
    // In a companies project the crons serve EVERY company (Tenancy 2a), so
    // the one secret holds back every company's reminders — said so here,
    // where /setup reads it.
    const whose = answers.tenantNoun === "none" ? "" : ` for every ${tenantLabel(answers).toLowerCase()}`;
    features.push(
      `{ name: "Scheduled messages", vars: ["CRON_SECRET"], disables: "The comms cron: /api/cron/comms answers 401 until the secret is set and the scheduler sends it. Templates and the log are unaffected; nothing drains the queue automatically${whose}." }`,
    );
  }

  if (answers.includeScheduling) {
    // Both optional everywhere, and neither is a credential the package reads
    // for itself: the app hands the key to the maps provider it builds in
    // src/server/scheduling.ts, and the zone seeds the business's first
    // settings row once. A zone that is present but not a real one fails at
    // boot, like any malformed value — not at the first booking, where it
    // would quietly fall back to Mountain Time.
    serverSpreads.push(
      "GOOGLE_MAPS_API_KEY: z.string().min(1).optional()",
      `SCHEDULING_TIME_ZONE: z
    .string()
    .refine((zone) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    }, "an IANA time zone, like America/Denver")
    .optional()`,
    );
    runtime.push(
      "GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY",
      "SCHEDULING_TIME_ZONE: process.env.SCHEDULING_TIME_ZONE",
    );
    features.push(
      `{ name: "Drive times", vars: ["GOOGLE_MAPS_API_KEY"], disables: "Real drive times and address lookup for scheduling. Without it, drive times between visits are straight-line estimates, marked as estimates on the calendar and the crew's route, and addresses are stored as typed. On the key, enable the Geocoding API and the Distance Matrix API, and restrict it to those two." }`,
      `{ name: "Scheduling time zone", vars: ["SCHEDULING_TIME_ZONE"], disables: "Nothing. The zone the business starts in the first time scheduling runs (America/Denver when unset). After that the owner changes it in Schedule settings, and every visit keeps its clock time." }`,
      `{ name: "Expiring requests", vars: ["CRON_SECRET"], disables: "The daily sweep: /api/cron/scheduling answers 401 until the secret is set. An unanswered request still stops holding its time at its deadline, and is released whenever a customer books or staff open the calendar; only the customer's email saying so waits for one of those." }`,
    );
  }

  if (answers.includeEstimator) {
    // Neither is a credential the package reads for itself. The zone seeds the
    // business's first settings row once (the owner changes it in Estimate
    // settings); the model id is handed to the photo reader the app builds in
    // src/server/estimator-services.ts. A zone that is present but not a real
    // one fails at boot, like any malformed value.
    serverSpreads.push(
      `ESTIMATOR_TIME_ZONE: z
    .string()
    .refine((zone) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    }, "an IANA time zone, like America/Denver")
    .optional()`,
    );
    runtime.push("ESTIMATOR_TIME_ZONE: process.env.ESTIMATOR_TIME_ZONE");
    features.push(
      `{ name: "Estimator time zone", vars: ["ESTIMATOR_TIME_ZONE"], disables: "Nothing. The zone the dates on quotes start in, the first time the estimator runs (America/Denver when unset). After that the owner changes it in Estimate settings." }`,
      `{ name: "Quote expiry and photo clean-up", vars: ["CRON_SECRET"], disables: "The daily sweep: /api/cron/estimator answers 401 until the secret is set. A quote past its date still can't be accepted, and is marked expired when its link is opened or staff open the estimates list; only the emails saying so wait for one of those. Photos a customer uploaded but never sent stay in storage until it runs." }`,
    );
    if (answers.includeAi) {
      serverSpreads.push("ESTIMATOR_TAKEOFF_MODEL: z.string().min(1).max(120).optional()");
      runtime.push("ESTIMATOR_TAKEOFF_MODEL: process.env.ESTIMATOR_TAKEOFF_MODEL");
      features.push(
        `{ name: "Photo reading model", vars: ["ESTIMATOR_TAKEOFF_MODEL"], disables: "Nothing. Unset is Claude Haiku 4.5, the cheapest capable model. Another model needs its price in MODEL_RATES (src/server/ai.ts), or photo reading stays off and the server log says why. The reading needs ANTHROPIC_API_KEY either way." }`,
      );
    }
  }

  // Last on /setup, and last here so it stays that way. Everything above
  // switches a product feature off; these two change only how well the running
  // app can be operated, and a reader working down the page should meet the
  // credentials that block a launch first.
  //
  // Named from OBSERVABILITY_ENV_GROUPS rather than retyped. The package
  // documents that constant as the reason an app cannot check a group and miss
  // a member, and spelling the strings out here would be that same mistake one
  // level up: a group that gained a third variable would gain it in the check
  // and not in the report.
  features.push(
    `{ name: "Error tracking", vars: [...OBSERVABILITY_ENV_GROUPS.sentry], disables: "Nothing on its own — errors are recorded in error_log either way. Validated here so adding a Sentry client is an install rather than a new environment contract." }`,
    `{ name: "Rate limiting", vars: [...OBSERVABILITY_ENV_GROUPS.upstash], disables: "Rate limits shared between instances. Without them every process counts alone, so a fleet allows N times the configured limit and a cold start resets it." }`,
  );

  return `${imports.join("\n")}

/**
 * The environment contract for ${answers.projectName}.
 *
 * HARD RULE: this is the only module allowed to read \`process.env\`. Everywhere
 * else imports \`env\`. Composed from the fragments of the packages actually
 * installed, so this project is never asked for a credential it has no use for.
 */
const server = {
  ${serverSpreads.join(",\n  ")},
};

const client = {
  ${clientSpreads.join(",\n  ")},
};

const runtimeEnv = {
  ${runtime.join(",\n  ")},
};

/**
 * Credentials you can add LATER.
 *
 * On a laptop these may be absent: the app boots, /setup lists what is missing,
 * and the feature each one unlocks stays off until you paste a value in. That
 * is the difference between a scaffold you can run and one you have to finish
 * shopping for first.
 *
 * On a deployment they are hard-required and the build fails without them,
 * because a forgotten Vercel variable should stop a release rather than reach a
 * customer as a broken page. A value that is PRESENT but malformed still fails
 * everywhere — a mistyped connection string is not a deferred credential.
 */
const optionalUntilDeployed = [
  ${deferred.join(",\n  ")},
] as const;

export const env = defineEnv({
  server,
  client,
  runtimeEnv,
  optionalUntilDeployed,
  // Their \`_test_\` / \`_live_\` mode must match the deployment. Checked outside
  // Zod on the raw values, so neither SKIP_ENV_VALIDATION nor deferring a key
  // above can switch it off.
  modeBoundKeys: [${modeBound.join(", ")}],
});
${answers.includeStorage ? TWO_STORES_CHECK : ""}
/**
 * Inputs for the /setup page, exported so it reads the SAME schemas boot
 * validation uses. A setup page with its own copy of the list drifts the first
 * time a package is added, and then confidently reports that everything is
 * configured.
 */
export const envDescription = {
  server,
  client,
  runtimeEnv,
  optionalUntilDeployed,
  features: [
    ${features.join(",\n    ")},
  ],
};
`;
}


/** The two catalogs a permission key can live in. Mirrors `Scope` in @…/permissions. */
export type PermissionScope = "staff" | "tenant";

/**
 * One package's permission fragment, and the scope the PACKAGE declares it for.
 *
 * ONE ROW PER FRAGMENT, and the scope is a property of the row rather than a
 * choice made again at the spread. That is the whole point of the table: which
 * catalog a fragment goes into is now read from here, so there is no second
 * place to type it and therefore no second place to type it wrongly.
 *
 * The scaffold has now shipped a permission in the wrong scope three times, and
 * every time the symptom was silence. A key declared under "tenant" and checked
 * with `requireStaff(...)` matches nothing: the feature is invisible to
 * everybody, forever, with no error anywhere. The catalog keys did it and the
 * conformance test caught them; commerce and billing did it and nothing did,
 * because `defaultFor: ["admin"]` names a real template in BOTH ladders — so
 * twelve of their fourteen defaults kept granting to the admin of the wrong
 * ladder and looked healthy, while `plans.manage` and `subscriptions.manage`,
 * which are owner-only, reached no role at all.
 *
 * The rule the `scope` column encodes: STAFF is you operating the product —
 * defining what is for sale, reading the audit log, impersonating a customer.
 * TENANT is your customer operating their own account. The tie-breaker when
 * that reads ambiguously is the package's own `defaultFor` values, because
 * those name templates from one ladder or the other and nothing else: owner,
 * member and viewer exist only in `TENANT_ROLE_TEMPLATES`; cs_lead and cs_agent
 * only in the staff ladder seeded by `scripts/seed-roles.ts`.
 */
export interface PackagePermissionFragment {
  /** Bare package name; the generated import is `${answers.scope}/${package}`. */
  readonly package: string;
  /** The binding the package exports. */
  readonly binding: string;
  /** The catalog it is declared for. */
  readonly scope: PermissionScope;
  /** True when these answers install the package that exports it. */
  installedBy(answers: Answers): boolean;
  /** Rendered as a comment above the import. */
  readonly why: string;
}

const SELLS = (answers: Answers): boolean => answers.businessModel !== "none";

export const PACKAGE_PERMISSION_FRAGMENTS: readonly PackagePermissionFragment[] = [
  {
    package: "tenancy",
    binding: "tenancyPermissions",
    scope: "tenant",
    installedBy: () => true,
    why:
      "Membership, invitations and ownership transfer. Tenancy is in the base " +
      "package set, so this fragment is in every project.",
  },
  {
    package: "catalog",
    binding: "catalogPermissions",
    scope: "staff",
    installedBy: SELLS,
    why:
      "Defining what is for sale is an operator activity: you author the " +
      "products, your customers buy them. Every default names admin, cs_lead " +
      "or cs_agent, and the admin router gates each key with requireStaff.",
  },
  {
    package: "stripe",
    binding: "stripePermissions",
    scope: "tenant",
    installedBy: SELLS,
    why:
      "A customer managing their own billing — the portal, their invoices, a " +
      "refund on their subscription. Theirs, not the firm's.",
  },
  {
    package: "commerce",
    binding: "commercePermissions",
    scope: "tenant",
    installedBy: SELLS,
    why:
      "Orders and discount codes, held by the organisation that owns them. " +
      "TENANT: every default here names owner, admin, member or viewer, and " +
      "the staff ladder has no owner, member or viewer to give them to.",
  },
  {
    package: "billing",
    binding: "billingPermissions",
    scope: "tenant",
    installedBy: SELLS,
    why:
      "Plans and subscriptions as the paying organisation sees them. TENANT " +
      "for the same reason commerce is: `plans.manage` and " +
      "`subscriptions.manage` are owner-only, and a staff catalog has no " +
      "owner — in one, those two keys reached no role at all.",
  },
  {
    package: "ai",
    binding: "aiPermissions",
    scope: "tenant",
    installedBy: (answers) => answers.includeAi,
    why: "A customer using the AI features inside their own account.",
  },
  // THE FIELD-SERVICE FEATURES, IN A COMPANIES PROJECT (Tenancy 2a, D9). Each
  // company runs its own schedule, price book, ledger and messages, so the
  // keys belong to the company's roles — the defaults name owner, admin,
  // member, viewer and (scheduling) crew. A single-business project keeps
  // these features on the staff ladder instead (one staff key per job,
  // mapped in its glue), so it never spreads these fragments.
  {
    package: "scheduling",
    binding: "schedulingPermissions",
    scope: "tenant",
    installedBy: (answers) => answers.tenantNoun !== "none" && answers.includeScheduling,
    why:
      "Each company runs its own schedule, so these are company keys: owners " +
      "and admins set up crews and hours, members book and move visits, a " +
      "viewer looks, and Crew opens only their own route.",
  },
  {
    package: "estimator",
    binding: "estimatorPermissions",
    scope: "tenant",
    installedBy: (answers) => answers.tenantNoun !== "none" && answers.includeEstimator,
    why:
      "Each company runs its own price book and quotes, so these are company " +
      "keys: owners and admins change prices and settings and see costs, " +
      "members work estimates and send quotes, a viewer looks.",
  },
  {
    package: "invoicing",
    binding: "invoicingPermissions",
    scope: "tenant",
    installedBy: (answers) => answers.tenantNoun !== "none" && answers.includeInvoicing,
    why:
      "Each company keeps its own ledger, so these are company keys: members " +
      "raise and send invoices and record payments, owners and admins also " +
      "reverse them, a viewer looks.",
  },
  {
    package: "comms",
    binding: "commsPermissions",
    scope: "tenant",
    installedBy: (answers) => answers.tenantNoun !== "none" && answers.includeComms,
    why:
      "Each company has its own messages, so these are company keys: everyone " +
      "but crew reads them, owners and admins change the wording and send " +
      "what's due.",
  },
  // ALERTS AND FILES, IN A COMPANIES PROJECT (Tenancy 2b-1). Every company
  // hears about its own work and keeps its own files, so the keys belong to
  // the company's roles. A single business maps them onto staff keys in its
  // glue (staff.alerts.*, staff.files.*) and never spreads these.
  {
    package: "notifications",
    binding: "notificationsPermissions",
    scope: "tenant",
    installedBy: (answers) => answers.tenantNoun !== "none" && answers.includeNotifications,
    why:
      "Each company hears about its own work, so these are company keys: " +
      "everyone (crew included) gets their own alerts, owners and admins " +
      "choose who hears about new work.",
  },
  {
    package: "storage",
    binding: "storagePermissions",
    scope: "tenant",
    installedBy: (answers) => answers.tenantNoun !== "none" && answers.includeStorage,
    why:
      "Each company keeps its own files, so these are company keys: the " +
      "office sees the company's files, owners and admins add and delete " +
      "them. A record's own files follow that record's permissions.",
  },
];

export class PermissionScopeMismatchError extends Error {
  readonly name = "PermissionScopeMismatchError";
  constructor(binding: string, declared: PermissionScope, spreadInto: PermissionScope) {
    super(
      `${binding} is declared for the ${declared} catalog and the generated ` +
        `src/permissions/catalog.ts spreads it into the ${spreadInto} one. A ` +
        `key in the wrong scope matches nothing and errors nowhere: the ` +
        `feature is invisible to everybody and no test in the generated ` +
        `project fails, because "admin" is a template in both ladders. Fix ` +
        `PACKAGE_PERMISSION_FRAGMENTS, or the catalog it is spread into.`,
    );
  }
}

/**
 * Read the emitted file back and check every spread landed in its own scope.
 *
 * AGAINST THE RENDERED TEXT, not against the table that produced it. Checking
 * the inputs against themselves would be a tautology that passes for ever; this
 * parses the `definePermissions("staff", { ...a, ...b })` calls actually
 * written and compares each binding to the scope its row declares, so a
 * hand-edit of the template string below is caught by the same assertion as a
 * mis-grouped row above. It runs on every single generation rather than only
 * under test, because the cost is one regex over a file we have just built and
 * the failure it prevents is a silent one.
 */
export function assertPermissionScopes(
  source: string,
  fragments: readonly PackagePermissionFragment[] = PACKAGE_PERMISSION_FRAGMENTS,
): void {
  const declared = new Map(fragments.map((f) => [f.binding, f.scope]));

  for (const call of source.matchAll(
    /definePermissions\(\s*"(staff|tenant)",\s*\{([^}]*)\}/g,
  )) {
    const spreadInto = call[1] as PermissionScope;
    for (const spread of (call[2] ?? "").matchAll(/\.\.\.(\w+)/g)) {
      const binding = spread[1] ?? "";
      const owns = declared.get(binding);
      // `appStaffPermissions` and `appTenantPermissions` are written here and
      // have no package to disagree with, so they are not in the table.
      if (owns !== undefined && owns !== spreadInto) {
        throw new PermissionScopeMismatchError(binding, owns, spreadInto);
      }
    }
  }
}

/**
 * `src/permissions/catalog.ts` for this project.
 *
 * Generated, because which packages contribute keys depends on what was
 * installed — and because SCOPE MATTERS AND IS EASY TO GET WRONG in a way
 * nothing downstream reports. See `PACKAGE_PERMISSION_FRAGMENTS` above for the
 * rule and for the three times this has now gone wrong.
 */
export function renderPermissionsCatalog(answers: Answers): string {
  const scope = answers.scope;
  const label = tenantLabel(answers);
  const plural = tenantLabelPlural(answers);

  // Grouped BY THE TABLE'S OWN `scope` column rather than by a second list per
  // catalog. There is nowhere here to put a fragment in the wrong one.
  const installed = PACKAGE_PERMISSION_FRAGMENTS.filter((f) => f.installedBy(answers));
  const inScope = (want: PermissionScope): string[] =>
    installed.filter((f) => f.scope === want).map((f) => f.binding);

  const imports = [
    `import { definePermissions, type PermissionKeyOf } from "${scope}/permissions";`,
    ...installed.map(
      (fragment) =>
        `${indentedComment(fragment.why).replace(/^ {2}/gm, "")}` +
        `import { ${fragment.binding} } from "${scope}/${fragment.package}";`,
    ),
  ];

  const staffFragments = inScope("staff");
  const tenantFragments = inScope("tenant");

  // THE STAFF KEYS BELOW ARE A SINGLE BUSINESS'S (Tenancy 2a, D12): there the
  // field-service features run for the one business on the staff ladder. In a
  // companies project each company runs them on its own roles — the package
  // fragments above, in the tenant catalog — and the platform's staff have no
  // schedule, price book, ledger or messages of their own.
  const single = answers.tenantNoun === "none";

  // Scheduling's staff keys, one per job, so a crew member can be given their
  // route without the office's full power (the crew role holds only
  // `staff.schedule.route`). src/server/scheduling-staff.ts maps the
  // package's four permissions onto these.
  const schedulingStaffKeys = single && answers.includeScheduling
    ? `
  "staff.schedule.route": {
    label: "Work a crew's route",
    description: "Open their own crew's day on a phone and mark its stops started, done or couldn't-do. Nothing else.",
    category: "Schedule",
    // And the crew role, which is not in this list on purpose: it is created
    // when the owner first picks somebody for a crew (src/server/scheduling.ts
    // gives it this key and nothing else), not by the staff seed — a
    // \`defaultFor\` naming a template the seed doesn't write grants nothing.
    defaultFor: ["admin", "cs_lead", "cs_agent"],
  },
  "staff.schedule.view": {
    label: "See the schedule",
    description: "The calendar, every crew's day, and the requests waiting for an answer.",
    category: "Schedule",
    defaultFor: ["admin", "cs_lead", "cs_agent"],
  },
  "staff.schedule.manage": {
    label: "Book and change visits",
    description: "Book visits, accept or decline requests, move, reassign and cancel visits. Customers are emailed about each change.",
    category: "Schedule",
    defaultFor: ["admin", "cs_lead", "cs_agent"],
  },
  "staff.schedule.settings": {
    label: "Change scheduling settings",
    description: "The business's time zone, online booking, services, crews, hours and who opens each crew's route.",
    category: "Schedule",
    // Not cs_agent: these decide what customers can book at all.
    defaultFor: ["admin", "cs_lead"],
  },`
    : "";
  // The estimator's staff keys, one per job, on the scheduling pattern. The
  // package declares its permissions for the TENANT ladder (each business runs
  // its own price book); this project serves one business from the staff
  // ladder, so src/server/estimator-staff.ts maps the package's five keys onto
  // these. SEEING COSTS is its own key on purpose: a supply's price and the
  // margin on a job are the owner's, and staff who quote customers see prices.
  const estimatorStaffKeys = single && answers.includeEstimator
    ? `
  "staff.estimates.view": {
    label: "See estimates and the price book",
    description: "Leads, estimates and quotes, the products and their customer prices, and the estimate settings.",
    category: "Estimates",
    defaultFor: ["admin", "cs_lead", "cs_agent"],
  },
  "staff.estimates.manage": {
    label: "Work estimates and send quotes",
    description: "Edit an estimate's lines, send, resend and revise quotes (the customer is emailed), mark one accepted or declined, archive, book the visit and turn an accepted quote into an invoice.",
    category: "Estimates",
    defaultFor: ["admin", "cs_lead", "cs_agent"],
  },
  "staff.estimates.costs": {
    label: "See costs and margins",
    description: "Supply costs, labor rates, the cost breakdown and the margin on every estimate, and what photo reading has cost. Without it, prices only.",
    category: "Estimates",
    defaultFor: ["admin"],
  },
  "staff.estimates.pricebook": {
    label: "Change the price book",
    description: "Products, supplies, labor, markup and options, and loading the sample catalog. This changes what every customer is quoted.",
    category: "Estimates",
    defaultFor: ["admin"],
  },
  "staff.estimates.settings": {
    label: "Change estimate settings",
    description: "The business's details, tax rate, quote rules, who hears about new leads, photo reading and its daily budget, and website embed keys.",
    category: "Estimates",
    defaultFor: ["admin"],
  },`
    : "";
  // Invoicing's and messages' staff keys (Tenancy 2a, D12): one key per job
  // on the scheduling pattern, replacing the `staff.dashboard.view` that used
  // to gate both — a seasonal mower given the shell's key could reverse
  // payments and rewrite every customer email. src/server/invoicing.ts and
  // src/server/comms.ts map the packages' permissions onto these.
  const invoicingStaffKeys = single && answers.includeInvoicing
    ? `
  "staff.invoices.view": {
    label: "See invoices",
    description: "The invoice ledger, every invoice, its lines and payments.",
    category: "Invoices",
    defaultFor: ["admin", "cs_lead"],
  },
  "staff.invoices.manage": {
    label: "Raise and send invoices, record and reverse payments",
    description: "Create and edit invoices, send them (the customer is emailed), void them, and record or reverse a payment.",
    category: "Invoices",
    defaultFor: ["admin"],
  },`
    : "";
  const commsStaffKeys = single && answers.includeComms
    ? `
  "staff.comms.view": {
    label: "See messages",
    description: "The wording of every email and text customers get, and what went to whom and when.",
    category: "Messages",
    defaultFor: ["admin", "cs_lead"],
  },
  "staff.comms.manage": {
    label: "Edit messages and send what's due",
    description: "Change the wording customers get, switch a message off or on, and send what's due now.",
    category: "Messages",
    defaultFor: ["admin"],
  },`
    : "";
  // Alerts' and files' staff keys (Tenancy 2b-1, 13.5): one key per job on
  // the scheduling pattern. src/server/alerts.ts and src/server/files.ts map
  // the packages' permissions onto these.
  const alertsStaffKeys = single && answers.includeNotifications
    ? `
  "staff.alerts.view": {
    label: "Get alerts",
    description: "See your own alerts in the bell, and choose which ones also come by email.",
    category: "Alerts",
    defaultFor: ["admin", "cs_lead", "cs_agent"],
  },
  "staff.alerts.manage": {
    label: "Choose who hears about new work",
    description: "Pick who gets alerts about new estimate requests, visit requests and invoices.",
    category: "Alerts",
    defaultFor: ["admin"],
  },`
    : "";
  const filesStaffKeys = single && answers.includeStorage
    ? `
  "staff.files.view": {
    label: "See files",
    description: "The business's own files and how much storage is used. Photos and files on visits, estimates and invoices also need permission to see those.",
    category: "Files",
    defaultFor: ["admin", "cs_lead"],
  },
  "staff.files.manage": {
    label: "Manage files",
    description: "Add files to the business's files and delete any file, whatever it's attached to.",
    category: "Files",
    defaultFor: ["admin"],
  },`
    : "";
  const staffSpread = [...staffFragments, "appStaffPermissions"];
  const tenantSpread = [...tenantFragments, "appTenantPermissions"];

  const source = `${imports.join("\n")}

/**
 * Permission keys for ${answers.projectName}.
 *
 * Packages contribute plain records; this file spreads them into one catalog
 * per scope. \`contributedBy\` is what catches two packages claiming the same
 * key — a bare spread lets the last one silently win, and which definition
 * survives is decided by import order.
 *
 * Adding a capability is two steps: a key here, and a grant in a role template.
 * Nothing is implicit — a key in no template is denied for everyone, including
 * you.
 *
 * SCOPE IS LOAD-BEARING. Check where the code that reads a key lives before you
 * add it: \`requireStaff\` reads the staff catalog, \`requireTenant\` reads the
 * tenant one, and a key in the wrong scope matches nothing and errors nowhere.
 */

const appTenantPermissions = {
  // "reports.export": { label: "Export reports", category: "Reports" },
} as const;

export const tenantCatalog = definePermissions(
  "tenant",
  { ${tenantSpread.map((f) => `...${f}`).join(", ")} },
  { contributedBy: [${tenantSpread.join(", ")}] },
);

const appStaffPermissions = {
  "staff.dashboard.view": {
    label: "View the admin dashboard",
    category: "Dashboard",
    defaultFor: ["admin", "cs_lead", "cs_agent"],
  },
  "staff.tenants.view": {
    label: "View ${plural}",
    category: "${plural}",
    defaultFor: ["admin", "cs_lead", "cs_agent"],
  },
  // The operator console's two powers over a customer (Tenancy 1). Admin only:
  // each one changes who can get into a ${label.toLowerCase()} at all.
  "staff.tenants.suspend": {
    label: "Suspend and reactivate ${plural.toLowerCase()}",
    description: "Everyone in a suspended one loses access until it's reactivated. Also releases its old web addresses.",
    category: "${plural}",
    defaultFor: ["admin"],
  },
  "staff.tenants.transfer": {
    label: "Give a ${label.toLowerCase()} a new owner",
    description: "For one whose owner closed their account: hand it to one of its active members.",
    category: "${plural}",
    defaultFor: ["admin"],
  },
  "staff.people.view": {
    label: "View people",
    category: "People",
    defaultFor: ["admin", "cs_lead"],
  },
  "staff.roles.view": {
    label: "View roles and permissions",
    category: "Access",
    defaultFor: ["admin", "cs_lead"],
  },
  "staff.roles.manage": {
    label: "Assign templates and set per-person overrides",
    description:
      "Grants and revokes individual capabilities on top of a role template.",
    category: "Access",
    defaultFor: ["admin"],
    // SEALED (review T1-05). Whoever holds this decides what everyone else
    // holds, so an override must never hand it to one person quietly — a
    // cs_lead given it by override could then give themselves every other
    // staff key. Only the admin template carries it.
    sealed: true,
  },
  "staff.audit.view": {
    label: "View the audit log",
    category: "Access",
    defaultFor: ["admin", "cs_lead"],
  },
  "staff.billing.resync": {
    label: "Re-sync billing with Stripe",
    description:
      "Publishes the plan record's prices to Stripe and re-pulls every " +
      "subscription into this application's own tables.",
    category: "Billing",
    // The firm's own key, not a customer's. Every key in
    // \`billingPermissions\` is what an OWNER holds over their own
    // organisation's plan; this is the firm repairing its records across every
    // customer at once, which only the staff ladder has a rung for.
    //
    // cs_lead as well as admin, because the person who needs it is on a call
    // about a subscription that says the wrong thing — and the alternative to
    // giving them the button is giving them the database.
    defaultFor: ["admin", "cs_lead"],
  },
  "staff.tenants.impersonate": {
    label: "Open a customer's own screen",
    description: "Every entry is written to the audit log as sensitive access.",
    category: "${plural}",
    // Sealed: an override must not hand this to one person quietly.
    sealed: true,
  },${schedulingStaffKeys}${estimatorStaffKeys}${invoicingStaffKeys}${commsStaffKeys}${alertsStaffKeys}${filesStaffKeys}
} as const;

export const staffCatalog = definePermissions(
  "staff",
  { ${staffSpread.map((f) => `...${f}`).join(", ")} },
  { contributedBy: [${staffSpread.join(", ")}] },
);

export type TenantPermission = PermissionKeyOf<typeof tenantCatalog>;
export type StaffPermission = PermissionKeyOf<typeof staffCatalog>;
`;

  // The last thing this function does, on the text it is about to hand back.
  // See `assertPermissionScopes` for why it reads the output rather than the
  // table: a check of the inputs against themselves cannot fail.
  assertPermissionScopes(source);
  return source;
}


/**
 * `src/server/invitation-mail.ts` for this project.
 *
 * TWO VARIANTS, ONE SIGNATURE, and the branch is here rather than in the file.
 * Tenancy is in the base package set, so every project can invite somebody;
 * @__SCOPE_NAME__/email is optional, so not every project can post the
 * invitation. The emitted module answers the same question either way —
 * `sendInvitationEmail(request)` resolves to an outcome — and the router that
 * calls it holds no `if` asking whether mail was installed. Without this split
 * the router would have to, and that is precisely the conditional the scaffold
 * refuses to put in a generated artifact.
 *
 * The no-mail variant is a real no-op with a real return value, not a throw and
 * not a null the caller has to remember to test: an invitation created on a
 * project with no email package still produces a working link, which the
 * members page then offers to copy. `createEmailSender` reaching outcome
 * `'skipped'` with no API key is the same pattern one level down, and both
 * exist so that "we have not set up mail yet" never blocks the feature that
 * happens to send some.
 */
export function renderInvitationMail(answers: Answers): string {
  const scope = answers.scope;

  const contract = `/**
 * One invitation, on its way out.
 *
 * \`url\` is absolute because a relative path is not a link in an inbox, and it
 * carries the one-time token — which is why this object never reaches the audit
 * log or a log line. \`invitationId\` is what the delivery log correlates on
 * instead: it is safe to store, and it is what somebody asking "did the mail
 * for this invitation ever go out" has in their hand.
 */
export interface InvitationMailRequest {
  readonly to: string;
  readonly tenantId: string;
  readonly tenantName: string;
  /** Who sent it, as a display name or an address. Null when unknown. */
  readonly invitedBy: string | null;
  readonly roleName: string;
  /** Absolute, and secret: the token is in it. */
  readonly url: string;
  readonly expiresAt: Date | null;
  readonly invitationId: string;
}

/**
 * What became of it.
 *
 * \`delivered\` is deliberately NOT \`status !== "failed"\`. It answers the only
 * question the caller acts on — did a provider accept this message, so that the
 * invitee will get the link without our help — and \`skipped\` answers no just
 * as firmly as \`failed\` does. The members page shows the link to copy exactly
 * when this is false, so collapsing the two would hide the link on a laptop
 * that cannot send mail at all.
 */
export interface InvitationMailOutcome {
  readonly status: "sent" | "skipped" | "failed";
  readonly delivered: boolean;
}
`;

  if (!answers.includeEmail) {
    return `${contract}
/**
 * ${answers.projectName} was generated without @${scope.replace(/^@/, "")}/email.
 *
 * There is no mail package installed and therefore nothing to send with, so
 * every invitation is recorded here as skipped and the link is handed back to
 * whoever created it. That is a complete feature rather than a degraded one:
 * copying a link to a colleague is how most invitations actually travel, and it
 * works with no credentials, no domain and no provider account.
 *
 * Re-generate with \`--email\` to post them instead. Nothing in the router
 * changes — the signature above is the same in both variants, which is the
 * whole reason this module is generated.
 */
export function sendInvitationEmail(
  _request: InvitationMailRequest,
): Promise<InvitationMailOutcome> {
  return Promise.resolve({ status: "skipped", delivered: false });
}

/**
 * Can this project email an invitation at all? No: there is no mail package.
 * The team page's handlers are then given no mailer, so the per-address email
 * limits never hold an invitation back for an email that was never going to
 * go — the inviter gets the link, every time.
 */
export const invitationEmailsConfigured: boolean = false;
`;
  }

  return `import { createEmailSender, formatSenderAddress } from "${scope}/email";
import { emailEvents } from "${scope}/email/schema";
import { db } from "@/db";
import { renderInvitationEmail } from "@/emails/invitation";
import { env } from "@/env";
import { SITE_NAME } from "@/seo";
import { log } from "@/server/logger";

${contract}
/** Recorded in \`email_events.template\`, so the log can be filtered by kind. */
export const INVITATION_TEMPLATE = "tenant-invitation";

/**
 * One sender for the process.
 *
 * EMAIL_FROM is deferred until deployment, so on a laptop it is genuinely
 * undefined — and \`createEmailSender\` throws at construction for a From it
 * cannot parse, which at module scope means the whole app fails to import.
 * The fallback is an RFC 2606 reserved domain that can never receive anything,
 * chosen over a plausible-looking address on purpose: with no API key nothing
 * is dispatched anyway, and if somebody does set a key without a From, the
 * provider's rejection names an address that is obviously a placeholder rather
 * than one that looks like it should have worked.
 */
const sender = createEmailSender({
  apiKey: env.RESEND_API_KEY,
  from: env.EMAIL_FROM ?? "invitations@example.invalid",
  replyTo: env.EMAIL_REPLY_TO,
});

/**
 * Can this project email an invitation? Only with RESEND_API_KEY set: without
 * it every send is "skipped". The team page's handlers are given the mailer
 * only when this is true, so the per-address email limits never hold an
 * invitation back for an email that was never going to go — the inviter gets
 * the link instead.
 */
export const invitationEmailsConfigured: boolean = sender.configured;

export async function sendInvitationEmail(
  request: InvitationMailRequest,
): Promise<InvitationMailOutcome> {
  const body = renderInvitationEmail({
    tenantName: request.tenantName,
    invitedBy: request.invitedBy,
    roleName: request.roleName,
    url: request.url,
    expiresAt: request.expiresAt,
    // The site's own name (what its header says), never the folder it was
    // generated into (review T2A-BO-12: "join Green Acres on igloo-back-office").
    productName: SITE_NAME,
  });

  // The invitation row already exists by the time this runs, so nothing here
  // may throw: an exception would lose the only copy of the link before the
  // caller could hand it back, and the invitee would be waiting on a mail that
  // was never attempted. \`send\` returns a failed outcome for a provider that
  // is down; it THROWS for a message it refuses to build, which is the case
  // this catch covers — an address that satisfied Zod and not the stricter
  // header parser.
  let outcome: Awaited<ReturnType<typeof sender.send>>;
  try {
    outcome = await sender.send({
      to: request.to,
      subject: body.subject,
      html: body.html,
      text: body.text,
      template: INVITATION_TEMPLATE,
      tenantId: request.tenantId,
      // The id, never the token. This column is jsonb in a table kept longer
      // than anything else here; a credential in it outlives the credential.
      metadata: { invitationId: request.invitationId },
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    // Written by hand because there is no outcome to take a log row from. The
    // alternative is no row at all, and a delivery log missing exactly the
    // sends that broke is a delivery log that answers the wrong question.
    await recordDelivery({
      messageId: null,
      toAddress: request.to,
      fromAddress: formatSenderAddress(sender.from),
      subject: body.subject,
      template: INVITATION_TEMPLATE,
      tenantId: request.tenantId,
      status: "failed",
      error: error.message,
      metadata: { invitationId: request.invitationId },
    });
    return { status: "failed", delivered: false };
  }

  // THE PROVIDER'S ANSWER IS THE TRUTH ABOUT THE EMAIL; the log row is
  // bookkeeping. Writing the row used to share the try above, so a provider
  // that had already accepted the message, followed by a database hiccup on
  // the log insert, came back "failed": the inviter read "We couldn't email
  // them", the email wasn't counted, and the next Resend sent a duplicate.
  await recordDelivery(outcome.log);
  return { status: outcome.status, delivered: outcome.status === "sent" };
}

/**
 * Writes one delivery-log row and never throws. A log that can't be written
 * is reported to the server log and nothing more: losing a bookkeeping row is
 * better than telling an inviter something untrue about an email, or losing
 * the link they're waiting on.
 */
async function recordDelivery(row: typeof emailEvents.$inferInsert): Promise<void> {
  try {
    await db.insert(emailEvents).values(row);
  } catch (cause) {
    log.error(
      { err: cause, template: INVITATION_TEMPLATE, status: row.status },
      "invitation email: the delivery log row could not be written",
    );
  }
}
`;
}


/**
 * `src/server/__tests__/invitation-mail.test.ts`, emitted only with --email.
 *
 * Pins the one promise `sendInvitationEmail` makes to the team page: its
 * answer is the PROVIDER'S answer. A provider that accepted the message
 * followed by a failed delivery-log write must still come back "sent" — the
 * round-4 verifier's probe showed it coming back "failed", which told the
 * inviter "We couldn't email them" and let the next Resend send a duplicate.
 * And nothing in it may throw, because the inviter's only copy of the link is
 * waiting on this call.
 */
export function renderInvitationMailTest(answers: Answers): string {
  const scope = answers.scope;
  return `import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  send: async (): Promise<unknown> => {
    throw new Error("set per test");
  },
  insertFails: false,
  inserted: [] as unknown[],
  logged: [] as unknown[],
}));

vi.mock("${scope}/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("${scope}/email")>();
  return {
    ...actual,
    createEmailSender: () => ({
      configured: true,
      from: { name: "Lawn Co", email: "invitations@example.invalid" },
      replyTo: null,
      send: () => state.send(),
    }),
  };
});
vi.mock("@/db", () => ({
  db: {
    insert: () => ({
      values: async (row: unknown) => {
        if (state.insertFails) throw new Error("database hiccup on the log insert");
        state.inserted.push(row);
      },
    }),
  },
}));
vi.mock("@/server/logger", () => ({
  log: { error: (...args: unknown[]) => state.logged.push(args) },
}));

import { sendInvitationEmail } from "@/server/invitation-mail";

const REQUEST = {
  to: "crew@lawnco.test",
  tenantId: "co_test",
  tenantName: "Lawn Co",
  invitedBy: "Ann Owner",
  roleName: "Member",
  url: "https://lawnco.test/invite/tok_never_logged",
  expiresAt: null,
  invitationId: "inv_1",
} as const;

const LOG_ROW = {
  messageId: "msg_1",
  toAddress: REQUEST.to,
  fromAddress: "Lawn Co <invitations@example.invalid>",
  subject: "You're invited",
  template: "tenant-invitation",
  tenantId: REQUEST.tenantId,
  status: "sent",
  error: null,
  metadata: { invitationId: REQUEST.invitationId },
};

beforeEach(() => {
  state.insertFails = false;
  state.inserted.length = 0;
  state.logged.length = 0;
});

describe("sendInvitationEmail answers with the provider's verdict, and never throws", () => {
  it("an email the provider accepted stays 'sent' even when the delivery log can't be written", async () => {
    state.send = async () => ({ status: "sent", messageId: "msg_1", log: LOG_ROW });
    state.insertFails = true;
    await expect(sendInvitationEmail(REQUEST)).resolves.toEqual({ status: "sent", delivered: true });
    // The lost row is reported, and the link (a credential) is not in the report.
    expect(state.logged).toHaveLength(1);
    expect(JSON.stringify(state.logged)).not.toContain("tok_never_logged");
  });

  it("an accepted email with a working log is 'sent' and leaves one row", async () => {
    state.send = async () => ({ status: "sent", messageId: "msg_1", log: LOG_ROW });
    await expect(sendInvitationEmail(REQUEST)).resolves.toEqual({ status: "sent", delivered: true });
    expect(state.inserted).toHaveLength(1);
  });

  it("a message the sender refuses to build is 'failed' — logged when it can be, never thrown when it can't", async () => {
    state.send = async () => {
      throw new Error("header parser refused the address");
    };
    await expect(sendInvitationEmail(REQUEST)).resolves.toEqual({ status: "failed", delivered: false });
    expect(state.inserted).toHaveLength(1);

    state.insertFails = true;
    await expect(sendInvitationEmail(REQUEST)).resolves.toEqual({ status: "failed", delivered: false });
    expect(state.logged).toHaveLength(1);
  });
});
`;
}

/**
 * `src/server/comms-senders.ts` — how a comms message actually leaves.
 *
 * GENERATED, AND THAT IS THE FIX FOR MN-04. This used to be a static file in
 * the comms overlay holding `commsSenders = {}` and the Resend wiring in a
 * comment, so a project generated with BOTH --comms and --email — every one
 * of its parts installed — recorded every message "skipped" until a developer
 * found the comment and typed it in. A business owner told "it sends
 * confirmations" would have deployed a booking page whose customers heard
 * nothing. With --email the sender is wired here; without it there is
 * nothing to send with, and the file says so instead of pretending.
 *
 * `commsEmailConfigured` travels with the senders so a feature that promises
 * an email (the scheduling widget's "we've emailed you") asks the same object
 * that does the sending, rather than re-deriving the answer from the key.
 */
export function renderCommsSenders(answers: Answers): string {
  const scope = answers.scope;
  const companies = isCompanies(answers);
  const noun = tenantLabel(answers).toLowerCase();
  // TENANCY 2b-1 (12.1): a customer email that failed for good becomes an
  // alert. DYNAMIC on purpose (13.10 rule 4): alerts.ts imports this module
  // (its email copies go out through these senders), and tenancy.ts reaches
  // company-setup the same way.
  const onFailed = answers.includeNotifications
    ? `
  // A customer's reminder, quote or invoice email that FAILED FOR GOOD
  // becomes an alert for whoever manages messages (Tenancy 2b-1). Imported
  // when first needed, not at the top of this file: alerts.ts imports this
  // module, and a static import back would be a load-time cycle.
  onFailed: (failure) => import("./alerts").then((m) => m.alertOnCommsFailure(failure)),`
    : "";
  const teamKeys = teamTemplateKeys(answers);

  const header = `/**
 * The app's comms senders, injected into ${scope}/comms. A sender is a function
 * that actually delivers a message; the package owns the templates, the queue
 * and the log, and takes the delivery from here so the provider is the app's
 * choice, not the package's.
 *
 * Generated by create-adminigloo-app from the answers this project was created
 * with. Editing it is fine — it is yours — but \`add email\` will then write
 * its version beside yours as \`.new\` rather than over it.
 *
 * SMS — wire it here when you need it. It REQUIRES \`smsCompliance\` (a type
 * error without it):
 *
 *   import twilio from "twilio";
 *   const twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
 *   sms: (m) =>
 *     twilioClient.messages.create({
 *       to: m.to,
 *       body: m.body,
 *       messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
 *     }),
 *   smsCompliance: { senderName: "Your Business Name" },
 *
 *   Every text is then sent as "Your Business Name: …" with "Reply STOP to opt
 *   out." (or your \`optOutText\`) appended unless the text already contains
 *   that exact line.${companies ? ` In this project each ${noun}'s name (its sender
 *   identity, below) is the name every text of theirs starts with.` : ""} Send through a Twilio MESSAGING SERVICE registered to
 *   your A2P 10DLC campaign (messagingServiceSid), not a bare \`from\` number.
 *   Recipients arrive already normalised to E.164.
 *
 * IMMEDIATE vs LATER. A confirmation goes out in the request that caused it:
 * \`sendNow(db, { tenantId, to, templateKey, vars }, commsSenders)\`. Only
 * future messages (reminders, follow-ups) belong in \`enqueueMessage\` — give
 * them \`refType\`/\`refId\` so \`cancelScheduled\` can withdraw them when the
 * thing they are about is cancelled or moved, and a \`dedupeKey\` if the
 * enqueue can be retried.
 */`;

  if (companies) {
    // EACH COMPANY'S EMAILS GO OUT AS THE COMPANY (Tenancy 2a, D8). No fixed
    // tenant here: every message carries its company's id, and the identity
    // is read per company.
    const identity = `
/**
 * WHO A ${noun.toUpperCase()}'S MESSAGES COME FROM (Tenancy 2a, D8), asked by comms once
 * per ${noun} per send or drain:
 *
 *   From      "{${noun} name}" <EMAIL_FROM's address>. The platform's verified
 *             sending domain is the only one the provider sends from, so the
 *             ${noun}'s NAME goes on it — never another address.
 *   Reply-To  the ${noun}'s contact email, else its owner's sign-in address —
 *             never this site's EMAIL_REPLY_TO while the ${noun} has either: a
 *             customer's "I need to reschedule" must reach the business, not
 *             you. Only a ${noun} with neither falls back to the default.
 *
 * Read per call from the ${noun} profile, so a rename shows on the next email.
 * comms records both in the delivery log (from_name, reply_to), so the owner
 * sees in Messages exactly what their customers saw. A throw here fails that
 * message and the queue retries it: sending a ${noun}'s email under the
 * platform's reply-to is the one outcome worse than a delay.
 */
export async function companyIdentity(tenantId: string): Promise<SenderIdentity | null> {
  const profile = await tenancy.companyProfile(tenantId);
  return profile ? { name: profile.name, replyTo: profile.replyTo } : null;
}
`;
    // EACH COMPANY'S SENDING ALLOWANCE (review SEC-2A-03), on the app's own
    // limiter — only where email can actually leave.
    const allowance = `
/**
 * EACH ${noun.toUpperCase()}'S SENDING ALLOWANCE (review SEC-2A-03): how many emails one
 * ${noun} may send from this site, per hour and per day, asked by comms right
 * before each message is handed to Resend.
 *
 * WHY. Anyone can sign up a ${noun} here, and every ${noun}'s email leaves from
 * YOUR one verified sending domain. Without a ceiling one ${noun} could send
 * thousands of messages in an hour under any name it chose — and the
 * provider's answer, throttling or suspending your account or domain, stops
 * every other ${noun}'s reminders, quotes and invoices with it. Tenancy's
 * invitations are capped the same way.
 *
 *   an established ${noun}      100 an hour, 500 a day
 *   one made in the last week   20 an hour, 100 a day
 *   its TEAM emails             60 an hour, 300 a day, counted on their own
 *
 * THE TEAM'S OWN EMAILS COUNT APART (Tenancy 2b-1, review BO-10): the office
 * notices and the alert emails go only to the ${noun}'s own people (and at
 * most five addresses per alert group), so a morning of alerts must never
 * hold a customer's invoice. The customer allowance exists to stop mail to
 * strangers; the team one stops a runaway loop. TEAM_TEMPLATE_KEYS says which
 * templates are the team's (generated from the installed packages).
 *
 * A held email isn't lost: it is logged in the ${noun}'s Messages as "held",
 * an invoice's Send says the allowance was reached, and a queued reminder is
 * tried again later. When a ${noun} reaches its allowance it is logged and
 * reported to /admin/errors (at most once an hour per ${noun}), so you see
 * who. Raise the numbers here as real ${noun}s need more; they count in
 * Upstash when it is configured (in memory per server otherwise), and a
 * limiter that is down lets mail through rather than stop every ${noun}.
 */
export const COMMS_SEND_ALLOWANCE = {
  established: { hour: 100, day: 500 },
  newCompany: { hour: 20, day: 100 },
  team: { hour: 60, day: 300 },
} as const;

/**
 * The templates that are the ${noun}'s TEAM email, not a customer's: GENERATED
 * from the installed packages' office notices${answers.includeNotifications ? ", and the alert email" : ""}.
 */
export const TEAM_TEMPLATE_KEYS: ReadonlySet<string> = new Set<string>([${teamKeys.map((key) => JSON.stringify(key)).join(", ")}]);

/** How long a ${noun} counts as new, for the lower allowance. */
const NEW_COMPANY_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** When each ${noun} was made, read once per process: it never changes. */
const createdAt = new Map<string, number>();
/** When each ${noun} last hit its allowance was reported, so a held backlog reports once an hour, not per email. */
const reportedAt = new Map<string, number>();

export async function companySendAllowance(message: { readonly tenantId: string; readonly templateKey?: string }): Promise<boolean> {
  const { tenantId } = message;
  // Whose email this is — the team's or a customer's — is the MESSAGE'S
  // template (runtime data), not a feature switch.
  const team = message.templateKey !== undefined && TEAM_TEMPLATE_KEYS.has(message.templateKey);
  let caps: { readonly hour: number; readonly day: number } = COMMS_SEND_ALLOWANCE.team;
  if (!team) {
    let made = createdAt.get(tenantId);
    if (made === undefined) {
      const profile = await tenancy.companyProfile(tenantId);
      // An unknown ${noun} gets the new one's allowance: nothing to trust yet.
      made = profile ? profile.createdAt.getTime() : Date.now();
      if (profile) createdAt.set(tenantId, made);
    }
    caps = Date.now() - made < NEW_COMPANY_MS ? COMMS_SEND_ALLOWANCE.newCompany : COMMS_SEND_ALLOWANCE.established;
  }
  const which = team ? "team" : "customer";
  for (const [bucket, limit, windowMs] of [
    ["hour", caps.hour, HOUR_MS],
    ["day", caps.day, DAY_MS],
  ] as const) {
    const key = team ? \`comms-out-team:\${bucket}:\${tenantId}\` : \`comms-out:\${bucket}:\${tenantId}\`;
    const result = await limiter.limit({ key, policy: { limit, windowMs } });
    if (!result.allowed) {
      const last = reportedAt.get(\`\${which}:\${tenantId}\`) ?? 0;
      if (Date.now() - last > HOUR_MS) {
        reportedAt.set(\`\${which}:\${tenantId}\`, Date.now());
        log.warn({ tenantId, bucket, limit, allowance: which }, "comms: a ${noun} reached its sending allowance; its emails are held");
        void reportError({
          error: new Error(\`A ${noun} reached its \${which} sending allowance (\${limit} emails a\${bucket === "hour" ? "n hour" : " day"}); those emails are held until it refills.\`),
          source: "route",
          tenantId,
          context: { feature: "comms", route: "allowance", bucket, allowance: which },
        });
      }
      return false;
    }
  }
  return true;
}
`;
    if (!answers.includeEmail) {
      return `import type { CommsSenders, SenderIdentity } from "${scope}/comms";
import { tenancy } from "./tenancy";

${header}
${identity}
/**
 * NO EMAIL SENDER: ${answers.projectName} was generated without
 * ${scope}/email, so there is nothing here to send mail with. comms records
 * each email as "skipped" — a real outcome in the log, never a fake "sent" —
 * with the ${noun} name and reply-to it WOULD have gone out under, and nothing
 * throws. \`add email\` (pnpm dlx @adminigloo/create-app add email) rewrites
 * this file with Resend wired in.
 */
export const commsSenders: CommsSenders = { identity: companyIdentity${onFailed ? `,${onFailed}\n` : " "}};

/** False: an email "sent" from this project is logged as skipped. Promise none. */
export const commsEmailConfigured: boolean = false;
`;
    }
    return `import type { CommsSenders, SenderIdentity } from "${scope}/comms";
import { createEmailSender, type EmailSender, type EmailTransport } from "${scope}/email";
import { env } from "@/env";
import { reportError } from "./error-reporter";
import { log } from "./logger";
import { limiter } from "./rate-limit";
import { tenancy } from "./tenancy";

${header}
${identity}${allowance}
/**
 * EMAIL THROUGH ${scope}/email (Resend). With no RESEND_API_KEY the sender
 * answers "skipped" for every message and comms logs exactly that, so the
 * whole flow runs on a laptop and the log shows what would have gone out.
 *
 * EMAIL_FROM is deferred until deployment, so on a laptop it is undefined —
 * and \`createEmailSender\` refuses a From it cannot parse at construction,
 * which at module scope would fail every import of this file. The fallback is
 * an RFC 2606 reserved domain that can never receive anything.
 *
 * \`transport\` replaces Resend — how the project's own email-identity test
 * (src/server/__tests__/company-email.test.ts) reads exactly what each
 * ${noun}'s email went out as, through these same senders.
 */
function mailerFor(transport?: EmailTransport): EmailSender {
  return createEmailSender({
    apiKey: env.RESEND_API_KEY,
    from: env.EMAIL_FROM ?? "messages@example.invalid",
    replyTo: env.EMAIL_REPLY_TO,
    ...(transport ? { send: transport } : {}),
  });
}

function sendersOver(mailer: EmailSender): CommsSenders {
  return {
    identity: companyIdentity,
    // Each ${noun}'s sending allowance (above): asked before every email leaves.
    allowance: companySendAllowance,${onFailed.replace(/\n  /g, "\n    ")}
    // The template is plain text; comms hands over \`html\` already converted
    // (escaped first, then paragraphs and links), so a customer's name can
    // never become markup. The ${noun}'s name and reply-to ride on each
    // message (\`fromName\`, \`replyTo\`), and the outcome is returned as it is
    // so the delivery log stays honest without this function throwing.
    email: (message) =>
      mailer.send({
        to: message.to,
        subject: message.subject,
        text: message.body,
        html: message.html,
        template: "comms",
        tenantId: message.tenantId,
        fromName: message.fromName,
        replyTo: message.replyTo,
      }),
  };
}

/** These senders over another transport (a test's capture). */
export function buildCommsSenders(transport?: EmailTransport): CommsSenders {
  return sendersOver(mailerFor(transport));
}

const mailer = mailerFor();

export const commsSenders: CommsSenders = sendersOver(mailer);

/**
 * Whether an email sent now would actually leave: true once RESEND_API_KEY is
 * set. The booking and estimate pages read it so they never tell a customer
 * "we've emailed you" from a deployment that cannot.
 */
export const commsEmailConfigured: boolean = mailer.configured;
`;
  }

  // SINGLE BUSINESS: the one fixed business's messages, as before 2a.
  const templates = `
/**
 * The tenant every comms row in this project is written for. Single-business,
 * like the rest of the field-service features — and equal to the scheduling
 * tenant, so the visit emails are edited in /admin/comms beside the rest.
 */
export const COMMS_TENANT = "primary";

let templatesSeeded = false;
export async function ensureCommsTemplates(db = sharedDb): Promise<void> {
  if (templatesSeeded) return;
  await seedDefaultTemplates(db, COMMS_TENANT);
  templatesSeeded = true;
}
`;

  if (!answers.includeEmail) {
    return `import { seedDefaultTemplates, type CommsSenders } from "${scope}/comms";
import { db as sharedDb } from "@/db";

${header}

/**
 * NO EMAIL SENDER: ${answers.projectName} was generated without
 * ${scope}/email, so there is nothing here to send mail with. comms records
 * each email as "skipped" — a real outcome in the log, never a fake "sent" —
 * and nothing throws. \`add email\` (pnpm dlx @adminigloo/create-app add email)
 * rewrites this file with Resend wired in.
 */
export const commsSenders: CommsSenders = {${onFailed ? `${onFailed}\n` : ""}};

/** False: an email "sent" from this project is logged as skipped. Promise none. */
export const commsEmailConfigured: boolean = false;
${templates}`;
  }

  return `import { seedDefaultTemplates, type CommsSenders } from "${scope}/comms";
import { createEmailSender } from "${scope}/email";
import { db as sharedDb } from "@/db";
import { env } from "@/env";

${header}

/**
 * EMAIL THROUGH ${scope}/email (Resend). With no RESEND_API_KEY the sender
 * answers "skipped" for every message and comms logs exactly that, so the
 * whole flow runs on a laptop and the log shows what would have gone out.
 * Set the key (and EMAIL_FROM, on a domain Resend has verified) and the same
 * code sends.
 *
 * EMAIL_FROM is deferred until deployment, so on a laptop it is undefined —
 * and \`createEmailSender\` refuses a From it cannot parse at construction,
 * which at module scope would fail every import of this file. The fallback is
 * an RFC 2606 reserved domain that can never receive anything, so a key set
 * without a From fails at the provider naming an obvious placeholder.
 */
const mailer = createEmailSender({
  apiKey: env.RESEND_API_KEY,
  from: env.EMAIL_FROM ?? "messages@example.invalid",
  replyTo: env.EMAIL_REPLY_TO,
});

export const commsSenders: CommsSenders = {${onFailed}
  // The template is plain text; comms hands over \`html\` already converted
  // (escaped first, then paragraphs and links), so a customer's name can
  // never become markup. Never interpolate \`message.body\` into HTML yourself.
  //
  // The outcome is returned as it is: comms reads \`{ status: "skipped" }\` as a
  // skip and an outcome carrying \`error\` as a failure, so the delivery log
  // stays honest without this function throwing.
  email: (message) =>
    mailer.send({
      to: message.to,
      subject: message.subject,
      text: message.body,
      html: message.html,
      template: "comms",
      tenantId: message.tenantId,
      fromName: message.fromName,
      replyTo: message.replyTo,
    }),
};

/**
 * Whether an email sent now would actually leave: true once RESEND_API_KEY is
 * set. The scheduling widget reads it (through the handlers' \`emailsEnabled\`)
 * so it never tells a customer "we've emailed you" from a deployment that
 * cannot.
 */
export const commsEmailConfigured: boolean = mailer.configured;
${templates}`;
}

/**
 * `src/server/comms-hooks.ts` — what the comms queue drain asks at send time.
 *
 * GENERATED FROM WHICH FEATURES QUEUE MESSAGES. Scheduling queues reminders,
 * and a reminder has to be re-checked when it is due (the visit may have moved
 * or been cancelled since) and given a freshly minted manage link, which is
 * then scrubbed from the delivery log. The cron route and the console's "send
 * due now" both call these two functions; which producers they consult is a
 * generated array — empty without scheduling, never an `if`.
 */
export function renderCommsHooks(answers: Answers): string {
  const scope = answers.scope;
  const producers = [
    ...(answers.includeScheduling ? ["schedulingComms"] : []),
    ...(answers.includeEstimator ? ["estimatorComms"] : []),
    ...(answers.includeInvoicing ? ["invoicingProducer"] : []),
  ];
  const imports = [
    `import type { BeforeSendResult, ScheduledRow } from "${scope}/comms";`,
    `import { log } from "@/server/logger";`,
    ...(answers.includeScheduling
      ? [`import { schedulingComms } from "@/server/scheduling-notify";`]
      : []),
    ...(answers.includeEstimator
      ? [`import { estimatorComms } from "@/server/estimator-notify";`]
      : []),
    ...(answers.includeInvoicing ? [`import { invoicingComms } from "@/server/invoicing";`] : []),
  ];
  const paragraphs: string[] = [];
  if (answers.includeScheduling) {
    paragraphs.push(`
 * Scheduling. Its reminders are queued without a link (the row sits in a
 * table for a day), so at send time it checks the visit is still on, at the
 * same time, more than 30 minutes away — and mints the customer's manage link
 * into the one it sends. \`afterCommsRun\` then replaces that link in the
 * delivery log with ":token", so no key to a customer's visit is kept there.`);
  }
  if (answers.includeEstimator) {
    paragraphs.push(`
 * The estimator. The follow-up on an unanswered quote is queued for days
 * without a link; at send time it checks the quote is still waiting on the
 * customer (not answered, revised or expired) and mints a fresh quote link
 * into the one it sends. \`afterCommsRun\` scrubs that link from the delivery
 * log the same way.`);
  }
  if (answers.includeInvoicing) {
    paragraphs.push(`
 * Invoicing (Tenancy 2a). It queues nothing — an invoice email goes out the
 * moment staff press Send — but that email carries the customer's invoice
 * link, which is replaced with ":token" in the delivery log right after each
 * send; \`afterCommsRun\` sweeps again for one a crashed send left behind.`);
  }
  const invoicingProducer = answers.includeInvoicing
    ? `/**
 * Invoicing's place in the list: nothing of its own to re-check at send time
 * (null: not its row), its link scrub after each drain, and its invoice email
 * template beside the others. Read lazily, inside each method: the invoicing
 * glue imports modules that import this one.
 */
const invoicingProducer: QueueProducer = {
  beforeSend: async () => null,
  redactSent: () => invoicingComms.redactSent(),
  ensureTemplates: (tenantId) => invoicingComms.ensureTemplates(tenantId),
};

`
    : "";
  const why = paragraphs.length > 0
    ? `
 * Here, in order:${paragraphs.join("\n *")}`
    : `
 * Nothing in this project queues messages that need a second look, so the
 * list below is empty and every due row is sent as it is. A feature added
 * later with \`add\` that does (scheduling's reminders) is listed here.`;

  return `${imports.join("\n")}

/**
 * The comms queue drain's hooks, from the features that queue messages.
 *${why}
 *
 * Called by /api/cron/comms and by the console's "send due now", so a message
 * sent either way is handled the same.
 */
interface QueueProducer {
  /** null: not one of this producer's rows — let the next one, or the default, decide. */
  beforeSend(row: ScheduledRow): Promise<BeforeSendResult | null>;
  /** After the drain: remove whatever \`beforeSend\` put into the delivery log that must not stay there. */
  redactSent(): Promise<number>;
  /** The producer's own email templates, added if absent (never over an owner's edit). */
  ensureTemplates?(tenantId: string): Promise<number>;
}

${invoicingProducer}const PRODUCERS: readonly QueueProducer[] = [${producers.join(", ")}];

/** For \`runDueMessages\`' \`beforeSend\`. A row no producer claims is sent as queued. */
export async function commsBeforeSend(row: ScheduledRow): Promise<BeforeSendResult> {
  for (const producer of PRODUCERS) {
    const decision = await producer.beforeSend(row);
    if (decision !== null) return decision;
  }
  return "send";
}

/**
 * The features' own templates, for the Messages console: added if absent and
 * never over an owner's edit, so they can be read and edited before the
 * first message of their kind is ever sent.
 */
export async function ensureProducerTemplates(tenantId: string): Promise<void> {
  for (const producer of PRODUCERS) {
    try {
      await producer.ensureTemplates?.(tenantId);
    } catch (error) {
      log.error({ err: error }, "comms: a feature's templates couldn't be added");
    }
  }
}

/**
 * Right after \`runDueMessages\`, in a \`finally\` in the same invocation. A
 * failure is logged and left for the next run rather than failing a drain
 * whose messages have already gone; the scheduling producer also sweeps the
 * recent log for any link a crashed run left behind, so nothing depends on
 * this process's memory.
 */
export async function afterCommsRun(): Promise<void> {
  for (const producer of PRODUCERS) {
    try {
      await producer.redactSent();
    } catch (error) {
      log.error({ err: error }, "comms: cleaning the delivery log after a run failed");
    }
  }
}
`;
}

/**
 * `src/server/scheduling-notify.ts` — who hears about each visit.
 *
 * Every scheduling write (a customer's request, staff accepting or moving a
 * visit, a request lapsing) emits one event after it commits, and the routes
 * hand each to `onSchedulingEvent`. With --comms that is the scheduling comms
 * listener: the acknowledgement, the confirmation with a manage link, the
 * reminder queued a day ahead, the notes when a visit is moved, reassigned,
 * declined, cancelled or released, and the office's notices. Without --comms
 * the list is empty and the booking page says it sends no email.
 */
export function renderSchedulingNotify(answers: Answers): string {
  // A companies project: every company's visit emails are its own (Tenancy
  // 2a) — features-emit.ts writes that variant.
  if (isCompanies(answers)) return renderSchedulingNotifyCompanies(answers);
  const scope = answers.scope;
  const alerts = answers.includeNotifications;
  // ALERTS FIRST (Tenancy 2b-1, 4.5): the alert rows are written before the
  // office email, so it finds them to claim. Inside an arrow (13.10 rule 3).
  const alertListener = alerts ? ["(event) => alertOnSchedulingEvent(event)"] : [];
  // The office email goes to Alert settings' choice where there is an Alert
  // settings page to make it on (a shell); otherwise 2a's list (13.4).
  const routed = alerts && answers.adminShell !== "none";
  const header = `/**
 * Who hears about each visit — the listeners every scheduling event is handed
 * to, after the write that caused it has committed.
 *
 * Generated by create-adminigloo-app from the answers this project was created
 * with. Add your own listener to LISTENERS (a Slack ping, a webhook, an audit
 * row); each is awaited in turn, and one that throws is logged without
 * stopping the others or failing the customer's request — the visit is booked
 * whether or not the mail server is up.
 *
 * An event carries no manage token and no requester key, so it is safe to log
 * or forward as it is. Whoever needs a manage link mints one
 * (\`issueManageToken\`), the way the comms listener does.
 */`;

  const dispatch = `
/** The \`onEvent\` both scheduling route handlers and the expiry cron are given. Never throws. */
export async function onSchedulingEvent(event: SchedulingEvent): Promise<void> {
  for (const listener of LISTENERS) {
    try {
      await listener(event);
    } catch (error) {
      log.error({ err: error, eventId: event.id, type: event.type }, "a scheduling listener failed");
    }
  }
}
`;

  if (!answers.includeComms) {
    return `import type { DeliveryStatus, SchedulingEvent, SchedulingEventListener } from "${scope}/scheduling";
${alerts ? `import { alertOnSchedulingEvent } from "@/server/alerts";\n` : ""}import { log } from "@/server/logger";
import { schedulingDeliveryStatus } from "@/server/scheduling-config";

${header}

/**
 * ${alerts ? "THE ALERTS ONLY" : "EMPTY"}: ${answers.projectName} was generated without ${scope}/comms, so no
 * email is sent about a visit. Customers keep the manage link the booking
 * page hands them, and staff see requests in /admin/schedule${alerts ? " (and get the\n * alerts, in the app)" : ""}.
 * \`add comms\` (and \`add email\`) wires the emails in.
 */
const LISTENERS: readonly SchedulingEventListener[] = [${alertListener.join(", ")}];

/** False: the booking page promises no email and shows the manage link to keep instead. */
export const SCHEDULING_EMAILS_ENABLED: boolean = false;

/** No comms, so no email templates to add. */
export async function ensureSchedulingEmailTemplates(): Promise<void> {}

/**
 * What the staff screens are told (their banner, and whether they offer
 * "Email the customer"): no email leaves this project, so nothing offers one.
 */
export async function schedulingDelivery(): Promise<DeliveryStatus> {
  return schedulingDeliveryStatus({
    commsInstalled: false,
    emailConfigured: false,
    cronSecretSet: false,
    reminderRuns: { dailyAtUtc: "00:00" },
    failedLastWeek: 0,
    overdueReminders: 0,
    overdueSince: null,
    timeZone: "UTC",
  });
}
${dispatch}`;
  }

  // The staff calendar link in the office's notices exists only where there
  // is a shell to hold the calendar; a link to a 404 in every "new request"
  // email is worse than none (the template reads "—").
  const adminUrl =
    answers.adminShell !== "none" ? "\n  adminUrl: schedulingUrls.admin," : "";
  const runAt = `${String(COMMS_CRON_DAILY_AT_UTC.hour).padStart(2, "0")}:${String(COMMS_CRON_DAILY_AT_UTC.minute).padStart(2, "0")}`;

  return `import { and, count, eq, gte, like, lt, min } from "drizzle-orm";
import { commsMessages, commsScheduled } from "${scope}/comms";
import { getSchedulingSettings, type DeliveryStatus, type SchedulingEvent, type SchedulingEventListener } from "${scope}/scheduling";
import { SCHEDULING_COMMS_REF_TYPE, createSchedulingCommsListener } from "${scope}/scheduling/comms";
import { db } from "@/db";
import { env } from "@/env";
${alerts ? `import { ${routed ? "alertOnSchedulingEvent, officeRecipientsFor, officeSentFor" : "alertOnSchedulingEvent"} } from "@/server/alerts";\n` : ""}import { commsEmailConfigured, commsSenders } from "@/server/comms-senders";
import { log } from "@/server/logger";
import { schedulingDeliveryStatus, schedulingLinks } from "@/server/scheduling-config";
import { SCHEDULING_TENANT } from "@/server/scheduling-staff";

${header}

/**
 * This module's own copy of the links, built from the same config as
 * src/server/scheduling.ts's — not imported from it, because scheduling.ts
 * imports THIS module (for the email templates at first boot), and two
 * modules importing each other leave one half-initialised.
 */
const schedulingUrls = schedulingLinks(env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000");

/**
 * When the comms cron runs: vercel.json's "/api/cron/comms" schedule, once a
 * day at ${runAt} UTC (Vercel Hobby). The listener queues each reminder for
 * the last run at or before its time, so it arrives the day before the visit,
 * a little more than the lead ahead — never the morning of, past the change
 * cutoff. Tighten the cron (every 15 minutes on Pro, DEPLOYMENT.md) and change
 * this to \`{ everyMinutes: 15 }\` with it, and reminders go out at the lead.
 */
const REMINDER_RUNS = { dailyAtUtc: "${runAt}" } as const;

/**
 * The visit emails, through ${scope}/comms: templates the owner edits in
 * /admin/comms (inserted once if absent, never overwritten), sends logged
 * per message, and the reminder queued for the comms cron. Every customer
 * email carries a freshly minted link to /visit/[token]; the link is
 * replaced with ":token" in the delivery log right after it is sent.
 *
 * WHO IN THE OFFICE HEARS about new requests and customer changes: the
 * addresses the owner sets in Schedule settings. Until they set any, the
 * first administrator (BOOTSTRAP_ADMIN_EMAIL) does, so the first online
 * request on a new deployment is not discovered a day late by accident.
 */
export const schedulingComms = createSchedulingCommsListener({
  db,
  senders: commsSenders,
  manageUrl: (token) => schedulingUrls.manage(token),
  bookUrl: schedulingUrls.book,${adminUrl}
  staffEmails: env.BOOTSTRAP_ADMIN_EMAIL ? [env.BOOTSTRAP_ADMIN_EMAIL] : [],${routed ? `
  // WHO GETS THE OFFICE EMAIL (Tenancy 2b-1, D6): the people Alert settings
  // name for visit requests and customers' changes (every staff administrator until someone is
  // chosen), each claimed once — never two emails for one event. The saved
  // list in the feature's settings is no longer read; \`staffEmails\` above is
  // read ONLY when this throws (review BO-02).
  officeRecipients: (notice) => officeRecipientsFor(notice),
  // A failed office email goes back to the alerts cron, sent once as a team
  // alert (review BO-02).
  officeSent: (notice, result) => officeSentFor(notice, result),` : ""}
  reminderRuns: REMINDER_RUNS,
  onError: (error, context) => log.error({ err: error, ...context }, "scheduling: an email step failed"),
});

const LISTENERS: readonly SchedulingEventListener[] = [${[...alertListener, "schedulingComms.onEvent"].join(", ")}];

/**
 * Told to the booking widget through the public handler's \`emailsEnabled\`:
 * true only when an email would actually leave (RESEND_API_KEY set), so the
 * page never says "we've emailed you" from a deployment that cannot.
 */
export const SCHEDULING_EMAILS_ENABLED: boolean = commsEmailConfigured;

/**
 * The nine visit emails, added to Messages at first boot (never over an
 * owner's edit), so the owner can read and brand them before the first
 * customer books.
 */
export async function ensureSchedulingEmailTemplates(): Promise<void> {
  await schedulingComms.ensureTemplates(SCHEDULING_TENANT);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What the staff screens are told — their banner, and whether they offer
 * "Email the customer": is the sender configured, is the cron allowed to run,
 * did visit emails fail this week, and are reminders sitting unsent past their
 * time (the cron not running). The office reads it in plain words on the
 * calendar instead of discovering it from a customer.
 */
export async function schedulingDelivery(): Promise<DeliveryStatus> {
  let failedLastWeek = 0;
  let overdueReminders = 0;
  let overdueSince: Date | null = null;
  let timeZone = "UTC";
  try {
    timeZone = (await getSchedulingSettings(db, SCHEDULING_TENANT)).timeZone;
    const [failed] = await db
      .select({ n: count() })
      .from(commsMessages)
      .where(
        and(
          eq(commsMessages.tenantId, SCHEDULING_TENANT),
          eq(commsMessages.status, "failed"),
          like(commsMessages.templateKey, "visit_%"),
          gte(commsMessages.createdAt, new Date(Date.now() - 7 * DAY_MS)),
        ),
      );
    failedLastWeek = Number(failed?.n ?? 0);
    // A reminder more than a day past its time is a cron that isn't running.
    const [late] = await db
      .select({ n: count(), oldest: min(commsScheduled.sendAt) })
      .from(commsScheduled)
      .where(
        and(
          eq(commsScheduled.tenantId, SCHEDULING_TENANT),
          eq(commsScheduled.status, "pending"),
          eq(commsScheduled.refType, SCHEDULING_COMMS_REF_TYPE),
          lt(commsScheduled.sendAt, new Date(Date.now() - 26 * 60 * 60 * 1000)),
        ),
      );
    overdueReminders = Number(late?.n ?? 0);
    overdueSince = late?.oldest ? new Date(late.oldest) : null;
  } catch (error) {
    log.warn({ err: error }, "scheduling: couldn't read the delivery log for the staff banner");
  }
  return schedulingDeliveryStatus({
    commsInstalled: true,
    emailConfigured: commsEmailConfigured,
    cronSecretSet: Boolean(env.CRON_SECRET),
    reminderRuns: REMINDER_RUNS,
    failedLastWeek,
    overdueReminders,
    overdueSince,
    timeZone,
  });
}
${dispatch}`;
}

/**
 * `src/server/estimator-features.ts` — what the estimator's PUBLIC pages need
 * to know about the rest of the project, as constants.
 *
 * Its own module, and constants only, so /estimate and /quote/[token] can read
 * it without importing a database handle, a model client or a blob store. Today
 * that is one fact: whether an estimate leads to a booking page.
 */
export function renderEstimatorFeatures(answers: Answers): string {
  // A companies project: the booking button goes to each company's OWN
  // booking page, so it is a function of the company's public path.
  if (isCompanies(answers)) return renderEstimatorFeaturesCompanies(answers);
  const book = answers.includeScheduling
    ? `/**
 * Where "Book a visit to measure" (after a customer saves an estimate) and
 * "Pick a time for the work" (after they accept a quote) go: the scheduling
 * booking page. The widget adds ?estimate=<id>, so the visit is tied to the
 * estimate and listed on it in /admin/estimates/[id].
 */
export const ESTIMATE_BOOK_VISIT_HREF: string | undefined = "/book-visit";`
    : `/**
 * Where "Book a visit to measure" and "Pick a time for the work" would go.
 * Nowhere: ${answers.projectName} was generated without scheduling, so neither
 * button is shown — the customer is told the business will be in touch.
 * \`add scheduling\` sets this to the booking page.
 */
export const ESTIMATE_BOOK_VISIT_HREF: string | undefined = undefined;`;

  return `/**
 * What this project's estimator is wired to, for the public pages.
 *
 * Generated by create-adminigloo-app from the answers this project was created
 * with; \`add\` rewrites it when a feature it names is added later. Constants
 * only, so the estimate page and the quote page can import it without pulling
 * a database, a model or a blob store into their render.
 */

${book}
`;
}

/**
 * `src/server/estimator-notify.ts` — who hears about each estimate.
 *
 * Every estimator write (a customer's lead, a quote sent, viewed, accepted,
 * declined, revised, expired, an estimate converted) emits one event after it
 * commits, and the routes hand each to `onEstimatorEvent`. With --comms that is
 * the estimator comms listener: the new-lead email to the office and the copy
 * to the customer, the quote with its link, the follow-up queued for when the
 * customer doesn't answer (withdrawn the moment they do), the thank-you, the
 * expiry note and the office's notices. Without --comms the list is empty and
 * the estimate page promises no email.
 */
export function renderEstimatorNotify(answers: Answers): string {
  // A companies project: every company's estimate emails are its own.
  if (isCompanies(answers)) return renderEstimatorNotifyCompanies(answers);
  const scope = answers.scope;
  const alerts = answers.includeNotifications;
  // ALERTS FIRST (Tenancy 2b-1, 4.5), inside an arrow (13.10 rule 3).
  const alertListener = alerts ? ["(event) => alertOnEstimatorEvent(event)"] : [];
  const routed = alerts && answers.adminShell !== "none";
  const header = `/**
 * Who hears about each estimate — the listeners every estimator event is
 * handed to, after the write that caused it has committed.
 *
 * Generated by create-adminigloo-app from the answers this project was created
 * with. Add your own listener to LISTENERS (a Slack ping, a webhook, a CRM);
 * each is awaited in turn, and one that throws is logged without stopping the
 * others or failing the customer's request — the lead is saved whether or not
 * the mail server is up.
 *
 * An event carries no quote token, no cost and no requester key, so it is safe
 * to log or forward as it is. Whoever needs a quote link mints one
 * (\`issueQuoteToken\`), the way the comms listener does.
 */`;

  const dispatch = `
/** The \`onEvent\` both estimator route handlers and the expiry cron are given. Never throws. */
export async function onEstimatorEvent(event: EstimatorEvent): Promise<void> {
  for (const listener of LISTENERS) {
    try {
      await listener(event);
    } catch (error) {
      log.error({ err: error, eventId: event.id, type: event.type }, "an estimator listener failed");
    }
  }
}
`;

  if (!answers.includeComms) {
    return `import type { EstimatorDelivery, EstimatorEvent, EstimatorEventListener } from "${scope}/estimator";
${alerts ? `import { alertOnEstimatorEvent } from "@/server/alerts";\n` : ""}import { estimatorDeliveryStatus } from "@/server/estimator-config";
import { log } from "@/server/logger";

${header}

/**
 * ${alerts ? "THE ALERTS ONLY" : "EMPTY"}: ${answers.projectName} was generated without ${scope}/comms, so no
 * email is sent about an estimate. New leads wait in /admin/estimates${alerts ? " (and\n * staff get the alerts, in the app)" : ""}, and
 * staff copy a quote's link to the customer from the estimate ("Copy link").
 * \`add comms\` (and \`add email\`) wires the emails in.
 */
const LISTENERS: readonly EstimatorEventListener[] = [${alertListener.join(", ")}];

/** False: the estimate page promises no email. */
export const ESTIMATOR_EMAILS_ENABLED: boolean = false;

/** No comms, so no email templates to add. */
export async function ensureEstimatorEmailTemplates(): Promise<void> {}

/** What the staff screens are told: no email leaves this project. */
export async function estimatorDelivery(): Promise<EstimatorDelivery> {
  return estimatorDeliveryStatus({ commsInstalled: false, emailConfigured: false, cronSecretSet: false });
}
${dispatch}`;
  }

  const runAt = `${String(COMMS_CRON_DAILY_AT_UTC.hour).padStart(2, "0")}:${String(COMMS_CRON_DAILY_AT_UTC.minute).padStart(2, "0")}`;
  // The accepted email's next step is the booking page — only where there is
  // one. Without scheduling the template's line reads "we'll be in touch".
  const bookUrl = answers.includeScheduling
    ? "\n  bookUrl: (estimate) => estimatorUrls.bookVisit(estimate.id),"
    : "";

  return `import type { EstimatorDelivery, EstimatorEvent, EstimatorEventListener } from "${scope}/estimator";
import { createEstimatorCommsListener } from "${scope}/estimator/comms";
import { db } from "@/db";
import { env } from "@/env";
${alerts ? `import { ${routed ? "alertOnEstimatorEvent, officeRecipientsFor, officeSentFor" : "alertOnEstimatorEvent"} } from "@/server/alerts";\n` : ""}import { commsEmailConfigured, commsSenders } from "@/server/comms-senders";
import { estimatorDeliveryStatus, estimatorLinks } from "@/server/estimator-config";
import { ESTIMATOR_TENANT } from "@/server/estimator-staff";
import { log } from "@/server/logger";

${header}

/**
 * This module's own copy of the links, built from the same config as
 * src/server/estimator.ts's — not imported from it, because estimator.ts
 * imports THIS module (for the email templates at first boot), and two
 * modules importing each other leave one half-initialised.
 */
const estimatorUrls = estimatorLinks(env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000");

/**
 * When the comms cron runs: vercel.json's "/api/cron/comms" schedule, once a
 * day at ${runAt} UTC (Vercel Hobby). A follow-up is queued for the last run at
 * or before its day, so "follow up after 3 days" goes out on the third day's
 * run rather than the fourth's. Tighten the cron (every 15 minutes on Pro,
 * DEPLOYMENT.md) and change this to \`{ everyMinutes: 15 }\` with it.
 */
const FOLLOW_UP_RUNS = { dailyAtUtc: "${runAt}" } as const;

/**
 * The estimate emails, through ${scope}/comms: seven templates the owner edits
 * in /admin/comms (inserted once if absent, never overwritten), sends logged
 * per message, and the follow-up queued for the comms cron. Every customer
 * email carries a freshly minted link to /quote/[token]; the link is replaced
 * with ":token" in the delivery log right after it is sent.
 *
 * WHO IN THE OFFICE HEARS about new leads and answers: the addresses the owner
 * sets in Estimate settings ("Lead alerts"). Until they set any, the first
 * administrator (BOOTSTRAP_ADMIN_EMAIL) does, so the first lead on a new
 * deployment is not discovered a day late by accident.
 */
export const estimatorComms = createEstimatorCommsListener({
  db,
  senders: commsSenders,
  quoteUrl: (token) => estimatorUrls.quote(token),
  adminEstimateUrl: (estimateId) => estimatorUrls.adminEstimate(estimateId),${bookUrl}
  staffEmails: env.BOOTSTRAP_ADMIN_EMAIL ? [env.BOOTSTRAP_ADMIN_EMAIL] : [],${routed ? `
  // WHO GETS THE OFFICE EMAIL (Tenancy 2b-1, D6): the people Alert settings
  // name for new estimate requests and quote answers (every staff administrator until someone is
  // chosen), each claimed once — never two emails for one event. The saved
  // list in the feature's settings is no longer read; \`staffEmails\` above is
  // read ONLY when this throws (review BO-02).
  officeRecipients: (notice) => officeRecipientsFor(notice),
  // A failed office email goes back to the alerts cron, sent once as a team
  // alert (review BO-02).
  officeSent: (notice, result) => officeSentFor(notice, result),` : ""}
  followUpRuns: FOLLOW_UP_RUNS,
  onError: (error, context) => log.error({ err: error, ...context }, "estimator: an email step failed"),
});

const LISTENERS: readonly EstimatorEventListener[] = [${[...alertListener, "estimatorComms.onEvent"].join(", ")}];

/**
 * Told to the estimate page through the public handler's \`emailsEnabled\`:
 * true only when an email would actually leave (RESEND_API_KEY set), so the
 * page never says "we've emailed you a copy" from a deployment that cannot.
 */
export const ESTIMATOR_EMAILS_ENABLED: boolean = commsEmailConfigured;

/**
 * The seven estimate emails, added to Messages at first boot (never over an
 * owner's edit), so the owner can read and brand them before the first lead.
 */
export async function ensureEstimatorEmailTemplates(): Promise<void> {
  await estimatorComms.ensureTemplates(ESTIMATOR_TENANT);
}

/**
 * What the staff screens are told — their banner, and the editor's warning
 * before "Send quote": is the sender configured, and is the cron allowed to
 * run the follow-ups.
 */
export async function estimatorDelivery(): Promise<EstimatorDelivery> {
  return estimatorDeliveryStatus({
    commsInstalled: true,
    emailConfigured: commsEmailConfigured,
    cronSecretSet: Boolean(env.CRON_SECRET),
  });
}
${dispatch}`;
}

/**
 * `src/server/estimator-services.ts` — the estimator's glue to the rest of the
 * project, each piece written only when the feature it needs was installed:
 *
 *   storage     a customer's photo is kept with the estimate (Vercel Blob,
 *               through the storage package's rows)
 *   ai          the photo is read by Claude Haiku 4.5 — observations only — and
 *               every call's tokens and cost go into ai_usage
 *   scheduling  an accepted quote books the visit, and the visits booked from
 *               an estimate are listed on it
 *   invoicing   an accepted quote becomes an invoice in one transaction, once
 *
 * Without one, the export is \`undefined\` and the package says so on its own
 * screens ("Photo reading is off", no "Create invoice" button) — never an \`if\`
 * in the routes.
 */
export function renderEstimatorServices(answers: Answers): string {
  const scope = answers.scope;
  const storage = answers.includeStorage;
  const ai = answers.includeAi;
  const scheduling = answers.includeScheduling;
  const invoicing = answers.includeInvoicing;

  const estimatorValues = invoicing ? ["EstimatorInputError", "getEstimate", "markEstimateConverted"] : [];
  const estimatorTypes = [
    "type CreateEstimatorAdminHandlersOptions",
    "type CreateEstimatorHandlersOptions",
    // Only the variant without storage declares a photo store here; with
    // storage it is files.ts's, re-exported.
    ...(storage ? [] : ["type EstimatorPhotoStore"]),
    ...(invoicing ? ["type LinkedInvoice"] : []),
    "type PhotoReadingOffReason",
    ...(scheduling ? ["type LinkedVisit"] : []),
  ];
  // A COMPANIES project (Tenancy 2a): every tenant below is the company the
  // call is for — the ARGUMENT the estimator hands each seam — never a
  // constant; the visits and the invoice an estimate links to are the
  // company's own screens; and an invoice made from a quote is due when the
  // company's own invoice details say. A single business keeps the one fixed
  // tenant its staff modules name.
  const companies = isCompanies(answers);
  const configImports = [
    ...(scheduling && !companies ? ["estimatorLinks"] : []),
    ...(scheduling ? ["linkedVisit"] : []),
    ...(ai ? ["takeoffModelFor"] : []),
  ];

  const imports = [
    ...(scheduling || invoicing ? [`import { ${scheduling ? "and, asc, eq" : "and, eq"} } from "drizzle-orm";`] : []),
    `import {\n${[...estimatorValues, ...estimatorTypes].map((name) => `  ${name},`).join("\n")}\n} from "${scope}/estimator";`,
    ...(ai ? [`import { createAnthropicTakeoffRunner } from "${scope}/estimator/anthropic";`] : []),
    ...(invoicing ? [`import { createInvoice, invoiceInputFromEstimate, invoices, InvoicingError } from "${scope}/invoicing";`] : []),
    ...(scheduling ? [`import { getSchedulingSettings, schedulingBookings } from "${scope}/scheduling";`] : []),
    ...(scheduling || invoicing ? [`import { db } from "@/db";`] : []),
    `import { env } from "@/env";`,
    ...(ai ? [`import { anthropic, MODEL_RATES, recordAiUsage } from "@/server/ai";`] : []),

    ...(companies && scheduling ? [`import { companyLinks } from "@/server/company-links";`] : []),
    ...(companies && invoicing ? [`import { companyAuthorizer, type FeatureHandlerOverrides } from "@/server/company-routes";`] : []),
    ...(configImports.length > 0 ? [`import { ${configImports.join(", ")} } from "@/server/estimator-config";`] : []),
    ...(invoicing && !companies ? [`import { ESTIMATOR_TENANT } from "@/server/estimator-staff";`] : []),
    ...(invoicing && companies ? [`import { dueDateFor, invoicingBusiness } from "@/server/invoicing";`] : []),
    ...(invoicing && !companies ? [`import { INVOICING_STAFF_KEYS } from "@/server/invoicing";`] : []),
    ...(ai ? [`import { log } from "@/server/logger";`] : []),
    ...(scheduling && !companies ? [`import { SCHEDULING_TENANT } from "@/server/scheduling-staff";`] : []),
    ...(invoicing && !companies ? [`import { authorizeStaffFor } from "@/server/staff-access";`] : []),
  ];

  const zones = `/**
 * Where the business's starting time zone comes from, in order: the
 * estimator's own variable${scheduling ? `, then the one scheduling starts in
 * (so a business set up for both starts both in the same zone)` : ""}. Read
 * once, at the first boot (src/server/estimator.ts); after that the owner
 * changes it in Estimate settings.
 */
export const ESTIMATOR_TIME_ZONE_HINTS: readonly (string | undefined)[] = [env.ESTIMATOR_TIME_ZONE${scheduling ? ", env.SCHEDULING_TIME_ZONE" : ""}];`;

  const photos = storage
    ? `/**
 * Where a customer's photo is kept (Tenancy 2b-1, 10.5): PRIVATELY, with its
 * estimate, in this project's file storage — \`files.purposeStore("estimator.photo")\`
 * in src/server/files.ts, the private store's "estimator.photo" purpose.
 * Counted, never refused because the ${companies ? "company" : "business"} is full (it is a lead), and
 * capped at a fifth of the room so strangers can't fill what the crew's job
 * photos need; served only through the staff screens. Once the lead is sent
 * the photo is filed on its estimate ("Estimate 1042 · Pat Rivera").
 *
 * KEPT so the business sees the steps before anybody drives out — the photo
 * is on the estimate's page, beside what the AI saw in it. One a customer
 * uploaded and never sent is deleted after two days by /api/cron/estimator.
 *
 * Undefined while the private store isn't connected: photos are then read
 * (with --ai) and not kept, and the staff screens say so.
 *
 * STAFF's own photos of an estimate are kept apart (review SEC-02):
 * \`estimatorStaffPhotoStore\`, the private store's "estimator.staff-photo"
 * purpose, counted and refused like the crew's job photos and never by the
 * customers' share — so strangers sending leads with photos can't stop the
 * business adding its own. The staff handlers get it as \`staffPhotoStore\`.
 */
export { estimatorPhotoStore, estimatorStaffPhotoStore } from "@/server/files";`
    : `/**
 * Where a customer's photo would be kept. Nowhere: ${answers.projectName} was
 * generated without file storage, so a photo is read (with --ai) and not kept,
 * and the staff screens say so. \`add storage\` wires it in.
 */
export const estimatorPhotoStore: EstimatorPhotoStore | undefined = undefined;

/** Where staff's own estimate photos would be kept: nowhere, for the same reason. */
export const estimatorStaffPhotoStore: EstimatorPhotoStore | undefined = undefined;`;

  const reading = ai
    ? `/**
 * What reads a customer's photo: Claude, through the package's runner — Haiku
 * 4.5 unless ESTIMATOR_TAKEOFF_MODEL names another. ONE SMALL CALL PER PHOTO:
 * the browser has already shrunk it to 768 px, the prompt is a few lines, the
 * answer is a strict JSON of what the model SAW (how many steps, how tall they
 * look, how sure it is) in at most 150 tokens, and no number a customer is
 * quoted comes from it — the package's code works those out. The same photo
 * for the same product is never read twice, nothing is read once the customer
 * has typed the measurement, and the business's daily budget (Estimate
 * settings) stops reading when it is spent.
 *
 * Every call's tokens and cost are written to ai_usage as "estimator_takeoff"
 * (src/server/ai.ts's MODEL_RATES prices it), so the spend is the owner's to
 * see in Estimate settings and in the AI usage totals.
 *
 * Undefined while ANTHROPIC_API_KEY is unset, or when the model named has no
 * price in MODEL_RATES (logged): reading is then off, the estimate page asks
 * the customer to count, and the staff screens say why, in words that name the
 * fix (estimatorPhotoReadingOff): no key connected, or a model with no price.
 */
const takeoffSetup = buildTakeoff();

export const estimatorTakeoff: CreateEstimatorHandlersOptions["takeoff"] = takeoffSetup.takeoff;

/** Why photo reading is off, for the staff screens' notice; undefined while it is on. */
export const estimatorPhotoReadingOff: PhotoReadingOffReason | undefined = takeoffSetup.off;

function buildTakeoff(): { takeoff: CreateEstimatorHandlersOptions["takeoff"]; off?: PhotoReadingOffReason } {
  if (!anthropic) return { takeoff: undefined, off: "no_key" };
  const model = takeoffModelFor(env.ESTIMATOR_TAKEOFF_MODEL);
  const rate = MODEL_RATES[model];
  if (!rate) {
    log.error({ model }, "estimator: photo reading is off — MODEL_RATES in src/server/ai.ts has no price for this model");
    return { takeoff: undefined, off: "model_unpriced" };
  }
  return {
    takeoff: {
      model: createAnthropicTakeoffRunner({
        client: anthropic,
        model,
        rates: { inputMicrosPerMTok: rate.inputMicrosPerMTok, outputMicrosPerMTok: rate.outputMicrosPerMTok },
      }),
      // The customer is nobody signed in: the row is the business's spend.
      recordUsage: (usage) =>
        recordAiUsage({
          tenantId: usage.tenantId,
          userId: null,
          operation: usage.operation,
          spend: {
            model: usage.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedInputTokens: 0,
            // A call that failed before the provider reported usage has an
            // unknown cost: written as null, never as zero.
            reported: !usage.costEstimated,
          },
          usage: { outcome: usage.outcome === "errored" ? "errored" : "completed", chunks: 0, durationMs: usage.durationMs },
        }),
    },
  };
}`
    : `/**
 * What would read a customer's photo. Nothing: ${answers.projectName} was
 * generated without --ai, so the estimate page asks the customer to count the
 * steps themselves (it always can), photos are kept but not read, and the
 * staff screens say "Photo reading isn't part of this site" and how to add it.
 * \`add ai\` wires in Claude Haiku 4.5 — one small call per photo, metered.
 * (Adding ANTHROPIC_API_KEY alone does nothing here: the wiring isn't in this
 * project, which is why the notice names the command, not the key.)
 */
export const estimatorTakeoff: CreateEstimatorHandlersOptions["takeoff"] = undefined;

/** Why photo reading is off, for the staff screens' notice: it was never installed. */
export const estimatorPhotoReadingOff: PhotoReadingOffReason | undefined = "not_installed";`;

  const urls = scheduling
    ? companies
      ? `
/**
 * A company's own calendar, absolute (the estimate's page links each visit
 * booked from it to its day there). The reader is already in the company's
 * area, so this is the page itself, not the email switch route.
 */
const SCHEDULE_PAGE = new URL(
  "app/schedule",
  (env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\\/?$/, "/"),
).toString();
`
      : `
/** Absolute links on this deployment (estimator-config). */
const estimatorUrls = estimatorLinks(env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000");
`
    : "";

  // The tenant each read is for: the company the estimator asked about
  // (companies), or the one business (single).
  const visitTenant = companies ? "tenantId" : "SCHEDULING_TENANT";
  const visitsFn = scheduling
    ? `
/**
 * The visits booked from an estimate (the booking page's ?estimate=<id>), for
 * the estimate's own page: when, in the ${companies ? "company's" : "business's"} zone, the status in words,
 * and a link to that day on the ${companies ? "company's" : "staff"} calendar. Read from scheduling's table
 * by (tenant, estimate) — scheduling exports no lookup for it.${companies ? " The tenant is the\n * company the estimate belongs to, never a constant: Summit's visits never\n * appear on Green Acres' estimate." : ""}
 */
async function visitsForEstimate(estimateId: string${companies ? ", tenantId: string" : ""}): Promise<LinkedVisit[]> {
  const rows = await db
    .select({
      id: schedulingBookings.id,
      status: schedulingBookings.status,
      startsAt: schedulingBookings.startsAt,
      scheduledDate: schedulingBookings.scheduledDate,
      startTime: schedulingBookings.startTime,
    })
    .from(schedulingBookings)
    .where(and(eq(schedulingBookings.tenantId, ${visitTenant}), eq(schedulingBookings.estimateId, estimateId)))
    .orderBy(asc(schedulingBookings.scheduledDate), asc(schedulingBookings.startTime))
    .limit(20);
  if (rows.length === 0) return [];
  const { timeZone } = await getSchedulingSettings(db, ${visitTenant});
  return rows.map((row) => linkedVisit(row, timeZone, ${companies ? "SCHEDULE_PAGE" : "estimatorUrls.scheduleAdmin"}));
}
`
    : "";

  const invoiceFns = invoicing
    ? companies
      ? `
/**
 * The invoice an estimate became, for the estimate's own page: its number and
 * status, and a link to it on the company's own invoice screen — which needs
 * no token (the customer's link stays on the ledger's "Copy link").
 */
async function invoiceForEstimate(estimateId: string, tenantId: string): Promise<LinkedInvoice | null> {
  const [row] = await db
    .select({ id: invoices.id, number: invoices.invoiceNumber, status: invoices.status })
    .from(invoices)
    .where(and(eq(invoices.tenantId, tenantId), eq(invoices.estimateId, estimateId)))
    .limit(1);
  return row ? { id: row.id, number: row.number, status: row.status, url: \`/app/invoices/\${encodeURIComponent(row.id)}\` } : null;
}

/**
 * "Create invoice" on an accepted quote: ONE TRANSACTION, so a quote is
 * invoiced once or not at all — and the invoice is THE SAME COMPANY'S as the
 * estimate (the tenant the estimator hands in), due after the company's own
 * "invoices are due after N days" (its invoice details), at the end of that
 * day in its time zone.
 *
 *   1. the estimate and its lines, as the customer accepted them;
 *   2. the invoice input, from invoicing's own bridge — labor folded into each
 *      line with the quoted total kept to the cent, the tax rate AND the
 *      discount carried over, nothing billed from a quote that isn't accepted;
 *   3. the invoice and its lines;
 *   4. the estimate CLAIMED as converted — only an accepted one, only once. If
 *      it was not, the claim fails and the invoice is rolled back.
 *
 * A refusal from either package is the refusal the estimate's page shows
 * ("transition_not_allowed"), never a 500.
 */
export const convertEstimateToInvoice: CreateEstimatorAdminHandlersOptions["convertToInvoice"] = async ({
  tenantId,
  estimateId,
  userId,
}) => {
  const found = await getEstimate(db, tenantId, estimateId);
  if (!found) throw new EstimatorInputError("transition_not_allowed", "This estimate can't be invoiced.");
  const business = await invoicingBusiness(tenantId);
  const dueDate = business ? dueDateFor(business) : null;
  try {
    return await db.transaction(async (tx) => {
      const invoice = await createInvoice(
        tx,
        { tenantId, ...invoiceInputFromEstimate(found.estimate, found.items), dueDate },
        userId ?? undefined,
      );
      const claimed = await markEstimateConverted(tx, tenantId, estimateId);
      if (!claimed) {
        throw new EstimatorInputError("transition_not_allowed", "Only an accepted quote can become an invoice, and only once.");
      }
      return { id: invoice.id, number: invoice.invoiceNumber, status: "draft", url: \`/app/invoices/\${encodeURIComponent(invoice.id)}\` };
    });
  } catch (error) {
    if (error instanceof InvoicingError) throw new EstimatorInputError("transition_not_allowed", error.message);
    throw error;
  }
};
`
      : `
/**
 * The tenant invoices are written for: invoicing's INVOICING_TENANT, which is
 * "primary" like ESTIMATOR_TENANT — one business, one id.
 */
const INVOICING_TENANT = ESTIMATOR_TENANT;

/**
 * The invoice an estimate became, for the estimate's own page: its number and
 * status, and a link to it in the ledger (/admin/invoices/{id}) — the staff
 * page needs no token, and opening it never counts as the customer viewing it.
 */
async function invoiceForEstimate(estimateId: string): Promise<LinkedInvoice | null> {
  const [row] = await db
    .select({ id: invoices.id, number: invoices.invoiceNumber, status: invoices.status })
    .from(invoices)
    .where(and(eq(invoices.tenantId, INVOICING_TENANT), eq(invoices.estimateId, estimateId)))
    .limit(1);
  return row ? { id: row.id, number: row.number, status: row.status, url: \`/admin/invoices/\${encodeURIComponent(row.id)}\` } : null;
}

/**
 * "Create invoice" on an accepted quote: ONE TRANSACTION, so a quote is
 * invoiced once or not at all.
 *
 *   1. the estimate and its lines, as the customer accepted them;
 *   2. the invoice input, from invoicing's own bridge — labor folded into each
 *      line with the quoted total kept to the cent, the tax rate AND the
 *      discount carried over, nothing billed from a quote that isn't accepted;
 *   3. the invoice and its lines;
 *   4. the estimate CLAIMED as converted — only an accepted one, only once. If
 *      it was not (somebody revised it a moment ago, or a second click got
 *      here first), the claim fails and the invoice is rolled back.
 *
 * A refusal from either package (already invoiced, not accepted) is the
 * refusal the estimate's page shows ("transition_not_allowed"), never a 500.
 * The estimator's handler announces \`estimate.converted\` after this commits.
 */
export const convertEstimateToInvoice: CreateEstimatorAdminHandlersOptions["convertToInvoice"] = async ({
  tenantId,
  estimateId,
  userId,
}) => {
  const found = await getEstimate(db, tenantId, estimateId);
  if (!found) throw new EstimatorInputError("transition_not_allowed", "This estimate can't be invoiced.");
  try {
    return await db.transaction(async (tx) => {
      const invoice = await createInvoice(
        tx,
        { tenantId: INVOICING_TENANT, ...invoiceInputFromEstimate(found.estimate, found.items) },
        userId ?? undefined,
      );
      const claimed = await markEstimateConverted(tx, tenantId, estimateId);
      if (!claimed) {
        throw new EstimatorInputError("transition_not_allowed", "Only an accepted quote can become an invoice, and only once.");
      }
      return { id: invoice.id, number: invoice.invoiceNumber, status: "draft", url: \`/admin/invoices/\${encodeURIComponent(invoice.id)}\` };
    });
  } catch (error) {
    if (error instanceof InvoicingError) throw new EstimatorInputError("transition_not_allowed", error.message);
    throw error;
  }
};
`
    : `
/**
 * "Create invoice" on an accepted quote. Not offered: ${answers.projectName} was
 * generated without invoicing. \`add invoicing\` wires it in.
 */
export const convertEstimateToInvoice: CreateEstimatorAdminHandlersOptions["convertToInvoice"] = undefined;
`;

  // "Turn into an invoice" WRITES AN INVOICE (review SEC-2A-02), so the
  // invoice permission is asked beside the estimator's own. Three variants,
  // chosen here: the company's invoice keys, the single business's staff
  // invoice keys, or nothing to ask without invoicing.
  const invoiceAccess = invoicing
    ? companies
      ? `
/**
 * The company's INVOICE permission, asked beside the estimator's own (review
 * SEC-2A-02): "Turn into an invoice" writes an invoice, so it needs
 * \`invoices.manage\` as well as \`estimator.estimates.manage\` — a member whose
 * invoice rights an owner took away can't raise one by converting a quote —
 * and an estimate's page shows the invoice it became only to someone with
 * \`invoices.view\`. \`overrides.principal\` is how the project's isolation
 * proof asks it as somebody else.
 */
export function estimatorInvoiceAccess(overrides: FeatureHandlerOverrides = {}): CreateEstimatorAdminHandlersOptions["invoiceAccess"] {
  const authorize = companyAuthorizer(overrides);
  return (req, need, tenantId) => authorize(req, need === "manage" ? "invoices.manage" : "invoices.view", tenantId);
}
`
      : `
/**
 * The business's INVOICE staff keys, asked beside the estimator's own (review
 * SEC-2A-02): "Turn into an invoice" writes an invoice, so it needs
 * \`staff.invoices.manage\` as well as the estimates key — a CS agent who may
 * quote but not bill can't raise one by converting a quote — and an
 * estimate's page shows the invoice only to someone with \`staff.invoices.view\`.
 */
export function estimatorInvoiceAccess(): CreateEstimatorAdminHandlersOptions["invoiceAccess"] {
  const authorize = authorizeStaffFor(INVOICING_STAFF_KEYS, "Sign in to see invoices.");
  return (req, need, tenantId) => authorize(req, need === "manage" ? "invoices.manage" : "invoices.view", tenantId);
}
`
    : `
/**
 * The invoice permission "Turn into an invoice" would ask. Nothing:
 * ${answers.projectName} was generated without invoicing, so no quote turns into
 * an invoice here. \`add invoicing\` wires it in.
 */
export function estimatorInvoiceAccess(_overrides: unknown = {}): CreateEstimatorAdminHandlersOptions["invoiceAccess"] {
  return undefined;
}
`;

  const seamLines = [
    ...(scheduling
      ? companies
        ? [
            "  // An accepted quote's \"Book the visit\": the company's own booking page, tied to the estimate.",
            "  bookVisitUrl: async (estimate, tenantId) => (await companyLinks(tenantId)).bookVisit(estimate.id),",
            "  visits: (estimateId, tenantId) => visitsForEstimate(estimateId, tenantId),",
          ]
        : [
            "  // An accepted quote's \"Book the visit\": the booking page, tied to the estimate.",
            "  bookVisitUrl: (estimate) => estimatorUrls.bookVisit(estimate.id),",
            "  visits: (estimateId) => visitsForEstimate(estimateId),",
          ]
      : []),
    ...(invoicing
      ? [companies ? "  invoice: (estimateId, tenantId) => invoiceForEstimate(estimateId, tenantId)," : "  invoice: (estimateId) => invoiceForEstimate(estimateId),"]
      : []),
  ];
  const seams = seamLines.length > 0
    ? `
/** What an estimate's page links to elsewhere in this project. */
export const estimatorLinkSeams: CreateEstimatorAdminHandlersOptions["links"] = {
${seamLines.join("\n")}
};
`
    : `
/**
 * What an estimate's page would link to elsewhere. Nothing: ${answers.projectName}
 * has neither scheduling nor invoicing. \`add scheduling\` / \`add invoicing\`
 * wire in "Book the visit" and the invoice.
 */
export const estimatorLinkSeams: CreateEstimatorAdminHandlersOptions["links"] = undefined;
`;

  return `${imports.join("\n")}

/**
 * The estimator's glue to the rest of ${answers.projectName}: where a customer's
 * photo is kept, what reads it, and what an accepted quote turns into.
 *
 * Generated by create-adminigloo-app from the answers this project was created
 * with — each piece is here only when the feature it needs was installed, and
 * \`add\` rewrites this file when one is added later. Editing it is fine (it is
 * yours), but \`add\` will then write its version beside yours as \`.new\`.
 */

${zones}

${photos}

${reading}
${urls}${visitsFn}${invoiceFns}${invoiceAccess}${seams}`;
}

/**
 * `src/server/audit.ts` for this project.
 *
 * Generated for the same reason `src/permissions/catalog.ts` is: which packages
 * contribute keys depends on what was installed. The catalog router only exists
 * in a project that sells something, so a hand-written file spreading its
 * actions would not compile in a project generated with `--model none`.
 *
 * ONE REGISTRY, composed from fragments, and the composition is the point.
 * Before this file there were two — `adminAuditedActions` in the admin router
 * and `catalogAuditedActions` in the catalog router — and two registries cannot
 * detect a collision between them. `admin.recentAudit` labels rows from the
 * registry it holds, so every catalog action rendered in the audit viewer as
 * its raw key: not broken, just quietly unreadable, in the one screen whose
 * entire job is to be read. Adding invitations would have made it three.
 *
 * Each router keeps writing through the registry it declares. `contributedBy`
 * is what makes that safe: a key claimed twice throws at boot rather than
 * letting whichever spread ran last decide the label and the `sensitive` flag.
 */
export function renderAuditRegistry(answers: Answers): string {
  const scope = answers.scope;
  const label = tenantLabel(answers).toLowerCase();
  const plural = tenantLabelPlural(answers).toLowerCase();

  const imports = [
    `import { defineAuditedActions } from "${scope}/observability";`,
    `import type { AuditActionKeyOf } from "${scope}/observability";`,
    // The company lifecycle's whole vocabulary (Tenancy 1): created, renamed,
    // suspended, a role changed, a member removed, an invitation sent… The
    // three \`invitation.*\` keys keep the names the 0.21 router wrote, so
    // historic rows keep their labels.
    `import { tenancyAuditedActions } from "${scope}/tenancy";`,
  ];
  const fragments = ["adminAuditedActions", "tenancyAuditedActions"];

  if (answers.includeNotifications) {
    // Who hears about new work (Tenancy 2b-1, review SEC-04): every saved
    // list in Alert settings, and an outside address added to one (sensitive:
    // it gets every lead's name, phone and address from then on). Written by
    // src/server/alerts-routes.ts through the package's `audit` seam.
    imports.push(`import { notificationsAuditedActions } from "${scope}/notifications";`);
    fragments.push("notificationsAuditedActions");
  }

  if (answers.includeScheduling && answers.tenantNoun === "none") {
    // Giving a crew member their route (the crew-only staff role) and taking
    // it away — a single business's crew. Declared beside the decision in
    // scheduling-staff, which imports nothing from here, so there is no
    // cycle. (In a companies project a crew member is a company member with
    // the Crew role, and tenancy audits the role change itself.)
    imports.push('import { schedulingAuditedActions } from "./scheduling-staff";');
    fragments.push("schedulingAuditedActions");
  }

  if (answers.businessModel !== "none") {
    // One-way. `routers/catalog.ts` writes through its own registry and imports
    // nothing from here, so this file can read its fragment without the two
    // modules forming a cycle that would leave one of them half-initialised.
    imports.push('import { catalogAuditedActions } from "./routers/catalog";');
    fragments.push("catalogAuditedActions");
    // The customer side, on the same one-way terms and for the same reason.
    // Only one thing a customer does is worth a row — opening the billing
    // portal, which hands them the ability to cancel the subscription and read
    // every invoice, and which then happens at Stripe where this application
    // sees nothing further.
    imports.push('import { accountAuditedActions } from "./routers/account";');
    fragments.push("accountAuditedActions");
    // The subscription mirror's vocabulary, on the same one-way terms. It is
    // declared beside the WRITER rather than beside a router because five
    // different callers write through that one function — the webhook, the
    // simulated path, cancel, resume and the staff resync — and an action
    // declared in one of the five would be invisible to the other four.
    imports.push('import { subscriptionAuditedActions } from "./subscription";');
    fragments.push("subscriptionAuditedActions");
  }

  return `${imports.join("\n")}

/**
 * Everything ${answers.projectName} can write to the audit log.
 *
 * A key is a permanent commitment: it is what an indexed \`action\` column
 * holds, so renaming one orphans every historical row from the query that used
 * to find it. Add rather than rename, and delete only what was never written.
 *
 * The registry is the ONLY way to name an action. \`auditEntry\` refuses a key
 * it has not heard of, which is what stops an action from being written as a
 * string literal at a call site — an action nobody declared is invisible to
 * every audit query written against this file, and the sweep comes back
 * quietly short rather than wrong.
 */

/**
 * The admin panel's own actions.
 *
 * Three keys rather than one with the effect in metadata, because the first
 * question asked of an audit log is "who was granted what", and answering it
 * from \`action = 'permission.override.granted'\` reads an index while
 * answering it from a jsonb field reads the table.
 */
export const adminAuditedActions = {
  "permission.override.granted": {
    label: "Granted a permission to one person",
    // Sensitive, even though nothing was read. An override is how somebody
    // comes to hold access their role never gave them, so the review that asks
    // "who could have seen this data" has to start from the grants — and it
    // reads the same partial index the reads are recorded in.
    sensitive: true,
  },
  "permission.override.revoked": {
    label: "Revoked a permission from one person",
  },
  "permission.override.cleared": {
    label: "Removed an override, returning the person to their role template",
  },
} as const;


/**
 * The composed vocabulary.
 *
 * \`contributedBy\` re-reads the fragments rather than trusting the spread. A
 * duplicate key cannot survive an object literal — the parser keeps the last
 * one — so without this a second package claiming \`invitation.sent\` would
 * silently overwrite the label and, worse, the \`sensitive\` flag, and the row
 * would drop out of the compliance slice with nothing to show for it.
 */
export const auditedActions = {
  ${fragments.map((f) => `...${f}`).join(",\n  ")},
} as const;

export const auditRegistry = defineAuditedActions(auditedActions, {
  contributedBy: [${fragments.join(", ")}],
});

export type AuditAction = AuditActionKeyOf<typeof auditRegistry>;
`;
}


/**
 * `src/server/routers/_app.ts` for this project.
 *
 * Generated, because the routers that exist depend on what was installed. It
 * was a static file importing `./catalog` and `./checkout` unconditionally,
 * which meant a project generated with `--model none` referenced two modules
 * that were never emitted and would not compile. Nothing caught it, because the
 * only configuration anyone had generated was the full one.
 */
export function renderAppRouter(answers: Answers): string {
  const takesMoney = answers.businessModel !== "none";

  const imports = [
    'import { adminRouter } from "./admin";',
    'import { createTRPCRouter, publicProcedure, requireTenant } from "../trpc";',
  ];
  if (answers.includeAi) imports.splice(1, 0, 'import { aiRouter } from "./ai";');
  if (answers.includeFeedback) {
    imports.splice(1, 0, 'import { feedbackRouter } from "./feedback";');
  }
  if (answers.includeSeoReports) {
    imports.splice(1, 0, 'import { seoRouter } from "./seo";');
  }
  if (answers.includeAssistant) {
    imports.splice(1, 0, 'import { assistantRouter } from "./assistant";');
  }
  if (answers.includeAeo) {
    imports.splice(1, 0, 'import { aeoRouter } from "./aeo";');
  }
  if (takesMoney) {
    imports.splice(1, 0, 'import { accountRouter } from "./account";');
    imports.splice(2, 0, 'import { billingRouter } from "./billing";');
    imports.splice(3, 0, 'import { catalogRouter } from "./catalog";');
    imports.splice(4, 0, 'import { checkoutRouter } from "./checkout";');
  }

  // What the AI route cost, read back. The route itself is a plain handler —
  // a streamed response has no useful shape for tRPC to type — so this is the
  // only tRPC surface `--ai` adds, and it exists because a usage table nothing
  // reads is the error log all over again.
  const ai = answers.includeAi
    ? `
  // Spend per ${tenantLabel(answers).toLowerCase()}, summed in the database.
  // Gated on \`ai.chat.history.view\`, which is narrower than the
  // \`ai.chat.use\` the route checks: being allowed to spend money is not the
  // same capability as seeing what everybody spent.
  ai: aiRouter,
`
    : "";

  // The staff side of the feedback queue. Mounted on the feedback answer
  // ALONE, the way \`admin\` is mounted without a shell: the ROUTER is where
  // the requireStaff rungs live, and it has to exist wherever tickets can
  // arrive — the triage pages are just one caller, added when there is a
  // shell to render them in.
  const feedback = answers.includeFeedback
    ? `
  // Reading and working the tickets the intake route writes. Every procedure
  // is staff-scoped on \`staff.dashboard.view\` — the key that says you may use
  // the shell — rather than a key of its own; mint one when the queue grows
  // actions that not every staff member should hold.
  feedback: feedbackRouter,
`
    : "";

  const seo = answers.includeSeoReports
    ? `
  // SEO & AEO audits of THIS deployment, run on demand from the admin. The
  // crawl targets NEXT_PUBLIC_APP_URL over the public internet — the audit
  // must see what a crawler sees, headers, redirects and all.
  seo: seoRouter,
`
    : "";

  // Alerts and files have no router here (Tenancy 2b-1, D16; 2a D3's
  // reason): the bell, the alerts page, Alert settings, a record's photos and
  // files and the Files screen speak HTTP to the packages' own handlers
  // (/api/app/{id}/alerts and /files, or /api/admin/… for one business) —
  // the wire the widgets are built against, one path rather than a tRPC copy
  // of it that drifts. The 0.1 `notifications` and `files` routers are gone.

  const assistant = answers.includeAssistant
    ? `
  // The AI assistant's editable brain: personality sections with versions and
  // rollback, per-tenant overlays, glossary, change log. Your AI route calls
  // assemblePrompt to build its system prompt from these rows.
  assistant: assistantRouter,
`
    : "";

  // Field service has no router here at all (Tenancy 2a, D3). Invoicing and
  // messages used to: a tRPC router each behind pages copied into the
  // project. Both now run on their packages' own HTTP handlers and widgets,
  // like scheduling and the estimator — one path per feature, the wire the
  // widgets are built against, and a fix that reaches every project by
  // `npm update` — in both modes. In a companies project every feature route
  // names its company in its path (/api/app/{id}/…, /api/t/{web address}/…).
  //
  // The estimator has no router here, deliberately, for scheduling's reason.
  // Its estimate page, quote page and staff screens speak HTTP to the
  // package's own handlers (app/api/estimator and app/api/admin/estimator) —
  // the wire the widgets are built against, one path rather than a tRPC copy
  // of it that drifts.

  // Scheduling has no router here, deliberately. Its booking page, manage
  // page and staff screens speak HTTP to the package's own handlers
  // (app/api/schedule and app/api/admin/schedule) — the wire the widgets are
  // built against, one path rather than a tRPC copy of it that drifts.

  const aeo = answers.includeAeo
    ? `
  // Answer-engine citation tracking. Staff track the questions customers ask an
  // assistant and check whether the answer mentions them.
  aeo: aeoRouter,
`
    : "";

  const shop = takesMoney
    ? `
  // The product builder. Staff-scoped, and mounted unconditionally alongside
  // \`admin\` for the same reason: the pages are copied source a client
  // restyles, while this router is where \`requireStaff(...)\` and the price
  // audit actually live.
  catalog: catalogRouter,

  // The public storefront and checkout. The only router here carrying \`public\`
  // procedures, deliberately — a shop nobody can browse without an account is a
  // shop nobody browses. What keeps it safe is that the amount, the currency
  // and the owning tenant are read from the catalog row, never from the
  // request.
  checkout: checkoutRouter,

  // The customer's own account: the Stripe billing portal, cancelling and
  // resuming a subscription, and the invoice list. Everything else the account
  // area does is a server-component read — pages read, routers mutate — and
  // these are here rather than in a page so the tenant rung and the audit
  // writes are somewhere the scope audit can see them.
  account: accountRouter,

  // The plan catalogue's own end of the money: starting a subscription,
  // simulating one where there are no Stripe keys, publishing the plan record's
  // prices to Stripe, and the staff re-sync that puts the firm's own billing
  // tables back in step with Stripe when a webhook was missed. Separate from
  // \`checkout\` because that router sells PRODUCTS to anybody and this one sells
  // the plan catalogue to an organisation.
  billing: billingRouter,
`
    : "";

  return `${imports.join("\n")}

/**
 * The root router for ${answers.projectName}.
 *
 * tRPC for CRUD and admin. AI, streaming and large payloads go through plain
 * route handlers instead — a streamed response has no useful shape for tRPC to
 * type, and a large upload should not be serialised through superjson.
 */
export const appRouter = createTRPCRouter({
  health: publicProcedure.meta({ scope: "public" }).query(() => ({ ok: true })),

  // Every tenant-scoped procedure goes through requireTenant, never an inline
  // check inside a handler. The rung is what the scope audit can actually see.
  members: createTRPCRouter({
    list: requireTenant("members.view")
      .meta({ scope: "tenant" })
      .query(({ ctx }) => ({ tenantId: ctx.tenantId, granted: ctx.can.toArray() })),
  }),

  // NO \`invitations\` ROUTER ANY MORE (Tenancy 1). Inviting, resending,
  // withdrawing and accepting are served by ${answers.scope}/tenancy's handlers
  // at /api/tenancy (src/server/tenancy-handlers.ts), with the company lock and
  // the rank rules the old router couldn't see. Two write paths into the same
  // invitation rows would be two places to keep those rules right.

  // The admin panel's pages are copied source that every client restyles; this
  // router is not, and it is where the staff permission checks and the audit
  // writes actually live. Mounted even in a project generated without the admin
  // shell, so the panel can be added later without re-deriving its boundary.
  admin: adminRouter,
${ai}${feedback}${seo}${assistant}${aeo}${shop}});

export type AppRouter = typeof appRouter;
`;
}

/**
 * `src/db/schema.ts` for this project.
 *
 * Re-exports the base tables so drizzle-kit sees ONE schema and a migration
 * covers base and app tables together. Copying a base table's definition here
 * instead would fork its migrations silently.
 */
export function renderSchemaModule(answers: Answers): string {
  const scope = answers.scope;
  // EVERY installed package that owns a table must appear here. drizzle.config
  // points drizzle-kit at this one file, so a package omitted from this list
  // has its tables silently excluded from every migration — the code compiles,
  // the app boots, and the first insert fails against a table that was never
  // created.
  const owners = ["auth", "tenancy", "permissions", "observability"];
  if (answers.businessModel !== "none") {
    owners.push("stripe", "catalog", "commerce", "billing");
  }
  if (answers.includeAi) owners.push("ai");
  if (answers.includeEmail) owners.push("email");
  // The widget package owns no tables; only the platform half does.
  if (answers.includeFeedback) owners.push("feedback");
  if (answers.includeSeoReports) owners.push("seo-reports");
  if (answers.includeNotifications) owners.push("notifications");
  if (answers.includeStorage) owners.push("storage");
  if (answers.includeAssistant) owners.push("assistant");
  // Field service. Each owns its own tables; the -widget package (estimator)
  // owns none, so only the server package is listed.
  if (answers.includeEstimator) owners.push("estimator");
  if (answers.includeScheduling) owners.push("scheduling");
  if (answers.includeInvoicing) owners.push("invoicing");
  if (answers.includeComms) owners.push("comms");
  if (answers.includeAeo) owners.push("aeo");

  /**
   * `@scope/auth/schema` -> `authSchema`; `seo-reports` -> `seoReportsSchema`.
   * Camelised because a hyphen survives a package name and not an identifier —
   * `seo-reportsSchema` is the syntax error this line exists to never emit.
   */
  const binding = (owner: string): string =>
    `${owner.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}Schema`;

  const imports = owners.map(
    (owner) => `import * as ${binding(owner)} from "${scope}/${owner}/schema";`,
  );
  const reExports = owners.map((owner) => `export * from "${scope}/${owner}/schema";`);
  const spread = owners.map((owner) => `  ...${binding(owner)},`);
  // Names two schema modules both export, which TypeScript refuses to pass on
  // through two `export *` lines (TS2308). An explicit re-export settles it.
  // Today: alerts and files each name their own table-name error
  // InvalidTableNameError (neither is a table, so drizzle never reads it).
  const clashes =
    answers.includeNotifications && answers.includeStorage
      ? [
          "",
          "/**",
          " * Alerts and files each name their own table-name error",
          " * InvalidTableNameError (neither is a table). Two `export *` lines can't",
          " * both pass the name on, so this one says which does; import either",
          " * package's own from that package.",
          " */",
          `export { InvalidTableNameError } from "${scope}/storage/schema";`,
        ]
      : [];

  return `/**
 * ${answers.projectName} schema.
 *
 * Base tables come from the packages that own them. Do NOT copy a base table's
 * definition into this file — the package owns its migrations, and a local copy
 * forks them without anyone noticing until an upgrade fails.
 *
 * TWO SHAPES OF THE SAME THING, and both are load-bearing.
 *
 * The \`export *\` lines are what drizzle-kit reads. \`drizzle.config.ts\` points
 * it at this file and it takes every table it finds exported from it, so a
 * package missing from that list is a package missing from every migration.
 *
 * \`schema\` below is the same tables as ONE OBJECT, and it exists because
 * \`src/db/index.ts\` cannot hand drizzle this module's namespace. A module whose
 * exports are all re-exports compiles, under Turbopack, to a namespace backed
 * by a Proxy over a non-extensible target — and \`Object.keys\` on one of those
 * throws. Drizzle calls exactly that, in \`extractTablesRelationalConfig\`, the
 * moment a real DATABASE_URL means it builds the relational query API instead
 * of the unconfigured stand-in. The result was a generated project that built
 * and served perfectly with no database and failed \`next build\` outright with
 * one: \`TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy
 * target is non-extensible\`, thrown from a driver, naming nothing. Spreading
 * each package's own namespace sidesteps it, because those modules export their
 * tables directly rather than passing them on.
 *
 * ADD YOUR OWN TABLES TO BOTH. The type of \`db\` is derived from this object, so
 * a table defined below and left out of it is a compile error the first time
 * you write \`db.query.yourTable\` — not a silent absence.
 */
${imports.join("\n")}

${[...reExports, ...clashes].join("\n")}

/** Every table above, as the one object \`createDb\` needs. */
export const schema = {
${spread.join("\n")}
};

// ---------------------------------------------------------------------------
// ${answers.projectName} tables go below. Use the shared column helpers so ids,
// timestamps and money follow the same rules everywhere:
//
//   import { idColumn, createdAt, updatedAt, amountMinor } from "${scope}/db";
//
// Then add each one to the \`schema\` object above.
// ---------------------------------------------------------------------------
`;
}

/**
 * One entry in a generated nav array, with the reason it is there.
 *
 * `why` is rendered as a comment above the entry in `src/nav.ts`. A generated
 * file is one nobody reviews line by line, so a link that appears in it with no
 * stated reason is a link the next person duplicates by hand somewhere else —
 * which is how a nav drifts away from the routes that actually exist.
 */
interface GeneratedLink {
  readonly href: string;
  readonly label: string;
  readonly why: string;
  /**
   * Who the link is drawn for. "everyone" is the default. "staff" links are
   * drawn only for someone holding a staff role (the header checks once per
   * signed-in page view); "developer" links are left out of a production
   * footer (/setup is a diagnostics page, and a production visitor has no use
   * for it). A RUNTIME filter over a generated list — which links exist is
   * settled here, who sees them at request time — never a feature `if`.
   */
  readonly audience?: "everyone" | "staff" | "developer";
  /**
   * A TENANT permission key (Tenancy 2a): the link is drawn only for someone
   * whose role in their active company holds it — a crew member's header
   * shows Dashboard and Today's route and nothing else. Like `audience`, a
   * runtime filter over a generated list; absent means every member.
   */
  readonly permission?: string;
}

/** `// ...` lines, wrapped and indented one level into an array literal. */
function indentedComment(text: string): string {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > 72) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.map((line) => `  // ${line}\n`).join("");
}

/**
 * One `export const NAME: readonly SiteLink[] = [...]`.
 *
 * The empty case renders `[]` rather than a literal with a stray comma in it.
 * That case is not hypothetical: `APP_LINKS` is empty in every project
 * generated with `--admin none`, and a file that does not parse is a worse
 * failure than the dead link it was written to prevent.
 */
function renderLinkArray(
  name: string,
  doc: string,
  links: readonly GeneratedLink[],
): string {
  const body =
    links.length === 0
      ? "[]"
      : `[\n${links
          .map(
            (link) =>
              `${indentedComment(link.why)}  ` +
              `{ href: "${link.href}", label: "${link.label}"${link.audience && link.audience !== "everyone" ? `, audience: "${link.audience}"` : ""}${link.permission ? `, permission: "${link.permission}"` : ""} },\n`,
          )
          .join("\n")}]`;
  return `${doc}\nexport const ${name}: readonly SiteLink[] = ${body};\n`;
}

/**
 * `src/nav.ts` for this project.
 *
 * Generated for the same reason `_app.ts` is: which routes exist depends on
 * what was installed. The storefront ships in the stripe overlay and the admin
 * shell in another, so a project generated with `--model none --admin none` has
 * neither route — and a base template hardcoding either link puts a 404 in the
 * header of every page. The overlays cannot patch a link in from their side
 * either: overlays are strictly additive and the header is a base file, which
 * is exactly what `OverlayCollisionError` exists to prevent.
 *
 * The result was a shop that was live, correct and linked to by nothing: the
 * product was in the database, the storefront rendered it, and the only way to
 * reach it was to already know the URL. From the outside that is
 * indistinguishable from the shop never having been built. The Admin link was
 * the same bug pointing the other way — hardcoded into the header, so it was a
 * 404 in every project that had deliberately declined an admin panel.
 *
 * THREE ARRAYS, because there are three audiences and merging them is how the
 * bug comes back. `SITE_LINKS` is public and renders even signed out;
 * `APP_LINKS` renders only once there is a user; `FOOTER_LINKS` is the
 * secondary map that lets the header stay short without costing a route its
 * only way in.
 *
 * Emitting LISTS rather than flags is the whole point. Consumers map over them,
 * so no emitted page holds an `if` asking whether the shop or the admin panel
 * was installed, and there is no null to forget to test.
 */
export function renderSiteNav(answers: Answers): string {
  const label = tenantLabel(answers).toLowerCase();

  const site: GeneratedLink[] = [
    {
      href: "/",
      label: "Home",
      why:
        "Every project has a landing page. Not a formality: the admin sidebar " +
        'renders this list under a "Public site" heading, and a heading over ' +
        "an empty list is a defect that only shows up in the one configuration " +
        "nobody generates.",
    },
  ];

  // Every money-taking model gets the storefront, because every one of them
  // installs the stripe overlay. The one-time/subscription answer shapes what
  // is sold, not whether there is somewhere to sell it.
  if (answers.businessModel !== "none") {
    site.push({
      href: "/products",
      label: "Products",
      why:
        "The storefront, from the stripe overlay. Absent in a project that " +
        "sells nothing, which is why this list is generated rather than " +
        "written by hand.",
    });
  }

  // The pricing page, from the marketing-pricing overlay — which needs BOTH a
  // marketing site and something to sell. Ahead of the shop because for a
  // subscription product it is the page the whole site exists to reach, and a
  // storefront of one-off items is the secondary destination rather than the
  // primary one.
  if (answers.includeMarketing && answers.businessModel !== "none") {
    site.push({
      href: "/pricing",
      label: "Pricing",
      why:
        "Rendered from src/plans.ts, so what a tier advertises is the same " +
        "record grantsForPlan entitles from. Absent in a project with no " +
        "marketing site and absent again in one with no plans to price, which " +
        "is two conditions and therefore two ways this list would have been " +
        "wrong if it were written by hand.",
    });
  }

  // The booking page, from the scheduling overlay. In the PUBLIC nav because
  // it is the page a field-service business exists to send people to — a
  // booking page reachable only from a link somebody pasted is one most
  // customers never find. Signed out is the main audience.
  //
  // A SINGLE BUSINESS ONLY (Tenancy 2a). In a companies project the platform
  // books and quotes nobody: each company does, at its own /t/{web address}
  // pages, which it links from its own website — so the platform's header
  // carries neither.
  const single = answers.tenantNoun === "none";
  if (single && answers.includeScheduling) {
    site.push({
      href: "/book-visit",
      label: "Book a visit",
      why:
        "The customer booking page (<VisitPicker>): a service, a day and a " +
        "time in the business's own time zone, then their details. Absent " +
        "without --scheduling. The manage page a customer reaches from their " +
        "email, /visit/[token], is deliberately in no nav: its URL is the " +
        "key to one person's visit.",
    });
  }

  // The instant estimate, from the estimator overlay. Public for the booking
  // page's reason: it is the page a field-service business sends people to,
  // and a price somebody can only reach from a pasted link is a price most
  // customers never see. A single business only, like the booking page.
  if (single && answers.includeEstimator) {
    site.push({
      href: "/estimate",
      label: "Get an estimate",
      why:
        "The instant estimate (<EstimateTool>): a price from the business's " +
        "own price book for what the customer can count or measure, with an " +
        "optional photo. Absent without --estimator. The quote page a customer " +
        "reaches from their email, /quote/[token], is deliberately in no nav: " +
        "its URL is the key to one person's quote.",
    });
  }

  // WHERE A SIGNED-IN PERSON WORKS (Tenancy 1, 2a). Per mode, chosen here so
  // the header holds no `if` about it: a project whose customers are
  // companies gets the company dashboard, the company's own feature screens
  // under /app (Tenancy 2a), the team page and the company's settings — each
  // with the TENANT key it needs, so the header shows a person only what their
  // role in their active company opens (a crew member: Dashboard and Today's
  // route); a single-business project gets the team page, because its one
  // workspace has no dashboard or settings of its own and its features are
  // staff screens under /admin. /members still exists (old links and old
  // invitation emails) and redirects to /settings/team, so it is not listed
  // twice.
  const companyFeatureLinks: GeneratedLink[] = [];
  if (!single && answers.includeScheduling) {
    companyFeatureLinks.push(
      {
        href: "/app/schedule",
        label: "Schedule",
        permission: "schedule.view",
        why:
          `The ${label}'s calendar: every crew's visits, the online requests ` +
          "waiting for an answer, and Schedule settings beside it.",
      },
      {
        href: "/app/schedule/today",
        label: "Today's route",
        permission: "schedule.route",
        why:
          "A crew's stops for the day, on a phone. On the one key the Crew " +
          "role holds, so a crew member's header shows this and the dashboard.",
      },
    );
  }
  if (!single && answers.includeEstimator) {
    companyFeatureLinks.push({
      href: "/app/estimates",
      label: "Estimates",
      permission: "estimator.view",
      why:
        `The ${label}'s leads and quotes; its price book and estimate ` +
        "settings are linked from the Estimates page's header.",
    });
  }
  if (!single && answers.includeInvoicing) {
    companyFeatureLinks.push({
      href: "/app/invoices",
      label: "Invoices",
      permission: "invoices.view",
      why: `The ${label}'s ledger: raise and send invoices, record payments.`,
    });
  }
  if (!single && answers.includeComms) {
    companyFeatureLinks.push({
      href: "/app/messages",
      label: "Messages",
      permission: "comms.view",
      why: `The emails the ${label}'s customers get, their wording, and what went out.`,
    });
  }
  // Tenancy 2b-1: the company's Files screen, after Messages. (Alerts need
  // no link: the bell is in the header, and its menu opens the alerts page
  // and Alert settings.)
  if (!single && answers.includeStorage) {
    companyFeatureLinks.push({
      href: "/app/files",
      label: "Files",
      permission: "files.view",
      why: `The photos and files the ${label} keeps, what each is attached to, and how much room is left.`,
    });
  }
  const app: GeneratedLink[] =
    single
      ? [
          {
            href: "/settings/team",
            label: "Team",
            why:
              `Who is in this ${label} and who has been invited, with the ` +
              "invite form (<TeamManager>, from the tenancy widget). In every " +
              "project: a single business still invites its staff.",
          },
        ]
      : [
          {
            href: "/dashboard",
            label: "Dashboard",
            why:
              `The active ${label}'s home: its setup checklist and a card for ` +
              "every part of it the person's role opens. Any member may open " +
              "it; a new owner who has no company yet is sent from here to " +
              "onboarding.",
          },
          ...companyFeatureLinks,
          {
            href: "/settings/team",
            label: "Team",
            permission: "members.view",
            why:
              `Who is in this ${label} and who has been invited: invite, ` +
              "resend, withdraw, change a role, remove, hand over ownership.",
          },
          {
            href: "/settings/company",
            label: "Settings",
            permission: "tenant.view",
            why:
              `The ${label}'s name, web address, logo, brand colour, time ` +
              "zone and contact details — typed once, read by every feature.",
          },
        ];

  // The customer's own side of the line, from the account overlay. Present on
  // exactly the condition the shop is: something that can be bought needs
  // somewhere the buyer can look at it afterwards, and a project that sells
  // nothing contributes no entry — which is the generated-array pattern doing
  // the job a flag would otherwise do badly.
  //
  // IN `APP_LINKS` RATHER THAN `SITE_LINKS`, and that is not a style choice.
  // `/account` is meaningless signed out: every page under it opens by asking
  // who is calling and shows a sign-in prompt when nobody is. Advertising it to
  // a signed-out visitor from the public nav would put a link in the header
  // whose only content is "you are not signed in", next to a Sign in button
  // that says the same thing better.
  if (answers.businessModel !== "none") {
    app.push({
      href: "/account",
      label: "Your account",
      why:
        "Orders, licence keys, allowances and billing — the read half of " +
        "everything `fulfilPurchase` writes. It was the gap: a person could " +
        "buy something and had nowhere at all to see it afterwards, because " +
        "the only reader in the project was keyed on a reference in the URL " +
        "Stripe returned them to.",
    });
  }

  // `app/admin` ships in the admin-minimal overlay and admin-full layers on top
  // of it, so anything other than "none" means the route exists. With "none"
  // this array stays empty and the header renders nothing — no flag, no null,
  // and nothing in the header that has to know an admin panel is a thing.
  if (answers.adminShell !== "none") {
    app.push({
      href: "/admin",
      label: "Admin",
      audience: "staff",
      why:
        "The admin shell, from the admin overlay. Drawn only for someone " +
        "with a staff role: a business owner's header is about their " +
        "company, and a link that opens on 'you don't have access' is noise " +
        "to every customer. The header already loads the signed-in person " +
        "for the company switcher, so the check is one more query.",
    });
  }

  const footer: GeneratedLink[] = [
    {
      href: "/setup",
      label: "Setup",
      audience: "developer",
      why:
        "Which credentials are set, and what each missing one switches off. " +
        "In every project. In the footer rather than the header because it is " +
        "a diagnostics page and not somewhere a customer goes, but it has to " +
        "be reachable from everywhere: whoever needs it has just hit a page " +
        "that did not work, and that page is rarely the landing page.",
    },
    {
      href: "/sign-up",
      label: "Create an account",
      why:
        "The Clerk catch-all route, which every project has. The header " +
        "offers Sign in and nothing offers this — Clerk renders its own " +
        "sign-up link inside its card, but only once it is configured, so " +
        "until then the route exists with nothing at all pointing at it.",
    },
  ];

  // Only in a project that installed the mail package: the page it points at
  // ships in the email overlay and does not exist otherwise. Beside /setup for
  // the same reason /setup is here — it is a diagnostics surface rather than
  // somewhere a customer goes, and it has to be reachable from wherever
  // somebody has just noticed that a message read wrong.
  if (answers.includeEmail) {
    footer.push({
      href: "/setup/email",
      label: "Email templates",
      audience: "developer",
      why:
        "Every message this project can send, rendered from sample data. An " +
        "email template is the one piece of UI with no way to look at it — the " +
        "loop is otherwise edit, deploy, invite somebody, wait — so without a " +
        "link nobody finds the page and the copy stays as it was first written.",
    });
  }

  // Where the orientation page went. It is `/` in a project with no marketing
  // site and `/setup/start` in one that has, because the landing page takes `/`
  // — see `planEmit`. Beside /setup, since the two are the same kind of surface:
  // developer-facing, reachable from anywhere, and deleted together at launch.
  // Without this entry the page still builds, still serves and is linked to by
  // nothing, which is the exact fault `src/nav.ts` exists to prevent.
  if (answers.includeMarketing) {
    footer.push({
      href: "/setup/start",
      label: "Where to start",
      audience: "developer",
      why:
        "The file map and the health check — what `/` says in a project " +
        "without a marketing site. The landing page owns `/` here, so this is " +
        "where it moved, and the footer is the only thing that knows.",
    });
  }

  // The legal pages, from the legal overlay. Present whenever the project has a
  // public face OR takes money — Stripe refuses to activate an account without
  // a reachable privacy policy and terms of service, so a paid product needs
  // both even with no marketing site in front of them. Last in the footer,
  // which is where every reader already looks for them.
  if (answers.includeMarketing || answers.businessModel !== "none") {
    footer.push(
      {
        href: "/privacy",
        label: "Privacy",
        why:
          "A starting point for a lawyer, and accurate about the one thing a " +
          "copied template always gets wrong: the subprocessor list is " +
          "generated from the packages this project actually installed.",
      },
      {
        href: "/terms",
        label: "Terms",
        why:
          "The other half of what Stripe checks before it will activate an " +
          "account. Its subscription clauses are absent in a project that " +
          "only takes one-off payments, because `src/legal.ts` is generated.",
      },
    );
  }

  // Nothing else in a generated project earns a footer entry, and inventing one
  // would be worse than leaving it out. /checkout means nothing without a
  // product in its query string, /checkout/success is reached by redirect after
  // a payment, a product page needs a slug, /sign-in is already the header's
  // signed-out affordance, /admin belongs to APP_LINKS and would be advertised
  // to signed-out visitors from here — and there is still no About, Contact or
  // Blog, because the scaffold generates none of the three. /privacy and /terms
  // are here only in the configurations that actually emit them.

  const arrays = [
    renderLinkArray(
      "SITE_LINKS",
      "/** Public top-level destinations, in nav order. */",
      site,
    ),
    renderLinkArray(
      "APP_LINKS",
      [
        "/**",
        " * Destinations for a signed-in user, in nav order.",
        " *",
        " * Rendered only once there is a user, so nobody signed out is shown a link",
        " * they cannot follow. What is IN it still depends on what was installed —",
        " * a project generated without an admin shell contributes no Admin entry —",
        " * and the header maps over whatever is here rather than asking whether a",
        " * panel exists.",
        " */",
      ].join("\n"),
      app,
    ),
    renderLinkArray(
      "FOOTER_LINKS",
      [
        "/**",
        " * Secondary destinations, in footer order.",
        " *",
        " * Reachable from every page and deliberately out of the header. The primary",
        " * nav stays short enough to read at a glance; everything else a visitor can",
        " * legitimately open lives down here, so keeping the header tidy never costs",
        " * a route its only way in.",
        " */",
      ].join("\n"),
      footer,
    ),
  ];

  return `/**
 * Where the parts of ${answers.projectName} are.
 *
 * Generated from the answers this project was created with, and that is the
 * only way it can be correct: a link to a route the project never installed is
 * a 404 in the header of every page, and a route installed with nothing linking
 * to it is a feature nobody can find.
 *
 * Map over these. There is no flag here and no null — a feature that was not
 * installed contributes no entry, and whatever is left is the nav. Add your own
 * routes as you build them, to the array whose audience matches: SITE_LINKS is
 * seen by everyone including signed-out visitors, APP_LINKS only once somebody
 * is signed in, FOOTER_LINKS by everyone but out of the way.
 *
 * Two runtime filters, and absent means everyone: \`audience\` — "staff" links
 * are drawn only for a staff role (the header checks), "developer" links are
 * left out of the footer in production (/setup is a diagnostics page) — and
 * \`permission\`, a key of the viewer's active company: the header and the
 * dashboard draw the link only when the person's role there holds it.
 * Which links EXIST was settled when this file was generated; who SEES them is
 * settled per request.
 */
export interface SiteLink {
  readonly href: string;
  readonly label: string;
  readonly audience?: "staff" | "developer";
  /** A permission key of the viewer's ACTIVE company; the link shows only when their role there holds it. */
  readonly permission?: string;
}

${arrays.join("\n")}`;
}

/**
 * One item in the generated admin sidebar, with the reason it is there.
 *
 * Separate from `GeneratedLink` because a sidebar item carries a permission and
 * a nav link does not: `SITE_LINKS` is public and `APP_LINKS` needs only a
 * signed-in user, whereas everything in the admin shell is gated on a key the
 * server has already resolved. Merging the two shapes would put an optional
 * `permission` on every public link, which is an invitation to leave it off.
 */
interface GeneratedNavItem {
  readonly href: string;
  readonly label: string;
  /** A key from the STAFF catalog. Without it the item is not rendered. */
  readonly permission: string;
  readonly why: string;
}

interface GeneratedNavGroup {
  readonly heading: string;
  readonly items: readonly GeneratedNavItem[];
}

/**
 * One `{ heading, items: [...] }` literal, each item under its reason.
 *
 * Indented two levels deeper than `renderLinkArray`'s output because these sit
 * inside a group rather than at the top of an array, and a generated file whose
 * comments do not line up with the code they describe is one people stop
 * reading.
 */
function renderNavGroup(group: GeneratedNavGroup): string {
  const items = group.items
    .map(
      (item) =>
        indentedComment(item.why)
          .split("\n")
          .map((line) => (line.length > 0 ? `    ${line}` : line))
          .join("\n") +
        `      { href: "${item.href}", label: "${item.label}", permission: "${item.permission}" },\n`,
    )
    .join("\n");

  return `  {
    heading: "${group.heading}",
    items: [
${items}    ],
  },`;
}

/**
 * `src/components/admin/AdminNav.tsx` for this project.
 *
 * GENERATED, and it had to become generated for the reason `src/nav.ts` already
 * is: which admin routes exist depends on the answers, and a sidebar written by
 * hand inside one overlay cannot see the others. `admin-minimal` ships /admin,
 * /admin/audit and /admin/tenants; `admin-full` layers /admin/people,
 * /admin/roles, /admin/errors and /admin/support on top; `catalog-admin`
 * contributes /admin/products only when the project sells something. No single
 * hardcoded list is right for all of those, and the list that was hardcoded was
 * wrong in both directions at once.
 *
 * IT ARGUED ITSELF INTO THE FIRST FAULT. The claim was that every item is
 * permission-gated, so an item whose page ships in a different overlay hides
 * itself. That is true of `catalog.products.view`, which exists only once the
 * catalog package is installed. It is FALSE of `staff.people.view` and
 * `staff.roles.view`, which `renderPermissionsCatalog` writes into every
 * project unconditionally and `seed-roles.ts` grants to `admin` and `cs_lead`.
 * A seeded administrator on an `--admin minimal` project therefore saw People
 * and Roles & permissions in the sidebar and got a 404 from both.
 *
 * AND THE DEFENCE AGAINST IT CAUSED THE SECOND. Leaving /admin/errors and
 * /admin/support out entirely — because neither has a permission key that could
 * hide them on a minimal shell — stranded two real pages in every `--admin full`
 * project: they build, they serve, and nothing anywhere links to them.
 *
 * Both faults are the same missing distinction. WHICH ITEMS EXIST is a fact
 * about how the project was generated, and is settled here. WHO SEES THEM is a
 * fact about one viewer at one moment, and is settled at runtime by the filter
 * below. Neither substitutes for the other.
 */
export function renderAdminNav(answers: Answers): string {
  const plural = tenantLabelPlural(answers);
  const sells = answers.businessModel !== "none";
  const full = answers.adminShell === "full";

  const overviewItems: GeneratedNavItem[] = [
        {
          href: "/admin",
          label: "Dashboard",
          permission: "staff.dashboard.view",
          why:
            "The shell's own index, generated beside this file. Present " +
            "wherever an admin panel is, which is the only circumstance in " +
            "which either of them is written at all.",
        },
        {
          href: "/admin/access",
          label: "Your access",
          permission: "staff.dashboard.view",
          why:
            "The resolved staff permission set for whoever is signed in, from " +
            "admin-minimal. It used to BE the dashboard, which is why it needs " +
            "an entry now: a page nothing links to is a page nobody finds, and " +
            "this is the one that settles \"why can they do that\" during a " +
            "support call. On the shell's own key rather than a key of its own, " +
            "because it shows the viewer nothing they are not already holding.",
        },
  ];

  // The alerts page belongs beside the dashboard, not in a feature group: it
  // is the first screen a shift starts on, and events from EVERY feature write
  // it. From the notifications-admin overlay — a single business's (a
  // company's alerts are in its own area) — which this function only runs
  // alongside: no shell, no entry, no page. Tenancy 2b-1 renamed it from
  // Inbox; /admin/inbox redirects here.
  if (answers.includeNotifications && answers.tenantNoun === "none") {
    overviewItems.push({
      href: "/admin/alerts",
      label: "Alerts",
      permission: "staff.alerts.view",
      why:
        "Your own alerts — new estimate requests, visit requests, customers' " +
        "changes, invoices opened, paid or overdue — with how you get each " +
        "one and who hears about new work in Alert settings.",
    });
  }

  const groups: GeneratedNavGroup[] = [{ heading: "Overview", items: overviewItems }];

  // The product builder lives in `catalog-admin`, which is copied only when the
  // project sells something AND asked for a shell to put it in. Absence here is
  // that overlay not having been copied — not a key nobody happens to hold.
  if (sells) {
    groups.push({
      heading: "Catalog",
      items: [
        {
          href: "/admin/products",
          label: "Products",
          permission: "catalog.products.view",
          why:
            "The product builder, from the catalog-admin overlay. The key is " +
            "contributed by the catalog package, so a project without a shop " +
            "has neither the page nor the permission — but what keeps this " +
            "entry out of one is the overlay that was not copied.",
        },
        {
          href: "/admin/billing",
          label: "Plans & billing",
          permission: "staff.billing.resync",
          why:
            "The plan catalogue's state at Stripe, and the re-sync that " +
            "repairs it. From catalog-admin, so it appears on the same " +
            "condition the product builder does — a project that sells " +
            "something AND asked for a shell to put it in. It matters more " +
            "here than an equivalent screen would in a kit that treats Stripe " +
            "as the record: this firm owns the subscriptions table, so a " +
            "missed webhook leaves it authoritative and wrong with nothing " +
            "else to reconcile against.",
        },
      ],
    });
  }

  // The triage surfaces from the feedback-admin overlay, which is copied on
  // the same two-condition shape as catalog-admin: the feedback answer AND a
  // shell to put the pages in. This function only runs when there is a shell,
  // so the answer alone decides here. Both entries sit on the shell's own key
  // — the queue holds nothing a staff viewer may not see, and a key of its
  // own is worth minting when triage grows actions not every staff member
  // should hold.
  if (answers.includeFeedback) {
    groups.push({
      heading: "Feedback",
      items: [
        {
          href: "/admin/feedback",
          label: "Queue",
          permission: "staff.dashboard.view",
          why:
            "Every ticket the widget submitted, newest first, with the " +
            "screenshot, click trail and browser errors that arrived with " +
            "it. From the feedback-admin overlay, so a project without the " +
            "feedback answer has neither this page nor this entry.",
        },
        {
          href: "/admin/feedback/board",
          label: "Board",
          permission: "staff.dashboard.view",
          why:
            "The same tickets as columns, with drag-to-move and the ticket " +
            "workspace panel — conversation, status, assignee. A second view " +
            "over one queue, which is why it sits directly under it.",
        },
        {
          href: "/admin/feedback/statuses",
          label: "Columns",
          permission: "staff.dashboard.view",
          why:
            "The board's column editor (0.5.0): rows in feedback_statuses ARE " +
            "the columns, and this is the screen that edits them. Under the " +
            "views it configures, on the same key — configuring columns is " +
            "triage work until a team says otherwise.",
        },
        {
          href: "/admin/feedback/categories",
          label: "Categories",
          permission: "staff.dashboard.view",
          why:
            "The widget's dropdown editor (0.7.0): rows in feedback_categories " +
            "ARE what a reporter can call their report, and showToCustomer is " +
            "the curation — a staff-only category exists for triage without " +
            "ever being offered to the person filing a bug.",
        },
      ],
    });
  }

  // Operating the site itself rather than any customer's account: the
  // self-audit and the file library. One group for however many of the two
  // were asked for, because a heading over a single link is still better than
  // that link filed under "Accounts" where nobody thinks to look for it.
  const operations: GeneratedNavItem[] = [];
  if (answers.includeSeoReports) {
    operations.push({
      href: "/admin/seo",
      label: "SEO & AEO",
      permission: "staff.dashboard.view",
      why:
        "The site grading itself: audit runs from the seo-reports package, " +
        "receipts in this project's own seo_reports table. From the " +
        "seo-admin overlay, so a project without the answer has neither " +
        "this page nor this entry.",
    });
  }
  // A single business's Files screen (storage-admin). A company's files are
  // in its own area (/app/files), never the platform's admin.
  if (answers.includeStorage && answers.tenantNoun === "none") {
    operations.push({
      href: "/admin/files",
      label: "Files",
      permission: "staff.files.view",
      why:
        "The business's photos and files from the storage package — on its " +
        "visits, estimates and invoices, and its own — with what each is " +
        "attached to and how much room is left. Deleting one removes the " +
        "stored copy too.",
    });
  }
  if (answers.includeAssistant) {
    operations.push({
      href: "/admin/assistant",
      label: "Assistant",
      permission: "staff.dashboard.view",
      why:
        "The AI assistant's editable personality from the assistant package: " +
        "versioned sections, tenant overlays, glossary and change log. From " +
        "the assistant-admin overlay, so a project without the answer has " +
        "neither the editor nor this entry.",
    });
  }
  if (operations.length > 0) {
    groups.push({ heading: "Operations", items: operations });
  }

  // Field service — the quote → book → bill work, plus the two around it. One
  // group for however many were asked for; each entry is present only when its
  // overlay was copied, each on its own job's staff key.
  //
  // A SINGLE BUSINESS ONLY (Tenancy 2a). In a companies project the platform
  // has no schedule, price book, ledger or messages of its own — each company
  // runs them in its own area (/app/…), and the admin shell is the operator
  // console — so none of these four is listed there. (AI citations is still
  // the platform's.)
  const single = answers.tenantNoun === "none";
  const fieldService: GeneratedNavItem[] = [];
  if (single && answers.includeEstimator) {
    fieldService.push(
      {
        href: "/admin/estimates",
        label: "Estimates",
        permission: "staff.estimates.view",
        why:
          "Every lead the estimate page and the embed saved, and every quote " +
          "sent, from the estimator widget: search, filter by where it stands, " +
          "archive. Opening one shows the customer's photo, what the AI saw " +
          "beside what the customer said, and the priced lines to edit and " +
          "send as a quote.",
      },
      {
        href: "/admin/estimator",
        label: "Price book",
        permission: "staff.estimates.view",
        why:
          "Products priced from the business's own supplies, labor and " +
          "markup, with a live test quote and exactly what a customer will be " +
          "asked. Viewing is everybody's; changing it is " +
          "staff.estimates.pricebook, and costs and margins show only with " +
          "staff.estimates.costs.",
      },
      {
        href: "/admin/estimator/settings",
        label: "Estimate settings",
        permission: "staff.estimates.settings",
        why:
          "The business's name and contact, tax rate, quote validity and " +
          "follow-up, who hears about new leads, photo reading and its daily " +
          "budget, and the keys for putting the estimate on another website.",
      },
    );
  }
  if (single && answers.includeScheduling) {
    fieldService.push(
      {
        href: "/admin/schedule",
        label: "Schedule",
        permission: "staff.schedule.view",
        why:
          "The day/week calendar per crew from the scheduling widget: requests " +
          "from /book-visit to accept or decline, drag to move or reassign, " +
          "and a new visit for a customer on the phone. Every change emails " +
          "the customer when comms is installed.",
      },
      {
        href: "/admin/schedule/today",
        label: "Today's route",
        permission: "staff.schedule.route",
        why:
          "A crew's stops for the day, on a phone: directions, call, Start " +
          "and Complete. On the crew's own key, so a crew member signed in " +
          "on their phone sees this and nothing else in the sidebar.",
      },
      {
        href: "/admin/schedule/settings",
        label: "Schedule settings",
        permission: "staff.schedule.settings",
        why:
          "The business's time zone, services, notice, auto-confirm, request " +
          "expiry, reminders, crews and hours — every decision an owner makes " +
          "about scheduling, saved without a deploy.",
      },
    );
  }
  if (single && answers.includeInvoicing) {
    fieldService.push({
      href: "/admin/invoices",
      label: "Invoices",
      permission: "staff.invoices.view",
      why:
        "The invoice ledger from the invoicing widget: raise an invoice, send " +
        "it, record a payment, and copy the link a customer opens without an " +
        "account. On its own staff key (Tenancy 2a), not the shell's.",
    });
  }
  if (single && answers.includeComms) {
    fieldService.push({
      href: "/admin/comms",
      label: "Messages",
      permission: "staff.comms.view",
      why:
        "The Messages console from the comms widget: the wording of every email " +
        "customers get, and the delivery log. The cron route drains what is " +
        "due. On its own staff key (Tenancy 2a), not the shell's.",
    });
  }
  if (answers.includeAeo) {
    fieldService.push({
      href: "/admin/aeo",
      label: "AI citations",
      permission: "staff.dashboard.view",
      why:
        "Citation tracking from the aeo package: the questions customers ask an " +
        "assistant, and whether the answer mentions you. From aeo-admin, so a " +
        "project without the answer has neither the page nor this entry.",
    });
  }
  if (fieldService.length > 0) {
    groups.push({ heading: "Field service", items: fieldService });
  }

  const accounts: GeneratedNavItem[] = [
    {
      href: "/admin/companies",
      label: plural,
      permission: "staff.tenants.view",
      why:
        `Every customer ${tenantLabel(answers).toLowerCase()}: search, open ` +
        "one, suspend or reactivate it, give it a new owner (Tenancy 1's " +
        "operator console, from the admin-minimal overlay). /admin/tenants " +
        "redirects here for old links.",
    },
    {
      href: "/admin/people",
      label: "People",
      permission: "staff.people.view",
      why:
        "Everyone with an account, and who holds a staff role — where an " +
        "administrator hires staff, including another administrator. In " +
        "EVERY shell now (it moved from admin-full to admin-minimal), because " +
        "a project whose owner can't add a colleague without a shell command " +
        "isn't one a business owner can run.",
    },
  ];

  if (full) {
    accounts.push({
      href: "/admin/support",
      label: "Support",
      permission: "staff.dashboard.view",
      why:
        "admin-full only, and a placeholder on purpose — the scaffold ships " +
        "no ticket model because every business already has one. Gated on " +
        "the key that says you may use this shell rather than on a key of " +
        "its own: the page enforces nothing, and declaring " +
        '"staff.support.view" here would advertise a control that does not ' +
        "exist. Give it a real key when you give it a real queue.",
    });
  }

  groups.push({ heading: "Accounts", items: accounts });

  const governance: GeneratedNavItem[] = [];

  if (full) {
    governance.push({
      href: "/admin/roles",
      label: "Roles & permissions",
      permission: "staff.roles.view",
      why:
        "admin-full only, and the same trap as People: `staff.roles.view` is " +
        "seeded in every project, so the permission filter on its own would " +
        "put this link in a minimal shell with no page behind it.",
    });
  }

  governance.push({
    href: "/admin/audit",
    label: "Audit log",
    permission: "staff.audit.view",
    why:
      "admin-minimal, so it is in every shell. Who did what, including the " +
      "sensitive-access rows impersonation writes.",
  });

  if (full) {
    governance.push({
      href: "/admin/errors",
      label: "Errors",
      permission: "staff.audit.view",
      why:
        "admin-full only. Beside the audit log and on the SAME key, which is " +
        "what the page itself checks: a stack trace routinely carries " +
        "customer data, so reading one is the audit privilege rather than a " +
        "lesser one. Until the sidebar was generated this page had no entry " +
        "anywhere, and the only way to reach it was to know the URL.",
    });
  }

  groups.push({ heading: "Governance", items: governance });

  return `"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SITE_LINKS } from "@/nav";

/**
 * The admin sidebar for ${answers.projectName}.
 *
 * GENERATED FROM THE ANSWERS THIS PROJECT WAS CREATED WITH, exactly like
 * \`src/nav.ts\` and for the same reason: which admin routes exist is a fact
 * about how the project was generated, and a hand-written list cannot see it.
 * A minimal shell has no /admin/people and no /admin/roles; a full one has
 * both; /admin/products arrives only with a catalog. One list covering every
 * case is a 404 in the sidebar of the smaller projects and an unreachable page
 * in the larger ones.
 *
 * WHICH ITEMS EXIST was decided when this file was written. WHO SEES THEM is
 * decided below, on every render, from the permission set the server resolved.
 * Both are load-bearing and neither replaces the other — a permission key can
 * be declared in a project whose pages were never copied in, which is exactly
 * how People and Roles & permissions came to point at nothing.
 *
 * \`granted\` is the server's answer, passed down; the client never re-derives it
 * from role templates. That is deliberate: askLou's client hook preferred
 * custom role permissions while ~20 of its routers ignored them, so the UI and
 * the server disagreed by construction. One resolver, one answer, and the
 * browser is only ever told the result.
 *
 * THIS FILE IS YOURS NOW. It was written once, at generation, and nothing
 * rewrites it — so a section you add here stays added.
 */
export interface AdminNavProps {
  readonly granted: readonly string[];
}

interface NavItem {
  readonly href: string;
  readonly label: string;
  /** Hidden unless the viewer holds this. */
  readonly permission: string;
}

interface NavGroup {
  readonly heading: string;
  readonly items: readonly NavItem[];
}

/**
 * Grouped, and the grouping is the point: a flat list of eight links makes
 * every section look equally likely, and the two people actually use — the
 * dashboard and whatever they came to change — get no more weight than the
 * audit log.
 */
const GROUPS: readonly NavGroup[] = [
${groups.map(renderNavGroup).join("\n")}
];

export function AdminNav({ granted }: AdminNavProps) {
  const pathname = usePathname();
  const allowed = new Set(granted);

  const visible = GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => allowed.has(item.permission)),
  })).filter((group) => group.items.length > 0);

  return (
    <nav aria-label="Admin" className="flex-1 overflow-y-auto px-2 py-3">
      {visible.map((group) => (
        <div key={group.heading} className="mb-4 last:mb-0">
          <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-ink-muted">
            {group.heading}
          </p>
          <ul>
            {group.items.map((item) => {
              // Exact match only. A \`startsWith\` test lights up "Dashboard" on
              // every page, because every admin route begins with /admin.
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={
                      active
                        ? "block rounded-[--radius-card] bg-accent-soft px-2 py-1.5 text-sm font-medium text-accent no-underline"
                        : "block rounded-[--radius-card] px-2 py-1.5 text-sm text-ink-muted no-underline hover:bg-canvas hover:text-ink"
                    }
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {visible.length === 0 && (
        <p className="px-2 text-[13px] text-ink-muted">
          You have staff access but no sections have been granted yet. Someone
          holding <code className="font-mono">staff.roles.manage</code> can grant
          them on the Roles page.
        </p>
      )}

      {/*
        The way out, and deliberately not another group.

        A staff user who has just created a product needs to look at it, and
        until this existed there was no route from the admin to the thing the
        admin edits — you had to know the URL. It sits under a rule rather than
        inside the list above because it is a different KIND of destination:
        everything above is a page in this shell, everything here is the public
        site, which the person reading is not the audience for.

        Driven by SITE_LINKS, which is generated from the same answers as the
        groups above and carries a shop entry only in a project that has a shop.
        No emptiness check either — every project has a public home page, so the
        array always has something in it.
      */}
      <div className="mt-4 border-t border-line pt-3">
        <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-ink-muted">
          Public site
        </p>
        <ul>
          {SITE_LINKS.map((link) => (
            <li key={link.href}>
              {/* A plain <a>, not next/link: a new tab opens a fresh document
                  either way, so Link would add a prefetch of a page this tab
                  never shows. New tab because the admin is a working context —
                  a half-filled form, a filtered list — and checking the public
                  page should not cost you the place you were in. */}
              <a
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 rounded-[--radius-card] px-2 py-1.5 text-sm text-ink-muted no-underline hover:bg-canvas hover:text-ink"
              >
                {link.label}
                <span aria-hidden="true">↗</span>
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
`;
}

/**
 * `app/admin/page.tsx` for this project.
 *
 * GENERATED, for the reason `src/components/admin/AdminNav.tsx` is: which
 * panels can exist is a fact about how the project was generated, and no single
 * hand-written file is right for all of them. A dashboard shipped inside
 * `admin-minimal` cannot import the commerce schema — a project generated with
 * `--model none` never installs that package, so the file would not compile —
 * and a dashboard that asked at runtime whether commerce was installed would be
 * exactly the conditional the artifact is forbidden to carry. Absence here is a
 * query that was never written.
 *
 * WHAT IT REPLACED: "Signed in as", and eighteen permission chips. That is a
 * debug view, and it was the first thing every client saw. It answers a real
 * support question and it answers nothing an operator opens a panel to find
 * out, so it has moved to /admin/access intact and this page now carries the
 * queues.
 *
 * EVERY NUMBER IS A COUNT OF ROWS THIS PROJECT ACTUALLY WRITES. No MRR, no
 * churn, no ARPU, no invented trend percentage beside a figure. The firm ships
 * to clients in different businesses and not one of those means the same thing
 * twice; a generated dashboard full of them is a screenshot in somebody's board
 * deck within the week. That refusal is the one the old page made and it
 * survives — what changes is that the alternative is no longer a list of
 * permission keys.
 *
 * IT READS `db` DIRECTLY, unlike /admin/audit which goes through the tRPC
 * caller. Deliberate and narrow: the counts span four packages, routing them
 * would mean generating a router as well, every one of them is gated
 * immediately above the query by the same key a rung would have checked, and
 * nothing here writes. Anything that writes still goes through a procedure.
 */
export function renderAdminDashboard(answers: Answers): string {
  const scope = answers.scope;
  const sells = answers.businessModel !== "none";
  const full = answers.adminShell === "full";
  const plural = tenantLabelPlural(answers);
  const lowerPlural = tenantLabelPlural(answers).toLowerCase();

  // Every import the panels below need, and none that a panel which was not
  // written would need. A missing import fails the build; an unused one fails
  // lint in any project that turns the rule on — so the list is assembled from
  // the same conditions the panels are.
  const drizzle = sells
    ? "and, count, eq, gte, inArray, isNull, like, ne, not, sum"
    : "and, count, isNull, ne";

  const imports = [
    `import Link from "next/link";`,
    `import { ${drizzle} } from "drizzle-orm";`,
    `import { users } from "${scope}/auth/schema";`,
    `import { isDbConfigured } from "${scope}/db";`,
    `import { errorLog } from "${scope}/observability/schema";`,
    `import { tenantInvitations, tenants } from "${scope}/tenancy/schema";`,
  ];
  if (sells) {
    imports.push(
      `import { formatMinor } from "${scope}/catalog";`,
      `import { products } from "${scope}/catalog/schema";`,
      `import { orders, orderShipments } from "${scope}/commerce/schema";`,
    );
  }
  imports.push(
    `import {`,
    `  Card,`,
    `  CardBody,`,
    `  EmptyState,`,
    `  Notice,`,
    `  PageHeader,`,
    `} from "@/components/ui";`,
    `import { db } from "@/db";`,
    `import { currentPrincipal } from "@/server/auth";`,
  );
  if (sells) {
    // The prefix every fulfilment idempotency key starts with. Imported rather
    // than retyped: "was this actually paid for" is a string match, and a copy
    // of that string here would be a second place the answer lives.
    imports.push(`import { FULFILMENT_KEY_PREFIX } from "@/server/fulfilment";`);
  }
  imports.push(`import { loadStaffPermissions } from "@/server/permissions";`);

  const queries: string[] = [
    `    // Unresolved errors. The partial index \`error_log_unresolved_idx\` exists
    // for exactly this count, and it is the one number here that means
    // "somebody has to do something today".
    counted(can.can("staff.audit.view"), async () =>
      rows(
        await db
          .select({ n: count() })
          .from(errorLog)
          .where(isNull(errorLog.resolvedAt)),
      ),
    ),`,
    `    // Invitations nobody has accepted or withdrawn. Expired ones are counted
    // too, on purpose: an invitation that quietly timed out is still a person
    // waiting to be let in, and it is the case nobody notices.
    counted(can.can("staff.tenants.view"), async () =>
      rows(
        await db
          .select({ n: count() })
          .from(tenantInvitations)
          .where(
            and(
              isNull(tenantInvitations.acceptedAt),
              isNull(tenantInvitations.revokedAt),
            ),
          ),
      ),
    ),`,
    `    // Customer ${lowerPlural} only. A personal workspace is minted for every
    // signed-in user and they outnumber real customers by an order of
    // magnitude, so counting them would make this a sign-up counter wearing the
    // wrong label.
    counted(can.can("staff.tenants.view"), async () =>
      rows(
        await db
          .select({ n: count() })
          .from(tenants)
          .where(ne(tenants.kind, "personal")),
      ),
    ),`,
    `    // People, excluding soft-deleted rows. A deleted user keeps their row
    // because their audit history references it; counting them would make this
    // number one that only ever goes up.
    counted(can.can("staff.people.view"), async () =>
      rows(
        await db
          .select({ n: count() })
          .from(users)
          .where(isNull(users.deletedAt)),
      ),
    ),`,
  ];

  if (sells) {
    queries.push(
      `    // Shipments booked and not despatched. A NULL \`shipped_at\` means the row
    // exists so the warehouse has something to pick up, not that anything has
    // moved — which is precisely the queue.
    counted(can.can("catalog.products.view"), async () =>
      rows(
        await db
          .select({ n: count() })
          .from(orderShipments)
          .where(isNull(orderShipments.shippedAt)),
      ),
    ),`,
      `    // Orders paid for in the window, simulated ones excluded.
    counted(can.can("catalog.products.view"), async () =>
      rows(
        await db
          .select({ n: count() })
          .from(orders)
          .where(and(paidInWindow(since), not(wasSimulated()))),
      ),
    ),`,
      `    // Orders recorded with no payment behind them — all time, not the
    // window. This should be zero on the day payments go live, and only an
    // all-time count can still say so a month later.
    counted(can.can("catalog.products.view"), async () =>
      rows(
        await db
          .select({ n: count() })
          .from(orders)
          .where(wasSimulated()),
      ),
    ),`,
      `    // Products a customer can buy right now. Drafts and archived rows are
    // deliberately not folded in — "12 products" over a storefront showing
    // three is the kind of number that gets believed.
    counted(can.can("catalog.products.view"), async () =>
      rows(
        await db
          .select({ n: count() })
          .from(products)
          .where(and(eq(products.status, "active"), isNull(products.deletedAt))),
      ),
    ),`,
    );
  }

  const destructure = sells
    ? `  const [
    unresolvedErrors,
    openInvitations,
    customerTenants,
    peopleCount,
    awaitingDespatch,
    paidOrders,
    simulatedOrders,
    activeProducts,
  ] = await Promise.all([`
    : `  const [unresolvedErrors, openInvitations, customerTenants, peopleCount] =
    await Promise.all([`;

  const windowConstant = sells
    ? `
/** The window every "recently" on this page means. */
const WINDOW_DAYS = 30;
`
    : "";

  const sinceLine = sells
    ? `  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

`
    : "";

  const revenueRead = sells
    ? `
  /**
   * Takings in the window, one row per currency.
   *
   * NOT a single total. Summing 1000 JPY and 1000 GBP produces 2000 of nothing,
   * and it would look entirely plausible on the way to a board meeting.
   * Simulated orders are excluded here as well as counted separately: money
   * that never moved must not appear in a revenue figure at all.
   */
  const takings = can.can("catalog.products.view")
    ? await db
        .select({
          currency: orders.currency,
          // A \`sum\` over a bigint column comes back as a numeric string, or
          // NULL for an empty group. Parsed back to bigint rather than to a
          // number, because minor units are exact and a float is not.
          totalMinor: sum(orders.totalMinor),
        })
        .from(orders)
        .where(and(paidInWindow(since), not(wasSimulated())))
        .groupBy(orders.currency)
    : [];
`
    : "";

  const attentionTiles: string[] = [
    `    tile({
      label: "Errors to triage",
      value: unresolvedErrors,
      permission: "staff.audit.view",
      hint: "Problems the site recorded that nobody has marked as fixed.",${
        full ? '\n      href: "/admin/errors",' : ""
      }
    }),`,
  ];
  if (sells) {
    attentionTiles.push(`    tile({
      label: "Awaiting despatch",
      value: awaitingDespatch,
      permission: "catalog.products.view",
      hint: "Shipments a purchase booked and nobody has handed to a carrier.",
    }),`);
  }
  attentionTiles.push(`    tile({
      label: "Open invitations",
      value: openInvitations,
      permission: "staff.tenants.view",
      hint: "Sent, not accepted, not withdrawn. Expired ones are included.",
    }),`);

  const activityTiles: string[] = sells
    ? [
        `    tile({
      label: "Orders",
      value: paidOrders,
      permission: "catalog.products.view",
      hint: "Paid or fulfilled in the window. Refunds and cancellations are not counted.",
    }),`,
        `    tile({
      label: "Simulated orders",
      value: simulatedOrders,
      permission: "catalog.products.view",
      hint: "All time. Booked with no payment while Stripe is unconfigured.",
      href: "/admin/audit?sensitive=1",
    }),`,
      ]
    : [];

  const shapeTiles: string[] = [
    `    tile({
      label: "${plural}",
      value: customerTenants,
      permission: "staff.tenants.view",
      hint: "Customer ${lowerPlural}. Personal workspaces are not counted.",
      href: "/admin/companies",
    }),`,
    `    tile({
      label: "People",
      value: peopleCount,
      permission: "staff.people.view",
      hint: "Signed-in users, excluding soft-deleted rows.",${
        full ? '\n      href: "/admin/people",' : ""
      }
    }),`,
  ];
  if (sells) {
    shapeTiles.push(`    tile({
      label: "Products for sale",
      value: activeProducts,
      permission: "catalog.products.view",
      hint: "Active and not deleted — exactly what the storefront lists.",
      href: "/admin/products",
    }),`);
  }

  const activitySection = sells
    ? `
      <section className="mt-6">
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
          Last {WINDOW_DAYS} days
        </h2>
        <TileGrid tiles={activity} />
      </section>
`
    : "";

  const takingsPanel = sells
    ? `
      {takings.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
            Taken in the last {WINDOW_DAYS} days
          </h2>
          <Card>
            <CardBody className="flex flex-wrap gap-6">
              {takings.map((row) => (
                <p
                  key={row.currency}
                  className="text-2xl font-semibold tabular-nums text-ink"
                >
                  {/* formatMinor, never a division by 100. JPY has no minor
                      unit, so dividing renders 1,000 yen as 10 — a hundredfold
                      error that still looks like a plausible amount. */}
                  {formatMinor(BigInt(row.totalMinor ?? "0"), row.currency)}
                </p>
              ))}
            </CardBody>
          </Card>
        </section>
      )}
`
    : "";

  const simulatedBanner = sells
    ? `simulatedOrders !== null && simulatedOrders > 0 ? (
        <Notice
          tone="warn"
          title={
            simulatedOrders +
            (simulatedOrders === 1 ? " order was" : " orders were") +
            " recorded without a payment"
          }
        >
          The simulated checkout books a real order and applies every grant with
          no money moving. It exists only while{" "}
          <code className="font-mono">STRIPE_SECRET_KEY</code> is unset, and is
          refused outright on a production deployment — so this number should
          reach zero and stay there once payments are live.{" "}
          <Link
            href="/admin/audit?sensitive=1"
            className="text-accent underline underline-offset-2"
          >
            Every one of them is in the audit log
          </Link>
          .
        </Notice>
      ) : null`
    : "null";

  const helpers = sells
    ? `
/**
 * Money that actually arrived, in the window.
 *
 * \`fulfilled\` is the same money one step later, so it counts. \`refunded\` and
 * \`cancelled\` do not, and \`pending\` least of all — a bank debit that has not
 * cleared is not takings.
 */
function paidInWindow(since: Date) {
  return and(
    inArray(orders.status, ["paid", "fulfilled"]),
    gte(orders.placedAt, since),
  );
}

/**
 * Was this order booked without a payment?
 *
 * Read off \`idempotency_key\`, which is \`fulfilment:\` followed by the
 * reference, and a simulated reference always begins \`sim_\`. NOT off a NULL
 * \`stripe_payment_intent_id\`: that is also NULL for a real Checkout order
 * whose PaymentIntent has not been attached yet, so it would report genuine
 * takings as simulated for as long as a webhook is in flight.
 *
 * The pattern stops at \`sim\` rather than \`sim_\` because \`_\` is a
 * single-character wildcard in LIKE and would need escaping to mean itself. A
 * Stripe reference begins \`pi_\`, so there is nothing here to collide with.
 */
function wasSimulated() {
  return like(orders.idempotencyKey, FULFILMENT_KEY_PREFIX + "sim%");
}
`
    : "";

  return `${imports.join("\n")}

/**
 * The first screen somebody opens in the morning.
 *
 * GENERATED FROM THE ANSWERS THIS PROJECT WAS CREATED WITH, exactly like
 * \`src/nav.ts\` and \`src/components/admin/AdminNav.tsx\`, and for the same
 * reason: a panel that counts orders cannot exist in a project with no orders
 * table, and asking at runtime whether one was installed is the conditional
 * this scaffold refuses to emit. What is absent here is a query that was never
 * written, not a feature switched off.
 *
 * WHAT IT IS NOT. No MRR tile, no churn, no ARPU, no trend percentage. This
 * shell ships to businesses that do not resemble each other, and a number whose
 * definition was guessed is worse than no number, because it gets screenshotted
 * into a board deck. Every figure below is a count of rows this application
 * writes and each one names the table it came from.
 *
 * WHAT IT IS. Three questions in the order an operator asks them — what needs
 * doing, what happened, how big is this thing — with every number that has
 * somewhere to go rendered as a link to the page that manages the thing it
 * counts. A tile you cannot click is a fact; a tile you can click is a task.
 *
 * ZERO IS A REAL ANSWER AND READS AS ONE. On a project generated this morning
 * every number here is 0, which is correct and looks exactly like a page that
 * failed to load — so when nothing has happened at all, this says so in words
 * and names the command that changes it.
 *
 * PERMISSIONS ARE VISIBLE RATHER THAN INVISIBLE. A viewer who does not hold a
 * key sees the tile with the key printed where the number would be, and the
 * query behind it never runs. Hiding the tile would be tidier and would also
 * mean nobody ever discovers that a permission is the reason — which is the
 * support question this panel should be answering rather than generating.
 *
 * THIS FILE IS YOURS NOW. It was written once, at generation, and nothing
 * rewrites it.
 */
export const dynamic = "force-dynamic";
${windowConstant}
interface TileProps {
  readonly label: string;
  /** NULL means "you may not see this". It never means zero. */
  readonly value: number | null;
  readonly hint: string;
  readonly permission: string;
  readonly href?: string;
}

export default async function AdminDashboard() {
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;

  // Gated again here rather than relying on the layout: a page can be rendered
  // by a route that does not sit under this layout, and "the parent checked" is
  // not a property the type system enforces.
  if (!can) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <Notice tone="warn">
          You are signed in but hold no staff role, so there is nothing here to
          count.
        </Notice>
      </>
    );
  }

  // Asked before anything queries, exactly as every other admin page asks it.
  // Catching the throw instead cannot work — a caller wraps it and the name
  // does not survive — and this page would 500 on a project with no
  // credentials at all.
  if (!isDbConfigured(db)) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <Notice tone="warn" title="DATABASE_URL is not set">
          Every number on this page is a count of rows in Postgres, and this
          deployment has no connection to one. Add the variable to{" "}
          <code className="font-mono">.env.local</code> and restart —{" "}
          <Link href="/setup" className="text-accent underline underline-offset-2">
            /setup
          </Link>{" "}
          lists what else is outstanding.
        </Notice>
      </>
    );
  }

${sinceLine}  // ONE ROUND OF QUERIES for the whole screen. Each is a count over an indexed
  // predicate, none depends on another, and issuing them in sequence would make
  // the panel's first page its slowest.
${destructure}
${queries.join("\n")}
  ]);
${revenueRead}
  const attention: readonly TileProps[] = [
${attentionTiles.join("\n")}
  ];

  const activity: readonly TileProps[] = [
${activityTiles.join("\n")}
  ];

  const shape: readonly TileProps[] = [
${shapeTiles.join("\n")}
  ];

  // Every number THIS viewer is allowed to see. Withheld ones are excluded
  // rather than counted as zero: telling somebody that nothing has happened
  // when they simply cannot see what happened is a lie with a friendly tone.
  const visible = [...attention, ...activity, ...shape]
    .map((entry) => entry.value)
    .filter((value): value is number => value !== null);
  const nothingHasHappened =
    visible.length > 0 && visible.every((value) => value === 0);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="What's happening across the site. Each number opens the list behind it."
      />

      {/*
        ONE BANNER, CHOSEN BY STATE, never two stacked. Two banners is how a
        page teaches people to scroll past the one that mattered.
      */}
      {nothingHasHappened ? (
        <EmptyState title="Nothing has happened here yet">
          Every number below is real, and on a site this new every one of them
          is zero. They fill in as people sign up and use it.
        </EmptyState>
      ) : (
        ${simulatedBanner}
      )}

      <section className="mt-6">
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
          Needs attention
        </h2>
        <TileGrid tiles={attention} />
      </section>
${activitySection}${takingsPanel}
      <section className="mt-6">
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
          What is here
        </h2>
        <TileGrid tiles={shape} />
      </section>
    </>
  );
}

/**
 * Run a count, or decline to.
 *
 * The query does NOT run when the viewer may not see the answer. That is the
 * difference between a permission and a display rule: a permission that only
 * hides the rendering still reads the rows, and the first person to open a
 * network trace finds the number anyway.
 */
async function counted(
  allowed: boolean,
  run: () => Promise<number>,
): Promise<number | null> {
  return allowed ? await run() : null;
}

/** \`select count(*)\` returns one row, and \`noUncheckedIndexedAccess\` is on. */
function rows(result: readonly { readonly n: number }[]): number {
  return result[0]?.n ?? 0;
}
${helpers}
function TileGrid({ tiles }: { readonly tiles: readonly TileProps[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {tiles.map((entry) => (
        <Tile key={entry.label} {...entry} />
      ))}
    </div>
  );
}

/**
 * One number, or the reason it is not there.
 *
 * A withheld tile keeps its position and names the key it needs. Dropping it
 * from the grid would look cleaner and would leave the viewer no way to
 * discover that a permission is why — which is exactly the ticket this panel
 * should be answering rather than generating.
 */
function Tile({ label, value, hint, permission, href }: TileProps) {
  const figure = (
    <p className="text-2xl font-semibold tabular-nums text-ink">
      {value === null ? "\\u2014" : value.toLocaleString()}
    </p>
  );

  return (
    <Card>
      <CardBody>
        <p className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">
          {label}
        </p>
        {href && value !== null ? (
          <Link href={href} className="block no-underline hover:text-accent">
            {figure}
          </Link>
        ) : (
          figure
        )}
        <p className="mt-1 text-xs text-ink-muted">
          {value === null ? (
            <>
              {/* Plain words (review R2 T1BO-11); the key is in the title for whoever needs it. */}
              <span title={permission}>Not part of your staff role.</span>
            </>
          ) : (
            hint
          )}
        </p>
      </CardBody>
    </Card>
  );
}

/** Named so the arrays above read as a list of tiles rather than of objects. */
function tile(props: TileProps): TileProps {
  return props;
}
`;
}

/**
 * The orientation page — `app/(site)/page.tsx`, or `/setup/start` in a project
 * that generated a marketing site.
 *
 * ONE PAGE, TWO ADDRESSES, and `planEmit` picks between them. Its job is to get
 * whoever just ran the generator to the file they are about to edit, which is a
 * job worth a route in every configuration and worth `/` in only some of them:
 * a client being shown the site should land on the landing page, not on a list
 * of file paths. Marketing copy here would be copy that gets deleted in the
 * first hour, so this page never grew any — the marketing overlay is where that
 * lives, and it takes `/` when it is selected.
 *
 * A static landing page could not mention the shop. `/products` only exists
 * once the stripe overlay is selected, so the base template hardcoding it would
 * 404 for every project generated with `--model none` — and the overlay is
 * forbidden from rewriting a base file to add it. Generating the page is the
 * same answer `_app.ts` reached for the same reason.
 *
 * It renders no header of its own. It used to mount `<AuthHeader />` directly,
 * which was the only reason any page had a nav at all — and therefore the
 * reason every other route had none. `app/(site)/layout.tsx` mounts the header
 * and the footer now, so this page is just the page.
 */
export function renderHomePage(answers: Answers): string {
  const sells = answers.businessModel !== "none";

  const uiImports = sells
    ? "Card, CardBody, PageHeader, buttonClass"
    : "Card, CardBody, PageHeader";

  /**
   * The one entry in the list below that is not in every project.
   *
   * A GENERATED ARRAY WITH NO ENTRY, which is the only shape this scaffold
   * allows: the emitted page must not ask whether billing was installed. The
   * plan record is the first file anybody editing a subscription product opens,
   * and a file nothing points at is a file whose contents get retyped somewhere
   * else — which is exactly the duplication the record exists to end.
   */
  const startingPoints = [
    `  { path: "src/permissions/catalog.ts", what: "Permission keys" },`,
    ...(sells
      ? [`  { path: "src/plans.ts", what: "Plans, prices, and what each includes" },`]
      : []),
    `  { path: "src/db/schema.ts", what: "Your tables" },`,
    `  { path: "src/server/routers/_app.ts", what: "Your API" },`,
    `  { path: "src/trpc/client.tsx", what: "Calling it from a client component" },`,
    `  { path: "src/trpc/server.ts", what: "Calling it from a server component" },`,
    `  { path: "app/globals.css", what: "Colours, radius, dark mode" },`,
  ].join("\n");

  const shop = sells
    ? `
      <h2 className="mt-10 mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
        Your shop
      </h2>
      {/* Not a call to action. This is the only place a product created in the
          admin panel becomes visible, and with nothing pointing at it the
          storefront renders perfectly at a URL nobody has been told about —
          which from the outside is indistinguishable from having no shop. */}
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[46ch] text-sm text-ink-muted">
            Published products appear here &mdash; this is the page a customer sees.
          </p>
          <Link href="/products" className={buttonClass("primary")}>
            Open the shop
          </Link>
        </CardBody>
      </Card>
`
    : "";

  return `import Link from "next/link";
import type { ReactNode } from "react";
import { HealthCheck } from "@/components/HealthCheck";
import { ${uiImports} } from "@/components/ui";

/**
 * Where the files are. Nothing more.
 *
 * A generated project's landing page has one job — get whoever just ran the
 * generator to the file they are about to edit. Marketing copy here is copy
 * that gets deleted in the first hour, and a hero image is a hero image nobody
 * asked for.
 */
const STARTING_POINTS: readonly { readonly path: string; readonly what: string }[] = [
${startingPoints}
];

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <PageHeader
        title="${answers.projectName}"
        description="Auth, tenancy, permissions, tRPC and the environment contract are wired. Start building features."
      />

      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-muted">
            <HealthCheck />
          </p>
          <Link href="/setup" className="text-sm text-accent underline underline-offset-2">
            What is configured, and what is not
          </Link>
        </CardBody>
      </Card>

      <p className="mt-4 max-w-[62ch] text-sm text-ink-muted">
        Add credentials to <Code>.env.local</Code> whenever you want the feature
        they unlock. Nothing here blocks you from building.
      </p>
${shop}
      <h2 className="mt-10 mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
        Where to start
      </h2>
      <Card>
        <ul>
          {STARTING_POINTS.map((entry) => (
            <li
              key={entry.path}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-2.5 last:border-0"
            >
              <span className="text-sm text-ink">{entry.what}</span>
              <Code>{entry.path}</Code>
            </li>
          ))}
        </ul>
      </Card>
    </main>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-[3px] bg-accent-soft px-1 py-px font-mono text-xs text-accent">
      {children}
    </code>
  );
}
`;
}

/**
 * `src/plans.ts` for this project — the plan record.
 *
 * ONE OBJECT THAT THE PRICING PAGE, THE ENTITLEMENT CHECK AND THE STRIPE SEED
 * ALL READ. Two hand-maintained answers to "what does Pro include" is how a page
 * ends up advertising a tier the code does not honour, and the page is always
 * the copy that wins the argument with a customer.
 *
 * GENERATED RATHER THAN A TEMPLATE FILE, for the reason `src/db/schema.ts` and
 * `src/permissions/catalog.ts` are: it imports @__SCOPE_NAME__/billing, which a
 * `--model none` project never installs, so a copy of it in `template/` would
 * emit a module that cannot resolve its own import. Absence here is a file that
 * was not written — never an `if` inside one that was.
 *
 * NOT AN OVERLAY EITHER, and that is the load-bearing half. An overlay is copied
 * source the client restyles, and a pricing page is exactly that. But the record
 * is also read by server code and by the seed, and a runtime package can never
 * import from an overlay — so putting it in one would give the enforcement no
 * way to see what the page advertises, which is the whole problem this record
 * exists to close.
 *
 * The tiers below are a STARTING POINT, and the emitted file says so. Every
 * client's pricing is different; what does not change is the shape, and the
 * shape is enforced by `definePlans` rather than by this text.
 */
/**
 * "a" or "an" for a word the answers chose.
 *
 * The tenant noun is one of five, and two of them start with a vowel — so the
 * generated pricing copy read "For a organization" in a project generated with
 * the default. It shipped, and it is the second sentence on the page a customer
 * lands on. A five-line function rather than a dependency, because the input is
 * a closed set this file already owns.
 */
function article(word: string): "a" | "an" {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

export function renderPlanCatalog(answers: Answers): string {
  const scope = answers.scope;
  const label = tenantLabel(answers).toLowerCase();

  return `import { definePlans } from "${scope}/billing";

/**
 * What each plan includes, what it costs, and nothing else.
 *
 * THE SOURCE OF TRUTH. The \`plans\` TABLE is a projection of this object plus a
 * cache of two Stripe ids; \`pnpm db:seed:plans\` writes that projection and
 * reports anything in the table this record does not account for. It is that way
 * round on purpose — a limit that can be edited in a table re-entitles every
 * subscriber the moment somebody saves a form, with no deploy and no review, and
 * a pricing page that reads the table renders nothing at all on a fresh clone.
 *
 * WHO READS IT. The pricing page renders \`plans.tiers\` and \`plans.features\`.
 * \`grantsForPlan(tier)\` turns a tier into the \`entitlements\` rows a subscriber
 * holds, and \`planGrantDiff\` reconciles an upgrade without losing
 * \`used_value\` — somebody who has spent 400 of their 500 exports and moves to
 * Pro has still spent 400. \`planAllows(tier, ...)\` answers the option
 * questions, which never become entitlement rows because there is no sum of
 * "priority" and "email".
 *
 * THREE KINDS, AND THE THIRD IS THE ONE THAT MATTERS. A quota is a number and
 * reaches \`entitlements.limit_value\` unchanged. A flag is on or off and reaches
 * it as 1 or 0 — 0 rather than no row at all, so an add-on granting the same
 * feature can still turn it on, and the audit trail records that the plan
 * withheld it. An option is a choice from a closed set, which is neither, and it
 * is what real client pricing is full of: a support tier, a data-retention
 * window, "check every 10 minutes on Pro and every minute on Business".
 *
 * PRICES ARE A MAP over interval and then currency, in MINOR UNITS as
 * \`bigint\` — the same unit \`formatMinor\` renders and Stripe's \`unit_amount\`
 * accepts, with no conversion anywhere. Adding a second currency later means
 * touching the record, the projection, the Stripe sync and every page that
 * prints a price, all at once, on somebody else's deadline. The nesting is here
 * from the start so that day is a two-line edit.
 *
 * A TIER IS RETIRED, NEVER DELETED. \`starter-legacy\` below is the
 * demonstration: subscriptions reference the rows a tier projects and
 * \`entitlements.source_ref\` carries its key, so removing the declaration leaves
 * those subscribers holding rows no diff can reconcile. \`isActive: false\` takes
 * it off the pricing page and leaves everything else able to reason about it.
 *
 * ADD-ONS ARE NOT MODELLED HERE, deliberately. A seat pack is a PRODUCT in
 * ${scope}/catalog with an \`entitlement\` grant on it — it already has a price, a
 * Stripe sync and an admin screen. A second catalog of purchasable things inside
 * this record would give you two of each, and \`resolveEntitlements\` would sum
 * rows from both while only one of them had a receipt. What billing owes an
 * add-on is that a plan change never revokes it, and \`planGrantDiff\` only ever
 * removes rows whose source is \`plan\`.
 */
export const plans = definePlans({
  /**
   * The vocabulary, declared ONCE. Every tier below must supply a value for
   * every entry — that is a compile error, not a convention — because a feature
   * added to Pro and forgotten on Starter puts a hole in the comparison table
   * and makes \`checkEntitlement\` answer "your plan does not include seats at
   * all" when the truth is that somebody missed a line.
   *
   * A quota's label is rendered AFTER the number: "10 members".
   */
  features: {
    // \`labelOne\` because the free tier holds one of each, and without it the
    // first tier on the page reads "1 projects".
    seats: { kind: "quota", label: "members", labelOne: "member" },
    projects: { kind: "quota", label: "projects", labelOne: "project" },
    exports: {
      kind: "quota",
      label: "exports a month",
      labelOne: "export a month",
    },
    sso: { kind: "flag", label: "Single sign-on" },
    support: {
      kind: "option",
      label: "Support",
      // Best first. A tier offers a SUBSET of these, and offering anything not
      // in this list is refused at construction — which is what stops a value
      // nobody implemented being sold on the pricing page.
      values: ["priority", "email", "community"],
    },
  },

  /**
   * The array order IS the pricing page's order, and \`sortOrder\` is derived
   * from it. There is nothing here to keep in step.
   */
  tiers: [
    {
      key: "free",
      name: "Free",
      description: "Everything one ${label} needs to try this properly.",
      // A free plan is 0, never absent. \`plans.price_minor\` is 0 and not NULL
      // for the same reason: NULL propagates through every price computation
      // and renders a free plan as "no price" rather than as "Free".
      prices: { month: { gbp: 0n, usd: 0n }, year: { gbp: 0n, usd: 0n } },
      features: {
        seats: 3,
        projects: 1,
        exports: 100,
        sso: false,
        support: ["community"],
      },
    },
    {
      key: "starter",
      name: "Starter",
      description: "For ${article(label)} ${label} that has outgrown the free tier.",
      prices: {
        month: { gbp: 700n, usd: 900n },
        // Two months free, which is why the yearly figure is ten times the
        // monthly one rather than twelve.
        year: { gbp: 7000n, usd: 9000n },
      },
      features: {
        seats: 10,
        projects: 5,
        exports: 500,
        sso: false,
        support: ["email", "community"],
      },
    },
    {
      key: "pro",
      name: "Pro",
      description: "Unlimited seats, priority support and single sign-on.",
      // At most one tier may claim this. Two "most popular" badges on one page
      // is not a recommendation.
      highlight: true,
      prices: {
        month: { gbp: 2400n, usd: 2900n },
        year: { gbp: 24000n, usd: 29000n },
      },
      features: {
        // NULL is unlimited, and it is not a large number. One unlimited row
        // wins the feature in \`resolveEntitlements\`; a sentinel like 999999
        // would be capped by anything summing beside it.
        seats: null,
        projects: null,
        exports: 5000,
        sso: true,
        support: ["priority", "email", "community"],
      },
    },
    {
      key: "enterprise",
      name: "Enterprise",
      description: "Talk to us. Invoiced annually, with whatever you need on it.",
      // NO PRICES AT ALL, which is a real tier and not a missing one. It
      // projects no \`plans\` row, because there is nothing to charge and nothing
      // for Stripe to hold a price for — so a pricing page renders a "contact
      // us" button here instead of an amount.
      prices: {},
      features: {
        seats: null,
        projects: null,
        exports: null,
        sso: true,
        support: ["priority", "email", "community"],
      },
    },
    {
      key: "starter-legacy",
      name: "Starter (2024)",
      description: "Closed to new subscriptions.",
      // RETIRED, NOT REMOVED. Off the pricing page, still readable by everything
      // that has to reason about the people on it. Delete the declaration and
      // their entitlement rows point at a tier \`planGrantDiff\` has never heard
      // of, so the next plan change removes the lot.
      isActive: false,
      prices: {
        month: { gbp: 500n, usd: 600n },
        year: { gbp: 5000n, usd: 6000n },
      },
      features: {
        seats: 5,
        projects: 3,
        exports: 250,
        sso: false,
        support: ["community"],
      },
    },
  ],
});
`;
}

/**
 * `src/seo.ts` — the metadata every page inherits, and the one decision about
 * whether this deployment may be indexed.
 *
 * WRITTEN FOR EVERY PROJECT, marketing or not, and that placement is the whole
 * point. Two of the things in here are not marketing at all, they are damage
 * control:
 *
 * WITHOUT `metadataBase`, Next resolves every relative Open Graph and Twitter
 * URL against `http://localhost:3000`. The build does not warn in a way anybody
 * reads, the page renders perfectly, and the failure appears only in somebody
 * else's chat window: a shared link renders as a grey box with no image and no
 * title. It is invisible from inside the product, which is why it survives to
 * production and why it belongs in the base rather than behind an answer.
 *
 * WITHOUT A NOINDEX ON STAGING, a Neon-branch preview gets crawled. A preview
 * carrying the client's real copy competes with the client's real site for
 * their own brand terms, and the fix is a Search Console removal followed by
 * weeks of waiting — so this is a harm, and a harm must not be opt-in. The
 * decision is `INDEXABLE`, taken once here and imported by `app/robots.ts`, so
 * the `<meta name="robots">` tag and `/robots.txt` cannot disagree.
 *
 * `resolveAppEnv()` AND NOT `isDeployed()`. The two questions differ exactly
 * where it matters: an unlabelled production artefact resolves to `staging` and
 * reports `isDeployed() === false`, so keying on deployment would let precisely
 * the environment nobody could identify be indexed. Anything that is not
 * `production` is not indexed, and a host that wants to be indexed says so with
 * `APP_ENV=production`.
 *
 * EVALUATED AT BUILD, which is correct rather than a compromise:
 * `NEXT_PUBLIC_APP_URL` is inlined at build time by Next, and `VERCEL_ENV` is
 * present in the build environment, so both halves of this module describe the
 * same moment. A deployment that changes environment gets a rebuild anyway,
 * because the URL would otherwise be wrong too.
 *
 * NO `alternates.canonical` HERE, deliberately. Metadata is merged field by
 * field down the tree, so a canonical URL set in the root layout is inherited
 * by every page that does not override it — and a site whose every page
 * declares itself canonical to `/` asks Google to drop all of them from the
 * index. A page that needs a canonical sets its own. The same reasoning keeps
 * `openGraph.url` out.
 */
/**
 * The project's name as people read it (review R2 T1BO-11): "lawnco" →
 * "Lawnco", "igloo-back-office" → "Igloo Back Office". It is the header's
 * wordmark and the product name in invitation emails ("join Green Blade Lawn
 * Care on Lawnco"), where the npm package name read as a typo.
 */
export function displayNameOf(projectName: string): string {
  const words = projectName.split(/[-_.\s]+/).filter(Boolean);
  return words.length === 0 ? projectName : words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export function renderSeoModule(answers: Answers): string {
  const scope = answers.scope;
  return `import type { Metadata } from "next";
import { resolveAppEnv } from "${scope}/env";
import { env } from "@/env";

/**
 * What this site is called and what it says it is.
 *
 * SITE_NAME starts as the project's name, title-cased. It is the header's
 * wordmark and the product name in invitation emails: make it the name your
 * customers know.
 *
 * SITE_DESCRIPTION is placeholder copy and the only string here you must
 * replace. It is what a search result shows, what a shared link shows, and what
 * an AI crawler quotes — one sentence, written for a person who has never heard
 * of this product, in about 150 characters. Left as it is, it says nothing.
 */
export const SITE_NAME = ${JSON.stringify(displayNameOf(answers.projectName))};

export const SITE_DESCRIPTION =
  "One sentence about what ${answers.projectName} does and who it is for. " +
  "Replace this: it is the line search results and shared links show.";

/**
 * May this deployment be indexed?
 *
 * PRODUCTION ONLY, and the comparison is against \`resolveAppEnv()\` rather than
 * \`isDeployed()\` because an unlabelled production artefact resolves to
 * \`staging\` and reports itself as not deployed — the exact environment that
 * must not be crawled. Everything else is a preview, a laptop or a host nobody
 * named, and none of the three should ever appear in a search result.
 *
 * ONE CONSTANT, TWO CONSUMERS. \`siteMetadata\` below writes the robots meta tag
 * from it and \`app/robots.ts\` writes /robots.txt from it, so the page and the
 * file cannot say different things.
 */
export const INDEXABLE: boolean = resolveAppEnv() === "production";

/**
 * Inherited by every page. A page overrides a field by exporting its own
 * \`metadata\`; anything it leaves out falls through to this.
 */
export const siteMetadata: Metadata = {
  // Every relative OG and Twitter URL is resolved against this. Without it they
  // resolve against localhost and shared links render as a grey box.
  //
  // Guarded, not asserted: NEXT_PUBLIC_APP_URL is optional-until-deployed, and
  // this module loads during \`next build\` on machines that legitimately lack
  // it — CI most of all. \`new URL(undefined)\` there fails the whole build from
  // inside the /_not-found page, which points at everything except this line.
  metadataBase: env.NEXT_PUBLIC_APP_URL ? new URL(env.NEXT_PUBLIC_APP_URL) : undefined,
  // \`%s\` is the page's own title. A page exporting \`title: "Pricing"\` becomes
  // "Pricing · ${answers.projectName}" without repeating the site name in forty files.
  title: { default: SITE_NAME, template: \`%s · \${SITE_NAME}\` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    // A copy decision rather than a technical one, and it is here so it is made
    // once. Change it with the rest of the copy if this site is not British.
    locale: "en_GB",
  },
  twitter: {
    // The large card is the one that shows an image. \`summary\` shows a
    // thumbnail, which for a product link reads as a broken share.
    card: "summary_large_image",
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
  },
  robots: INDEXABLE
    ? { index: true, follow: true }
    : {
        // \`nocache\` as well as \`index: false\`, because the two are answers to
        // different questions: one asks not to be listed, the other asks not to
        // be kept. A preview that was crawled before this shipped is still in
        // the cache until it is told otherwise.
        index: false,
        follow: false,
        nocache: true,
        googleBot: { index: false, follow: false },
      },
};
`;
}

/**
 * `app/robots.ts` — what a crawler is allowed to look at.
 *
 * GENERATED, because the disallow list is a list of routes and which routes
 * exist depends on the answers. A hardcoded `/admin` in a project generated with
 * `--admin none` is a rule about nothing, and — worse in the other direction —
 * a project that grew an admin panel with no rule for it publishes the panel's
 * URL to every crawler that reads the file. The same reasoning that makes
 * `src/nav.ts` generated makes this generated.
 *
 * It states the decision `src/seo.ts` already took rather than taking it again.
 * Two independent readings of `resolveAppEnv()` are two chances for the meta tag
 * and the file to disagree, and the disagreement would be invisible: nothing in
 * the product renders /robots.txt.
 */
export function renderRobots(answers: Answers): string {
  const sells = answers.businessModel !== "none";

  /**
   * Routes that exist and should not be crawled, as a generated array. Nothing
   * in the emitted file asks whether a feature was installed — a project without
   * an admin panel contributes no entry and the array is simply shorter.
   */
  const disallowed: { readonly path: string; readonly why: string }[] = [
    {
      path: "/api/",
      why: "Route handlers. Webhooks and the tRPC endpoint answer JSON or 405 to a GET; neither belongs in an index.",
    },
    {
      path: "/setup",
      why: "The credential report. It never prints a value, but it does list which services this deployment is wired to, which is not a search result anybody wants.",
    },
    {
      path: "/members",
      why: "Signed-in only. A crawler gets the sign-in redirect, which costs it a request and gains it nothing.",
    },
    {
      path: "/settings",
      why: "The team page (and, for companies, their settings). Signed-in only.",
    },
    {
      path: "/invite/",
      why: "An invitation link. The URL is the key to it, and the page says nothing until someone signs in.",
    },
    {
      path: "/sign-in",
      why: "An auth screen indexes as a page with no content, and it competes with the real landing page for the brand term.",
    },
    { path: "/sign-up", why: "The same, for the other half of the pair." },
  ];

  if (answers.adminShell !== "none") {
    disallowed.push({
      path: "/admin",
      why: "The admin shell, from the admin overlay. Absent in a project generated with --admin none, which is why this list is generated.",
    });
  }
  if (answers.tenantNoun !== "none") {
    disallowed.push(
      {
        path: "/onboarding",
        why: "Naming a new company. Signed-in only, from the companies overlay.",
      },
      {
        path: "/dashboard",
        why: "A company's own home and setup checklist. Signed-in only.",
      },
      {
        path: "/app/",
        why: "Each company's own working area (Tenancy 2a): its schedule, estimates, invoices and messages. Signed-in only.",
      },
      {
        path: "/t/",
        why: "Each company's public pages (Tenancy 2a): its booking and estimate pages and the token pages behind its emails. Kept out of search in this release — every page there says noindex too — and the token pages are each one customer's key.",
      },
    );
  }
  // The token pages at the ROOT exist only in a single-business project: a
  // companies project's live under each company's /t/ address (above).
  const single = answers.tenantNoun === "none";
  if (single && answers.includeEstimator) {
    disallowed.push({
      path: "/quote/",
      why: "A customer's own quote, opened from the link in their email. The URL is the key to it (anyone holding it can accept); the page already says noindex and the API sends X-Robots-Tag, and this keeps a crawler that found a leaked link from fetching it at all.",
    });
  }
  if (single && answers.includeScheduling) {
    disallowed.push({
      path: "/visit/",
      why: "A customer's own visit, opened from the link in their email. The URL is the key to it; the page already says noindex and the API sends X-Robots-Tag, and this keeps a crawler that found a leaked link from fetching it at all.",
    });
  }
  if (single && answers.includeInvoicing) {
    disallowed.push({
      path: "/invoice/",
      why: "A customer's own invoice, opened from the link in their email. The URL is the key to it; the page already says noindex and the API sends X-Robots-Tag, and this keeps a crawler that found a leaked link from fetching it at all.",
    });
  }
  if (sells) {
    disallowed.push(
      {
        path: "/account",
        why: "A customer's own orders and billing. Signed-in only, and never a search result.",
      },
      {
        path: "/checkout",
        why: "Meaningless without a product in the query string, and a crawler following it would be indexing a payment form.",
      },
    );
  }

  const entries = disallowed
    .map((entry) => `${indentedComment(entry.why)}  "${entry.path}",\n`)
    .join("\n");

  return `import type { MetadataRoute } from "next";
import { env } from "@/env";
// THE DECISION IS TAKEN ONCE, in src/seo.ts, and imported here. Reading the
// environment again in this file would let /robots.txt and the robots meta tag
// on the page disagree — and nothing in the product renders /robots.txt, so the
// disagreement would only ever be found by a crawler.
import { INDEXABLE } from "@/seo";

/**
 * Routes that exist in this project and should not be indexed.
 *
 * A generated array, in the order it is written into the file. A project
 * generated without an admin panel contributes no /admin entry rather than
 * carrying a rule about a route it does not have.
 */
const DISALLOWED: readonly string[] = [
${entries}];

/**
 * /robots.txt.
 *
 * ANYTHING THAT IS NOT PRODUCTION REFUSES EVERYTHING. A preview deployment
 * carries the client's real copy at a URL nobody guards, and a crawled preview
 * competes with the client's own site for their own brand terms — undoing which
 * is a Search Console removal request followed by weeks of waiting. There is no
 * version of that trade worth the preview traffic.
 *
 * Evaluated at build, like every other metadata route. \`VERCEL_ENV\` is set in
 * the build environment and \`NEXT_PUBLIC_APP_URL\` is inlined at build anyway,
 * so a deployment that changes environment needs a rebuild regardless.
 */
export default function robots(): MetadataRoute.Robots {
  if (!INDEXABLE) {
    return { rules: [{ userAgent: "*", disallow: "/" }] };
  }

  return {
    rules: [{ userAgent: "*", allow: "/", disallow: [...DISALLOWED] }],
    // Absolute, because a sitemap reference in robots.txt must be. A relative
    // path here is ignored by every crawler that reads it, silently — so with
    // no base URL configured the line is omitted rather than emitted wrong.
    // Unreachable on an INDEXABLE deployment, where the variable is required.
    ...(env.NEXT_PUBLIC_APP_URL
      ? { sitemap: new URL("/sitemap.xml", env.NEXT_PUBLIC_APP_URL).toString() }
      : {}),
  };
}
`;
}

/**
 * `app/sitemap.ts` — the public pages this project actually has.
 *
 * GENERATED FOR THE SAME REASON `src/nav.ts` IS. A sitemap listing `/pricing` in
 * a project that never installed the pricing page asks every crawler to fetch a
 * 404, and repeated 404s from a submitted sitemap are the thing Search Console
 * reports as an error against the whole property. A sitemap that OMITS a page
 * the project does have is the quieter half of the same fault.
 *
 * NO `lastModified`, `changeFrequency` OR `priority`. Google ignores `priority`
 * outright and has said so; `changeFrequency` is a hint it mostly disregards;
 * and a `lastModified` taken from the build clock claims every page changed on
 * every deploy, which is a lie that trains the crawler to disbelieve the real
 * ones. A URL list is the part of a sitemap that does anything.
 */
export function renderSitemap(answers: Answers): string {
  const sells = answers.businessModel !== "none";

  const pages: { readonly path: string; readonly why: string }[] = [
    { path: "/", why: "The landing page. Every project has one." },
  ];

  if (answers.includeMarketing && sells) {
    pages.push({
      path: "/pricing",
      why: "From the marketing-pricing overlay, which needs both a marketing site and something to sell.",
    });
  }
  // A single business's own booking and estimate pages. A companies project
  // has none at its root — each company's are under /t/, which stays out of
  // search in this release (Tenancy 2a, D17), so none is listed here.
  const single = answers.tenantNoun === "none";
  if (single && answers.includeScheduling) {
    pages.push({
      path: "/book-visit",
      why: "The booking page, from the scheduling overlay — for a field-service business the page most worth finding. The manage pages under /visit are never listed: each URL is one customer's key.",
    });
  }
  if (single && answers.includeEstimator) {
    pages.push({
      path: "/estimate",
      why: "The instant estimate, from the estimator overlay. The quote pages under /quote are never listed: each URL is one customer's key.",
    });
  }
  if (sells) {
    pages.push({
      path: "/products",
      why: "The storefront, from the stripe overlay. Individual product pages are deliberately absent: they are database rows, so this file cannot know them — add a database read here when the catalogue is worth indexing.",
    });
  }
  if (answers.includeMarketing || sells) {
    pages.push(
      {
        path: "/privacy",
        why: "From the legal overlay. Low value as a search result and high value as a link a crawler can verify exists, which is what Stripe and an app store both check.",
      },
      { path: "/terms", why: "The other half of the pair." },
    );
  }

  const entries = pages
    .map((page) => `${indentedComment(page.why)}  "${page.path}",\n`)
    .join("\n");

  return `import type { MetadataRoute } from "next";
import { env } from "@/env";

/**
 * Every public page this project emitted, as a path.
 *
 * Generated from the answers, so a route that was never installed contributes
 * no entry. Sign-in, sign-up, /setup, /members, /account and /admin are absent
 * on purpose — they are either private or content-free, and /robots.txt already
 * asks crawlers not to follow them.
 */
const PUBLIC_PAGES: readonly string[] = [
${entries}];

/**
 * /sitemap.xml.
 *
 * Absolute URLs, built from NEXT_PUBLIC_APP_URL. A sitemap containing relative
 * paths is rejected wholesale rather than partially, so getting this wrong
 * costs the whole file.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  // No base URL, no sitemap: entries must be absolute, and a build without
  // NEXT_PUBLIC_APP_URL (CI, a fresh laptop) has nothing true to make them
  // absolute WITH. Empty is honest; localhost URLs in a sitemap are not.
  if (!env.NEXT_PUBLIC_APP_URL) return [];
  const base = env.NEXT_PUBLIC_APP_URL;
  return PUBLIC_PAGES.map((path) => ({
    url: new URL(path, base).toString(),
  }));
}
`;
}

/**
 * `app/llms.txt/route.ts` — the routing table answer engines read first.
 *
 * llms.txt is to ChatGPT, Claude and Perplexity what sitemap.xml is to
 * Google: a machine-readable map of where the substance lives, with one
 * sentence of context per link so an engine routes a question to the right
 * page instead of guessing from anchor text. The seo-reports package's own
 * AEO audit fails any site that does not serve one — including, for a while,
 * the site that ships the package. This emission closes that gap for every
 * generated project on its first boot.
 *
 * ALWAYS EMITTED, like robots.txt and the sitemap: answer-engine visibility
 * is plumbing, not marketing, and the page list is derived from the answers
 * exactly the way the sitemap's is — a route that was never installed
 * contributes no line.
 *
 * THE SUMMARY LINE IS THE CLIENT'S. Everything else here is a fact the
 * generator knows; what the product IS in one sentence is a claim only its
 * owner can make, and an answer engine will quote it verbatim. The emitted
 * default states only the project name, with the instruction to replace it
 * beside it, because a placeholder that reads like copy is a placeholder
 * that ships.
 */
export function renderLlmsTxt(answers: Answers): string {
  const sells = answers.businessModel !== "none";

  const pages: { readonly path: string; readonly line: string }[] = [
    { path: "/", line: "The landing page." },
  ];
  if (answers.includeMarketing && sells) {
    pages.push({ path: "/pricing", line: "Plans and pricing." });
  }
  // A single business's own pages only: a companies project's booking and
  // estimate pages are each company's, under /t/, and out of search in this
  // release (Tenancy 2a, D17).
  const single = answers.tenantNoun === "none";
  if (single && answers.includeScheduling) {
    pages.push({ path: "/book-visit", line: "Book a visit: pick a service and a time; we come to you." });
  }
  if (single && answers.includeEstimator) {
    pages.push({ path: "/estimate", line: "Instant estimate: a price from our own price book for what you can count or measure." });
  }
  if (sells) {
    pages.push({ path: "/products", line: "Published products available to buy." });
  }
  if (answers.includeMarketing || sells) {
    pages.push(
      { path: "/privacy", line: "Privacy policy; the subprocessor list is derived from the software actually installed." },
      { path: "/terms", line: "Terms of service." },
    );
  }

  const entries = pages
    .map((page) => `- [${page.path === "/" ? "Home" : page.path.slice(1)}](\${base}${page.path === "/" ? "/" : page.path}): ${page.line}`)
    .join("\n");

  return `/**
 * The routing table answer engines read first — sitemap.xml for the systems
 * that answer instead of listing. Generated from the answers, so a route that
 * was never installed contributes no line; the summary under the heading is
 * YOURS to write, because an answer engine will quote it verbatim and the
 * generator refuses to put words in your mouth.
 *
 * A route handler rather than a static file so the body can derive from the
 * environment. Content is deliberately terse — this is a map, not a pitch.
 */
import { env } from "@/env";

export function GET(): Response {
  // Paths stay relative until the deployment knows its own address; engines
  // only ever read this from a live site, where the variable is required.
  const base = env.NEXT_PUBLIC_APP_URL ?? "";
  const body = \`# ${answers.projectName}

> ${answers.projectName}. Replace this line with the one sentence you would
> say on the phone about what this product is — engines quote it verbatim.

## Pages

${entries}
\`;
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
`;
}

/**
 * `src/legal.ts` — the parts of a privacy policy and terms of service that only
 * the generator can know.
 *
 * THE ACCURACY IS THE PRODUCT. Every client arrives with a legal template
 * copied from another site, and the paragraph it always gets wrong is the one
 * listing who else sees their customers' data — because that list is a fact
 * about the software, not about the business, and the person adapting the
 * template has no way to know it. The generator does: it decided which packages
 * this project installed.
 *
 * A RECORD AND A PAGE, split the same way `src/plans.ts` and the pricing page
 * are. The pages in `overlays/legal` are copied source, because every client
 * restyles them and their lawyer rewrites the prose. This file is derived, so
 * it must not be. What is here is only what follows from the answers; the
 * company name, the address, the governing law and the contact address are
 * things nobody but the client knows, and they are placeholders in the copied
 * pages where they are obvious.
 *
 * THE OPTIONAL ROWS ARE THE HONEST PART. Sentry and Upstash are in every
 * project's environment contract because `@__SCOPE_NAME__/observability` is in
 * every project — but neither receives a byte until its credential is set. A
 * list that omitted them would be wrong for every deployment that does set one;
 * a list that stated them flatly would be wrong for every deployment that does
 * not. `activatedBy` says which, and the page prints it.
 */
export function renderLegalRecord(answers: Answers): string {
  const sells = answers.businessModel !== "none";
  const label = tenantLabel(answers).toLowerCase();

  interface Row {
    readonly name: string;
    readonly purpose: string;
    readonly dataShared: string;
    readonly activatedBy: string | null;
  }

  const subprocessors: Row[] = [
    {
      name: "Clerk",
      purpose: "Accounts and sign-in",
      dataShared:
        "Your name, your email address, and the identifiers Clerk issues for your account and each session.",
      activatedBy: null,
    },
    {
      name: "Neon",
      purpose: "The application database",
      dataShared:
        "Everything this service stores about you. It is held in Postgres, in the region the database was created in.",
      activatedBy: null,
    },
    {
      name: "Vercel",
      purpose: "Hosting and delivery",
      dataShared:
        "Every request to this site, including your IP address and browser, in server logs.",
      activatedBy: null,
    },
  ];

  if (sells) {
    subprocessors.push({
      name: "Stripe",
      purpose: "Payments and subscriptions",
      dataShared:
        "Your name, email address, billing address and card details. Card numbers are entered directly into Stripe and never reach this service.",
      activatedBy: null,
    });
  }
  if (answers.includeEmail) {
    subprocessors.push({
      name: "Resend",
      purpose: "Email we send you",
      dataShared:
        "The address a message is sent to, and the contents of that message.",
      activatedBy: null,
    });
  }
  if (answers.includeAi) {
    subprocessors.push(
      {
        name: "Anthropic",
        purpose: "The assistant",
        dataShared:
          "The messages you send to the assistant, and the context this service attaches to them.",
        activatedBy: "ANTHROPIC_API_KEY",
      },
      {
        name: "OpenAI",
        purpose: "The assistant, on deployments configured to use it",
        dataShared: "The same messages and context as above.",
        activatedBy: "OPENAI_API_KEY",
      },
      {
        name: "Google",
        purpose: "The assistant, on deployments configured to use it",
        dataShared: "The same messages and context as above.",
        activatedBy: "GOOGLE_GENERATIVE_AI_API_KEY",
      },
    );
  }

  if (answers.includeFeedback) {
    // The screenshots the widget captures are page renders, and a page render
    // is customer data — names, emails, whatever was on screen, minus the
    // fields the widget redacted. They land in a PUBLIC blob store reachable
    // by URL, which is exactly the kind of fact a privacy policy exists to
    // state and a copied template never does.
    subprocessors.push({
      name: "Vercel Blob",
      purpose: "Screenshots attached to feedback reports",
      dataShared:
        "The screenshot a reporter chose to attach, which shows whatever was on their screen. Stored publicly, at an unguessable URL.",
      activatedBy: "BLOB_READ_WRITE_TOKEN",
    });
  }

  // Both from @__SCOPE_NAME__/observability, which every project installs, and
  // both inert until a credential exists. Listed rather than omitted, because a
  // deployment that sets SENTRY_DSN is sending stack traces — which can carry a
  // user id — to a third party, and that is precisely what a subprocessor table
  // is for.
  subprocessors.push(
    {
      name: "Sentry",
      purpose: "Error reporting",
      dataShared:
        "Stack traces and the request context attached to an error, which can include the id of the signed-in account.",
      activatedBy: "SENTRY_DSN",
    },
    {
      name: "Upstash",
      purpose: "Rate limiting",
      dataShared:
        "A counter keyed to your IP address or account id. No message contents and no personal details.",
      activatedBy: "UPSTASH_REDIS_REST_URL",
    },
  );

  interface Clause {
    readonly heading: string;
    readonly body: string;
  }

  const dataCategories: Clause[] = [
    {
      heading: "Your account",
      body:
        "Your name and email address, held so you can sign in and so other " +
        `people in your ${label} can see who you are.`,
    },
    {
      heading: `Your ${label}`,
      body:
        `Which ${label} you belong to, what you may do inside it, and any ` +
        "invitation sent to you or by you.",
    },
    {
      heading: "An audit trail",
      body:
        "A record of administrative actions — who changed what, and when. It " +
        "is kept deliberately, because the alternative is being unable to " +
        "answer that question after a security incident.",
    },
    {
      heading: "Errors",
      body:
        "When something goes wrong, the failure is recorded with enough " +
        "context to reproduce it, which can include your account id and the " +
        "page you were on.",
    },
  ];

  if (sells) {
    dataCategories.push(
      {
        heading: "Orders",
        body:
          "What you bought, when, for how much, and the reference Stripe gave " +
          "the payment. Card details are not held here.",
      },
      {
        heading: "What your plan includes",
        body:
          "Your subscription, its status, and the allowances it grants you — " +
          "including how much of each you have used.",
      },
    );
  }
  if (answers.includeEmail) {
    dataCategories.push({
      heading: "Email we sent you",
      body:
        "A record that each message was sent, to which address, and whether " +
        "the provider accepted it.",
    });
  }
  if (answers.includeAi) {
    dataCategories.push({
      heading: "Assistant usage",
      body:
        "A record of each request to the assistant and its size, so usage can " +
        "be attributed and limited.",
    });
  }
  if (answers.includeFeedback) {
    dataCategories.push({
      heading: "Feedback you send",
      body:
        "A report submitted through the feedback button: your description, " +
        "the screenshot if you attached one, the page you were on, recent " +
        "browser errors, and the name or email you chose to give. Kept so " +
        "the problem you reported can be found and fixed.",
    });
  }

  const extraTerms: Clause[] = [];
  if (answers.businessModel === "one-time" || answers.businessModel === "both") {
    extraTerms.push({
      heading: "Purchases",
      body:
        "A purchase is complete when payment succeeds and what you bought is " +
        "made available to you. Prices are shown before you pay, in the " +
        "currency stated at checkout, and are the prices charged.",
    });
  }
  if (
    answers.businessModel === "subscription" ||
    answers.businessModel === "both"
  ) {
    extraTerms.push(
      {
        heading: "Subscriptions and renewal",
        body:
          "A subscription renews automatically at the end of each period at " +
          "the price then published, until it is cancelled. Cancelling stops " +
          "the next renewal; it does not shorten the period already paid for.",
      },
      {
        heading: "Changing plans",
        body:
          "Moving between plans changes what your account is entitled to from " +
          "the moment the change takes effect. Anything you have already used " +
          "in the current period stays used.",
      },
    );
  }
  if (sells) {
    extraTerms.push({
      heading: "Refunds",
      body:
        "STATE YOUR ACTUAL REFUND POLICY HERE. This sentence is a placeholder " +
        "and is not one: a refund policy is a commercial decision, and in " +
        "several jurisdictions a consumer has statutory rights that override " +
        "whatever it says.",
    });
  }
  if (answers.includeAi) {
    extraTerms.push({
      heading: "The assistant",
      body:
        "Replies from the assistant are generated by a language model. They " +
        "can be wrong, and they are not professional advice of any kind. " +
        "Check anything you intend to act on.",
    });
  }

  const renderRows = (rows: readonly Row[]): string =>
    rows
      .map(
        (row) =>
          `  {\n` +
          `    name: ${JSON.stringify(row.name)},\n` +
          `    purpose: ${JSON.stringify(row.purpose)},\n` +
          `    dataShared: ${JSON.stringify(row.dataShared)},\n` +
          `    activatedBy: ${row.activatedBy === null ? "null" : JSON.stringify(row.activatedBy)},\n` +
          `  },\n`,
      )
      .join("");

  const renderClauses = (clauses: readonly Clause[]): string =>
    clauses.length === 0
      ? "[]"
      : `[\n${clauses
          .map(
            (clause) =>
              `  {\n` +
              `    heading: ${JSON.stringify(clause.heading)},\n` +
              `    body:\n      ${JSON.stringify(clause.body)},\n` +
              `  },\n`,
          )
          .join("")}]`;

  return `/**
 * The parts of ${answers.projectName}'s privacy policy and terms that follow from
 * what this project is BUILT OUT OF, rather than from what the business decides.
 *
 * GENERATED. Every entry below is derived from the packages this project
 * installed, which is the one thing a legal template copied from another site
 * cannot get right — and the subprocessor list is the paragraph a regulator, an
 * enterprise customer's security review and Stripe's account activation all
 * read first. Regenerating the project regenerates this file; a package added
 * later is a row added here, not a paragraph somebody remembers to write.
 *
 * WHAT IS NOT HERE. The legal entity, its address, the contact address for a
 * data request, the governing law and the refund policy are facts about the
 * business, not the software. They are placeholders in \`app/(site)/privacy\` and
 * \`app/(site)/terms\`, where they are visible and obviously unfinished, rather
 * than plausible-looking defaults in a generated file nobody re-reads.
 *
 * THIS IS A STARTING POINT FOR A LAWYER, NOT ADVICE. It is accurate about the
 * software and says nothing at all about whether your processing is lawful,
 * which is the question that actually matters.
 */

export interface Subprocessor {
  readonly name: string;
  /** Why this service is in the stack, in a customer's words. */
  readonly purpose: string;
  /** What reaches it. Specific enough that a reader can disagree with it. */
  readonly dataShared: string;
  /**
   * The environment variable that turns this on, or \`null\` when the service is
   * unconditional.
   *
   * The honest half of the list. Sentry and Upstash are in every project's
   * environment contract and neither receives a byte until its credential is
   * set — so stating them flatly would be wrong on every deployment that has
   * not configured them, and omitting them would be wrong on every deployment
   * that has. Delete the rows you will never enable.
   */
  readonly activatedBy: string | null;
}

/**
 * Everyone this service can send your data to, and why.
 *
 * In the order a reader cares about: identity, storage, hosting, then the
 * services a particular deployment adds.
 */
export const SUBPROCESSORS: readonly Subprocessor[] = [
${renderRows(subprocessors)}];

/** One heading and one paragraph. The unit both legal pages render. */
export interface LegalClause {
  readonly heading: string;
  readonly body: string;
}

/**
 * What this service holds about a person, derived from the tables this project
 * actually has.
 *
 * A project that sells nothing contributes no order paragraph — an absent entry
 * rather than a paragraph hedged with "if applicable", which is the phrase that
 * makes a privacy policy unreadable and unverifiable at once.
 */
export const DATA_CATEGORIES: readonly LegalClause[] = ${renderClauses(dataCategories)};

/**
 * Terms that only apply because of what this project does.
 *
 * Empty in a project that neither sells nor answers with a model, which is the
 * correct number of clauses about subscriptions in a service that has none.
 */
export const EXTRA_TERMS: readonly LegalClause[] = ${renderClauses(extraTerms)};
`;
}
