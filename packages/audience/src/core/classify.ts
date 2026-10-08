import { ipInRange, parseCidr, type IpRange } from "./cidr.js";
import {
  automationAgentOf,
  DEFAULT_EMAIL_DOMAINS,
  DEFAULT_EMAIL_PATTERNS,
  DEFAULT_NON_PRODUCTION_HOSTS,
  isBotAgent,
  type AudienceDefaults,
} from "./defaults.js";
import { REASON_ORDER, type AudienceReason, type RuleKind } from "./labels.js";
import {
  domainMatches,
  emailDomain,
  emailKey,
  emailPatternMatches,
  hostMatches,
  normalizeEmail,
  normalizeHost,
} from "./normalize.js";
import type { ActorFacts, AudienceClassification, AudienceMatch, AudienceRule, AudienceUser } from "./types.js";

/**
 * THE classifier: given what is known about one actor and the active rules,
 * every reason that applies — and the winner by precedence. Pure: no I/O, no
 * clock, no secret. `createAudience` feeds it; the tests drive it directly.
 */

const RANK: Readonly<Record<string, number>> = Object.fromEntries(REASON_ORDER.map((reason, i) => [reason, i]));

/** Position in the precedence order (lower wins). Unknown reasons sort last. */
export function reasonRank(reason: string): number {
  return RANK[reason] ?? REASON_ORDER.length;
}

/**
 * Reasons that are about the PERSON, so the user is marked as well as the
 * device. An `org` rule is one: being a member of an internal org (a staff
 * workspace, a demo org) is a fact about the person, and `apply()` reaches
 * members through `user.orgIds` the same way intake does.
 */
const PERSONAL: ReadonlySet<AudienceReason> = new Set<AudienceReason>(["role", "named_user", "email", "domain", "pattern", "org"]);

export function isPersonalReason(reason: AudienceReason): boolean {
  return PERSONAL.has(reason);
}

/**
 * What an intake verdict marks, by reason:
 *
 *   - "person": the device (all of its history, since a person who is
 *     internal browsed on it) and the user. role, named_user, email, domain,
 *     pattern, org.
 *   - "device": the device. A `visitor` rule names the device itself.
 *   - "visit": facts about ONE request — its user agent, host, network,
 *     the webdriver flag, the smoke-test header. They say nothing about the
 *     device's other visits, so they mark the SESSION (pass `sessionId`). A
 *     customer who loads the site once from the office network keeps the rest
 *     of their history. Without a session id they fall back to the device.
 *   - "subject": a test event or order acted on. The event or order is marked
 *     by its rule; at intake only the acting session is marked, never the
 *     actor's device (a customer who touched a test event is still a customer).
 */
export type MarkScope = "person" | "device" | "visit" | "subject";

export function markScopeOf(reason: AudienceReason): MarkScope {
  if (PERSONAL.has(reason)) return "person";
  if (reason === "device" || reason === "manual") return "device";
  if (reason === "event" || reason === "order") return "subject";
  return "visit";
}

export interface ClassifyOptions {
  /** The ACTIVE stored rules (disabled ones must already be filtered out). */
  rules: readonly AudienceRule[];
  defaults: AudienceDefaults;
  /** Fold Gmail dots and +tags when comparing exact `email` rules. */
  foldGmail: boolean;
  /** Hosts declared production in code, on top of `host` rules. */
  productionHosts?: readonly string[];
}

/** Rules pre-sorted by kind with their parsed forms, so classifying is a few array scans. */
export interface CompiledRules {
  byKind: Readonly<Record<RuleKind, readonly AudienceRule[]>>;
  networks: ReadonlyArray<{ rule: AudienceRule; range: IpRange }>;
  emailKeys: ReadonlyArray<{ rule: AudienceRule; key: string }>;
  productionHosts: readonly string[];
}

const compiledCache = new WeakMap<readonly AudienceRule[], Map<string, CompiledRules>>();

