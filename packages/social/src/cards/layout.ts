import { fitLine, fitText, type FitBox, type FontMetrics, type Fitted } from "./metrics.js";
import { CARD_SIZES, MAX_LIST_ROWS, SAFE_AREA, type CardSize, type CardSpec } from "./types.js";

/**
 * WHERE EVERYTHING GOES, worked out before anything is drawn: each block of
 * words gets its box and the size it fits at (metrics.ts). Pure, so a test
 * can hold every card to "nothing runs off the edge" without drawing one.
 */

/** The two faces every card measures with. */
export interface CardMetrics {
  readonly serif: FontMetrics;
  readonly sans: FontMetrics;
}

/** A block of words, fitted into its box. */
export interface TextBlock extends Fitted {
  readonly box: FitBox;
}

/** One line, fitted into its width. */
export interface LineBlock {
  readonly size: number;
  readonly text: string;
  readonly cut: boolean;
  readonly width: number;
}

export interface Frame {
  readonly width: number;
  readonly height: number;
  /** The safe content box. */
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
  readonly contentWidth: number;
}

export function frameOf(size: CardSize): Frame {
  const { width, height } = CARD_SIZES[size];
  const safe = SAFE_AREA[size];
  return { width, height, ...safe, contentWidth: width - safe.left - safe.right };
}

function block(metrics: FontMetrics, text: string, box: FitBox): TextBlock {
  return { ...fitText(metrics, text, box), box };
}

function line(metrics: FontMetrics, text: string, width: number, sizes: readonly number[], tracking = 0): LineBlock {
  return { ...fitLine(metrics, text, width, sizes, tracking), width };
}

/** The slides' chrome: a header row (mark, wordmark, page) and a footer row. */
export const SLIDE_HEADER = 60;
export const SLIDE_FOOTER = 48;
const HEADER_GAP = 56;
const FOOTER_GAP = 40;
/** Small capitals above a hook or a number. */
export const EYEBROW = { size: 26, tracking: 0.16, gap: 26 } as const;

/** The body of a slide: below the header, above the footer. */
export function slideBody(frame: Frame): { top: number; height: number } {
  const top = frame.top + SLIDE_HEADER + HEADER_GAP;
  const bottom = frame.height - frame.bottom - SLIDE_FOOTER - FOOTER_GAP;
  return { top, height: bottom - top };
}

/** Quote card geometry. */
export const QUOTE = {
  padX: 104,
  top: 100,
  bottom: 84,
  avatar: 132,
  gap: 56,
  footer: 44,
  footerGap: 60,
  lineHeight: 1.14,
} as const;

export interface QuoteLayout {
  readonly kind: "quote";
  readonly frame: Frame;
  readonly name: LineBlock;
  readonly handle: LineBlock;
  readonly text: TextBlock;
  /** The address beside the mark at the foot. */
  readonly site: LineBlock;
}

/** A slide's chrome, fitted like its words: a long business name or address never runs off. */
export interface SlideChrome {
  /** The brand's name beside its mark, top left. */
  readonly wordmark: LineBlock;
  /** The words at the foot, left: the address (the handle on the last slide). */
  readonly footer: LineBlock;
}

export interface CoverLayout extends SlideChrome {
  readonly kind: "cover";
  readonly frame: Frame;
  readonly eyebrow: LineBlock | null;
  readonly text: TextBlock;
  readonly art: number;
}

export interface StatLayout extends SlideChrome {
  readonly kind: "stat";
  readonly frame: Frame;
  readonly eyebrow: LineBlock | null;
  readonly value: LineBlock;
  readonly text: TextBlock;
  readonly note: TextBlock | null;
}

export interface ListRowLayout {
  readonly label: LineBlock;
  readonly detail: LineBlock | null;
  readonly value: LineBlock | null;
}

export interface ListLayout extends SlideChrome {
  readonly kind: "list";
  readonly frame: Frame;
  readonly eyebrow: LineBlock | null;
  readonly text: TextBlock;
  readonly rows: readonly ListRowLayout[];
  readonly rowHeight: number;
  readonly medal: number;
  readonly valueWidth: number;
  readonly note: TextBlock | null;
}

export interface CtaLayout extends SlideChrome {
  readonly kind: "cta";
  readonly frame: Frame;
  readonly eyebrow: LineBlock | null;
  readonly art: number;
  readonly site: LineBlock;
  readonly button: LineBlock;
  readonly note: TextBlock | null;
}

export type CardLayout = QuoteLayout | CoverLayout | StatLayout | ListLayout | CtaLayout;

const upper = (s: string | undefined) => (s ? s.toUpperCase() : "");

