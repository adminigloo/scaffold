/**
 * The widget's whole appearance, injected once as a <style> tag. Every rule is
 * prefixed `aiew-`, so the host app's CSS can't reach in by accident and the
 * widget can't leak out. No Tailwind and no CSS import step for the buyer:
 * React is the only peer, and this is what that costs.
 *
 * THEMING (contract 9.2). The palette is AdminIgloo's "Ink & Snow" (the
 * scheduling widget's), carried as `--aiew-*` custom properties declared under
 * `:where()`, i.e. at ZERO specificity, so one ordinary rule —
 * `.aiew-root { --aiew-accent: #7c3aed }` — re-themes every component whatever
 * order the stylesheets load in. Component rules stay at class specificity, so
 * a host's element rules (Tailwind preflight's `button { background:
 * transparent }`) still can't restyle the widget.
 *
 * Dark comes from the `data-theme` the component writes once it has read the
 * host's theme (./theme.ts). Before hydration there is no `data-theme`, so the
 * media query decides — no flash on a page that matches the OS. Every colour
 * resolves through a token, and every token pair the widget prints text with
 * passes WCAG AA in both themes (src/__tests__/styles.test.ts) — including
 * whatever colour the business picks (`brandTokens`).
 *
 * 0.1's `aie-*` sheet is gone, and its invalid `font:` shorthand with it
 * (ES-V4): the font is the host page's, inherited.
 */

const STYLE_ID = "aiew-styles";

/** The light tokens: the names a buyer can override, without the `--aiew-` prefix. */
export const LIGHT_TOKENS: Record<string, string> = {
  ground: "#f4f7fa",
  surface: "#ffffff",
  ink: "#0a1520",
  muted: "#3e4b57",
  faint: "#5b6977",
  line: "#d2dbe3",
  "line-strong": "#7a8794",
  accent: "#0d6b64",
  "accent-strong": "#0a5650",
  "accent-soft": "#d9efec",
  // The accent used as TEXT: links, a selected chip's label, the focus ring.
  "accent-ink": "#0d6b64",
  "on-accent": "#ffffff",
  ok: "#187339",
  "ok-soft": "#ddf2e3",
  warn: "#7d5a0c",
  "warn-soft": "#f8efd7",
  danger: "#a02e21",
  "danger-soft": "#fbe9e6",
  "on-danger": "#ffffff",
  focus: "#0d6b64",
  radius: "14px",
  "radius-sm": "10px",
  shadow: "0 1px 2px rgb(15 40 70 / 0.06), 0 6px 16px -6px rgb(15 40 70 / 0.14)",
  // Behind a dialog, and a dialog's own lift.
  scrim: "rgb(8 14 20 / 0.45)",
  "shadow-lg": "0 20px 50px -12px rgb(15 40 70 / 0.45)",
  // `inherit` on a custom property pulls the host's own --aiew-font if it set
  // one higher up; with none, font-family is invalid at computed time and
  // falls back to inheriting the page's font. Either way: the host's type.
  font: "inherit",
};

export const DARK_TOKENS: Record<string, string> = {
  ground: "#0b0f13",
  surface: "#141b22",
  ink: "#e8edf1",
  muted: "#a3b0bb",
  faint: "#8f9ca8",
  line: "#26313a",
  "line-strong": "#5f6d79",
  accent: "#45c4ad",
  "accent-strong": "#6cd6c3",
  "accent-soft": "#113029",
  "accent-ink": "#45c4ad",
  "on-accent": "#0b0f13",
  ok: "#56c586",
  "ok-soft": "#10301d",
  warn: "#d9ad5b",
  "warn-soft": "#32270f",
  danger: "#ec8f80",
  "danger-soft": "#391712",
  "on-danger": "#0b0f13",
  focus: "#45c4ad",
  shadow: "0 1px 2px rgb(0 0 0 / 0.45), 0 0 0 1px rgb(255 255 255 / 0.03)",
  scrim: "rgb(0 0 0 / 0.6)",
  "shadow-lg": "0 20px 50px -12px rgb(0 0 0 / 0.7)",
};

