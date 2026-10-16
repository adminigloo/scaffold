/**
 * The widget's whole appearance, injected once as a <style> tag. Every rule is
 * prefixed `ainw-`, so the host app's CSS can't reach in by accident and the
 * widget can't leak out. No Tailwind and no CSS import step for the buyer:
 * React is the only peer.
 *
 * THEMING. The palette is AdminIgloo's "Ink & Snow" (comms-widget's token
 * set, copied), carried as `--ainw-*` custom properties declared under
 * `:where()`, at ZERO specificity, so one ordinary rule
 * (`.ainw-root { --ainw-accent: #7c3aed }`) re-themes the screens whatever
 * order the stylesheets load in. Dark comes from the `data-theme` the root
 * writes once it has read the host's theme (./theme.ts); before hydration the
 * media query decides. Every token pair the widget prints text with passes
 * WCAG AA in both themes (src/__tests__/styles.test.ts).
 *
 * PHONES. Every control is at least 44 px tall under 640 px, nothing scrolls
 * sideways at 360 px, and the bell's list opens as a sheet across the top of
 * the screen there (a popover under the button from 640 px).
 */

const STYLE_ID = "ainw-styles";

/** The light tokens: the names a buyer can override, without the `--ainw-` prefix. */
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
  badge: "#a02e21",
  "on-badge": "#ffffff",
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
  badge: "#ec8f80",
  "on-badge": "#0b0f13",
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
  ["accent", "accent-soft", 4.5],
  ["ink", "accent-soft", 4.5],
  ["on-accent", "accent", 4.5],
  ["on-accent", "accent-strong", 4.5],
  ["on-badge", "badge", 4.5],
  ["ok", "ok-soft", 4.5],
  ["ok", "surface", 4.5],
  ["warn", "warn-soft", 4.5],
  ["warn", "surface", 4.5],
  ["danger", "danger-soft", 4.5],
  ["danger", "surface", 4.5],
  ["on-danger", "danger", 4.5],
  ["line-strong", "surface", 3],
  ["accent", "surface", 3],
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

/** `--ainw-name: value;` for every token. */
export function declareTokens(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `--ainw-${name}: ${value};`)
    .join(" ");
}

