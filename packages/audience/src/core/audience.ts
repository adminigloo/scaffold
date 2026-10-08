import { allMatches, bestReason, markScopeOf, ruleMatchesUser, USER_KINDS } from "./classify.js";
import {
  clientIpFrom,
  DEFAULT_TEST_HEADER,
  DEVICE_LINK_PARAM,
  headerValue,
  isPrivacyOptOut,
  resolveDefaults,
  type AudienceDefaults,
} from "./defaults.js";
import { AudienceError } from "./errors.js";
import { assertSecret, signDeviceToken, testHeaderValueFor, userKeyFor, verifyDeviceToken } from "./keys.js";
import {
  DEFAULT_REASON_LABELS,
  isRetroactiveKind,
  KIND_INFO,
  REASON_FOR_KIND,
  SUBJECT_KINDS,
  type AudienceReason,
  type MarkSource,
  type RuleKind,
  type SubjectKind,
} from "./labels.js";
import { createMasker, maskEmail, maskEmailsIn, maskNetwork, maskRule, maskRun } from "./mask.js";
import { cleanId, normalizeHost, normalizeRuleInput, RuleValueError } from "./normalize.js";
import {
  countedSubjectParts,
  countedVisitorParts,
  DEFAULT_MARKS_TABLE,
  renderSql,
  type CountedOptions,
  type CountedVisitorOptions,
  type RawSql,
  type RenderOptions,
  type SqlPart,
} from "./sql.js";
import type { AudienceStore, RowCount } from "./store.js";
import type {
  ActorFacts,
  AudienceClassification,
  AudienceMatch,
  AudienceRule,
  AudienceRuleInput,
  AudienceRun,
  AudienceUser,
  AudienceWindow,
  ExcludedBreakdown,
  HeadersLike,
  NewAudienceMark,
  RowsSource,
} from "./types.js";

/**
 * `createAudience` — the one object an app holds. It reads and writes only
 * through an `AudienceStore`, so it runs the same over the Drizzle Postgres
 * store, a MySQL store, or an in-memory one in a test.
 *
 * Two paths, kept apart on purpose:
 *   - INTAKE (`observe`, `classifyActor`): on the hot path of every beacon and
 *     server event. Never throws — a broken store degrades to "counted", it
 *     never breaks a page — and writes at most a few idempotent rows, cached
 *     so a staff member's 200 page views write their mark once.
 *   - ADMIN (`preview`, `addRule`, `apply`, `remove`, `backfill`, `maintain`):
 *     deliberate, audited (every write that changes numbers leaves a run
 *     row), and loud when misconfigured.
 */

export type LinkMode = "internal-only" | "pseudonymous";

/** What the app's `isInternal` returns: a label ("staff") means internal; false/null counts. */
export type InternalVerdict = string | boolean | null | undefined;

export type UsersSource<TUser> = Iterable<TUser> | AsyncIterable<TUser> | Promise<Iterable<TUser>>;

export interface AudienceAnnotation {
  /** When it happened. */
  at: Date;
  /** The UTC day, YYYY-MM-DD — what a trend chart pins a note to. */
  day: string;
  /** "Internal rule added (staff domain riddlergo.com): 312 sessions excluded back to 2026-07-02" */
  label: string;
  action: AudienceRun["action"];
  ruleId: string | null;
  runId: string;
}

export interface CreateAudienceOptions<TUser extends AudienceUser = AudienceUser> {
  store: AudienceStore;
  /** AUDIENCE_SECRET — 32+ characters. Keys link rows and signs device links. */
  secret: string;
  /**
   * Secrets used before the current one. Rotating AUDIENCE_SECRET would
   * otherwise orphan every visitor→user link: a person rule could no longer
   * find devices linked before the rotation. Links written under these are
   * still READ (new links use `secret`). Device links are verified with the
   * current secret only, so a rotation also revokes every device link.
   */
  previousSecrets?: readonly string[];
  /**
   * How long the app's visitor id lives. "stable" (default): a first-party
   * cookie (Riddler Go's 2-year `rg_visitor`). "rotating": a cookieless key
   * that changes daily (@adminigloo/analytics 0.1). With rotating ids a
   * browser cannot be marked for good, so `markVisitor` and device links
   * refuse, and preview says how little of a person's past a rule reaches.
   */
  visitorIds?: "stable" | "rotating";
  /**
   * Default "default". Every row the package writes carries it, and every
   * read of its own tables filters by it. The APP's sessions table is filtered
   * only by `sessions.where`: when that table is shared by several tenants or
   * environments, set `where` (`{ tenant_id: "site" }`) or preview and the
   * breakdown will count other tenants' rows.
   */
  tenantId?: string;
  /** The rule in code: a label ("staff") means internal. For Riddler Go, `platformRole ∈ {super, staff, analytics}`. */
  isInternal?: (user: TUser) => InternalVerdict | Promise<InternalVerdict>;
  /** One sentence describing `isInternal`, shown read-only in the admin panel. */
  codeRule?: string | null;
  /**
   * The app's users, for rules that name people. Return everyone (the package
   * re-checks each user against the rule), or narrow by the `rule` hint.
   * `rule` is null when several rules are resolved in one pass.
   */
  listUsers?: (query: { rule: AudienceRule | null }) => UsersSource<TUser>;
  /** Look one user up by id — lets `observe({ userId })` run the callback and email rules. */
  getUser?: (userId: string) => Promise<TUser | null | undefined>;
  /** How long intake reuses a `getUser` answer per instance. Default 60 000 ms; 0 turns it off. */
  userCacheMs?: number;
  /**
   * "internal-only" (default): a visitor→user link is written only for signed-in
   * INTERNAL users. "pseudonymous": for every signed-in visitor, so a person
   * named later reaches their anonymous past. Both store an HMAC, never the id.
   */
  link?: LinkMode;
  /** How long active rules are cached per instance. Default 60 000 ms. */
  rulesCacheMs?: number;
  /** Zero-config exclusions; `false` turns them all off. */
  defaults?: Partial<AudienceDefaults> | false;
  /** Fold Gmail dots and +tags when comparing exact email rules. Default true. */
  foldGmail?: boolean;
  /** Hosts that ARE production, declared in code (on top of `host` rules). */
  productionHosts?: readonly string[];
  /**
   * The smoke-test header. Default name `x-aig-audience`; the default VALUE
   * is derived from the secret (read it from `audience.testHeader`), so it is
   * not a public string. Set your own value, or false to ignore the header.
   */
  testHeader?: { name?: string; value?: string } | false;
  /** The app's sessions table — what preview, apply and the breakdown count. */
  sessions?: RowsSource & { castToText?: boolean };
  /** Unit word for the breakdown line. Default "sessions". */
  unit?: string;
  /** Record a dated note (Riddler Go: an `analytics_annotations` row). Errors are reported, not thrown. */
  annotate?: (annotation: AudienceAnnotation) => void | Promise<void>;
  /** Told about intake failures (observe never throws). Default: console.warn. */
  onError?: (error: unknown, where: string) => void;
  /** The clock; inject in tests. */
  now?: () => Date;
  /** Root entry wires the @adminigloo/license check through this. */
  licenseGate?: () => { ok: boolean; reason: string };
}

/** Who/what is acting — any subset. */
export interface ActorInput<TUser extends AudienceUser = AudienceUser> {
  user?: TUser | null;
  userId?: string | number | null;
  email?: string | null;
  orgId?: string | null;
  orgIds?: readonly string[] | null;
  eventId?: string | null;
  orderId?: string | null;
  /** With a visitor id, a verdict about the PERSON marks that visitor (classifyActor and observe alike). */
  visitorId?: string | null;
  /**
   * The app's session (visit) id. A verdict about this one visit — automation,
   * a network or host rule, a test event or order — marks the SESSION, not the
   * whole device. Without it those reasons fall back to marking the visitor
   * (except event and order, which then mark nothing at intake).
   */
  sessionId?: string | number | null;
  /**
   * The request's headers. Read for Global Privacy Control / Do Not Track
   * (and, in `observe`, the user agent, x-forwarded-for and the smoke-test
   * header). A visitor→user link is written ONLY when the call says the
   * browser did not opt out: pass `headers`, or `privacyOptOut`.
   */
  headers?: HeadersLike | null;
  /** The app's own privacy verdict, when it has no headers to pass. true: never linked. */
  privacyOptOut?: boolean | null;
}

