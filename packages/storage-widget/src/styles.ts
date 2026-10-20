/**
 * The widget's whole appearance, injected once as a <style> tag. Every rule is
 * prefixed `aifw-`, so the host app's CSS can't reach in by accident and the
 * widget can't leak out. No Tailwind and no CSS import step for the buyer:
 * React is the only peer.
 *
 * THEMING. The palette is AdminIgloo's "Ink & Snow" (comms-widget's token
 * set, copied), carried as `--aifw-*` custom properties declared under
 * `:where()`, at ZERO specificity, so one ordinary rule
 * (`.aifw-root { --aifw-accent: #7c3aed }`) re-themes the screens whatever
 * order the stylesheets load in. Dark comes from the `data-theme` the root
 * writes once it has read the host's theme (./theme.ts); before hydration
 * the media query decides. Every token pair the widget prints text with
 * passes WCAG AA in both themes (src/__tests__/styles.test.ts). Under 640 px
 * every control is at least 44 px tall: a crew member is tapping with a
 * glove on, in the sun.
 */

const STYLE_ID = "aifw-styles";

/** The light tokens: the names a buyer can override, without the `--aifw-` prefix. */
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

/** The colour pairs the screens print, with the WCAG minimum each must meet. */
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
  ["accent", "line", 3],
  ["warn", "line", 3],
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

/** `--aifw-name: value;` for every token. */
export function declareTokens(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `--aifw-${name}: ${value};`)
    .join(" ");
}

