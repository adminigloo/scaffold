/**
 * WHAT THE AI MENTIONS HANDLERS SEND (0.2), as plain JSON — read by the `./ui`
 * screen through its transport, or by a host app that draws it itself.
 * Dates are ISO strings; costs are never sent. Add fields, never rename them.
 */
export type AeoErrorCodeWire =
  | "forbidden"
  | "not_found"
  | "invalid"
  | "limit_reached"
  | "no_profile"
  | "off"
  | "closed"
  | "rate_limited"
  | "allowance"
  | "cross_site"
  | "internal";

export interface AeoErrorWire {
  readonly error: { readonly code: AeoErrorCodeWire; readonly message: string };
}

export interface ProfileWire {
  readonly brand: string;
  readonly domain: string | null;
  readonly aliases: readonly string[];
  readonly competitors: readonly string[];
  readonly updatedAt: string;
}

/** One answer, as CODE read it. */
export interface MentionCheckWire {
  readonly id: string;
  readonly questionId: string;
  readonly checkedAt: string;
  /** "Claude". */
  readonly engine: string;
  /** "done", or "failed": the answer didn't come. */
  readonly status: "done" | "failed";
  /** Named, or its own website cited. */
  readonly cited: boolean;
  /** Named in the answer's words. */
  readonly mentioned: boolean;
  /** Its own website among the sources. */
  readonly sourceCited: boolean;
  /** How: "brand", "domain", "alias", "source", or null. */
  readonly matchedOn: string | null;
  /** The answer's words around the mention (or its opening, when it wasn't named). Plain text, to show as a quote. */
  readonly snippet: string | null;
  /** The sources it cited (http and https only). */
  readonly sources: readonly string[];
  /** The source on the business's own website, when one was cited. */
  readonly matchedUrl: string | null;
  readonly competitorsNamed: readonly string[];
  /** For a failed one: a plain sentence. */
  readonly problem: string | null;
}

export interface TrendWeekWire {
  readonly week: string;
  readonly checks: number;
  readonly cited: number;
}

export interface QuestionWire {
  readonly id: string;
  readonly question: string;
  readonly createdAt: string;
  readonly latest: MentionCheckWire | null;
  /** The last eight weeks, oldest first. */
  readonly trend: readonly TrendWeekWire[];
  /** When the weekly check asks it again (about); null when nothing asks automatically here. */
  readonly nextAutomaticAt: string | null;
}

export interface MentionsOverviewWire {
  /** Who the business is, as answers would name it; null until it's been said. */
  readonly profile: ProfileWire | null;
  /** Before it has: a starting point for the form (the company's own name); null otherwise. */
  readonly suggested: { readonly brand: string; readonly domain: string | null } | null;
  readonly questions: readonly QuestionWire[];
  /** May this person change the questions, the profile, and press Check now? */
  readonly canManage: boolean;
  /** Is checking switched on here (an engine wired, with a key)? */
  readonly engine: { readonly on: boolean; readonly label: string | null; readonly message: string | null };
  /** How many questions this business may track (its plan's). */
  readonly maxQuestions: number;
  /** Are the questions asked again automatically each week? */
  readonly automatic: boolean;
  /** The month's (or day's) checks used up, in a sentence; null while there's room. */
  readonly notice: string | null;
}

export interface QuestionDetailWire {
  readonly question: QuestionWire;
  /** Every answer kept, newest first (up to 50). */
  readonly checks: readonly MentionCheckWire[];
}

export interface RunResultWire {
  readonly checked: number;
  readonly cited: number;
  readonly failed: number;
  readonly waiting: number;
  /** Why it stopped early, in words; null when every question was asked. */
  readonly stopped: string | null;
  /** The overview after the run. */
  readonly overview: MentionsOverviewWire;
}