/**
 * The colour pairs the widget actually prints, with the WCAG minimum each must
 * meet: 4.5:1 for text, 3:1 for a boundary a person has to see (input
 * borders, the focus ring). The contrast test runs every pair in both themes,
 * and again over a sweep of brand colours, so a palette change that breaks one
 * fails CI instead of shipping.
 */
export const CONTRAST_PAIRS: ReadonlyArray<readonly [fg: string, bg: string, min: number]> = [
  ["ink", "surface", 4.5],
  ["ink", "ground", 4.5],
  ["muted", "surface", 4.5],
  ["muted", "ground", 4.5],
  ["faint", "surface", 4.5],
  ["faint", "ground", 4.5],
  ["accent-ink", "surface", 4.5],
  ["accent-ink", "ground", 4.5],
  ["accent-ink", "accent-soft", 4.5],
  ["ink", "accent-soft", 4.5],
  ["on-accent", "accent", 4.5],
  ["on-accent", "accent-strong", 4.5],
  ["ok", "ok-soft", 4.5],
  ["ok", "surface", 4.5],
  ["warn", "warn-soft", 4.5],
  ["warn", "surface", 4.5],
  ["danger", "danger-soft", 4.5],
  ["danger", "surface", 4.5],
  ["on-danger", "danger", 4.5],
  ["line-strong", "surface", 3],
  ["focus", "surface", 3],
  ["focus", "ground", 3],
];

// ---------------------------------------------------------------------------
// Colour arithmetic (display only: contrast and the brand palette)
// ---------------------------------------------------------------------------

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The WCAG contrast ratio of two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `a` moved `amount` (0–1) of the way toward `b`. */
export function mixColors(a: string, b: string, amount: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return toHex([ar + (br - ar) * amount, ag + (bg - ag) * amount, ab + (bb - ab) * amount]);
}

/** A `#rrggbb` colour (any case), lowercased; null for anything else. */
export function normalizeHex(value: string | null | undefined): string | null {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim().toLowerCase() : null;
}

const WHITE = "#ffffff";
const BLACK = "#000000";
const NEAR_BLACK = "#0b0f13";

/** The brand-coloured tokens, in the order `brandTokens` writes them. */
export const BRAND_TOKEN_NAMES = ["accent", "on-accent", "accent-strong", "accent-soft", "accent-ink", "focus"] as const;

/**
 * The business's colour as the accent tokens for one theme (contract 9.2),
 * keyed like `LIGHT_TOKENS` (no `--aiew-` prefix):
 *
 *   accent         the colour itself (buttons, a selected chip's border)
 *   on-accent      white or near-black, whichever reads better on it
 *   accent-strong  the hover shade: 15% toward black (light) or white (dark)
 *   accent-soft    the colour at 14% over the theme's surface (a solid hex)
 *   accent-ink     the colour as TEXT: stepped darker (light) or lighter
 *                  (dark) in 5% steps until it reads at 4.5:1
 *   focus          = accent-ink
 *
 * So ANY colour an owner picks keeps every pair AA (the test sweeps colours).
 *
 * CONTRACT: two guards the contract's wording doesn't spell out, both so that
 * "any colour yields AA pairs" is actually true:
 *  - `on-accent` is white or #0b0f13 as written; for the few mid-tones where
 *    neither reaches 4.5:1 (the best of the two bottoms out near 4.38:1),
 *    pure black is used, which always does.
 *  - `accent-strong` goes the contract's way unless that takes the button text
 *    below 4.5:1 (white text on a colour lightened for dark mode); then it goes
 *    the other way, away from the text colour, which can only raise contrast.
 *  - `accent-ink` must reach 4.5:1 on every background it is printed on — the
 *    surface, the ground and the accent-soft tint — not only the surface.
 */
