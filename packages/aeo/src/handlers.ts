import type { AnswerEngine } from "./engines.js";
import {
  AeoHttpError,
  CROSS_SITE_MESSAGE,
  errorResponse,
  INTERNAL_MESSAGE,
  isCrossSiteRequest,
  isIdShaped,
  json,
  MANAGE_FORBIDDEN_MESSAGE,
  NOT_HERE,
  readJsonBody,
  segmentsAfter,
  VIEW_FORBIDDEN_MESSAGE,
} from "./http.js";
import type { AeoPermission } from "./permissions.js";
import { AEO_ADMIN_ROUTE_PERMISSIONS, type AeoAdminRouteKind } from "./routes.js";
import { runMentionChecks, type MentionSpend } from "./runner.js";
import {
  addQuestion,
  AeoError,
  deactivateQuery,
  getProfile,
  getQuery,
  latestChecks,
  listChecks,
  listQueries,
  MAX_QUESTIONS,
  questionTrends,
  saveProfile,
  type AeoDb,
  type CheckRow,
  type ProfileInput,
  type QueryRow,
} from "./store.js";
import type { AeoErrorCodeWire, MentionCheckWire, MentionsOverviewWire, QuestionDetailWire, QuestionWire, RunResultWire, TrendWeekWire } from "./wire.js";

/**
 * A COMPANY'S AI MENTIONS (0.2): one fetch handler, every route under
 * `{mount}/v1/` (AEO_ADMIN_ROUTES):
 *
 *   // app/api/app/[tenantId]/ai-mentions/[...path]/route.ts
 *   const { handle } = createAeoHandlers({ db, resolveTenant, authorize, engine, spend });
 *   export { handle as GET, handle as POST };
 *
 * WHOSE COMPANY: the id in the PATH, asked of `authorize` on every call;
 * another company's question is "not found".
 *
 * WHAT IT COSTS, AND WHO SAYS NO: every answer is a paid AI call with web
 * search. Before any is asked: `admit` (the company's plan is open),
 * `rateLimit` (Check now pressed too often), and per question
 * `spend.reserve` (the company's month, its share of the site's day, the
 * site's daily ceiling — @adminigloo/ai's ledger). No `engine` (no key, or
 * --ai not installed): questions can still be kept, and Check now says
 * checking isn't switched on. An engine without `spend` is refused at
 * construction: an unmetered answer is never asked.
 */

export type AeoAuthorizeResult = boolean | { userId?: string | number | null } | Response;

/** The weekly job asks a question again only when its last answer is older than this. */
export const AEO_SCHEDULE_EVERY_MS = 6.5 * 24 * 60 * 60_000;

export interface CreateAeoHandlersOptions {
  db: AeoDb;
  tenantId?: string;
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  authorize: (req: Request, permission: AeoPermission, tenantId: string) => AeoAuthorizeResult | Promise<AeoAuthorizeResult>;
  /** The answer engine; null: checking isn't switched on here. */
  engine: AnswerEngine | null;
  /** The metering every answer goes through. Required with an engine. */
  spend?: MentionSpend;
  /** Why checking is off, in words, when `engine` is null. */
  offMessage?: string;
  /** May this company spend right now (its plan open)? true, or the sentence to refuse with. */
  admit?: (tenantId: string) => true | string | Promise<true | string>;
  /** Check now pressed too often? true, or the sentence to refuse with. */
  rateLimit?: (who: { tenantId: string; userId: string | null }) => true | string | Promise<true | string>;
  /** How many questions this company may track (its plan's): a number; null: up to MAX_QUESTIONS; undefined: MAX_QUESTIONS. */
  questionLimit?: (tenantId: string) => number | null | undefined | Promise<number | null | undefined>;
  /**
   * Is this company's month (or day) of checks used up? null when there's
   * room, else the sentence to show — read only, for the screen and to let
   * the weekly job skip a company without holding anything.
   */
  allowanceNotice?: (tenantId: string) => string | null | Promise<string | null>;
  /** Does a weekly job ask the questions again (runScheduled on a schedule)? The screen says when. Default false. */
  automatic?: boolean;
  /** What to suggest as the business's name before it has said (its company name). */
  suggestedProfile?: (tenantId: string) => { brand: string; domain?: string | null } | null | Promise<{ brand: string; domain?: string | null } | null>;
  /** One run's time, ms (default 45 seconds, inside a 60-second server function). */
  budgetMs?: number;
  callTimeoutMs?: number;
  onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
  now?: () => Date;
}

