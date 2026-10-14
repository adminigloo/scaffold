/**
 * The widget's whole appearance, injected once as a <style> tag. Every rule is
 * prefixed `aicw-`, so the host app's CSS can't reach in by accident and the
 * widget can't leak out. No Tailwind and no CSS import step for the buyer:
 * React is the only peer.
 *
 * THEMING. The palette is AdminIgloo's "Ink & Snow" (the booking and
 * scheduling widgets' token set), carried as `--aicw-*` custom properties
 * declared under `:where()`, at ZERO specificity, so one ordinary rule
 * (`.aicw-root { --aicw-accent: #7c3aed }`) re-themes the console whatever
 * order the stylesheets load in. Dark comes from the `data-theme` the root
 * writes once it has read the host's theme (./theme.ts); before hydration
 * the media query decides. Every token pair the widget prints text with
 * passes WCAG AA in both themes (src/__tests__/styles.test.ts).
 */

const STYLE_ID = "aicw-styles";

/** The light tokens: the names a buyer can override, without the `--aicw-` prefix. */
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

/** The colour pairs the console prints, with the WCAG minimum each must meet. */
export const CONTRAST_PAIRS: ReadonlyArray<readonly [fg: string, bg: string, min: number]> = [
  ["ink", "surface", 4.5],
  ["ink", "ground", 4.5],
  ["muted", "surface", 4.5],
  ["muted", "ground", 4.5],
  ["faint", "surface", 4.5],
  ["faint", "ground", 4.5],
  ["accent", "surface", 4.5],
  ["accent", "ground", 4.5],
  ["on-accent", "accent", 4.5],
  ["on-accent", "accent-strong", 4.5],
  ["accent", "accent-soft", 4.5],
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

function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** The WCAG contrast ratio of two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `--aicw-name: value;` for every token. */
export function declareTokens(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `--aicw-${name}: ${value};`)
    .join(" ");
}

