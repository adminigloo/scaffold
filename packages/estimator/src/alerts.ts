import type { EstimatorEvent } from "./events.js";
import { formatMoney } from "./settings.js";

/**
 * Alerts (Tenancy 2b-1, contract 10.1): what the estimator tells the bell.
 *
 * STRUCTURAL, NO NOTIFICATIONS IMPORT (2a D4). The shapes are the contract's
 * 3.2 and 3.3, declared here and package-prefixed, so a host passes
 * `estimatorAlertKinds` to `defineAlertRegistry` and the drafts from
 * `estimatorAlertsFor` to `alerts.notify`, and the estimator never loads
 * @adminigloo/notifications.
 *
 * THE WORDS ARE THE ESTIMATOR'S (D3): titles, bodies and dedupe keys are
 * written here, by the package that knows the fact, so a wording fix reaches
 * every project by npm.
 *
 * ONE DECISION FOR THE ALERT AND THE OFFICE EMAIL (D6, 3.4). Which event the
 * office hears about, under which kind and key, is `estimatorOfficeNotice`,
 * and BOTH the mapper and the comms listener (`./comms`) ask it, so the
 * office email's claim always finds the rows the mapper wrote: a lead is
 * never emailed twice, nor lost between two halves that disagreed.
 *
 * PURE. The event's snapshot has everything (the lines, the range, the
 * customer), so the mapper reads no table.
 */

// ---- shapes (contract 3.2 / 3.3, package-prefixed) --------------------------

export type EstimatorAlertChannel = "in_app" | "email";

export interface EstimatorAlertKind {
  /** Permanent. /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/, at most 64 characters. */
  readonly key: string;
  /** What a person sees in Alert settings, a plain phrase. */
  readonly label: string;
  readonly description?: string;
  /** The heading it is listed under. */
  readonly category: string;
  readonly audience: {
    /** Only active members holding this may receive it (D4). */
    readonly permission: string;
    /** The routing group whose chosen people get it (default: the owner). Absent: everyone holding `permission`. */
    readonly routing?: string;
    /** People assigned to the record who hold this also get it (crew). */
    readonly assigned?: { readonly permission: string };
  };
  /** For someone who never chose. */
  readonly defaultChannel: EstimatorAlertChannel;
  /** false: never emailed, and the choice isn't offered. Default true. */
  readonly email?: boolean;
  /** "producer": the package sends its own office email for it (D6). Default "notifications". */
  readonly emailBy?: "notifications" | "producer";
  /** Order inside its category. Default 100. */
  readonly order?: number;
}

export interface EstimatorAlertRouting {
  /** /^[a-z][a-z0-9-]{1,31}$/. Permanent (stored). */
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  /** Who may be chosen for it: members holding this. */
  readonly permission: string;
  readonly order?: number;
}

export interface EstimatorAlertKinds {
  readonly kinds: readonly EstimatorAlertKind[];
  readonly routings: readonly EstimatorAlertRouting[];
}

export interface EstimatorAlertDraft {
  readonly tenantId: string;
  /** A registered kind key. */
  readonly kind: string;
  /** One line, 1–200 characters, plain text: no CR, LF, U+2028 or U+2029 (it becomes an email Subject; D18). */
  readonly title: string;
  /** At most 2000 characters, plain text, may have line breaks; null = none. */
  readonly body: string | null;
  /** Where it opens: a path on this site; null = nothing to open. */
  readonly href: string | null;
  /** Where it opens for someone reached ONLY through `assigned`. Default `href`. */
  readonly assignedHref?: string | null;
  /** D7: from the durable fact; 1–200 characters. */
  readonly dedupeKey: string;
  /** What it is about. */
  readonly subject: { readonly type: string; readonly id: string } | null;
  /** Who caused it; never alerted about it. null for a customer or the system. */
  readonly actorUserId: string | null;
  /** For kinds with `audience.assigned`: who is on the record (as text). */
  readonly assignedUserIds?: readonly string[];
  /** Where a reply to the email copy goes (the customer, on a lead: 2a review T2A-BO-12). */
  readonly replyTo?: string | null;
}

// ---- the fragment -------------------------------------------------------------

/** The record every estimator alert is about (`subject.type`), and the file record type (files.ts). */
export const ESTIMATOR_ESTIMATE_SUBJECT = "estimator.estimate";

export type EstimatorAlertKindKey = "estimator.lead" | "estimator.quote.accepted" | "estimator.quote.declined" | "estimator.quote.expired";

const ESTIMATES = "estimates";
const CATEGORY = "Estimates";

/**
 * The estimator's alert kinds and its one routing group (contract 10.1).
 *
 * All four are new work or a sale won or lost, so all default to "In the app
 * and by email", to the "estimates" group (the owner until someone else is
 * chosen, D4). All four already have the estimator's own office email (2a's
 * `estimate_lead_staff` and `quote_staff_notice`: the lines, the range, the
 * customer's details, a reply that reaches the customer), so they are
 * `emailBy: "producer"`: notifications writes the in-app rows and the comms
 * listener sends the one email (D6).
 */
