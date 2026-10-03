/**
 * The widget's entire appearance, injected once as a <style> tag. Every rule is
 * prefixed `aibk-`, so the host app's CSS cannot reach in by accident and the
 * widget cannot leak out. No Tailwind, no CSS import step for the buyer: React
 * is the only peer, and this is what that costs.
 *
 * THEMING. The palette is AdminIgloo's "Ink & Snow" (white surfaces, near-ink
 * text, glacial teal accent; a cool dark ground at night), carried as
 * `--aibk-*` custom properties. The defaults are declared under `:where()`,
 * i.e. at ZERO specificity, so a buyer re-themes with one ordinary rule —
 * `.aibk-root { --aibk-accent: #7c3aed }` — whatever order the stylesheets
 * load in. The component rules themselves stay at class specificity, so a
 * host's element rules (Tailwind preflight's `button { background: transparent }`)
 * still cannot restyle the widget.
 *
 * Dark follows `prefers-color-scheme`, like the feedback widget, and a host
 * with its own theme switch can pin either with `theme="light" | "dark"`
 * (rendered as `data-theme`). Every colour below resolves through a token: one
 * bare hex is a rule nobody re-tests in the other theme.
 */

const STYLE_ID = "aibk-styles";

/** The light tokens, and the names a buyer can override. */
export const LIGHT_TOKENS: Record<string, string> = {
  ground: "#f4f7fa",
  surface: "#ffffff",
  ink: "#0a1520",
  muted: "#3e4b57",
  faint: "#5b6977",
  line: "#d2dbe3",
  "line-strong": "#b4c1cc",
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
};

export const DARK_TOKENS: Record<string, string> = {
  ground: "#0b0f13",
  surface: "#141b22",
  ink: "#e8edf1",
  muted: "#93a2ae",
  faint: "#808e9a",
  line: "#26313a",
  "line-strong": "#3a4752",
  accent: "#45c4ad",
  "accent-strong": "#6cd6c3",
  "accent-soft": "#113029",
  "on-accent": "#0b0f13",
  ok: "#56c586",
  "ok-soft": "#10301d",
  warn: "#cfa14e",
  "warn-soft": "#32270f",
  danger: "#e08272",
  "danger-soft": "#391712",
  "on-danger": "#0b0f13",
  focus: "#45c4ad",
  shadow: "0 1px 2px rgb(0 0 0 / 0.45), 0 0 0 1px rgb(255 255 255 / 0.03)",
};

function declare(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `--aibk-${name}: ${value};`)
    .join(" ");
}