const CSS_TEXT = `
:where(.aicw-root) { ${declareTokens(LIGHT_TOKENS)} }
@media (prefers-color-scheme: dark) {
  :where(.aicw-root:not([data-theme="light"])) { ${declareTokens(DARK_TOKENS)} }
}
:where(.aicw-root[data-theme="dark"]) { ${declareTokens(DARK_TOKENS)} }

.aicw-root {
  position: relative; box-sizing: border-box; width: 100%; max-width: 100%;
  background: var(--aicw-ground); color: var(--aicw-ink); text-align: left;
  font-family: var(--aicw-font); font-size: 14.5px; line-height: 1.5;
  -webkit-text-size-adjust: 100%; color-scheme: light;
}
.aicw-root[data-theme="dark"] { color-scheme: dark; }
@media (prefers-color-scheme: dark) { .aicw-root:not([data-theme="light"]) { color-scheme: dark; } }
.aicw-root *, .aicw-root *::before, .aicw-root *::after { box-sizing: border-box; }
.aicw-root :where(h2, h3, h4, p, ul, ol, dl, dd, fieldset, legend, figure, table) { margin: 0; padding: 0; }
.aicw-root :where(button, input, select, textarea) { font: inherit; color: inherit; letter-spacing: inherit; }
.aicw-root :where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: 2px solid var(--aicw-focus); outline-offset: 2px;
}
.aicw-root [tabindex="-1"]:focus { outline: none; }
.aicw-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0;
}
.aicw-root a:not(.aicw-btn) { color: var(--aicw-accent); font-weight: 600; text-underline-offset: 3px; }

.aicw-inner { padding: 16px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
@media (max-width: 480px) { .aicw-inner { padding: 12px; gap: 12px; } }
.aicw-title { font-size: 21px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.25; color: var(--aicw-ink); }
.aicw-card {
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; padding: 16px; min-width: 0;
  background: var(--aicw-surface); border: 1px solid var(--aicw-line); border-radius: var(--aicw-radius); box-shadow: var(--aicw-shadow);
}
.aicw-card-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.aicw-h2 { font-size: 17px; font-weight: 700; color: var(--aicw-ink); }
.aicw-h3 { font-size: 13px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--aicw-muted); }
.aicw-muted { color: var(--aicw-muted); }
.aicw-small { font-size: 13px; color: var(--aicw-muted); overflow-wrap: anywhere; }
.aicw-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
.aicw-grow { flex: 1 1 auto; min-width: 0; }
.aicw-stack { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
.aicw-ok-text { color: var(--aicw-ok); font-weight: 600; font-size: 14px; }
.aicw-danger-text { color: var(--aicw-danger); font-weight: 600; font-size: 14px; }

/* Templates */
.aicw-group { display: grid; gap: 8px; }
.aicw-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.aicw-template {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 12px;
  border: 1px solid var(--aicw-line); border-radius: var(--aicw-radius-sm); background: var(--aicw-surface);
}
.aicw-template-name { font-weight: 700; color: var(--aicw-ink); }
.aicw-template-subject { font-size: 13px; color: var(--aicw-muted); overflow-wrap: anywhere; }
.aicw-template-when { font-size: 13px; color: var(--aicw-ink); overflow-wrap: anywhere; }

/* Tags */
.aicw-tag {
  display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px;
  font-size: 12px; font-weight: 700; letter-spacing: .03em; white-space: nowrap;
  background: var(--aicw-ground); color: var(--aicw-muted); border: 1px solid var(--aicw-line);
}
.aicw-tag-ok { background: var(--aicw-ok-soft); color: var(--aicw-ok); border-color: transparent; }
.aicw-tag-warn { background: var(--aicw-warn-soft); color: var(--aicw-warn); border-color: transparent; }
.aicw-tag-danger { background: var(--aicw-danger-soft); color: var(--aicw-danger); border-color: transparent; }

/* Buttons */
.aicw-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 40px; padding: 8px 16px; border-radius: var(--aicw-radius-sm);
  border: 1px solid transparent; font-weight: 600; font-size: 14.5px; line-height: 1.2;
  cursor: pointer; text-decoration: none; text-align: center; background: transparent; color: var(--aicw-ink);
}
@media (max-width: 640px) { .aicw-btn { min-height: 44px; } }
.aicw-btn-primary { background: var(--aicw-accent); color: var(--aicw-on-accent); }
.aicw-btn-primary:hover:not(:disabled) { background: var(--aicw-accent-strong); }
.aicw-btn-secondary { background: var(--aicw-surface); color: var(--aicw-ink); border-color: var(--aicw-line-strong); }
.aicw-btn-secondary:hover:not(:disabled) { background: var(--aicw-ground); border-color: var(--aicw-accent); }
.aicw-btn-danger { background: var(--aicw-danger); color: var(--aicw-on-danger); }
.aicw-btn:disabled { opacity: .55; cursor: not-allowed; }
.aicw-actions { display: flex; flex-wrap: wrap; gap: 8px; }

/* Form */
.aicw-field { display: grid; gap: 6px; min-width: 0; }
.aicw-label { font-size: 14px; font-weight: 600; color: var(--aicw-ink); }
.aicw-input {
  width: 100%; min-height: 44px; padding: 10px 12px; font-size: 16px;
  border: 1px solid var(--aicw-line-strong); border-radius: var(--aicw-radius-sm);
  background: var(--aicw-surface); color: var(--aicw-ink);
}
.aicw-input[aria-invalid="true"] { border-color: var(--aicw-danger); box-shadow: inset 0 0 0 1px var(--aicw-danger); }
textarea.aicw-input { min-height: 180px; resize: vertical; font-family: inherit; }
.aicw-hint { font-size: 13px; color: var(--aicw-muted); overflow-wrap: anywhere; }
.aicw-field-error { font-size: 13px; color: var(--aicw-danger); font-weight: 600; }

/* Notices */
.aicw-notice { padding: 11px 14px; border-radius: var(--aicw-radius-sm); font-size: 14px; border: 1px solid transparent; overflow-wrap: anywhere; }
.aicw-notice-warn { background: var(--aicw-warn-soft); color: var(--aicw-warn); }
.aicw-notice-error { background: var(--aicw-danger-soft); color: var(--aicw-danger); }
.aicw-notice-ok { background: var(--aicw-ok-soft); color: var(--aicw-ok); }
.aicw-notice-info { background: var(--aicw-surface); color: var(--aicw-muted); border-color: var(--aicw-line); }

/* The delivery log: a table from 768px, cards below. */
.aicw-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.aicw-table th { text-align: left; font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--aicw-muted); padding: 8px 10px; border-bottom: 1px solid var(--aicw-line); }
.aicw-table td { padding: 10px; border-bottom: 1px solid var(--aicw-line); vertical-align: top; overflow-wrap: anywhere; }
.aicw-cards { display: none; list-style: none; margin: 0; padding: 0; gap: 8px; }
.aicw-log-card { display: grid; gap: 4px; padding: 10px 12px; border: 1px solid var(--aicw-line); border-radius: var(--aicw-radius-sm); background: var(--aicw-surface); }
@media (max-width: 767px) {
  .aicw-table { display: none; }
  .aicw-cards { display: grid; }
}

/* Loading */
.aicw-loading { display: flex; align-items: center; gap: 10px; padding: 16px 0; color: var(--aicw-muted); }
.aicw-spinner {
  width: 18px; height: 18px; border-radius: 50%; flex: none;
  border: 2px solid var(--aicw-line); border-top-color: var(--aicw-accent);
  animation: aicw-spin .8s linear infinite;
}
@keyframes aicw-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .aicw-spinner { animation-duration: 2.4s; } }

/* Dialog */
.aicw-backdrop {
  position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
  padding: 16px; background: var(--aicw-scrim);
}
.aicw-dialog {
  width: min(640px, 100%); max-height: calc(100vh - 32px); overflow: auto; display: grid; gap: 14px;
  padding: 18px; background: var(--aicw-surface); color: var(--aicw-ink);
  border: 1px solid var(--aicw-line); border-radius: var(--aicw-radius); box-shadow: var(--aicw-shadow-lg);
}
.aicw-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.aicw-dialog-title { font-size: 18px; font-weight: 700; }
.aicw-dialog-close {
  display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; padding: 0;
  border: 0; border-radius: var(--aicw-radius-sm); background: transparent; color: var(--aicw-muted); cursor: pointer;
}
.aicw-dialog-close:hover { background: var(--aicw-ground); color: var(--aicw-ink); }
.aicw-dialog-close svg { width: 18px; height: 18px; }
`;

export interface InjectStylesOptions {
  /** A CSP nonce, set on the created <style> element. */
  nonce?: string;
}

/** Add `<style id="aicw-styles">` once. A tag that already exists is never duplicated. */
export function injectCommsStyles(options: InjectStylesOptions = {}): void {
  injectStyleTag(STYLE_ID, CSS_TEXT, options.nonce);
}

/** The stylesheet text, for a host that renders it itself (SSR, a shadow root). */
export function commsWidgetCss(): string {
  return CSS_TEXT;
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
