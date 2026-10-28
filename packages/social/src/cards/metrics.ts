/**
 * TEXT THAT FITS, measured with the font's own widths. A card's words come
 * from a post (any length), and satori draws them where it's told: too many
 * and they run off the image. So every block of text is sized here first,
 * from the advance widths in the font file the card is drawn with, wrapped
 * the way satori wraps (greedy, at spaces, a word too long for a line broken
 * by letters), and given the largest of a few fixed sizes it fits at. Nothing
 * fits even at the smallest: the words are cut at a word, with an ellipsis.
 *
 * Kerning is left out (it nearly always tightens a line) and lines are
 * measured against 97% of the box, so a line this module says fits does.
 */

/** A font's advance widths, in its own units. */
export interface FontMetrics {
  readonly unitsPerEm: number;
  readonly widths: ReadonlyMap<number, number>;
  /** For a character the font doesn't draw (satori falls back to another font): about an "M". */
  readonly fallback: number;
}

/** Read the advance widths out of a TrueType/OpenType file (head, hhea, hmtx and cmap formats 4 and 12). */
export function parseFontMetrics(data: ArrayBuffer | Uint8Array): FontMetrics {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map<string, number>();
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
    tables.set(tag, view.getUint32(at + 8));
  }
  const head = tables.get("head");
  const hhea = tables.get("hhea");
  const hmtx = tables.get("hmtx");
  const cmap = tables.get("cmap");
  if (head === undefined || hhea === undefined || hmtx === undefined || cmap === undefined) throw new Error("Not a TrueType or OpenType font this module can read.");
  const unitsPerEm = view.getUint16(head + 18);
  const hMetrics = view.getUint16(hhea + 34);
  const advance = (glyph: number) => view.getUint16(hmtx + 4 * Math.min(glyph, hMetrics - 1));

  // The Unicode subtable: full repertoire (format 12) first, then the BMP one (format 4).
  let format4: number | null = null;
  let format12: number | null = null;
  const subtables = view.getUint16(cmap + 2);
  for (let i = 0; i < subtables; i++) {
    const platform = view.getUint16(cmap + 4 + i * 8);
    const encoding = view.getUint16(cmap + 6 + i * 8);
    const offset = cmap + view.getUint32(cmap + 8 + i * 8);
    const format = view.getUint16(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (format === 12) format12 ??= offset;
    if (format === 4) format4 ??= offset;
  }
  const widths = new Map<number, number>();
  if (format12 !== null) {
    const groups = view.getUint32(format12 + 12);
    for (let g = 0; g < groups; g++) {
      const at = format12 + 16 + g * 12;
      const start = view.getUint32(at);
      const end = Math.min(view.getUint32(at + 4), start + 0xffff);
      const glyph = view.getUint32(at + 8);
      for (let code = start; code <= end; code++) widths.set(code, advance(glyph + code - start));
    }
  } else if (format4 !== null) {
    const segments = view.getUint16(format4 + 6) / 2;
    const ends = format4 + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    for (let s = 0; s < segments; s++) {
      const start = view.getUint16(starts + s * 2);
      const end = view.getUint16(ends + s * 2);
      const delta = view.getInt16(deltas + s * 2);
      const range = view.getUint16(ranges + s * 2);
      for (let code = start; code <= end && code !== 0xffff; code++) {
        let glyph: number;
        if (range === 0) glyph = (code + delta) & 0xffff;
        else {
          const raw = view.getUint16(ranges + s * 2 + range + (code - start) * 2);
          glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
        }
        if (glyph !== 0) widths.set(code, advance(glyph));
      }
    }
  }
  if (widths.size === 0) throw new Error("The font has no Unicode character map.");
  return { unitsPerEm, widths, fallback: widths.get(0x4d) ?? unitsPerEm * 0.75 };
}

/** How wide `text` is at `size` pixels (plus `tracking` em between letters, as CSS letter-spacing). */
export function textWidth(metrics: FontMetrics, text: string, size: number, tracking = 0): number {
  let units = 0;
  let letters = 0;
  for (const char of text) {
    units += metrics.widths.get(char.codePointAt(0)!) ?? metrics.fallback;
    letters++;
  }
  return (units / metrics.unitsPerEm) * size + Math.max(0, tracking) * size * letters;
}

/** The safety margin every line is measured against. */
export const FIT_SLACK = 0.97;

/**
 * The lines satori will draw `text` in, in a box `width` wide: greedy, at
 * spaces; a word wider than the box broken by letters (the cards set
 * word-break so satori does the same). A newline starts a new line.
 */
