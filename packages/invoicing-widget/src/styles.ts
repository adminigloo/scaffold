/**
 * The widget's whole appearance, injected once as a <style> tag. Every rule is
 * prefixed `aiiw-`, so the host app's CSS can't reach in by accident and the
 * widget can't leak out. React is the only peer: no Tailwind, no CSS import.
 *
 * THEMING. AdminIgloo's "Ink & Snow" token set as `--aiiw-*` custom
 * properties at ZERO specificity (`:where()`), so `.aiiw-root { --aiiw-accent:
 * … }` re-themes everything. Dark comes from the `data-theme` the root writes
 * once it has read the host's theme (./theme.ts). Every token pair the
 * widget prints text with passes WCAG AA in both themes (tested).
 *
 * THE BUSINESS'S COLOUR (the customer's page, `accentColor`). COPIED from
 * @adminigloo/estimator-widget's styles (`brandTokens`, `brandStyle`): any
 * `#rrggbb` an owner picks becomes accent tokens for both themes, with the
 * text on it, the hover shade, a soft tint and an ink shade stepped until
 * every pair reads at 4.5:1. Change both or neither.
 */

const STYLE_ID = "aiiw-styles";
const ADMIN_STYLE_ID = "aiiw-admin-styles";

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
  scrim: "rgb(8 14 20 / 0.45)",
  "shadow-lg": "0 20px 50px -12px rgb(15 40 70 / 0.45)",
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

/** The colour pairs the widget prints, with the WCAG minimum each must meet. */
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

export const BRAND_TOKEN_NAMES = ["accent", "on-accent", "accent-strong", "accent-soft", "accent-ink", "focus"] as const;

/** The business's colour as accent tokens for one theme; every pair AA, whatever the colour. */
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

/** The inline style that brands a root: both themes' accent tokens; the stylesheet picks the pair for the theme. */
export function brandStyle(hex: string | null | undefined): Record<string, string> {
  const colour = normalizeHex(hex);
  if (!colour) return {};
  const out: Record<string, string> = {};
  for (const [prefix, theme] of [["bl", "light"], ["bd", "dark"]] as const) {
    for (const [name, value] of Object.entries(brandTokens(colour, theme))) out[`--aiiw-${prefix}-${name}`] = value;
  }
  return out;
}

/** `--aiiw-name: value;` for every token. */
export function declareTokens(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `--aiiw-${name}: ${value};`)
    .join(" ");
}

function brandDeclarations(prefix: "bl" | "bd"): string {
  return BRAND_TOKEN_NAMES.map((name) => `--aiiw-${name}: var(--aiiw-${prefix}-${name});`).join(" ");
}

