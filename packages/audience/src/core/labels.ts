/**
 * The vocabulary — rule kinds, reasons, their precedence and their words — as
 * plain data with no imports, so the client entry (`./ui`) can bundle it
 * without dragging `node:crypto` (or anything else server-side) into a
 * browser build. Everything else in the package reads these constants; a new
 * kind or reason is added here first.
 */

/** What a stored rule can name. See README → "Rule kinds". */
export const RULE_KINDS = [
  "user",
  "email",
  "email_domain",
  "email_pattern",
  "org",
  "event",
  "order",
  "visitor",
  "network",
  "host",
  "user_agent",
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

/**
 * Why something is excluded, in PRECEDENCE order: when several apply, the
 * first one wins, so a subject is counted under exactly one reason and the
 * per-reason counts add up to the total excluded (Road Rally's `exclusionOf`).
 *
 * bot > automation > non-production > role (the app's callback) > named user
 * > email > domain > pattern > org > event/order > device > network > manual.
 *
 * `bot` is listed so a breakdown can show it, but it is never "internal":
 * the labels keep it apart.
 */
export const REASON_ORDER = [
  "bot",
  "automation",
  "non_production",
  "role",
  "named_user",
  "email",
  "domain",
  "pattern",
  "org",
  "event",
  "order",
  "device",
  "network",
  "manual",
] as const;
export type AudienceReason = (typeof REASON_ORDER)[number];

/** Where a mark came from. */
export const MARK_SOURCES = ["ingest", "rule", "manual", "backfill"] as const;
export type MarkSource = (typeof MARK_SOURCES)[number];

/** What a mark is about. Sessions are for apps that mark one visit, not a device. */
export const SUBJECT_KINDS = ["visitor", "user", "org", "event", "order", "session"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export const RUN_ACTIONS = ["apply", "remove", "backfill", "manual"] as const;
export type RunAction = (typeof RUN_ACTIONS)[number];

/** The reason a stored rule of each kind excludes for. */
export const REASON_FOR_KIND: Readonly<Record<RuleKind, AudienceReason>> = {
  user: "named_user",
  email: "email",
  email_domain: "domain",
  email_pattern: "pattern",
  org: "org",
  event: "event",
  order: "order",
  visitor: "device",
  network: "network",
  host: "non_production",
  user_agent: "automation",
};

/**
 * Kinds that can reach back in time. The others are judged at intake from
 * facts that are never stored (an IP, a request host, a user agent), so a new
 * rule of that kind can only affect visits from now on.
 */
export const RETROACTIVE_KINDS: ReadonlySet<RuleKind> = new Set<RuleKind>([
  "user",
  "email",
  "email_domain",
  "email_pattern",
  "org",
  "event",
  "order",
  "visitor",
]);

export function isRetroactiveKind(kind: RuleKind): boolean {
  return RETROACTIVE_KINDS.has(kind);
}

/**
 * The words a report shows — "Excluded: 312 sessions (staff 200, named person
 * 100, automation 12)". Two reasons may share a word (a named user and a named
 * email are both "named person"); a breakdown line sums them under it.
 */
export const DEFAULT_REASON_LABELS: Readonly<Record<AudienceReason, string>> = {
  bot: "bots",
  automation: "automation",
  non_production: "non-production",
  role: "staff",
  named_user: "named person",
  email: "named person",
  domain: "staff domain",
  pattern: "test account",
  org: "internal org",
  event: "test event",
  order: "test order",
  device: "marked device",
  network: "office network",
  manual: "marked by hand",
};

/** How the admin form describes each kind. */
export const KIND_INFO: Readonly<
  Record<RuleKind, { label: string; hint: string; placeholder: string }>
> = {
  user: { label: "A person's account", hint: "One account, by the account id your developer gives you.", placeholder: "user_2abc…" },
  email: {
    label: "A team member's email",
    hint: "One person's email address. A Gmail address still matches when it's written with dots or a +word added.",
    placeholder: "jane@gmail.com",
  },
  email_domain: {
    label: "Everyone at an email domain",
    hint: "Everyone whose email ends in this, like everyone @greenacres.com.",
    placeholder: "greenacres.com",
  },
  email_pattern: {
    label: "Emails containing some text",
    hint: "Any email address with this text in it, like +test.",
    placeholder: "+qa",
  },
  org: { label: "An organization", hint: "A staff workspace or a demo account, by the id your developer gives you.", placeholder: "org_…" },
  event: { label: "Test event", hint: "An event made for testing, by id.", placeholder: "evt_…" },
  order: { label: "Test order", hint: "A test purchase, by id.", placeholder: "ord_…" },
  visitor: {
    label: "One device",
    hint: "One browser, by its visitor id. The “leave this device out” button is easier.",
    placeholder: "visitor id",
  },
  network: {
    label: "An office or home internet connection",
    hint: "Every device on that connection, from now on. Its address looks like 203.0.113.7 — search “what is my IP” while you're on it. Earlier visits can't be matched.",
    placeholder: "203.0.113.7",
  },
  host: {
    label: "Your live website's address",
    hint: "Once one is listed, visits to any other address (a test copy) are left out. New visits only.",
    placeholder: "www.example.com",
  },
  user_agent: {
    label: "A monitoring tool",
    hint: "A tool that checks your site is up, by the name it sends (like UptimeRobot). New visits only.",
    placeholder: "UptimeRobot",
  },
};
