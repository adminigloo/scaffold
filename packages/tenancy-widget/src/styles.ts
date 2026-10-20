import { contrastRatio } from "./color.js";

/**
 * The widget's whole appearance, injected once as a <style> tag. Every rule is
 * prefixed `aitw-`, so the host app's CSS can't reach in by accident and the
 * widget can't leak out. No Tailwind and no CSS import step for the buyer:
 * React is the only peer, and this is what that costs.
 *
 * THEMING (contract 8.2, scheduling-widget's rules with the `aitw` prefix).
 * The palette is AdminIgloo's "Ink & Snow", carried as `--aitw-*` custom
 * properties declared under `:where()`, i.e. at ZERO specificity, so one
 * ordinary rule (`.aitw-root { --aitw-accent: #7c3aed }`) re-themes every
 * component whatever order the stylesheets load in. Component rules stay at
 * class specificity, so a host's element rules (Tailwind preflight's
 * `button { background: transparent }`) still can't restyle the widget.
 *
 * Dark comes from the `data-theme` the component writes once it has read the
 * host's theme (./theme.ts). Before hydration there is no `data-theme`, so the
 * media query decides: no flash on a page that matches the OS. Every colour
 * resolves through a token, and every token pair the widget prints text with
 * passes WCAG AA in both themes (src/__tests__/styles.test.ts).
 *
 * THE ACCENT IS THE HOST'S. A company's own brand colour is shown only as a
 * swatch or in the settings preview, never as the widget's accent: an owner
 * who picks a pale yellow must not make their own team page unreadable.
 */

const STYLE_ID = "aitw-styles";

/** The light tokens: the names a buyer can override, without the `--aitw-` prefix. */
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
  // Behind a dialog, and a dialog's own lift (scheduling-widget's two extras).
  scrim: "rgb(8 14 20 / 0.45)",
  "shadow-lg": "0 20px 50px -12px rgb(15 40 70 / 0.45)",
  // `inherit` on a custom property pulls the host's own --aitw-font if it set
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
 * so a palette change that breaks one fails CI instead of shipping.
 */
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
  ["ink", "accent-soft", 4.5],
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

export { contrastRatio };

/** `--aitw-name: value;` for every token. */
export function declareTokens(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `--aitw-${name}: ${value};`)
    .join(" ");
}

