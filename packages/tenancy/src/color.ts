/**
 * Brand colour and contrast (contract 5.2). The maths is Riddler Go's
 * `domain/branding/schema.ts`, re-implemented: WCAG 2.x channel
 * linearisation, the 0.2126/0.7152/0.0722 luminance weights, and
 * (L1 + 0.05) / (L2 + 0.05).
 *
 * WARN, NEVER BLOCK. A colour is never refused for contrast: an owner's brand
 * is theirs. The report says what will be hard to read and how to use the
 * colour well (behind dark text, say), and the choice stays theirs.
 *
 * `@adminigloo/tenancy-widget` keeps a copy for the live preview; its parity
 * test checks the two agree on 500 generated colours.
 */

export const AA_TEXT_RATIO = 4.5;

/** "#ABC" | "abc" | "#aabbcc" | "aabbcc" → "#aabbcc"; anything else → null. */
export function normaliseHexColor(input: string): string | null {
  if (typeof input !== "string") return null;
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!match) return null;
  const digits = (match[1] as string).toLowerCase();
  return `#${digits.length === 3 ? [...digits].map((d) => d + d).join("") : digits}`;
}

/** sRGB channel (0–255) → linear light, WCAG 2.x. */
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * linear((n >> 16) & 255) + 0.7152 * linear((n >> 8) & 255) + 0.0722 * linear(n & 255);
}

/** The WCAG 2.x contrast ratio of two hex colours (1 … 21). An unreadable colour counts as black. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(normaliseHexColor(a) ?? "#000000");
  const lb = luminance(normaliseHexColor(b) ?? "#000000");
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export interface BrandColorReport {
  readonly color: string;
  readonly textOnColor: "#ffffff" | "#111111";
  readonly ratioWithWhiteText: number;
  readonly ratioWithDarkText: number;
  readonly ratioOnWhitePage: number;
  readonly readable: boolean;
  readonly warning: string | null;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

export const HARD_TO_READ_WARNING = "Text on this colour is hard to read. A darker or lighter shade will work better.";
export const LIGHT_COLOUR_WARNING =
  "This colour is light, so links and headings in it will be hard to read on a white page. It works best as a background behind dark text.";

/**
 * How a brand colour reads: which text colour sits on it, both ratios, and a
 * plain warning when it will be hard to read. Null for an unparseable colour.
 *
 * DECISION: `readable` is decided on the two ratios as reported (2 decimals),
 * so the sentence the owner reads ("4.5 to 1, easy to read") never disagrees
 * with the number beside it.
 */
export function brandColorReport(hex: string): BrandColorReport | null {
  const color = normaliseHexColor(hex);
  if (!color) return null;
  const ratioWithWhiteText = round2(contrastRatio(color, "#ffffff"));
  const ratioWithDarkText = round2(contrastRatio(color, "#111111"));
  const textOnColor = ratioWithWhiteText >= ratioWithDarkText ? "#ffffff" : "#111111";
  const readable = Math.max(ratioWithWhiteText, ratioWithDarkText) >= AA_TEXT_RATIO;
  const ratioOnWhitePage = ratioWithWhiteText;
  const warning = !readable ? HARD_TO_READ_WARNING : ratioOnWhitePage < 3 ? LIGHT_COLOUR_WARNING : null;
  return { color, textOnColor, ratioWithWhiteText, ratioWithDarkText, ratioOnWhitePage, readable, warning };
}