export const estimatorAlertKinds: EstimatorAlertKinds = Object.freeze({
  kinds: Object.freeze([
    Object.freeze({
      key: "estimator.lead",
      label: "Someone asks for an estimate",
      category: CATEGORY,
      audience: Object.freeze({ permission: "estimator.view", routing: ESTIMATES }),
      defaultChannel: "email",
      emailBy: "producer",
      order: 10,
    }),
    Object.freeze({
      key: "estimator.quote.accepted",
      label: "A customer accepts a quote",
      category: CATEGORY,
      audience: Object.freeze({ permission: "estimator.view", routing: ESTIMATES }),
      defaultChannel: "email",
      emailBy: "producer",
      order: 20,
    }),
    Object.freeze({
      key: "estimator.quote.declined",
      label: "A customer declines a quote",
      category: CATEGORY,
      audience: Object.freeze({ permission: "estimator.view", routing: ESTIMATES }),
      defaultChannel: "email",
      emailBy: "producer",
      order: 30,
    }),
    Object.freeze({
      key: "estimator.quote.expired",
      label: "A quote lapses unanswered",
      category: CATEGORY,
      audience: Object.freeze({ permission: "estimator.view", routing: ESTIMATES }),
      defaultChannel: "email",
      emailBy: "producer",
      order: 40,
    }),
  ] satisfies EstimatorAlertKind[]),
  routings: Object.freeze([
    Object.freeze({
      key: ESTIMATES,
      label: "New estimate requests and quote answers",
      description: "Someone asking for an estimate, and customers accepting, declining or letting a quote lapse.",
      permission: "estimator.view",
      order: 10,
    }),
  ] satisfies EstimatorAlertRouting[]),
});

// ---- the shared decision (D6, 3.4) --------------------------------------------

export interface EstimatorOfficeNoticeSpec {
  /** The alert kind this fact is (contract 10.1). */
  readonly kind: EstimatorAlertKindKey;
  /** D7: from the durable fact, never from the event's id. */
  readonly dedupeKey: string;
  /** The office email 2a sends for it. */
  readonly templateKey: "estimate_lead_staff" | "quote_staff_notice";
}

/**
 * The office email an event warrants, with its alert kind and dedupe key, or
 * null. THE ONE PLACE this is decided (see the module comment). Never for a
 * change staff made themselves: a lead staff typed in, a quote staff marked
 * accepted. A quote that lapses is one whoever ran the sweep (a lost sale).
 *
 * CONTRACT: 10.1's table says a lead "(actor customer)"; the comms listener
 * has always sent the lead notice for any lead staff didn't make (2a), and
 * the two must agree, so "not staff" decides here. Every lead the package
 * writes today comes from a customer, so the two readings are the same.
 *
 * A lead is one per estimate; an answer carries the quote's sequence, so a
 * customer who accepts a revised quote is a new fact, and the same answer
 * delivered twice is not.
 */
export function estimatorOfficeNotice(event: EstimatorEvent): EstimatorOfficeNoticeSpec | null {
  const id = event.estimateId;
  const sequence = event.data.estimate.quoteSequence;
  switch (event.type) {
    case "lead.received":
      return event.actor.type === "staff" ? null : { kind: "estimator.lead", dedupeKey: `estimator.lead:${id}`, templateKey: "estimate_lead_staff" };
    case "quote.accepted":
      return event.actor.type === "customer"
        ? { kind: "estimator.quote.accepted", dedupeKey: `estimator.quote.accepted:${id}:${sequence}`, templateKey: "quote_staff_notice" }
        : null;
    case "quote.declined":
      return event.actor.type === "customer"
        ? { kind: "estimator.quote.declined", dedupeKey: `estimator.quote.declined:${id}:${sequence}`, templateKey: "quote_staff_notice" }
        : null;
    case "quote.expired":
      return { kind: "estimator.quote.expired", dedupeKey: `estimator.quote.expired:${id}:${sequence}`, templateKey: "quote_staff_notice" };
    default:
      return null;
  }
}

// ---- helpers -------------------------------------------------------------------

/** Every control character and Unicode line separator becomes a space; runs collapse (a title is one line, D18). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
function oneLine(value: string | null | undefined): string {
  return (value ?? "").replace(CONTROL, " ").replace(/\s{2,}/g, " ").trim();
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function titleOf(text: string): string {
  return clip(oneLine(text), 200);
}

function bodyOf(lines: ReadonlyArray<string | null | undefined>): string | null {
  const text = lines.filter((line): line is string => typeof line === "string" && line.trim() !== "").join("\n");
  return text ? clip(text, 2000) : null;
}

/** "Pat Rivera", or "a customer" / "A customer" at the start of a sentence. */
function customerWord(name: string | null | undefined, start: boolean): string {
  return oneLine(name) || (start ? "A customer" : "a customer");
}

/** An href pattern with {id} filled, URL-encoded (2a 7.10's rule). */
export function fillEstimateHref(pattern: string, id: string): string {
  return pattern.split("{id}").join(encodeURIComponent(id));
}

