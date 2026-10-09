/**
 * Where a visit came from — one bucket per session, decided once, from the
 * request that started it. Pure: no IO, safe in the ingest hot path, and the
 * whole attribution story rests on it, so it is the most-tested file here.
 *
 * Ported from trailcards' classifier (itself from Riddler) with the gaps that
 * port carried fixed: host matching is by registrable suffix (google.co.uk,
 * lm.facebook.com and android-app:// referrers used to fall through to
 * "referral"), the two entries that were paths and could never match a host
 * are gone, ad click ids count as paid (gclid-only Google Ads traffic used to
 * read as organic), and email has its own bucket.
 *
 * FIRST MATCH WINS, in this order — each step is more specific evidence than
 * the next: offline (a printed QR code says so explicitly) > paid > email >
 * AI assistant > organic search > social > referral > direct.
 */

export const SOURCE_BUCKETS = [
  "offline",
  "paid",
  "email",
  "aiAssistant",
  "organic",
  "social",
  "referral",
  "direct",
] as const;
export type SourceBucket = (typeof SOURCE_BUCKETS)[number];

export const SOURCE_LABELS: Record<SourceBucket, string> = {
  offline: "QR / offline",
  paid: "Paid",
  email: "Email",
  aiAssistant: "AI assistants",
  organic: "Search",
  social: "Social",
  referral: "Referral",
  direct: "Direct",
};

/** Ad-platform click ids. Only WHICH one was present is kept — never its value. */
export const CLICK_ID_PARAMS = ["gclid", "gbraid", "wbraid", "fbclid", "msclkid", "ttclid", "li_fat_id", "twclid"] as const;
export type ClickIdKind = (typeof CLICK_ID_PARAMS)[number];

/**
 * Which version of this classifier a session's `source_bucket` came from —
 * stored on every session (`classifier_version`) so `reclassifySources` can
 * bring history in line after the lists below change. Bump it whenever a
 * change here would put an already-stored session in a different bucket.
 *
 *   1  0.1.0 (rows from 0.1 carry null, read as 1)
 *   2  0.2.0: Microsoft 365 Copilot (`copilot.cloud.microsoft`), AI Studio,
 *      NotebookLM, Duck.ai, Qwen, Kimi and Pi as AI assistants; the Claude,
 *      Perplexity, Gemini and Copilot Android apps; `utm_source=perplexity.ai`,
 *      `claude.ai`, `gemini.google.com`, `copilot.microsoft.com` and similar.
 *      And two hosts NARROWED: `openai.com` → only `chatgpt.com` and
 *      `chat.openai.com` (community., help., platform.openai.com are forums
 *      and docs), `deepseek.com` → `chat.deepseek.com` (platform., api-docs.).
 */
export const SOURCE_CLASSIFIER_VERSION = 2;

/**
 * The AI assistants a visit can come from, by name. Matched on the referrer's
 * HOSTNAME (a registrable suffix: `www.perplexity.ai` is Perplexity), on an
 * exact `utm_source`, or on the Android app's package for an
 * `android-app://` referrer — never on a path or a query, which the stored
 * referrer does not have. So Bing's Copilot answers on `bing.com/chat`, and
 * Google's AI Overviews and AI Mode on `google.com/search`, arrive as their
 * search engine and stay "Search": the referrer cannot tell them apart.
 *
 * Because every subdomain of a listed host matches, a host is listed only
 * when the assistant IS that host and its subdomains: `chatgpt.com`, not
 * `openai.com` (its subdomains are forums, help and the API platform);
 * `chat.deepseek.com`, not `deepseek.com`. `m365.cloud.microsoft` is NOT
 * listed: it is the whole Microsoft 365 app hub, where Copilot Chat is only a
 * path (`/chat`), and a path is never read — the `bing.com/chat` rule.
 * Those visits stay "Referral" under that host. `copilot.cloud.microsoft`,
 * AI Studio, NotebookLM, Duck.ai, Qwen, Kimi, Pi and the Android packages
 * were inferred from the research and not checked against live traffic.
 */