/** One beacon (or one server event). */
export interface ObserveInput<TUser extends AudienceUser = AudienceUser> extends ActorInput<TUser> {
  visitorId: string | null | undefined;
  /** The page URL; its host is checked. */
  url?: string | null;
  host?: string | null;
  userAgent?: string | null;
  /** Checked against network rules in memory, then dropped. Undefined: read from x-forwarded-for when a network rule exists. */
  ip?: string | null;
  nonProduction?: boolean | null;
  webdriver?: boolean | null;
}

export interface PreviewWindow {
  key: "30d" | "90d" | "all";
  label: string;
  from: Date | null;
  to: Date;
  before: { sessions: number; visitors: number };
  after: { sessions: number; visitors: number };
  excluded: { sessions: number; visitors: number };
  earliest: Date | null;
}

export interface SubjectCounts {
  users: number;
  visitors: number;
  orgs: number;
  events: number;
  orders: number;
}

export interface AudiencePreview {
  rule: ReturnType<typeof normalizeRuleInput>;
  reason: AudienceReason;
  retroactive: boolean;
  subjects: SubjectCounts;
  alreadyExcluded: SubjectCounts;
  windows: PreviewWindow[];
  limits: string[];
  duplicateOf: string | null;
}

export interface ApplyResult {
  rule: AudienceRule;
  subjects: SubjectCounts;
  /** Marks actually written (0 on a second apply). */
  subjectsChanged: number;
  /** Sessions newly excluded; null without a `sessions` source. */
  sessionsAffected: number | null;
  from: Date | null;
  to: Date | null;
  /** The sentence for the app's annotation ("…excluded back to <date>"). */
  annotation: string;
  /**
   * The run row. Null when a repeat apply found nothing new: a retried or
   * double-clicked apply writes no second run row and no second annotation.
   */
  run: AudienceRun | null;
}

export interface RemoveResult {
  rule: AudienceRule;
  marksCleared: number;
  /** Sessions counted again; null without a `sessions` source. */
  sessionsRestored: number | null;
  annotation: string;
  /** Null when the rule was already removed and nothing was left to clear (a retried remove). */
  run: AudienceRun | null;
}

export interface BackfillCandidate<TUser extends AudienceUser = AudienceUser> {
  subjectKind: SubjectKind;
  subjectId: string;
  /** A verdict the adapter already made… */
  reason?: AudienceReason;
  /** …or the actor behind this subject, for the package to classify. */
  actor?: ActorInput<TUser>;
}

export interface BackfillContext<TUser extends AudienceUser = AudienceUser> {
  tenantId: string;
  /** The package's verdict on an actor (callback + rules), without writing anything. */
  classify(actor: ActorInput<TUser>): Promise<AudienceClassification | null>;
}

export interface BackfillAdapter<TUser extends AudienceUser = AudienceUser> {
  /** Shown in the run history ("checkout events → orders"). */
  name: string;
  candidates(ctx: BackfillContext<TUser>): UsersSource<BackfillCandidate<TUser>>;
}

export interface BackfillResult {
  name: string;
  dryRun: boolean;
  /** Candidates the adapter yielded. */
  candidates: number;
  /** Of those, judged internal. */
  internal: number;
  byReason: Partial<Record<AudienceReason, number>>;
  /**
   * Subjects newly excluded: those with no active mark before this run. The
   * SAME measure in a dry run and a real one, so the number reviewed before
   * applying is the number the run row records.
   */
  subjectsChanged: number;
  /** Mark rows actually written (a subject can get several, one per matching rule). 0 in a dry run. */
  marksWritten: number;
  sessionsAffected: number | null;
  run: AudienceRun | null;
}

export interface MaintainResult {
  rulesApplied: number;
  roleUsers: number;
  subjectsChanged: number;
  /** Active marks whose rule had been removed, cleared (an instance that had not yet seen the removal wrote them). */
  orphansCleared: number;
  /** With `pruneRoleMarks`: role marks cleared from people the code rule no longer calls internal, and their devices. */
  roleMarksCleared: number;
  run: AudienceRun | null;
}

export interface AudienceViewModel {
  rules: AudienceRule[];
  runs: AudienceRun[];
  codeRule: string | null;
  linkMode: LinkMode;
  masked: boolean;
}

const DAY = 86_400_000;
const RECENT_TTL = 10 * 60_000;
const RECENT_MAX = 10_000;
const BATCH = 500;

export type AudienceCore<TUser extends AudienceUser = AudienceUser> = ReturnType<typeof createAudienceCore<TUser>>;

