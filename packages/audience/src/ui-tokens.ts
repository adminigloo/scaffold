/**
 * The admin components' palette, as data. `ui.tsx` builds its injected CSS
 * from these two maps, and `__tests__/ui-tokens.test.ts` measures every pair
 * the CSS actually puts text (or a control's edge) on — so a value that drops
 * below WCAG AA fails a test instead of shipping. (Feedback 0.8.0 shipped a
 * 3.1:1 grey exactly because nothing measured it; Riddler Go's ADR-0014 notes
 * those stock styles failed its rules.)
 *
 * Hosts re-theme by setting the custom properties (`--aiu-<name>`) on
 * `.aiu-root`; the defaults sit under `:where()`, so any host rule wins.
 */
export interface AudiencePalette {
  surface: string;
  "surface-2": string;
  ink: string;
  "ink-muted": string;
  /** Control edges and the off switch track: ≥ 3:1 (WCAG 1.4.11). */
  edge: string;
  /** Decorative dividers only — never the only boundary of a control. */
  line: string;
  accent: string;
  "accent-strong": string;
  "accent-soft": string;
  "on-accent": string;
  danger: string;
  "danger-soft": string;
  "warn-ink": string;
  "warn-soft": string;
}

export const LIGHT_PALETTE: AudiencePalette = {
  surface: "#ffffff",
  "surface-2": "#f4f6f8",
  ink: "#0e161c",
  "ink-muted": "#4d5b67",
  edge: "#6b7782",
  line: "#dde3e8",
  accent: "#0f6b63",
  "accent-strong": "#0a504a",
  "accent-soft": "#dcefec",
  "on-accent": "#ffffff",
  danger: "#a12d20",
  "danger-soft": "#fbeae7",
  "warn-ink": "#6b4800",
  "warn-soft": "#fdf1d6",
};

export const DARK_PALETTE: AudiencePalette = {
  surface: "#151b21",
  "surface-2": "#0f1418",
  ink: "#e8edf1",
  "ink-muted": "#a3b0bb",
  edge: "#7f8d99",
  line: "#2a343d",
  accent: "#4cc9b3",
  "accent-strong": "#7fdccb",
  "accent-soft": "#12302b",
  "on-accent": "#0b1215",
  danger: "#f0907f",
  "danger-soft": "#3a1d19",
  "warn-ink": "#f2c76b",
  "warn-soft": "#33280f",
};

/** `--aiu-surface: #ffffff; …` — one declaration per palette entry. */
export function paletteDeclarations(palette: AudiencePalette): string {
  return (Object.keys(palette) as (keyof AudiencePalette)[]).map((name) => `--aiu-${name}: ${palette[name]};`).join(" ");
}

/**
 * Text and control-edge pairs the stylesheet really uses: [foreground,
 * background, minimum ratio, where]. Text is 4.5:1 (WCAG 1.4.3); a control's
 * boundary, the focus ring and the switch track are 3:1 (1.4.11).
 */
export const CONTRAST_PAIRS: ReadonlyArray<readonly [keyof AudiencePalette, keyof AudiencePalette, number, string]> = [
  ["ink", "surface", 4.5, "panel text, rule values, inputs"],
  ["ink", "surface-2", 4.5, "rule rows, preview table, disabled button text"],
  ["ink-muted", "surface", 4.5, "hints, meta, run history"],
  ["ink-muted", "surface-2", 4.5, "rule meta, table headers, disabled button"],
  ["accent", "surface", 4.5, "kind tag, links, toggle label when on"],
  ["accent", "surface-2", 4.5, "kind tag on a rule row"],
  ["accent", "accent-soft", 4.5, "code-rule tag"],
  ["ink", "accent-soft", 4.5, "preview box text"],
  ["ink-muted", "accent-soft", 4.5, "preview limits"],
  ["on-accent", "accent", 4.5, "primary button"],
  ["on-accent", "accent-strong", 4.5, "primary button hover"],
  ["danger", "surface", 4.5, "remove button text"],
  ["danger", "surface-2", 4.5, "remove button on a rule row"],
  ["danger", "danger-soft", 4.5, "error message"],
  ["surface", "danger", 4.5, "confirm Remove rule button"],
  ["ink", "danger-soft", 4.5, "confirm-remove text"],
  ["warn-ink", "warn-soft", 4.5, "include-internal banner, duplicate warning"],
  ["edge", "surface", 3, "input, select and button edges; switch track off"],
  ["edge", "surface-2", 3, "button edge on a rule row"],
  ["accent", "surface", 3, "focus ring, switch track on"],
  ["accent", "surface-2", 3, "focus ring on a rule row"],
  ["on-accent", "accent", 3, "switch knob when on"],
  ["surface", "edge", 3, "switch knob when off"],
  ["danger", "danger-soft", 3, "error box edge"],
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