export const AI_ENGINES = [
  {
    id: "chatgpt",
    label: "ChatGPT",
    hosts: ["chatgpt.com", "chat.openai.com"],
    utmSources: ["chatgpt", "chatgpt.com", "chat.openai.com", "openai"],
    androidApps: ["com.openai.chatgpt"],
  },
  {
    id: "perplexity",
    label: "Perplexity",
    hosts: ["perplexity.ai"],
    utmSources: ["perplexity", "perplexity.ai"],
    androidApps: ["ai.perplexity.app.android"],
  },
  {
    id: "claude",
    label: "Claude",
    hosts: ["claude.ai"],
    utmSources: ["claude", "claude.ai", "anthropic"],
    androidApps: ["com.anthropic.claude"],
  },
  {
    id: "gemini",
    label: "Gemini",
    hosts: ["gemini.google.com", "bard.google.com", "aistudio.google.com", "notebooklm.google.com"],
    utmSources: ["gemini", "google_gemini", "gemini.google.com", "bard"],
    androidApps: ["com.google.android.apps.bard"],
  },
  {
    id: "copilot",
    label: "Microsoft Copilot",
    hosts: ["copilot.microsoft.com", "copilot.cloud.microsoft"],
    utmSources: ["copilot", "bing_copilot", "copilot.microsoft.com"],
    androidApps: ["com.microsoft.copilot"],
  },
  { id: "you", label: "You.com", hosts: ["you.com"], utmSources: ["you.com"], androidApps: [] },
  { id: "phind", label: "Phind", hosts: ["phind.com"], utmSources: ["phind", "phind.com"], androidApps: [] },
  { id: "poe", label: "Poe", hosts: ["poe.com"], utmSources: ["poe", "poe.com"], androidApps: [] },
  { id: "meta", label: "Meta AI", hosts: ["meta.ai"], utmSources: ["meta.ai"], androidApps: [] },
  { id: "mistral", label: "Le Chat (Mistral)", hosts: ["chat.mistral.ai"], utmSources: ["mistral", "chat.mistral.ai"], androidApps: [] },
  { id: "deepseek", label: "DeepSeek", hosts: ["chat.deepseek.com"], utmSources: ["deepseek", "chat.deepseek.com"], androidApps: [] },
  { id: "grok", label: "Grok", hosts: ["grok.com"], utmSources: ["grok", "grok.com"], androidApps: [] },
  { id: "duckai", label: "Duck.ai", hosts: ["duck.ai"], utmSources: ["duck.ai"], androidApps: [] },
  { id: "qwen", label: "Qwen", hosts: ["chat.qwen.ai"], utmSources: ["qwen", "chat.qwen.ai"], androidApps: [] },
  { id: "kimi", label: "Kimi", hosts: ["kimi.com"], utmSources: ["kimi", "kimi.com"], androidApps: [] },
  { id: "pi", label: "Pi", hosts: ["pi.ai"], utmSources: ["pi.ai"], androidApps: [] },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  hosts: readonly string[];
  utmSources: readonly string[];
  androidApps: readonly string[];
}>;

export type AiEngineId = (typeof AI_ENGINES)[number]["id"];

export const AI_ENGINE_LABELS = Object.fromEntries(AI_ENGINES.map((engine) => [engine.id, engine.label])) as Record<AiEngineId, string>;

/** A host `AI_ASSISTANT_DOMAINS` lists. */
export type AiAssistantDomain = (typeof AI_ENGINES)[number]["hosts"][number];
/** A `utm_source` value `AI_ASSISTANT_UTM_SOURCES` lists. */
export type AiAssistantUtmSource = (typeof AI_ENGINES)[number]["utmSources"][number];

/**
 * Registrable domains, matched as a suffix of the referrer host — every AI
 * engine's hosts. (Search rules list the second-level label instead, so every
 * ccTLD — google.co.uk, google.de — matches.) 0.1 exported a fixed tuple; this
 * is a readonly array whose ELEMENT type is still the literal union, so
 * `(typeof AI_ASSISTANT_DOMAINS)[number]` keeps meaning "one of these hosts".
 */
export const AI_ASSISTANT_DOMAINS: readonly AiAssistantDomain[] = AI_ENGINES.flatMap((engine) => engine.hosts);

/** Exact `utm_source` values (lower-cased) that name an AI assistant. Element type: the literal union, as in 0.1. */
export const AI_ASSISTANT_UTM_SOURCES: readonly AiAssistantUtmSource[] = AI_ENGINES.flatMap((engine) => engine.utmSources);

