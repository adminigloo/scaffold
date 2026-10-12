/**
 * The widget's whole appearance, injected once as a <style> tag. Every rule is
 * prefixed `aisw-`, so the host app's CSS can't reach in by accident and the
 * widget can't leak out. No Tailwind and no CSS import step for the buyer:
 * React is the only peer, and this is what that costs.
 *
 * THEMING (contract 8.2). The palette is AdminIgloo's "Ink & Snow" (the
 * booking widget's), carried as `--aisw-*` custom properties declared under
 * `:where()`, i.e. at ZERO specificity, so one ordinary rule —
 * `.aisw-root { --aisw-accent: #7c3aed }` — re-themes every component whatever
 * order the stylesheets load in. The component rules stay at class
 * specificity, so a host's element rules (Tailwind preflight's
 * `button { background: transparent }`) still can't restyle the widget.
 *
 * Dark comes from the `data-theme` the component writes once it has read the
 * host's theme (see ./theme.ts). Before hydration there is no `data-theme`, so
 * the media query decides — no flash on a page that matches the OS. Every
 * colour resolves through a token, and every token pair the widget prints text
 * with passes WCAG AA in both themes (src/__tests__/styles.test.ts).
 */

const STYLE_ID = "aisw-styles";

/** The light tokens: the names a buyer can override, without the `--aisw-` prefix. */
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
  // Calendar statuses: a request, a visit under way, a finished one, and the
  // grey of anything that no longer holds time.
  pending: "#875200",
  "pending-soft": "#fdf1dc",
  progress: "#1f5fa8",
  "progress-soft": "#e3eefb",
  done: "#2e6a43",
  "done-soft": "#e6f1ea",
  inactive: "#5b6977",
  // Crew colours: a stripe on each crew's column and visits, never the only signal.
  "crew-1": "#0d7a72",
  "crew-2": "#2a6bc0",
  "crew-3": "#8a46e6",
  "crew-4": "#c0501f",
  "crew-5": "#8a6d00",
  "crew-6": "#b0377e",
  "crew-7": "#4f5fc4",
  "crew-8": "#2f7f35",
  radius: "14px",
  "radius-sm": "10px",
  shadow: "0 1px 2px rgb(15 40 70 / 0.06), 0 6px 16px -6px rgb(15 40 70 / 0.14)",
  // Behind a dialog, and a dialog's own lift.
  scrim: "rgb(8 14 20 / 0.45)",
  "shadow-lg": "0 20px 50px -12px rgb(15 40 70 / 0.45)",
  // `inherit` on a custom property pulls the host's own --aisw-font if it set
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
  pending: "#e3b562",
  "pending-soft": "#33260c",
  progress: "#86b8f2",
  "progress-soft": "#12273f",
  done: "#79cf98",
  "done-soft": "#11301e",
  inactive: "#97a4b0",
  "crew-1": "#45c4ad",
  "crew-2": "#86b8f2",
  "crew-3": "#c39bff",
  "crew-4": "#f0946b",
  "crew-5": "#d9c060",
  "crew-6": "#ee8cc4",
  "crew-7": "#a3adf5",
  "crew-8": "#7fd17f",
  shadow: "0 1px 2px rgb(0 0 0 / 0.45), 0 0 0 1px rgb(255 255 255 / 0.03)",
  scrim: "rgb(0 0 0 / 0.6)",
  "shadow-lg": "0 20px 50px -12px rgb(0 0 0 / 0.7)",
};

/**
 * The colour pairs the widget actually prints, with the WCAG minimum each must
 * meet: 4.5:1 for text, 3:1 for a boundary or a stripe a person has to see
 * (input borders, the focus ring, crew colours). The contrast test runs every
 * pair in both themes, so a buyer-facing palette change that breaks one fails
 * CI instead of shipping.
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
  ["pending", "pending-soft", 4.5],
  ["pending", "surface", 4.5],
  ["ink", "pending-soft", 4.5],
  ["progress", "progress-soft", 4.5],
  ["progress", "surface", 4.5],
  ["ink", "progress-soft", 4.5],
  ["done", "done-soft", 4.5],
  ["ink", "done-soft", 4.5],
  ["inactive", "surface", 4.5],
  ["inactive", "ground", 4.5],
  ["line-strong", "surface", 3],
  ["focus", "surface", 3],
  ["focus", "ground", 3],
  ["crew-1", "surface", 3],
  ["crew-2", "surface", 3],
  ["crew-3", "surface", 3],
  ["crew-4", "surface", 3],
  ["crew-5", "surface", 3],
  ["crew-6", "surface", 3],
  ["crew-7", "surface", 3],
  ["crew-8", "surface", 3],
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

/** `--aisw-name: value;` for every token. */
export function declareTokens(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `--aisw-${name}: ${value};`)
    .join(" ");
}