const CSS_TEXT = `
:where(.aiiw-root) { ${declareTokens(LIGHT_TOKENS)} }
@media (prefers-color-scheme: dark) {
  :where(.aiiw-root:not([data-theme="light"])) { ${declareTokens(DARK_TOKENS)} }
}
:where(.aiiw-root[data-theme="dark"]) { ${declareTokens(DARK_TOKENS)} }
:where(.aiiw-root[data-brand]) { ${brandDeclarations("bl")} }
@media (prefers-color-scheme: dark) {
  :where(.aiiw-root[data-brand]:not([data-theme="light"])) { ${brandDeclarations("bd")} }
}
:where(.aiiw-root[data-brand][data-theme="dark"]) { ${brandDeclarations("bd")} }

.aiiw-root {
  position: relative; box-sizing: border-box; width: 100%; max-width: 100%; color: var(--aiiw-ink); text-align: left;
  font-family: var(--aiiw-font); font-size: 15px; line-height: 1.5; -webkit-text-size-adjust: 100%; color-scheme: light;
}
.aiiw-root[data-theme="dark"] { color-scheme: dark; }
@media (prefers-color-scheme: dark) { .aiiw-root:not([data-theme="light"]) { color-scheme: dark; } }
.aiiw-root *, .aiiw-root *::before, .aiiw-root *::after { box-sizing: border-box; }
.aiiw-root [hidden] { display: none !important; }
.aiiw-root :where(h1, h2, h3, h4, p, ul, ol, dl, dd, fieldset, legend, figure, table) { margin: 0; padding: 0; }
.aiiw-root :where(fieldset) { border: 0; min-width: 0; }
.aiiw-root :where(button, input, select, textarea) { font: inherit; color: inherit; letter-spacing: inherit; }
.aiiw-root :where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: 2px solid var(--aiiw-focus); outline-offset: 2px;
}
.aiiw-root [tabindex="-1"]:focus { outline: none; }
.aiiw-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0;
}
.aiiw-root a:not(.aiiw-btn) { color: var(--aiiw-accent-ink); font-weight: 600; text-underline-offset: 3px; }

.aiiw-card {
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; padding: 20px; min-width: 0;
  background: var(--aiiw-surface); border: 1px solid var(--aiiw-line); border-radius: var(--aiiw-radius); box-shadow: var(--aiiw-shadow);
}
@media (max-width: 480px) { .aiiw-card { padding: 16px; } }
.aiiw-stack { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; min-width: 0; }
.aiiw-stack-sm { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; min-width: 0; }
.aiiw-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
.aiiw-grow { flex: 1 1 auto; min-width: 0; }
.aiiw-spread { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 16px; }
.aiiw-title { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.25; color: var(--aiiw-ink); }
.aiiw-h2 { font-size: 17px; font-weight: 700; color: var(--aiiw-ink); }
.aiiw-h3 { font-size: 13px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--aiiw-muted); }
.aiiw-muted { color: var(--aiiw-muted); }
.aiiw-small { font-size: 13.5px; color: var(--aiiw-muted); overflow-wrap: anywhere; }
.aiiw-num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.aiiw-pre { white-space: pre-line; overflow-wrap: anywhere; }

/* The business block on the customer's page */
.aiiw-business { display: flex; align-items: center; gap: 12px; padding-bottom: 12px; border-bottom: 3px solid var(--aiiw-accent); }
.aiiw-logo { max-height: 40px; max-width: 160px; width: auto; height: auto; object-fit: contain; }
.aiiw-business-name { font-size: 17px; font-weight: 700; color: var(--aiiw-ink); }

/* Status badges */
.aiiw-tag {
  display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px; font-size: 12.5px; font-weight: 700;
  letter-spacing: .02em; white-space: nowrap; background: var(--aiiw-ground); color: var(--aiiw-muted); border: 1px solid var(--aiiw-line);
}
.aiiw-tag-ok { background: var(--aiiw-ok-soft); color: var(--aiiw-ok); border-color: transparent; }
.aiiw-tag-warn { background: var(--aiiw-warn-soft); color: var(--aiiw-warn); border-color: transparent; }
.aiiw-tag-danger { background: var(--aiiw-danger-soft); color: var(--aiiw-danger); border-color: transparent; }
.aiiw-tag-accent { background: var(--aiiw-accent-soft); color: var(--aiiw-accent-ink); border-color: transparent; }

/* Tables (lines, the ledger) and their phone cards */
.aiiw-table { width: 100%; border-collapse: collapse; font-size: 14.5px; }
.aiiw-table th { text-align: left; font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--aiiw-muted); padding: 8px 10px; border-bottom: 1px solid var(--aiiw-line); }
.aiiw-table td { padding: 10px; border-bottom: 1px solid var(--aiiw-line); vertical-align: top; overflow-wrap: anywhere; }
.aiiw-table .aiiw-right, .aiiw-right { text-align: right; }
.aiiw-cards { display: none; list-style: none; margin: 0; padding: 0; gap: 8px; }
.aiiw-item-card { display: grid; gap: 4px; padding: 12px; border: 1px solid var(--aiiw-line); border-radius: var(--aiiw-radius-sm); background: var(--aiiw-surface); }
@media (max-width: 767px) {
  .aiiw-wide { display: none; }
  .aiiw-cards { display: grid; }
}

/* Totals */
.aiiw-totals { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 16px; justify-self: end; min-width: min(100%, 300px); }
.aiiw-totals dt { color: var(--aiiw-muted); }
.aiiw-totals dd { text-align: right; font-variant-numeric: tabular-nums; }
.aiiw-totals .aiiw-strong { font-weight: 700; color: var(--aiiw-ink); font-size: 16.5px; }

/* Buttons */
.aiiw-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 40px; padding: 8px 16px; border-radius: var(--aiiw-radius-sm);
  border: 1px solid transparent; font-weight: 600; font-size: 14.5px; line-height: 1.2;
  cursor: pointer; text-decoration: none; text-align: center; background: transparent; color: var(--aiiw-ink);
}
@media (max-width: 640px) { .aiiw-btn { min-height: 44px; } }
.aiiw-btn-primary { background: var(--aiiw-accent); color: var(--aiiw-on-accent); }
.aiiw-btn-primary:hover:not(:disabled) { background: var(--aiiw-accent-strong); }
.aiiw-btn-secondary { background: var(--aiiw-surface); color: var(--aiiw-ink); border-color: var(--aiiw-line-strong); }
.aiiw-btn-secondary:hover:not(:disabled) { background: var(--aiiw-ground); border-color: var(--aiiw-accent); }
.aiiw-btn-danger { background: var(--aiiw-danger); color: var(--aiiw-on-danger); }
.aiiw-btn-link { background: transparent; color: var(--aiiw-accent-ink); text-decoration: underline; text-underline-offset: 3px; padding: 8px 4px; }
.aiiw-btn:disabled { opacity: .55; cursor: not-allowed; }
.aiiw-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.aiiw-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.aiiw-chip {
  display: inline-flex; align-items: center; min-height: 40px; padding: 6px 14px; cursor: pointer; font-weight: 600; font-size: 14px;
  border: 1px solid var(--aiiw-line-strong); border-radius: 999px; background: var(--aiiw-surface); color: var(--aiiw-ink);
}
@media (max-width: 640px) { .aiiw-chip { min-height: 44px; } }
.aiiw-chip[aria-pressed="true"] { background: var(--aiiw-accent-soft); border-color: var(--aiiw-accent); color: var(--aiiw-accent-ink); }

/* Forms */
.aiiw-form { display: grid; gap: 14px; }
.aiiw-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 12px; }
.aiiw-line-row { display: grid; grid-template-columns: minmax(0, 3fr) minmax(70px, 1fr) minmax(100px, 1.2fr) auto; gap: 8px; align-items: end; }
@media (max-width: 640px) { .aiiw-line-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } .aiiw-line-row > :first-child { grid-column: 1 / -1; } }
.aiiw-field { display: grid; gap: 6px; min-width: 0; align-content: start; }
.aiiw-label { font-size: 14px; font-weight: 600; color: var(--aiiw-ink); }
.aiiw-input {
  width: 100%; min-height: 44px; padding: 10px 12px; font-size: 16px;
  border: 1px solid var(--aiiw-line-strong); border-radius: var(--aiiw-radius-sm); background: var(--aiiw-surface); color: var(--aiiw-ink);
}
.aiiw-input[aria-invalid="true"] { border-color: var(--aiiw-danger); box-shadow: inset 0 0 0 1px var(--aiiw-danger); }
textarea.aiiw-input { min-height: 88px; resize: vertical; }
.aiiw-hint { font-size: 13px; color: var(--aiiw-muted); overflow-wrap: anywhere; }
.aiiw-field-error { font-size: 13px; color: var(--aiiw-danger); font-weight: 600; }

/* Notices */
.aiiw-notice { padding: 11px 14px; border-radius: var(--aiiw-radius-sm); font-size: 14px; border: 1px solid transparent; overflow-wrap: anywhere; }
.aiiw-notice-warn { background: var(--aiiw-warn-soft); color: var(--aiiw-warn); }
.aiiw-notice-error { background: var(--aiiw-danger-soft); color: var(--aiiw-danger); }
.aiiw-notice-ok { background: var(--aiiw-ok-soft); color: var(--aiiw-ok); }
.aiiw-notice-info { background: var(--aiiw-surface); color: var(--aiiw-muted); border-color: var(--aiiw-line); }
.aiiw-notice a { color: inherit; font-weight: 700; }

/* Loading */
.aiiw-loading { display: flex; align-items: center; gap: 10px; padding: 16px 0; color: var(--aiiw-muted); }
.aiiw-spinner {
  width: 18px; height: 18px; border-radius: 50%; flex: none;
  border: 2px solid var(--aiiw-line); border-top-color: var(--aiiw-accent); animation: aiiw-spin .8s linear infinite;
}
@keyframes aiiw-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .aiiw-spinner { animation-duration: 2.4s; } }

/* Dialog */
.aiiw-backdrop { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--aiiw-scrim); }
.aiiw-dialog {
  width: min(560px, 100%); max-height: calc(100vh - 32px); overflow: auto; display: grid; gap: 14px; padding: 18px;
  background: var(--aiiw-surface); color: var(--aiiw-ink); border: 1px solid var(--aiiw-line); border-radius: var(--aiiw-radius); box-shadow: var(--aiiw-shadow-lg);
}
.aiiw-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.aiiw-dialog-title { font-size: 18px; font-weight: 700; }
.aiiw-dialog-close {
  display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; padding: 0;
  border: 0; border-radius: var(--aiiw-radius-sm); background: transparent; color: var(--aiiw-muted); cursor: pointer;
}
.aiiw-dialog-close:hover { background: var(--aiiw-ground); color: var(--aiiw-ink); }
.aiiw-dialog-close svg { width: 18px; height: 18px; }

/* Print: the customer's page prints as a plain invoice; only the accent chrome goes. */
@media print {
  :where(.aiiw-root), :where(.aiiw-root[data-theme="dark"]), :where(.aiiw-root[data-brand]) { ${declareTokens(LIGHT_TOKENS)} }
  .aiiw-root { color-scheme: light; }
  .aiiw-card { box-shadow: none; }
  .aiiw-business { border-bottom-color: var(--aiiw-line); }
  .aiiw-no-print { display: none !important; }
  .aiiw-table tr { break-inside: avoid; }
}
`;

