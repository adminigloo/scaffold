/**
 * The widget's whole appearance, injected once as a <style> tag. Every rule is
 * prefixed `aia-`, so the host app's CSS can't reach in by accident and the
 * widget can't leak out. No Tailwind and no CSS import step for the buyer:
 * React is the only peer.
 *
 * THEMING. The palette is AdminIgloo's "Ink & Snow" (the notifications
 * widget's token set, copied), carried as `--aia-*` custom properties declared
 * under `:where()`, at ZERO specificity, so one ordinary rule
 * (`.aia-root { --aia-accent: #7c3aed }`) re-themes it. Dark comes from the
 * `data-theme` the root writes once it has read the HOST's theme (./theme.ts);
 * before hydration the media query decides. Every pair the widget prints text
 * with passes WCAG AA in both themes (src/__tests__/styles.test.ts).
 *
 * PHONES. Under 640 px the chat opens full screen, every control is at least
 * 44 px tall, and nothing scrolls sideways at 360 px.
 */

const STYLE_ID = "aia-styles";

/** The light tokens: the names a buyer can override, without the `--aia-` prefix. */
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

/** The colour pairs the widget prints, with the WCAG minimum each must meet. */
export const CONTRAST_PAIRS: ReadonlyArray<readonly [fg: string, bg: string, min: number]> = [
  ["ink", "surface", 4.5],
  ["ink", "ground", 4.5],
  ["muted", "surface", 4.5],
  ["muted", "ground", 4.5],
  ["faint", "surface", 4.5],
  ["accent", "surface", 4.5],
  ["accent", "accent-soft", 4.5],
  ["ink", "accent-soft", 4.5],
  ["on-accent", "accent", 4.5],
  ["on-accent", "accent-strong", 4.5],
  ["ok", "ok-soft", 4.5],
  ["warn", "warn-soft", 4.5],
  ["danger", "danger-soft", 4.5],
  ["danger", "surface", 4.5],
  ["line-strong", "surface", 3],
  ["focus", "surface", 3],
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

function declareTokens(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `--aia-${name}: ${value};`)
    .join(" ");
}

