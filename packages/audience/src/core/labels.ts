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
  user: { label: "Person (user id)", hint: "One account, by its user id.", placeholder: "user_2abc…" },
  email: {
    label: "Person (email)",
    hint: "One address. Gmail dots and +tags are folded, so j.doe+x@gmail.com matches jdoe@gmail.com.",
    placeholder: "jane@gmail.com",
  },
  email_domain: {
    label: "Email domain",
    hint: "Everyone at a domain, and its subdomains.",
    placeholder: "riddlergo.com",
  },
  email_pattern: {
    label: "Email pattern",
    hint: "Text inside the address (+clerk_test), or a glob with * and ?.",
    placeholder: "+qa",
  },
  org: { label: "Organization", hint: "A staff workspace or demo org, by id.", placeholder: "org_…" },
  event: { label: "Test event", hint: "An event made for testing, by id.", placeholder: "evt_…" },
  order: { label: "Test order", hint: "A test purchase, by id.", placeholder: "ord_…" },
  visitor: {
    label: "Device",
    hint: "One browser, by its visitor id. Prefer the Mark this browser button.",
    placeholder: "visitor id",
  },
  network: {
    label: "Network (IP range)",
    hint: "An office or home range in CIDR form. New visits only: IPs are never stored.",
    placeholder: "203.0.113.0/24",
  },
  host: {
    label: "Production host",
    hint: "A host that IS production. Once any is listed, visits to every other host count as non-production. New visits only.",
    placeholder: "www.example.com",
  },
  user_agent: {
    label: "Automation (user agent)",
    hint: "Text inside a monitor's or script's user agent. New visits only.",
    placeholder: "MyUptimeBot",
  },
};
