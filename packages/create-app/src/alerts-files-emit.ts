/**
 * The Tenancy 2b-1 renderers (contract section 13.5): ALERTS and PHOTOS AND
 * FILES, for each company of a companies project and for the one business of
 * a single-business project.
 *
 *   src/server/alerts.ts          the alerts instance, every installed
 *                                 package's producer glued to it, the
 *                                 office-email seams and the sweeps
 *   src/server/alerts-routes.ts   the alerts handlers (route files only)
 *   app/api/cron/alerts/route.ts  the alerts cron
 *   src/server/files.ts           the two stores and the files instance
 *   src/server/files-routes.ts    the files handlers (route files only)
 *   src/components/AlertsBellSlot.tsx    the bell in the header (3 variants)
 *   src/components/RecordFilesSlot.tsx   a record's photos and files (2 variants)
 *   src/components/SetupFilesSlot.tsx    /setup's file-store rows (2 variants)
 *   src/server/visit-files.ts     where a visit's photos and files open
 *   src/server/alerts-links.ts    where "who gets these alerts" is chosen
 *
 * In their own module, the features-emit.ts precedent: emit.ts is long enough
 * already, and these files are one subject — what a company hears about, and
 * what it keeps.
 *
 * THE GENERATOR'S RULES APPLY HERE AS EVERYWHERE (README "Rules"):
 *
 *   - No emitted `if` asks whether a feature or a mode is installed. Each file
 *     below is written per mode and per feature set; a feature that isn't
 *     installed contributes no line, no import and no array entry. The `if`s
 *     that ARE emitted are about runtime state (which event arrived, whether
 *     an email failed, which environment this is) and each says so.
 *   - The screens are package components; the emitted files are glue.
 *   - A companies project contains no fixed business: ALERTS_TENANT and
 *     FILES_TENANT exist only in the single-business variants (D12's grep).
 *
 * IMPORT ORDER (13.10). `company-routes → company-setup → the feature glue →
 * scheduling-notify → alerts` is a chain, and `tenancy.ts → tenancy-logo →
 * files` another. They stay safe by four rules, each said again where it
 * applies:
 *
 *   1. alerts.ts and files.ts never import company-routes; their handler
 *      builders live in alerts-routes.ts and files-routes.ts, which only route
 *      files (and tests) import.
 *   2. files.ts imports nothing that imports tenancy.ts at load, because
 *      tenancy.ts imports it at load; its `stillValid` and `onUsage` reach
 *      tenancy and alerts by dynamic imports inside the functions.
 *   3. Every cross-module use inside the chains happens INSIDE a function,
 *      never at a module's top level.
 *   4. comms-senders.ts reaches alerts.ts by a dynamic import, and so does
 *      files.ts.
 */

import { tenantLabel, tenantLabelPlural, type Answers } from "./answers.js";
import { companiesMode } from "./tenancy-emit.js";

/** Any of the three features that keep records files can belong to. */
export function hasFileRecords(answers: Answers): boolean {
  return answers.includeScheduling || answers.includeEstimator || answers.includeInvoicing;
}

/** True when any field-service feature is installed (the alert producers). */
function hasFieldService(answers: Answers): boolean {
  return answers.includeScheduling || answers.includeEstimator || answers.includeInvoicing || answers.includeComms;
}

/**
 * Where each alert opens, per mode (13.5 `ALERT_HREFS`). Companies: the
 * company's own screens under /app (and the team page). Single: the shell's
 * pages under /admin — and, in a single-business project with no admin panel
 * (only invoicing and messages can be installed there), nowhere: "" is no
 * same-site path, so the packages' mappers answer `href: null` and the alert
 * opens nothing rather than a page that doesn't exist.
 */
export function alertHrefs(answers: Answers): Readonly<Record<string, string>> {
  const companies = companiesMode(answers);
  const shell = answers.adminShell !== "none";
  const out: Record<string, string> = {};
  if (companies) out.team = "/settings/team";
  if (answers.includeScheduling) {
    out.visit = companies ? "/app/schedule?date={date}&visit={id}" : "/admin/schedule?date={date}&visit={id}";
    out.crewDay = companies ? "/app/schedule/today" : "/admin/schedule/today";
  }
  if (answers.includeEstimator) out.estimate = companies ? "/app/estimates/{id}" : "/admin/estimates/{id}";
  if (answers.includeInvoicing) out.invoice = companies ? "/app/invoices/{id}" : shell ? "/admin/invoices/{id}" : "";
  if (answers.includeComms) out.messages = companies ? "/app/messages" : shell ? "/admin/comms" : "";
  if (answers.includeStorage) out.files = companies ? "/app/files" : shell ? "/admin/files" : "";
  // Tenancy 2b-2a: a company's feedback board, with the ticket open.
  if (companies && answers.includeFeedback) out.feedback = "/app/feedback?ticket={id}";
  return out;
}

/** The alert registry's fragments, in the order the contract lists them (13.5). */
function alertFragments(answers: Answers): readonly string[] {
  return [
    ...(companiesMode(answers) ? ["tenancyAlertKinds"] : []),
    ...(answers.includeScheduling ? ["schedulingAlertKinds"] : []),
    ...(answers.includeEstimator ? ["estimatorAlertKinds"] : []),
    ...(answers.includeInvoicing ? ["invoicingAlertKinds"] : []),
    ...(answers.includeComms ? ["commsAlertKinds"] : []),
    ...(answers.includeStorage ? ["storageAlertKinds"] : []),
    // Tenancy 2b-2a: a company's feedback board (this site's own board has no
    // company people to alert, so a single-business project has none).
    ...(companiesMode(answers) && answers.includeFeedback ? ["feedbackAlertKinds"] : []),
  ];
}

/**
 * The comms template each producer kind's office email is (D6, BO-11): the
 * kinds whose email the producing package sends itself. Every other kind's
 * email is notifications' `team_alert`.
 */
function producerTemplates(answers: Answers): ReadonlyArray<readonly [kind: string, template: string]> {
  return [
    ...(answers.includeEstimator
      ? ([
          ["estimator.lead", "estimate_lead_staff"],
          ["estimator.quote.accepted", "quote_staff_notice"],
          ["estimator.quote.declined", "quote_staff_notice"],
          ["estimator.quote.expired", "quote_staff_notice"],
        ] as const)
      : []),
    ...(answers.includeScheduling
      ? ([
          ["scheduling.visit.requested", "visit_staff_notice"],
          ["scheduling.visit.moved", "visit_staff_notice"],
          ["scheduling.visit.cancelled", "visit_staff_notice"],
          ["scheduling.request.expired", "visit_staff_notice"],
        ] as const)
      : []),
  ];
}

/**
 * The comms templates that count in a company's TEAM sending allowance
 * (review BO-10): the alert email and the installed packages' office
 * notices. Exported for comms-senders' renderer and the generator test.
 */
export function teamTemplateKeys(answers: Answers): readonly string[] {
  return [
    ...(answers.includeNotifications ? ["team_alert"] : []),
    ...(answers.includeEstimator ? ["estimate_lead_staff", "quote_staff_notice"] : []),
    ...(answers.includeScheduling ? ["visit_staff_notice"] : []),
  ];
}

// ---------------------------------------------------------------------------
// src/server/alerts.ts
// ---------------------------------------------------------------------------

export function renderAlerts(answers: Answers): string {
  return companiesMode(answers) ? renderAlertsCompanies(answers) : renderAlertsSingle(answers);
}

/** The pieces both variants of alerts.ts share, generated per feature set. */
function alertsShared(answers: Answers): {
  readonly packageImports: string[];
  readonly registry: string;
  readonly hrefs: string;
  readonly producers: string;
  readonly sweeps: string;
  readonly office: string;
  readonly commsFailure: string;
  readonly storageUsage: string;
  readonly delivery: string;
} {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const shell = answers.adminShell !== "none";
  const sched = answers.includeScheduling;
  const est = answers.includeEstimator;
  const inv = answers.includeInvoicing;
  const comms = answers.includeComms;
  const storage = answers.includeStorage;
  const noun = tenantLabel(answers).toLowerCase();
  const who = companies ? `the ${noun}` : "the business";

  const packageImports = [
    `import {\n  createNotifications,\n  defineAlertRegistry,\n${[
      ...(comms ? ["TEAM_ALERT_EMAIL_TEMPLATE"] : []),
      "type AlertDraft",
      ...(comms ? ["type AlertEmailDelivery", "type AlertEmailMessage", "type AlertEmailOutcome"] : []),
      "type AlertPerson",
      "type Notifications",
    ]
      .map((name) => `  ${name},`)
      .join("\n")}\n} from "${scope}/notifications";`,
    `import { notificationTables } from "${scope}/notifications/schema";`,
    ...(companies ? [`import { tenancyAlertKinds, tenancyAlertsFor, type TenancyEvent } from "${scope}/tenancy";`] : []),
    ...(sched
      ? [
          `import {\n  listExpiringRequests,\n  schedulingAlertKinds,\n  schedulingAlertsFor,\n  schedulingExpiringAlert,\n  type SchedulingEvent,\n} from "${scope}/scheduling";`,
        ]
      : []),
    ...(sched && comms ? [`import { SCHEDULING_EMAIL_TEMPLATES } from "${scope}/scheduling/comms";`] : []),
    ...(est ? [`import { estimatorAlertKinds, estimatorAlertsFor, type EstimatorEvent } from "${scope}/estimator";`] : []),
    ...(est && comms ? [`import { ESTIMATOR_EMAIL_TEMPLATES } from "${scope}/estimator/comms";`] : []),
    ...(inv ? [`import { invoicingAlertKinds, invoicingAlertsFor, invoicingCardAlert, type CardAlert, type InvoicingEvent } from "${scope}/invoicing";`] : []),
    ...(inv && comms ? [`import { INVOICE_EMAIL_TEMPLATES } from "${scope}/invoicing/comms";`] : []),
    ...(comms
      ? [`import { commsAlertKinds, commsFailureAlert, commsTemplates, deliverNow, templateLabel, type CommsFailure } from "${scope}/comms";`]
      : []),
    ...(storage ? [`import { storageAlertKinds, storageUsageAlert, type StorageUsageEvent } from "${scope}/storage";`] : []),
    ...(companies && answers.includeFeedback
      ? [`import { feedbackAlertKinds, feedbackAlertsFor, type FeedbackEvent } from "${scope}/feedback";`]
      : []),
  ];

  const fragments = alertFragments(answers);
  const registry = `/**
 * Every kind of alert this project can raise, composed ONCE from the
 * installed packages' own fragments (D3) — so each package owns its words:
 * "New estimate request: …" is written by the estimator, "… moved their
 * visit …" by scheduling, and a wording fix reaches this project by
 * \`npm update\`. A kind key is permanent: it is stored on every alert row and
 * every person's choice. Refused at load on a duplicate or malformed key.
 *
 * GENERATED: one fragment per installed package${companies ? " (tenancy's team alerts in a companies project only)" : ""}.
 */
export const ALERT_REGISTRY = defineAlertRegistry([${fragments.join(", ")}]);`;

  const hrefEntries = Object.entries(alertHrefs(answers));
  const hrefs = `/**
 * Where each alert opens (GENERATED per mode). Patterns: each \`{name}\` is
 * replaced with the URL-encoded value by the package that writes the alert,
 * so the same packages serve ${companies ? "/app/… here" : "/admin/… here"} and the other mode's paths
 * elsewhere.${!companies && !shell ? ` This project has no admin panel, so there are no staff pages to open:
 * an empty pattern is no same-site path, and the alert opens nothing.` : ""}
 */
export const ALERT_HREFS = {
${hrefEntries.map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`).join("\n")}
} as const;`;

  // The producers: one listener per installed package (13.6).
  const producerBlocks: string[] = [];
  if (sched) {
    producerBlocks.push(`
/**
 * Scheduling's events (13.6): a customer asked for, booked, moved or
 * cancelled a visit, or a request lapsed. FIRST in scheduling-notify.ts's
 * LISTENERS, before the comms listener, so the office email that follows
 * finds the rows to claim (D6). The crew on a moved or cancelled visit get
 * their own alert, linking to their day (review BO-03, BO-04).${storage ? "" : `
 *
 * No \`visitFiles\` link: this project was generated without file storage.`}
 */
export async function alertOnSchedulingEvent(event: SchedulingEvent): Promise<void> {
  try {
    const drafts = await schedulingAlertsFor(db, event, {
      hrefs: { visit: ALERT_HREFS.visit, crewDay: ALERT_HREFS.crewDay${storage ? ", visitFiles: VISIT_FILES_HREF" : ""} },
    });
    await alerts.notify(drafts);
  } catch (error) {
    reportAlertsError(error, { tenantId: event.tenantId, step: "scheduling-event" });
  }
}`);
  }
  if (est) {
    producerBlocks.push(`
/**
 * The estimator's events (13.6): a new lead, a quote accepted, declined or
 * lapsed. FIRST in estimator-notify.ts's LISTENERS, before the comms
 * listener, so the lead email finds its rows to claim — never two emails for
 * one lead (D6).
 */
export async function alertOnEstimatorEvent(event: EstimatorEvent): Promise<void> {
  try {
    await alerts.notify(estimatorAlertsFor(event, { hrefs: { estimate: ALERT_HREFS.estimate } }));
  } catch (error) {
    reportAlertsError(error, { tenantId: event.tenantId, step: "estimator-event" });
  }
}`);
  }
  if (inv) {
    producerBlocks.push(`