const CSS_TEXT = `
.aifw-empty { display: grid; justify-items: center; gap: 6px; padding: 28px 12px; text-align: center; background: var(--aifw-surface); border: 1px solid var(--aifw-line); border-radius: var(--aifw-radius); }
.aifw-empty-title { margin: 0; font-weight: 700; font-size: 16px; color: var(--aifw-ink); }
.aifw-empty-text { margin: 0; max-width: 58ch; font-size: 14.5px; color: var(--aifw-muted); }
:where(.aifw-root) { ${declareTokens(LIGHT_TOKENS)} }
@media (prefers-color-scheme: dark) {
  :where(.aifw-root:not([data-theme="light"])) { ${declareTokens(DARK_TOKENS)} }
}
:where(.aifw-root[data-theme="dark"]) { ${declareTokens(DARK_TOKENS)} }

.aifw-root {
  position: relative; box-sizing: border-box; width: 100%; max-width: 100%;
  color: var(--aifw-ink); text-align: left;
  font-family: var(--aifw-font); font-size: 14.5px; line-height: 1.5;
  -webkit-text-size-adjust: 100%; color-scheme: light;
}
.aifw-root[data-theme="dark"] { color-scheme: dark; }
@media (prefers-color-scheme: dark) { .aifw-root:not([data-theme="light"]) { color-scheme: dark; } }
.aifw-root *, .aifw-root *::before, .aifw-root *::after { box-sizing: border-box; }
.aifw-root :where(h2, h3, h4, p, ul, ol, dl, dd, fieldset, legend, figure, table) { margin: 0; padding: 0; }
.aifw-root :where(button, input, select, textarea) { font: inherit; color: inherit; letter-spacing: inherit; }
.aifw-root :where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: 2px solid var(--aifw-focus); outline-offset: 2px;
}
.aifw-root [tabindex="-1"]:focus { outline: none; }
.aifw-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0;
}
.aifw-root a:not(.aifw-btn) { color: var(--aifw-accent); font-weight: 600; text-underline-offset: 3px; }

.aifw-card {
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; padding: 16px; min-width: 0;
  background: var(--aifw-surface); border: 1px solid var(--aifw-line); border-radius: var(--aifw-radius); box-shadow: var(--aifw-shadow);
}
.aifw-drop[data-dropping="true"] { outline: 2px dashed var(--aifw-accent); outline-offset: 4px; border-radius: var(--aifw-radius-sm); }
@media (max-width: 480px) { .aifw-card { padding: 12px; } }
.aifw-head { display: grid; gap: 2px; min-width: 0; }
.aifw-h2 { font-size: 17px; font-weight: 700; color: var(--aifw-ink); }
.aifw-sub { font-size: 14px; font-weight: 600; color: var(--aifw-ink); overflow-wrap: anywhere; }
.aifw-muted { color: var(--aifw-muted); }
.aifw-small { font-size: 13px; color: var(--aifw-muted); overflow-wrap: anywhere; }
.aifw-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
.aifw-grow { flex: 1 1 auto; min-width: 0; }
.aifw-stack { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; min-width: 0; }

/* Photos: a grid of thumbnails, each a link that opens the photo. */
.aifw-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 10px; }
@media (max-width: 480px) { .aifw-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.aifw-thumb { display: grid; gap: 6px; min-width: 0; }
.aifw-thumb-link { display: block; aspect-ratio: 1 / 1; border-radius: var(--aifw-radius-sm); overflow: hidden; background: var(--aifw-ground); border: 1px solid var(--aifw-line); }
.aifw-thumb-link img { display: block; width: 100%; height: 100%; object-fit: cover; }
.aifw-thumb-actions { display: flex; flex-wrap: wrap; gap: 4px; }

/* Documents: rows with an icon, the name and the size. */
.aifw-docs { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.aifw-doc {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 12px; min-width: 0;
  border: 1px solid var(--aifw-line); border-radius: var(--aifw-radius-sm); background: var(--aifw-surface);
}
.aifw-doc-name { font-weight: 600; color: var(--aifw-ink); overflow-wrap: anywhere; }
.aifw-icon { width: 22px; height: 22px; flex: none; color: var(--aifw-muted); }

/* Buttons */
.aifw-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 40px; padding: 8px 16px; border-radius: var(--aifw-radius-sm);
  border: 1px solid transparent; font-weight: 600; font-size: 14.5px; line-height: 1.2;
  cursor: pointer; text-decoration: none; text-align: center; background: transparent; color: var(--aifw-ink);
}
.aifw-btn-sm { min-height: 32px; padding: 4px 10px; font-size: 13px; }
@media (max-width: 640px) { .aifw-btn, .aifw-btn-sm { min-height: 44px; } }
.aifw-btn-primary { background: var(--aifw-accent); color: var(--aifw-on-accent); }
.aifw-btn-primary:hover:not(:disabled) { background: var(--aifw-accent-strong); }
.aifw-btn-secondary { background: var(--aifw-surface); color: var(--aifw-ink); border-color: var(--aifw-line-strong); }
.aifw-btn-secondary:hover:not(:disabled) { background: var(--aifw-ground); border-color: var(--aifw-accent); }
.aifw-btn-danger { background: var(--aifw-danger); color: var(--aifw-on-danger); }
.aifw-btn-quiet { color: var(--aifw-accent); padding-left: 8px; padding-right: 8px; }
.aifw-btn:disabled { opacity: .55; cursor: not-allowed; }
.aifw-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.aifw-file-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }

/* Uploads in flight, and the ones that didn't go (review BO-05). */
.aifw-queue { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.aifw-pending {
  display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 10px; align-items: center; padding: 10px;
  border: 1px solid var(--aifw-line); border-radius: var(--aifw-radius-sm); background: var(--aifw-surface);
}
.aifw-pending[data-failed="true"] { border-color: var(--aifw-danger); background: var(--aifw-danger-soft); }
.aifw-pending-preview { width: 56px; height: 56px; border-radius: 8px; object-fit: cover; background: var(--aifw-ground); }
.aifw-progress { height: 8px; border-radius: 999px; background: var(--aifw-line); overflow: hidden; }
.aifw-progress-bar { height: 100%; background: var(--aifw-accent); transition: width .2s ease; }
@media (prefers-reduced-motion: reduce) { .aifw-progress-bar { transition: none; } }

/* The usage meter */
.aifw-meter { display: grid; gap: 6px; }
.aifw-meter-track { height: 10px; border-radius: 999px; background: var(--aifw-line); overflow: hidden; }
.aifw-meter-fill { height: 100%; background: var(--aifw-accent); }
.aifw-meter[data-tone="warn"] .aifw-meter-fill { background: var(--aifw-warn); }
.aifw-meter[data-tone="full"] .aifw-meter-fill { background: var(--aifw-danger); }
.aifw-meter-label { font-weight: 600; color: var(--aifw-ink); }
.aifw-meter-note { font-size: 13.5px; color: var(--aifw-muted); }
.aifw-meter[data-tone="warn"] .aifw-meter-note { color: var(--aifw-warn); font-weight: 600; }
.aifw-meter[data-tone="full"] .aifw-meter-note { color: var(--aifw-danger); font-weight: 600; }

/* Filters, as an owner thinks of them (review BO-22). */
.aifw-filters { display: flex; flex-wrap: wrap; gap: 6px; }
.aifw-chip {
  display: inline-flex; align-items: center; min-height: 36px; padding: 6px 14px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--aifw-line-strong); background: var(--aifw-surface); color: var(--aifw-ink); font-weight: 600; font-size: 13.5px;
}
.aifw-chip[aria-pressed="true"] { background: var(--aifw-accent); border-color: var(--aifw-accent); color: var(--aifw-on-accent); }
@media (max-width: 640px) { .aifw-chip { min-height: 44px; } }
.aifw-select {
  min-height: 40px; padding: 6px 10px; font-size: 14.5px; border-radius: var(--aifw-radius-sm);
  border: 1px solid var(--aifw-line-strong); background: var(--aifw-surface); color: var(--aifw-ink);
}
@media (max-width: 640px) { .aifw-select { min-height: 44px; font-size: 16px; } }

/* The Files screen: a table from 768 px, cards below. */
.aifw-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.aifw-table th { text-align: left; font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--aifw-muted); padding: 8px 10px; border-bottom: 1px solid var(--aifw-line); }
.aifw-table td { padding: 10px; border-bottom: 1px solid var(--aifw-line); vertical-align: top; overflow-wrap: anywhere; }
.aifw-cards { display: none; list-style: none; margin: 0; padding: 0; gap: 8px; }
.aifw-file-card { display: grid; gap: 4px; padding: 10px 12px; border: 1px solid var(--aifw-line); border-radius: var(--aifw-radius-sm); background: var(--aifw-surface); min-width: 0; }
@media (max-width: 767px) {
  .aifw-table { display: none; }
  .aifw-cards { display: grid; }
}

/* Notices */
.aifw-notice { padding: 11px 14px; border-radius: var(--aifw-radius-sm); font-size: 14px; border: 1px solid transparent; overflow-wrap: anywhere; }
.aifw-notice-warn { background: var(--aifw-warn-soft); color: var(--aifw-warn); }
.aifw-notice-error { background: var(--aifw-danger-soft); color: var(--aifw-danger); }
.aifw-notice-ok { background: var(--aifw-ok-soft); color: var(--aifw-ok); }
.aifw-notice-info { background: var(--aifw-surface); color: var(--aifw-muted); border-color: var(--aifw-line); }
.aifw-danger-text { color: var(--aifw-danger); font-weight: 600; font-size: 14px; }
.aifw-link-box { width: 100%; min-height: 44px; padding: 8px 10px; font-size: 14px; border: 1px solid var(--aifw-line-strong); border-radius: var(--aifw-radius-sm); background: var(--aifw-surface); color: var(--aifw-ink); }

/* Loading */
.aifw-loading { display: flex; align-items: center; gap: 10px; padding: 16px 0; color: var(--aifw-muted); }
.aifw-spinner {
  width: 18px; height: 18px; border-radius: 50%; flex: none;
  border: 2px solid var(--aifw-line); border-top-color: var(--aifw-accent);
  animation: aifw-spin .8s linear infinite;
}
@keyframes aifw-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .aifw-spinner { animation-duration: 2.4s; } }

/* Dialog */
.aifw-backdrop {
  position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
  padding: 16px; background: var(--aifw-scrim);
}
.aifw-dialog {
  width: min(480px, 100%); max-height: calc(100vh - 32px); overflow: auto; display: grid; gap: 14px;
  padding: 18px; background: var(--aifw-surface); color: var(--aifw-ink);
  border: 1px solid var(--aifw-line); border-radius: var(--aifw-radius); box-shadow: var(--aifw-shadow-lg);
}
.aifw-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.aifw-dialog-title { font-size: 18px; font-weight: 700; overflow-wrap: anywhere; }
.aifw-dialog-close {
  display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; padding: 0;
  border: 0; border-radius: var(--aifw-radius-sm); background: transparent; color: var(--aifw-muted); cursor: pointer;
}
.aifw-dialog-close:hover { background: var(--aifw-ground); color: var(--aifw-ink); }
.aifw-dialog-close svg { width: 18px; height: 18px; }
`;

export interface InjectStylesOptions {
  /** A CSP nonce, set on the created <style> element. */
  nonce?: string;
}

/** Add `<style id="aifw-styles">` once. A tag that already exists is never duplicated. */
export function injectFilesStyles(options: InjectStylesOptions = {}): void {
  injectStyleTag(STYLE_ID, CSS_TEXT, options.nonce);
}

/** The stylesheet text, for a host that renders it itself (SSR, a shadow root). */
export function filesWidgetCss(): string {
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
