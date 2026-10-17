/**
 * WAS THE BUSINESS NAMED? — pure (0.2). Given an answer an AI engine produced
 * for a customer's question and the sources it cited, CODE decides: did it
 * name the business (by name, website or another name it goes by), did it
 * cite the business's own website, which competitors did it name, and the
 * sentence that shows it. The model is never asked any of this — "did it say
 * our name" is a yes/no a business can trust, and it is worked out here.
 *
 * EVERY MATCH IS BOUNDED. A name or another name matches as a whole word; a
 * website as a whole host (`domainIndex`); a cited source by its host name
 * (`isOwnSource`). A bare substring made "SG" match inside "message", "Ace"
 * inside "space" and ace.co inside grace.com — a false "Named you" that made
 * the whole report lie.
 *
 * POSITIONS ARE IN THE ORIGINAL TEXT: every search is a case-insensitive
 * regex over what the answer said, never over a lower-cased copy (lower-casing
 * can change a string's length, and a quote cut at a shifted index is wrong).
 */
export interface CitationTarget {
  brand: string;
  domain?: string | null;
  aliases?: readonly string[];
}

export interface CitationResult {
  cited: boolean;
  /** "brand" | "domain" | "alias" | null */
  matchedOn: string | null;
  matchedText: string | null;
}

/** "https://www.SGGlass.com/quote" → "sgglass.com". */
export function normalizeDomain(domain: string): string {
  return domain
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where `needle` first appears in `text` as a whole word — not glued inside a longer one; -1 when it doesn't. */
function wordIndex(text: string, needle: string): number {
  const word = needle.trim();
  if (!word) return -1;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, "iu");
  const match = re.exec(text);
  return match ? match.index : -1;
}

/**
 * Where the website `domain` — or a part of it, like www. or shop. — first
 * appears in `text` as a whole host: "ace.co" in "see ace.co/prices" and
 * "shop.ace.co", never in "grace.com", "place.com" or "ace.com". Before the
 * host: nothing that could continue a host name (a letter, digit, dot or
 * hyphen). After it: nothing that could continue its last label (a letter,
 * digit or hyphen), nor a dot followed by more of a name ("ace.co.uk"); a
 * path, punctuation or the end of the text is fine. Returns where the domain
 * itself starts, or -1.
 */
export function domainIndex(text: string, domain: string): number {
  const d = normalizeDomain(domain);
  if (!d || !d.includes(".")) return -1;
  const re = new RegExp(`(?<![a-z0-9.-])(?:[a-z0-9-]+\\.)*${escapeRegExp(d)}(?![a-z0-9-])(?!\\.[a-z0-9])`, "gi");
  const match = re.exec(text);
  return match ? match.index + match[0].length - d.length : -1;
}

interface Mention {
  readonly label: "brand" | "domain" | "alias";
  readonly raw: string;
  readonly index: number;
}

/** The earliest mention of the business in the text, by name, website or another name; null when there is none. */
function firstMention(text: string, target: CitationTarget): Mention | null {
  const found: Mention[] = [];
  const brand = target.brand.trim();
  if (brand) {
    const at = wordIndex(text, brand);
    if (at >= 0) found.push({ label: "brand", raw: target.brand, index: at });
  }
  if (target.domain && target.domain.trim()) {
    const at = domainIndex(text, target.domain);
    if (at >= 0) found.push({ label: "domain", raw: normalizeDomain(target.domain), index: at });
  }
  for (const alias of target.aliases ?? []) {
    const at = wordIndex(text, alias);
    if (at >= 0) found.push({ label: "alias", raw: alias, index: at });
  }
  if (found.length === 0) return null;
  // The order the rules are listed in breaks a tie: the brand first.
  return found.reduce((best, m) => (m.index < best.index ? m : best));
}

/** 0.1's yes/no, by name, website or alias. */
export function detectCitation(answer: string, target: CitationTarget): CitationResult {
  if (target.brand.trim() && wordIndex(answer, target.brand) >= 0) return { cited: true, matchedOn: "brand", matchedText: target.brand };
  if (target.domain && target.domain.trim() && domainIndex(answer, target.domain) >= 0) {
    return { cited: true, matchedOn: "domain", matchedText: normalizeDomain(target.domain) };
  }
  for (const alias of target.aliases ?? []) {
    if (wordIndex(answer, alias) >= 0) return { cited: true, matchedOn: "alias", matchedText: alias };
  }
  return { cited: false, matchedOn: null, matchedText: null };
}

/** Is this address on the business's own website — its domain exactly, or a part of it (shop.), www. aside? By host name only. */
export function isOwnSource(url: string, domain: string | null | undefined): boolean {
  if (!domain) return false;
  const own = normalizeDomain(domain);
  if (!own || !own.includes(".")) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  } catch {
    return false;
  }
  return host === own || host.endsWith(`.${own}`);
}

export interface AnswerAnalysis {
  /** Mentioned by name in the answer, OR its own website among the sources: the yes/no a report counts. */
  cited: boolean;
  /** Named in the answer's words (by name, website or another name). */
  mentioned: boolean;
  /** The business's own website is one of the sources the engine cited. */
  sourceCited: boolean;
  /** How: "brand", "domain" or "alias" (in the words), "source" (only in the sources), or null. */
  matchedOn: "brand" | "domain" | "alias" | "source" | null;
  matchedText: string | null;
  /** The cited address on the business's own website, when there was one. */
  matchedUrl: string | null;
  /** The answer's words around the first mention (about 240 characters), or null when it wasn't named. */
  snippet: string | null;
  /** Competitors the answer named, in the order they were listed. */
  competitorsNamed: string[];
}

/** The answer's words around `index`: 80 characters before, 160 after, on word edges where it can. */
export function snippetAround(text: string, index: number): string {
  let start = Math.max(0, index - 80);
  let end = Math.min(text.length, index + 160);
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space !== -1 && space < index) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > index) end = space;
  }
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

/** Decide everything a check records from what the engine said and cited. */
export function analyzeAnswer(
  answer: { readonly text: string; readonly citedUrls: readonly string[] },
  target: CitationTarget,
  competitors: readonly string[] = [],
): AnswerAnalysis {
  const text = answer.text ?? "";
  const mention = firstMention(text, target);
  const ownSource = answer.citedUrls.find((url) => isOwnSource(url, target.domain)) ?? null;
  const own = new Set([target.brand, ...(target.aliases ?? [])].map((name) => name.trim().toLowerCase()).filter(Boolean));
  const named: { name: string; at: number }[] = [];
  for (const competitor of competitors) {
    const name = competitor.trim();
    if (!name || own.has(name.toLowerCase()) || named.some((n) => n.name.toLowerCase() === name.toLowerCase())) continue;
    const at = wordIndex(text, name);
    if (at >= 0) named.push({ name, at });
  }
  return {
    cited: mention !== null || ownSource !== null,
    mentioned: mention !== null,
    sourceCited: ownSource !== null,
    matchedOn: mention ? mention.label : ownSource ? "source" : null,
    matchedText: mention ? mention.raw : ownSource ? normalizeDomain(target.domain ?? "") : null,
    matchedUrl: ownSource,
    snippet: mention ? snippetAround(text, mention.index) : null,
    competitorsNamed: named.sort((a, b) => a.at - b.at).map((n) => n.name),
  };
}
