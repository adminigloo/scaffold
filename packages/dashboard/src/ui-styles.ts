/**
 * The dashboard's stylesheet, injected once by <Dashboard />.
 *
 * EVERY COLOUR IS THE HOST'S FIRST. An AdminIgloo app declares its theme as
 * `--color-*` custom properties (canvas, surface, ink, line, accent, ok, warn,
 * danger, and their -soft fills), and this reads those, so the dashboard is the
 * app's own colours in both themes with nothing to configure. The values after
 * each comma are the AdminIgloo defaults, for an app that declares none.
 *
 * Prefixed `aid-` and scoped under `.aid-root`, so nothing here reaches the
 * rest of the page, and `:where()` keeps the tokens at zero specificity: an app
 * that sets `.aid-root { --aid-accent: … }` wins in any order.
 */
export const DASHBOARD_CSS = `
:where(.aid-root) {
  --aid-canvas: var(--color-canvas, #f5f7f9);
  --aid-surface: var(--color-surface, #ffffff);
  --aid-surface-2: var(--color-canvas, #f5f7f9);
  --aid-ink: var(--color-ink, #0e161c);
  --aid-muted: var(--color-ink-muted, #55636f);
  --aid-faint: var(--color-ink-faint, #8494a1);
  --aid-line: var(--color-line, #e1e7ec);
  --aid-line-strong: var(--color-line-strong, #c3ced7);
  --aid-accent: var(--color-accent, #0f766e);
  --aid-accent-strong: var(--color-accent-strong, #0c5f59);
  --aid-accent-soft: var(--color-accent-soft, #d9efec);
  --aid-on-accent: var(--color-surface, #ffffff);
  --aid-good: var(--color-ok, #187339);
  --aid-good-soft: var(--color-ok-soft, #ddf2e3);
  --aid-warn: var(--color-warn, #7d5a0c);
  --aid-warn-soft: var(--color-warn-soft, #f8efd7);
  --aid-bad: var(--color-danger, #a02e21);
  --aid-bad-soft: var(--color-danger-soft, #fbe9e6);
  --aid-shadow: var(--shadow-card, 0 1px 2px rgb(23 64 120 / 0.07), 0 1px 1px rgb(23 64 120 / 0.04));
  --aid-shadow-raised: var(--shadow-raised, 0 4px 12px rgb(23 64 120 / 0.10), 0 1px 3px rgb(23 64 120 / 0.07));
  --aid-radius: var(--radius-card, 12px);
  --aid-radius-control: var(--radius-control, 8px);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :where(.aid-root) {
    --aid-canvas: var(--color-canvas, #0b0f13);
    --aid-surface: var(--color-surface, #12181d);
    --aid-surface-2: var(--color-surface-raised, #1a222a);
    --aid-ink: var(--color-ink, #e8edf1);
    --aid-muted: var(--color-ink-muted, #93a2ae);
    --aid-faint: var(--color-ink-faint, #61707c);
    --aid-line: var(--color-line, #232d35);
    --aid-line-strong: var(--color-line-strong, #38454f);
    --aid-accent: var(--color-accent, #45c4ad);
    --aid-accent-strong: var(--color-accent-strong, #6cd6c3);
    --aid-accent-soft: var(--color-accent-soft, #113029);
    --aid-on-accent: #0b0f13;
    --aid-good: var(--color-ok, #56c586);
    --aid-good-soft: var(--color-ok-soft, #10301d);
    --aid-warn: var(--color-warn, #cfa14e);
    --aid-warn-soft: var(--color-warn-soft, #32270f);
    --aid-bad: var(--color-danger, #e08272);
    --aid-bad-soft: var(--color-danger-soft, #391712);
    --aid-shadow: var(--shadow-card, 0 1px 2px rgb(0 0 0 / 0.4));
    --aid-shadow-raised: var(--shadow-raised, 0 4px 14px rgb(0 0 0 / 0.5));
    color-scheme: dark;
  }
}

.aid-root { color: var(--aid-ink); font: inherit; font-size: 14px; line-height: 1.45; }
.aid-root *, .aid-root *::before, .aid-root *::after { box-sizing: border-box; }
.aid-root a { color: inherit; }
.aid-svg { display: block; flex: none; }
.aid-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* The page's own header. */
.aid-top { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 24px; margin-bottom: 24px; }
.aid-title { margin: 0; font-size: 24px; line-height: 1.33; font-weight: 600; letter-spacing: -0.025em; }
.aid-lede { margin: 4px 0 0; color: var(--aid-muted); max-width: 68ch; font-size: 14px; line-height: 1.625; }
.aid-top-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.aid-stamp { color: var(--aid-muted); font-size: 12.5px; margin-right: 4px; }

/* Buttons. */
.aid-btn { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; border-radius: var(--aid-radius-control);
  border: 1px solid var(--aid-line-strong); background: var(--aid-surface); color: var(--aid-ink); font: inherit; font-size: 13.5px;
  font-weight: 500; cursor: pointer; text-decoration: none; white-space: nowrap; }
.aid-btn:hover { background: var(--aid-surface-2); }
.aid-btn[aria-pressed="true"], .aid-btn[aria-expanded="true"], .aid-btn-primary { background: var(--aid-accent); border-color: var(--aid-accent); color: var(--aid-on-accent); }
.aid-btn[aria-pressed="true"]:hover, .aid-btn[aria-expanded="true"]:hover, .aid-btn-primary:hover { background: var(--aid-accent-strong); border-color: var(--aid-accent-strong); }
.aid-btn:disabled { opacity: .55; cursor: default; }
.aid-iconbtn { display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: var(--aid-radius-control); border: 0;
  background: transparent; color: var(--aid-muted); cursor: pointer; text-decoration: none; padding: 0; }
.aid-iconbtn:hover { background: var(--aid-surface-2); color: var(--aid-ink); }
.aid-iconbtn[aria-pressed="true"] { color: var(--aid-accent); }
.aid-iconbtn:disabled { opacity: .4; cursor: default; }
.aid-root :is(a, button, input, [tabindex]):focus-visible { outline: 2px solid var(--aid-accent); outline-offset: 2px; }

/* Notices. */
.aid-notice { display: flex; gap: 10px; align-items: flex-start; padding: 10px 14px; margin-bottom: 16px; border-radius: var(--aid-radius-control);
  background: var(--aid-warn-soft); color: var(--aid-warn); border: 1px solid color-mix(in srgb, var(--aid-warn) 30%, transparent); }
.aid-notice[data-tone="bad"] { background: var(--aid-bad-soft); color: var(--aid-bad); border-color: color-mix(in srgb, var(--aid-bad) 30%, transparent); }
.aid-notice p { margin: 0; }
.aid-notice[data-tone="info"] { background: var(--aid-surface); color: var(--aid-ink); border-color: var(--aid-line-strong); align-items: center; }
.aid-notice[data-tone="info"] p { flex: 1; }

/* The page: cards, and the catalog beside them while customising. */
.aid-body { display: grid; gap: 20px; align-items: start; }
.aid-root[data-customizing="true"] .aid-body { grid-template-columns: minmax(0, 1fr); }
@media (min-width: 1100px) {
  .aid-root[data-customizing="true"] .aid-body { grid-template-columns: minmax(0, 1fr) 320px; }
}
.aid-gridwrap { container-type: inline-size; container-name: aidgrid; min-width: 0; }
/* Dense: a small card fills a gap a wider one left, so the wall never shows holes.
   The order people set still decides which card comes first. */
.aid-grid { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); grid-auto-flow: row dense; }
@container aidgrid (min-width: 620px) {
  .aid-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .aid-card[data-size="m"], .aid-card[data-size="l"] { grid-column: span 2; }
}
@container aidgrid (min-width: 920px) {
  .aid-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .aid-card[data-size="l"] { grid-column: span 3; }
}
@container aidgrid (min-width: 1280px) {
  .aid-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .aid-card[data-size="l"] { grid-column: span 4; }
}

/* A card. */
.aid-card { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 210px; background: var(--aid-surface);
  border: 1px solid var(--aid-line); border-radius: var(--aid-radius); box-shadow: var(--aid-shadow); container-type: inline-size; container-name: aidcard; }
.aid-card[data-main="true"] { border-color: color-mix(in srgb, var(--aid-accent) 45%, var(--aid-line)); }
.aid-card[data-main="true"]::after { content: ""; position: absolute; inset: -1px -1px auto -1px; height: 3px; border-radius: var(--aid-radius) var(--aid-radius) 0 0; background: var(--aid-accent); }
.aid-card[data-dragging="true"] { opacity: .45; }
.aid-card[data-drop="before"]::before, .aid-card[data-drop="after"]::before { content: ""; position: absolute; top: 10px; bottom: 10px; width: 3px; border-radius: 2px; background: var(--aid-accent); }
.aid-card[data-drop="before"]::before { left: -10px; }
.aid-card[data-drop="after"]::before { right: -10px; }
.aid-root[data-customizing="true"] .aid-card { border-style: dashed; border-color: var(--aid-line-strong); }
.aid-root[data-customizing="true"] .aid-card[data-main="true"] { border-color: var(--aid-accent); }

.aid-head { display: flex; align-items: center; gap: 10px; padding: 10px 8px 10px 12px; border-bottom: 1px solid var(--aid-line); min-height: 52px; }
.aid-grip { display: inline-grid; place-items: center; width: 22px; height: 32px; color: var(--aid-faint); cursor: grab; margin: 0 -4px 0 -4px;
  touch-action: none; user-select: none; border-radius: 6px; }
.aid-grip:hover { color: var(--aid-ink); background: var(--aid-surface-2); }
.aid-card[data-dragging="true"] .aid-grip { cursor: grabbing; }
.aid-ico { display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: var(--aid-radius-control); background: var(--aid-accent-soft); color: var(--aid-accent); flex: none; }
.aid-names { min-width: 0; flex: 1; }
.aid-name { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.aid-name a { text-decoration: none; }
.aid-name a:hover { text-decoration: underline; text-underline-offset: 2px; }
.aid-section { margin: 1px 0 0; font-size: 12px; color: var(--aid-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.aid-attn { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 7px; border-radius: 999px;
  background: var(--aid-accent); color: var(--aid-on-accent); font-size: 12px; font-weight: 600; flex: none; }
.aid-actions { display: flex; align-items: center; gap: 0; flex: none; }
.aid-editbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 8px 6px 12px; border-bottom: 1px solid var(--aid-line); background: var(--aid-surface-2); }
.aid-editbar .aid-sizes { margin: 0; }
.aid-editbar-move { display: inline-flex; margin-left: auto; }
.aid-chipbtn { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 10px; border-radius: var(--aid-radius-control); border: 1px solid var(--aid-line-strong);
  background: var(--aid-surface); color: var(--aid-ink); font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer; }
.aid-chipbtn[aria-pressed="true"] { border-color: var(--aid-accent); color: var(--aid-accent); }
.aid-sizes { display: inline-flex; border: 1px solid var(--aid-line-strong); border-radius: var(--aid-radius-control); overflow: hidden; margin: 0 4px; }
.aid-sizes button { border: 0; background: transparent; color: var(--aid-muted); font: inherit; font-size: 12px; font-weight: 600; width: 26px; height: 26px; cursor: pointer; padding: 0; }
.aid-sizes button + button { border-left: 1px solid var(--aid-line-strong); }
.aid-sizes button[aria-pressed="true"] { background: var(--aid-accent); color: var(--aid-on-accent); }

.aid-content { display: flex; flex-direction: column; gap: 12px; padding: 14px; flex: 1; min-width: 0; }
.aid-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 14px; border-top: 1px solid var(--aid-line); font-size: 12.5px; color: var(--aid-muted); }
.aid-foot a { color: var(--aid-accent); font-weight: 500; text-decoration: none; white-space: nowrap; }
.aid-foot a:hover { text-decoration: underline; text-underline-offset: 2px; }

/* What a glance draws. */
.aid-status { display: flex; gap: 8px; align-items: flex-start; margin: 0; font-size: 13.5px; }
.aid-status .aid-svg { margin-top: 1px; }
.aid-status[data-tone="good"] .aid-svg { color: var(--aid-good); }
.aid-status[data-tone="warn"] .aid-svg { color: var(--aid-warn); }
.aid-status[data-tone="bad"] .aid-svg { color: var(--aid-bad); }
.aid-status[data-tone="neutral"] .aid-svg { color: var(--aid-faint); }

.aid-tiles { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(108px, 1fr)); }
.aid-tile { position: relative; display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 9px 11px 10px; border-radius: var(--aid-radius-control);
  background: var(--aid-surface-2); text-decoration: none; color: var(--aid-ink); }
a.aid-tile:hover { background: color-mix(in srgb, var(--aid-accent) 8%, var(--aid-surface-2)); }
.aid-tile[data-tone="good"] { box-shadow: inset 3px 0 0 var(--aid-good); }
.aid-tile[data-tone="warn"] { box-shadow: inset 3px 0 0 var(--aid-warn); }
.aid-tile[data-tone="bad"] { box-shadow: inset 3px 0 0 var(--aid-bad); }
.aid-tile-label { font-size: 12px; color: var(--aid-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.aid-tile-value { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.15; overflow-wrap: anywhere; }
.aid-card[data-main="true"] .aid-tile-value { font-size: 28px; }
.aid-tile-hint { font-size: 11.5px; color: var(--aid-muted); line-height: 1.3; }

.aid-spark { position: relative; }
.aid-spark-head { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--aid-muted); margin-bottom: 4px; }
.aid-spark-head strong { color: var(--aid-ink); font-weight: 600; }
.aid-spark svg { display: block; width: 100%; height: 44px; overflow: visible; }
.aid-spark .aid-bar { fill: var(--aid-faint); }
.aid-spark .aid-bar[data-last="true"] { fill: var(--aid-accent); }
.aid-spark .aid-bar[data-hover="true"] { fill: var(--aid-ink); }
.aid-spark .aid-base { stroke: var(--aid-line-strong); stroke-width: 1; }
.aid-tip { position: absolute; top: -6px; transform: translate(-50%, -100%); padding: 4px 8px; border-radius: 6px; background: var(--aid-ink); color: var(--aid-surface);
  font-size: 12px; white-space: nowrap; pointer-events: none; box-shadow: var(--aid-shadow-raised); z-index: 2; }

.aid-list h3 { margin: 0 0 2px; font-size: 12px; font-weight: 600; color: var(--aid-muted); text-transform: none; }
.aid-list ul { list-style: none; margin: 0; padding: 0; }
.aid-row { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 7px 0; border-top: 1px solid var(--aid-line); font-size: 13px; }
.aid-row:first-child { border-top: 0; }
.aid-row-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-decoration: none; }
a.aid-row-title:hover { text-decoration: underline; text-underline-offset: 2px; }
.aid-row-meta { flex: none; color: var(--aid-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.aid-chip { flex: none; display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 999px; font-size: 11.5px; font-weight: 600;
  background: var(--aid-surface-2); color: var(--aid-muted); border: 1px solid var(--aid-line); }
.aid-chip[data-tone="good"] { background: var(--aid-good-soft); color: var(--aid-good); border-color: transparent; }
.aid-chip[data-tone="warn"] { background: var(--aid-warn-soft); color: var(--aid-warn); border-color: transparent; }
.aid-chip[data-tone="bad"] { background: var(--aid-bad-soft); color: var(--aid-bad); border-color: transparent; }
.aid-empty { margin: 0; padding: 6px 0; color: var(--aid-muted); font-size: 13px; }
.aid-note { margin: 0; font-size: 12px; color: var(--aid-muted); }
.aid-setup { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 14px; border-radius: var(--aid-radius-control);
  background: var(--aid-surface-2); color: var(--aid-ink); }
.aid-setup p { margin: 0; color: var(--aid-muted); }
.aid-problem { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; color: var(--aid-muted); }
.aid-problem p { margin: 0; }

/* Loading. */
.aid-skel { display: grid; gap: 10px; }
.aid-skel span { display: block; height: 14px; border-radius: 6px; background: var(--aid-surface-2); }
.aid-skel span:nth-child(1) { width: 70%; }
.aid-skel span:nth-child(2) { height: 52px; }
.aid-skel span:nth-child(3) { width: 85%; }
@media (prefers-reduced-motion: no-preference) {
  .aid-skel span { animation: aid-pulse 1.4s ease-in-out infinite; }
  @keyframes aid-pulse { 50% { opacity: .55; } }
}

/* The catalog. */
.aid-catalog { background: var(--aid-surface); border: 1px solid var(--aid-line); border-radius: var(--aid-radius); box-shadow: var(--aid-shadow-raised);
  display: flex; flex-direction: column; min-width: 0; }
/* Above the cards on a narrow screen, where beside them doesn't fit; beside them from 1100px. */
.aid-catalog { order: -1; }
@media (min-width: 1100px) { .aid-catalog { order: 0; position: sticky; top: 16px; max-height: calc(100dvh - 32px); } }
.aid-cat-head { padding: 14px 14px 10px; border-bottom: 1px solid var(--aid-line); }
.aid-cat-head h2 { margin: 0; font-size: 15px; font-weight: 600; }
.aid-cat-head p { margin: 2px 0 10px; font-size: 12.5px; color: var(--aid-muted); }
.aid-search { width: 100%; height: 34px; padding: 0 10px; border-radius: var(--aid-radius-control); border: 1px solid var(--aid-line-strong);
  background: var(--aid-surface); color: var(--aid-ink); font: inherit; font-size: 13.5px; }
.aid-cat-list { overflow: auto; padding: 4px 6px 8px; flex: 1; }
.aid-cat-section { margin-top: 10px; }
.aid-cat-section h3 { margin: 0; padding: 4px 8px; font-size: 11.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--aid-muted); }
.aid-cat-row { display: flex; align-items: flex-start; gap: 10px; padding: 8px; border-radius: var(--aid-radius-control); }
.aid-cat-row:hover { background: var(--aid-surface-2); }
.aid-cat-row input { margin: 3px 0 0; width: 16px; height: 16px; accent-color: var(--aid-accent); flex: none; cursor: pointer; }
.aid-cat-row label { flex: 1; min-width: 0; cursor: pointer; }
.aid-cat-row .aid-cat-title { display: flex; align-items: center; gap: 6px; font-size: 13.5px; font-weight: 500; }
.aid-cat-row .aid-cat-title .aid-svg { color: var(--aid-muted); }
.aid-cat-row .aid-cat-desc { display: block; font-size: 12px; color: var(--aid-muted); margin-top: 1px; }
.aid-cat-foot { display: flex; justify-content: space-between; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--aid-line); }

.aid-blank { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; padding: 48px 20px; border: 1px dashed var(--aid-line-strong);
  border-radius: var(--aid-radius); color: var(--aid-muted); background: var(--aid-surface); }
.aid-blank h2 { margin: 0; color: var(--aid-ink); font-size: 16px; font-weight: 600; }
.aid-blank p { margin: 0; max-width: 46ch; }

@media (prefers-reduced-motion: no-preference) {
  .aid-card { transition: box-shadow .15s ease, opacity .15s ease; }
}
`;