export type ScheduledMentionsOutcome =
  | { readonly ran: true; readonly checked: number; readonly cited: number; readonly failed: number; readonly waiting: number; readonly stopped: string | null }
  | { readonly ran: false; readonly reason: "off" | "closed" | "no_profile" | "nothing_due" | "used_up" };

export interface AeoHandlers {
  handle: (req: Request) => Promise<Response>;
  /** The weekly job's step for one company: ask the questions not answered this week. */
  runScheduled: (tenantId: string) => Promise<ScheduledMentionsOutcome>;
}

interface Matched {
  kind: AeoAdminRouteKind;
  id?: string;
}

function route(pathname: string, method: string): Matched | null {
  const parts = segmentsAfter(pathname, "/v1/");
  if (!parts) return null;
  const get = method === "GET" || method === "HEAD";
  const post = method === "POST";
  const [a, b, c] = parts;
  const n = parts.length;
  if (a === "mentions" && n === 1 && get) return { kind: "overview" };
  if (a === "profile" && n === 1 && post) return { kind: "profile" };
  if (a === "check" && n === 1 && post) return { kind: "check" };
  if (a === "questions") {
    if (n === 1 && post) return { kind: "question-add" };
    if (n === 2 && get) return { kind: "question", id: b as string };
    if (n === 3 && c === "remove" && post) return { kind: "question-remove", id: b as string };
    if (n === 3 && c === "check" && post) return { kind: "question-check", id: b as string };
  }
  return null;
}

function userIdOf(verdict: AeoAuthorizeResult): string | null {
  return typeof verdict === "object" && !(verdict instanceof Response) && verdict.userId != null && verdict.userId !== "" ? String(verdict.userId) : null;
}

const ERROR_STATUS: Record<AeoError["code"], { status: number; code: AeoErrorCodeWire }> = {
  invalid_input: { status: 400, code: "invalid" },
  not_found: { status: 404, code: "not_found" },
  limit_reached: { status: 409, code: "limit_reached" },
  no_profile: { status: 409, code: "no_profile" },
  off: { status: 409, code: "off" },
  closed: { status: 403, code: "closed" },
  rate_limited: { status: 429, code: "rate_limited" },
  allowance: { status: 429, code: "allowance" },
};

/** Only an http(s) address is ever sent to a screen as a link. */
function safeUrls(urls: readonly unknown[] | null | undefined): string[] {
  return (urls ?? []).filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u)).slice(0, 12);
}

function toCheckWire(row: CheckRow, engineLabel: (key: string) => string): MentionCheckWire {
  const failed = row.status === "failed";
  return {
    id: row.id,
    questionId: row.queryId,
    checkedAt: new Date(row.checkedAt).toISOString(),
    engine: engineLabel(row.engine),
    status: failed ? "failed" : "done",
    cited: row.cited,
    mentioned: row.mentioned,
    sourceCited: row.sourceCited,
    matchedOn: row.matchedOn,
    snippet: row.answerSnippet,
    sources: safeUrls(row.citedUrls),
    matchedUrl: row.matchedUrl && /^https?:\/\//i.test(row.matchedUrl) ? row.matchedUrl : null,
    competitorsNamed: (row.competitorsNamed ?? []).slice(0, 20),
    problem: failed ? (row.error === "The answer took too long." ? "The answer took too long. It's asked again next time." : "The AI assistant didn't answer this time. It's asked again next time.") : null,
  };
}