const CSS_TEXT = `
:where(.aia-root) { ${declareTokens(LIGHT_TOKENS)} }
@media (prefers-color-scheme: dark) {
  :where(.aia-root:not([data-theme="light"])) { ${declareTokens(DARK_TOKENS)} }
}
:where(.aia-root[data-theme="dark"]) { ${declareTokens(DARK_TOKENS)} }

.aia-root {
  box-sizing: border-box; max-width: 100%; color: var(--aia-ink); text-align: left;
  font-family: var(--aia-font); font-size: 14.5px; line-height: 1.5; -webkit-text-size-adjust: 100%; color-scheme: light;
}
.aia-root[data-theme="dark"] { color-scheme: dark; }
@media (prefers-color-scheme: dark) { .aia-root:not([data-theme="light"]) { color-scheme: dark; } }
.aia-root *, .aia-root *::before, .aia-root *::after { box-sizing: border-box; }
.aia-root :where(h2, h3, h4, p, ul, ol, fieldset, legend) { margin: 0; padding: 0; }
.aia-root :where(fieldset) { border: 0; min-width: 0; }
.aia-root :where(button, input, select, textarea) { font: inherit; color: inherit; letter-spacing: inherit; }
.aia-root :where(a, button, input, select, textarea, [tabindex]):focus-visible { outline: 2px solid var(--aia-focus); outline-offset: 2px; }
.aia-root [tabindex="-1"]:focus { outline: none; }
.aia-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0; }

/* Buttons */
.aia-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 40px; padding: 8px 14px;
  border: 1px solid var(--aia-line-strong); border-radius: var(--aia-radius-sm); background: var(--aia-surface); color: var(--aia-ink);
  font-weight: 600; font-size: 14px; cursor: pointer; text-decoration: none; white-space: nowrap;
}
.aia-btn:hover { background: var(--aia-ground); }
.aia-btn[disabled] { opacity: .55; cursor: default; }
.aia-btn-primary { background: var(--aia-accent); border-color: var(--aia-accent); color: var(--aia-on-accent); }
.aia-btn-primary:hover { background: var(--aia-accent-strong); border-color: var(--aia-accent-strong); }
.aia-btn-quiet { border-color: transparent; background: transparent; color: var(--aia-muted); }
.aia-btn-quiet:hover { background: var(--aia-ground); color: var(--aia-ink); }
.aia-btn-danger { color: var(--aia-danger); }
.aia-icon-btn { width: 44px; height: 44px; min-height: 44px; padding: 0; }
.aia-icon-btn svg { width: 18px; height: 18px; }

/* The launcher */
.aia-launcher {
  position: fixed; right: 20px; bottom: 20px; z-index: 900; display: inline-flex; align-items: center; gap: 8px;
  min-height: 52px; padding: 0 18px 0 14px; border: 0; border-radius: 999px; background: var(--aia-accent); color: var(--aia-on-accent);
  font-weight: 700; font-size: 15px; box-shadow: var(--aia-shadow-lg); cursor: pointer;
}
.aia-launcher:hover { background: var(--aia-accent-strong); }
.aia-launcher svg { width: 22px; height: 22px; }
.aia-scrim { position: fixed; inset: 0; z-index: 950; background: var(--aia-scrim); }
.aia-sheet {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 960; width: 420px; max-width: 100vw; display: flex; flex-direction: column;
  background: var(--aia-surface); color: var(--aia-ink); border-left: 1px solid var(--aia-line); box-shadow: var(--aia-shadow-lg);
  animation: aia-slide .18s ease-out;
}
@keyframes aia-slide { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .aia-sheet { animation: none; } }
@media (max-width: 639px) {
  .aia-sheet { width: 100vw; border-left: 0; }
  .aia-launcher { right: 16px; bottom: 16px; }
  .aia-btn { min-height: 44px; }
}

/* The chat */
.aia-chat { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--aia-surface); }
.aia-head { display: flex; align-items: center; gap: 4px; padding: 8px 8px 8px 16px; border-bottom: 1px solid var(--aia-line); }
.aia-head-title { flex: 1; min-width: 0; }
.aia-title { font-size: 16px; font-weight: 700; line-height: 1.3; overflow-wrap: anywhere; }
.aia-subtitle { font-size: 12.5px; color: var(--aia-muted); }
.aia-notice { margin: 10px 12px 0; padding: 10px 12px; border-radius: var(--aia-radius-sm); font-size: 13.5px; }
.aia-notice-warn { background: var(--aia-warn-soft); color: var(--aia-warn); }
.aia-notice-info { background: var(--aia-ground); color: var(--aia-muted); }
.aia-thread { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.aia-msg { max-width: 88%; padding: 10px 13px; border-radius: 14px; overflow-wrap: anywhere; }
.aia-user { align-self: flex-end; background: var(--aia-accent); color: var(--aia-on-accent); border-bottom-right-radius: 4px; white-space: pre-wrap; }
.aia-assistant { align-self: flex-start; background: var(--aia-ground); border: 1px solid var(--aia-line); border-bottom-left-radius: 4px; }
.aia-msg-note { margin-top: 6px; font-size: 12px; color: var(--aia-muted); }
.aia-activity { align-self: flex-start; display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--aia-muted); }
.aia-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--aia-accent); animation: aia-pulse 1s ease-in-out infinite; }
@keyframes aia-pulse { 0%,100% { opacity: .3; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .aia-dot { animation: none; } }
.aia-error { align-self: stretch; padding: 10px 12px; border-radius: var(--aia-radius-sm); background: var(--aia-danger-soft); color: var(--aia-danger); font-size: 13.5px; }
.aia-empty { margin: auto 0; display: flex; flex-direction: column; gap: 12px; color: var(--aia-muted); }
.aia-starters { display: flex; flex-wrap: wrap; gap: 8px; }
.aia-starter {
  min-height: 40px; padding: 8px 12px; border: 1px solid var(--aia-line-strong); border-radius: 999px; background: var(--aia-surface);
  color: var(--aia-ink); font-size: 13.5px; text-align: left; cursor: pointer;
}
.aia-starter:hover { border-color: var(--aia-accent); background: var(--aia-accent-soft); }
@media (max-width: 639px) { .aia-starter { min-height: 44px; } }

/* "Ask before acting" */
.aia-action { margin-top: 10px; padding: 12px; border: 1px solid var(--aia-accent); border-radius: 12px; background: var(--aia-accent-soft); color: var(--aia-ink); }
.aia-action-label { font-size: 12px; font-weight: 700; letter-spacing: .02em; color: var(--aia-accent); }
.aia-action-summary { margin-top: 2px; font-weight: 600; }
.aia-action-buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.aia-action-result { margin-top: 6px; font-size: 13.5px; }
.aia-action-fields { margin: 8px 0 0; display: grid; gap: 6px; }
.aia-action-field dt { font-size: 12px; font-weight: 700; color: var(--aia-muted); }
.aia-action-field dd { margin: 2px 0 0; padding: 8px 10px; border-radius: 8px; background: var(--aia-surface); border: 1px solid var(--aia-line);
  white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
.aia-action-field dd:has(> .aia-input) { padding: 0; border: 0; background: none; }
.aia-action-field .aia-input { width: 100%; }
.aia-starter[disabled] { opacity: .5; cursor: default; }
.aia-action[data-state="done"] { border-color: var(--aia-ok); background: var(--aia-ok-soft); }
.aia-action[data-state="done"] .aia-action-label { color: var(--aia-ok); }

/* Rendered answers (safe markdown: no raw HTML, ever) */
.aia-md > * + * { margin-top: 8px; }
.aia-md :where(ul, ol) { padding-left: 20px; }
.aia-md li + li { margin-top: 2px; }
.aia-md code { padding: 1px 5px; border-radius: 5px; background: var(--aia-surface); border: 1px solid var(--aia-line); font-size: 13px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.aia-md pre { padding: 10px; border-radius: 8px; background: var(--aia-surface); border: 1px solid var(--aia-line); overflow-x: auto; }
.aia-md pre code { padding: 0; border: 0; background: none; }
.aia-md a { color: var(--aia-accent); font-weight: 600; text-underline-offset: 3px; }
.aia-md h3 { font-size: 15px; font-weight: 700; }

/* Compose */
.aia-compose { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--aia-line); }
.aia-input {
  flex: 1; min-width: 0; resize: none; min-height: 44px; max-height: 140px; padding: 10px 12px; border: 1px solid var(--aia-line-strong);
  border-radius: var(--aia-radius-sm); background: var(--aia-surface); color: var(--aia-ink); font-size: 15px;
}
.aia-compose .aia-btn { align-self: flex-end; min-height: 44px; }

/* History */
.aia-history { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; }
.aia-history-item {
  display: block; width: 100%; min-height: 48px; padding: 10px 12px; border: 0; border-radius: var(--aia-radius-sm);
  background: transparent; color: var(--aia-ink); text-align: left; cursor: pointer;
}
.aia-history-item:hover { background: var(--aia-ground); }
.aia-history-when { display: block; font-size: 12px; color: var(--aia-muted); }

/* Settings (./admin) */
.aia-settings { display: grid; gap: 16px; }
.aia-card { padding: 16px; border: 1px solid var(--aia-line); border-radius: var(--aia-radius); background: var(--aia-surface); box-shadow: var(--aia-shadow); }
.aia-card > * + * { margin-top: 10px; }
.aia-card-title { font-size: 16px; font-weight: 700; }
.aia-card-help { font-size: 13.5px; color: var(--aia-muted); }
.aia-field { display: grid; gap: 4px; font-size: 13.5px; font-weight: 600; color: var(--aia-muted); }
.aia-field :where(input, textarea) {
  width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid var(--aia-line-strong); border-radius: var(--aia-radius-sm);
  background: var(--aia-surface); color: var(--aia-ink); font-weight: 400; font-size: 15px;
}
.aia-field textarea { min-height: 96px; resize: vertical; }
.aia-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.aia-list { list-style: none; display: grid; gap: 8px; }
.aia-item { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px 12px; padding: 10px 12px; border: 1px solid var(--aia-line); border-radius: var(--aia-radius-sm); }
.aia-item-body { flex: 1; min-width: 12rem; overflow-wrap: anywhere; }
.aia-item-sub { font-size: 13.5px; color: var(--aia-muted); white-space: pre-wrap; }
.aia-meter { height: 8px; border-radius: 999px; background: var(--aia-ground); border: 1px solid var(--aia-line); overflow: hidden; }
.aia-meter > span { display: block; height: 100%; background: var(--aia-accent); }
.aia-meter[data-full="true"] > span { background: var(--aia-danger); }
.aia-saved { font-size: 13.5px; color: var(--aia-ok); }
.aia-problem { font-size: 13.5px; color: var(--aia-danger); }
`;

/** The stylesheet text, for a host that renders it itself. */
export const ASSISTANT_WIDGET_CSS = CSS_TEXT;

export function injectStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS_TEXT;
  document.head.appendChild(style);
}