export function brandTokens(hex: string, theme: "light" | "dark"): Record<string, string> {
  const accent = normalizeHex(hex) ?? (theme === "dark" ? DARK_TOKENS.accent! : LIGHT_TOKENS.accent!);
  const palette = theme === "dark" ? { ...LIGHT_TOKENS, ...DARK_TOKENS } : LIGHT_TOKENS;
  const surface = palette.surface!;
  const ground = palette.ground!;

  let onAccent = contrastRatio(WHITE, accent) >= contrastRatio(NEAR_BLACK, accent) ? WHITE : NEAR_BLACK;
  if (contrastRatio(onAccent, accent) < 4.5) onAccent = BLACK;

  let strong = mixColors(accent, theme === "dark" ? WHITE : BLACK, 0.15);
  if (contrastRatio(onAccent, strong) < 4.5) strong = mixColors(accent, onAccent === WHITE ? BLACK : WHITE, 0.15);

  const soft = mixColors(surface, accent, 0.14);

  const target = theme === "dark" ? WHITE : BLACK;
  let ink = accent;
  for (let step = 1; step <= 20; step += 1) {
    if (contrastRatio(ink, surface) >= 4.5 && contrastRatio(ink, ground) >= 4.5 && contrastRatio(ink, soft) >= 4.5) break;
    ink = mixColors(accent, target, step * 0.05);
  }

  return { accent, "on-accent": onAccent, "accent-strong": strong, "accent-soft": soft, "accent-ink": ink, focus: ink };
}

/**
 * The inline style that brands a root: both themes' accent tokens as
 * `--aiew-bl-*` (light) and `--aiew-bd-*` (dark). The stylesheet picks the set
 * that matches the root's theme — the same media query and `data-theme` rules
 * as the base palette — so a branded widget is right before hydration and
 * follows a live theme switch without a re-render. Empty for no colour.
 */
export function brandStyle(hex: string | null | undefined): Record<string, string> {
  const colour = normalizeHex(hex);
  if (!colour) return {};
  const out: Record<string, string> = {};
  for (const [prefix, theme] of [["bl", "light"], ["bd", "dark"]] as const) {
    for (const [name, value] of Object.entries(brandTokens(colour, theme))) out[`--aiew-${prefix}-${name}`] = value;
  }
  return out;
}

/** `--aiew-name: value;` for every token. */
export function declareTokens(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `--aiew-${name}: ${value};`)
    .join(" ");
}

function brandDeclarations(prefix: "bl" | "bd"): string {
  return BRAND_TOKEN_NAMES.map((name) => `--aiew-${name}: var(--aiew-${prefix}-${name});`).join(" ");
}