export function compileRules(
  rules: readonly AudienceRule[],
  foldGmail: boolean,
  productionHosts: readonly string[] = [],
): CompiledRules {
  const cacheKey = `${foldGmail ? 1 : 0}|${productionHosts.join(",")}`;
  const hit = compiledCache.get(rules)?.get(cacheKey);
  if (hit) return hit;
  const byKind = {
    user: [],
    email: [],
    email_domain: [],
    email_pattern: [],
    org: [],
    event: [],
    order: [],
    visitor: [],
    network: [],
    host: [],
    user_agent: [],
  } as Record<RuleKind, AudienceRule[]>;
  for (const rule of rules) {
    if (rule.disabledAt) continue;
    byKind[rule.kind]?.push(rule);
  }
  const networks: Array<{ rule: AudienceRule; range: IpRange }> = [];
  for (const rule of byKind.network) {
    const range = parseCidr(rule.value);
    if (range) networks.push({ rule, range });
  }
  const emailKeys: Array<{ rule: AudienceRule; key: string }> = [];
  for (const rule of byKind.email) {
    const key = emailKey(rule.value, foldGmail);
    if (key) emailKeys.push({ rule, key });
  }
  const hosts = productionHosts.map((h) => (h.startsWith("*.") ? `*.${normalizeHost(h.slice(2)) ?? ""}` : (normalizeHost(h) ?? "")));
  const compiled: CompiledRules = { byKind, networks, emailKeys, productionHosts: hosts.filter(Boolean) };
  const forRules = compiledCache.get(rules) ?? new Map<string, CompiledRules>();
  forRules.set(cacheKey, compiled);
  compiledCache.set(rules, forRules);
  return compiled;
}

/**
 * Every match, best first. Ties within one reason put the matches with no
 * rule id (defaults, the callback, flags — things `remove()` cannot take
 * away) ahead of stored rules.
 */
export function allMatches(facts: ActorFacts, options: ClassifyOptions): AudienceMatch[] {
  const compiled = compileRules(options.rules, options.foldGmail, options.productionHosts);
  const { defaults } = options;
  const matches: AudienceMatch[] = [];
  const push = (reason: AudienceReason, ruleId: string | null, detail: string) =>
    matches.push({ reason, ruleId, detail, personal: isPersonalReason(reason) });

  const userAgent = facts.userAgent ?? null;
  const uaLower = userAgent?.toLowerCase() ?? "";

  // automation (checked before bots so a monitor is never called a crawler)
  const automationAgent = defaults.automation ? automationAgentOf(userAgent) : null;
  const automationRules = uaLower ? compiled.byKind.user_agent.filter((rule) => uaLower.includes(rule.value)) : [];

  // bot
  if (defaults.bots && !automationAgent && automationRules.length === 0 && isBotAgent(userAgent)) {
    push("bot", null, "crawler user agent");
  }

  if (defaults.automation && facts.webdriver) push("automation", null, "navigator.webdriver");
  if (facts.testHeader) push("automation", null, "smoke-test header");
  if (automationAgent) push("automation", null, `user agent: ${automationAgent}`);
  for (const rule of automationRules) push("automation", rule.id, `user agent: ${rule.value}`);

  // non-production
  const host = normalizeHost(facts.host);
  const allowList = [...compiled.productionHosts, ...compiled.byKind.host.map((rule) => rule.value)];
  const allowed = host !== null && allowList.some((pattern) => hostMatches(host, pattern));
  if (facts.nonProduction) push("non_production", null, "non-production deployment");
  if (host !== null && !allowed) {
    const deny = defaults.hosts ? DEFAULT_NON_PRODUCTION_HOSTS.find((pattern) => hostMatches(host, pattern)) : undefined;
    if (deny) push("non_production", null, `host: ${host}`);
    else if (allowList.length > 0) {
      // A miss is caused by the allow-list, so the stored host rules OWN it:
      // removing a mistyped rule (www. listed, the apex forgotten) clears the
      // visits it wrongly excluded. A list declared in code owns nothing.
      const detail = `host not in the production list: ${host}`;
      if (compiled.productionHosts.length > 0) push("non_production", null, detail);
      for (const rule of compiled.byKind.host) push("non_production", rule.id, detail);
    }
  }

  // role (the app's callback)
  if (typeof facts.roleLabel === "string" && facts.roleLabel.trim()) push("role", null, facts.roleLabel.trim());

  // named user
  const userId = facts.userId === null || facts.userId === undefined ? null : String(facts.userId);
  if (userId) {
    for (const rule of compiled.byKind.user) if (rule.value === userId) push("named_user", rule.id, `user ${rule.value}`);
  }

  // email, domain, pattern
  const email = normalizeEmail(facts.email);
  if (email) {
    const key = emailKey(email, options.foldGmail);
    for (const { rule, key: ruleKey } of compiled.emailKeys) if (ruleKey === key) push("email", rule.id, rule.value);
    const domain = emailDomain(email);
    if (defaults.emailDomains) {
      const reserved = DEFAULT_EMAIL_DOMAINS.find((suffix) => domainMatches(domain, suffix));
      if (reserved) push("domain", null, `reserved domain: ${reserved}`);
    }
    for (const rule of compiled.byKind.email_domain) if (domainMatches(domain, rule.value)) push("domain", rule.id, rule.value);
    if (defaults.emailPatterns) {
      const pattern = DEFAULT_EMAIL_PATTERNS.find((p) => email.includes(p));
      if (pattern) push("pattern", null, `test address: ${pattern}`);
    }
    for (const rule of compiled.byKind.email_pattern) if (emailPatternMatches(email, rule.value)) push("pattern", rule.id, rule.value);
  }

  // org, event, order
  const orgIds = (facts.orgIds ?? []).map(String);
  if (orgIds.length) {
    for (const rule of compiled.byKind.org) if (orgIds.includes(rule.value)) push("org", rule.id, `org ${rule.value}`);
  }
  if (facts.eventId) {
    for (const rule of compiled.byKind.event) if (rule.value === facts.eventId) push("event", rule.id, `event ${rule.value}`);
  }
  if (facts.orderId) {
    for (const rule of compiled.byKind.order) if (rule.value === facts.orderId) push("order", rule.id, `order ${rule.value}`);
  }

  // device
  if (facts.visitorId) {
    for (const rule of compiled.byKind.visitor) if (rule.value === facts.visitorId) push("device", rule.id, "marked device");
  }

  // network — the IP is read here and nowhere else
  if (facts.ip && compiled.networks.length) {
    for (const { rule, range } of compiled.networks) if (ipInRange(facts.ip, range)) push("network", rule.id, rule.value);
  }

  return matches
    .map((match, index) => ({ match, index }))
    .sort(
      (a, b) =>
        reasonRank(a.match.reason) - reasonRank(b.match.reason) ||
        Number(a.match.ruleId !== null) - Number(b.match.ruleId !== null) ||
        a.index - b.index,
    )
    .map(({ match }) => match);
}