const CSS_TEXT = `
:where(.aibk-root) { ${declare(LIGHT_TOKENS)} }
@media (prefers-color-scheme: dark) {
  :where(.aibk-root:not([data-theme="light"])) { ${declare(DARK_TOKENS)} }
}
:where(.aibk-root[data-theme="dark"]) { ${declare(DARK_TOKENS)} }

.aibk-root {
  position: relative; box-sizing: border-box; width: 100%; max-width: 100%;
  background: var(--aibk-surface); color: var(--aibk-ink);
  border: 1px solid var(--aibk-line); border-radius: var(--aibk-radius);
  box-shadow: var(--aibk-shadow); overflow: hidden; text-align: left;
  /* Unset unless the buyer sets it: font-family then inherits the host's. */
  font-family: var(--aibk-font); font-size: 15px; line-height: 1.5;
  -webkit-text-size-adjust: 100%;
}
.aibk-root *, .aibk-root *::before, .aibk-root *::after { box-sizing: border-box; }
.aibk-root :where(h2, h3, h4, p, ul, ol, dl, dd, fieldset, legend, figure) { margin: 0; padding: 0; }
.aibk-root :where(button, input, select, textarea) { font: inherit; color: inherit; letter-spacing: inherit; }
.aibk-root :where(a, button, input, select, textarea, [tabindex]):focus-visible {
  outline: 2px solid var(--aibk-focus); outline-offset: 2px;
}
.aibk-root [tabindex="-1"]:focus { outline: none; }
/* Focus moves to each step's heading, which scrolls it into view — under a
   host's sticky header, unless it keeps a margin. Not declared on the root,
   so a host can set --aibk-scroll-margin once on :root (its header height). */
.aibk-root [tabindex="-1"] { scroll-margin-top: var(--aibk-scroll-margin, 96px); }
.aibk-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0;
}

/* Sandbox banner — persistent, at the very top, and impossible to mistake for
   the real thing. */
.aibk-sandbox {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px;
  padding: 10px 20px; background: var(--aibk-warn-soft); color: var(--aibk-warn);
  border-bottom: 1px solid var(--aibk-line); font-size: 14px;
}
.aibk-sandbox-text { flex: 1 1 240px; }
.aibk-sandbox-text strong { font-weight: 700; }
.aibk-root a:not(.aibk-btn) { color: var(--aibk-accent); font-weight: 600; text-underline-offset: 3px; }
.aibk-root .aibk-sandbox a { color: inherit; font-weight: 700; }

/* minmax(0, 1fr) everywhere a grid holds the date strip: a grid track's
   default minimum is its content's min-content width, and a strip of thirty
   day tiles would widen the whole card past the viewport (then get clipped by
   the card's overflow) instead of scrolling inside itself. */
.aibk-body { padding: 20px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
@media (max-width: 480px) { .aibk-body { padding: 16px; gap: 16px; } .aibk-sandbox { padding: 10px 16px; } }

.aibk-head { display: grid; gap: 4px; }
.aibk-title { font-size: 19px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.3; color: var(--aibk-ink); }
/* overflow-wrap: a long email address is one unbreakable "word" otherwise. */
.aibk-sub { color: var(--aibk-muted); font-size: 14.5px; overflow-wrap: anywhere; }
.aibk-section { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; min-width: 0; }
.aibk-section-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 12px; }
.aibk-h3 { font-size: 15px; font-weight: 700; color: var(--aibk-ink); }

/* Type picker */
.aibk-types { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; }
.aibk-type {
  display: grid; gap: 2px; text-align: left; min-height: 44px; cursor: pointer;
  padding: 12px 14px; border: 1px solid var(--aibk-line); border-radius: var(--aibk-radius-sm);
  background: var(--aibk-surface); color: var(--aibk-ink);
  transition: border-color .12s ease, background .12s ease;
}
.aibk-type:hover { border-color: var(--aibk-accent); }
.aibk-type[aria-pressed="true"] { border-color: var(--aibk-accent); background: var(--aibk-accent-soft); box-shadow: inset 0 0 0 1px var(--aibk-accent); }
.aibk-type-name { font-weight: 700; display: flex; justify-content: space-between; gap: 8px; }
.aibk-type-len { font-weight: 500; font-size: 13px; color: var(--aibk-muted); white-space: nowrap; }
.aibk-type-desc { font-size: 13.5px; color: var(--aibk-muted); }

/* Time zone */
.aibk-zone { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: 13.5px; color: var(--aibk-muted); }
.aibk-zone-now { font-weight: 600; color: var(--aibk-ink); }
.aibk-select {
  min-height: 40px; max-width: 100%; padding: 6px 10px; font-size: 14px;
  border: 1px solid var(--aibk-line-strong); border-radius: 8px;
  background: var(--aibk-surface); color: var(--aibk-ink);
}

/* Date strip. The ‹ › buttons only exist when the tiles overflow
   ([data-overflow]); they flank the strip, and on a phone sit in a row above
   it so the strip keeps the full width for tiles. */
.aibk-days-wrap {
  position: relative; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr);
  grid-template-areas: "days"; gap: 6px;
}
.aibk-days-wrap[data-overflow] { grid-template-columns: 44px minmax(0, 1fr) 44px; grid-template-areas: "prev days next"; }
.aibk-days-step { display: none; }
.aibk-days-wrap[data-overflow] .aibk-days-step {
  display: inline-flex; align-items: center; justify-content: center; align-self: start;
  width: 44px; height: 68px; margin-top: 2px; padding: 0; cursor: pointer;
  border: 1px solid var(--aibk-line-strong); border-radius: var(--aibk-radius-sm);
  background: var(--aibk-surface); color: var(--aibk-ink);
  transition: border-color .12s ease, color .12s ease;
}
.aibk-days-step:hover:not(:disabled) { border-color: var(--aibk-accent); color: var(--aibk-accent); }
.aibk-days-step:disabled { opacity: .4; cursor: default; }
.aibk-days-prev { grid-area: prev; }
.aibk-days-next { grid-area: next; }
@media (max-width: 480px) {
  .aibk-days-wrap[data-overflow] { grid-template-columns: minmax(0, 1fr) 44px 44px; grid-template-areas: ". prev next" "days days days"; }
  .aibk-days-wrap[data-overflow] .aibk-days-step { height: 44px; margin-top: 0; }
}
/* position: relative makes the list its tiles' offsetParent, so a tile's
   offsetLeft is measured in the list's own scrolled content. */
.aibk-days {
  grid-area: days; position: relative;
  display: flex; gap: 8px; overflow-x: auto; padding: 2px 2px 8px; margin: 0; list-style: none;
  /* scroll-padding matches the side padding, so the first tile snaps to
     scrollLeft 0 (not 2) and the strip reads as "at the start". */
  scroll-snap-type: x proximity; scroll-padding-inline: 2px; -webkit-overflow-scrolling: touch; scrollbar-width: thin;
}
.aibk-days > li { flex: 0 0 auto; scroll-snap-align: start; }
/* position: relative so each tile is the containing block of its sr-only
   label. Without it those absolutely positioned labels belong to .aibk-root,
   escape the strip's scroll container, and stretch the card's scroll width by
   however far the strip runs off-screen. */
.aibk-day {
  position: relative; width: 64px; min-height: 68px; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 1px; padding: 6px 4px; cursor: pointer;
  border: 1px solid var(--aibk-line); border-radius: var(--aibk-radius-sm);
  background: var(--aibk-surface); color: var(--aibk-ink);
  transition: border-color .12s ease, background .12s ease;
}
.aibk-day:hover:not(:disabled) { border-color: var(--aibk-accent); }
.aibk-day-wd { font-size: 11.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--aibk-muted); }
.aibk-day-n { font-size: 19px; font-weight: 700; line-height: 1.2; }
.aibk-day-m { font-size: 11.5px; color: var(--aibk-faint); }
.aibk-day:disabled { cursor: default; background: var(--aibk-ground); border-color: transparent; opacity: .5; }
.aibk-day:disabled .aibk-day-n { font-weight: 500; }
.aibk-day[aria-pressed="true"] { background: var(--aibk-accent); border-color: var(--aibk-accent); color: var(--aibk-on-accent); }
.aibk-day[aria-pressed="true"] .aibk-day-wd,
.aibk-day[aria-pressed="true"] .aibk-day-m { color: var(--aibk-on-accent); }

/* Times */
.aibk-group { display: grid; gap: 8px; }
.aibk-group-label { font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--aibk-muted); }
.aibk-times { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 8px; margin: 0; padding: 0; list-style: none; }
.aibk-time {
  width: 100%; min-height: 44px; padding: 8px 6px; cursor: pointer; font-weight: 600; font-size: 15px;
  border: 1px solid var(--aibk-line-strong); border-radius: var(--aibk-radius-sm);
  background: var(--aibk-surface); color: var(--aibk-accent);
  font-variant-numeric: tabular-nums; transition: border-color .12s ease, background .12s ease;
}
.aibk-time:hover:not(:disabled) { border-color: var(--aibk-accent); background: var(--aibk-accent-soft); }
.aibk-time[aria-pressed="true"] { background: var(--aibk-accent); border-color: var(--aibk-accent); color: var(--aibk-on-accent); }
.aibk-time:disabled { cursor: progress; opacity: .7; }

/* Tags and chips */
.aibk-tag {
  display: inline-flex; align-items: center; justify-self: start; padding: 2px 9px; border-radius: 999px;
  font-size: 11.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
  background: var(--aibk-warn-soft); color: var(--aibk-warn); white-space: nowrap;
}
.aibk-tag-ok { background: var(--aibk-ok-soft); color: var(--aibk-ok); }
.aibk-tag-danger { background: var(--aibk-danger-soft); color: var(--aibk-danger); }
.aibk-tag-muted { background: var(--aibk-ground); color: var(--aibk-muted); }

/* The picked time + hold countdown */
.aibk-picked {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 14px;
  padding: 12px 14px; border-radius: var(--aibk-radius-sm);
  background: var(--aibk-ground); border: 1px solid var(--aibk-line);
}
.aibk-picked-main { display: grid; gap: 2px; min-width: 0; }
.aibk-picked-when { font-weight: 700; }
.aibk-picked-meta { font-size: 13.5px; color: var(--aibk-muted); }
.aibk-timer { display: inline-flex; align-items: center; gap: 6px; font-size: 13.5px; color: var(--aibk-muted); }
.aibk-timer-n { font-weight: 700; color: var(--aibk-accent); font-variant-numeric: tabular-nums; }
.aibk-timer-low .aibk-timer-n { color: var(--aibk-warn); }

/* Buttons */
.aibk-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 44px; padding: 10px 18px; border-radius: var(--aibk-radius-sm);
  border: 1px solid transparent; font-weight: 600; font-size: 15px; line-height: 1.2;
  cursor: pointer; text-decoration: none; text-align: center;
  transition: background .12s ease, border-color .12s ease, color .12s ease;
}
.aibk-btn-primary { background: var(--aibk-accent); color: var(--aibk-on-accent); }
.aibk-btn-primary:hover:not(:disabled) { background: var(--aibk-accent-strong); }
.aibk-btn-secondary { background: var(--aibk-surface); color: var(--aibk-ink); border-color: var(--aibk-line-strong); }
.aibk-btn-secondary:hover:not(:disabled) { background: var(--aibk-ground); border-color: var(--aibk-accent); }
.aibk-btn-danger { background: var(--aibk-danger); color: var(--aibk-on-danger); }
.aibk-btn-link {
  background: transparent; color: var(--aibk-accent); padding: 8px 4px; min-height: 44px;
  text-decoration: underline; text-underline-offset: 3px;
}
.aibk-btn-block { width: 100%; }
.aibk-btn-cta { width: 100%; min-height: 52px; font-size: 16.5px; font-weight: 700; }
.aibk-btn:disabled { opacity: .55; cursor: not-allowed; }
.aibk-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.aibk-actions > .aibk-btn { flex: 1 1 180px; }

/* Form */
.aibk-form { display: grid; gap: 14px; }
.aibk-row2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
.aibk-field { display: grid; gap: 6px; align-content: start; }
.aibk-label { font-size: 14px; font-weight: 600; color: var(--aibk-ink); }
.aibk-optional { font-weight: 400; color: var(--aibk-faint); }
.aibk-input {
  width: 100%; min-height: 44px; padding: 10px 12px;
  /* 16px: anything smaller makes iOS Safari zoom the page on focus. */
  font-size: 16px; border: 1px solid var(--aibk-line-strong); border-radius: var(--aibk-radius-sm);
  background: var(--aibk-surface); color: var(--aibk-ink);
}
.aibk-input::placeholder { color: var(--aibk-faint); }
.aibk-input[aria-invalid="true"] { border-color: var(--aibk-danger); }
textarea.aibk-input { min-height: 92px; resize: vertical; }
.aibk-hint { font-size: 13px; color: var(--aibk-muted); }
.aibk-field-error { font-size: 13px; color: var(--aibk-danger); font-weight: 600; }
.aibk-media { display: grid; gap: 8px; border: 0; min-width: 0; }
.aibk-media > legend { margin-bottom: 8px; }
.aibk-medium {
  display: flex; align-items: flex-start; gap: 12px; min-height: 44px; padding: 12px 14px; cursor: pointer;
  border: 1px solid var(--aibk-line); border-radius: var(--aibk-radius-sm); background: var(--aibk-surface);
  transition: border-color .12s ease, background .12s ease;
}
.aibk-medium:hover { border-color: var(--aibk-accent); }
.aibk-medium.aibk-on { border-color: var(--aibk-accent); background: var(--aibk-accent-soft); }
.aibk-medium input { flex: none; width: 18px; height: 18px; margin: 2px 0 0; accent-color: var(--aibk-accent); }
.aibk-medium-text { display: grid; gap: 2px; }
.aibk-medium-title { font-weight: 600; }
.aibk-medium-blurb { font-size: 13.5px; color: var(--aibk-muted); }

/* Notices */
.aibk-notice { padding: 11px 14px; border-radius: var(--aibk-radius-sm); font-size: 14px; border: 1px solid transparent; }
.aibk-notice-warn { background: var(--aibk-warn-soft); color: var(--aibk-warn); }
.aibk-notice-error { background: var(--aibk-danger-soft); color: var(--aibk-danger); }
.aibk-notice-ok { background: var(--aibk-ok-soft); color: var(--aibk-ok); }
.aibk-notice-info { background: var(--aibk-ground); color: var(--aibk-muted); border-color: var(--aibk-line); }
.aibk-notice .aibk-btn-link { min-height: 0; padding: 0; color: inherit; font-weight: 700; }

/* Loading / empty */
.aibk-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 28px 0; color: var(--aibk-muted); }
.aibk-spinner {
  width: 20px; height: 20px; border-radius: 50%; flex: none;
  border: 2px solid var(--aibk-line); border-top-color: var(--aibk-accent);
  animation: aibk-spin .8s linear infinite;
}
@keyframes aibk-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .aibk-spinner { animation-duration: 2.4s; }
  .aibk-root * { transition: none !important; }
}
.aibk-empty { display: grid; gap: 8px; justify-items: center; text-align: center; padding: 24px 8px; color: var(--aibk-muted); }
.aibk-empty-title { font-weight: 700; color: var(--aibk-ink); }

/* Confirmation / manage summary */
.aibk-done { display: grid; gap: 16px; }
.aibk-done-head { display: flex; align-items: center; gap: 12px; }
.aibk-badge {
  width: 44px; height: 44px; flex: none; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  background: var(--aibk-ok-soft); color: var(--aibk-ok);
}
.aibk-badge svg { width: 22px; height: 22px; }
.aibk-badge-muted { background: var(--aibk-ground); color: var(--aibk-muted); }
.aibk-badge-warn { background: var(--aibk-warn-soft); color: var(--aibk-warn); }
.aibk-done-title { font-size: 21px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.3; color: var(--aibk-ink); }
.aibk-facts { display: grid; gap: 12px; }
.aibk-fact { display: grid; grid-template-columns: 116px minmax(0, 1fr); gap: 4px 12px; }
.aibk-fact dt { font-size: 13px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--aibk-muted); padding-top: 2px; }
.aibk-fact dd { overflow-wrap: anywhere; }
.aibk-fact a { color: var(--aibk-accent); font-weight: 600; text-underline-offset: 3px; }
@media (max-width: 480px) { .aibk-fact { grid-template-columns: 1fr; } }
.aibk-divider { border: 0; border-top: 1px solid var(--aibk-line); margin: 0; }

/* A private link to keep (no email will carry it): field + copy button. */
.aibk-copy { padding: 12px 14px; border-radius: var(--aibk-radius-sm); background: var(--aibk-ground); border: 1px solid var(--aibk-line); }
.aibk-copy-row { display: flex; flex-wrap: wrap; gap: 8px; }
.aibk-copy-input { flex: 1 1 220px; min-width: 0; text-overflow: ellipsis; }
.aibk-copy-row > .aibk-btn { flex: 0 0 auto; }

/* Sandbox confirmation */
.aibk-preview { display: grid; gap: 14px; padding: 16px; border: 1px dashed var(--aibk-line-strong); border-radius: var(--aibk-radius-sm); }
.aibk-preview-label { font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--aibk-warn); }
.aibk-real { display: grid; gap: 10px; padding: 16px; border-radius: var(--aibk-radius-sm); background: var(--aibk-ground); border: 1px solid var(--aibk-line); }
/* list-style restated: a host on Tailwind's preflight resets it to none. */
.aibk-list { display: grid; gap: 6px; padding-left: 20px; list-style: disc; }
.aibk-list li::marker { color: var(--aibk-accent); }

.aibk-foot { font-size: 12.5px; color: var(--aibk-faint); }
`;

export function injectStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS_TEXT;
  document.head.appendChild(style);
}

/** The stylesheet text, for a host that renders it itself (SSR, a shadow root). */
export function bookingWidgetCss(): string {
  return CSS_TEXT;
}