const CSS_TEXT = `
:where(.aiew-root) { ${declareTokens(LIGHT_TOKENS)} }
@media (prefers-color-scheme: dark) {
  :where(.aiew-root:not([data-theme="light"])) { ${declareTokens(DARK_TOKENS)} }
}
:where(.aiew-root[data-theme="dark"]) { ${declareTokens(DARK_TOKENS)} }
:where(.aiew-root[data-brand]) { ${brandDeclarations("bl")} }
@media (prefers-color-scheme: dark) {
  :where(.aiew-root[data-brand]:not([data-theme="light"])) { ${brandDeclarations("bd")} }
}
:where(.aiew-root[data-brand][data-theme="dark"]) { ${brandDeclarations("bd")} }

.aiew-root {
  position: relative; box-sizing: border-box; max-width: 100%; color: var(--aiew-ink); text-align: left;
  font-family: var(--aiew-font); font-size: 15px; line-height: 1.5; -webkit-text-size-adjust: 100%;
  color-scheme: light;
}
.aiew-root[data-theme="dark"] { color-scheme: dark; }
@media (prefers-color-scheme: dark) { .aiew-root:not([data-theme="light"]) { color-scheme: dark; } }
.aiew-card {
  width: 100%; background: var(--aiew-surface); border: 1px solid var(--aiew-line);
  border-radius: var(--aiew-radius); box-shadow: var(--aiew-shadow);
}
.aiew-fab-wrap { display: contents; }
.aiew-root *, .aiew-root *::before, .aiew-root *::after { box-sizing: border-box; }
/* The [hidden] attribute always hides: a class that sets display (".aiew-fields
   { display: grid }") would otherwise beat the browser's own [hidden] rule, and
   "More ways to measure" showed its questions while collapsed (review EST-R03). */
.aiew-root [hidden] { display: none !important; }
.aiew-root :where(h2, h3, h4, p, ul, ol, dl, dd, fieldset, legend, figure, table) { margin: 0; padding: 0; }
.aiew-root :where(fieldset) { border: 0; min-width: 0; }
.aiew-root :where(button, input, select, textarea) { font: inherit; color: inherit; letter-spacing: inherit; }
.aiew-root :where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: 2px solid var(--aiew-focus); outline-offset: 2px;
}
.aiew-root [tabindex="-1"]:focus { outline: none; }
.aiew-root [tabindex="-1"] { scroll-margin-top: var(--aiew-scroll-margin, 96px); }
.aiew-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0;
}
.aiew-root a:not(.aiew-btn) { color: var(--aiew-accent-ink); font-weight: 600; text-underline-offset: 3px; }

.aiew-body { padding: 20px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; }
@media (max-width: 480px) { .aiew-body { padding: 16px; gap: 18px; } }
.aiew-head { display: grid; gap: 4px; }
.aiew-title { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.3; color: var(--aiew-ink); }
.aiew-sub { color: var(--aiew-muted); font-size: 14.5px; overflow-wrap: anywhere; }
.aiew-section { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; min-width: 0; }
.aiew-h3 { font-size: 16px; font-weight: 700; color: var(--aiew-ink); }
.aiew-desc { font-size: 14px; color: var(--aiew-muted); overflow-wrap: anywhere; }
.aiew-stack { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
.aiew-stack-sm { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.aiew-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }

/* Chips: products, options, presets. Radio semantics; never colour alone (a check mark too). */
.aiew-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.aiew-chip {
  display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 8px 14px; cursor: pointer; text-align: left;
  border: 1px solid var(--aiew-line-strong); border-radius: 999px; background: var(--aiew-surface); color: var(--aiew-ink);
  font-weight: 600; font-size: 14.5px; transition: border-color .12s ease, background .12s ease;
}
.aiew-chip:hover { border-color: var(--aiew-accent); }
.aiew-chip[aria-checked="true"] { border-color: var(--aiew-accent); background: var(--aiew-accent-soft); color: var(--aiew-accent-ink); box-shadow: inset 0 0 0 1px var(--aiew-accent); }
.aiew-chip-check { width: 16px; height: 16px; flex: none; display: none; }
.aiew-chip[aria-checked="true"] .aiew-chip-check { display: inline-block; }
.aiew-mod { font-weight: 500; color: var(--aiew-muted); font-size: 13.5px; }
.aiew-chip[aria-checked="true"] .aiew-mod { color: var(--aiew-accent-ink); }
.aiew-group-label { font-size: 14px; font-weight: 600; color: var(--aiew-ink); }

/* Fields */
.aiew-fields { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.aiew-field { display: grid; gap: 6px; align-content: start; min-width: 0; }
.aiew-label { font-size: 14.5px; font-weight: 600; color: var(--aiew-ink); display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.aiew-optional { font-weight: 400; color: var(--aiew-muted); }
.aiew-input {
  width: 100%; min-height: 44px; padding: 10px 12px;
  /* 16px: anything smaller makes iOS Safari zoom the page on focus. */
  font-size: 16px; border: 1px solid var(--aiew-line-strong); border-radius: var(--aiew-radius-sm);
  background: var(--aiew-surface); color: var(--aiew-ink);
}
.aiew-input::placeholder { color: var(--aiew-faint); }
.aiew-input[aria-invalid="true"] { border-color: var(--aiew-danger); box-shadow: inset 0 0 0 1px var(--aiew-danger); }
textarea.aiew-input { min-height: 88px; resize: vertical; }
.aiew-input-unit { display: flex; align-items: stretch; max-width: 16em; }
.aiew-input-unit .aiew-input { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.aiew-unit {
  display: inline-flex; align-items: center; padding: 0 12px; border: 1px solid var(--aiew-line-strong); border-left: 0;
  border-radius: 0 var(--aiew-radius-sm) var(--aiew-radius-sm) 0; background: var(--aiew-ground); color: var(--aiew-muted); font-weight: 600;
}
.aiew-hint { font-size: 13.5px; color: var(--aiew-muted); }
.aiew-field-error { font-size: 13.5px; color: var(--aiew-danger); font-weight: 600; }
.aiew-field-check { font-size: 13.5px; color: var(--aiew-warn); font-weight: 600; }
.aiew-stepper { display: inline-flex; align-items: stretch; gap: 0; }
.aiew-stepper-btn {
  width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
  border: 1px solid var(--aiew-line-strong); background: var(--aiew-surface); color: var(--aiew-ink); font-size: 22px; font-weight: 600; line-height: 1;
}
.aiew-stepper-btn:first-child { border-radius: var(--aiew-radius-sm) 0 0 var(--aiew-radius-sm); }
.aiew-stepper-btn:last-child { border-radius: 0 var(--aiew-radius-sm) var(--aiew-radius-sm) 0; }
.aiew-stepper-btn:hover:not(:disabled) { border-color: var(--aiew-accent); color: var(--aiew-accent-ink); }
.aiew-stepper-btn:disabled { opacity: .45; cursor: not-allowed; }
.aiew-stepper .aiew-input { width: 4.5em; text-align: center; border-radius: 0; border-left: 0; border-right: 0; font-weight: 700; font-variant-numeric: tabular-nums; }
.aiew-badge-photo {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 700;
  background: var(--aiew-accent-soft); color: var(--aiew-accent-ink);
}
.aiew-badge-photo svg { width: 12px; height: 12px; }
.aiew-more { display: grid; gap: 12px; }
.aiew-disclosure {
  justify-self: start; display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding: 8px 2px; cursor: pointer;
  border: 0; background: transparent; color: var(--aiew-accent-ink); font-weight: 600; text-decoration: underline; text-underline-offset: 3px;
}
.aiew-disclosure svg { width: 16px; height: 16px; transition: transform .12s ease; }
.aiew-disclosure[aria-expanded="true"] svg { transform: rotate(90deg); }

/* Photos */
.aiew-photo-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.aiew-file { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; clip-path: inset(50%); }
.aiew-file:focus-visible + .aiew-btn { outline: 2px solid var(--aiew-focus); outline-offset: 2px; }
.aiew-photos { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.aiew-photo {
  display: grid; grid-template-columns: minmax(0, 160px) minmax(0, 1fr); gap: 12px; align-items: start;
  padding: 10px; border: 1px solid var(--aiew-line); border-radius: var(--aiew-radius-sm); background: var(--aiew-ground);
}
@media (max-width: 480px) { .aiew-photo { grid-template-columns: minmax(0, 1fr); } }
.aiew-thumb { display: block; width: 100%; height: auto; max-height: 220px; object-fit: contain; border-radius: 8px; background: var(--aiew-surface); border: 1px solid var(--aiew-line); }
.aiew-reading { display: grid; gap: 6px; min-width: 0; font-size: 14.5px; }
.aiew-reading-lines { display: grid; gap: 4px; list-style: none; margin: 0; padding: 0; }

/* Tags */
.aiew-tag {
  display: inline-flex; align-items: center; gap: 6px; justify-self: start; padding: 3px 10px; border-radius: 999px;
  font-size: 12.5px; font-weight: 700; letter-spacing: .02em; white-space: nowrap;
  background: var(--aiew-ground); color: var(--aiew-muted); border: 1px solid var(--aiew-line);
}
.aiew-tag svg { width: 13px; height: 13px; flex: none; }
.aiew-tag-ok { background: var(--aiew-ok-soft); color: var(--aiew-ok); border-color: transparent; }
.aiew-tag-warn { background: var(--aiew-warn-soft); color: var(--aiew-warn); border-color: transparent; }
.aiew-tag-danger { background: var(--aiew-danger-soft); color: var(--aiew-danger); border-color: transparent; }
.aiew-tag-accent { background: var(--aiew-accent-soft); color: var(--aiew-accent-ink); border-color: transparent; }

/* The price */
.aiew-price {
  display: grid; gap: 8px; padding: 16px; border-radius: var(--aiew-radius-sm);
  background: var(--aiew-ground); border: 1px solid var(--aiew-line); transition: opacity .15s ease;
}
.aiew-price[aria-busy="true"] .aiew-price-main { opacity: .55; }
.aiew-price-label { font-size: 12.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--aiew-muted); }
.aiew-amount { font-size: 30px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.15; color: var(--aiew-ink); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
@media (max-width: 480px) { .aiew-amount { font-size: 26px; } }
.aiew-tax { font-size: 13.5px; color: var(--aiew-muted); }
.aiew-result { font-weight: 600; }
.aiew-explain { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; font-size: 14px; color: var(--aiew-muted); }
.aiew-explain li + li::before { content: "→ "; color: var(--aiew-accent-ink); font-weight: 700; }
.aiew-note {
  padding: 10px 12px; border-radius: var(--aiew-radius-sm); font-size: 14px; color: var(--aiew-ink);
  background: var(--aiew-accent-soft); border-left: 4px solid var(--aiew-accent);
}
.aiew-why { font-size: 14px; color: var(--aiew-ink); }
.aiew-why strong { font-weight: 700; }
.aiew-confirm-note { font-size: 13.5px; color: var(--aiew-muted); }

/* Buttons */
.aiew-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 44px; padding: 10px 18px; border-radius: var(--aiew-radius-sm);
  border: 1px solid transparent; font-weight: 600; font-size: 15px; line-height: 1.2;
  cursor: pointer; text-decoration: none; text-align: center; background: transparent; color: var(--aiew-ink);
}
.aiew-btn svg { width: 18px; height: 18px; flex: none; }
.aiew-btn-primary { background: var(--aiew-accent); color: var(--aiew-on-accent); }
.aiew-btn-primary:hover:not(:disabled) { background: var(--aiew-accent-strong); }
.aiew-btn-secondary { background: var(--aiew-surface); color: var(--aiew-ink); border-color: var(--aiew-line-strong); }
.aiew-btn-secondary:hover:not(:disabled) { background: var(--aiew-ground); border-color: var(--aiew-accent); }
.aiew-btn-danger { background: var(--aiew-danger); color: var(--aiew-on-danger); }
.aiew-btn-danger-outline { background: var(--aiew-surface); color: var(--aiew-danger); border-color: var(--aiew-line-strong); }
.aiew-btn-danger-outline:hover:not(:disabled) { border-color: var(--aiew-danger); background: var(--aiew-danger-soft); }
.aiew-btn-link { background: transparent; color: var(--aiew-accent-ink); padding: 8px 4px; text-decoration: underline; text-underline-offset: 3px; }
.aiew-btn-block { width: 100%; }
.aiew-btn-sm { padding: 8px 12px; font-size: 14px; }
.aiew-btn:disabled { opacity: .55; cursor: not-allowed; }
.aiew-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.aiew-actions > .aiew-btn { flex: 1 1 180px; }

/* Form */
.aiew-form { display: grid; gap: 14px; position: relative; }
.aiew-row2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 14px; }
/* The honeypot: off-screen, not display:none (a display:none field is the
   first thing a bot learns to skip). */
.aiew-hp { position: absolute; left: -10000px; top: auto; width: 1px; height: 1px; overflow: hidden; }

/* Notices */
.aiew-notice { padding: 11px 14px; border-radius: var(--aiew-radius-sm); font-size: 14px; border: 1px solid transparent; overflow-wrap: anywhere; }
.aiew-notice-warn { background: var(--aiew-warn-soft); color: var(--aiew-warn); }
.aiew-notice-error { background: var(--aiew-danger-soft); color: var(--aiew-danger); }
.aiew-notice-ok { background: var(--aiew-ok-soft); color: var(--aiew-ok); }
.aiew-notice-info { background: var(--aiew-ground); color: var(--aiew-muted); border-color: var(--aiew-line); }
.aiew-notice a, .aiew-notice .aiew-btn-link { color: inherit; font-weight: 700; }
.aiew-notice .aiew-btn-link { min-height: 0; padding: 0; }
.aiew-root details > summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; font-weight: 600; }

/* Loading */
.aiew-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 28px 0; color: var(--aiew-muted); }
.aiew-spinner {
  width: 20px; height: 20px; border-radius: 50%; flex: none;
  border: 2px solid var(--aiew-line); border-top-color: var(--aiew-accent);
  animation: aiew-spin .8s linear infinite;
}
.aiew-spinner-sm { width: 14px; height: 14px; }
@keyframes aiew-spin { to { transform: rotate(360deg); } }
.aiew-skeleton { display: grid; gap: 10px; }
.aiew-skeleton-bar { height: 16px; border-radius: 8px; background: var(--aiew-ground); border: 1px solid var(--aiew-line); }
.aiew-skeleton-bar:nth-child(1) { width: 55%; height: 22px; }
.aiew-skeleton-bar:nth-child(2) { width: 35%; }
.aiew-skeleton-bar:nth-child(3) { width: 100%; height: 68px; }
.aiew-skeleton-bar:nth-child(4) { width: 100%; height: 44px; }
@media (prefers-reduced-motion: reduce) {
  .aiew-spinner { animation-duration: 2.4s; }
  .aiew-root * { transition: none !important; }
}
.aiew-empty { display: grid; gap: 8px; justify-items: center; text-align: center; padding: 24px 8px; color: var(--aiew-muted); }
.aiew-empty-title { font-weight: 700; color: var(--aiew-ink); font-size: 16px; }

/* Saved */
.aiew-done { display: grid; gap: 16px; }
.aiew-done-head { display: flex; align-items: center; gap: 12px; }
.aiew-badge {
  width: 44px; height: 44px; flex: none; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  background: var(--aiew-ok-soft); color: var(--aiew-ok);
}
.aiew-badge svg { width: 22px; height: 22px; }
.aiew-done-title { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.3; color: var(--aiew-ink); }
.aiew-next { display: grid; gap: 8px; padding: 14px 16px; border-radius: var(--aiew-radius-sm); background: var(--aiew-ground); border: 1px solid var(--aiew-line); }
.aiew-list { display: grid; gap: 6px; padding-left: 20px; list-style: disc; }
.aiew-list li::marker { color: var(--aiew-accent-ink); }
.aiew-powered { font-size: 12px; color: var(--aiew-muted); text-align: center; }

/* A value to copy: field + button. */
.aiew-copy { padding: 12px 14px; border-radius: var(--aiew-radius-sm); background: var(--aiew-ground); border: 1px solid var(--aiew-line); }
.aiew-copy-row { display: flex; flex-wrap: wrap; gap: 8px; }
.aiew-copy-input { flex: 1 1 220px; min-width: 0; text-overflow: ellipsis; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px; }
.aiew-copy-row > .aiew-btn { flex: 0 0 auto; }
.aiew-code {
  margin: 0; padding: 12px; overflow-x: auto; white-space: pre; border-radius: var(--aiew-radius-sm);
  background: var(--aiew-ground); border: 1px solid var(--aiew-line); color: var(--aiew-ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.5;
}

/* The floating button and the dialog */
.aiew-fab {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147482000; min-height: 48px; padding: 12px 20px; cursor: pointer;
  border: 0; border-radius: 999px; background: var(--aiew-accent); color: var(--aiew-on-accent);
  font-family: var(--aiew-font); font-weight: 700; font-size: 15px; box-shadow: var(--aiew-shadow-lg);
}
.aiew-fab:hover { background: var(--aiew-accent-strong); }
.aiew-fab:focus-visible { outline: 2px solid var(--aiew-focus); outline-offset: 3px; }
.aiew-backdrop { position: fixed; inset: 0; z-index: 2147483000; background: var(--aiew-scrim); display: flex; align-items: center; justify-content: center; padding: 16px; }
.aiew-dialog {
  position: relative; display: grid; grid-template-rows: auto minmax(0, 1fr); max-height: calc(100vh - 32px); width: min(560px, 100%);
  background: var(--aiew-surface); color: var(--aiew-ink); border: 1px solid var(--aiew-line); border-radius: var(--aiew-radius);
  box-shadow: var(--aiew-shadow-lg); text-align: left;
}
.aiew-dialog-wide { width: min(880px, 100%); }
.aiew-dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 16px 14px 20px; border-bottom: 1px solid var(--aiew-line); }
.aiew-dialog-title { font-size: 18px; font-weight: 700; line-height: 1.3; color: var(--aiew-ink); padding-top: 8px; }
.aiew-dialog-sub { font-size: 14px; color: var(--aiew-muted); }
.aiew-dialog-body { overflow-y: auto; padding: 16px 20px 20px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-content: start; }
@media (max-width: 480px) { .aiew-backdrop { padding: 8px; } .aiew-dialog-body { padding: 14px 16px 18px; } }
.aiew-dialog-close {
  min-width: 44px; min-height: 44px; padding: 8px; display: inline-flex; align-items: center; justify-content: center; flex: none;
  border: 1px solid var(--aiew-line-strong); border-radius: var(--aiew-radius-sm); background: var(--aiew-surface); color: var(--aiew-ink); cursor: pointer;
}
.aiew-dialog-close svg { width: 18px; height: 18px; }

/* The quote page */
.aiew-quote { display: grid; gap: 20px; }
.aiew-quote-brand { height: 6px; border-radius: 999px; background: var(--aiew-accent); }
.aiew-quote-head { display: grid; gap: 4px; }
.aiew-quote-business { font-size: 22px; font-weight: 800; letter-spacing: -0.01em; line-height: 1.25; color: var(--aiew-ink); }
.aiew-quote-meta { display: grid; gap: 2px; color: var(--aiew-muted); font-size: 14.5px; }
.aiew-quote-meta strong { color: var(--aiew-ink); }
.aiew-message { white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px 14px; border-radius: var(--aiew-radius-sm); background: var(--aiew-ground); border: 1px solid var(--aiew-line); }
.aiew-lines { width: 100%; border-collapse: collapse; font-size: 14.5px; }
.aiew-lines th { text-align: left; font-size: 12.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--aiew-muted); padding: 8px 6px; border-bottom: 1px solid var(--aiew-line-strong); }
.aiew-lines td { padding: 10px 6px; border-bottom: 1px solid var(--aiew-line); vertical-align: top; overflow-wrap: anywhere; }
.aiew-lines .aiew-num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.aiew-line-details { display: grid; gap: 1px; margin-top: 2px; font-size: 13px; color: var(--aiew-muted); list-style: none; padding: 0; }
.aiew-totals { display: grid; gap: 6px; justify-self: end; width: min(340px, 100%); font-variant-numeric: tabular-nums; }
.aiew-totals div { display: flex; justify-content: space-between; gap: 16px; }
.aiew-totals .aiew-total { font-size: 18px; font-weight: 800; padding-top: 8px; border-top: 2px solid var(--aiew-line-strong); }
.aiew-banner { display: grid; gap: 8px; padding: 14px 16px; border-radius: var(--aiew-radius-sm); border: 1px solid var(--aiew-line); background: var(--aiew-ground); }
.aiew-banner-ok { background: var(--aiew-ok-soft); color: var(--aiew-ok); border-color: transparent; }
.aiew-banner-warn { background: var(--aiew-warn-soft); color: var(--aiew-warn); border-color: transparent; }
.aiew-banner-danger { background: var(--aiew-danger-soft); color: var(--aiew-danger); border-color: transparent; }
.aiew-banner a { color: inherit; }
.aiew-footer { font-size: 13.5px; color: var(--aiew-muted); white-space: pre-wrap; overflow-wrap: anywhere; border-top: 1px solid var(--aiew-line); padding-top: 12px; }
.aiew-confirm { display: grid; gap: 12px; padding: 16px; border-radius: var(--aiew-radius-sm); border: 2px solid var(--aiew-accent); background: var(--aiew-surface); }

@media print {
  :where(.aiew-root), :where(.aiew-root[data-theme="dark"]), :where(.aiew-root[data-brand]) { ${declareTokens(LIGHT_TOKENS)} }
  .aiew-root { color-scheme: light; }
  .aiew-card { box-shadow: none; border: 0; }
  .aiew-no-print, .aiew-root .aiew-btn, .aiew-fab { display: none !important; }
  .aiew-lines tr { break-inside: avoid; }
}
`;

export interface InjectStylesOptions {
  /** A CSP nonce, set on the created <style> element. */
  nonce?: string;
}

/** Add `<style id="aiew-styles">` once. A tag that already exists is never duplicated. */
export function injectEstimatorStyles(options: InjectStylesOptions = {}): void {
  injectStyleTag(STYLE_ID, CSS_TEXT, options.nonce);
}

/** The stylesheet text, for a host that renders it itself (SSR, a shadow root). */
export function estimatorWidgetCss(): string {
  return CSS_TEXT;
}

/** Shared by both entries: one <style> per id, with the nonce on the element. */
export function injectStyleTag(id: string, css: string, nonce?: string): void {
  if (typeof document === "undefined" || document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  if (nonce) {
    style.nonce = nonce;
    style.setAttribute("nonce", nonce);
  }
  style.textContent = css;
  (document.head ?? document.documentElement).appendChild(style);
}