/** The winning match (with the rest attached), or null when the actor counts. */
export function classify(facts: ActorFacts, options: ClassifyOptions): AudienceClassification | null {
  const all = allMatches(facts, options);
  const best = all[0];
  return best ? { ...best, all } : null;
}

/** The best of several reasons, by precedence. */
export function bestReason<T extends string>(reasons: Iterable<T>): T | null {
  let best: T | null = null;
  for (const reason of reasons) if (best === null || reasonRank(reason) < reasonRank(best)) best = reason;
  return best;
}

/**
 * Does a stored rule pick out this user? The retroactive half of the rule
 * model: `apply()` runs every user the app lists through this, so a rule
 * matches the same people at intake and in history.
 */
export function ruleMatchesUser(rule: AudienceRule, user: AudienceUser, foldGmail: boolean): boolean {
  switch (rule.kind) {
    case "user":
      return String(user.id) === rule.value;
    case "org":
      return Array.isArray(user.orgIds) && user.orgIds.some((orgId) => String(orgId) === rule.value);
    case "email": {
      const key = emailKey(user.email, foldGmail);
      return key !== null && key === emailKey(rule.value, foldGmail);
    }
    case "email_domain": {
      const email = normalizeEmail(user.email);
      return email !== null && domainMatches(emailDomain(email), rule.value);
    }
    case "email_pattern": {
      const email = normalizeEmail(user.email);
      return email !== null && emailPatternMatches(email, rule.value);
    }
    default:
      return false;
  }
}

/** Kinds whose subjects are found by walking the app's users (an org's members through `user.orgIds`). */
export const USER_KINDS: ReadonlySet<RuleKind> = new Set<RuleKind>(["user", "email", "email_domain", "email_pattern", "org"]);
