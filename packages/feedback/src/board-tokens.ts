/**
 * The board's palette, as data. `board.tsx` builds its injected CSS from these
 * two maps, and `__tests__/board-tokens.test.ts` measures every pair the CSS
 * actually puts text (or a control's edge) on — so a value that drops below
 * WCAG AA fails a test instead of shipping. 0.8.0's `ink-faint` (#8494a1,
 * 3.1:1 on white) shipped exactly because nothing measured it.
 *
 * Hosts re-theme by setting the CSS custom properties (`--aib-<name>`) on
 * `.aib-root` / `.aib-panel-layer`; see the package README.
 */
export interface BoardPalette {
  surface: string;
  "surface-2": string;
  ink: string;
  "ink-muted": string;
  "ink-faint": string;
  line: string;
  "line-strong": string;
  accent: string;
  "accent-strong": string;
  "accent-soft": string;
  danger: string;
  warn: string;
  "on-accent": string;
  "shadow-card": string;
  "shadow-panel": string;
  scrim: string;
}

export const LIGHT_PALETTE: BoardPalette = {
  surface: "#ffffff",
  "surface-2": "#f5f7f9",
  ink: "#0e161c",
  "ink-muted": "#55636f",
  "ink-faint": "#66737d",
  line: "#e1e7ec",
  "line-strong": "#c3ced7",
  accent: "#0f766e",
  "accent-strong": "#0c5f59",
  "accent-soft": "#d9efec",
  danger: "#a02e21",
  warn: "#7d5a0c",
  "on-accent": "#ffffff",
  "shadow-card": "0 1px 2px rgba(14,22,28,.06)",
  "shadow-panel": "-12px 0 40px rgba(14,22,28,.2)",
  scrim: "rgba(10,14,17,.45)",
};

export const DARK_PALETTE: BoardPalette = {
  surface: "#161d23",
  "surface-2": "#0f1418",
  ink: "#e8edf1",
  "ink-muted": "#93a2ae",
  "ink-faint": "#7b8a96",
  line: "#29343d",
  "line-strong": "#3c4a55",
  accent: "#45c4ad",
  "accent-strong": "#6cd6c3",
  "accent-soft": "#113029",
  danger: "#e08272",
  warn: "#cfa14e",
  "on-accent": "#0e161c",
  "shadow-card": "0 1px 2px rgba(0,0,0,.4)",
  "shadow-panel": "-12px 0 40px rgba(0,0,0,.55)",
  scrim: "rgba(0,0,0,.55)",
};

/** `--aib-surface: #ffffff; …` — one declaration per palette entry. */
export function paletteDeclarations(palette: BoardPalette): string {
  return (Object.keys(palette) as (keyof BoardPalette)[])
    .map((name) => `--aib-${name}: ${palette[name]};`)
    .join(" ");
}

/**
 * Text and control-edge pairs the stylesheet really uses: [foreground, background,
 * minimum ratio, where]. Text is 4.5:1 (WCAG 1.4.3); a control's boundary or a
 * state indicator is 3:1 (1.4.11).
 */
export const CONTRAST_PAIRS: ReadonlyArray<
  readonly [keyof BoardPalette, keyof BoardPalette, number, string]
> = [
  ["ink", "surface", 4.5, "card title, panel text"],
  ["ink-muted", "surface", 4.5, "card meta, panel labels"],
  ["ink-muted", "surface-2", 4.5, "column title"],
  ["ink-faint", "surface", 4.5, "ticket number, low/medium chip"],
  ["ink-faint", "surface-2", 4.5, "column count, empty column, archived card meta"],
  ["accent", "surface", 4.5, "screenshot link"],
  ["accent", "accent-soft", 4.5, "assignee chip"],
  ["danger", "surface", 4.5, "critical chip, browser errors"],
  ["warn", "surface", 4.5, "high chip"],
  ["on-accent", "accent", 4.5, "Apply / Send / reply pill"],
  ["on-accent", "ink-faint", 4.5, "disabled Apply / Send"],
  ["warn", "surface-2", 4.5, "WIP-full count, high chip on an archived card"],
  ["danger", "surface-2", 4.5, "WIP-over count, critical chip on an archived card"],
  ["accent", "surface-2", 4.5, "screenshot link on an archived card"],
  ["ink", "surface-2", 4.5, "archived card title"],
  ["ink", "accent-soft", 4.5, "staff message body"],
  ["ink-muted", "accent-soft", 4.5, "staff message time"],
  ["on-accent", "accent-strong", 4.5, "Apply / Send hover"],
  ["ink-muted", "surface", 3, "checkbox edge"],
  ["ink-faint", "surface", 3, "input, select and textarea edge"],
  ["accent", "surface", 3, "focus ring"],
  ["accent", "surface-2", 3, "drop-target outline"],
];

function channel(hex: string, at: number): number {
  const value = parseInt(hex.slice(at, at + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** WCAG contrast ratio of two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