/**
 * Which AI assistant a visit came from, or null. Takes the stored pair
 * (`{ referrerHost, utmSource }`; a utm that names an engine wins over the
 * host), or one string — a referrer URL or host, or a `utm_source` value.
 * Hostnames only: a path is never read (`bing.com/chat` is Bing, not Copilot).
 */
export function aiEngineOf(input: string | { referrerHost?: string | null; utmSource?: string | null } | null | undefined): AiEngineId | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return null;
    return engineOfHost(referrerHostOf(text, [])) ?? engineOfUtm(text);
  }
  return engineOfUtm(input.utmSource) ?? engineOfHost(lower(input.referrerHost));
}

function engineOfUtm(value: string | null | undefined): AiEngineId | null {
  const utm = lower(value);
  if (!utm) return null;
  for (const engine of AI_ENGINES) if ((engine.utmSources as readonly string[]).includes(utm)) return engine.id;
  return null;
}

function engineOfHost(host: string | null): AiEngineId | null {
  if (!host) return null;
  if (host.startsWith("android-app:")) {
    const pkg = host.slice("android-app:".length);
    for (const engine of AI_ENGINES) {
      if ((engine.androidApps as readonly string[]).some((app) => pkg === app || pkg.startsWith(`${app}.`))) return engine.id;
    }
    return null;
  }
  for (const engine of AI_ENGINES) if (engine.hosts.some((domain) => hostMatches(host, domain))) return engine.id;
  return null;
}

/** Search engines: matched by second-level label so ccTLDs come along. */
export const SEARCH_ENGINE_LABELS = ["google", "bing", "duckduckgo", "yahoo", "ecosia", "yandex", "baidu", "naver", "qwant", "startpage"] as const;
export const SEARCH_ENGINE_DOMAINS = ["search.brave.com", "kagi.com", "search.yahoo.com"] as const;

export const SOCIAL_DOMAINS = [
  "facebook.com",
  "fb.com",
  "t.co",
  "twitter.com",
  "x.com",
  "instagram.com",
  "linkedin.com",
  "lnkd.in",
  "pinterest.com",
  "pin.it",
  "reddit.com",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "threads.net",
  "bsky.app",
  "mastodon.social",
  "news.ycombinator.com",
  "producthunt.com",
  "discord.com",
  "slack.com",
  "whatsapp.com",
  "telegram.org",
] as const;

/** Android apps send `android-app://<package>/`; the package names a few channels. */
const ANDROID_APP_BUCKETS: Array<[RegExp, SourceBucket]> = [
  [/^com\.google\.android\.googlequicksearchbox/, "organic"],
  [/^com\.google\.android\.gm/, "email"],
  [/^com\.(facebook|instagram|twitter|linkedin|reddit|zhiliaoapp\.musically|pinterest)/, "social"],
  // AI assistants' apps (ChatGPT, Claude, Perplexity, Gemini, Copilot) come from AI_ENGINES, checked first.
];

const PAID_MEDIUMS = new Set(["cpc", "cpm", "ppc", "cpv", "paid", "paidsearch", "paid_search", "paid_social", "paidsocial", "display", "retargeting", "affiliate"]);
const PAID_SOURCES = new Set(["google_ads", "googleads", "google-ads", "adwords", "facebook_ads", "facebookads", "facebook-ads", "meta_ads", "tiktok_ads", "bing_ads", "microsoft_ads", "linkedin_ads", "reddit_ads"]);
const EMAIL_MEDIUMS = new Set(["email", "e-mail", "newsletter", "mail"]);
const OFFLINE_MEDIUMS = new Set(["qr", "physical", "print", "offline", "packaging"]);

export interface ClassifySourceInput {
  /** Lower-cased referrer host (or `android-app:<package>`), already self-referral-filtered. */
  referrerHost?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  clickIdKind?: ClickIdKind | null;
}