const ADMIN_CSS_TEXT = `
.aiiw-root.aiiw-admin { background: var(--aiiw-ground); font-size: 14.5px; }
.aiiw-admin-inner { padding: 16px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
@media (max-width: 480px) { .aiiw-admin-inner { padding: 12px; gap: 12px; } }
.aiiw-ledger-row { cursor: pointer; }
.aiiw-ledger-row:hover td { background: var(--aiiw-ground); }
.aiiw-overpaid { color: var(--aiiw-warn); font-weight: 700; }
.aiiw-reversed { text-decoration: line-through; color: var(--aiiw-muted); }
`;

export interface InjectStylesOptions {
  /** A CSP nonce, set on the created <style> element. */
  nonce?: string;
}

/** Add `<style id="aiiw-styles">` once. */
export function injectInvoicingStyles(options: InjectStylesOptions = {}): void {
  injectStyleTag(STYLE_ID, CSS_TEXT, options.nonce);
}

/** The staff screens' extra sheet, on top of the widget's. */
export function injectInvoicingAdminStyles(options: InjectStylesOptions = {}): void {
  injectStyleTag(STYLE_ID, CSS_TEXT, options.nonce);
  injectStyleTag(ADMIN_STYLE_ID, ADMIN_CSS_TEXT, options.nonce);
}

/** The stylesheet text, for a host that renders it itself. */
export function invoicingWidgetCss(): string {
  return CSS_TEXT;
}

export function invoicingAdminCss(): string {
  return ADMIN_CSS_TEXT;
}

/** One <style> per id, with the nonce on the element. */
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