export function wrapLines(metrics: FontMetrics, text: string, size: number, width: number, tracking = 0): string[] {
  const room = width * FIT_SLACK;
  const space = textWidth(metrics, " ", size, tracking);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    let lineWidth = 0;
    for (const word of words) {
      let w = textWidth(metrics, word, size, tracking);
      if (line && lineWidth + space + w <= room) {
        line += ` ${word}`;
        lineWidth += space + w;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      lineWidth = 0;
      let rest = word;
      while (w > room) {
        // Break a too-long word by letters.
        let cut = "";
        for (const char of rest) {
          if (textWidth(metrics, cut + char, size, tracking) > room) break;
          cut += char;
        }
        if (!cut) cut = [...rest][0]!;
        lines.push(cut);
        rest = rest.slice(cut.length);
        w = textWidth(metrics, rest, size, tracking);
      }
      line = rest;
      lineWidth = w;
    }
    lines.push(line);
  }
  return lines;
}

/** Where a block of text must fit. */
export interface FitBox {
  readonly width: number;
  readonly height: number;
  /** Font sizes to try, largest first. */
  readonly sizes: readonly number[];
  /** Line height as a multiple of the font size. */
  readonly lineHeight: number;
  /** At most this many lines, whatever the height allows. */
  readonly maxLines?: number;
  /** Letter spacing in em (CSS letter-spacing); only a positive value widens a line. */
  readonly tracking?: number;
}

/** The size a block was given, the lines it wraps to, and the text as drawn (cut, if it had to be). */
export interface Fitted {
  readonly size: number;
  readonly lines: readonly string[];
  readonly text: string;
  readonly height: number;
  readonly cut: boolean;
  /**
   * A word wider than the line had to be broken by letters. The card then
   * lets satori break words too, and doesn't balance the lines: balancing
   * narrows the box, and with words allowed to break it breaks them
   * ("thermometer / s") rather than wrapping.
   */
  readonly broken: boolean;
}

/** Is any one word wider than a line? */
function overlong(metrics: FontMetrics, text: string, size: number, width: number, tracking = 0): boolean {
  return text.split(/\s+/).some((word) => textWidth(metrics, word, size, tracking) > width * FIT_SLACK);
}

function fits(box: FitBox, lines: readonly string[], size: number): boolean {
  return lines.length <= Math.max(1, Math.floor(box.height / (size * box.lineHeight))) && lines.length <= (box.maxLines ?? Infinity);
}

/** The largest of `box.sizes` the text fits at; else the smallest, with the text cut at a word to fit. */
export function fitText(metrics: FontMetrics, text: string, box: FitBox): Fitted {
  const clean = text
    .split("\n")
    .map((p) => p.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  for (const size of box.sizes) {
    const lines = wrapLines(metrics, clean, size, box.width, box.tracking);
    if (fits(box, lines, size)) return { size, lines, text: clean, height: lines.length * size * box.lineHeight, cut: false, broken: overlong(metrics, clean, size, box.width, box.tracking) };
  }
  const size = box.sizes[box.sizes.length - 1]!;
  let words = clean.split(" ");
  while (words.length > 1) {
    words = words.slice(0, -1);
    const shorter = `${words.join(" ").replace(/[\s,;:.–—-]+$/, "")}…`;
    const lines = wrapLines(metrics, shorter, size, box.width, box.tracking);
    if (fits(box, lines, size)) return { size, lines, text: shorter, height: lines.length * size * box.lineHeight, cut: true, broken: overlong(metrics, shorter, size, box.width, box.tracking) };
  }
  // One word left that doesn't fit: as many of its letters as fit on the lines allowed.
  const allowed = Math.max(1, Math.min(box.maxLines ?? Infinity, Math.floor(box.height / (size * box.lineHeight))));
  const lines = wrapLines(metrics, `${words[0] ?? ""}`, size, box.width, box.tracking).slice(0, allowed);
  let last = [...(lines[lines.length - 1] ?? "")];
  do last = last.slice(0, -1);
  while (last.length > 0 && textWidth(metrics, `${last.join("")}…`, size, box.tracking) > box.width * FIT_SLACK);
  lines[lines.length - 1] = `${last.join("")}…`;
  return { size, lines, text: lines.join(""), height: lines.length * size * box.lineHeight, cut: true, broken: true };
}

/** One line only: the largest size at which the text is no wider than `width` (a big number, a name). */
export function fitLine(metrics: FontMetrics, text: string, width: number, sizes: readonly number[], tracking = 0): { size: number; text: string; cut: boolean } {
  const clean = text.replace(/\s+/g, " ").trim();
  for (const size of sizes) if (textWidth(metrics, clean, size, tracking) <= width * FIT_SLACK) return { size, text: clean, cut: false };
  const size = sizes[sizes.length - 1]!;
  let cut = clean;
  while (cut.length > 1 && textWidth(metrics, `${cut}…`, size, tracking) > width * FIT_SLACK) cut = [...cut].slice(0, -1).join("");
  return { size, text: `${cut.trimEnd()}…`, cut: true };
}