/**
 * Invoicing's events (13.6): a customer opened an invoice, or a payment
 * settled it. Handed to both invoicing handlers as \`onEvent\`
 * (src/server/invoicing.ts). An invoice going overdue is the cron's
 * (\`runAlertSweeps\`).
 */
export async function alertOnInvoicingEvent(event: InvoicingEvent): Promise<void> {
  try {
    await alerts.notify(invoicingAlertsFor(event, { hrefs: { invoice: ALERT_HREFS.invoice } }));
  } catch (error) {
    reportAlertsError(error, { tenantId: event.tenantId, step: "invoicing-event" });
  }
}

/**
 * Getting paid, part 1: money Stripe took that didn't land cleanly on an
 * invoice — a mismatch, an unknown payment, a cancelled invoice, an
 * overpayment — or a refund, a dispute opened or lost, a bank payment that
 * failed. To the people who answer for the books, in the bell AND by email,
 * with the amount and the payment's page in Stripe (src/server/payments-webhook.ts).
 */
export async function alertOnCardPayment(alert: CardAlert): Promise<void> {
  try {
    await alerts.notify([invoicingCardAlert(alert, { hrefs: { invoice: ALERT_HREFS.invoice } })]);
  } catch (error) {
    reportAlertsError(error, { tenantId: alert.tenantId, step: "card-payment" });
  }
}`);
  }

  if (companies && answers.includeFeedback) {
    producerBlocks.push(`
/**
 * Feedback's events (Tenancy 2b-2a): a customer sent the ${noun} something
 * new, or answered on their ticket — to everyone who can see its board.
 * Handed to the ${noun}'s intake handlers as \`onEvent\` (src/server/feedback.ts),
 * which never passes this site's own board's events.
 */
export async function alertOnFeedbackEvent(event: FeedbackEvent): Promise<void> {
  try {
    await alerts.notify(feedbackAlertsFor(event, { hrefs: { ticket: ALERT_HREFS.feedback } }));
  } catch (error) {
    reportAlertsError(error, { tenantId: event.tenantId, step: "feedback-event" });
  }
}`);
  }

  // The sweeps (D8: the time-based kinds are produced by the cron).
  const sweepSteps: string[] = [];
  if (sched) {
    sweepSteps.push(`  // Visit requests about to lapse unanswered (scheduling 9.2): made more
  // than six hours ago, with their deadline in the next 26 hours.
  for (const request of await listExpiringRequests(db, tenantId, { now })) {
    drafts.push(schedulingExpiringAlert(tenantId, request, { hrefs: { visit: ALERT_HREFS.visit } }));
  }`);
  }
  if (inv) {
    sweepSteps.push(`  // Invoices newly overdue (invoicing 11.2), in ${who}'s own zone and
  // currency. From the invoicing glue, which owns how ${who} is read —
  // reached by a DYNAMIC import${companies ? ": invoicing.ts imports company-routes, and this module must\n  // not (13.10 rule 1)" : ": invoicing.ts imports this module back (13.10 rule 3)"}.
  const { overdueInvoiceAlerts } = await import("./invoicing");
  drafts.push(...(await overdueInvoiceAlerts(tenantId, { invoiceHref: ALERT_HREFS.invoice, now })));`);
  }
  const sweeps =
    sweepSteps.length > 0
      ? `/**
 * The alerts the CLOCK raises (D8: produced by the cron from the records
 * themselves, so at least once by construction), for one ${companies ? noun : "business"}. Called by
 * the alerts cron ${companies ? `for every active ${noun}` : "for the one business"}. Every key comes from the fact (the
 * visit and its sequence, the invoice and its due date), so the cron running
 * twice alerts once. GENERATED body: one step per installed feature.
 */
export async function runAlertSweeps(tenantId: string): Promise<{ readonly alerted: number }> {
  const now = new Date();
  const drafts: AlertDraft[] = [];
${sweepSteps.join("\n")}
  const report = await alerts.notify(drafts);
  return { alerted: report.alerted };
}`
      : `/**
 * The alerts the clock raises, for one ${companies ? noun : "business"}. None: ${answers.projectName}
 * was generated without scheduling and invoicing, the two features with
 * time-based alerts (a request about to lapse, an invoice gone overdue).
 */
export async function runAlertSweeps(_tenantId: string): Promise<{ readonly alerted: number }> {
  return { alerted: 0 };
}`;

  // The office-email seams (D6, review BO-02) — with comms, which sends them.
  const office =
    comms && (sched || est)
      ? `
/**
 * WHO GETS THE OFFICE EMAIL (D6): the comms listeners of scheduling and the
 * estimator ask this, through their \`officeRecipients\` seam, instead of
 * reading the per-feature lists of 2a. It answers the addresses of the
 * people (and extra addresses) Alert settings name for whom this alert's
 * email is still OWED, claimed in the same statement — so the same event
 * handed to the listener twice claims nothing the second time: never two
 * emails for one lead. ${companies ? `The owner's copy goes to the business email in ${noun}\n * settings (review BO-01).` : "Each staff admin's copy goes to their own address."}
 *
 * Throws only when its database statement failed (AlertsUnavailableError),
 * and then the listener falls back to its \`staffEmails\` (${companies ? `the ${noun}'s inbox` : "the first administrator"}),
 * so the office still hears (review BO-02).${companies ? `
 *
 * A suspended or deleted ${noun} hears nothing (D9): its alerts were never
 * written (\`alertPeople\` answers nobody), so there is nothing to claim, no
 * email goes, and nothing is reported. A quiet skip, not "a step failed".` : ""}
 */
export async function officeRecipientsFor(notice: {
  readonly tenantId: string;
  readonly kind: string;
  readonly dedupeKey: string;
  readonly assignedUserIds: readonly string[];
}): Promise<readonly string[]> {${companies ? `
  const profile = await tenancy.companyProfile(notice.tenantId);
  // Which ${noun} this is, and whether it is active: runtime state.
  if (!profile || profile.kind !== "org" || profile.status !== "active") return [];` : ""}
  return alerts.claimEmails({
    tenantId: notice.tenantId,
    kind: notice.kind,
    dedupeKey: notice.dedupeKey,
    assignedUserIds: notice.assignedUserIds,
  });
}

/**
 * How each office email ended (D6, review BO-02): one that FAILED in a way a
 * retry could help is handed back to the alerts cron, which sends it once as
 * a team alert (the alert's title, body and link) with the same retries as
 * every other alert email. A send that timed out is never told here (it may
 * have gone; two emails are worse than a late one).
 */
export async function officeSentFor(
  notice: { readonly tenantId: string; readonly kind: string; readonly dedupeKey: string },
  result: { readonly to: string; readonly status: "sent" | "skipped" | "failed"; readonly retryable: boolean },
): Promise<void> {
  // About how THIS email ended (runtime state), not about what is installed.
  if (result.status !== "failed" || !result.retryable) return;
  await alerts.releaseClaim({ tenantId: notice.tenantId, kind: notice.kind, dedupeKey: notice.dedupeKey, to: result.to });
}`
      : "";

  const customerLists = [
    ...(sched ? [`  ...SCHEDULING_EMAIL_TEMPLATES.filter((template) => template.audience === "customer").map((template) => template.key),`] : []),
    ...(est ? [`  ...ESTIMATOR_EMAIL_TEMPLATES.filter((template) => template.audience === "customer").map((template) => template.key),`] : []),
    ...(inv ? [`  ...INVOICE_EMAIL_TEMPLATES.map((template) => template.key),`] : []),
  ];
  const commsFailure = comms
    ? `
/**
 * The emails a CUSTOMER gets, from the installed packages' own lists
 * (GENERATED: one entry per installed feature; the \`audience\` filter is a
 * runtime filter over a package's list, not a feature switch). Only these
 * raise "an email didn't go": an office notice or a team alert that failed
 * is the alerts' own retry's job, and alerting the office that the office's
 * own email failed would be a second message about the first (no loop).
 */
const CUSTOMER_TEMPLATE_KEYS: ReadonlySet<string> = new Set<string>([
${customerLists.join("\n")}
]);

/**
 * comms' \`onFailed\` (12.1): a customer's reminder, quote or invoice email
 * that FAILED FOR GOOD becomes an alert for the people who manage messages —
 * "The visit reminder email to pat@… didn't go" — while there's time to
 * call. Never emailed (\`email: false\`): the provider that refused the
 * customer's email may refuse this too. Reached from comms-senders.ts by a
 * dynamic import (13.10 rule 4).
 */
export async function alertOnCommsFailure(failure: CommsFailure): Promise<void> {
  try {
    const draft = commsFailureAlert(failure, { href: ALERT_HREFS.messages, customerTemplateKeys: CUSTOMER_TEMPLATE_KEYS });
    // Null for a template that isn't a customer's (runtime data).
    if (draft) await alerts.notify(draft);
  } catch (error) {
    reportAlertsError(error, { tenantId: failure.tenantId, step: "comms-failure" });
  }
}`
    : "";

  const filesHrefReal = !(!companies && !shell);
  const storageUsage = storage
    ? `
/**
 * Storage's \`onUsage\` (6.6, 6.15): "Your files are almost full" at 90 % (once
 * a month) and "A file couldn't be added: your storage is full" on the first
 * refusal of a day, for the people who manage files — and a refusal reported
 * to /admin/errors at most once a day per ${companies ? noun : "business"}, so the platform owner
 * sees who is out of room. Reached from files.ts by a dynamic import (13.10
 * rule 4).
 */
export async function alertOnStorageUsage(event: StorageUsageEvent): Promise<void> {
  try {
    reportStorageFull(event);
    // Who to ask for more room (reviews BO-5, BO-6): files.ts's FILES_MORE_ROOM,
    // the same words the Files screen uses.
    const draft = storageUsageAlert(event, {
      href: ALERT_HREFS.files,
      now: new Date(),
      platformName: FILES_MORE_ROOM.platformName,
      supportEmail: FILES_MORE_ROOM.supportEmail,
    });
    // Null below 90 % (runtime data).
    if (draft) await alerts.notify(${filesHrefReal ? "draft" : "{ ...draft, href: null }"});
  } catch (error) {
    reportAlertsError(error, { tenantId: event.tenantId, step: "storage-usage" });
  }
}`
    : "";

  // emailDelivery and the email seam (with comms).
  const producerRows = producerTemplates(answers);
  const delivery = comms
    ? `
/**
 * The comms template each kind's email is (D6, review BO-11): the producer
 * kinds' own office notices, and \`team_alert\` for every other kind.
 * GENERATED from the installed packages.
 */
const PRODUCER_TEMPLATES: Readonly<Record<string, string>> = {
${producerRows.map(([kind, template]) => `  ${JSON.stringify(kind)}: ${JSON.stringify(template)},`).join("\n")}
};

/** Which email a kind is, by its comms template key. */
function alertEmailTemplate(kind: string): string {
  return PRODUCER_TEMPLATES[kind] ?? TEAM_ALERT_EMAIL_TEMPLATE.key;
}

/** \`team_alert\` added for a ${companies ? noun : "business"} once per process, if absent (never over an owner's edit, 4.9). */
const teamTemplateAdded = new Set<string>();

/**
 * The team alert email (4.9), added to ${companies ? `a ${noun}'s` : "the business's"} Messages if absent —
 * never over an owner's edit, so the owner can reword it or switch it off
 * there ("Team alert"). Once per process per ${companies ? noun : "business"}.
 */
export async function ensureTeamAlertTemplate(tenantId: string): Promise<void> {
  if (teamTemplateAdded.has(tenantId)) return;
  await db
    .insert(commsTemplates)
    .values({
      tenantId,
      key: TEAM_ALERT_EMAIL_TEMPLATE.key,
      channel: "email",
      subject: TEAM_ALERT_EMAIL_TEMPLATE.subject,
      body: TEAM_ALERT_EMAIL_TEMPLATE.body,
    })
    .onConflictDoNothing({ target: [commsTemplates.tenantId, commsTemplates.key] });
  teamTemplateAdded.add(tenantId);
}

/**
 * Is email really leaving for ${who}, and if not, why (Alert settings says
 * so) — and which kinds' emails the owner switched OFF in Messages (review
 * BO-11): ONE query of ${who}'s templates that are switched off, each named
 * as Messages names it ("New lead (to your office)"). Those kinds get no
 * email copy, and Alert settings says where to turn them back on instead of
 * offering an email that would never go.
 */
async function alertEmailDelivery(tenantId: string): Promise<AlertEmailDelivery> {
  const offKinds: Record<string, string> = {};
  const templates = [...new Set(ALERT_REGISTRY.kinds.map((kind) => alertEmailTemplate(kind.key)))];
  const off = await db
    .select({ key: commsTemplates.key })
    .from(commsTemplates)
    .where(and(eq(commsTemplates.tenantId, tenantId), eq(commsTemplates.isActive, false), inArray(commsTemplates.key, templates)));
  const offKeys = new Set(off.map((row) => row.key));
  for (const kind of ALERT_REGISTRY.kinds) {
    const template = alertEmailTemplate(kind.key);
    if (offKeys.has(template)) offKinds[kind.key] = templateLabel(template);
  }
  return {
    available: commsEmailConfigured,
    offReason: commsEmailConfigured ? null : "This site doesn't send email yet, so alerts stay in the app.",
    offKinds,
  };
}`
    : "";

  return {
    packageImports,
    registry,
    hrefs,
    producers: producerBlocks.join("\n"),
    sweeps,
    office,
    commsFailure,
    storageUsage,
    delivery,
  };
}

function renderAlertsCompanies(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  const comms = answers.includeComms;
  const storage = answers.includeStorage;
  const shared = alertsShared(answers);
  const drizzle = comms ? [`import { and, eq, inArray } from "drizzle-orm";`] : [];
  const imports = [
    ...drizzle,
    ...shared.packageImports,
    `import { db } from "@/db";`,
    ...(comms ? [`import { commsEmailConfigured, commsSenders } from "@/server/comms-senders";`] : []),
    ...(comms ? [`import { companyLinksFor } from "@/server/company-links";`] : []),
    `import { reportError } from "@/server/error-reporter";`,
    ...(storage ? [`import { FILES_MORE_ROOM, reportStorageFull } from "@/server/files";`] : []),
    `import { log } from "@/server/logger";`,
    `import { tenancy } from "@/server/tenancy";`,
    ...(storage && answers.includeScheduling ? [`import { VISIT_FILES_HREF } from "@/server/visit-files";`] : []),
  ];

  const email = comms
    ? `