/** A list row's breathing room, top and bottom together. */
export const ROW_PAD = 20;

/** The steps no bigger than `max`; the largest whole size under it when none are. */
function capped(steps: readonly number[], max: number): number[] {
  const fit = steps.filter((s) => s <= max);
  return fit.length ? fit : [Math.max(10, Math.floor(max))];
}

function eyebrowOf(m: CardMetrics, text: string | undefined, width: number): LineBlock | null {
  return text ? line(m.sans, upper(text), width, [EYEBROW.size, 24, 22, 20], EYEBROW.tracking) : null;
}

/** The mark's tile at the top left, and the room kept at the top right for "5 / 5". */
export const MARK = 56;
export const PAGE_ROOM = 120;
/** At the foot: the accent rule before the words, and the "Swipe" pill on a cover. */
export const FOOT_RULE = 30 + 14;
export const CUE_ROOM = 250;

/** A slide's wordmark and footer, fitted to their room. */
function chrome(m: CardMetrics, frame: Frame, name: string, foot: string, cue: boolean): SlideChrome {
  return {
    wordmark: line(m.serif, name, frame.contentWidth - MARK - 16 - PAGE_ROOM, [42, 38, 34, 30, 27, 24]),
    footer: line(m.sans, foot, frame.contentWidth - FOOT_RULE - (cue ? CUE_ROOM : 0), [25, 23, 21, 19, 17]),
  };
}