export function createAeoHandlers(options: CreateAeoHandlersOptions): AeoHandlers {
  if (!options.tenantId && !options.resolveTenant) throw new TypeError("createAeoHandlers needs `tenantId` (one site) or `resolveTenant` (one per company).");
  if (typeof options.authorize !== "function") throw new TypeError("createAeoHandlers needs `authorize`.");
  if (options.engine && !options.spend) {
    throw new TypeError("createAeoHandlers: an `engine` needs `spend` (reserve/settle/release): an unmetered AI answer is never asked.");
  }
  const { db, engine } = options;
  const now = options.now ?? (() => new Date());
  const label = (key: string) => (engine && key === engine.key ? engine.label : key === "claude" ? "Claude" : key);
  const offMessage = options.offMessage ?? "Checking AI answers isn't switched on here yet.";

  async function canManage(req: Request, tenantId: string): Promise<boolean> {
    const verdict = await options.authorize(req, "aeo.manage", tenantId);
    return verdict !== false && !(verdict instanceof Response);
  }

  async function questionCap(tenantId: string): Promise<number> {
    const limit = await options.questionLimit?.(tenantId);
    return limit === undefined || limit === null ? MAX_QUESTIONS : Math.max(0, Math.min(limit, MAX_QUESTIONS));
  }

  /** When the weekly job asks a question again: a week after its last answer, or within a day if it has none. */
  function nextAutomaticAt(last: CheckRow | undefined): string | null {
    if (!options.automatic) return null;
    const base = last ? new Date(last.checkedAt).getTime() + AEO_SCHEDULE_EVERY_MS : now().getTime();
    return new Date(Math.max(base, now().getTime()) + (last ? 0 : 86_400_000)).toISOString();
  }

  async function questionsOf(tenantId: string, only?: QueryRow[]): Promise<QuestionWire[]> {
    const queries = only ?? (await listQueries(db, tenantId));
    const ids = queries.map((q) => q.id);
    const [latest, trends] = await Promise.all([latestChecks(db, tenantId, ids), questionTrends(db, tenantId, { queryIds: ids, now: now() })]);
    return queries.map((q) => {
      const last = latest.get(q.id);
      const trend: TrendWeekWire[] = trends.get(q.id) ?? [];
      return {
        id: q.id,
        question: q.query,
        createdAt: new Date(q.createdAt).toISOString(),
        latest: last ? toCheckWire(last, label) : null,
        trend,
        nextAutomaticAt: nextAutomaticAt(last),
      };
    });
  }

  async function overview(req: Request, tenantId: string): Promise<MentionsOverviewWire> {
    const [profile, questions, manage, cap, notice] = await Promise.all([
      getProfile(db, tenantId),
      questionsOf(tenantId),
      canManage(req, tenantId),
      questionCap(tenantId),
      engine ? (options.allowanceNotice?.(tenantId) ?? null) : null,
    ]);
    const shownProfile = profile
      ? { brand: profile.brand, domain: profile.domain, aliases: profile.aliases ?? [], competitors: profile.competitors ?? [], updatedAt: new Date(profile.updatedAt).toISOString() }
      : null;
    // Before the business has said who it is: its company name, as the form's starting text (never saved as is).
    const suggested = !profile && manage ? ((await options.suggestedProfile?.(tenantId)) ?? null) : null;
    return {
      profile: shownProfile,
      suggested: suggested ? { brand: suggested.brand, domain: suggested.domain ?? null } : null,
      questions,
      canManage: manage,
      engine: engine ? { on: true, label: engine.label, message: null } : { on: false, label: null, message: offMessage },
      maxQuestions: cap,
      automatic: Boolean(options.automatic) && engine !== null,
      notice,
    };
  }

  async function run(tenantId: string, userId: string | null, trigger: "manual" | "schedule", queryIds?: readonly string[], dueOnly = false) {
    if (!engine || !options.spend) throw new AeoError("off", offMessage);
    const admitted = (await options.admit?.(tenantId)) ?? true;
    if (admitted !== true) throw new AeoError("closed", admitted);
    let lastCheckedAt: Map<string, Date> | undefined;
    if (dueOnly) {
      const queries = await listQueries(db, tenantId);
      const latest = await latestChecks(db, tenantId, queries.map((q) => q.id));
      lastCheckedAt = new Map([...latest.entries()].map(([id, row]) => [id, new Date(row.checkedAt)]));
    }
    return runMentionChecks({
      db,
      tenantId,
      engine,
      spend: options.spend,
      ...(queryIds ? { queryIds } : {}),
      ...(dueOnly && lastCheckedAt ? { lastCheckedAt, skipCheckedSince: new Date(now().getTime() - AEO_SCHEDULE_EVERY_MS) } : {}),
      trigger,
      userId,
      ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
      ...(options.callTimeoutMs !== undefined ? { callTimeoutMs: options.callTimeoutMs } : {}),
      now,
      onError: (error, context) => options.onError?.(error, { tenantId: context.tenantId, route: "engine" }),
    });
  }

  async function runNow(req: Request, tenantId: string, userId: string | null, queryIds?: readonly string[]): Promise<RunResultWire> {
    if (!engine) throw new AeoError("off", offMessage);
    const limited = (await options.rateLimit?.({ tenantId, userId })) ?? true;
    if (limited !== true) throw new AeoError("rate_limited", limited);
    const result = await run(tenantId, userId, "manual", queryIds);
    if (result.checked === 0 && result.failed === 0 && result.stopped !== null && !result.stopped.startsWith("Out of time")) {
      // Nothing was asked: the allowance said no before the first question.
      throw new AeoError("allowance", result.stopped);
    }
    return { ...result, overview: await overview(req, tenantId) };
  }

  async function dispatch(req: Request, match: Matched, tenantId: string, userId: string | null): Promise<Response> {
    switch (match.kind) {
      case "overview":
        return json(await overview(req, tenantId));
      case "profile": {
        const body = await readJsonBody(req);
        const saved = await saveProfile(db, tenantId, body as ProfileInput, userId);
        return json({
          profile: { brand: saved.brand, domain: saved.domain, aliases: saved.aliases ?? [], competitors: saved.competitors ?? [], updatedAt: new Date(saved.updatedAt).toISOString() },
        });
      }
      case "question-add": {
        const body = await readJsonBody(req);
        const added = await addQuestion(db, tenantId, typeof body.question === "string" ? body.question : "", userId, await questionCap(tenantId));
        const [wire] = await questionsOf(tenantId, [added]);
        return json({ question: wire }, 201);
      }
      case "question": {
        if (!isIdShaped(match.id)) return errorResponse("not_found", 404, NOT_HERE);
        const found = await getQuery(db, tenantId, match.id);
        if (!found) return errorResponse("not_found", 404, NOT_HERE);
        const [question] = await questionsOf(tenantId, [found]);
        const detail: QuestionDetailWire = { question: question!, checks: (await listChecks(db, tenantId, found.id, 50)).map((row) => toCheckWire(row, label)) };
        return json(detail);
      }
      case "question-remove": {
        if (!isIdShaped(match.id)) return errorResponse("not_found", 404, NOT_HERE);
        await readJsonBody(req);
        if (!(await deactivateQuery(db, tenantId, match.id))) return errorResponse("not_found", 404, NOT_HERE);
        return json({ removed: true });
      }
      case "question-check": {
        if (!isIdShaped(match.id)) return errorResponse("not_found", 404, NOT_HERE);
        await readJsonBody(req);
        if (!(await getQuery(db, tenantId, match.id))) return errorResponse("not_found", 404, NOT_HERE);
        return json(await runNow(req, tenantId, userId, [match.id]));
      }
      case "check": {
        await readJsonBody(req);
        return json(await runNow(req, tenantId, userId));
      }
    }
  }

  return {
    async handle(req: Request): Promise<Response> {
      let tenantId: string | null = null;
      let kind = "unknown";
      try {
        const match = route(new URL(req.url).pathname, req.method);
        if (!match) return errorResponse("not_found", 404, NOT_HERE);
        kind = match.kind;
        if (req.method === "POST" && isCrossSiteRequest(req)) return errorResponse("cross_site", 403, CROSS_SITE_MESSAGE);
        tenantId = options.tenantId ?? (await options.resolveTenant?.(req)) ?? null;
        if (!tenantId) return errorResponse("not_found", 404, NOT_HERE);
        const permission = AEO_ADMIN_ROUTE_PERMISSIONS[match.kind];
        const verdict = await options.authorize(req, permission, tenantId);
        if (verdict instanceof Response) return verdict;
        if (verdict === false) return errorResponse("forbidden", 403, permission === "aeo.manage" ? MANAGE_FORBIDDEN_MESSAGE : VIEW_FORBIDDEN_MESSAGE);
        return await dispatch(req, match, tenantId, userIdOf(verdict));
      } catch (error) {
        if (error instanceof AeoHttpError) return errorResponse(error.code, error.status, error.message);
        if (error instanceof AeoError) {
          const mapped = ERROR_STATUS[error.code];
          return errorResponse(mapped.code, mapped.status, error.message);
        }
        options.onError?.(error, { tenantId, route: kind });
        return errorResponse("internal", 500, INTERNAL_MESSAGE);
      }
    },

    async runScheduled(tenantId: string): Promise<ScheduledMentionsOutcome> {
      if (!engine) return { ran: false, reason: "off" };
      try {
        // A month (or day) already used up is skipped without holding anything.
        if ((await options.allowanceNotice?.(tenantId)) ?? null) return { ran: false, reason: "used_up" };
        const result = await run(tenantId, null, "schedule", undefined, true);
        if (result.checked === 0 && result.failed === 0 && result.waiting === 0) return { ran: false, reason: "nothing_due" };
        if (result.checked === 0 && result.failed === 0 && result.stopped !== null && !result.stopped.startsWith("Out of time")) {
          return { ran: false, reason: "used_up" };
        }
        return { ran: true, ...result };
      } catch (error) {
        if (error instanceof AeoError && error.code === "closed") return { ran: false, reason: "closed" };
        if (error instanceof AeoError && error.code === "no_profile") return { ran: false, reason: "no_profile" };
        throw error;
      }
    },
  };
}