/**
 * The lead's price IN THE OFFICE EMAIL'S OWN FORM (review BO-3): "$480 –
 * $620", or "$59" when low equals high, before tax and in whole units, as
 * the customer saw it ("Estimate: $59, plus 7.25% sales tax.") and as the
 * office email's subject says it ("New lead: Pat Rivera, $59 (…)"); then
 * " + tax" when tax applies. The bell once said "$63.10" (the total, tax in)
 * for the lead the inbox called "$59": one lead, two prices.
 *
 * CONTRACT: 10.1 says "or the total when low equals high". The total is the
 * one figure neither the customer nor the office email showed, so the
 * pre-tax figure is used, the email's. A lead with no price yet (every line
 * "priced after a look", the range and total 0) reads "no price yet" rather
 * than "$0", which would look like a free job.
 */
export function formatEstimateRange(
  estimate: {
    readonly rangeLow: number;
    readonly rangeHigh: number;
    readonly total: number;
    readonly currency: string;
    readonly taxRateBp?: number;
  },
  locale: string,
): string {
  const money = { currency: estimate.currency || "USD", locale };
  if (estimate.rangeLow === 0 && estimate.rangeHigh === 0 && estimate.total === 0) return "no price yet";
  const whole = (cents: number) => formatMoney(cents, money, true);
  // The same text as comms.ts's `rangeText` (the office email's subject).
  const range = estimate.rangeLow === estimate.rangeHigh ? whole(estimate.rangeLow) : `${whole(estimate.rangeLow)} – ${whole(estimate.rangeHigh)}`;
  return (estimate.taxRateBp ?? 0) > 0 ? `${range} + tax` : range;
}

/** At most this many lines are listed in a lead's body; the rest are "and N more". */
const LEAD_LINES = 3;

// ---- the mapper ------------------------------------------------------------------

export interface EstimatorAlertsForOptions {
  /** Where an estimate opens: a pattern with {id}, e.g. "/app/estimates/{id}". */
  readonly hrefs: { readonly estimate: string };
  /** The business's locale (its settings'), for money. Default "en-US". */
  readonly locale?: string;
}

/**
 * The estimator's event → alert drafts (contract 10.1). An alert is written
 * exactly when the comms listener writes an office email
 * (`estimatorOfficeNotice`), and nothing else: staff-made changes alert
 * nobody, and a view, a send, a revision or a conversion is the office's own
 * doing.
 */
export function estimatorAlertsFor(event: EstimatorEvent, options: EstimatorAlertsForOptions): readonly EstimatorAlertDraft[] {
  const spec = estimatorOfficeNotice(event);
  if (!spec) return [];
  const locale = options.locale ?? "en-US";
  const estimate = event.data.estimate;
  const money = { currency: estimate.currency || "USD", locale };
  const number = oneLine(estimate.number);
  const base = {
    tenantId: event.tenantId,
    kind: spec.kind,
    href: fillEstimateHref(options.hrefs.estimate, estimate.id),
    dedupeKey: spec.dedupeKey,
    subject: { type: ESTIMATOR_ESTIMATE_SUBJECT, id: estimate.id },
    actorUserId: null,
    replyTo: estimate.customerEmail?.trim() || null,
  } as const;
  const note = oneLine(event.data.note);

  switch (spec.kind) {
    case "estimator.lead": {
      const lines = estimate.lines.slice(0, LEAD_LINES).map((line) => `${oneLine(line.description) || "Item"} × ${line.quantity}`);
      const more = estimate.lines.length - LEAD_LINES;
      const address = oneLine(estimate.jobAddress);
      const phone = oneLine(estimate.customerPhone);
      // The estimate's number, as the office email's subject carries it, so
      // the bell and the inbox are easy to match up (review BO-3).
      const reference = number ? ` (${number})` : "";
      return [
        {
          ...base,
          title: titleOf(`New estimate request: ${customerWord(estimate.customerName, false)}, ${formatEstimateRange(estimate, locale)}${reference}`),
          body: bodyOf([...lines, more > 0 ? `and ${more} more` : null, address || null, phone ? `Phone: ${phone}` : null]),
        },
      ];
    }
    case "estimator.quote.accepted":
      return [
        {
          ...base,
          title: titleOf(`${customerWord(estimate.customerName, true)} accepted quote ${number} (${formatMoney(estimate.total, money)})`),
          body: note ? bodyOf([`Their note: ${note}`]) : null,
        },
      ];
    case "estimator.quote.declined":
      return [
        {
          ...base,
          title: titleOf(`${customerWord(estimate.customerName, true)} declined quote ${number}`),
          body: note ? bodyOf([`Their note: ${note}`]) : null,
        },
      ];
    case "estimator.quote.expired":
      return [
        {
          ...base,
          title: titleOf(`Quote ${number} for ${customerWord(estimate.customerName, false)} lapsed unanswered`),
          body: null,
        },
      ];
    default:
      return [];
  }
}
