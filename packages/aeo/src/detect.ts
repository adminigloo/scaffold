/**
 * Citation detection — pure. Given an answer an AI engine produced for a query,
 * decide whether it actually mentions the brand (by name, domain, or a known
 * alias). Deliberately simple and explainable: a substring match, case-folded,
 * with the domain stripped to its host — because "did it say our name" is a
 * yes/no a business can trust, not a similarity score it can't.
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

export function detectCitation(answer: string, target: CitationTarget): CitationResult {
  const hay = answer.toLowerCase();
  const needles: Array<{ text: string; label: string; raw: string }> = [];
  if (target.brand.trim()) needles.push({ text: target.brand.toLowerCase().trim(), label: "brand", raw: target.brand });
  if (target.domain && target.domain.trim()) {
    const d = normalizeDomain(target.domain);
    if (d) needles.push({ text: d, label: "domain", raw: d });
  }
  for (const alias of target.aliases ?? []) {
    if (alias.trim()) needles.push({ text: alias.toLowerCase().trim(), label: "alias", raw: alias });
  }
  for (const n of needles) {
    if (n.text && hay.includes(n.text)) {
      return { cited: true, matchedOn: n.label, matchedText: n.raw };
    }
  }
  return { cited: false, matchedOn: null, matchedText: null };
}