const CSS_TEXT = `
:where(.aitw-root) { ${declareTokens(LIGHT_TOKENS)} }
@media (prefers-color-scheme: dark) {
  :where(.aitw-root:not([data-theme="light"])) { ${declareTokens(DARK_TOKENS)} }
}
:where(.aitw-root[data-theme="dark"]) { ${declareTokens(DARK_TOKENS)} }

.aitw-root {
  position: relative; box-sizing: border-box; max-width: 100%; text-align: left;
  color: var(--aitw-ink); font-family: var(--aitw-font); font-size: 15px; line-height: 1.5;
  -webkit-text-size-adjust: 100%; color-scheme: light;
}
.aitw-root[data-theme="dark"] { color-scheme: dark; }
@media (prefers-color-scheme: dark) { .aitw-root:not([data-theme="light"]) { color-scheme: dark; } }
.aitw-root *, .aitw-root *::before, .aitw-root *::after { box-sizing: border-box; }
.aitw-root :where(h2, h3, h4, p, ul, ol, dl, dd, fieldset, legend, figure) { margin: 0; padding: 0; }
.aitw-root :where(button, input, select, textarea) { font: inherit; color: inherit; letter-spacing: inherit; }
.aitw-root :where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: 2px solid var(--aitw-focus); outline-offset: 2px;
}
.aitw-root [tabindex="-1"]:focus { outline: none; }
/* Focus moves to a section's heading on a deep link, which scrolls it into
   view; keep it clear of a host's sticky header (set --aitw-scroll-margin). */
.aitw-root [tabindex="-1"], .aitw-root section[id] { scroll-margin-top: var(--aitw-scroll-margin, 96px); }
.aitw-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0;
}
.aitw-root a:not(.aitw-btn):not(.aitw-menu-item) { color: var(--aitw-accent); font-weight: 600; text-underline-offset: 3px; }

/* A card. The root itself has no chrome, so the header switcher can sit in a nav bar. */
.aitw-panel {
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; padding: 20px; min-width: 0;
  background: var(--aitw-surface); color: var(--aitw-ink);
  border: 1px solid var(--aitw-line); border-radius: var(--aitw-radius); box-shadow: var(--aitw-shadow);
}
@media (max-width: 480px) { .aitw-panel { padding: 16px; gap: 16px; } }
.aitw-page { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
.aitw-stack { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; min-width: 0; }
.aitw-stack-sm { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; min-width: 0; }
.aitw-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
.aitw-grow { flex: 1 1 auto; min-width: 0; }
.aitw-head { display: grid; gap: 4px; }
.aitw-title { font-size: 19px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.3; color: var(--aitw-ink); overflow-wrap: anywhere; }
.aitw-h3 { font-size: 16px; font-weight: 700; color: var(--aitw-ink); overflow-wrap: anywhere; }
.aitw-sub { color: var(--aitw-muted); font-size: 14.5px; overflow-wrap: anywhere; }
.aitw-muted { color: var(--aitw-muted); }
.aitw-small { font-size: 13.5px; }
.aitw-ok-text { color: var(--aitw-ok); font-weight: 600; font-size: 14px; }
.aitw-danger-text { color: var(--aitw-danger); font-weight: 600; font-size: 14px; }
.aitw-dirty { color: var(--aitw-warn); font-weight: 600; font-size: 13.5px; }
.aitw-plain-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; overflow-wrap: anywhere; }
/* What isn't saved yet, kept in view at the bottom of the screen (review R2 T1BO-08). */
.aitw-unsaved-bar {
  position: sticky; bottom: 12px; z-index: 5; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px;
  padding: 12px 16px; border-radius: var(--aitw-radius-sm); border: 1px solid var(--aitw-line);
  background: var(--aitw-warn-soft); color: var(--aitw-warn); font-weight: 600; font-size: 14.5px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
}
.aitw-divider { border: 0; border-top: 1px solid var(--aitw-line); margin: 0; }

/* Buttons: 44px tall everywhere, so a thumb always finds them. */
.aitw-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 44px; min-width: 44px; padding: 10px 18px; border-radius: var(--aitw-radius-sm);
  border: 1px solid transparent; font-weight: 600; font-size: 15px; line-height: 1.2;
  cursor: pointer; text-decoration: none; text-align: center; background: transparent; color: var(--aitw-ink);
}
.aitw-btn-primary { background: var(--aitw-accent); color: var(--aitw-on-accent); }
.aitw-btn-primary:hover:not(:disabled) { background: var(--aitw-accent-strong); }
.aitw-btn-secondary { background: var(--aitw-surface); color: var(--aitw-ink); border-color: var(--aitw-line-strong); }
.aitw-btn-secondary:hover:not(:disabled) { background: var(--aitw-ground); border-color: var(--aitw-accent); }
.aitw-btn-danger { background: var(--aitw-danger); color: var(--aitw-on-danger); }
.aitw-btn-danger-outline { background: var(--aitw-surface); color: var(--aitw-danger); border-color: var(--aitw-line-strong); }
.aitw-btn-danger-outline:hover:not(:disabled) { border-color: var(--aitw-danger); background: var(--aitw-danger-soft); }
.aitw-btn-link {
  background: transparent; color: var(--aitw-accent); padding: 8px 4px; min-height: 44px;
  text-decoration: underline; text-underline-offset: 3px;
}
.aitw-btn-sm { padding: 8px 12px; font-size: 14px; }
.aitw-btn-block { width: 100%; }
.aitw-btn:disabled, .aitw-btn[aria-disabled="true"] { opacity: .55; cursor: not-allowed; }
.aitw-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

/* Form */
.aitw-form { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
.aitw-fields { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
@media (min-width: 640px) {
  .aitw-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .aitw-fields > .aitw-field:not([data-width="half"]) { grid-column: 1 / -1; }
}
.aitw-field { display: grid; gap: 6px; align-content: start; min-width: 0; }
.aitw-label { font-size: 14px; font-weight: 600; color: var(--aitw-ink); }
.aitw-input {
  width: 100%; min-height: 44px; padding: 10px 12px;
  /* 16px: anything smaller makes iOS Safari zoom the page on focus. */
  font-size: 16px; border: 1px solid var(--aitw-line-strong); border-radius: var(--aitw-radius-sm);
  background: var(--aitw-surface); color: var(--aitw-ink);
}
.aitw-input::placeholder { color: var(--aitw-faint); }
.aitw-input[readonly], .aitw-input:disabled { background: var(--aitw-ground); color: var(--aitw-muted); }
.aitw-input[aria-invalid="true"] { border-color: var(--aitw-danger); box-shadow: inset 0 0 0 1px var(--aitw-danger); }
textarea.aitw-input { min-height: 92px; resize: vertical; }
.aitw-hint { font-size: 13px; color: var(--aitw-muted); overflow-wrap: anywhere; }
.aitw-field-error { font-size: 13px; color: var(--aitw-danger); font-weight: 600; }
.aitw-check { display: flex; align-items: flex-start; gap: 10px; min-height: 44px; padding: 10px 0; cursor: pointer; }
.aitw-check input { flex: none; width: 20px; height: 20px; margin: 1px 0 0; accent-color: var(--aitw-accent); }

/* Notices and status lines */
.aitw-notice { padding: 11px 14px; border-radius: var(--aitw-radius-sm); font-size: 14px; border: 1px solid transparent; overflow-wrap: anywhere; }
.aitw-notice-warn { background: var(--aitw-warn-soft); color: var(--aitw-warn); }
.aitw-notice-error { background: var(--aitw-danger-soft); color: var(--aitw-danger); }
.aitw-notice-ok { background: var(--aitw-ok-soft); color: var(--aitw-ok); }
.aitw-notice-info { background: var(--aitw-ground); color: var(--aitw-muted); border-color: var(--aitw-line); }
.aitw-notice a, .aitw-notice .aitw-btn-link { color: inherit; font-weight: 700; }
.aitw-status:empty { display: none; }
.aitw-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 24px 0; color: var(--aitw-muted); }
.aitw-spinner {
  width: 20px; height: 20px; border-radius: 50%; flex: none;
  border: 2px solid var(--aitw-line); border-top-color: var(--aitw-accent);
  animation: aitw-spin .8s linear infinite;
}
@keyframes aitw-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .aitw-spinner { animation-duration: 2.4s; }
  .aitw-root * { transition: none !important; scroll-behavior: auto !important; }
}

/* Tags and badges: the words carry the meaning; colour only repeats it. */
.aitw-tag {
  display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px;
  font-size: 12.5px; font-weight: 700; letter-spacing: .02em; white-space: nowrap;
  background: var(--aitw-ground); color: var(--aitw-muted); border: 1px solid var(--aitw-line);
}
.aitw-tag svg { width: 13px; height: 13px; flex: none; }
.aitw-tag-ok { background: var(--aitw-ok-soft); color: var(--aitw-ok); border-color: transparent; }
.aitw-tag-warn { background: var(--aitw-warn-soft); color: var(--aitw-warn); border-color: transparent; }
.aitw-tag-danger { background: var(--aitw-danger-soft); color: var(--aitw-danger); border-color: transparent; }
.aitw-tag-accent { background: var(--aitw-accent-soft); color: var(--aitw-accent); border-color: transparent; }

/* A link to copy */
.aitw-copy { padding: 12px 14px; border-radius: var(--aitw-radius-sm); background: var(--aitw-ground); border: 1px solid var(--aitw-line); }
.aitw-copy-row { display: flex; flex-wrap: wrap; gap: 8px; }
.aitw-copy-input { flex: 1 1 220px; min-width: 0; text-overflow: ellipsis; }

/* Dialogs: rendered in place (they inherit the tokens), fixed so nothing clips them. */
.aitw-backdrop { position: fixed; inset: 0; z-index: 2147483000; background: var(--aitw-scrim); display: flex; align-items: center; justify-content: center; padding: 16px; }
.aitw-dialog {
  position: relative; display: grid; grid-template-rows: auto minmax(0, 1fr); max-height: calc(100vh - 32px); width: min(520px, 100%);
  background: var(--aitw-surface); color: var(--aitw-ink); border: 1px solid var(--aitw-line); border-radius: var(--aitw-radius);
  box-shadow: var(--aitw-shadow-lg); text-align: left;
}
.aitw-dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--aitw-line); }
.aitw-dialog-title { font-size: 17px; font-weight: 700; line-height: 1.3; color: var(--aitw-ink); overflow-wrap: anywhere; padding-top: 10px; }
.aitw-dialog-body { overflow-y: auto; padding: 16px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-content: start; }
.aitw-dialog-close {
  min-width: 44px; min-height: 44px; padding: 8px; display: inline-flex; align-items: center; justify-content: center; flex: none;
  border: 1px solid var(--aitw-line-strong); border-radius: var(--aitw-radius-sm); background: var(--aitw-surface); color: var(--aitw-ink); cursor: pointer;
}
.aitw-dialog-close svg { width: 18px; height: 18px; }
.aitw-dialog-actions { display: flex; flex-wrap: wrap-reverse; justify-content: flex-end; gap: 8px; }

/* Onboarding */
.aitw-onboard { max-width: 560px; }
.aitw-address { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-height: 44px; }
.aitw-address-text { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; min-width: 0; }
.aitw-address-text strong { color: var(--aitw-ink); font-weight: 700; }
.aitw-address-prefix { color: var(--aitw-muted); }
.aitw-slug-row { display: flex; align-items: stretch; min-width: 0; }
.aitw-slug-prefix {
  display: inline-flex; align-items: center; padding: 0 10px; max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  border: 1px solid var(--aitw-line-strong); border-right: 0; border-radius: var(--aitw-radius-sm) 0 0 var(--aitw-radius-sm);
  background: var(--aitw-ground); color: var(--aitw-muted); font-size: 14px;
}
.aitw-slug-row .aitw-input { border-radius: 0 var(--aitw-radius-sm) var(--aitw-radius-sm) 0; min-width: 0; }
.aitw-availability { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 14px; min-height: 24px; }
.aitw-availability svg { width: 16px; height: 16px; flex: none; }
.aitw-invites { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.aitw-invite-card { display: grid; gap: 10px; padding: 14px; border: 1px solid var(--aitw-line); border-radius: var(--aitw-radius-sm); background: var(--aitw-ground); }
.aitw-or { display: flex; align-items: center; gap: 12px; color: var(--aitw-muted); font-weight: 600; font-size: 14px; }
.aitw-or::before, .aitw-or::after { content: ""; flex: 1 1 auto; border-top: 1px solid var(--aitw-line); }

/* The header switcher: no card, just a button and its menu.
   It sits in a host's header ROW, so the root must be allowed to SHRINK there
   (review T1-05): as a flex item an element sizes to its content unless it has
   min-width 0, and a long company name pushed the account button off a 360px
   phone. Below 420px the name is capped at 42% of the screen; below 340px only
   the mark and the chevron show (the button's accessible name still says it). */
.aitw-root[data-aitw-switcher] { display: inline-block; flex: 0 1 auto; min-width: 0; max-width: 100%; vertical-align: middle; }
.aitw-switcher { position: relative; display: inline-block; min-width: 0; max-width: 100%; }
.aitw-switcher-btn {
  display: inline-flex; align-items: center; gap: 8px; min-height: 44px; min-width: 44px; max-width: min(100%, 300px); padding: 6px 10px; cursor: pointer;
  flex: 0 1 auto; border: 1px solid var(--aitw-line-strong); border-radius: var(--aitw-radius-sm); background: var(--aitw-surface); color: var(--aitw-ink); font-weight: 600;
}
@media (max-width: 420px) { .aitw-switcher-btn { max-width: min(100%, 42vw); } }
@media (max-width: 340px) {
  .aitw-switcher-name { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
}
.aitw-switcher-btn:hover { border-color: var(--aitw-accent); }
.aitw-switcher-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aitw-switcher-btn svg { width: 16px; height: 16px; flex: none; }
.aitw-logo-sm { width: 24px; height: 24px; flex: none; border-radius: 6px; object-fit: contain; background: var(--aitw-surface); }
.aitw-initials {
  width: 24px; height: 24px; flex: none; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center;
  background: var(--aitw-accent-soft); color: var(--aitw-accent); font-size: 11.5px; font-weight: 800; letter-spacing: .02em;
}
.aitw-menu {
  position: absolute; z-index: 2147482000; top: calc(100% + 6px); left: 0; min-width: 240px; max-width: min(340px, calc(100vw - 32px));
  padding: 6px; display: grid; gap: 2px; background: var(--aitw-surface); color: var(--aitw-ink);
  border: 1px solid var(--aitw-line); border-radius: var(--aitw-radius-sm); box-shadow: var(--aitw-shadow-lg);
}
.aitw-menu[data-align="end"] { left: auto; right: 0; }
.aitw-menu-item {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 44px; padding: 8px 10px; text-align: left; cursor: pointer;
  border: 0; border-radius: 8px; background: transparent; color: var(--aitw-ink); text-decoration: none; font-weight: 600; font-size: 14.5px;
}
.aitw-menu-item:hover, .aitw-menu-item:focus-visible { background: var(--aitw-ground); }
.aitw-menu-item[aria-checked="true"] { background: var(--aitw-accent-soft); }
.aitw-menu-item:focus-visible { outline: 2px solid var(--aitw-focus); outline-offset: -2px; }
.aitw-menu-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aitw-menu-check { width: 18px; height: 18px; flex: none; color: var(--aitw-accent); }
.aitw-menu-sep { height: 0; border: 0; border-top: 1px solid var(--aitw-line); margin: 4px 0; }
.aitw-menu-status { padding: 6px 10px; font-size: 13.5px; color: var(--aitw-danger); font-weight: 600; }

/* The setup checklist */
.aitw-progress-row { display: grid; gap: 6px; }
.aitw-progress { width: 100%; height: 8px; accent-color: var(--aitw-accent); appearance: none; -webkit-appearance: none; border: 0; border-radius: 999px; background: var(--aitw-line); overflow: hidden; }
.aitw-progress::-webkit-progress-bar { background: var(--aitw-line); border-radius: 999px; }
.aitw-progress::-webkit-progress-value { background: var(--aitw-accent); border-radius: 999px; }
.aitw-progress::-moz-progress-bar { background: var(--aitw-accent); border-radius: 999px; }
.aitw-items { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.aitw-item {
  display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 4px 12px; padding: 12px 14px;
  border: 1px solid var(--aitw-line); border-radius: var(--aitw-radius-sm); background: var(--aitw-surface);
}
.aitw-item[data-done] { background: var(--aitw-ground); }
.aitw-item-icon { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; color: var(--aitw-muted); }
.aitw-item-icon svg { width: 22px; height: 22px; }
.aitw-item[data-done] .aitw-item-icon { color: var(--aitw-ok); }
.aitw-item-main { display: grid; gap: 4px; min-width: 0; }
.aitw-item-title { font-weight: 700; overflow-wrap: anywhere; }
.aitw-item[data-dismissed] .aitw-item-title { text-decoration: line-through; color: var(--aitw-muted); }
.aitw-item-desc { font-size: 14px; color: var(--aitw-muted); }
.aitw-item-actions { grid-column: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
/* The dashboard's compact checklist: what's left, tight; what's done, folded. */
.aitw-checklist-compact .aitw-items { gap: 8px; }
.aitw-checklist-compact .aitw-item { padding: 10px 12px; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; }
.aitw-checklist-compact .aitw-item-actions { grid-column: 3; grid-row: 1; justify-content: flex-end; }
@media (max-width: 560px) { .aitw-checklist-compact .aitw-item { grid-template-columns: 24px minmax(0, 1fr); } .aitw-checklist-compact .aitw-item-actions { grid-column: 2; grid-row: auto; justify-content: flex-start; } }
.aitw-checklist-compact .aitw-item-icon { width: 24px; height: 24px; }
.aitw-folded { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 4px; }
.aitw-folded li { display: flex; align-items: center; gap: 10px; color: var(--aitw-muted); font-size: 14px; }
.aitw-folded li[data-done] .aitw-item-icon { color: var(--aitw-ok); }
.aitw-folded .aitw-item-icon { width: 22px; height: 22px; }
.aitw-folded .aitw-item-icon svg { width: 18px; height: 18px; }
.aitw-folded-title { flex: 1 1 auto; min-width: 0; }
.aitw-root details > summary { min-height: 44px; min-width: 44px; padding: 0 8px; display: inline-flex; align-items: center; cursor: pointer; font-weight: 600; color: var(--aitw-muted); }

/* Tables: a real table from 640px, label-and-value cards below it. */
.aitw-table { width: 100%; border-collapse: collapse; font-size: 14.5px; }
.aitw-table th { text-align: left; font-size: 12.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--aitw-muted); padding: 8px 10px; border-bottom: 1px solid var(--aitw-line); }
.aitw-table td { padding: 10px; border-bottom: 1px solid var(--aitw-line); vertical-align: middle; overflow-wrap: anywhere; }
.aitw-table tr[data-busy] td { opacity: .6; }
.aitw-cell-main { display: grid; gap: 2px; min-width: 0; }
.aitw-cell-sub { font-size: 13.5px; color: var(--aitw-muted); overflow-wrap: anywhere; }
@media (max-width: 639.98px) {
  .aitw-table[data-stack="640"] thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); }
  .aitw-table[data-stack="640"], .aitw-table[data-stack="640"] tbody { display: grid; gap: 10px; }
  .aitw-table[data-stack="640"] tr { display: grid; gap: 8px; padding: 12px 14px; border: 1px solid var(--aitw-line); border-radius: var(--aitw-radius-sm); background: var(--aitw-surface); }
  .aitw-table[data-stack="640"] td { display: grid; grid-template-columns: minmax(84px, 30%) minmax(0, 1fr); gap: 8px; align-items: center; padding: 0; border: 0; }
  .aitw-table[data-stack="640"] td::before { content: attr(data-label); font-size: 12.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--aitw-muted); }
  .aitw-table[data-stack="640"] td[data-label=""] { grid-template-columns: minmax(0, 1fr); }
  .aitw-table[data-stack="640"] td[data-label=""]::before { display: none; }
}

/* Company settings */
.aitw-logo-row { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; }
.aitw-logo-preview {
  width: 88px; height: 88px; flex: none; display: flex; align-items: center; justify-content: center; overflow: hidden;
  border: 1px solid var(--aitw-line); border-radius: var(--aitw-radius-sm); background: var(--aitw-ground); color: var(--aitw-muted); font-size: 12.5px; text-align: center; padding: 6px;
}
.aitw-logo-preview img { max-width: 100%; max-height: 100%; object-fit: contain; }
.aitw-file { position: relative; display: inline-flex; }
.aitw-file input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.aitw-file input:disabled { cursor: not-allowed; }
.aitw-file:focus-within .aitw-btn { outline: 2px solid var(--aitw-focus); outline-offset: 2px; }
.aitw-colour-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.aitw-colour-picker { width: 52px; height: 44px; flex: none; padding: 2px; border: 1px solid var(--aitw-line-strong); border-radius: var(--aitw-radius-sm); background: var(--aitw-surface); cursor: pointer; }
.aitw-colour-row .aitw-input { width: 9em; flex: 0 1 auto; font-variant-numeric: tabular-nums; }
.aitw-swatch { display: inline-block; width: 16px; height: 16px; border-radius: 4px; border: 1px solid var(--aitw-line-strong); flex: none; vertical-align: middle; }
.aitw-preview { display: grid; gap: 10px; padding: 14px; border: 1px solid var(--aitw-line); border-radius: var(--aitw-radius-sm); background: var(--aitw-ground); }
.aitw-preview-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.aitw-sample-btn { display: inline-flex; align-items: center; min-height: 44px; padding: 10px 18px; border-radius: var(--aitw-radius-sm); font-weight: 700; border: 1px solid transparent; }
.aitw-sample-page { padding: 10px 14px; border-radius: var(--aitw-radius-sm); border: 1px solid var(--aitw-line); font-weight: 700; text-decoration: underline; text-underline-offset: 3px; }

/* The suspended screen and the invitation page */
.aitw-centre { max-width: 560px; }
.aitw-badge-icon {
  width: 44px; height: 44px; flex: none; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  background: var(--aitw-warn-soft); color: var(--aitw-warn);
}
.aitw-badge-icon svg { width: 22px; height: 22px; }
.aitw-badge-icon[data-tone="ok"] { background: var(--aitw-ok-soft); color: var(--aitw-ok); }
.aitw-switch-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }

/* A company's public face (Tenancy 2a): the brand bar and the closed panel.
   Here the company's colour is the point, so it's used as given; its text
   colour is the one the server worked out for it (white or near-black). */
.aitw-brandbar {
  display: flex; align-items: center; gap: 12px; min-width: 0; padding: 12px 0;
  border-bottom: 3px solid transparent; color: var(--aitw-ink);
}
.aitw-brandbar[data-brand] { border-bottom-color: var(--aitw-brand); }
.aitw-brandbar-logo { display: block; max-height: 40px; max-width: 160px; width: auto; height: auto; flex: none; object-fit: contain; }
.aitw-brandbar-initials {
  width: 40px; height: 40px; flex: none; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center;
  background: var(--aitw-accent-soft); color: var(--aitw-accent); font-size: 19px; line-height: 1; font-weight: 800; letter-spacing: .02em;
}
.aitw-brandbar-initials[data-brand] { background: var(--aitw-brand); color: var(--aitw-on-brand); }
.aitw-brandbar-text { display: grid; gap: 2px; min-width: 0; }
.aitw-brandbar-name { font-size: 18px; font-weight: 700; color: var(--aitw-ink); text-decoration: none; overflow-wrap: anywhere; }
a.aitw-brandbar-name:hover { text-decoration: underline; text-underline-offset: 3px; }
a.aitw-brandbar-name:focus-visible, .aitw-contact a:focus-visible { outline: 2px solid var(--aitw-focus); outline-offset: 2px; border-radius: 2px; }
.aitw-contact { margin: 0; display: flex; flex-wrap: wrap; gap: 2px 12px; color: var(--aitw-muted); font-size: 14.5px; }
.aitw-contact a { color: var(--aitw-accent); overflow-wrap: anywhere; }
.aitw-contact-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.aitw-contact-list a { color: var(--aitw-accent); font-weight: 600; overflow-wrap: anywhere; }
`;

export interface InjectStylesOptions {
  /** A CSP nonce, set on the created <style> element. */
  nonce?: string;
}

/** Add `<style id="aitw-styles">` once. A tag that already exists is never duplicated. */
export function injectTenancyStyles(options: InjectStylesOptions = {}): void {
  injectStyleTag(STYLE_ID, CSS_TEXT, options.nonce);
}

/** The stylesheet text, for a host that renders it itself (SSR, a shadow root). */
export function tenancyWidgetCss(): string {
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