export function createAudienceCore<TUser extends AudienceUser = AudienceUser>(options: CreateAudienceOptions<TUser>) {
  assertSecret(options.secret);
  const store = options.store;
  const secret = options.secret;
  const previousSecrets = [...(options.previousSecrets ?? [])];
  previousSecrets.forEach((old, i) => assertSecret(old, `previousSecrets[${i}]`));
  const tenantId = options.tenantId ?? "default";
  const linkMode: LinkMode = options.link ?? "internal-only";
  if (linkMode !== "internal-only" && linkMode !== "pseudonymous") {
    throw new Error(`@adminigloo/audience: link must be "internal-only" or "pseudonymous" (got ${JSON.stringify(linkMode)}).`);
  }
  const visitorIdMode = options.visitorIds ?? "stable";
  const rulesCacheMs = options.rulesCacheMs ?? 60_000;
  const userCacheMs = options.userCacheMs ?? 60_000;
  const defaults = resolveDefaults(options.defaults);
  const foldGmail = options.foldGmail ?? true;
  const productionHosts = options.productionHosts ?? [];
  const testHeader =
    options.testHeader === false
      ? null
      : {
          name: options.testHeader?.name ?? DEFAULT_TEST_HEADER.name,
          value: options.testHeader?.value ?? testHeaderValueFor(secret, tenantId),
        };
  const sessions = options.sessions ?? null;
  const unit = options.unit ?? "sessions";
  const marksTable = store.marksTable ?? DEFAULT_MARKS_TABLE;
  const now = options.now ?? (() => new Date());
  const report =
    options.onError ??
    ((error: unknown, where: string) => {
      console.warn(`[@adminigloo/audience] ${where}:`, error instanceof Error ? error.message : error);
    });

  // ---------------------------------------------------------------- caches

  let ruleCache: { at: number; rules: AudienceRule[] } | null = null;
  let rulePending: Promise<AudienceRule[]> | null = null;
  /**
   * Bumped by `invalidate()`. A load that started before a rule change must
   * not write its (now stale) answer into the cache when it lands after it.
   */
  let ruleGeneration = 0;

  function activeRules(): Promise<AudienceRule[]> {
    const at = Date.now();
    if (ruleCache && at - ruleCache.at < rulesCacheMs) return Promise.resolve(ruleCache.rules);
    if (rulePending) return rulePending;
    const generation = ruleGeneration;
    const load: Promise<AudienceRule[]> = Promise.resolve()
      .then(() => store.listRules(tenantId))
      .then((rules) => {
        if (generation === ruleGeneration) ruleCache = { at: Date.now(), rules };
        return rules;
      })
      .finally(() => {
        if (rulePending === load) rulePending = null;
      });
    rulePending = load;
    return load;
  }

  /** Rules for the intake path: a failing store means "no stored rules", never an exception. */
  async function activeRulesSafe(): Promise<AudienceRule[]> {
    try {
      return await activeRules();
    } catch (error) {
      report(error, "loading rules");
      return ruleCache?.rules ?? [];
    }
  }

  const recent = new Map<string, number>();
  function seenRecently(key: string): boolean {
    const at = recent.get(key);
    if (at !== undefined && Date.now() - at < RECENT_TTL) return true;
    return false;
  }
  function remember(key: string): void {
    recent.delete(key);
    recent.set(key, Date.now());
    if (recent.size > RECENT_MAX) {
      const oldest = recent.keys().next().value;
      if (oldest !== undefined) recent.delete(oldest);
    }
  }

  /** Intake's `getUser` answers, per instance, for `userCacheMs`: one lookup per person per minute, not per beacon. */
  const userCache = new Map<string, { at: number; user: TUser | null }>();

  function invalidate(): void {
    ruleGeneration += 1;
    ruleCache = null;
    rulePending = null;
    recent.clear();
    userCache.clear();
  }

  /** Every key a user's links may be stored under: the current secret's first, then each previous secret's. */
  function lookupKeys(userId: string): string[] {
    return [secret, ...previousSecrets].map((each) => userKeyFor(each, tenantId, userId));
  }

  /** userKey → userId for a set of users, under every secret. */
  function keysForUsers(userIds: Iterable<string>): Map<string, string> {
    const out = new Map<string, string>();
    for (const userId of userIds) for (const key of lookupKeys(userId)) out.set(key, userId);
    return out;
  }

  async function visitorsOf(userIds: Iterable<string>): Promise<Map<string, Set<string>>> {
    const keyToUser = keysForUsers(userIds);
    const keys = [...keyToUser.keys()];
    const out = new Map<string, Set<string>>();
    for (let i = 0; i < keys.length; i += BATCH) {
      for (const { userKey, visitorId } of await store.visitorsForUserKeys(tenantId, keys.slice(i, i + BATCH))) {
        const userId = keyToUser.get(userKey);
        if (!userId) continue;
        const set = out.get(userId) ?? new Set<string>();
        set.add(visitorId);
        out.set(userId, set);
      }
    }
    return out;
  }

  let warnedSessionsId = false;

  function gate(): void {
    const decision = options.licenseGate?.();
    if (decision && !decision.ok) throw new AudienceError("unlicensed", decision.reason);
  }

  // ---------------------------------------------------------------- facts

  async function resolveUser(input: ActorInput<TUser>, safe: boolean): Promise<TUser | null> {
    if (input.user) return input.user;
    const userId = cleanId(input.userId);
    if (userId && options.getUser) {
      if (safe && userCacheMs > 0) {
        const hit = userCache.get(userId);
        if (hit && Date.now() - hit.at < userCacheMs) return hit.user;
      }
      try {
        const user = (await options.getUser(userId)) ?? null;
        if (safe && userCacheMs > 0) {
          userCache.set(userId, { at: Date.now(), user });
          if (userCache.size > RECENT_MAX) {
            const oldest = userCache.keys().next().value;
            if (oldest !== undefined) userCache.delete(oldest);
          }
        }
        return user;
      } catch (error) {
        if (!safe) throw error;
        report(error, "getUser");
      }
    }
    return null;
  }

  async function verdictFor(user: TUser | null, safe: boolean): Promise<string | null> {
    if (!user || !options.isInternal) return null;
    try {
      const verdict = await options.isInternal(user);
      if (typeof verdict === "string") return verdict.trim() || null;
      return verdict === true ? "internal (app rule)" : null;
    } catch (error) {
      if (!safe) throw error;
      report(error, "isInternal");
      return null;
    }
  }

  function actorFacts(input: ActorInput<TUser>, user: TUser | null, roleLabel: string | null): ActorFacts {
    const orgIds = [...(user?.orgIds ?? []), ...(input.orgIds ?? []), ...(input.orgId ? [input.orgId] : [])]
      .map((orgId) => cleanId(orgId))
      .filter((orgId): orgId is string => orgId !== null);
    return {
      visitorId: cleanId(input.visitorId),
      sessionId: cleanId(input.sessionId),
      userId: cleanId(user?.id) ?? cleanId(input.userId),
      email: user?.email ?? input.email ?? null,
      orgIds,
      eventId: cleanId(input.eventId),
      orderId: cleanId(input.orderId),
      roleLabel,
    };
  }

  function requestFacts(input: ObserveInput<TUser>, rules: readonly AudienceRule[]): ActorFacts {
    const headers = input.headers ?? null;
    let host = normalizeHost(input.host ?? null);
    if (!host && input.url) host = normalizeHost(input.url);
    if (!host) host = normalizeHost(headerValue(headers, "x-forwarded-host") ?? headerValue(headers, "host"));
    const needsIp = rules.some((rule) => rule.kind === "network");
    const ip = input.ip !== undefined ? input.ip : needsIp ? clientIpFrom(headers) : null;
    return {
      host,
      userAgent: input.userAgent ?? headerValue(headers, "user-agent"),
      ip: needsIp ? ip : null,
      nonProduction: input.nonProduction ?? null,
      webdriver: input.webdriver ?? null,
      testHeader: testHeader ? headerValue(headers, testHeader.name)?.trim() === testHeader.value : false,
    };
  }

  function classifyFacts(facts: ActorFacts, rules: readonly AudienceRule[]): AudienceClassification | null {
    const all = allMatches(facts, { rules, defaults, foldGmail, productionHosts });
    const best = all[0];
    return best ? { ...best, all } : null;
  }

  /**
   * The marks one verdict implies for one subject: a mark per matching stored
   * rule (so removing one rule leaves the others standing) plus one for the
   * best match no rule owns (a default, the callback, a flag).
   */
  function marksFor(
    subjectKind: SubjectKind,
    subjectId: string,
    matches: readonly AudienceMatch[],
    rules: readonly AudienceRule[],
    source: MarkSource,
    by: string | null,
    at: Date,
  ): NewAudienceMark[] {
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    const out: NewAudienceMark[] = [];
    const seenRules = new Set<string>();
    let unowned: AudienceMatch | null = null;
    for (const match of matches) {
      if (match.ruleId === null) {
        if (!unowned) unowned = match;
        continue;
      }
      if (seenRules.has(match.ruleId)) continue;
      seenRules.add(match.ruleId);
      out.push({
        tenantId,
        subjectKind,
        subjectId,
        reason: match.reason,
        ruleId: match.ruleId,
        source,
        markedBy: by,
        markedAt: at,
        appliesFrom: byId.get(match.ruleId)?.appliesFrom ?? null,
      });
    }
    if (unowned) {
      out.push({
        tenantId,
        subjectKind,
        subjectId,
        reason: unowned.reason,
        ruleId: null,
        source,
        markedBy: by,
        markedAt: at,
        appliesFrom: null,
      });
    }
    return out;
  }

  function markKey(mark: NewAudienceMark): string {
    return `m|${mark.subjectKind}|${mark.subjectId}|${mark.ruleId ?? mark.reason}`;
  }

  /** Insert marks not written recently by this instance; never throws. */
  async function writeIntakeMarks(marks: NewAudienceMark[]): Promise<void> {
    const fresh = marks.filter((mark) => !seenRecently(markKey(mark)));
    if (!fresh.length) return;
    try {
      await store.insertMarks(fresh);
      for (const mark of fresh) remember(markKey(mark));
    } catch (error) {
      report(error, "writing an intake mark");
    }
  }

  async function writeLink(visitorId: string, userId: string, at: Date): Promise<void> {
    const userKey = userKeyFor(secret, tenantId, userId);
    const key = `l|${visitorId}|${userKey}`;
    if (seenRecently(key)) return;
    try {
      await store.upsertLink(tenantId, visitorId, userKey, at);
      remember(key);
    } catch (error) {
      report(error, "writing a visitor link");
    }
  }

  // ---------------------------------------------------------------- intake

  async function intake(
    input: ObserveInput<TUser> | ActorInput<TUser>,
    withRequest: boolean,
  ): Promise<AudienceClassification | null> {
    const rules = await activeRulesSafe();
    const user = await resolveUser(input, true);
    const roleLabel = await verdictFor(user, true);
    const facts: ActorFacts = {
      ...actorFacts(input, user, roleLabel),
      ...(withRequest ? requestFacts(input as ObserveInput<TUser>, rules) : {}),
    };
    const verdict = classifyFacts(facts, rules);
    const at = now();
    const visitorId = facts.visitorId ?? null;
    const sessionId = facts.sessionId ?? null;
    const userId = facts.userId ?? null;

    if (verdict) {
      // Each reason marks what it is about (see `markScopeOf`): a person's
      // device carries all of its history; one visit's facts mark that visit.
      const onVisitor: AudienceMatch[] = [];
      const onSession: AudienceMatch[] = [];
      for (const match of verdict.all) {
        const scope = markScopeOf(match.reason);
        if (scope === "person" || scope === "device") onVisitor.push(match);
        else if (scope === "visit") (sessionId ? onSession : onVisitor).push(match);
        else if (scope === "subject" && sessionId) onSession.push(match);
      }
      if (visitorId && onVisitor.length) await writeIntakeMarks(marksFor("visitor", visitorId, onVisitor, rules, "ingest", null, at));
      if (sessionId && onSession.length) {
        if (sessions && sessions.id === undefined && !warnedSessionsId) {
          warnedSessionsId = true;
          report(
            new Error("a session was marked, but `sessions.id` is not configured, so previews, apply and the breakdown cannot see session marks"),
            "configuration",
          );
        }
        await writeIntakeMarks(marksFor("session", sessionId, onSession, rules, "ingest", null, at));
      }
    }
    const personal = verdict ? verdict.all.filter((match) => match.personal) : [];
    if (personal.length && userId) {
      await writeIntakeMarks(marksFor("user", userId, personal, rules, "ingest", null, at));
    }
    // A link is written only when the call SAYS the browser did not opt out
    // (headers to read, or the app's own verdict). Unknown means no link.
    const optOut = typeof input.privacyOptOut === "boolean" ? input.privacyOptOut : input.headers ? isPrivacyOptOut(input.headers) : null;
    if (visitorId && userId && optOut === false) {
      if (linkMode === "pseudonymous" || personal.length > 0) await writeLink(visitorId, userId, at);
    }
    return verdict;
  }

  /**
   * One beacon: classify the visit and, when it is internal, mark the visitor
   * (and the user, for a personal reason). Returns the winning reason or null.
   * The IP is matched in memory and dropped; no request fact is stored.
   */
  async function observe(input: ObserveInput<TUser>): Promise<AudienceReason | null> {
    try {
      return (await intake(input, true))?.reason ?? null;
    } catch (error) {
      report(error, "observe");
      return null;
    }
  }

  /**
   * A server-side actor (a funnel event, a purchase): is this user / org /
   * event / order internal? With `visitorId`, an internal verdict marks that
   * visitor — the event is still written by the app, and simply stops counting.
   */
  async function classifyActor(input: ActorInput<TUser>): Promise<AudienceClassification | null> {
    try {
      return await intake(input, false);
    } catch (error) {
      report(error, "classifyActor");
      return null;
    }
  }

  // ---------------------------------------------------------------- subjects

  interface Subjects {
    users: Set<string>;
    visitors: Set<string>;
    orgs: Set<string>;
    events: Set<string>;
    orders: Set<string>;
  }

  const emptySubjects = (): Subjects => ({
    users: new Set(),
    visitors: new Set(),
    orgs: new Set(),
    events: new Set(),
    orders: new Set(),
  });

  async function* iterate<T>(source: UsersSource<T>): AsyncGenerator<T> {
    const resolved = await source;
    if (Symbol.asyncIterator in (resolved as object)) {
      for await (const item of resolved as AsyncIterable<T>) yield item;
    } else {
      for (const item of resolved as Iterable<T>) yield item;
    }
  }

  /**
   * Who each rule picks out, for several rules at once: ONE walk of the app's
   * users serves every person rule, then one links lookup turns users into
   * their devices.
   */
  async function resolveSubjects(rules: readonly AudienceRule[]): Promise<{ byRule: Map<string, Subjects>; limits: string[] }> {
    const byRule = new Map<string, Subjects>();
    const limits: string[] = [];
    for (const rule of rules) byRule.set(rule.id, emptySubjects());

    const personRules = rules.filter((rule) => USER_KINDS.has(rule.kind));
    const needsListing = personRules.filter((rule) => rule.kind !== "user");
    for (const rule of personRules) if (rule.kind === "user") byRule.get(rule.id)!.users.add(rule.value);

    let sawOrgIds = false;
    if (needsListing.length && options.listUsers) {
      const hint = needsListing.length === 1 ? needsListing[0]! : null;
      for await (const user of iterate(options.listUsers({ rule: hint }))) {
        // A numeric id (Road Rally) is its digits; junk is skipped.
        const userId = user ? cleanId(user.id) : null;
        if (!user || !userId) continue;
        if (Array.isArray(user.orgIds)) sawOrgIds = true;
        for (const rule of needsListing) if (ruleMatchesUser(rule, user, foldGmail)) byRule.get(rule.id)!.users.add(userId);
      }
    } else if (needsListing.length) {
      limits.push("The app has not supplied listUsers, so this rule can only match people as they sign in from now on.");
    }
    if (options.listUsers && !sawOrgIds && needsListing.some((rule) => rule.kind === "org")) {
      limits.push(
        "listUsers returns no orgIds, so this org's members (and their devices) cannot be found in history: only the org itself is marked. Return each user's orgIds to reach them.",
      );
    }

    // Users → their devices, through the link table (under every secret, current and previous).
    const allUsers = new Set<string>();
    for (const rule of personRules) for (const id of byRule.get(rule.id)!.users) allUsers.add(id);
    if (allUsers.size) {
      const visitorsByUser = await visitorsOf(allUsers);
      for (const rule of personRules) {
        const subjects = byRule.get(rule.id)!;
        for (const userId of subjects.users) for (const visitorId of visitorsByUser.get(userId) ?? []) subjects.visitors.add(visitorId);
      }
    }
    if (personRules.length && linkMode === "internal-only") {
      limits.push(
        "Link mode is internal-only: devices are linked to people only while they are internal, so a person's earlier anonymous visits are reached only if they were already internal then.",
      );
    }
    if (visitorIdMode === "rotating" && rules.some((rule) => USER_KINDS.has(rule.kind) || rule.kind === "visitor")) {
      limits.push(
        "Visitor ids on this site rotate daily (a cookieless key), so a person's past visits are reached only on days they were signed in; anonymous visits on other days stay counted.",
      );
    }

    for (const rule of rules) {
      const subjects = byRule.get(rule.id)!;
      if (rule.kind === "org") subjects.orgs.add(rule.value);
      else if (rule.kind === "event" || rule.kind === "order") {
        (rule.kind === "event" ? subjects.events : subjects.orders).add(rule.value);
        limits.push(
          `A test ${rule.kind} rule marks the ${rule.kind} itself, for ${rule.kind} counts (countedSubjectSql). Session counts do not change: the package cannot tell which visits touched it.`,
        );
      } else if (rule.kind === "visitor") subjects.visitors.add(rule.value);
      else if (!isRetroactiveKind(rule.kind)) {
        limits.push(
          rule.kind === "network"
            ? "Network rules apply to new visits only: IP addresses are never stored, so past visits cannot be matched."
            : rule.kind === "host"
              ? "Host rules apply to new visits only: the request host is not stored."
              : "User-agent rules apply to new visits only: user agents are not stored.",
        );
      }
    }
    return { byRule, limits: [...new Set(limits)] };
  }

  function counts(subjects: Subjects): SubjectCounts {
    return {
      users: subjects.users.size,
      visitors: subjects.visitors.size,
      orgs: subjects.orgs.size,
      events: subjects.events.size,
      orders: subjects.orders.size,
    };
  }

  const KIND_OF: ReadonlyArray<[keyof Subjects, SubjectKind]> = [
    ["users", "user"],
    ["visitors", "visitor"],
    ["orgs", "org"],
    ["events", "event"],
    ["orders", "order"],
  ];

  async function alreadyExcluded(subjects: Subjects): Promise<SubjectCounts> {
    const out: SubjectCounts = { users: 0, visitors: 0, orgs: 0, events: 0, orders: 0 };
    for (const [key, subjectKind] of KIND_OF) {
      const ids = [...subjects[key]];
      const marked = new Set<string>();
      for (let i = 0; i < ids.length; i += BATCH) {
        for (const mark of await store.listMarks(tenantId, { subjectKind, subjectIds: ids.slice(i, i + BATCH), active: true })) {
          marked.add(mark.subjectId);
        }
      }
      out[key] = marked.size;
    }
    return out;
  }

  function subjectMarks(rule: AudienceRule, subjects: Subjects, source: MarkSource, by: string | null, at: Date): NewAudienceMark[] {
    const reason = REASON_FOR_KIND[rule.kind];
    const out: NewAudienceMark[] = [];
    for (const [key, subjectKind] of KIND_OF) {
      for (const subjectId of subjects[key]) {
        out.push({ tenantId, subjectKind, subjectId, reason, ruleId: rule.id, source, markedBy: by, markedAt: at, appliesFrom: rule.appliesFrom });
      }
    }
    return out;
  }

  async function insertAll(marks: readonly NewAudienceMark[]): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < marks.length; i += BATCH) inserted += await store.insertMarks(marks.slice(i, i + BATCH));
    return inserted;
  }

  async function countRows(query: { from?: Date | null; to?: Date | null; visitorIds?: readonly string[] | null; countedOnly: boolean }): Promise<RowCount | null> {
    if (!sessions || !store.countRows) return null;
    return store.countRows(tenantId, { rows: sessions, ...query });
  }

  // ---------------------------------------------------------------- words

  /**
   * A rule in words for an annotation and a run summary. Those reach people
   * who must not see personal data (analysts read the trend chart's notes and
   * the digest), so: no free-text label or note ("Rachel Smith's husband"),
   * emails masked, a pattern ("rachel.smith") and a single-address network
   * shortened, user and device ids left out.
   */
  function describeRule(rule: Pick<AudienceRule, "kind" | "value">): string {
    const kind = KIND_INFO[rule.kind].label.toLowerCase();
    let value: string | null;
    if (rule.kind === "email") value = maskEmail(rule.value);
    else if (rule.kind === "email_pattern") value = rule.value.length <= 6 ? "•••" : `${rule.value.slice(0, 3)}•••`;
    else if (rule.kind === "network") value = maskNetwork(rule.value);
    else if (rule.kind === "user" || rule.kind === "visitor") value = null;
    else value = maskEmailsIn(rule.value);
    return value ? `${kind} ${value}` : kind;
  }

  const ymd = (date: Date) => date.toISOString().slice(0, 10);

  async function recordRun(run: Omit<AudienceRun, "id" | "tenantId">, annotate = true): Promise<AudienceRun> {
    const saved = await store.insertRun({ tenantId, ...run });
    if (annotate && options.annotate && run.summary) {
      try {
        await options.annotate({
          at: run.runAt,
          day: ymd(run.runAt),
          label: run.summary,
          action: run.action,
          ruleId: run.ruleId,
          runId: saved.id,
        });
      } catch (error) {
        report(error, "annotate");
      }
    }
    return saved;
  }

  function invalidRule(error: unknown): never {
    if (error instanceof RuleValueError) throw new AudienceError("invalid_rule", error.message);
    throw error;
  }

  const DUPLICATE = () => new AudienceError("duplicate_rule", "An active rule already says that.");

  async function requireRule(ruleId: string): Promise<AudienceRule> {
    const rule = await store.getRule(tenantId, ruleId);
    if (!rule) throw new AudienceError("not_found", "That rule does not exist.");
    return rule;
  }

  // ---------------------------------------------------------------- admin

  /** Dry run: who and how many a rule WOULD exclude — 30 days, 90 days, all time. Writes nothing. */
  async function preview(input: AudienceRuleInput): Promise<AudiencePreview> {
    gate();
    let normalized: ReturnType<typeof normalizeRuleInput>;
    try {
      normalized = normalizeRuleInput(input);
    } catch (error) {
      invalidRule(error);
    }
    const draft: AudienceRule = {
      id: "__preview__",
      tenantId,
      ...normalized,
      createdBy: null,
      createdAt: now(),
      disabledAt: null,
      disabledBy: null,
    };
    const rules = await activeRules();
    const duplicate = rules.find((rule) => rule.kind === draft.kind && rule.value === draft.value) ?? null;
    const { byRule, limits } = await resolveSubjects([draft]);
    const subjects = byRule.get(draft.id)!;
    const at = now();
    const windows: PreviewWindow[] = [];
    if (sessions && store.countRows) {
      const visitorIds = [...subjects.visitors];
      const spans: Array<[PreviewWindow["key"], string, Date | null]> = [
        ["30d", "Last 30 days", new Date(at.getTime() - 30 * DAY)],
        ["90d", "Last 90 days", new Date(at.getTime() - 90 * DAY)],
        ["all", "All time", null],
      ];
      for (const [key, label, from] of spans) {
        const before = (await countRows({ from, to: at, countedOnly: true }))!;
        const excludedFrom = laterOf(from, draft.appliesFrom);
        const excluded = visitorIds.length
          ? (await countRows({ from: excludedFrom, to: at, visitorIds, countedOnly: true }))!
          : { rows: 0, visitors: 0, earliest: null, latest: null };
        windows.push({
          key,
          label,
          from,
          to: at,
          before: { sessions: before.rows, visitors: before.visitors },
          excluded: { sessions: excluded.rows, visitors: excluded.visitors },
          after: { sessions: before.rows - excluded.rows, visitors: before.visitors - excluded.visitors },
          earliest: excluded.earliest,
        });
      }
    } else if (isRetroactiveKind(draft.kind)) {
      limits.push("No sessions source is configured, so session counts are not shown.");
    }
    return {
      rule: normalized,
      reason: REASON_FOR_KIND[draft.kind],
      retroactive: isRetroactiveKind(draft.kind),
      subjects: counts(subjects),
      alreadyExcluded: await alreadyExcluded(subjects),
      windows,
      limits,
      duplicateOf: duplicate?.id ?? null,
    };
  }

  /**
   * Save a rule (normalised) and, by default, apply it to history at once.
   * `annotate: false` still writes the run row but does not call `annotate`
   * (device-link redemptions use it, so a shared link cannot flood the chart).
   */
  async function addRule(
    input: AudienceRuleInput,
    opts: { by?: string | null; apply?: boolean; annotate?: boolean } = {},
  ): Promise<{ rule: AudienceRule; applied: ApplyResult | null }> {
    gate();
    let normalized: ReturnType<typeof normalizeRuleInput>;
    try {
      normalized = normalizeRuleInput(input);
    } catch (error) {
      invalidRule(error);
    }
    const existing = (await store.listRules(tenantId)).find((rule) => rule.kind === normalized.kind && rule.value === normalized.value);
    if (existing) throw DUPLICATE();
    let rule: AudienceRule;
    try {
      rule = await store.insertRule({
        tenantId,
        ...normalized,
        createdBy: opts.by ?? null,
        createdAt: now(),
      });
    } catch (error) {
      // Two admins adding the same rule at once both pass the check above;
      // the unique index stops the second, and it gets the form's words, not
      // a database error.
      if (isUniqueViolation(error)) throw DUPLICATE();
      throw error;
    }
    invalidate();
    const applied =
      opts.apply === false ? null : await apply(rule.id, { by: opts.by ?? null, ...(opts.annotate === false ? { annotate: false } : {}) });
    return { rule, applied };
  }

  /**
   * Write the rule's marks over history, in batches. Idempotent: a second run
   * writes nothing and reports 0. Leaves a run row and an annotation the
   * first time; a repeat that finds nothing new writes neither.
   */
  async function apply(ruleId: string, opts: { by?: string | null; annotate?: boolean } = {}): Promise<ApplyResult> {
    gate();
    const rule = await requireRule(ruleId);
    if (rule.disabledAt) throw new AudienceError("not_found", "That rule has been removed.");
    const by = opts.by ?? null;
    const { byRule } = await resolveSubjects([rule]);
    const subjects = byRule.get(rule.id)!;
    const at = now();
    const delta = await countRows({ from: rule.appliesFrom, visitorIds: [...subjects.visitors], countedOnly: true });
    const subjectsChanged = await insertAll(subjectMarks(rule, subjects, "rule", by, at));
    const what = describeRule(rule);
    let annotation: string;
    if (!isRetroactiveKind(rule.kind)) annotation = `Internal rule added (${what}): applies to new visits only`;
    else if (rule.kind === "event" || rule.kind === "order") {
      annotation = `Internal rule added (${what}): left out of ${rule.kind} counts; session counts unchanged`;
    } else if (delta) {
      annotation = `Internal rule added (${what}): ${delta.rows} ${unit} excluded${delta.earliest ? ` back to ${ymd(delta.earliest)}` : ""}`;
    } else annotation = `Internal rule added (${what}): ${subjectsChanged} subjects marked`;
    if (subjectsChanged === 0 && (await store.listRuns(tenantId, { ruleId: rule.id, limit: 1 })).length > 0) {
      // A retried or double-clicked apply: nothing new, so no second run row
      // and no second "…: 0 sessions excluded" note on the chart.
      return {
        rule,
        subjects: counts(subjects),
        subjectsChanged: 0,
        sessionsAffected: delta ? 0 : null,
        from: null,
        to: null,
        annotation: `Already applied (${what}): nothing new to exclude`,
        run: null,
      };
    }
    const run = await recordRun(
      {
        ruleId: rule.id,
        action: "apply",
        subjectsChanged,
        sessionsAffected: delta?.rows ?? null,
        rangeFrom: delta?.earliest ?? null,
        rangeTo: delta?.latest ?? null,
        runBy: by,
        runAt: at,
        summary: annotation,
      },
      opts.annotate !== false,
    );
    return {
      rule,
      subjects: counts(subjects),
      subjectsChanged,
      sessionsAffected: delta?.rows ?? null,
      from: delta?.earliest ?? null,
      to: delta?.latest ?? null,
      annotation,
      run,
    };
  }

  /**
   * Disable a rule and clear ITS marks (cleared_at — nothing is deleted).
   * Marks made at intake by a default or the callback, by hand, or by other
   * rules are untouched; the remaining active rules are then re-applied to
   * the subjects that lost a mark, so nobody another rule still covers is
   * counted again. Removing what `apply` did restores the numbers exactly.
   */
  async function remove(ruleId: string, opts: { by?: string | null; reapply?: boolean } = {}): Promise<RemoveResult> {
    const rule = await requireRule(ruleId);
    const by = opts.by ?? null;
    const at = now();
    const before = await store.listMarks(tenantId, { ruleId, active: true });
    const visitorIds = [...new Set(before.filter((mark) => mark.subjectKind === "visitor").map((mark) => mark.subjectId))];
    const countedBefore = await countRows({ visitorIds, countedOnly: true });
    if (!rule.disabledAt) await store.disableRule(tenantId, ruleId, at, by);
    const cleared = await store.clearMarks(tenantId, { ruleId }, at, by);
    invalidate();
    const retried = rule.disabledAt !== null && cleared.length === 0;

    // The remaining rules, re-applied to whatever lost a mark. On a RETRIED
    // remove (the first one failed after clearing but before this step) the
    // lost subjects are the rule's already-cleared marks, so the retry
    // finishes the job instead of answering "already removed" and stopping.
    const lostMarks: Array<{ subjectKind: SubjectKind; subjectId: string }> = retried
      ? await store.listMarks(tenantId, { ruleId, active: false })
      : cleared;
    if (opts.reapply !== false && lostMarks.length) {
      const remaining = (await store.listRules(tenantId)).filter((other) => other.id !== ruleId && isRetroactiveKind(other.kind));
      if (remaining.length) {
        const lost = new Set(lostMarks.map((mark) => `${mark.subjectKind}|${mark.subjectId}`));
        const { byRule } = await resolveSubjects(remaining);
        const marks: NewAudienceMark[] = [];
        for (const other of remaining) {
          for (const mark of subjectMarks(other, byRule.get(other.id)!, "rule", by, at)) {
            if (lost.has(`${mark.subjectKind}|${mark.subjectId}`)) marks.push(mark);
          }
        }
        await insertAll(marks);
      }
    }
    if (retried) {
      // Already done: no second run row.
      return { rule, marksCleared: 0, sessionsRestored: countedBefore ? 0 : null, annotation: "Rule already removed", run: null };
    }

    const countedAfter = await countRows({ visitorIds, countedOnly: true });
    // Visits the rule marked one by one (a network or host rule's sessions)
    // count again unless something else still marks them.
    const sessionIds = [...new Set(cleared.filter((mark) => mark.subjectKind === "session").map((mark) => mark.subjectId))];
    let sessionsFreed = 0;
    if (sessionIds.length && countedBefore) {
      const still = new Set<string>();
      for (let i = 0; i < sessionIds.length; i += BATCH) {
        for (const mark of await store.listMarks(tenantId, { subjectKind: "session", subjectIds: sessionIds.slice(i, i + BATCH), active: true })) {
          still.add(mark.subjectId);
        }
      }
      sessionsFreed = sessionIds.filter((id) => !still.has(id)).length;
    }
    const restored = countedBefore && countedAfter ? countedAfter.rows - countedBefore.rows + sessionsFreed : null;
    const what = describeRule(rule);
    const annotation =
      restored === null
        ? `Internal rule removed (${what}): ${cleared.length} marks cleared`
        : `Internal rule removed (${what}): ${restored} ${unit} counted again`;
    const run = await recordRun({
      ruleId,
      action: "remove",
      subjectsChanged: cleared.length,
      sessionsAffected: restored,
      rangeFrom: countedAfter?.earliest ?? null,
      rangeTo: countedAfter?.latest ?? null,
      runBy: by,
      runAt: at,
      summary: annotation,
    });
    return {
      rule: { ...rule, disabledAt: rule.disabledAt ?? at, disabledBy: rule.disabledAt ? rule.disabledBy : by },
      marksCleared: cleared.length,
      sessionsRestored: restored,
      annotation,
      run,
    };
  }

  /** Mark one subject by hand ("this order was a test"). A user's linked devices are marked too. */
  async function mark(input: {
    subjectKind: SubjectKind;
    subjectId: string;
    reason?: AudienceReason;
    by?: string | null;
  }): Promise<{ subjectsChanged: number; run: AudienceRun }> {
    gate();
    const subjectId = cleanId(input.subjectId);
    if (!subjectId) throw new AudienceError("invalid_rule", "Say which subject to mark (an id of at most 200 characters).");
    const by = input.by ?? null;
    const at = now();
    const reason = input.reason ?? "manual";
    const base = { tenantId, reason, ruleId: null, source: "manual" as const, markedBy: by, markedAt: at, appliesFrom: null };
    const marks: NewAudienceMark[] = [{ ...base, subjectKind: input.subjectKind, subjectId }];
    if (input.subjectKind === "user") {
      for (const visitorId of (await visitorsOf([subjectId])).get(subjectId) ?? []) {
        marks.push({ ...base, subjectKind: "visitor", subjectId: visitorId });
      }
    }
    const subjectsChanged = await insertAll(marks);
    const run = await recordRun({
      ruleId: null,
      action: "manual",
      subjectsChanged,
      sessionsAffected: null,
      rangeFrom: null,
      rangeTo: null,
      runBy: by,
      runAt: at,
      summary: `Marked by hand: ${input.subjectKind}${marks.length > 1 ? ` and ${marks.length - 1} linked device${marks.length === 2 ? "" : "s"}` : ""}`,
    });
    return { subjectsChanged, run };
  }

  /**
   * Undo a mark. By default only hand-made marks (`mark`). `sources` widens
   * it: `"all"` clears every active mark on the subject — the way to restore
   * a real customer a default, the code rule or a visit-only fact wrongly
   * excluded (a staffer who signed in on their device to help, a demoted
   * employee, a false automation hit). A user's linked devices are cleared
   * with them. Not license-gated, like `remove`. A rule that still names the
   * subject marks them again (intake, `apply`, `maintain`) — remove the rule
   * for that.
   */
  async function unmark(input: {
    subjectKind: SubjectKind;
    subjectId: string;
    by?: string | null;
    sources?: readonly MarkSource[] | "all";
  }): Promise<{ subjectsChanged: number; run: AudienceRun }> {
    const subjectId = cleanId(input.subjectId);
    if (!subjectId) throw new AudienceError("invalid_rule", "Say which subject to unmark.");
    const by = input.by ?? null;
    const at = now();
    const sources = input.sources === "all" ? null : (input.sources ?? (["manual"] as const));
    const filter = sources ? { sources } : {};
    let cleared = (await store.clearMarks(tenantId, { subjectKind: input.subjectKind, subjectId, ...filter }, at, by)).length;
    if (input.subjectKind === "user") {
      for (const visitorId of (await visitorsOf([subjectId])).get(subjectId) ?? []) {
        cleared += (await store.clearMarks(tenantId, { subjectKind: "visitor", subjectId: visitorId, ...filter }, at, by)).length;
      }
    }
    invalidate();
    const run = await recordRun({
      ruleId: null,
      action: "manual",
      subjectsChanged: cleared,
      sessionsAffected: null,
      rangeFrom: null,
      rangeTo: null,
      runBy: by,
      runAt: at,
      summary: `Unmarked by hand: ${input.subjectKind}${sources ? "" : " (every reason)"}`,
    });
    return { subjectsChanged: cleared, run };
  }

  function refuseRotating(): void {
    if (visitorIdMode === "rotating") {
      throw new AudienceError(
        "not_configured",
        "This site's visitor ids change every day, so a browser cannot be marked for good. Sign in as staff on it instead (the code rule marks it), or add a network rule.",
      );
    }
  }

  /** "Mark this browser": a `visitor` rule for this device, applied at once. Idempotent, also under a race. */
  async function markVisitor(input: {
    visitorId: string;
    by?: string | null;
    note?: string | null;
    label?: string | null;
    annotate?: boolean;
  }): Promise<{ rule: AudienceRule; applied: ApplyResult | null }> {
    refuseRotating();
    const visitorId = cleanId(input.visitorId);
    if (!visitorId) throw new AudienceError("invalid_rule", "This browser has no visitor id yet — load a page first.");
    const find = async () => (await store.listRules(tenantId)).find((rule) => rule.kind === "visitor" && rule.value === visitorId);
    const existing = await find();
    if (existing) return { rule: existing, applied: null };
    try {
      return await addRule(
        { kind: "visitor", value: visitorId, reasonLabel: input.label ?? "Marked from this browser", note: input.note ?? null },
        { by: input.by ?? null, ...(input.annotate === false ? { annotate: false } : {}) },
      );
    } catch (error) {
      // Two tabs pressing the button at once: the second finds the first's rule.
      if (error instanceof AudienceError && error.code === "duplicate_rule") {
        const raced = await find();
        if (raced) return { rule: raced, applied: null };
      }
      throw error;
    }
  }

  const deviceLinkNote = (linkId: string) => `device link ${linkId}`;

  /**
   * A link that marks whichever browser opens it (`?internal=<token>`), for
   * the client team's phones and signed-out laptops. It marks at most
   * `maxDevices` browsers (default 5) and names its maker only in encrypted
   * form. To revoke the browsers one link marked, remove the device rules
   * whose note is `device link <linkId>`; to revoke every outstanding link,
   * rotate AUDIENCE_SECRET (keeping the old one in `previousSecrets`).
   */
  function createDeviceLink(input: { by: string; ttlMs?: number; baseUrl?: string; maxDevices?: number }): {
    token: string;
    linkId: string;
    expiresAt: Date;
    maxDevices: number;
    url: string | null;
  } {
    refuseRotating();
    const expiresAt = new Date(now().getTime() + (input.ttlMs ?? 30 * DAY));
    const maxDevices = Math.max(1, Math.min(100, Math.floor(input.maxDevices ?? 5)));
    const { token, linkId } = signDeviceToken(secret, { tenantId, by: input.by, expiresAt, maxDevices });
    let url: string | null = null;
    if (input.baseUrl) {
      const parsed = new URL(input.baseUrl);
      parsed.searchParams.set(DEVICE_LINK_PARAM, token);
      url = parsed.toString();
    }
    return { token, linkId, expiresAt, maxDevices, url };
  }

  /**
   * Verify a device link and mark the visitor that opened it. Opening it again
   * in the same browser is a no-op; each NEW browser counts against the link's
   * limit. A redemption leaves a run row but no chart annotation, so a link
   * that leaks cannot flood the trend chart.
   */
  async function redeemDeviceLink(token: string, input: { visitorId: string }): Promise<{ rule: AudienceRule }> {
    refuseRotating();
    const result = verifyDeviceToken(secret, tenantId, token, now());
    if (!result.ok) {
      throw new AudienceError(
        "invalid_token",
        result.reason === "expired" ? "That device link has expired — ask for a new one." : "That device link is not valid.",
      );
    }
    const visitorId = cleanId(input.visitorId);
    if (!visitorId) throw new AudienceError("invalid_rule", "This browser has no visitor id yet — load a page first.");
    const all = await store.listRules(tenantId, { includeDisabled: true });
    const existing = all.find((rule) => !rule.disabledAt && rule.kind === "visitor" && rule.value === visitorId);
    if (existing) return { rule: existing };
    const note = deviceLinkNote(result.linkId);
    const used = all.filter((rule) => rule.kind === "visitor" && rule.note === note).length;
    if (used >= result.maxDevices) {
      throw new AudienceError(
        "invalid_token",
        `That device link has already marked ${used} browser${used === 1 ? "" : "s"}, its limit — ask for a new one.`,
      );
    }
    const { rule } = await markVisitor({ visitorId, by: result.by, label: "Marked with a device link", note, annotate: false });
    return { rule };
  }

  /**
   * History the links table cannot reach, through joins only the app knows
   * (Riddler Go: checkout events → orders → the buyer). The adapter yields
   * subjects with an actor; the package judges each with the same rules and
   * callback as intake. Dry run first; writes are idempotent.
   */
  async function backfill(adapter: BackfillAdapter<TUser>, opts: { by?: string | null; dryRun?: boolean } = {}): Promise<BackfillResult> {
    gate();
    const by = opts.by ?? null;
    const dryRun = opts.dryRun === true;
    const rules = await activeRules();
    const at = now();
    const ctx: BackfillContext<TUser> = {
      tenantId,
      async classify(actor) {
        const user = await resolveUser(actor, false);
        return classifyFacts(actorFacts(actor, user, await verdictFor(user, false)), rules);
      },
    };
    let candidates = 0;
    let internal = 0;
    const byReason: Partial<Record<AudienceReason, number>> = {};
    const pending: NewAudienceMark[] = [];
    for await (const candidate of iterate(adapter.candidates(ctx))) {
      candidates += 1;
      const subjectId = cleanId(candidate.subjectId);
      if (!subjectId) continue;
      let marks: NewAudienceMark[] = [];
      let reason: AudienceReason | null = null;
      if (candidate.reason) {
        reason = candidate.reason;
        marks = [{ tenantId, subjectKind: candidate.subjectKind, subjectId, reason, ruleId: null, source: "backfill", markedBy: by, markedAt: at, appliesFrom: null }];
      } else if (candidate.actor) {
        const verdict = await ctx.classify(candidate.actor);
        if (verdict) {
          reason = verdict.reason;
          marks = marksFor(candidate.subjectKind, subjectId, verdict.all, rules, "backfill", by, at);
        }
      }
      if (!reason) continue;
      internal += 1;
      byReason[reason] = (byReason[reason] ?? 0) + 1;
      pending.push(...marks);
    }

    // What this run newly excludes: subjects with no active mark of any kind
    // yet — counted the SAME way in a dry run and a real one, and BEFORE
    // anything is written, so the dry-run number reviewed is the number the
    // run row records (a subject getting two marks, or one it already had, is
    // still one subject, or none).
    const unmarked = new Map<string, NewAudienceMark>();
    for (const mark of pending) unmarked.set(`${mark.subjectKind}|${mark.subjectId}`, mark);
    for (const subjectKind of SUBJECT_KINDS) {
      const ids = [...unmarked.values()].filter((mark) => mark.subjectKind === subjectKind).map((mark) => mark.subjectId);
      for (let i = 0; i < ids.length; i += BATCH) {
        for (const existing of await store.listMarks(tenantId, { subjectKind, subjectIds: ids.slice(i, i + BATCH), active: true })) {
          unmarked.delete(`${subjectKind}|${existing.subjectId}`);
        }
      }
    }
    const subjectsChanged = unmarked.size;
    const newVisitors = [...unmarked.values()].filter((mark) => mark.subjectKind === "visitor").map((mark) => mark.subjectId);
    const delta = await countRows({ visitorIds: newVisitors, countedOnly: true });
    const marksWritten = dryRun ? 0 : await insertAll(pending);
    const sessionsAffected = delta?.rows ?? null;
    const run = dryRun
      ? null
      : await recordRun({
          ruleId: null,
          action: "backfill",
          subjectsChanged,
          sessionsAffected,
          rangeFrom: delta?.earliest ?? null,
          rangeTo: delta?.latest ?? null,
          runBy: by,
          runAt: at,
          summary:
            sessionsAffected === null
              ? `Backfill (${adapter.name}): ${subjectsChanged} subjects marked`
              : `Backfill (${adapter.name}): ${sessionsAffected} ${unit} excluded${delta?.earliest ? ` back to ${ymd(delta.earliest)}` : ""}`,
        });
    return { name: adapter.name, dryRun, candidates, internal, byReason, subjectsChanged, marksWritten, sessionsAffected, run };
  }

  /**
   * The daily safety net. Idempotent; one run row when anything changed.
   *
   *   1. Clears active marks whose rule has been removed. Another instance,
   *      still holding the rule in its cache, may have written one after the
   *      removal; the Drizzle store refuses such inserts, and this sweep
   *      covers any store that does not.
   *   2. Re-applies every active rule (catching devices linked since).
   *   3. With `isInternal` and `listUsers`, marks everyone the code rule calls
   *      internal, and their devices.
   *   4. With `pruneRoleMarks: true`, clears the code-rule marks of people it
   *      NO LONGER calls internal (and their devices'). Off by default: it
   *      counts a former staffer's whole history again, including the visits
   *      they made while on staff. Turn it on when "left the team" should mean
   *      "their browsing was never internal"; otherwise restore one person by
   *      hand with `unmark({ subjectKind: "user", subjectId, sources: "all" })`.
   */
  async function maintain(opts: { by?: string | null; pruneRoleMarks?: boolean } = {}): Promise<MaintainResult> {
    gate();
    const by = opts.by ?? "maintenance";
    const at = now();
    const allRules = await store.listRules(tenantId, { includeDisabled: true });
    let orphansCleared = 0;
    for (const rule of allRules) {
      if (rule.disabledAt) orphansCleared += (await store.clearMarks(tenantId, { ruleId: rule.id }, at, by)).length;
    }
    if (orphansCleared) invalidate();
    const rules = allRules.filter((rule) => !rule.disabledAt && isRetroactiveKind(rule.kind));
    const { byRule } = await resolveSubjects(rules);
    const marks: NewAudienceMark[] = [];
    for (const rule of rules) marks.push(...subjectMarks(rule, byRule.get(rule.id)!, "rule", by, at));

    let roleUsers = 0;
    let roleMarksCleared = 0;
    if (options.isInternal && options.listUsers) {
      const roleUserIds = new Set<string>();
      for await (const user of iterate(options.listUsers({ rule: null }))) {
        const userId = user ? cleanId(user.id) : null;
        if (!user || !userId) continue;
        if (await verdictFor(user, false)) roleUserIds.add(userId);
      }
      roleUsers = roleUserIds.size;

      if (opts.pruneRoleMarks) {
        const formerIds = (await store.listMarks(tenantId, { subjectKind: "user", reason: "role", ruleIdIsNull: true, active: true }))
          .map((mark) => mark.subjectId)
          .filter((userId) => !roleUserIds.has(userId));
        const former = [...new Set(formerIds)];
        const devices = await visitorsOf(former);
        for (const userId of former) {
          const where = { reason: "role" as const, ruleIdIsNull: true };
          roleMarksCleared += (await store.clearMarks(tenantId, { subjectKind: "user", subjectId: userId, ...where }, at, by)).length;
          for (const visitorId of devices.get(userId) ?? []) {
            roleMarksCleared += (await store.clearMarks(tenantId, { subjectKind: "visitor", subjectId: visitorId, ...where }, at, by)).length;
          }
        }
        if (roleMarksCleared) invalidate();
      }

      // After any pruning, so a device shared with someone still on staff is marked again.
      const base = { tenantId, reason: "role" as const, ruleId: null, source: "backfill" as const, markedBy: by, markedAt: at, appliesFrom: null };
      for (const userId of roleUserIds) marks.push({ ...base, subjectKind: "user", subjectId: userId });
      for (const visitors of (await visitorsOf(roleUserIds)).values()) {
        for (const visitorId of visitors) marks.push({ ...base, subjectKind: "visitor", subjectId: visitorId });
      }
    }
    const subjectsChanged = await insertAll(marks);
    const changed = subjectsChanged + orphansCleared + roleMarksCleared;
    const extra = [
      orphansCleared ? `${orphansCleared} marks of removed rules cleared` : "",
      roleMarksCleared ? `${roleMarksCleared} marks of people no longer internal cleared` : "",
    ].filter(Boolean);
    const run =
      changed > 0
        ? await recordRun({
            ruleId: null,
            action: "backfill",
            subjectsChanged: changed,
            sessionsAffected: null,
            rangeFrom: null,
            rangeTo: null,
            runBy: by,
            runAt: at,
            summary: `Maintenance: ${subjectsChanged} new marks (${rules.length} rules re-applied${options.isInternal ? `, ${roleUsers} people by the code rule` : ""})${extra.length ? `; ${extra.join("; ")}` : ""}`,
          })
        : null;
    return { rulesApplied: rules.length, roleUsers, subjectsChanged, orphansCleared, roleMarksCleared, run };
  }

  /** "Excluded: N (staff X, test Y, automation Z)" — over the app's sessions in a window. Sums exactly. */
  async function excludedBreakdown(window: AudienceWindow = {}, opts: { rows?: RowsSource } = {}): Promise<ExcludedBreakdown> {
    const rows = opts.rows ?? sessions;
    if (!rows || !store.breakdownRows) {
      throw new AudienceError("not_configured", "excludedBreakdown needs a `sessions` source and a store that can count rows.");
    }
    const groups = await store.breakdownRows(tenantId, { rows, from: window.from ?? null, to: window.to ?? null });
    const byReason: Partial<Record<AudienceReason, number>> = {};
    let total = 0;
    for (const { reason, count } of groups) {
      if (!count) continue;
      byReason[reason] = (byReason[reason] ?? 0) + count;
      total += count;
    }
    return { total, byReason, unit };
  }

  function countedOptions(extra: Omit<CountedOptions, "tenantId" | "marksTable"> = {}): CountedOptions {
    return { tenantId, marksTable, ...extra };
  }

  /** Rules and runs as a viewer may see them — masked for the analytics role, ON THE SERVER. */
  async function viewModel(opts: { canSeeEmails: boolean; runsLimit?: number; salt?: string }): Promise<AudienceViewModel> {
    const [rules, runs] = await Promise.all([store.listRules(tenantId), store.listRuns(tenantId, { limit: opts.runsLimit ?? 20 })]);
    if (opts.canSeeEmails) return { rules, runs, codeRule: options.codeRule ?? null, linkMode, masked: false };
    const masker = createMasker(opts.salt);
    return {
      rules: rules.map((rule) => maskRule(rule, masker)),
      runs: runs.map((run) => maskRun(run, masker)),
      codeRule: options.codeRule ?? null,
      linkMode,
      masked: true,
    };
  }

  type VisitorExtra = Omit<CountedVisitorOptions, "tenantId" | "marksTable">;
  type SubjectExtra = Omit<CountedOptions, "tenantId" | "marksTable">;

  return {
    tenantId,
    linkMode,
    marksTable,
    visitorIds: visitorIdMode,
    /**
     * The smoke-test header this instance accepts, `{ name, value }`, or null
     * when it is off. The value is derived from AUDIENCE_SECRET unless set, so
     * a smoke suite against production reads it from here (or from the same
     * secret with `testHeaderValueFor`).
     */
    testHeader: testHeader ? { name: testHeader.name, value: testHeader.value } : null,
    reasonLabels: DEFAULT_REASON_LABELS,
    observe,
    classifyActor,
    /** Pure check against the current rules — no writes. */
    async explain(input: ObserveInput<TUser>): Promise<AudienceClassification | null> {
      const rules = await activeRules();
      const user = await resolveUser(input, false);
      return classifyFacts({ ...actorFacts(input, user, await verdictFor(user, false)), ...requestFacts(input, rules) }, rules);
    },
    rules: (opts?: { includeDisabled?: boolean }) => store.listRules(tenantId, opts),
    runs: (opts?: { limit?: number; ruleId?: string }) => store.listRuns(tenantId, opts),
    preview,
    addRule,
    apply,
    remove,
    mark,
    unmark,
    markVisitor,
    createDeviceLink,
    redeemDeviceLink,
    backfill,
    maintain,
    excludedBreakdown,
    viewModel,
    /** Drop the cached rules and intake caches (another instance changed rules). */
    invalidate,
    /** HMAC of a user id, as the links table stores it. */
    userKey: (userId: string | number) => userKeyFor(secret, tenantId, String(userId)),
    /** `extra` must name `time` and `session` (or null each on purpose) — see `CountedVisitorOptions`. */
    countedVisitorParts: (column: string | { chunk: unknown }, extra: VisitorExtra): SqlPart[] =>
      countedVisitorParts(column, { tenantId, marksTable, ...extra }),
    countedSubjectParts: (kind: SubjectKind, column: string | { chunk: unknown }, extra?: SubjectExtra): SqlPart[] =>
      countedSubjectParts(kind, column, countedOptions(extra)),
    /** The anti-join as text + params, for raw SQL without Drizzle. */
    countedVisitorClause: (column: string, extra: VisitorExtra & RenderOptions): RawSql =>
      renderSql(countedVisitorParts(column, { tenantId, marksTable, ...extra }), extra),
    countedSubjectClause: (kind: SubjectKind, column: string, extra: SubjectExtra & RenderOptions = {}): RawSql =>
      renderSql(countedSubjectParts(kind, column, countedOptions(extra)), extra),
    /** The best reason among several — exposed for apps building their own breakdowns. */
    bestReason,
  };
}

/**
 * A unique-index violation from the store, however the driver wraps it:
 * Postgres 23505 (Drizzle puts the driver's error in `cause`), MySQL
 * ER_DUP_ENTRY / 1062, or a store that already threw `duplicate_rule`.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    if (current instanceof AudienceError) return current.code === "duplicate_rule";
    const { code, errno } = current as { code?: unknown; errno?: unknown };
    if (code === "23505" || code === "ER_DUP_ENTRY" || errno === 1062) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