/**
 * One alert's email copy (D5), through comms — so it goes out AS THE
 * ${noun.toUpperCase()} (2a D8: "{${noun}}" on this site's sending address, the ${noun}'s
 * reply-to, or the customer's on a lead), is logged in the ${noun}'s
 * Messages, is held to the ${noun}'s TEAM sending allowance (never the one
 * its customers' quotes and invoices use; review BO-10), and carries
 * \`alert:{id}\` to Resend, which drops a repeat (D7).
 *
 * Links go THROUGH THE SWITCH ROUTE (2a D2), so an alert about Green Acres
 * opens in Green Acres for someone who also works in Summit. The settings
 * line is the 4.9 rule: an email-only address the owner added has no
 * sign-in, so it is told why it gets these instead.
 */
async function sendAlertEmail(message: AlertEmailMessage): Promise<AlertEmailOutcome> {
  await ensureTeamAlertTemplate(message.tenantId);
  const profile = await tenancy.companyProfile(message.tenantId);
  // A ${noun} deleted while its email waited (runtime state).
  if (!profile) return { status: "skipped", reason: "The ${noun} is no longer here." };
  const links = companyLinksFor(profile.slug);
  // The package checked the href is a same-site path (D18); the switch
  // route checks it again before it sends anyone there (safeSwitchNext).
  const open = message.href ? links.app(message.href as \`/app/\${string}\`) : null;
  const { message: logged, retryable } = await deliverNow(
    db,
    {
      tenantId: message.tenantId,
      to: message.to,
      templateKey: TEAM_ALERT_EMAIL_TEMPLATE.key,
      vars: {
        title: message.title,
        body: message.body ?? "",
        linkLine: open ? \`Open it: \${open}\` : "",
        settingsLine: message.addressOnly
          ? \`You get this because \${profile.name} added this address.\`
          : \`Change which alerts you get by email: \${links.app("/app/alerts/settings")}\`,
        businessName: profile.name,
      },
      idempotencyKey: message.idempotencyKey,
      replyTo: message.replyTo,
    },
    commsSenders,
  );
  // How the send ended (runtime state).
  if (logged.status === "sent") return { status: "sent" };
  if (logged.status === "skipped") return { status: "skipped", reason: logged.error ?? "Not sent." };
  return { status: "failed", error: logged.error ?? "The email didn't go.", retryable };
}
${shared.delivery}`
    : "";

  const instanceLines = [
    "  db,",
    "  // REQUIRED, and named (D14, review G1): the package's own tables, never",
    "  // a table of the same name somebody else made.",
    "  tables: notificationTables,",
    "  registry: ALERT_REGISTRY,",
    "  people: alertPeople,",
    `  // The owner's copies of the routed kinds go to the business email in ${noun}`,
    "  // settings while a group is on \"The owner\" (review BO-01).",
    "  ownerEmail: businessEmail,",
    ...(comms
      ? [
          "  email: sendAlertEmail,",
          "  // Resend drops a repeat of the same idempotency key (D7, review G12), so",
          "  // a copy left mid-send by a cut-off request is retried, not lost.",
          "  emailIdempotent: true,",
          "  emailDelivery: alertEmailDelivery,",
        ]
      : []),
    "  onError: (error, context) => reportAlertsError(error, context),",
  ];

  return `${imports.join("\n")}

/**
 * ALERTS FOR EVERY ${noun.toUpperCase()}, AND EVERY PERSON IN IT (Tenancy 2b-1): the bell in
 * each ${noun}'s header, each person's choice of "In the app" or "In the app and
 * by email", the ONE place the owner picks who hears about new work, and the
 * email copies — under the ${noun}'s name.
 *
 * ${scope}/notifications does the work; this module only says who THIS
 * project's people are (\`alertPeople\`: the ${noun}'s active members holding a
 * permission NOW — its own roles decide), where things open, and how an
 * email leaves (comms${comms ? "" : " — not installed here, so alerts stay in the app"}). Every installed package's producer is glued
 * below, and each package wrote its own words (D3).
 *
 * IMPORT ORDER (13.10): this module never imports company-routes (rule 1);
 * every use of another glue module happens inside a function (rule 3).
 * Its handler builder is alerts-routes.ts.
 */

${shared.registry}

${shared.hrefs}

/**
 * Who in a ${noun} may get an alert of a kind: its ACTIVE members holding the
 * kind's permission right now (D4) — the same three queries for a team of 3
 * or 30. A suspended, deleted or unknown ${noun} (or a personal workspace)
 * hears nothing, so nothing is written or emailed for it (D9). The owner is
 * who a routing group falls back to while nobody is chosen.
 */
async function alertPeople(tenantId: string, permission: string): Promise<readonly AlertPerson[]> {
  const profile = await tenancy.companyProfile(tenantId);
  // Which ${noun} this is, and whether it is active: runtime state.
  if (!profile || profile.kind !== "org" || profile.status !== "active") return [];
  const people = await tenancy.listMemberPeople(tenantId, { holding: permission });
  return people.map((person) => ({
    userId: person.userId,
    name: person.name,
    email: person.email,
    isOwner: person.roleKey === "owner",
  }));
}

/**
 * Where the owner's copies of new work go while a group is on "The owner"
 * (review BO-01): the business email in ${noun} settings (2a D8's inbox), else
 * the owner's own address. So a ${noun} whose office reads office@… keeps
 * getting its leads there with zero setup, and Alert settings says so.
 */
async function businessEmail(tenantId: string): Promise<string | null> {
  return (await tenancy.companyProfile(tenantId))?.inbox[0] ?? null;
}

/** Every alert step that failed: the log, and /admin/errors with the ${noun} it happened to. */
export function reportAlertsError(
  error: unknown,
  context: { readonly tenantId: string | null; readonly kind?: string; readonly step?: string; readonly route?: string },
): void {
  log.error({ err: error, ...context }, "alerts: a step failed");
  void reportError({
    error,
    source: "route",
    tenantId: context.tenantId,
    context: { feature: "alerts", step: context.step ?? context.route ?? "alerts", ...(context.kind ? { kind: context.kind } : {}) },
  });
}
${email}

/**
 * THE ALERTS: one instance for every ${noun}. Every read, mark and delete names
 * the ${noun} AND the person (the package's rule); every alert is keyed by the
 * fact it reports (D7), so a retried request, an event handed over twice or a
 * cron that runs again never alerts twice.
 */
export const alerts: Notifications = createNotifications({
${instanceLines.join("\n")}
});

/**
 * Tenancy's events (13.6), from company-setup.ts's \`onCompanyEvent\`: a
 * teammate joined, left or was removed — and the housekeeping that follows
 * (D9): someone removed or gone has their alerts, choices and places on the
 * routing lists in this ${noun} forgotten; someone whose role changed loses
 * the alerts they can no longer get (review G4: reads are filtered by what
 * the reader holds NOW anyway, so this is housekeeping, not the guard).
 */
export async function alertOnTenancyEvent(event: TenancyEvent): Promise<void> {
  try {
    await alerts.notify(tenancyAlertsFor(event, { teamHref: ALERT_HREFS.team }));
    // Which EVENT arrived — runtime state, not a feature switch.
    if (event.type === "member.removed" || event.type === "member.left") {
      await alerts.forget({ tenantId: event.tenantId, userId: event.userId });
    } else if (event.type === "member.role.changed") {
      await alerts.prune({ tenantId: event.tenantId, userId: event.userId, permissions: await permissionsHeld(event.tenantId, event.userId) });
    }
  } catch (error) {
    reportAlertsError(error, { tenantId: event.tenantId, step: "tenancy-event" });
  }
}

/** The registry's permissions this person holds in this ${noun} NOW (for \`prune\`). */
async function permissionsHeld(tenantId: string, userId: string): Promise<string[]> {
  const held: string[] = [];
  for (const permission of ALERT_REGISTRY.permissions) {
    const people = await tenancy.listMemberPeople(tenantId, { holding: permission });
    if (people.some((person) => person.userId === userId)) held.push(permission);
  }
  return held;
}
${shared.producers}${shared.office}${shared.commsFailure}${shared.storageUsage}

${shared.sweeps}
`;
}

function renderAlertsSingle(answers: Answers): string {
  const scope = answers.scope;
  const comms = answers.includeComms;
  const storage = answers.includeStorage;
  const shell = answers.adminShell !== "none";
  const shared = alertsShared(answers);
  const staffMaps = [
    ...(answers.includeScheduling ? [["SCHEDULING_STAFF_KEYS", "./scheduling-staff"]] : []),
    ...(answers.includeEstimator ? [["ESTIMATOR_STAFF_KEYS", "./estimator-staff"]] : []),
    ...(answers.includeInvoicing ? [["INVOICING_STAFF_KEYS", "./invoicing"]] : []),
    ...(comms ? [["COMMS_STAFF_KEYS", "./comms"]] : []),
    ...(storage ? [["FILES_STAFF_KEYS", "./files"]] : []),
  ] as const;
  const drizzle = comms ? ["and", "eq", "inArray", "isNull"] : ["and", "eq", "isNull"];
  const imports = [
    `import { ${drizzle.join(", ")} } from "drizzle-orm";`,
    `import { users } from "${scope}/auth/schema";`,
    ...shared.packageImports,
    `import { FIRM_WIDE } from "${scope}/permissions";`,
    `import { principalRole, roleTemplate } from "${scope}/permissions/schema";`,
    `import { db } from "@/db";`,
    ...(comms ? [`import { env } from "@/env";`] : []),
    ...(comms ? [`import { SITE_NAME } from "@/seo";`] : []),
    ...(comms ? [`import { commsEmailConfigured, commsSenders } from "@/server/comms-senders";`] : []),
    `import { reportError } from "@/server/error-reporter";`,
    ...(storage ? [`import { FILES_MORE_ROOM, reportStorageFull } from "@/server/files";`] : []),
    `import { log } from "@/server/logger";`,
    `import { loadStaffPermissions } from "@/server/permissions";`,
    ...(storage && answers.includeScheduling ? [`import { VISIT_FILES_HREF } from "@/server/visit-files";`] : []),
  ];

  // One dynamic import per installed feature's staff keys, and their spread.
  const loads = staffMaps.map(([, from]) => `import("${from}")`);
  const spread = [...staffMaps.map(([name], i) => `...m${i}.${name}`), "...ALERTS_STAFF_KEYS"];
  const names = staffMaps.map((_, i) => `m${i}`);

  const alertsPage = shell ? `"/admin/alerts"` : "null";
  const settingsPage = shell ? `"/admin/alerts/settings"` : "null";
  const email = comms
    ? `
/** This deployment's own address, with the slash \`new URL\` needs. */
function appBase(): string {
  const app = env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return app.endsWith("/") ? app : \`\${app}/\`;
}

/**
 * A path on this site, absolute — ONLY when it resolves to this site's own
 * origin (review G15); otherwise ${shell ? "the Alerts page" : "nothing"}. The package already
 * refused a path that isn't same-site; this is the belt to its braces.
 */
function siteLink(path: string | null): string | null {
  const base = new URL(appBase());
  const fallback = ${alertsPage};
  const target = path ?? fallback;
  if (target === null) return null;
  const url = new URL(target, base);
  return url.origin === base.origin ? url.toString() : fallback === null ? null : new URL(fallback, base).toString();
}

/**
 * One alert's email copy (D5), through comms: from this site's name and
 * sending address, logged in Messages (/admin/comms), carrying \`alert:{id}\`
 * to Resend, which drops a repeat (D7). The settings line is the 4.9 rule:
 * an email-only address has no sign-in, so it is told why it gets these.
 */
async function sendAlertEmail(message: AlertEmailMessage): Promise<AlertEmailOutcome> {
  await ensureTeamAlertTemplate(message.tenantId);
  const open = siteLink(message.href);
  const settings = siteLink(${settingsPage});
  const { message: logged, retryable } = await deliverNow(
    db,
    {
      tenantId: message.tenantId,
      to: message.to,
      templateKey: TEAM_ALERT_EMAIL_TEMPLATE.key,
      vars: {
        title: message.title,
        body: message.body ?? "",
        linkLine: open ? \`Open it: \${open}\` : "",
        settingsLine: message.addressOnly
          ? \`You get this because \${SITE_NAME} added this address.\`
          : settings
            ? \`Change which alerts you get by email: \${settings}\`
            : "",
        businessName: SITE_NAME,
      },
      idempotencyKey: message.idempotencyKey,
      replyTo: message.replyTo,
    },
    commsSenders,
  );
  // How the send ended (runtime state).
  if (logged.status === "sent") return { status: "sent" };
  if (logged.status === "skipped") return { status: "skipped", reason: logged.error ?? "Not sent." };
  return { status: "failed", error: logged.error ?? "The email didn't go.", retryable };
}
${shared.delivery}`
    : "";

  const instanceLines = [
    "  db,",
    "  // REQUIRED, and named (D14, review G1): the package's own tables, never",
    "  // a table of the same name somebody else made.",
    "  tables: notificationTables,",
    "  registry: ALERT_REGISTRY,",
    "  people: alertPeople,",
    ...(comms
      ? [
          "  email: sendAlertEmail,",
          "  // Resend drops a repeat of the same idempotency key (D7, review G12).",
          "  emailIdempotent: true,",
          "  emailDelivery: alertEmailDelivery,",
        ]
      : []),
    "  onError: (error, context) => reportAlertsError(error, context),",
  ];

  return `${imports.join("\n")}

/**
 * ALERTS FOR THIS BUSINESS'S STAFF (Tenancy 2b-1): the bell in the header,
 * each person's choice of "In the app" or "In the app and by email"${shell ? ", the\n * one place the owner picks who hears about new work (/admin/alerts/settings)," : ","} and the email copies.
 *
 * ${scope}/notifications does the work; this module says who THIS
 * project's people are — the site's staff, each package permission mapped
 * to one staff key (\`alertsStaffKeys\`) — where things open, and how an
 * email leaves (comms${comms ? "" : " — not installed here, so alerts stay in the app"}).
 *
 * IMPORT ORDER (13.10): every use of another glue module happens inside a
 * function (rule 3) — comms.ts and invoicing.ts import this module back.
 */

/**
 * The one business every alert row is written for — "primary", the id the
 * rest of the field-service features use, so its alerts and its Messages are
 * one business.
 */
export const ALERTS_TENANT = "primary";

/**
 * The staff key each alerts permission is checked against: ONE KEY PER JOB
 * (2a D12). Declared in src/permissions/catalog.ts with the roles that hold
 * them.
 *
 *   staff.alerts.view     get your own alerts, and choose how
 *   staff.alerts.manage   choose who hears about new work
 */
export const ALERTS_STAFF_KEYS: Readonly<Record<string, string>> = {
  "alerts.view": "staff.alerts.view",
  "alerts.manage": "staff.alerts.manage",
};

let staffKeys: Promise<Readonly<Record<string, string>>> | null = null;

/**
 * Every package permission an alert or a screen asks, mapped to the staff
 * key that holds it: GENERATED, the spread of each installed feature's own
 * staff keys. A permission with no mapping holds nobody.
 *
 * Read on first use by DYNAMIC imports (13.10 rule 4), never at load:
 * comms.ts reaches the listeners (comms-hooks.ts reads them at its top
 * level), and the listeners reach this module, so a static import of
 * comms.ts or invoicing.ts here closes a loop that leaves one of them
 * half-initialised — a production build fails on it.
 */
export function alertsStaffKeys(): Promise<Readonly<Record<string, string>>> {
  staffKeys ??= Promise.all([${loads.join(", ")}]).then(([${names.join(", ")}]) => ({ ${spread.join(", ")} }));
  return staffKeys;
}

${shared.registry}

${shared.hrefs}

interface StaffPerson {
  readonly userId: string;
  readonly name: string | null;
  readonly email: string | null;
  /** Holds the staff admin template: the "owner" a routing group falls back to (D15). */
  readonly isAdmin: boolean;
}

/** Everyone holding a FIRM-WIDE staff role (not a deleted account): this site's staff. */
async function staffPeople(): Promise<StaffPerson[]> {
  const rows = await db
    .select({ userId: principalRole.principalId, template: roleTemplate.key, name: users.displayName, email: users.email })
    .from(principalRole)
    .innerJoin(roleTemplate, eq(roleTemplate.id, principalRole.templateId))
    .innerJoin(users, eq(users.id, principalRole.principalId))
    .where(and(eq(principalRole.scope, "staff"), eq(principalRole.tenantId, FIRM_WIDE), isNull(users.deletedAt)));
  const people = new Map<string, StaffPerson>();
  for (const row of rows) {
    const known = people.get(row.userId);
    people.set(row.userId, {
      userId: row.userId,
      name: row.name,
      email: row.email,
      isAdmin: (known?.isAdmin ?? false) || row.template === "admin",
    });
  }
  return [...people.values()];
}

/**
 * Who may get an alert of a kind: the site's staff whose staff permissions,
 * resolved from this project's own tables, hold the staff key the kind's
 * permission maps to (D15). The routing groups' "owner" is every staff
 * admin; with no admin holding it, everyone who does (the package's rule,
 * review G13).
 */
async function alertPeople(tenantId: string, permission: string): Promise<readonly AlertPerson[]> {
  // Runtime data: only the one business exists, and an unmapped permission holds nobody.
  if (tenantId !== ALERTS_TENANT) return [];
  const key = (await alertsStaffKeys())[permission];
  if (!key) return [];
  const out: AlertPerson[] = [];
  for (const person of await staffPeople()) {
    const can = await loadStaffPermissions({ principal: { userId: person.userId } });
    if (can?.can(key)) out.push({ userId: person.userId, name: person.name, email: person.email, isOwner: person.isAdmin });
  }
  return out;
}

/** Every alert step that failed: the log, and /admin/errors. */
export function reportAlertsError(
  error: unknown,
  context: { readonly tenantId: string | null; readonly kind?: string; readonly step?: string; readonly route?: string },
): void {
  log.error({ err: error, ...context }, "alerts: a step failed");
  void reportError({
    error,
    source: "route",
    tenantId: context.tenantId,
    context: { feature: "alerts", step: context.step ?? context.route ?? "alerts", ...(context.kind ? { kind: context.kind } : {}) },
  });
}
${email}

/**
 * THE ALERTS, for the one business. Every read, mark and delete names the
 * business AND the person; every alert is keyed by the fact it reports (D7),
 * so a retried request or a cron that runs again never alerts twice.
 */
export const alerts: Notifications = createNotifications({
${instanceLines.join("\n")}
});
${shared.producers}${shared.office}${shared.commsFailure}${shared.storageUsage}

${shared.sweeps}
`;
}

// ---------------------------------------------------------------------------
// src/server/alerts-routes.ts
// ---------------------------------------------------------------------------

export function renderAlertsRoutes(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  if (companiesMode(answers)) {
    const messages = answers.includeComms ? `"/app/messages"` : "null";
    return `import { createNotificationHandlers, type NotificationsAuditEvent } from "${scope}/notifications";
import { auditEntry } from "${scope}/observability";
import { auditLog } from "${scope}/observability/schema";
import { db } from "@/db";
import { alerts, reportAlertsError } from "@/server/alerts";
import { auditRegistry } from "@/server/audit";
import { companyAuthorizer, companyRoutes, type FeatureHandlerOverrides } from "@/server/company-routes";
import { requestContext } from "@/server/request-context";
import { tenancy } from "@/server/tenancy";

/**
 * The alerts routes of every ${noun}: what the bell, /app/alerts and Alert
 * settings talk to, at /api/app/{${noun} id}/alerts. Its own module so
 * alerts.ts never imports company-routes (13.10 rule 1); only route files
 * and tests import this one.
 *
 * THE ${noun.toUpperCase()} IS THE ONE IN THE PATH, asked on every call: signed in → a
 * member → not suspended → holds \`alerts.view\` (\`alerts.manage\` for who
 * hears about new work). Then the package asks once more per permission the
 * alerts name, so a person sees only the alerts they may get NOW (D2) — a
 * member demoted to Crew stops seeing the old leads on their next poll.
 */

/** How long a ${noun}'s web address is remembered for the alerts' links. A rename shows within a minute. */
const SLUG_TTL_MS = 60_000;

/**
 * Each alert's link, THROUGH THE SWITCH ROUTE (review G16): an alert of Green
 * Acres opens IN Green Acres even if another tab switched to Summit. The
 * path form of companyLinksFor(slug).app(href) — /app/switch/{web
 * address}?next=… — which the switch route checks again (safeSwitchNext).
 * The web address is read once per ${noun} a minute, not once per alert.
 */
function switchHrefs(): (tenantId: string, href: string) => Promise<string> {
  const slugs = new Map<string, { readonly slug: string | null; readonly at: number }>();
  return async (tenantId, href) => {
    let known = slugs.get(tenantId);
    if (!known || Date.now() - known.at > SLUG_TTL_MS) {
      known = { slug: (await tenancy.companyProfile(tenantId))?.slug ?? null, at: Date.now() };
      slugs.set(tenantId, known);
    }
    // A ${noun} that is gone has no switch to go through (runtime state).
    if (known.slug === null) return href;
    return \`/app/switch/\${encodeURIComponent(known.slug)}?\${new URLSearchParams({ next: href }).toString()}\`;
  };
}

/**
 * Who hears about new work, in the audit log (review SEC-04): every saved
 * list in Alert settings is a row ("Changed who hears about new work"), and
 * an outside address starting to get the ${noun}'s leads is its own row,
 * marked sensitive ("Added an outside email address to an alert list"):
 * from then on that address gets every lead's name, phone and address.
 */
export async function auditAlertRouting(event: NotificationsAuditEvent): Promise<void> {
  await db.insert(auditLog).values(
    auditEntry(auditRegistry, {
      action: event.action,
      actor: { userId: event.actorUserId },
      scope: "tenant",
      tenantId: event.tenantId,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      request: await requestContext(),
      metadata: { ...event.metadata },
    }),
  );
}

/** \`overrides.principal\` is how the project's isolation proof calls it as somebody else. */
export function buildAlertsHandlers(overrides: FeatureHandlerOverrides = {}) {
  return createNotificationHandlers({
    notifications: alerts,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer(overrides),
    links: { inbox: "/app/alerts", settings: "/app/alerts/settings", messages: ${messages} },
    hrefFor: switchHrefs(),
    audit: auditAlertRouting,
    onError: (error, context) => reportAlertsError(error, { tenantId: context.tenantId, route: context.route }),
  });
}
`;
  }
  const shell = answers.adminShell !== "none";
  // CONTRACT: 13.5 names the single business's messages link
  // "/admin/messages"; the Messages console of a single business has always
  // lived at /admin/comms (the comms-admin overlay), so the link goes there.
  const links = shell
    ? `{ inbox: "/admin/alerts", settings: "/admin/alerts/settings", messages: ${answers.includeComms ? `"/admin/comms"` : "null"} }`
    : `{ inbox: null, settings: null, messages: null }`;
  return `import { createNotificationHandlers, type NotificationsAuditEvent } from "${scope}/notifications";
import { auditEntry } from "${scope}/observability";
import { auditLog } from "${scope}/observability/schema";
import { db } from "@/db";
import { ALERTS_TENANT, alerts, alertsStaffKeys, reportAlertsError } from "@/server/alerts";
import { auditRegistry } from "@/server/audit";
import { requestContext } from "@/server/request-context";
import { authorizeStaffFor } from "@/server/staff-access";

/**
 * The alerts routes of this business: what the bell${shell ? ", /admin/alerts and Alert\n * settings talk" : " talks"} to, at /api/admin/alerts.
 *
 * Behind this project's own sign-in and staff keys: \`staff.alerts.view\`
 * to get your own alerts, \`staff.alerts.manage\` to choose who hears about
 * new work — then the package asks once more per permission the alerts name,
 * so a person sees only the alerts they may get NOW (D2).${shell ? "" : `
 *
 * This project has no admin panel, so the bell links to no alerts page and
 * no settings: each person's alerts come in the app, and the office emails
 * keep 2a's lists.`}
 */
/**
 * Who hears about new work, in the audit log (review SEC-04): every saved
 * list in Alert settings is a row, and an outside address starting to get
 * the business's leads is its own row, marked sensitive: from then on that
 * address gets every lead's name, phone and address. Staff scope, like the
 * other staff decisions of a single business.
 */
export async function auditAlertRouting(event: NotificationsAuditEvent): Promise<void> {
  await db.insert(auditLog).values(
    auditEntry(auditRegistry, {
      action: event.action,
      actor: { userId: event.actorUserId },
      scope: "staff",
      tenantId: null,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      request: await requestContext(),
      metadata: { ...event.metadata },
    }),
  );
}

export function buildAlertsHandlers() {
  return createNotificationHandlers({
    notifications: alerts,
    tenantId: ALERTS_TENANT,
    // The staff keys are read once, on the first request (13.10 rule 4).
    authorize: async (req, permission, tenantId) =>
      authorizeStaffFor(await alertsStaffKeys(), "Sign in to see your alerts.")(req, permission, tenantId),
    links: ${links},
    audit: auditAlertRouting,
    onError: (error, context) => reportAlertsError(error, { tenantId: context.tenantId, route: context.route }),
  });
}
`;
}

// ---------------------------------------------------------------------------
// app/api/cron/alerts/route.ts
// ---------------------------------------------------------------------------

export function renderAlertsCron(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  const sweeps = companies
    ? `  // 1. The alerts the clock raises, for EVERY ACTIVE ${noun.toUpperCase()} (D10): a request about
  //    to lapse, an invoice gone overdue. One ${noun}'s failure is reported in
  //    \`failed\` and the rest still run; the starting ${noun} differs every run.
  const sweeps = await runForEachCompany(tenancy, (tenantId) => runAlertSweeps(tenantId), {
    timeBudgetMs: 30_000,
    onError: (error, tenantId) => log.error({ err: error, tenantId }, "alerts cron: a ${noun}'s sweep failed"),
  });
  reportStopped(sweeps.deferred.length > 0, \`\${sweeps.deferred.length} of the ${tenantLabelPlural(answers).toLowerCase()} weren't reached\`);

  // 2. Alert emails a request couldn't send (or an office email that
  //    failed), retried — ONLY for the active ${noun}s (D9, review G3), each
  //    recipient checked again first, the ${noun}s taking turns (BO-14).
  const emails = await alerts.deliverPendingEmails({
    tenantIds: await tenancy.activeCompanyIds(),
    limit: 1000,
    timeBudgetMs: 15_000,
  });`
    : `  // 1. The alerts the clock raises for the business: a request about to
  //    lapse, an invoice gone overdue.
  const sweeps = await runAlertSweeps(ALERTS_TENANT);

  // 2. Alert emails a request couldn't send (or an office email that
  //    failed), retried — each recipient checked again first (D9, review G3).
  const emails = await alerts.deliverPendingEmails({
    tenantIds: [ALERTS_TENANT],
    limit: 1000,
    timeBudgetMs: 15_000,
  });`;
  return `import { NextResponse } from "next/server";
${companies ? `import { runForEachCompany } from "${scope}/tenancy/server";\n` : ""}import { env } from "@/env";
import { ${companies ? "alerts, runAlertSweeps" : "ALERTS_TENANT, alerts, runAlertSweeps"} } from "@/server/alerts";
import { reportError } from "@/server/error-reporter";
import { log } from "@/server/logger";${companies ? `\nimport { tenancy } from "@/server/tenancy";` : ""}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The platform kills the function at this limit; the three steps below stop
// well before it (their own time budgets), so a busy day ends cleanly and the
// next run picks up the rest.
export const maxDuration = 60;

/**
 * The alerts cron (Tenancy 2b-1, 13.8), three steps:
 *
 *   1. the time-based alerts (D8: produced from the records, so at least once
 *      by construction; keyed by the fact, so a second run alerts nobody);
 *   2. the email copies still owed, retried (claim, attempts, backoff; given
 *      up after 26 hours), each recipient re-checked before the send;
 *   3. clean-up: read alerts older than 30 days, and any older than 180.
 *
 * SCHEDULED IN vercel.json, once a day (Vercel Hobby), so an alert email that
 * failed in its request is retried the next day; point any scheduler at this
 * route every 15 minutes for retries within the hour (DEPLOYMENT.md). Vercel
 * Cron sends \`Authorization: Bearer $CRON_SECRET\`; anything else can send
 * \`x-cron-secret\`. Refuses every call while CRON_SECRET is unset.
 */
async function handle(request: Request): Promise<Response> {
  const secret = env.CRON_SECRET;
  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\\s+/i, "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
${sweeps}
  reportStopped(emails.stoppedEarly, "alert emails were left for the next run (the time budget ran out)");

  // 3. Clean-up, in batches, within its own budget.
  const cleanup = await alerts.cleanup({ timeBudgetMs: 5_000 });

  return NextResponse.json({ sweeps, emails, cleanup });
}

/** A run that ran out of time: logged and reported to /admin/errors, so a platform outgrowing its daily run is noticed. */
function reportStopped(stopped: boolean, what: string): void {
  // About this run (runtime state).
  if (!stopped) return;
  log.error({ cron: "alerts" }, \`alerts cron: \${what}\`);
  void reportError({
    error: new Error(\`The alerts cron ran out of time: \${what}. Run it more often (DEPLOYMENT.md).\`),
    source: "route",
    tenantId: null,
    context: { feature: "alerts", route: "cron:alerts" },
  });
}

export const GET = handle;
export const POST = handle;
`;
}

// ---------------------------------------------------------------------------
// src/server/files.ts
// ---------------------------------------------------------------------------

/** The record types files can belong to, per installed feature and mode. */
function fileRecordEntries(answers: Answers): string[] {
  const companies = companiesMode(answers);
  return [
    ...(answers.includeScheduling
      ? [`      ...schedulingFileRecords(db, { visitHref: ${JSON.stringify(companies ? "/app/schedule?date={date}&visit={id}" : "/admin/schedule?date={date}&visit={id}")} }),`]
      : []),
    ...(answers.includeEstimator
      ? [`      ...estimatorFileRecords(db, { estimateHref: ${JSON.stringify(companies ? "/app/estimates/{id}" : "/admin/estimates/{id}")} }),`]
      : []),
    ...(answers.includeInvoicing
      ? [`      ...invoicingFileRecords(db, { invoiceHref: ${JSON.stringify(companies ? "/app/invoices/{id}" : "/admin/invoices/{id}")} }),`]
      : []),
    // Tenancy 2b-2a review (M3): a company's feedback ticket keeps its
    // screenshots privately, and the ticket's permissions decide who opens
    // them. Companies only: this site's own board isn't a company's.
    ...(companies && answers.includeFeedback
      ? [`      ...feedbackFileRecords(db, { ticketHref: "/app/feedback?ticket={id}" }),`]
      : []),
  ];
}

/** True when a company's feedback screenshots are kept privately in this project (review M3). */
export function privateFeedbackScreenshots(answers: Answers): boolean {
  return companiesMode(answers) && answers.includeFeedback && answers.includeStorage;
}

/**
 * `src/server/files.ts`. CONTRACT: 13.5's FILES_MOVE_TO_PRIVATE is
 * ["estimator.photo"] or []; 0.1's library files ("library.file") join it in
 * every variant (review BUY-04), and the module also answers /setup's
 * still-public count and its hour-long private check (reviews BUY-05, BUY-06).
 */
export function renderFiles(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  const notifications = answers.includeNotifications;
  const est = answers.includeEstimator;
  const records = fileRecordEntries(answers);
  const imports = [
    `import { createHmac } from "node:crypto";`,
    `import { and, count, eq, inArray, isNull } from "drizzle-orm";`,
    `import { del, get, head, put, type DeleteCommandOptions, type GetCommandOptions, type PutCommandOptions } from "@vercel/blob";`,
    `import {\n  createStorage,\n  formatBytes,\n  STORAGE_BUILT_IN_PURPOSES,\n  type BlobStore,\n  type Storage,\n  type StorageLogoStore,\n  type StoragePurposeStore,\n  type StorageSigningOptions,\n  type StorageUsageEvent,\n} from "${scope}/storage";`,
    `import { createLocalDiskStore } from "${scope}/storage/local";`,
    `import { storageTables } from "${scope}/storage/schema";`,
    `import { createVercelBlobStore, type VercelBlobSdk } from "${scope}/storage/vercel-blob";`,
    ...(est ? [`import { estimatorFileRecords, estimatorPhotoPurpose, estimatorStaffPhotoPurpose } from "${scope}/estimator";`] : []),
    ...(answers.includeInvoicing ? [`import { invoicingFileRecords } from "${scope}/invoicing";`] : []),
    ...(answers.includeScheduling ? [`import { schedulingFileRecords } from "${scope}/scheduling";`] : []),
    ...(companies && answers.includeFeedback ? [`import { feedbackFileRecords, feedbackScreenshotPurpose } from "${scope}/feedback";`] : []),
    ...(answers.includeStore ? [`import { STORE_PHOTO_PURPOSE } from "${scope}/commerce/store";`] : []),
    `import { db } from "@/db";`,
    `import { env } from "@/env";`,
    ...(companies ? [`import { SITE_NAME } from "@/seo";`] : []),
    `import { reportError } from "./error-reporter";`,
    `import { log } from "./logger";`,
    `import { storageAllowanceBytes } from "./plan-gate";`,
  ];

  const stillValid = companies
    ? `/**
 * Every open of a signed link asks this (review G2): is the ${noun} still
 * active, is the person who made the link still an active member of it — the
 * same verdict the ${noun}'s screens get from the membership gate — AND may
 * they still open THIS file (review SEC-03): \`mayView\` runs the file's own
 * rule again (its record's permissions and, for a crew, the assignment) with
 * what the maker holds in the ${noun} NOW. So a removed member's copied link,
 * a demoted member's, a crew member's once the visit moves to another crew,
 * and every link of a suspended ${noun}, stop working on the next open.
 *
 * tenancy is reached by a DYNAMIC import, inside the function (13.10 rules 2
 * and 4): tenancy.ts imports this module at load (the logo store), so a
 * static import here would read it half-initialised.
 */
const memberStillValid: FileLinkStillValid = async ({ tenantId, userId, mayView }) => {
  const { tenancy } = await import("./tenancy");
  const profile = await tenancy.companyProfile(tenantId);
  // Runtime state: a suspended or deleted ${noun}'s links stop.
  if (profile?.status !== "active") return false;
  if ((await tenancy.membership({ userId, tenantId })) !== "member") return false;
  return mayView((permission) => tenancy.hasPermission({ userId, tenantId, permission }));
};`
    : `/**
 * Every open of a signed link asks this (review G2): does the person who made
 * it still hold a firm-wide staff role here — AND may they still open THIS
 * file (review SEC-03)? \`mayView\` runs the file's own rule again (its
 * record's permissions and, for a crew, the assignment) with the staff keys
 * the maker holds NOW, each package permission mapped to its staff key as
 * the files routes map it. So a removed staff member's copied link, a
 * demoted one's, and a crew member's once the visit moves to another crew,
 * stop working on the next open. The permission loader and the key map are
 * reached by DYNAMIC imports inside the function (13.10 rules 2 and 4).
 */
const memberStillValid: FileLinkStillValid = async ({ tenantId, userId, mayView }) => {
  // Runtime data: only the one business exists.
  if (tenantId !== FILES_TENANT) return false;
  const { loadStaffPermissions } = await import("./permissions");
  const can = await loadStaffPermissions({ principal: { userId } });
  if (can === null) return false;
  const { filesStaffKeyFor } = await import("./files-routes");
  const keys = filesStaffKeyFor();
  return mayView((permission) => {
    const key = keys[permission];
    // A permission with no staff key holds nobody (runtime data).
    return key !== undefined && can.can(key);
  });
};`;

  const content = companies
    ? `(tenantId, fileId) => \`/api/app/\${encodeURIComponent(tenantId)}/files/v1/admin/files/\${encodeURIComponent(fileId)}/content\``
    : `(_tenantId, fileId) => \`/api/admin/files/v1/admin/files/\${encodeURIComponent(fileId)}/content\``;

  const onUsage = notifications
    ? `    // The "Files" alerts (almost full, full) and the once-a-day report of a
    // refusal. DYNAMIC on purpose (13.10 rule 4): alerts.ts imports this
    // module back.
    onUsage: (event) => import("./alerts").then((m) => m.alertOnStorageUsage(event)),`
    : `    // No alerts here (generated without --notifications): a refusal is
    // still reported to /admin/errors, at most once a day per ${companies ? noun : "business"}.
    onUsage: (event) => reportStorageFull(event),`;

  const single = companies
    ? ""
    : `
/**
 * The one business every file row is written for — "primary", the id the
 * rest of the field-service features use.
 */
export const FILES_TENANT = "primary";

/**
 * The staff key each files permission is checked against: ONE KEY PER JOB
 * (2a D12). Declared in src/permissions/catalog.ts with the roles that hold
 * them.
 *
 *   staff.files.view     the business's own files, and how much room is used
 *   staff.files.manage   add files, and delete any file
 */
export const FILES_STAFF_KEYS: Readonly<Record<string, string>> = {
  "files.view": "staff.files.view",
  "files.manage": "staff.files.manage",
};
`;

  return `${imports.join("\n")}

/**
 * PHOTOS AND FILES (Tenancy 2b-1): ${companies ? `each ${noun}'s own files, private by default` : "the business's files, private by default"}
 * (D10) — on its visits, estimates and invoices, the customer's estimate
 * photo kept privately with its estimate, the logo the one public file, and
 * the Files screen's "Using X of Y" against ${companies ? `a per-${noun}` : "an"} allowance.
 *
 * ${scope}/storage does the work: every read, list and delete names the
 * ${companies ? noun : "business"}; the record a file is on decides who sees it (D12); the type
 * comes from the bytes; the allowance is checked under a lock; deleting
 * removes the stored object from the store it is in; a private file is only
 * ever streamed by this site's own routes. This module chooses the stores and
 * says what this project's records and rules are.
 *
 * IMPORT ORDER (13.10): tenancy.ts imports this module at load (the logo
 * store), so this module imports nothing that imports tenancy.ts (rule 2),
 * never imports company-routes (rule 1), and reaches tenancy and alerts only
 * by dynamic imports inside functions (rule 4).
 */
${single}
/**
 * @vercel/blob's four calls, as the storage package's adapter takes them. The
 * adapter builds every options object itself (\`{ access, token, … }\`), so
 * each call gets exactly what @vercel/blob expects; only the declared shapes
 * differ, because the package names them loosely so it needn't depend on
 * @vercel/blob.
 *
 * CONTRACT: 13.5 passes the namespace (\`sdk: vercelBlob\`). Against
 * @vercel/blob 2.8 that doesn't typecheck: the package's VercelBlobSdk types
 * every options argument \`Record<string, unknown>\`, which \`put\`'s
 * PutCommandOptions (it requires \`access\`) doesn't accept, and \`get\`
 * may answer a 304 with no stream. This bridge is the narrowest fix here.
 */
const blobSdk: VercelBlobSdk = {
  put: (pathname, body, options) => put(pathname, body, options as unknown as PutCommandOptions),
  get: async (pathname, options) => {
    const found = await get(pathname, options as unknown as GetCommandOptions);
    // A 304 has no body; the adapter never asks for one (no ifNoneMatch), so
    // this is only the type's other case (runtime data).
    if (!found || !found.stream) return null;
    return { stream: found.stream, blob: { contentType: found.blob.contentType, size: found.blob.size } };
  },
  head: (pathname, options) => head(pathname, options as Parameters<typeof head>[1]),
  del: (pathname, options) => del(pathname, options as DeleteCommandOptions),
};

/**
 * PRIVATE FILES (D10): a PRIVATE Vercel Blob store, its own token. A Vercel
 * Blob store is private or public as a whole, so photos and files need a
 * second store; the env check refuses a token equal to the public store's
 * (13.7, review G9), and the adapter refuses to keep a file in a store that
 * answers with a public address.
 */
const privateBlob = env.BLOB_PRIVATE_READ_WRITE_TOKEN
  ? createVercelBlobStore({ sdk: blobSdk, token: env.BLOB_PRIVATE_READ_WRITE_TOKEN, access: "private" })
  : undefined;

/** PUBLIC FILES (the logo): the project's existing public Blob store, under an unguessable key. */
const publicBlob = env.BLOB_READ_WRITE_TOKEN
  ? createVercelBlobStore({ sdk: blobSdk, token: env.BLOB_READ_WRITE_TOKEN, access: "public" })
  : undefined;

/**
 * Review BO-08: with NEITHER token, while developing (\`pnpm dev\`), files are
 * kept on this machine's disk (.data/files/, git-ignored) so a laptop — and
 * a client-style install — has working logo uploads and job photos with
 * nothing set. An ENVIRONMENT check, not a feature or mode conditional
 * (generator rule 1): the same file is emitted for every project with
 * storage.
 *
 * CONTRACT: 13.5 writes \`NODE_ENV !== "production"\`. This says
 * \`=== "development"\`, so the test runner (NODE_ENV "test") never writes
 * files into the project's folder: the project's own tests build their
 * stores in memory (\`createFilesStorage\`).
 */
const devDisk = !privateBlob && !publicBlob && env.NODE_ENV === "development";
const privateStore = privateBlob ?? (devDisk ? createLocalDiskStore({ dir: ".data/files/private", access: "private" }) : undefined);
const publicStore = publicBlob ?? (devDisk ? createLocalDiskStore({ dir: ".data/files/public", access: "public" }) : undefined);

/** What a signed link's maker is checked against on every open (review G2). */
export type FileLinkStillValid = StorageSigningOptions["stillValid"];

/**
 * The key "Copy link" signs with: FILES_LINK_SECRET, else (review BO-19) one
 * made from CLERK_SECRET_KEY — HMAC-SHA256(CLERK_SECRET_KEY,
 * "adminigloo:file-links:v1"), so a deployment that set nothing still has
 * links. Rotating Clerk's secret key therefore ends every open link (they
 * last an hour at most anyway). Neither set: no links, and the button isn't
 * offered; everything else works.
 */
export function fileLinkSecret(): string | null {
  if (env.FILES_LINK_SECRET) return env.FILES_LINK_SECRET;
  if (env.CLERK_SECRET_KEY) return createHmac("sha256", env.CLERK_SECRET_KEY).update("adminigloo:file-links:v1").digest("hex");
  return null;
}

/**
 * How much ${companies ? `each ${noun}` : "the business"} may store (D11, review BO-07): FILES_ALLOWANCE_MB,
 * default 5120 — 5 GB, the platform owner's default. A two-crew lawn ${companies ? noun : "business"}
 * taking 40 shrunk photos a day at about 0.7 MB fills 1 GB in about five
 * weeks and 5 GB in about six months. THE BILLING CHUNK REPLACES THIS
 * FUNCTION with the plan's answer; until then it is one number for everyone${companies ? `,
 * so one ${noun} can't be given more room than the others yet` : ""}.
 *
 * THE DEFAULT ASSUMES VERCEL PRO (review BUY-02). On Vercel Hobby, Blob is 1
 * GB and 2,000 uploads a month for the WHOLE site${companies ? `, every ${noun} together` : ""},
 * and past either limit Vercel stops every file (logos, photos, attachments)
 * for 30 days. DEPLOYMENT.md "Photos and files" says so: on Hobby, set
 * FILES_ALLOWANCE_MB well under 1024${companies ? ` divided by the number of ${tenantLabelPlural(answers).toLowerCase()}` : ""}, or keep the
 * files on R2 (@adminigloo/storage/s3).
 */
export function filesAllowanceBytes(_tenantId: string): number {
  return (env.FILES_ALLOWANCE_MB ?? 5120) * 1024 * 1024;
}

/**
 * Who to ask for more room, in the Files screen's and the "storage is full"
 * alert's words (reviews BO-5, BO-6). ${companies ? `The platform: this site's name and the
 * address a ${noun} writes to (SUPPORT_EMAIL, else BOOTSTRAP_ADMIN_EMAIL, as the
 * suspended screen uses), so a full ${noun} reads "…or write to {this site} at
 * help@… for more room": a way to ask, not only a name.` : `The person who set up this site: the
 * site IS the business, so it never tells the business to ask itself, and
 * raising FILES_ALLOWANCE_MB is that person's job.`}
 */
export const FILES_MORE_ROOM: { readonly platformName: string; readonly supportEmail: string | undefined } = {
  platformName: ${companies ? "SITE_NAME" : `"the person who set up this site"`},
  supportEmail: ${companies ? "env.SUPPORT_EMAIL ?? env.BOOTSTRAP_ADMIN_EMAIL ?? undefined" : "undefined"},
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** When each ${companies ? noun : "business"}'s last refusal was reported, so a full one reports once a day, not per upload. */
const fullReportedAt = new Map<string, number>();

/**
 * A refusal for the allowance, reported to /admin/errors at most once a day
 * per ${companies ? noun : "business"} (review BO-07), IN WORDS (review BO-6): "${companies ? `Green Acres is` : "The business is"} out of
 * storage (5 GB of 5 GB)", so the platform owner sees who is out of room and
 * what changes it. An in-process map, like the sending allowance's reports.${companies ? `
 * The ${noun}'s name is read by a DYNAMIC import (13.10 rules 2 and 4).` : ""}
 */
export function reportStorageFull(event: StorageUsageEvent): void {
  // About this upload (runtime state).
  if (event.outcome !== "refused") return;
  const last = fullReportedAt.get(event.tenantId) ?? 0;
  if (Date.now() - last < DAY_MS) return;
  fullReportedAt.set(event.tenantId, Date.now());
  log.warn({ tenantId: event.tenantId, usage: event.usage }, "files: ${companies ? `a ${noun}` : "the business"} is out of storage");
  const used = \`\${formatBytes(event.usage.usedBytes)} of \${formatBytes(event.usage.allowanceBytes ?? 0)}\`;
  void (async () => {${companies ? `
    const { tenancy } = await import("./tenancy");
    const name = (await tenancy.companyProfile(event.tenantId).catch(() => null))?.name ?? "A ${noun}";` : ""}
    await reportError({
      error: new Error(
        ${
          companies
            ? `\`\${name} is out of storage (\${used}); a file was refused. Every ${noun} has the same room (FILES_ALLOWANCE_MB), so raising it gives them all more.\``
            : `\`The business is out of storage (\${used}); a file was refused. Raise FILES_ALLOWANCE_MB to give it more room.\``
        },
      ),
      source: "route",
      tenantId: event.tenantId,
      context: { feature: "files", route: "allowance", purpose: event.purpose },
    });
  })().catch((error: unknown) => log.error({ err: error, tenantId: event.tenantId }, "files: the storage-full report failed"));
}