const CSS_TEXT = `
:where(.aisw-root) { ${declareTokens(LIGHT_TOKENS)} }
@media (prefers-color-scheme: dark) {
  :where(.aisw-root:not([data-theme="light"])) { ${declareTokens(DARK_TOKENS)} }
}
:where(.aisw-root[data-theme="dark"]) { ${declareTokens(DARK_TOKENS)} }

.aisw-root {
  position: relative; box-sizing: border-box; width: 100%; max-width: 100%;
  background: var(--aisw-surface); color: var(--aisw-ink);
  border: 1px solid var(--aisw-line); border-radius: var(--aisw-radius);
  box-shadow: var(--aisw-shadow); text-align: left;
  font-family: var(--aisw-font); font-size: 15px; line-height: 1.5;
  -webkit-text-size-adjust: 100%;
  color-scheme: light;
}
.aisw-root[data-theme="dark"] { color-scheme: dark; }
@media (prefers-color-scheme: dark) { .aisw-root:not([data-theme="light"]) { color-scheme: dark; } }
.aisw-root *, .aisw-root *::before, .aisw-root *::after { box-sizing: border-box; }
.aisw-root :where(h2, h3, h4, p, ul, ol, dl, dd, fieldset, legend, figure) { margin: 0; padding: 0; }
.aisw-root :where(button, input, select, textarea) { font: inherit; color: inherit; letter-spacing: inherit; }
.aisw-root :where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: 2px solid var(--aisw-focus); outline-offset: 2px;
}
.aisw-root [tabindex="-1"]:focus { outline: none; }
/* Focus moves to each step's heading, which scrolls it into view; keep it
   clear of a host's sticky header (set --aisw-scroll-margin on :root). */
.aisw-root [tabindex="-1"] { scroll-margin-top: var(--aisw-scroll-margin, 96px); }
.aisw-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0;
}
.aisw-root a:not(.aisw-btn) { color: var(--aisw-accent); font-weight: 600; text-underline-offset: 3px; }

.aisw-body { padding: 20px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
@media (max-width: 480px) { .aisw-body { padding: 16px; gap: 16px; } }

.aisw-head { display: grid; gap: 4px; }
.aisw-title { font-size: 19px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.3; color: var(--aisw-ink); }
.aisw-sub { color: var(--aisw-muted); font-size: 14.5px; overflow-wrap: anywhere; }
.aisw-section { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; min-width: 0; }
.aisw-section-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 12px; }
.aisw-h3 { font-size: 16px; font-weight: 700; color: var(--aisw-ink); }
.aisw-step { font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--aisw-muted); }

/* Services */
.aisw-services { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 8px; }
.aisw-service {
  display: grid; gap: 2px; text-align: left; min-height: 44px; cursor: pointer;
  padding: 12px 14px; border: 1px solid var(--aisw-line-strong); border-radius: var(--aisw-radius-sm);
  background: var(--aisw-surface); color: var(--aisw-ink);
  transition: border-color .12s ease, background .12s ease;
}
.aisw-service:hover { border-color: var(--aisw-accent); background: var(--aisw-accent-soft); }
.aisw-service[aria-pressed="true"] { border-color: var(--aisw-accent); background: var(--aisw-accent-soft); box-shadow: inset 0 0 0 1px var(--aisw-accent); }
.aisw-service-name { font-weight: 700; display: flex; justify-content: space-between; gap: 8px; }
.aisw-service-len { font-weight: 500; font-size: 13px; color: var(--aisw-muted); white-space: nowrap; }
.aisw-service-desc { font-size: 13.5px; color: var(--aisw-muted); }

/* The chosen service / time, with a "Change" button */
.aisw-picked {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 14px;
  padding: 12px 14px; border-radius: var(--aisw-radius-sm);
  background: var(--aisw-ground); border: 1px solid var(--aisw-line);
}
.aisw-picked-main { display: grid; gap: 2px; min-width: 0; }
.aisw-picked-when { font-weight: 700; }
.aisw-picked-meta { font-size: 13.5px; color: var(--aisw-muted); }

/* Time zone line */
.aisw-zone { font-size: 13.5px; color: var(--aisw-muted); }
.aisw-zone strong { color: var(--aisw-ink); font-weight: 600; }

/* Date strip: the days that have times, with earlier / later windows. */
.aisw-days-wrap { display: grid; grid-template-columns: 44px minmax(0, 1fr) 44px; gap: 6px; align-items: start; min-width: 0; }
@media (max-width: 480px) {
  .aisw-days-wrap { grid-template-columns: minmax(0, 1fr) 44px 44px; grid-template-areas: "label prev next" "days days days"; }
  .aisw-days-wrap .aisw-days { grid-area: days; }
  .aisw-days-wrap .aisw-days-prev { grid-area: prev; }
  .aisw-days-wrap .aisw-days-next { grid-area: next; }
  .aisw-days-wrap .aisw-days-label { grid-area: label; display: block; align-self: center; font-size: 13px; color: var(--aisw-muted); }
}
.aisw-days-label { display: none; }
.aisw-days-step {
  display: inline-flex; align-items: center; justify-content: center;
  width: 44px; min-height: 44px; height: 68px; padding: 0; cursor: pointer;
  border: 1px solid var(--aisw-line-strong); border-radius: var(--aisw-radius-sm);
  background: var(--aisw-surface); color: var(--aisw-ink);
}
@media (max-width: 480px) { .aisw-days-step { height: 44px; } }
.aisw-days-step:hover:not(:disabled) { border-color: var(--aisw-accent); color: var(--aisw-accent); }
.aisw-days-step:disabled { opacity: .45; cursor: default; }
.aisw-days {
  position: relative; display: flex; gap: 8px; overflow-x: auto; padding: 2px 2px 8px; margin: 0; list-style: none;
  scroll-snap-type: x proximity; scroll-padding-inline: 2px; -webkit-overflow-scrolling: touch; scrollbar-width: thin;
}
.aisw-days > li { flex: 0 0 auto; scroll-snap-align: start; }
.aisw-day {
  position: relative; width: 64px; min-height: 68px; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 1px; padding: 6px 4px; cursor: pointer;
  border: 1px solid var(--aisw-line-strong); border-radius: var(--aisw-radius-sm);
  background: var(--aisw-surface); color: var(--aisw-ink);
}
.aisw-day:hover { border-color: var(--aisw-accent); }
.aisw-day-wd { font-size: 11.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--aisw-muted); }
.aisw-day-n { font-size: 19px; font-weight: 700; line-height: 1.2; }
.aisw-day-m { font-size: 11.5px; color: var(--aisw-muted); }
.aisw-day[aria-pressed="true"] { background: var(--aisw-accent); border-color: var(--aisw-accent); color: var(--aisw-on-accent); }
.aisw-day[aria-pressed="true"] .aisw-day-wd, .aisw-day[aria-pressed="true"] .aisw-day-m { color: var(--aisw-on-accent); }

/* Times */
.aisw-group { display: grid; gap: 8px; }
.aisw-group-label { font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--aisw-muted); }
.aisw-times { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; margin: 0; padding: 0; list-style: none; }
.aisw-time {
  width: 100%; min-height: 44px; padding: 8px 6px; cursor: pointer; font-weight: 600; font-size: 15px;
  border: 1px solid var(--aisw-line-strong); border-radius: var(--aisw-radius-sm);
  background: var(--aisw-surface); color: var(--aisw-accent); font-variant-numeric: tabular-nums;
}
.aisw-time:hover:not(:disabled) { border-color: var(--aisw-accent); background: var(--aisw-accent-soft); }
.aisw-time[aria-pressed="true"] { background: var(--aisw-accent); border-color: var(--aisw-accent); color: var(--aisw-on-accent); }

/* Tags */
.aisw-tag {
  display: inline-flex; align-items: center; gap: 6px; justify-self: start; padding: 3px 10px; border-radius: 999px;
  font-size: 12px; font-weight: 700; letter-spacing: .03em;
  background: var(--aisw-warn-soft); color: var(--aisw-warn); white-space: nowrap;
}
.aisw-tag svg { width: 13px; height: 13px; flex: none; }
.aisw-tag-ok { background: var(--aisw-ok-soft); color: var(--aisw-ok); }
.aisw-tag-danger { background: var(--aisw-danger-soft); color: var(--aisw-danger); }
.aisw-tag-muted { background: var(--aisw-ground); color: var(--aisw-muted); border: 1px solid var(--aisw-line); }
.aisw-tag-progress { background: var(--aisw-progress-soft); color: var(--aisw-progress); }
.aisw-tag-pending { background: var(--aisw-pending-soft); color: var(--aisw-pending); }
.aisw-tag-done { background: var(--aisw-done-soft); color: var(--aisw-done); }

/* Buttons */
.aisw-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 44px; padding: 10px 18px; border-radius: var(--aisw-radius-sm);
  border: 1px solid transparent; font-weight: 600; font-size: 15px; line-height: 1.2;
  cursor: pointer; text-decoration: none; text-align: center; background: transparent; color: var(--aisw-ink);
}
.aisw-btn-primary { background: var(--aisw-accent); color: var(--aisw-on-accent); }
.aisw-btn-primary:hover:not(:disabled) { background: var(--aisw-accent-strong); }
.aisw-btn-secondary { background: var(--aisw-surface); color: var(--aisw-ink); border-color: var(--aisw-line-strong); }
.aisw-btn-secondary:hover:not(:disabled) { background: var(--aisw-ground); border-color: var(--aisw-accent); }
.aisw-btn-danger { background: var(--aisw-danger); color: var(--aisw-on-danger); }
.aisw-btn-danger-outline { background: var(--aisw-surface); color: var(--aisw-danger); border-color: var(--aisw-line-strong); }
.aisw-btn-danger-outline:hover:not(:disabled) { border-color: var(--aisw-danger); background: var(--aisw-danger-soft); }
.aisw-btn-link {
  background: transparent; color: var(--aisw-accent); padding: 8px 4px; min-height: 44px;
  text-decoration: underline; text-underline-offset: 3px;
}
.aisw-btn-block { width: 100%; }
.aisw-btn:disabled { opacity: .55; cursor: not-allowed; }
.aisw-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.aisw-actions > .aisw-btn { flex: 1 1 180px; }

/* Form */
.aisw-form { display: grid; gap: 14px; position: relative; }
.aisw-row2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 14px; }
.aisw-field { display: grid; gap: 6px; align-content: start; min-width: 0; }
.aisw-label { font-size: 14px; font-weight: 600; color: var(--aisw-ink); }
.aisw-optional { font-weight: 400; color: var(--aisw-muted); }
.aisw-input {
  width: 100%; min-height: 44px; padding: 10px 12px;
  /* 16px: anything smaller makes iOS Safari zoom the page on focus. */
  font-size: 16px; border: 1px solid var(--aisw-line-strong); border-radius: var(--aisw-radius-sm);
  background: var(--aisw-surface); color: var(--aisw-ink);
}
.aisw-input::placeholder { color: var(--aisw-faint); }
.aisw-input[aria-invalid="true"] { border-color: var(--aisw-danger); box-shadow: inset 0 0 0 1px var(--aisw-danger); }
textarea.aisw-input { min-height: 92px; resize: vertical; }
.aisw-hint { font-size: 13px; color: var(--aisw-muted); }
.aisw-field-error { font-size: 13px; color: var(--aisw-danger); font-weight: 600; }
/* The honeypot: off-screen, not display:none (some bots skip hidden fields,
   and a display:none field is the first thing a bot learns to ignore). */
.aisw-hp { position: absolute; left: -10000px; top: auto; width: 1px; height: 1px; overflow: hidden; }

/* Notices */
.aisw-notice { padding: 11px 14px; border-radius: var(--aisw-radius-sm); font-size: 14px; border: 1px solid transparent; overflow-wrap: anywhere; }
.aisw-notice-warn { background: var(--aisw-warn-soft); color: var(--aisw-warn); }
.aisw-notice-error { background: var(--aisw-danger-soft); color: var(--aisw-danger); }
.aisw-notice-ok { background: var(--aisw-ok-soft); color: var(--aisw-ok); }
.aisw-notice-info { background: var(--aisw-ground); color: var(--aisw-muted); border-color: var(--aisw-line); }
.aisw-notice a, .aisw-notice .aisw-btn-link { color: inherit; font-weight: 700; }
.aisw-notice .aisw-btn-link { min-height: 0; padding: 0; }

/* Loading */
.aisw-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 28px 0; color: var(--aisw-muted); }
.aisw-spinner {
  width: 20px; height: 20px; border-radius: 50%; flex: none;
  border: 2px solid var(--aisw-line); border-top-color: var(--aisw-accent);
  animation: aisw-spin .8s linear infinite;
}
@keyframes aisw-spin { to { transform: rotate(360deg); } }
.aisw-skeleton { display: grid; gap: 10px; }
.aisw-skeleton-bar { height: 16px; border-radius: 8px; background: var(--aisw-ground); border: 1px solid var(--aisw-line); }
.aisw-skeleton-bar:nth-child(1) { width: 55%; height: 22px; }
.aisw-skeleton-bar:nth-child(2) { width: 35%; }
.aisw-skeleton-bar:nth-child(3) { width: 100%; height: 68px; }
.aisw-skeleton-bar:nth-child(4) { width: 100%; height: 44px; }
@media (prefers-reduced-motion: reduce) {
  .aisw-spinner { animation-duration: 2.4s; }
  .aisw-root * { transition: none !important; }
}
.aisw-empty { display: grid; gap: 8px; justify-items: center; text-align: center; padding: 24px 8px; color: var(--aisw-muted); }
.aisw-empty-title { font-weight: 700; color: var(--aisw-ink); }

/* Confirmation / visit summary */
.aisw-done { display: grid; gap: 16px; }
.aisw-done-head { display: flex; align-items: center; gap: 12px; }
.aisw-badge {
  width: 44px; height: 44px; flex: none; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  background: var(--aisw-ok-soft); color: var(--aisw-ok);
}
.aisw-badge svg { width: 22px; height: 22px; }
.aisw-badge-muted { background: var(--aisw-ground); color: var(--aisw-muted); }
.aisw-badge-warn { background: var(--aisw-pending-soft); color: var(--aisw-pending); }
.aisw-done-title { font-size: 21px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.3; color: var(--aisw-ink); }
.aisw-facts { display: grid; gap: 12px; }
.aisw-fact { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 4px 12px; }
.aisw-fact dt { font-size: 13px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--aisw-muted); padding-top: 2px; }
.aisw-fact dd { overflow-wrap: anywhere; }
@media (max-width: 480px) { .aisw-fact { grid-template-columns: 1fr; } }
.aisw-divider { border: 0; border-top: 1px solid var(--aisw-line); margin: 0; }
.aisw-next { display: grid; gap: 8px; padding: 14px 16px; border-radius: var(--aisw-radius-sm); background: var(--aisw-ground); border: 1px solid var(--aisw-line); }
.aisw-list { display: grid; gap: 6px; padding-left: 20px; list-style: disc; }
.aisw-list li::marker { color: var(--aisw-accent); }

/* A private link to keep: field + copy button. */
.aisw-copy { padding: 12px 14px; border-radius: var(--aisw-radius-sm); background: var(--aisw-ground); border: 1px solid var(--aisw-line); }
.aisw-copy-row { display: flex; flex-wrap: wrap; gap: 8px; }
.aisw-copy-input { flex: 1 1 220px; min-width: 0; text-overflow: ellipsis; }
.aisw-copy-row > .aisw-btn { flex: 0 0 auto; }
`;

export interface InjectStylesOptions {
  /** A CSP nonce, set on the created <style> element. */
  nonce?: string;
}

/** Add `<style id="aisw-styles">` once. A tag that already exists is never duplicated. */
export function injectSchedulingStyles(options: InjectStylesOptions = {}): void {
  injectStyleTag(STYLE_ID, CSS_TEXT, options.nonce);
}

/** The stylesheet text, for a host that renders it itself (SSR, a shadow root). */
export function schedulingWidgetCss(): string {
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