/** Lay out a card for its spec: every block of words sized to fit. */
export function layoutCard(spec: CardSpec, m: CardMetrics, brand: { readonly name: string; readonly site: string; readonly handle: string; readonly author: string }): CardLayout {
  const frame = frameOf(spec.size);
  switch (spec.kind) {
    case "quote": {
      const width = frame.width - QUOTE.padX * 2;
      const height = frame.height - QUOTE.top - QUOTE.avatar - QUOTE.gap - QUOTE.footerGap - QUOTE.footer - QUOTE.bottom;
      const sizes = spec.size === "square" ? [100, 88, 78, 70, 62, 56, 50, 46, 42] : [108, 96, 86, 76, 68, 60, 54, 48, 44];
      const nameWidth = width - QUOTE.avatar - 28 - 56;
      return {
        kind: "quote",
        frame,
        // The serif, so a name like "Al" can't be read as "AI" (a sans draws l and I alike).
        name: line(m.serif, brand.author, nameWidth, [52, 48, 44, 40, 36, 32, 28]),
        handle: line(m.sans, spec.date ? `${brand.handle} · ${spec.date}` : brand.handle, width - QUOTE.avatar - 28, [32, 30, 28, 26, 24, 22]),
        text: block(m.serif, spec.text, { width, height, sizes, lineHeight: QUOTE.lineHeight, maxLines: 12 }),
        site: line(m.sans, brand.site, width - 40 - 14, [25, 23, 21, 19, 17]),
      };
    }
    case "cover": {
      const body = slideBody(frame);
      const art = spec.character ? (spec.size === "story" ? 560 : spec.size === "portrait" ? 510 : 390) : 0;
      const eyebrow = eyebrowOf(m, spec.eyebrow, frame.contentWidth);
      const height = body.height - (eyebrow ? EYEBROW.size + EYEBROW.gap : 0) - (art ? art + 24 : 0);
      const sizes = spec.size === "square" ? [104, 92, 82, 72, 64, 56, 50] : [124, 110, 98, 88, 78, 70, 62, 56];
      return {
        kind: "cover",
        frame,
        eyebrow,
        art,
        text: block(m.serif, spec.text, { width: frame.contentWidth, height, sizes, lineHeight: 1.06, maxLines: 8 }),
        ...chrome(m, frame, brand.name, brand.site, true),
      };
    }
    case "stat": {
      const body = slideBody(frame);
      const eyebrow = eyebrowOf(m, spec.eyebrow, frame.contentWidth);
      const value = line(m.serif, spec.value, frame.contentWidth, spec.size === "square" ? [260, 230, 200, 176, 150, 128, 108, 92] : [320, 280, 244, 212, 184, 156, 132, 112, 96]);
      const note = spec.note ? block(m.sans, spec.note, { width: frame.contentWidth, height: 3 * 26 * 1.4, sizes: [26, 24, 22], lineHeight: 1.4, maxLines: 3 }) : null;
      const used = (eyebrow ? EYEBROW.size + EYEBROW.gap : 0) + value.size * 1.02 + 32 + (note ? note.height + 40 : 0);
      const sizes = spec.size === "square" ? [56, 50, 45, 40, 36, 32] : [64, 58, 52, 46, 41, 36, 32];
      const text = block(m.serif, spec.text, { width: frame.contentWidth, height: Math.max(120, body.height - used), sizes, lineHeight: 1.2, maxLines: 6 });
      return { kind: "stat", frame, eyebrow, value, text, note, ...chrome(m, frame, brand.name, brand.site, false) };
    }
    case "list": {
      const body = slideBody(frame);
      const eyebrow = eyebrowOf(m, spec.eyebrow, frame.contentWidth);
      const text = block(m.serif, spec.text, {
        width: frame.contentWidth,
        height: spec.size === "square" ? 150 : 180,
        sizes: spec.size === "square" ? [68, 60, 54, 48, 42] : [78, 68, 60, 54, 48, 42],
        lineHeight: 1.08,
        maxLines: 2,
      });
      const note = spec.note ? block(m.sans, spec.note, { width: frame.contentWidth, height: 2 * 24 * 1.4, sizes: [24, 22, 20], lineHeight: 1.4, maxLines: 2 }) : null;
      const rows = spec.rows.slice(0, MAX_LIST_ROWS);
      const area = body.height - (eyebrow ? EYEBROW.size + EYEBROW.gap : 0) - text.height - 40 - (note ? note.height + 28 : 0);
      const rowHeight = Math.min(spec.size === "story" ? 168 : 156, Math.floor(area / Math.max(1, rows.length)));
      const medal = spec.ranked ? Math.max(36, Math.min(76, rowHeight - 36)) : 0;
      const valueWidth = rows.some((r) => r.value) ? (spec.size === "story" ? 250 : 280) : 0;
      const labelWidth = frame.contentWidth - (medal ? medal + 28 : 0) - (valueWidth ? valueWidth + 24 : 0);
      const big = rowHeight >= 130;
      // A row's words fit its height: the label and the detail share it (a line is 1.15 of its size, 6px between).
      const inner = rowHeight - ROW_PAD;
      const twoLines = rows.some((r) => r.detail);
      const labelMax = twoLines ? ((inner - 6) * 0.58) / 1.15 : inner / 1.15;
      const detailMax = ((inner - 6) * 0.42) / 1.15;
      return {
        kind: "list",
        frame,
        eyebrow,
        text,
        note,
        rowHeight,
        medal,
        valueWidth,
        ...chrome(m, frame, brand.name, brand.site, false),
        rows: rows.map((r) => ({
          label: line(m.sans, r.label, labelWidth, capped(big ? [42, 38, 34, 30, 27] : [36, 32, 29, 26], labelMax)),
          detail: r.detail ? line(m.sans, r.detail, labelWidth, capped(big ? [30, 28, 26, 24, 22] : [26, 24, 22, 20], detailMax)) : null,
          value: r.value ? line(m.serif, r.value, valueWidth, capped(big ? [68, 60, 54, 48, 42, 36] : [56, 50, 44, 38, 34], inner)) : null,
        })),
      };
    }
    case "cta": {
      const body = slideBody(frame);
      const eyebrow = eyebrowOf(m, spec.eyebrow, frame.contentWidth);
      // A company's address can be long ("app.example.com/t/green-acres"): it steps down further before it's cut.
      const site = line(m.serif, brand.site, frame.contentWidth, [112, 100, 92, 84, 76, 68, 60, 54, 48, 42, 36]);
      const button = line(m.sans, spec.text, frame.contentWidth - 2 * 44, [40, 37, 34, 31, 28, 25]);
      const fixed = (eyebrow ? EYEBROW.size + EYEBROW.gap : 0) + site.size * 1.1 + 32 + button.size * 1.2 + 56;
      let note = spec.note ? block(m.sans, spec.note, { width: frame.contentWidth, height: 3 * 28 * 1.4, sizes: [28, 26, 24, 22], lineHeight: 1.4, maxLines: 3 }) : null;
      if (note && fixed + note.height + 32 > body.height) note = null;
      // The character takes what's left, up to its size; too little room and it sits this one out.
      const room = body.height - fixed - (note ? note.height + 32 : 0) - 36;
      const want = spec.character ? (spec.size === "story" ? 560 : spec.size === "portrait" ? 500 : 360) : 0;
      const art = want && room >= 160 ? Math.min(want, Math.floor(room)) : 0;
      // The footer is the handle; with none (it would only repeat the address above), the business's name.
      const foot = brand.handle && brand.handle !== brand.site ? brand.handle : brand.name;
      return { kind: "cta", frame, eyebrow, art, site, button, note, ...chrome(m, frame, brand.name, foot, false) };
    }
  }
}