/** Every files step that failed: the log, and /admin/errors. */
export function reportFilesError(error: unknown, context: { readonly tenantId: string | null; readonly step?: string; readonly route?: string }): void {
  log.error({ err: error, ...context }, "files: a step failed");
  void reportError({
    error,
    source: "route",
    tenantId: context.tenantId,
    context: { feature: "files", step: context.step ?? context.route ?? "files" },
  });
}

${stillValid}

/** This deployment's own address, with the slash \`new URL\` needs. */
function appBase(): string {
  const app = env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return app.endsWith("/") ? app : \`\${app}/\`;
}

/**
 * The files instance over any two stores — the project's own (below), and
 * what its tests build over memory stores (14.1): the same purposes, records
 * and rules either way. \`stillValid\` replaces the member check (a test's own).
 */
export function createFilesStorage(
  stores: { readonly private?: BlobStore; readonly public?: BlobStore },
  options: { readonly signingSecret?: string | null; readonly stillValid?: FileLinkStillValid } = {},
): Storage {
  const secret = options.signingSecret === undefined ? fileLinkSecret() : options.signingSecret;
  return createStorage({
    db,
    // REQUIRED, and named (D14, review G1): the package's own table, never a
    // table of the same name somebody else made.
    tables: storageTables,
    stores,
    purposes: [...STORAGE_BUILT_IN_PURPOSES${est ? ", estimatorPhotoPurpose, estimatorStaffPhotoPurpose" : ""}${companies && answers.includeFeedback ? ", feedbackScreenshotPurpose" : ""}${answers.includeStore ? ", STORE_PHOTO_PURPOSE" : ""}],
    // GENERATED: the records files can belong to, one per installed feature.
    // The record's own permissions decide who sees its files (D12).
    records: [${records.length > 0 ? `\n${records.join("\n")}\n    ` : ""}],
    // The plan's storage when this project sells plans (billing 0.3), else
    // FILES_ALLOWANCE_MB. src/server/plan-gate.ts decides; no \`if\` here.
    allowanceBytes: (tenantId) => storageAllowanceBytes(tenantId, filesAllowanceBytes(tenantId)),
    // Signed links only when a key is known (configuration, not a feature).
    ...(secret ? { signing: { secret, stillValid: options.stillValid ?? memberStillValid } } : {}),
${onUsage}
    urls: {
      content: ${content},
      publicBase: new URL("api/files", appBase()).toString(),
    },
    onError: (error, context) => reportFilesError(error, context),
  });
}

/** THE FILES of this site, over the stores above. */
export const files: Storage = createFilesStorage({ private: privateStore, public: publicStore }, { signingSecret: fileLinkSecret() });

/** The logo store tenancy keeps ${companies ? `each ${noun}'s` : "the"} logo in (src/server/tenancy-logo.ts): public, unguessable. Undefined without a public store. */
export const filesLogoStore: StorageLogoStore | undefined = files.logoStore();
${
  est
    ? `
/**
 * Where a customer's estimate photo is kept (10.5): PRIVATELY, with its
 * estimate — counted, never refused because the ${companies ? noun : "business"} is full (it is a
 * lead), and capped at a fifth of the room so strangers can't fill what the
 * crew's job photos need. Undefined without a private store: photos are then
 * read (with --ai) and not kept, and the screens say so.
 */
export const estimatorPhotoStore: StoragePurposeStore | undefined = files.purposeStore("estimator.photo");

/**
 * Where STAFF's own estimate photos are kept (review SEC-02): privately, on
 * their estimate, under a purpose of their own, counted and refused like the
 * crew's job photos and never by the customers' share. So strangers filling
 * that share with leads' photos can't stop the business adding its own.
 * Handed to the estimator's staff handlers as \`staffPhotoStore\`
 * (src/server/estimator-services.ts).
 */
export const estimatorStaffPhotoStore: StoragePurposeStore | undefined = files.purposeStore("estimator.staff-photo");
`
    : ""
}
${
  companies && answers.includeFeedback
    ? `
/**
 * Where a ${noun}'s feedback screenshots are kept (Tenancy 2b-2a review M3):
 * PRIVATELY, on their ticket — the ticket's permissions decide who opens them
 * (\`feedback.view\`), through the ${noun}'s signed-in files route. Counted,
 * never refused because the ${noun} is full, and capped at a tenth of the room
 * (strangers send these). Undefined without a private store: the ${noun}'s
 * feedback then takes no screenshots (src/server/feedback.ts).
 */
export const feedbackScreenshotStore: StoragePurposeStore | undefined = files.purposeStore("feedback.screenshot");
`
    : ""
}${
  answers.includeStore
    ? `
/**
 * Where a store's product photos are kept (getting paid, part 2): PUBLIC (they
 * are on the store page), COUNTED in the ${companies ? noun + "'s" : "business's"} storage allowance and
 * refused when it is full, in storage's own words. Undefined without a public
 * store: the store screen then says photo uploads aren't switched on.
 */
export const storePhotoStore: StoragePurposeStore | undefined = files.purposeStore(STORE_PHOTO_PURPOSE.key);
`
    : ""
}
/**
 * The purposes the files cron moves out of the public store (reviews G11,
 * BUY-04): 0.1's library files (the 2a Files page's uploads, "library.file")${est ? ` and the
 * estimator's photos, which 0.1 and Tenancy 2a kept in the public store` : ""}. A
 * project that never had them has no such rows, and the cron moves nothing.
 * GENERATED: a list, never an \`if\`.
 */
export const FILES_MOVE_TO_PRIVATE: readonly string[] = ["library.file"${est ? `, "estimator.photo"` : ""}];

/**
 * How many files of FILES_MOVE_TO_PRIVATE are still at a public address
 * (review BUY-05): what /setup says while the files cron is still moving an
 * older version's files, and what the cron reports when a run didn't finish.
 */
export async function filesStillPublic(): Promise<number> {
  const f = storageTables.files;
  const [row] = await db
    .select({ n: count() })
    .from(f)
    .where(and(inArray(f.kind, [...FILES_MOVE_TO_PRIVATE]), eq(f.access, "public"), isNull(f.deletedAt)));
  return Number(row?.n ?? 0);
}

/** What the private store's check answers. */
export type PrivateStoreVerdict = Awaited<ReturnType<Storage["checkPrivateStore"]>>;

/** How long /setup keeps the private store's verdict (review BUY-06): an hour. */
const PRIVATE_CHECK_TTL_MS = 60 * 60 * 1000;
let privateCheck: { readonly at: number; readonly verdict: PrivateStoreVerdict } | null = null;

/**
 * Is the private store really private? (review G9) The verdict /setup shows,
 * kept for an hour on this server (review BUY-06): each live check stores a
 * probe file and deletes it, an upload Vercel counts (Hobby has 2,000 a month
 * for the whole site), so reloading /setup mustn't spend one each time. The
 * files cron asks for a live check every day (\`fresh: true\`).
 */
export async function privateStoreVerdict(
  options: { readonly fresh?: boolean; readonly storage?: Storage } = {},
): Promise<PrivateStoreVerdict> {
  // How old the last verdict is (runtime state). \`storage\`: the instance the
  // caller runs on (the files cron's own), else this module's.
  if (!options.fresh && privateCheck && Date.now() - privateCheck.at < PRIVATE_CHECK_TTL_MS) return privateCheck.verdict;
  const verdict = await (options.storage ?? files).checkPrivateStore();
  privateCheck = { at: Date.now(), verdict };
  return verdict;
}
`;
}

// ---------------------------------------------------------------------------
// src/server/files-routes.ts
// ---------------------------------------------------------------------------

export function renderFilesRoutes(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  const limits = `/**
 * How many uploads and links, per hour (review BO-09): a person may add 120
 * files an hour (a crew's busy morning is far under it), the ${companies ? noun : "business"} 600, and
 * 60 signed links an hour. They count in Upstash when configured.
 */
export const FILES_RATE_LIMITS = {
  uploadPerPerson: { limit: 120, windowMs: 60 * 60 * 1000 },
  uploadPerCompany: { limit: 600, windowMs: 60 * 60 * 1000 },
  link: { limit: 60, windowMs: 60 * 60 * 1000 },
} as const;

/** false: 429 "Too many uploads for now." The person and the ${companies ? noun : "business"} each have their own count. */
async function filesRateLimit(_req: Request, bucket: "upload" | "link", tenantId: string, userId: string | null): Promise<boolean> {
  // Which bucket, and who: runtime state.
  if (bucket === "link") {
    return (await limiter.limit({ key: \`files:\${tenantId}:link\`, policy: FILES_RATE_LIMITS.link })).allowed;
  }
  if (userId !== null) {
    const mine = await limiter.limit({ key: \`files:\${tenantId}:\${userId}:upload\`, policy: FILES_RATE_LIMITS.uploadPerPerson });
    if (!mine.allowed) return false;
  }
  return (await limiter.limit({ key: \`files:\${tenantId}:upload\`, policy: FILES_RATE_LIMITS.uploadPerCompany })).allowed;
}

/**
 * The signed links and the public files, at /api/files (both modes; GET and
 * HEAD only). A private file is streamed only after its link's MAC, expiry,
 * ${companies ? noun : "business"} and maker all check out; a public file only by the random part of
 * its key.
 */
export function buildFileLinkHandlers(storage: Storage = files) {
  return createStorageLinkHandlers({
    storage,
    onError: (error, context) => reportFilesError(error, { tenantId: null, route: context.route }),
  });
}`;
  if (companies) {
    return `import { createStorageHandlers, createStorageLinkHandlers, type Storage } from "${scope}/storage";
import { companyAuthorizer, companyRoutes, type FeatureHandlerOverrides } from "@/server/company-routes";
import { files, reportFilesError } from "@/server/files";
import { limiter } from "@/server/rate-limit";
import { tenancy } from "@/server/tenancy";

/**
 * The files routes of every ${noun}: what a record's "Photos and files", the
 * Files screen and the usage meter talk to, at /api/app/{${noun} id}/files.
 * Its own module so files.ts never imports company-routes (13.10 rule 1);
 * only route files and tests import this one.
 *
 * THE ${noun.toUpperCase()} IS THE ONE IN THE PATH; THE ROW DECIDES (D12). The list and
 * the upload ask \`files.view\` / \`files.manage\`; one file, or a record's
 * files, asks what that record's own permissions grant — a crew member adds
 * photos to their own crew's visit and nothing else, and \`files.view\` alone
 * opens no invoice's attachments. Anyone else gets 404, never 403.
 */

${limits}

/** \`overrides.principal\` and \`overrides.storage\` are how the project's own proofs call it as somebody else, over memory stores. */
export function buildFilesHandlers(overrides: FeatureHandlerOverrides & { readonly storage?: Storage } = {}) {
  return createStorageHandlers({
    storage: overrides.storage ?? files,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer(overrides),
    // "Added by": the ${noun}'s own members' names, never the site's user list.
    names: async (tenantId, userIds) => {
      const wanted = new Set(userIds);
      const out = new Map<string, string>();
      for (const person of await tenancy.listMemberPeople(tenantId)) {
        if (wanted.has(person.userId)) out.set(person.userId, person.name ?? person.email ?? "Someone");
      }
      return out;
    },
    // "Green Acres' storage is full… Ask the owner to make room." (review BO-07)
    companyName: async (tenantId) => (await tenancy.companyProfile(tenantId))?.name ?? null,
    // Where the logo is changed (review FH-11): "This is removed where it's
    // used: in ${noun} settings." — this project's own page by that name.
    logoSettings: "${noun} settings",
    rateLimit: filesRateLimit,
    onError: (error, context) => reportFilesError(error, { tenantId: context.tenantId, route: context.route }),
  });
}
`;
  }
  const staffMaps = [
    ...(answers.includeScheduling ? [["SCHEDULING_STAFF_KEYS", "@/server/scheduling-staff"]] : []),
    ...(answers.includeEstimator ? [["ESTIMATOR_STAFF_KEYS", "@/server/estimator-staff"]] : []),
    ...(answers.includeInvoicing ? [["INVOICING_STAFF_KEYS", "@/server/invoicing"]] : []),
  ] as const;
  return `import { inArray } from "drizzle-orm";
import { users } from "${scope}/auth/schema";
import { createStorageHandlers, createStorageLinkHandlers, type Storage } from "${scope}/storage";
import { SITE_NAME } from "@/seo";
${staffMaps.map(([name, from]) => `import { ${name} } from "${from}";`).join("\n")}${staffMaps.length > 0 ? "\n" : ""}import { FILES_STAFF_KEYS, FILES_TENANT, files, reportFilesError } from "@/server/files";
import { limiter } from "@/server/rate-limit";
import { authorizeStaffFor } from "@/server/staff-access";
import { db } from "@/db";

/**
 * The files routes of this business: what a record's "Photos and files", the
 * Files screen and the usage meter talk to, at /api/admin/files.
 *
 * Behind this project's own sign-in and staff keys. THE ROW DECIDES (D12):
 * one file, or a record's files, asks what that record's own permissions
 * grant — mapped to staff keys (\`filesStaffKeyFor\`) — so a crew member adds
 * photos to their own crew's visit and nothing else. Anyone else gets 404.
 */

/**
 * Every package permission a file route asks, mapped to the staff key that
 * holds it: GENERATED, the spread of each installed feature's own staff keys
 * and the files keys. A permission with no mapping holds nobody. Built when
 * the handlers are, not at load (13.10 rule 3).
 */
export function filesStaffKeyFor(): Readonly<Record<string, string>> {
  return { ${[...staffMaps.map(([name]) => `...${name}`), "...FILES_STAFF_KEYS"].join(", ")} };
}

${limits}

/** \`overrides.storage\` is how the project's own proofs call it over memory stores. */
export function buildFilesHandlers(overrides: { readonly storage?: Storage } = {}) {
  return createStorageHandlers({
    storage: overrides.storage ?? files,
    tenantId: FILES_TENANT,
    authorize: authorizeStaffFor(filesStaffKeyFor(), "Sign in to see files."),
    // "Added by": the staff member's name.
    names: async (_tenantId, userIds) => {
      const rows =
        userIds.length === 0
          ? []
          : await db.select({ id: users.id, name: users.displayName, email: users.email }).from(users).where(inArray(users.id, [...userIds]));
      return new Map(rows.map((row) => [row.id, row.name ?? row.email ?? "Someone"]));
    },
    companyName: async () => SITE_NAME,
    rateLimit: filesRateLimit,
    onError: (error, context) => reportFilesError(error, { tenantId: context.tenantId, route: context.route }),
  });
}
`;
}

// ---------------------------------------------------------------------------
// The slots and the small generated constants
// ---------------------------------------------------------------------------

export function renderAlertsBellSlot(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  if (!answers.includeNotifications) {
    return `import type { ReactNode } from "react";
import type { SessionState } from "${scope}/tenancy/server";

/**
 * The alerts bell in the header. Nothing: ${answers.projectName} was generated without
 * alerts, so the header has no bell. \`create-app add notifications\` writes
 * the bell in here. (GENERATED in three variants; this is the one without.)
 */
export function AlertsBellSlot(_props: {
  readonly session: SessionState | null;
  readonly can: readonly string[];
  readonly isStaff: boolean;
}): ReactNode {
  return null;
}
`;
  }
  if (companiesMode(answers)) {
    return `import type { ReactNode } from "react";
import { AlertsBell } from "${scope}/notifications-widget/admin";
import type { SessionState } from "${scope}/tenancy/server";

/**
 * The alerts bell in the header, for the ${noun} the person is working in
 * (D2): its count, the latest ten, and "Mark all as read", polled once a
 * minute while the page is visible (slower when nobody's at the keyboard).
 * Outside the phone menu, so it shows on a phone too.
 *
 * Drawn only for a ready session whose role in the active ${noun} holds
 * \`alerts.view\` — runtime state, read once per page by the header. The
 * routes behind it check again on every call.
 */
export function AlertsBellSlot(props: {
  readonly session: SessionState | null;
  readonly can: readonly string[];
  readonly isStaff: boolean;
}): ReactNode {
  if (props.session?.state !== "ready" || !props.can.includes("alerts.view")) return null;
  return <AlertsBell baseUrl={\`/api/app/\${props.session.company.id}/alerts\`} />;
}
`;
  }
  return `import type { ReactNode } from "react";
import { AlertsBell } from "${scope}/notifications-widget/admin";
import type { SessionState } from "${scope}/tenancy/server";

/**
 * The alerts bell in the header, for this site's staff: its count, the latest
 * ten, and "Mark all as read", polled once a minute while the page is
 * visible. Outside the phone menu, so it shows on a phone too.
 *
 * Drawn for staff (runtime state, read once per page by the header); the
 * bell hides itself if the server answers 401 or 403 (a staff member without
 * \`staff.alerts.view\`).
 */
export function AlertsBellSlot(props: {
  readonly session: SessionState | null;
  readonly can: readonly string[];
  readonly isStaff: boolean;
}): ReactNode {
  if (!props.isStaff) return null;
  return <AlertsBell baseUrl="/api/admin/alerts" />;
}
`;
}

export function renderRecordFilesSlot(answers: Answers): string {
  const scope = answers.scope;
  const props = `props: {
  /** Where the files routes are mounted for this ${companiesMode(answers) ? tenantLabel(answers).toLowerCase() : "business"}. */
  readonly baseUrl: string;
  /** The record the files belong to: { type: "invoicing.invoice", id }. */
  readonly record: { readonly type: string; readonly id: string };
  /** The card's heading; default "Photos and files". */
  readonly title?: string;
  /** One muted line under the heading. */
  readonly hint?: string;
}`;
  if (!answers.includeStorage) {
    return `import type { ReactNode } from "react";

/**
 * A record's "Photos and files" card. Nothing: ${answers.projectName} was generated
 * without file storage, so a visit, an estimate or an invoice keeps no files
 * of its own. \`create-app add storage\` writes the card in here. (GENERATED in
 * two variants; this is the one without.)
 */
export function RecordFilesSlot(_${props}): ReactNode {
  return null;
}
`;
  }
  return `import type { ReactNode } from "react";
import { RecordFiles } from "${scope}/storage-widget/admin";

/**
 * A record's "Photos and files" card (D12): the files kept on this visit,
 * estimate or invoice — thumbnails for photos, a row per document, add from
 * the computer or (on a phone) the camera, remove, copy a link. The record's
 * own permissions decide who sees and adds them; the routes check on every
 * call. Photos are made smaller on the phone before they're sent.
 *
 * A slot so the 2a record pages render it without an \`if\` about storage
 * (GENERATED in two variants; this is the one with storage).
 */
export function RecordFilesSlot(${props}): ReactNode {
  return <RecordFiles baseUrl={props.baseUrl} record={props.record} title={props.title} hint={props.hint} />;
}
`;
}

export function renderSetupFilesSlot(answers: Answers): string {
  if (!answers.includeStorage) {
    return `import type { ReactNode } from "react";

/**
 * /setup's file-store rows. Nothing: ${answers.projectName} was generated without file
 * storage. (GENERATED in two variants; this is the one without.)
 */
export async function SetupFilesSlot(): Promise<ReactNode> {
  return null;
}
`;
  }
  return `import type { ReactNode } from "react";
import { Notice } from "@/components/ui";
import { env } from "@/env";
import { filesStillPublic, privateStoreVerdict } from "@/server/files";

/**
 * /setup's file-store rows (13.7; reviews BO-08, G9, BUY-05, BUY-06, BUY-08):
 * which stores this deployment connected, said in a sentence, and — with the
 * private store set — whether it really is private, with the reason when not
 * (or what the check couldn't see, for an R2 bucket), whether the public store
 * for logos is connected too, and how many of an older version's files are
 * still waiting to be moved out of the public store. Each branch is an
 * ENVIRONMENT check (which tokens are set here) or runtime data, not a feature
 * switch.
 *
 * The private check is \`privateStoreVerdict()\`, kept for an hour (review
 * BUY-06): a live check stores a probe file and deletes it, so a reload of
 * this page doesn't spend one of the store's uploads each time.
 */
export async function SetupFilesSlot(): Promise<ReactNode> {
  if (env.BLOB_PRIVATE_READ_WRITE_TOKEN) {
    const check = await privateStoreVerdict();
    if (!check.ok) {
      return (
        <Notice tone="danger" title="The store for photos and files isn't private">
          {check.reason ?? "Anyone could open the files kept there."}
        </Notice>
      );
    }
    // Runtime data: what is still at a public address from an older version.
    const stillPublic = await filesStillPublic().catch(() => 0);
    return (
      <>
        {check.note ? (
          <Notice tone="info" title="Check one thing about the store for photos and files">
            {check.note}
          </Notice>
        ) : null}
        {env.BLOB_READ_WRITE_TOKEN ? null : (
          <Notice tone="warn" title="Logos aren't kept yet">
            Logos can&rsquo;t be uploaded until the public Blob store is connected (BLOB_READ_WRITE_TOKEN): in Vercel, Storage →
            Create → Blob, access Public, connected with the usual prefix. Photos and files work.
          </Notice>
        )}
        {stillPublic > 0 ? (
          <Notice tone="info" title="Older files are still being made private">
            {stillPublic === 1 ? "1 photo or file" : \`\${stillPublic} photos and files\`} from an earlier version of this site{" "}
            {stillPublic === 1 ? "is" : "are"} still at a public address. The files job (/api/cron/files) moves them into the
            private store a batch at a time, every time it runs; this goes away when none are left.
          </Notice>
        ) : null}
      </>
    );
  }
  if (env.BLOB_READ_WRITE_TOKEN) {
    return (
      <Notice tone="warn" title="Photos and files aren't kept yet">
        Customers&rsquo; estimate photos and job photos aren&rsquo;t kept until the private store is connected
        (BLOB_PRIVATE_READ_WRITE_TOKEN). Company logos work.
      </Notice>
    );
  }
  if (env.NODE_ENV === "development") {
    return (
      <Notice tone="info" title="Files are kept on this computer">
        Files are kept on this computer (.data/files) until a Blob store is connected.
      </Notice>
    );
  }
  return (
    <Notice tone="warn" title="File storage isn't switched on yet">
      Logos, photos and files can&rsquo;t be kept until the two Blob stores are connected (DEPLOYMENT.md).
    </Notice>
  );
}
`;
}

/** `src/server/visit-files.ts` (with scheduling): where a visit's photos and files open. */
export function renderVisitFiles(answers: Answers): string {
  const companies = companiesMode(answers);
  if (!answers.includeStorage) {
    return `/**
 * Where a visit's photos and files open. Nowhere: ${answers.projectName} was generated
 * without file storage, so the calendar and today's route offer no files
 * link. \`create-app add storage\` sets it. (GENERATED in two variants; no \`if\`.)
 */
export const VISIT_FILES_HREF: string | undefined = undefined;
`;
  }
  return `/**
 * Where a visit's photos and files open: its own page (a visit has no page of
 * its own in the schedule), from the calendar's visit panel and from each
 * stop on today's route — a crew member adds the job's photos there from
 * their phone. A pattern: {id} is the visit. GENERATED per mode.
 */
export const VISIT_FILES_HREF: string | undefined = ${JSON.stringify(companies ? "/app/schedule/visits/{id}/files" : "/admin/schedule/visits/{id}/files")};
`;
}

/**
 * `src/server/alerts-links.ts` (with scheduling or the estimator).
 *
 * CONTRACT: 13.5 has the scheduling and estimator admin builders pass
 * `alertsHref` with notifications. Those builders are STATIC overlay files
 * (scheduling-companies' and estimator-companies' src/server, and the single
 * business's admin route files), which can't carry an `if` about another
 * feature — so the value is this generated constant, in two variants, and
 * the overlays pass it as it is (null = not passed: the package keeps 2a's
 * per-feature lists).
 */
export function renderAlertsLinks(answers: Answers): string {
  const companies = companiesMode(answers);
  const shell = answers.adminShell !== "none";
  const href = answers.includeNotifications ? (companies ? "/app/alerts/settings" : shell ? "/admin/alerts/settings" : null) : null;
  // A single business's crew STAFF role (scheduling-single) holds its route
  // key and, with alerts, its own bell (staff.alerts.view): a customer moving
  // a crew's visit reaches the crew in the app, not only by email. A company's
  // Crew role gets `alerts.view` from the package's own defaults.
  const crewKeys = !companies && answers.includeNotifications ? [`"staff.alerts.view"`] : [];
  const crew = `
/**
 * The alert keys a single business's crew staff role holds beside its route
 * (src/server/scheduling.ts grants them): ${crewKeys.length > 0 ? "its own bell." : `none here (${companies ? `a ${tenantLabel(answers).toLowerCase()}'s Crew role gets alerts.view from the package` : "generated without alerts"}).`}
 * GENERATED: a list, never an \`if\`.
 */
export const ALERTS_CREW_STAFF_KEYS: readonly string[] = [${crewKeys.join(", ")}];
`;
  if (href === null) {
    return `/**
 * Where "who gets these alerts" is chosen, for the schedule's and the
 * estimator's settings screens. Nowhere: ${answers.projectName} ${answers.includeNotifications ? "has alerts but no admin panel to hold Alert settings" : "was generated without alerts"},
 * so each feature keeps its own "send new-request alerts to" list (2a).
 * (GENERATED in two variants; no \`if\`.)
 */
export const ALERTS_SETTINGS_HREF: string | null = null;
${crew}`;
  }
  return `/**
 * Where "who gets these alerts" is chosen (D6): Alert settings, the ONE place
 * the owner picks who hears about new work. Handed to the schedule's and the
 * estimator's staff handlers as \`alertsHref\`, so their settings screens say
 * "Who gets these alerts is chosen in Alert settings." with a link, instead
 * of offering their old per-feature lists. GENERATED per mode.
 */
export const ALERTS_SETTINGS_HREF: string | null = ${JSON.stringify(href)};
${crew}`;
}

/** The `--tenant-noun none` fixed-tenant constants this module emits (D12's grep). */
export const ALERTS_FILES_FIXED_TENANTS = ["ALERTS_TENANT", "FILES_TENANT"] as const;

/** For the generator test: does this project get the slot files? */
export function emitsRecordFilesSlot(answers: Answers): boolean {
  return hasFileRecords(answers);
}

/** For the generator test: the alert producers glued for this project. */
export function alertProducers(answers: Answers): readonly string[] {
  return [
    ...(companiesMode(answers) ? ["alertOnTenancyEvent"] : []),
    ...(answers.includeScheduling ? ["alertOnSchedulingEvent"] : []),
    ...(answers.includeEstimator ? ["alertOnEstimatorEvent"] : []),
    ...(answers.includeInvoicing ? ["alertOnInvoicingEvent", "alertOnCardPayment"] : []),
    ...(answers.includeComms ? ["alertOnCommsFailure"] : []),
    ...(answers.includeStorage ? ["alertOnStorageUsage"] : []),
    ...(companiesMode(answers) && answers.includeFeedback ? ["alertOnFeedbackEvent"] : []),
  ];
}

/** Whether alerts.ts has anything the field-service features produce. */
export function hasAlertProducers(answers: Answers): boolean {
  return hasFieldService(answers);
}

// ---------------------------------------------------------------------------
// DEPLOYMENT.md — alerts and files (Tenancy 2b-1, 13.8, 13.9)
// ---------------------------------------------------------------------------

/** Where DEPLOYMENT.md's alerts-and-files notes go. */
export const ALERTS_FILES_MARKER = "<!-- adminigloo:alerts-files -->";

/**
 * DEPLOYMENT.md's alerts and files sections (13.8, 13.9; review BO-19): the
 * alerts cron, the two Blob stores (the steps word for word), the allowance,
 * the link key, the files cron and what files cost. Generated, so a project
 * without either feature says nothing about them. Empty when neither is
 * installed.
 *
 * CONTRACT: 13.9's "Keep the Blob store you have…" sentence is step 2 now,
 * after a step that creates the PUBLIC store (review BUY-08: a new buyer has
 * no store to keep), and the Hobby limits are said (review BUY-02).
 */
export function renderDeploymentAlertsFiles(answers: Answers): string {
  const companies = companiesMode(answers);
  const noun = companies ? tenantLabel(answers).toLowerCase() : "business";
  const parts: string[] = [];
  if (answers.includeNotifications) {
    const clock = [
      ...(answers.includeScheduling ? ["visit requests about to lapse unanswered"] : []),
      ...(answers.includeInvoicing ? ["invoices gone overdue"] : []),
    ];
    parts.push(`
### Alerts: the alerts cron

With alerts, \`vercel.json\` also holds \`/api/cron/alerts\`, once a day (14:15
UTC). For ${companies ? `every active ${noun}` : "the business"} it ${clock.length > 0 ? `raises the alerts the clock decides (${clock.join(" and ")}), ` : ""}sends the alert emails
that are waiting — one that failed when it was first sent, and an office email
that failed and was handed back — and clears out old alerts (read ones after
30 days, all after 180). A daily run retries an alert email once a day; point
any scheduler at the route every 15 minutes for retries within the hour:
Vercel Pro, or any outside scheduler calling
\`https://<your site>/api/cron/alerts\` with the header
\`x-cron-secret: <CRON_SECRET>\`.

Alert emails go out through Messages${companies ? `, under the ${noun}'s name,` : ""} as the "Team alert" message
(the owner can reword it or switch it off there), and count in the team's own
sending allowance (60 an hour, 300 a day${companies ? ` per ${noun}` : ""}), never in the one customers'
quotes and invoices use. Without email set up (\`RESEND_API_KEY\`), alerts stay
in the app and Alert settings says so.
`);
  }
  if (answers.includeStorage) {
    parts.push(`
### Photos and files: two Blob stores

A Vercel Blob store is public or private as a whole, and its access is chosen
when it is created, so this site needs two:

1. **The public store, for logos.** In the Vercel dashboard open Storage → Create → Blob, set its access to **Public**, and connect it to this project with the usual environment variable prefix, \`BLOB\` (that gives \`BLOB_READ_WRITE_TOKEN\`). If the project already has a Blob store, keep it: that is this one, and it holds the ${companies ? `${noun} ` : ""}logos.
2. **The private store, for photos and files.** For photos and files, in the Vercel dashboard open Storage → Create → Blob, set its access to Private, and connect it to this project with the environment variable prefix \`BLOB_PRIVATE\` (that gives \`BLOB_PRIVATE_READ_WRITE_TOKEN\`). Redeploy.

The site refuses to start when the two tokens are the same, and /setup checks
that the private store really is private (the check stores and deletes a tiny
file, so /setup repeats it at most once an hour, and the files cron once a
day) and says when the public store for logos is missing. While developing with
neither token, files are kept on your computer in \`.data/files\` (git-ignored).

**On Vercel Hobby, files outgrow the plan fast.** Hobby's Blob
is 1 GB of storage and 2,000 uploads a month for the WHOLE site${companies ? `, every ${noun}
together` : ""}, and past either limit Vercel stops every file (logos, photos,
attachments) until 30 days have passed, with no warning in the app. One
two-crew ${companies ? noun : "business"} taking 40 photos a day uploads 1,200 a month. The default
allowance below (5 GB${companies ? ` per ${noun}` : ""}) assumes Vercel Pro. On Hobby, set
\`FILES_ALLOWANCE_MB\` well under 1024${companies ? ` divided by the number of ${tenantLabelPlural(answers).toLowerCase()}` : ""}, or keep the files on R2
(\`@adminigloo/storage/s3\`, one change in \`src/server/files.ts\`).

- \`FILES_ALLOWANCE_MB\` (optional; default 5120, which is 5 GB): how much ${companies ? `each ${noun}` : "the business"}
  may store. The billing chunk will set this per plan${companies ? `; until then it is the same
  for every ${noun}, and one ${noun} can't be given more than the others` : ""}.${answers.includeEstimator ? ` Customers' estimate photos
  count, are never refused for a full store, and may use at most a fifth of it.` : ""}
- \`FILES_LINK_SECRET\` (optional; at least 32 characters): signs the links
  people copy for a file, each good for at most an hour${companies ? ` and only while its
  maker is still in the ${noun}, may still open that file, and the ${noun} isn't
  suspended` : " and only while its maker may still open that file"}. Without it a key is
  made from your Clerk secret key, so changing that key ends every copied link.${companies ? `
- \`SUPPORT_EMAIL\`: a full ${noun}'s Files screen and its "storage is full"
  alert say to write there for more room.` : ""}

\`vercel.json\` also holds \`/api/cron/files\`, once a day (14:45 UTC): it deletes
removed files from the stores, moves the files an older version kept in the
public store (0.1's library files${answers.includeEstimator ? " and the estimator's customer photos" : ""}) into the
private one — up to 1,000 at a time for 20 seconds a run; while any are left,
/setup says how many and a run that didn't finish is reported to
\`/admin/errors\` — and checks the private store is still private (a failure is
reported to \`/admin/errors\`).

**What files cost.** Vercel's included Blob storage and operations are for the whole platform, not per ${companies ? noun : "business"}; every thumbnail view runs a function and a store read (cached in the browser for five minutes); for a platform with many ${companies ? tenantLabelPlural(answers).toLowerCase() : "businesses"}, R2 through \`@adminigloo/storage/s3\` (one change in \`src/server/files.ts\`) costs less.
`);
  }
  return parts.join("");
}
