import { injectStyleTag, type InjectStylesOptions } from "../styles.js";

/**
 * The staff screens' stylesheet, on top of the widget's. An admin root carries
 * BOTH `aisw-root` and `aisw-admin`: it inherits the widget's tokens (light,
 * dark, the calendar statuses, the crew colours, and any buyer override on
 * `.aisw-root`), resets, buttons, inputs and notices — and this sheet adds
 * what staff need: the toolbar, the day and week grids, visit blocks, the
 * drawer and dialogs, toasts, today's route, and the settings cards. Every
 * class is `aisw-`-prefixed.
 */

const STYLE_ID = "aisw-admin-styles";

const CSS_TEXT = `
/* The page's one setup card: "3 things to finish", collapsed until opened. */
.aisw-setup { background: var(--aisw-surface); border: 1px solid var(--aisw-line); border-radius: var(--aisw-radius); box-shadow: var(--aisw-shadow); }
.aisw-setup-head { display: flex; align-items: center; gap: 4px; padding: 4px 4px 4px 0; }
.aisw-setup-toggle { flex: 1 1 auto; display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 8px 14px; border: 0; background: transparent; cursor: pointer; text-align: left; color: var(--aisw-ink); border-radius: var(--aisw-radius-sm); }
.aisw-setup-toggle:hover .aisw-setup-title { text-decoration: underline; text-underline-offset: 3px; }
.aisw-setup-count { display: inline-flex; align-items: center; justify-content: center; min-width: 26px; height: 26px; padding: 0 8px; border-radius: 999px; background: var(--aisw-accent-soft); color: var(--aisw-accent-ink); font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
.aisw-setup-title { font-weight: 600; font-size: 15px; }
.aisw-setup-chevron { margin-left: auto; color: var(--aisw-muted); flex: none; }
.aisw-setup-dismiss { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; border: 0; background: transparent; color: var(--aisw-muted); cursor: pointer; border-radius: var(--aisw-radius-sm); }
.aisw-setup-dismiss svg { width: 18px; height: 18px; }
.aisw-setup-dismiss:hover { color: var(--aisw-ink); background: var(--aisw-ground); }
.aisw-setup-body { border-top: 1px solid var(--aisw-line); padding: 12px 18px 16px; display: grid; gap: 10px; }
.aisw-setup-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; font-size: 14px; }
.aisw-setup-list li { position: relative; padding-left: 18px; overflow-wrap: anywhere; }
.aisw-setup-list li::before { content: ""; position: absolute; left: 2px; top: .6em; width: 6px; height: 6px; border-radius: 50%; background: var(--aisw-line-strong); }
.aisw-setup-list a { font-weight: 600; }
.aisw-setup-sub { font-size: 12.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--aisw-muted); padding-top: 4px; }
.aisw-setup-detail { display: block; margin-top: 2px; font-size: 13px; color: var(--aisw-muted); }

.aisw-root.aisw-admin { background: var(--aisw-ground); box-shadow: none; font-size: 14.5px; }
.aisw-admin-inner { padding: 16px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
@media (max-width: 480px) { .aisw-admin-inner { padding: 12px; gap: 12px; } }
.aisw-admin-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.aisw-admin-title { font-size: 21px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.25; color: var(--aisw-ink); }
.aisw-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
.aisw-grow { flex: 1 1 auto; min-width: 0; }
.aisw-stack { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
.aisw-stack-sm { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.aisw-btn-sm { min-height: 44px; padding: 8px 12px; font-size: 14px; }
.aisw-ok-text { color: var(--aisw-ok); font-weight: 600; font-size: 14px; }
.aisw-danger-text { color: var(--aisw-danger); font-weight: 600; font-size: 14px; }
.aisw-muted { color: var(--aisw-muted); }
.aisw-dirty { color: var(--aisw-warn); font-weight: 600; font-size: 13.5px; }
.aisw-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; flex: none; }

/* Toolbar */
.aisw-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.aisw-toolbar-label { font-size: 16px; font-weight: 700; color: var(--aisw-ink); min-width: 0; margin-right: auto; }
.aisw-seg { display: inline-flex; border: 1px solid var(--aisw-line-strong); border-radius: var(--aisw-radius-sm); overflow: hidden; }
.aisw-seg button {
  min-height: 44px; min-width: 64px; padding: 8px 14px; border: 0; cursor: pointer; font-weight: 600;
  background: var(--aisw-surface); color: var(--aisw-ink);
}
.aisw-seg button + button { border-left: 1px solid var(--aisw-line-strong); }
.aisw-seg button[aria-pressed="true"] { background: var(--aisw-accent); color: var(--aisw-on-accent); }
.aisw-icon-btn { min-width: 44px; padding: 8px; }
.aisw-count {
  display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 6px;
  border-radius: 999px; background: var(--aisw-pending-soft); color: var(--aisw-pending); font-size: 12.5px; font-weight: 700;
}
.aisw-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.aisw-chip-filter {
  display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 6px 14px; cursor: pointer;
  border: 1px solid var(--aisw-line-strong); border-radius: 999px; background: var(--aisw-surface); color: var(--aisw-ink); font-weight: 600; font-size: 14px;
}
.aisw-chip-filter[aria-pressed="true"] { background: var(--aisw-accent-soft); border-color: var(--aisw-accent); }

/* Day view: a time column, then one column per crew. Sideways scroll on a phone. */
.aisw-cal { position: relative; overflow-x: auto; border: 1px solid var(--aisw-line); border-radius: var(--aisw-radius); background: var(--aisw-surface); }
.aisw-day-grid { display: grid; min-width: 100%; }
.aisw-col-head {
  position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 8px 10px;
  background: var(--aisw-surface); border-bottom: 1px solid var(--aisw-line); border-left: 1px solid var(--aisw-line);
  font-weight: 700; font-size: 14px; color: var(--aisw-ink); overflow-wrap: anywhere;
}
.aisw-col-head:first-child { border-left: 0; }
.aisw-col-head small { font-weight: 500; color: var(--aisw-muted); }
.aisw-times-col { position: relative; }
.aisw-hour { position: absolute; right: 8px; transform: translateY(-50%); font-size: 12px; color: var(--aisw-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.aisw-col {
  position: relative; border-left: 1px solid var(--aisw-line);
  /* Off-hours: shaded with stripes, so it reads without colour too. */
  background: repeating-linear-gradient(135deg, var(--aisw-ground) 0 8px, var(--aisw-surface) 8px 16px);
}
.aisw-col-window { position: absolute; left: 0; right: 0; background: var(--aisw-surface); }
.aisw-hour-line { position: absolute; left: 0; right: 0; height: 0; border-top: 1px solid var(--aisw-line); pointer-events: none; }
.aisw-step-line { position: absolute; left: 0; right: 0; height: 0; border-top: 1px dashed var(--aisw-line); pointer-events: none; opacity: .7; }
.aisw-col[data-drop-target] { box-shadow: inset 0 0 0 2px var(--aisw-accent); }
.aisw-now-line { position: absolute; left: 0; right: 0; height: 0; border-top: 2px solid var(--aisw-danger); z-index: 2; pointer-events: none; }

.aisw-block {
  position: absolute; z-index: 1; display: grid; align-content: start; gap: 1px; overflow: hidden; text-align: left;
  padding: 4px 6px 4px 9px; border-radius: 8px; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none;
  font-size: 12.5px; line-height: 1.3; color: var(--aisw-ink);
  background: var(--aisw-surface); border: 1px solid var(--aisw-line-strong);
  box-shadow: inset 4px 0 0 0 var(--aisw-crew, var(--aisw-accent));
}
.aisw-block:hover { border-color: var(--aisw-accent); }
.aisw-block-time { font-weight: 700; font-variant-numeric: tabular-nums; }
.aisw-block-who { font-weight: 600; overflow-wrap: anywhere; }
.aisw-block-what { color: var(--aisw-muted); overflow-wrap: anywhere; }
.aisw-block-status { display: inline-flex; align-items: center; gap: 4px; font-weight: 700; font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; }
.aisw-block-status svg { width: 12px; height: 12px; }
.aisw-block[data-status="pending"] { border-style: dashed; border-width: 2px; border-color: var(--aisw-pending); background: var(--aisw-pending-soft); }
.aisw-block[data-status="pending"] .aisw-block-status { color: var(--aisw-pending); }
.aisw-block[data-status="in_progress"] { border-color: var(--aisw-progress); background: var(--aisw-progress-soft); }
.aisw-block[data-status="in_progress"] .aisw-block-status { color: var(--aisw-progress); }
.aisw-block[data-status="completed"] { background: var(--aisw-done-soft); color: var(--aisw-muted); border-color: var(--aisw-line); }
.aisw-block[data-status="completed"] .aisw-block-status { color: var(--aisw-done); }
.aisw-block[data-status="no_show"], .aisw-block[data-status="cancelled"], .aisw-block[data-status="declined"], .aisw-block[data-status="expired"] {
  color: var(--aisw-inactive); background: var(--aisw-ground); border-color: var(--aisw-line);
}
.aisw-block[data-status="no_show"] .aisw-block-who, .aisw-block[data-status="no_show"] .aisw-block-time,
.aisw-block[data-status="cancelled"] .aisw-block-who, .aisw-block[data-status="cancelled"] .aisw-block-time { text-decoration: line-through; }
.aisw-block[data-fixed] { cursor: not-allowed; touch-action: auto; }
.aisw-block[data-dragging] { z-index: 6; cursor: grabbing; box-shadow: inset 4px 0 0 0 var(--aisw-crew, var(--aisw-accent)), var(--aisw-shadow); opacity: .92; }
.aisw-block[data-saving] { opacity: .7; }

/* Week view: a dispatch board, crews down the side, days across. */
.aisw-week-grid { display: grid; min-width: 100%; }
.aisw-week-head { position: sticky; top: 0; z-index: 2; padding: 8px; min-height: 44px; background: var(--aisw-surface); border-bottom: 1px solid var(--aisw-line); border-left: 1px solid var(--aisw-line); font-weight: 700; font-size: 13.5px; }
.aisw-week-head[data-today] { color: var(--aisw-accent); }
.aisw-week-crew { display: flex; align-items: flex-start; gap: 8px; padding: 10px; font-weight: 700; border-top: 1px solid var(--aisw-line); overflow-wrap: anywhere; }
.aisw-cell { display: grid; align-content: start; gap: 4px; min-height: 72px; padding: 4px; border-top: 1px solid var(--aisw-line); border-left: 1px solid var(--aisw-line); background: var(--aisw-surface); min-width: 0; }
.aisw-cell[data-off] { background: repeating-linear-gradient(135deg, var(--aisw-ground) 0 8px, var(--aisw-surface) 8px 16px); }
.aisw-cell[data-drop-target] { box-shadow: inset 0 0 0 2px var(--aisw-accent); }
.aisw-cell-off { font-size: 12px; color: var(--aisw-muted); padding: 2px 4px; }
.aisw-chip {
  position: relative; display: grid; gap: 0; width: 100%; min-height: 44px; padding: 4px 6px 4px 9px; text-align: left; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none;
  border: 1px solid var(--aisw-line-strong); border-radius: 8px; background: var(--aisw-surface); color: var(--aisw-ink); font-size: 12.5px; line-height: 1.3;
  box-shadow: inset 4px 0 0 0 var(--aisw-crew, var(--aisw-accent));
}
.aisw-chip[data-status="pending"] { border-style: dashed; border-width: 2px; border-color: var(--aisw-pending); background: var(--aisw-pending-soft); }
.aisw-chip[data-status="in_progress"] { border-color: var(--aisw-progress); background: var(--aisw-progress-soft); }
.aisw-chip[data-status="completed"] { background: var(--aisw-done-soft); color: var(--aisw-muted); }
.aisw-chip[data-status="no_show"] { color: var(--aisw-inactive); text-decoration: line-through; }
.aisw-chip[data-fixed] { cursor: not-allowed; touch-action: auto; }
.aisw-chip[data-dragging] { z-index: 6; opacity: .92; box-shadow: var(--aisw-shadow); }

.aisw-cal-empty { display: grid; justify-items: center; gap: 6px; padding: 28px 16px; text-align: center; background: var(--aisw-surface); border: 1px solid var(--aisw-line); border-radius: var(--aisw-radius); }
.aisw-cal-empty-title { font-weight: 700; font-size: 16px; color: var(--aisw-ink); }
.aisw-cal-empty-text { max-width: 56ch; color: var(--aisw-muted); font-size: 14px; }
.aisw-cal-empty-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 8px; }

/* Dialogs and the visit drawer */
.aisw-backdrop { position: fixed; inset: 0; z-index: 2147483000; background: var(--aisw-scrim); display: flex; align-items: center; justify-content: center; padding: 16px; }
.aisw-dialog {
  position: relative; display: grid; grid-template-rows: auto minmax(0, 1fr); max-height: calc(100vh - 32px); width: min(520px, 100%);
  background: var(--aisw-surface); color: var(--aisw-ink); border: 1px solid var(--aisw-line); border-radius: var(--aisw-radius);
  box-shadow: var(--aisw-shadow-lg); text-align: left;
}
.aisw-backdrop[data-variant="drawer"] { justify-content: flex-end; align-items: stretch; padding: 0; }
.aisw-backdrop[data-variant="drawer"] .aisw-dialog { width: min(460px, 100vw); max-height: none; height: 100%; border-radius: 0; border-width: 0 0 0 1px; }
.aisw-dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--aisw-line); }
.aisw-dialog-title { font-size: 17px; font-weight: 700; line-height: 1.3; color: var(--aisw-ink); }
.aisw-dialog-body { overflow-y: auto; padding: 16px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-content: start; }
.aisw-dialog-close { min-width: 44px; min-height: 44px; padding: 8px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--aisw-line-strong); border-radius: var(--aisw-radius-sm); background: var(--aisw-surface); color: var(--aisw-ink); cursor: pointer; }
.aisw-dialog-close svg { width: 18px; height: 18px; }
.aisw-kv { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 6px 12px; }
.aisw-kv dt { font-size: 12.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--aisw-muted); padding-top: 2px; }
.aisw-kv dd { overflow-wrap: anywhere; min-width: 0; }
.aisw-kv dd a { display: inline-block; min-height: 24px; line-height: 24px; }
.aisw-check { display: flex; align-items: flex-start; gap: 10px; min-height: 44px; padding: 10px 0; cursor: pointer; }
.aisw-check input { flex: none; width: 20px; height: 20px; margin: 1px 0 0; accent-color: var(--aisw-accent); }
.aisw-panel-box { display: grid; gap: 10px; padding: 12px 14px; border: 1px solid var(--aisw-line); border-radius: var(--aisw-radius-sm); background: var(--aisw-ground); }
.aisw-suggestions { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.aisw-suggestion {
  display: grid; gap: 2px; width: 100%; min-height: 44px; padding: 8px 12px; text-align: left; cursor: pointer;
  border: 1px solid var(--aisw-line-strong); border-radius: var(--aisw-radius-sm); background: var(--aisw-surface); color: var(--aisw-ink);
}
.aisw-suggestion[aria-pressed="true"] { border-color: var(--aisw-accent); background: var(--aisw-accent-soft); }
.aisw-suggestion small { color: var(--aisw-muted); font-size: 13px; }

/* Requests */
.aisw-requests { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.aisw-request { display: grid; gap: 6px; padding: 12px; border: 2px dashed var(--aisw-pending); border-radius: var(--aisw-radius-sm); background: var(--aisw-pending-soft); }
.aisw-request-when { font-weight: 700; }
.aisw-request-meta { font-size: 13.5px; color: var(--aisw-ink); }
.aisw-request-where { font-size: 13.5px; color: var(--aisw-ink); overflow-wrap: anywhere; }

/* Toasts */
.aisw-toasts { position: fixed; z-index: 2147483001; left: 50%; bottom: 16px; transform: translateX(-50%); width: min(480px, calc(100vw - 32px)); display: grid; gap: 8px; pointer-events: none; }
.aisw-toast { pointer-events: auto; display: flex; align-items: flex-start; gap: 10px; padding: 10px 10px 10px 14px; border-radius: var(--aisw-radius-sm); box-shadow: var(--aisw-shadow); border: 1px solid var(--aisw-line); font-size: 14px; }
.aisw-toast-text { flex: 1 1 auto; padding-top: 10px; overflow-wrap: anywhere; }
.aisw-toast-ok { background: var(--aisw-ok-soft); color: var(--aisw-ok); }
.aisw-toast-warn { background: var(--aisw-warn-soft); color: var(--aisw-warn); }
.aisw-toast-error { background: var(--aisw-danger-soft); color: var(--aisw-danger); }
.aisw-toast .aisw-dialog-close { background: transparent; border-color: transparent; color: inherit; }

/* Today's route: phone first. */
.aisw-route-head { display: grid; gap: 6px; }
.aisw-route-nav { display: grid; grid-template-columns: 44px minmax(0, 1fr) 44px; align-items: center; gap: 8px; }
.aisw-route-date { text-align: center; font-weight: 700; font-size: 16px; }
.aisw-route-totals { font-size: 14px; color: var(--aisw-muted); }
.aisw-stops { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.aisw-stop {
  display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 10px 12px; padding: 14px;
  background: var(--aisw-surface); border: 1px solid var(--aisw-line); border-radius: var(--aisw-radius); box-shadow: var(--aisw-shadow);
}
.aisw-stop[data-status="completed"] { background: var(--aisw-done-soft); }
.aisw-stop[data-status="in_progress"] { border-color: var(--aisw-progress); box-shadow: inset 0 0 0 1px var(--aisw-progress); }
.aisw-stop-n {
  width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  background: var(--aisw-accent); color: var(--aisw-on-accent); font-size: 20px; font-weight: 800;
}
.aisw-stop[data-status="completed"] .aisw-stop-n { background: var(--aisw-done); color: var(--aisw-surface); }
.aisw-stop-main { display: grid; gap: 4px; min-width: 0; }
.aisw-stop-when { font-weight: 700; font-size: 15px; font-variant-numeric: tabular-nums; }
.aisw-stop-who { font-size: 17px; font-weight: 700; overflow-wrap: anywhere; }
.aisw-stop-address { overflow-wrap: anywhere; }
.aisw-stop-notes { white-space: pre-wrap; color: var(--aisw-muted); overflow-wrap: anywhere; }
.aisw-stop-drive { font-size: 13.5px; color: var(--aisw-muted); }
.aisw-stop-actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 8px; }
.aisw-stop-actions > .aisw-btn { flex: 1 1 140px; }
.aisw-done-stamp { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; color: var(--aisw-done); min-height: 44px; }
.aisw-done-stamp svg { width: 20px; height: 20px; }

/* Settings */
.aisw-card { background: var(--aisw-surface); border: 1px solid var(--aisw-line); border-radius: var(--aisw-radius); box-shadow: var(--aisw-shadow); min-width: 0; }
.aisw-card-head { padding: 16px 18px 0; display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; }
.aisw-card-title { font-size: 16.5px; font-weight: 700; color: var(--aisw-ink); }
.aisw-card-hint { flex-basis: 100%; font-size: 13.5px; color: var(--aisw-muted); }
.aisw-card-body { padding: 14px 18px 18px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
@media (max-width: 480px) { .aisw-card-head { padding: 14px 14px 0; } .aisw-card-body { padding: 12px 14px 16px; } }
.aisw-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 14px; }
.aisw-number { max-width: 9em; }
.aisw-inline-fields { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.aisw-inline-fields > .aisw-input { width: auto; flex: 0 1 auto; }
.aisw-service-row { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--aisw-line); border-radius: var(--aisw-radius-sm); background: var(--aisw-ground); }
.aisw-week-row { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 8px 12px; align-items: start; padding: 10px 0; border-bottom: 1px solid var(--aisw-line); }
.aisw-week-row:last-child { border-bottom: 0; }
.aisw-week-day { padding-top: 11px; font-weight: 600; }
.aisw-week-windows { display: grid; gap: 8px; min-width: 0; }
@media (max-width: 560px) { .aisw-week-row { grid-template-columns: minmax(0, 1fr); } .aisw-week-day { padding-top: 0; } }
.aisw-list-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.aisw-list-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 6px 6px 6px 12px; border: 1px solid var(--aisw-line); border-radius: var(--aisw-radius-sm); background: var(--aisw-surface); }
.aisw-root details > summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; font-weight: 600; }
.aisw-switch { display: flex; align-items: flex-start; gap: 12px; min-height: 44px; padding: 8px 0; cursor: pointer; }
.aisw-switch input { flex: none; appearance: none; -webkit-appearance: none; width: 44px; height: 26px; margin: 0; border-radius: 999px; position: relative; cursor: pointer;
  background: var(--aisw-line-strong); border: 0; transition: background .12s ease; }
.aisw-switch input::after { content: ""; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: var(--aisw-surface); transition: transform .12s ease; }
.aisw-switch input:checked { background: var(--aisw-accent); }
.aisw-switch input:checked::after { transform: translateX(18px); }
.aisw-switch input:disabled { opacity: .55; cursor: not-allowed; }
.aisw-switch-text { display: grid; gap: 2px; }
.aisw-switch-text strong { font-weight: 600; }
`;

/** Add `<style id="aisw-admin-styles">` once (the widget's sheet is injected too, by every admin component). */
export function injectSchedulingAdminStyles(options: InjectStylesOptions = {}): void {
  injectStyleTag(STYLE_ID, CSS_TEXT, options.nonce);
}

/** The admin stylesheet text (render `schedulingWidgetCss()` first), for SSR or a shadow root. */
export function schedulingAdminCss(): string {
  return CSS_TEXT;
}
