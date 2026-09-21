/**
 * Citation detection — pure. Given an answer an AI engine produced for a query,
 * decide whether it actually mentions the brand (by name, domain, or a known
 * alias). Deliberately simple and explainable — "did it say our name" is a
 * yes/no a business can trust, not a similarity score it can't.
 *
 * A NAME MATCH IS WORD-BOUNDED, a domain match is a substring. A bare substring
 * made a two-letter brand ("SG") or a short alias ("Ace") report a citation
 * inside "message" or "space" — a false yes that made the whole report lie. A
 * domain ("sgglass.com") is distinctive enough to match anywhere it appears.
 */
export interface CitationTarget {
  brand: string;
  domain?: string | null;
  aliases?: string[];
}

export interface CitationResult {
  cited: boolean;
  /** "brand" | "domain" | "alias" | null */
  matchedOn: string | null;
  matchedText: string | null;
}

function normalizeDomain(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `needle` appears in `hay` as a whole token — not glued inside a
 * longer word. Boundaries are "not a letter or digit" on either side, Unicode
 * aware, so "Ace" matches "Ace Ramps" and "we love Ace." but not "space".
 */
function matchesWord(hay: string, needle: string): boolean {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, "iu");
  return re.test(hay);
}

export function detectCitation(answer: string, target: CitationTarget): CitationResult {
  const hay = answer.toLowerCase();
  const needles: Array<{ text: string; label: string; raw: string; word: boolean }> = [];
  if (target.brand.trim()) {
    needles.push({ text: target.brand.toLowerCase().trim(), label: "brand", raw: target.brand, word: true });
  }
  if (target.domain && target.domain.trim()) {
    const d = normalizeDomain(target.domain);
    // A domain matches as a substring: it is distinctive, and word boundaries
    // would trip over its own dots.
    if (d) needles.push({ text: d, label: "domain", raw: d, word: false });
  }
  for (const alias of target.aliases ?? []) {
    if (alias.trim()) needles.push({ text: alias.toLowerCase().trim(), label: "alias", raw: alias, word: true });
  }
  for (const n of needles) {
    if (!n.text) continue;
    const hit = n.word ? matchesWord(hay, n.text) : hay.includes(n.text);
    if (hit) return { cited: true, matchedOn: n.label, matchedText: n.raw };
  }
  return { cited: false, matchedOn: null, matchedText: null };
}