function lower(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/** True when `host` is `domain` or a subdomain of it. */
export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * True when the host IS the engine's front door under any country domain:
 * google.co.uk, www.google.de, m.google.com — but not mail.google.com or
 * docs.google.com, which share the label and are not search.
 */
function isEngineFrontDoor(host: string, label: string): boolean {
  const parts = host.split(".");
  // Strip a two-part public suffix like co.uk / com.au before reading the label.
  const twoPartSuffix = parts.length >= 3 && /^(co|com|org|net|ac|gov|edu|ne|or)$/.test(parts[parts.length - 2] ?? "");
  const labelIndex = parts.length - (twoPartSuffix ? 3 : 2);
  if (labelIndex < 0 || parts[labelIndex] !== label) return false;
  const subdomain = parts.slice(0, labelIndex).join(".");
  return subdomain === "" || subdomain === "www" || subdomain === "m" || subdomain === "search";
}

/** Webmail front ends: a click from an email read in the browser. */
export const EMAIL_DOMAINS = [
  "mail.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "outlook.office365.com",
  "mail.yahoo.com",
  "mail.proton.me",
  "app.hey.com",
  "fastmail.com",
] as const;

export function isEmailHost(host: string): boolean {
  return EMAIL_DOMAINS.some((domain) => hostMatches(host, domain));
}

export function isAiAssistantHost(host: string): boolean {
  return AI_ASSISTANT_DOMAINS.some((domain) => hostMatches(host, domain));
}

export function isSearchHost(host: string): boolean {
  if (SEARCH_ENGINE_DOMAINS.some((domain) => hostMatches(host, domain))) return true;
  return SEARCH_ENGINE_LABELS.some((label) => isEngineFrontDoor(host, label));
}

export function isSocialHost(host: string): boolean {
  return SOCIAL_DOMAINS.some((domain) => hostMatches(host, domain));
}

export function classifySource(input: ClassifySourceInput): SourceBucket {
  const utmSource = lower(input.utmSource);
  const utmMedium = lower(input.utmMedium);
  const host = lower(input.referrerHost);

  if (utmSource === "qr" || (utmMedium && OFFLINE_MEDIUMS.has(utmMedium))) return "offline";

  if (input.clickIdKind) return "paid";
  if (utmMedium && PAID_MEDIUMS.has(utmMedium)) return "paid";
  if (utmSource && PAID_SOURCES.has(utmSource)) return "paid";

  if (utmMedium && EMAIL_MEDIUMS.has(utmMedium)) return "email";

  if (utmSource && (AI_ASSISTANT_UTM_SOURCES as readonly string[]).includes(utmSource)) return "aiAssistant";

  if (host?.startsWith("android-app:")) {
    if (engineOfHost(host)) return "aiAssistant";
    const pkg = host.slice("android-app:".length);
    for (const [pattern, bucket] of ANDROID_APP_BUCKETS) if (pattern.test(pkg)) return bucket;
    return "referral";
  }

  if (host && isAiAssistantHost(host)) return "aiAssistant";
  if (host && isEmailHost(host)) return "email";
  if (host && isSearchHost(host)) return "organic";
  if (host && isSocialHost(host)) return "social";
  if (host) return "referral";

  // A utm_source with no referrer (a link in a PDF, an app, a bookmarked
  // campaign URL) is still somebody's campaign, not a typed-in address.
  if (utmSource) return "referral";
  return "direct";
}

/**
 * The referrer as stored: its host only, lower-cased, `www.` kept off, and
 * null for a self-referral or anything unparseable. The path and query never
 * leave this function — a referrer URL can carry a search query, a document
 * name or a token, and the host is all attribution needs.
 */
export function referrerHostOf(referrer: string | null | undefined, ownHosts: readonly string[]): string | null {
  if (!referrer) return null;
  const value = referrer.trim();
  if (!value) return null;
  const android = /^android-app:\/\/([^/]+)/i.exec(value);
  if (android?.[1]) return `android-app:${android[1].toLowerCase()}`;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;
  const bare = host.replace(/^www\./, "");
  // Own hosts may carry a port ("localhost:3000"); a URL's hostname never does.
  if (ownHosts.some((own) => bare === own.toLowerCase().replace(/:\d+$/, "").replace(/^www\./, ""))) return null;
  return bare;
}

/** Which ad click id the landing URL carried, if any. */
export function clickIdKindOf(params: URLSearchParams | Record<string, string | undefined>): ClickIdKind | null {
  const get = (key: string) => (params instanceof URLSearchParams ? params.get(key) : params[key]);
  for (const key of CLICK_ID_PARAMS) if (get(key)) return key;
  return null;
}
