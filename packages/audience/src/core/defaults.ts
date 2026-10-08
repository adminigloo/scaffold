import type { HeadersLike } from "./types.js";

/**
 * What is excluded with no configuration at all. Every list is exported so a
 * README, a test and the admin panel's "always excluded" note all read the
 * same values; every group can be switched off with `defaults: { … false }`.
 */

/** Addresses test tooling creates. Matched as substrings of the lower-cased, unfolded address. */
export const DEFAULT_EMAIL_PATTERNS: readonly string[] = ["+clerk_test@", "+test@"];

/**
 * Reserved for documentation and testing (RFC 2606 / RFC 6761): no real
 * customer has an address here. Matched as the domain or any subdomain.
 */
export const DEFAULT_EMAIL_DOMAINS: readonly string[] = [
  "example.com",
  "example.org",
  "example.net",
  "test",
  "invalid",
  "localhost",
];

/**
 * Hosts that are never production. "*.vercel.app" is every preview
 * deployment — if your production site really is served from a vercel.app
 * address, add it as a `host` rule (or `productionHosts`) and it is exempt.
 */
export const DEFAULT_NON_PRODUCTION_HOSTS: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "*.localhost",
  "*.vercel.app",
];

/**
 * Automation: browsers driven by scripts, audits, uptime monitors and
 * synthetic checks. Case-insensitive substrings of the user agent.
 */
export const DEFAULT_AUTOMATION_AGENTS: readonly string[] = [
  "headlesschrome",
  "playwright",
  "puppeteer",
  "selenium",
  "webdriver",
  "phantomjs",
  "cypress",
  "chrome-lighthouse",
  "lighthouse",
  "pagespeed",
  "gtmetrix",
  "uptimerobot",
  "checkly",
  "pingdom",
  "statuscake",
  "datadogsynthetics",
  "newrelicsynthetics",
  "site24x7",
  "betteruptime",
  "better stack",
  "vercel-screenshot",
  "vercelbot",
];

/**
 * The header a smoke test sends to say "this is us". Its default VALUE is not
 * here on purpose: a public value lets anyone hide their visits. It is derived
 * from AUDIENCE_SECRET (`testHeaderValueFor`, or `audience.testHeader`).
 */
export const DEFAULT_TEST_HEADER = { name: "x-aig-audience" } as const;

/** URL parameter for the per-request "include internal" view. Never persisted. */
export const INCLUDE_INTERNAL_PARAM = "include_internal";

/** URL parameter that carries a signed device link (`?internal=<token>`). */
export const DEVICE_LINK_PARAM = "internal";

export interface AudienceDefaults {
  /** `+clerk_test@`, `+test@`. */
  emailPatterns: boolean;
  /** example.com/.org/.net, *.test, *.invalid, *.localhost. */
  emailDomains: boolean;
  /** localhost, loopback, *.localhost, *.vercel.app. */
  hosts: boolean;
  /** The automation user-agent list and `navigator.webdriver`. */
  automation: boolean;
  /** Crawler user agents, reported apart from internal traffic. */
  bots: boolean;
}

export const ALL_DEFAULTS: AudienceDefaults = {
  emailPatterns: true,
  emailDomains: true,
  hosts: true,
  automation: true,
  bots: true,
};

export function resolveDefaults(option: Partial<AudienceDefaults> | false | undefined): AudienceDefaults {
  if (option === false) {
    return { emailPatterns: false, emailDomains: false, hosts: false, automation: false, bots: false };
  }
  return { ...ALL_DEFAULTS, ...(option ?? {}) };
}

/** Which automation entry a user agent carries, or null. */
export function automationAgentOf(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  return DEFAULT_AUTOMATION_AGENTS.find((needle) => ua.includes(needle)) ?? null;
}

/**
 * Is this a crawler? Name/version tokens ("Googlebot/2.1", "GPTBot/1.0"), the
 * "+http…" contact URL crawlers put in their agent, and a few that do
 * neither. Deliberately NOT a bare "bot" substring: a CUBOT phone is a
 * person. Automation is checked first by the classifier, so an uptime
 * monitor ("UptimeRobot/2.0") is automation, not a bot.
 */
export function isBotAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return (
    /(?:bot|crawler|spider|crawl|fetcher)\/\d/i.test(userAgent) ||
    /\+https?:\/\//i.test(userAgent) ||
    /\b(?:facebookexternalhit|slurp|mediapartners-google|bingpreview|embedly|quora link preview|whatsapp|telegrambot|discordbot|slackbot|twitterbot|linkedinbot)\b/i.test(
      userAgent,
    )
  );
}

/** Case-insensitive header read from a Fetch `Headers` or a plain object. */
export function headerValue(headers: HeadersLike | null | undefined, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(n: string): string | null }).get(name);
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined | null>)) {
    if (key.toLowerCase() !== lower || value === undefined || value === null) continue;
    return Array.isArray(value) ? value.join(", ") : value;
  }
  return null;
}

/** Global Privacy Control or Do Not Track. Apps drop these beacons; the package never links them. */
export function isPrivacyOptOut(headers: HeadersLike | null | undefined): boolean {
  return headerValue(headers, "sec-gpc")?.trim() === "1" || headerValue(headers, "dnt")?.trim() === "1";
}

/**
 * The client IP as a proxy reports it: the first `x-forwarded-for` entry,
 * else `x-real-ip`. Only trustworthy behind a proxy that sets it (Vercel
 * does); a forged value can only ever hide the forger's own visit, because
 * a network rule only ever EXCLUDES.
 */
export function clientIpFrom(headers: HeadersLike | null | undefined): string | null {
  const forwarded = headerValue(headers, "x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;
  return headerValue(headers, "x-real-ip")?.trim() || null;
}

/**
 * The deployment is not production — FAILING OPEN, like trailcards'
 * `isNonProductionDeployment`: only a positive signal says "not production"
 * (VERCEL_ENV set to something other than "production", or NODE_ENV
 * "development"). An unknown environment counts, because a production site
 * silently excluding everyone is worse than a preview counting a few visits.
 */
export function isNonProductionEnv(
  env: Readonly<Record<string, string | undefined>> = typeof process === "undefined" ? {} : process.env,
): boolean {
  const vercel = env.VERCEL_ENV?.trim();
  if (vercel) return vercel !== "production";
  return env.NODE_ENV === "development";
}

/** Read the per-request include-internal flag from a URL's search params. */
export function readIncludeInternal(
  params: URLSearchParams | Readonly<Record<string, string | string[] | undefined>> | null | undefined,
  name: string = INCLUDE_INTERNAL_PARAM,
): boolean {
  if (!params) return false;
  const raw =
    params instanceof URLSearchParams
      ? params.get(name)
      : ((Array.isArray(params[name]) ? params[name]?.[0] : params[name]) as string | undefined);
  return raw === "1" || raw === "true" || raw === "on";
}

/**
 * The same URL with the include-internal flag set or cleared — the toggle's
 * href. Works on a path ("/admin/analytics?range=30d") or a full URL.
 */
export function includeInternalHref(url: string, on: boolean, name: string = INCLUDE_INTERNAL_PARAM): string {
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url);
  const parsed = new URL(url, "http://placeholder.invalid");
  if (on) parsed.searchParams.set(name, "1");
  else parsed.searchParams.delete(name);
  if (absolute) return parsed.toString();
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
