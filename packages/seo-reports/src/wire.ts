import type { CheckKind, CheckStatus, PageAudit, SeoCheck } from "./audit.js";

/**
 * WHAT THE SEARCH CHECK HANDLERS SEND (0.2), as plain JSON — read by the
 * `./ui` screen through its transport, and by a host app that draws the
 * report itself. Dates are ISO strings. Add fields, never rename them.
 */
export type SeoReportsErrorCodeWire =
  | "forbidden"
  | "not_found"
  | "invalid"
  | "limit_reached"
  | "running"
  | "closed"
  | "rate_limited"
  | "no_addresses"
  | "cross_site"
  | "internal";

export interface SeoReportsErrorWire {
  readonly error: { readonly code: SeoReportsErrorCodeWire; readonly message: string };
}

export interface SiteCheckSummaryWire {
  readonly id: string;
  /** "running", "done" or "failed" (the check broke on our side; it didn't count). */
  readonly status: "running" | "done" | "failed";
  /** "manual" or "schedule". */
  readonly trigger: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly score: number;
  readonly seoScore: number;
  readonly aeoScore: number;
  readonly pageCount: number;
  readonly passCount: number;
  readonly warnCount: number;
  readonly failCount: number;
  /** "pages" or "time" when the check stopped early; null when it read everything it found. */
  readonly stopped: string | null;
  readonly addresses: readonly string[];
}

/** One thing to do, with every place it was found. */
export interface WorkItemWire {
  /** The check's id ("page.title"). */
  readonly id: string;
  /** What to do, in plain words: "Give each page a clear title". */
  readonly todo: string;
  readonly why: string;
  /** "fail" (fix this) or "warn" (worth a look). */
  readonly status: Exclude<CheckStatus, "pass">;
  readonly kind: CheckKind;
  /** Where, and what was found there: a page's address, or null for the whole site. */
  readonly evidence: readonly { readonly page: string | null; readonly detail: string }[];
}

export interface SiteCheckWire extends SiteCheckSummaryWire {
  /** The worklist: what failed first, then what's worth a look, the most widespread first. */
  readonly worklist: readonly WorkItemWire[];
  /** What passed everywhere, as plain to-dos already done. */
  readonly done: readonly string[];
  readonly siteChecks: readonly SeoCheck[];
  readonly pages: readonly PageAudit[];
}

export interface SearchCheckOverviewWire {
  /** This company's checks, newest first. */
  readonly checks: readonly SiteCheckSummaryWire[];
  /** The newest finished check in full; null before the first. */
  readonly latest: SiteCheckWire | null;
  /** May this person press "Check now"? */
  readonly canRun: boolean;
  /** What a check reads: "Our website — greenacres.com". Empty: nothing to check yet. */
  readonly addresses: readonly string[];
  /** The same, as a sentence: "Your pages on Snowplow (app.snowplow.test/t/green-acres) and your website “Green Acres” (greenacres.com)". */
  readonly addressSentence: string;
  /** Addresses not checked yet, each with why ("We'll check this site once your visits line is working."). */
  readonly waiting: readonly string[];
  /** When the weekly check runs next (about); null when nothing checks automatically here. */
  readonly nextAutomaticAt: string | null;
  /** "Check now" presses this month and the plan's limit on them (the weekly check is free). */
  readonly month: { readonly used: number; readonly limit: number | null; readonly resetsAt: string };
  /** A sentence to show above the button (nothing to check yet, the month used up); null for none. */
  readonly notice: string | null;
}