const CSS_TEXT = `
:where(.ainw-root) { ${declareTokens(LIGHT_TOKENS)} }
@media (prefers-color-scheme: dark) {
  :where(.ainw-root:not([data-theme="light"])) { ${declareTokens(DARK_TOKENS)} }
}
:where(.ainw-root[data-theme="dark"]) { ${declareTokens(DARK_TOKENS)} }

.ainw-root {
  position: relative; box-sizing: border-box; max-width: 100%;
  color: var(--ainw-ink); text-align: left;
  font-family: var(--ainw-font); font-size: 14.5px; line-height: 1.5;
  -webkit-text-size-adjust: 100%; color-scheme: light;
}
.ainw-root[data-theme="dark"] { color-scheme: dark; }
@media (prefers-color-scheme: dark) { .ainw-root:not([data-theme="light"]) { color-scheme: dark; } }
.ainw-root *, .ainw-root *::before, .ainw-root *::after { box-sizing: border-box; }
.ainw-root :where(h2, h3, h4, p, ul, ol, dl, dd, fieldset, legend, figure) { margin: 0; padding: 0; }
.ainw-root :where(fieldset) { border: 0; min-width: 0; }
.ainw-root :where(button, input, select, textarea) { font: inherit; color: inherit; letter-spacing: inherit; }
.ainw-root :where(a, button, input, select, textarea, [tabindex]):focus-visible {
  outline: 2px solid var(--ainw-focus); outline-offset: 2px;
}
.ainw-root [tabindex="-1"]:focus { outline: none; }
.ainw-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0;
}
.ainw-root a:not(.ainw-btn) { color: var(--ainw-accent); font-weight: 600; text-underline-offset: 3px; }

/* The bell */
.ainw-bell-root { display: inline-block; }
.ainw-bell-wrap { position: relative; display: inline-block; }
.ainw-bell {
  position: relative; display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 44px; padding: 0; border: 0; border-radius: 999px;
  background: transparent; color: inherit; cursor: pointer;
}
.ainw-bell:hover { background: var(--ainw-accent-soft); color: var(--ainw-ink); }
.ainw-bell svg { width: 22px; height: 22px; }
.ainw-badge {
  position: absolute; top: 4px; right: 2px; min-width: 18px; height: 18px; padding: 0 5px;
  display: inline-flex; align-items: center; justify-content: center; border-radius: 999px;
  background: var(--ainw-badge); color: var(--ainw-on-badge); font-size: 11px; font-weight: 700; line-height: 1;
}

/* The bell's panel: a popover from 640px, a sheet across the top below. */
.ainw-panel {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 1000; width: 360px; max-width: calc(100vw - 16px);
  display: grid; grid-template-rows: auto minmax(0, 1fr) auto; max-height: min(560px, calc(100vh - 80px));
  background: var(--ainw-surface); color: var(--ainw-ink);
  border: 1px solid var(--ainw-line); border-radius: var(--ainw-radius); box-shadow: var(--ainw-shadow-lg);
}
.ainw-backdrop { position: fixed; inset: 0; z-index: 999; background: var(--ainw-scrim); }
.ainw-panel[data-ainw-mode="sheet"] {
  position: fixed; top: 0; left: 0; right: 0; width: 100%; max-width: 100%; max-height: 85vh;
  border-radius: 0 0 var(--ainw-radius) var(--ainw-radius); border-top: 0;
}
.ainw-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px 8px 16px; border-bottom: 1px solid var(--ainw-line); }
.ainw-panel-title { font-size: 16px; font-weight: 700; }
.ainw-panel-body { overflow-y: auto; overflow-x: hidden; }
.ainw-panel-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; padding: 10px 16px; border-top: 1px solid var(--ainw-line); }
.ainw-close {
  display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; padding: 0;
  border: 0; border-radius: var(--ainw-radius-sm); background: transparent; color: var(--ainw-muted); cursor: pointer;
}
.ainw-close:hover { background: var(--ainw-ground); color: var(--ainw-ink); }
.ainw-close svg { width: 18px; height: 18px; }

/* An alert */
.ainw-list { list-style: none; margin: 0; padding: 0; }
.ainw-item { border-bottom: 1px solid var(--ainw-line); }
.ainw-item:last-child { border-bottom: 0; }
.ainw-item-btn {
  display: grid; grid-template-columns: 32px minmax(0, 1fr) 10px; gap: 10px; align-items: start; width: 100%;
  min-height: 56px; padding: 10px 14px; border: 0; background: transparent; color: var(--ainw-ink);
  text-align: left; cursor: pointer;
}
.ainw-item-btn:hover { background: var(--ainw-ground); }
.ainw-icon {
  display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 999px;
  background: var(--ainw-accent-soft); color: var(--ainw-accent);
}
.ainw-icon svg { width: 17px; height: 17px; }
.ainw-item-text { display: grid; gap: 2px; min-width: 0; }
.ainw-item-title { font-weight: 500; overflow-wrap: anywhere; }
.ainw-unread .ainw-item-title { font-weight: 700; }
.ainw-item-body { font-size: 13.5px; color: var(--ainw-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ainw-item-when { font-size: 12.5px; color: var(--ainw-faint); }
.ainw-dot { width: 10px; height: 10px; margin-top: 6px; border-radius: 999px; background: var(--ainw-accent); }
.ainw-empty { padding: 22px 16px; color: var(--ainw-muted); text-align: center; overflow-wrap: anywhere; }

/* Buttons and links */
.ainw-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 40px; padding: 8px 14px; border-radius: var(--ainw-radius-sm);
  border: 1px solid transparent; font-weight: 600; font-size: 14px; line-height: 1.2;
  cursor: pointer; text-decoration: none; text-align: center; background: transparent; color: var(--ainw-ink);
}
.ainw-btn-primary { background: var(--ainw-accent); color: var(--ainw-on-accent); }
.ainw-btn-primary:hover:not(:disabled) { background: var(--ainw-accent-strong); }
.ainw-btn-secondary { background: var(--ainw-surface); color: var(--ainw-ink); border-color: var(--ainw-line-strong); }
.ainw-btn-secondary:hover:not(:disabled) { background: var(--ainw-ground); border-color: var(--ainw-accent); }
.ainw-btn-link { padding: 8px 4px; color: var(--ainw-accent); }
.ainw-btn:disabled { opacity: .55; cursor: not-allowed; }
.ainw-link { display: inline-flex; align-items: center; min-height: 40px; }
@media (max-width: 639px) {
  .ainw-btn, .ainw-link { min-height: 44px; }
}

/* Pages */
.ainw-page { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; width: 100%; padding: 16px; background: var(--ainw-ground); }
@media (max-width: 480px) { .ainw-page { padding: 12px; gap: 12px; } }
.ainw-title { font-size: 21px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.25; color: var(--ainw-ink); }
.ainw-card {
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; padding: 16px; min-width: 0;
  background: var(--ainw-surface); border: 1px solid var(--ainw-line); border-radius: var(--ainw-radius); box-shadow: var(--ainw-shadow);
}
.ainw-card-flush { padding: 0; gap: 0; overflow: hidden; }
.ainw-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.ainw-h2 { font-size: 17px; font-weight: 700; color: var(--ainw-ink); }
.ainw-h3 { font-size: 13px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--ainw-muted); }
.ainw-day { padding: 12px 16px 6px; background: var(--ainw-ground); border-bottom: 1px solid var(--ainw-line); }
.ainw-muted { color: var(--ainw-muted); }
.ainw-small { font-size: 13px; color: var(--ainw-muted); overflow-wrap: anywhere; }
.ainw-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
.ainw-stack { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }

/* All / Unread */
.ainw-tabs { display: inline-flex; padding: 3px; gap: 3px; border-radius: 999px; background: var(--ainw-surface); border: 1px solid var(--ainw-line); }
.ainw-tab {
  min-height: 36px; padding: 6px 14px; border: 0; border-radius: 999px; background: transparent; color: var(--ainw-muted);
  font-weight: 600; cursor: pointer;
}
.ainw-tab[aria-pressed="true"] { background: var(--ainw-accent-soft); color: var(--ainw-ink); }
@media (max-width: 639px) { .ainw-tab { min-height: 44px; } }

/* Settings */
.ainw-kind { display: grid; gap: 6px; padding: 12px 0; border-top: 1px solid var(--ainw-line); min-width: 0; }
.ainw-kind:first-of-type { border-top: 0; padding-top: 0; }
.ainw-kind-label { font-weight: 700; color: var(--ainw-ink); }
.ainw-choices { display: flex; flex-wrap: wrap; gap: 6px 18px; }
.ainw-choice { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; cursor: pointer; overflow-wrap: anywhere; }
.ainw-choice input { width: 18px; height: 18px; margin: 0; accent-color: var(--ainw-accent); flex: none; }
.ainw-choice-disabled { color: var(--ainw-faint); cursor: not-allowed; }
@media (max-width: 639px) { .ainw-choice { min-height: 44px; } }
.ainw-note { font-size: 13px; color: var(--ainw-muted); overflow-wrap: anywhere; }
.ainw-people { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.ainw-person-email { color: var(--ainw-muted); font-size: 13px; overflow-wrap: anywhere; }
.ainw-field { display: grid; gap: 6px; min-width: 0; }
.ainw-label { font-size: 14px; font-weight: 600; color: var(--ainw-ink); }
.ainw-input {
  width: 100%; min-height: 44px; padding: 10px 12px; font-size: 16px;
  border: 1px solid var(--ainw-line-strong); border-radius: var(--ainw-radius-sm);
  background: var(--ainw-surface); color: var(--ainw-ink);
}
.ainw-input-grow { flex: 1 1 220px; width: auto; min-width: 0; }
.ainw-input[aria-invalid="true"] { border-color: var(--ainw-danger); box-shadow: inset 0 0 0 1px var(--ainw-danger); }
.ainw-field-error { font-size: 13px; color: var(--ainw-danger); font-weight: 600; }

/* Notices */
.ainw-notice { padding: 11px 14px; border-radius: var(--ainw-radius-sm); font-size: 14px; border: 1px solid transparent; overflow-wrap: anywhere; }
.ainw-notice-warn { background: var(--ainw-warn-soft); color: var(--ainw-warn); }
.ainw-notice-error { background: var(--ainw-danger-soft); color: var(--ainw-danger); }
.ainw-notice-ok { background: var(--ainw-ok-soft); color: var(--ainw-ok); }
.ainw-notice-info { background: var(--ainw-surface); color: var(--ainw-muted); border-color: var(--ainw-line); }
.ainw-status { min-height: 1.5em; font-size: 14px; color: var(--ainw-ok); font-weight: 600; }

/* Loading */
.ainw-loading { display: flex; align-items: center; gap: 10px; padding: 16px; color: var(--ainw-muted); }
.ainw-spinner {
  width: 18px; height: 18px; border-radius: 50%; flex: none;
  border: 2px solid var(--ainw-line); border-top-color: var(--ainw-accent);
  animation: ainw-spin .8s linear infinite;
}
@keyframes ainw-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ainw-spinner { animation-duration: 2.4s; } }
`;

export interface InjectStylesOptions {
  /** A CSP nonce, set on the created <style> element. */
  nonce?: string;
}

/** Add `<style id="ainw-styles">` once. A tag that already exists is never duplicated. */
export function injectAlertsStyles(options: InjectStylesOptions = {}): void {
  injectStyleTag(STYLE_ID, CSS_TEXT, options.nonce);
}

/** The stylesheet text, for a host that renders it itself (SSR, a shadow root). */
export function alertsWidgetCss(): string {
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
