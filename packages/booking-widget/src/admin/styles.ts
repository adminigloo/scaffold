/**
 * The admin's stylesheet, on top of the widget's. The admin root carries
 * BOTH `aibk-root` and `aibk-admin`: it inherits the widget's tokens (light,
 * dark, and any buyer override on `.aibk-root`), resets, buttons, inputs,
 * notices and the time picker — and this sheet only turns the card-shaped
 * root into a panel and adds what an admin needs (tabs, cards, rows, the
 * checklist). Every class is `aibk-`-prefixed, like the widget's.
 */

const STYLE_ID = "aibk-admin-styles";

const CSS_TEXT = `
.aibk-root.aibk-admin { background: var(--aibk-ground); overflow: visible; box-shadow: none; font-size: 14.5px; }
.aibk-admin-inner { padding: 20px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
@media (max-width: 480px) { .aibk-admin-inner { padding: 16px 12px; gap: 16px; } }
.aibk-admin-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 16px; }
.aibk-admin-title { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.25; color: var(--aibk-ink); }
.aibk-admin .aibk-tag-accent { background: var(--aibk-accent-soft); color: var(--aibk-accent); }

/* Tabs: a real tablist; 44px targets. */
.aibk-tabs { display: flex; flex-wrap: wrap; gap: 2px; border-bottom: 1px solid var(--aibk-line); }
.aibk-tab {
  min-height: 44px; padding: 10px 14px; margin-bottom: -1px; cursor: pointer;
  border: 0; border-bottom: 2px solid transparent; background: transparent;
  color: var(--aibk-muted); font-weight: 600; font-size: 15px;
}
.aibk-tab:hover { color: var(--aibk-ink); }
/* Narrower padding on a phone so the four tabs stay on one row at 390px. */
@media (max-width: 480px) { .aibk-tab { padding: 10px 9px; font-size: 14.5px; } }
.aibk-tab[aria-selected="true"] { color: var(--aibk-accent); border-bottom-color: var(--aibk-accent); }
.aibk-tabpanel { min-width: 0; }

/* Cards and layout */
.aibk-stack { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.aibk-stack-sm { display: grid; gap: 6px; }
.aibk-card {
  background: var(--aibk-surface); border: 1px solid var(--aibk-line); border-radius: var(--aibk-radius);
  box-shadow: var(--aibk-shadow); min-width: 0;
}
.aibk-card-head { padding: 16px 18px 0; display: grid; gap: 4px; }
.aibk-card-title { font-size: 16px; font-weight: 700; color: var(--aibk-ink); }
.aibk-card-hint { font-size: 13.5px; color: var(--aibk-muted); }
.aibk-card-body { padding: 14px 18px 18px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
@media (max-width: 480px) { .aibk-card-head { padding: 14px 14px 0; } .aibk-card-body { padding: 12px 14px 16px; } }
.aibk-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 14px; }
.aibk-span2 { grid-column: 1 / -1; }
.aibk-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.aibk-nowrap { flex-wrap: nowrap; }
.aibk-push { margin-left: auto; }
.aibk-form-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; }
.aibk-form-row > .aibk-field { flex: 0 1 auto; min-width: 0; }
.aibk-form-row > .aibk-grow { flex: 1 1 200px; }
.aibk-number { width: 7.5em; }
.aibk-minute { width: auto; min-width: 9.5em; }
.aibk-fieldset { border: 0; display: grid; gap: 4px; min-width: 0; }
.aibk-check { display: flex; align-items: flex-start; gap: 10px; min-height: 44px; padding: 6px 0; cursor: pointer; }
.aibk-check input { flex: none; width: 18px; height: 18px; margin: 3px 0 0; accent-color: var(--aibk-accent); }
.aibk-admin .aibk-ol { padding-left: 20px; list-style: decimal; display: grid; gap: 2px; }
.aibk-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; overflow-wrap: anywhere; }
.aibk-strong { color: var(--aibk-ink); }
.aibk-ok-text { color: var(--aibk-ok); font-weight: 600; font-size: 14px; }
.aibk-danger-text { color: var(--aibk-danger); font-weight: 600; font-size: 14px; }
.aibk-btn-danger-outline { color: var(--aibk-danger); }
.aibk-btn-danger-outline:hover:not(:disabled) { border-color: var(--aibk-danger); }
.aibk-host-pick { max-width: 320px; }

/* Finish setting up */
.aibk-checklist {
  display: grid; gap: 10px; padding: 14px 16px; border-radius: var(--aibk-radius);
  background: var(--aibk-warn-soft); border: 1px solid var(--aibk-line);
}
.aibk-checklist-title { font-size: 15px; font-weight: 700; color: var(--aibk-warn); }
.aibk-checklist-items { list-style: none; display: grid; gap: 8px; }
.aibk-checklist-item { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; color: var(--aibk-ink); }
/* The dot sits on the text's first line however many lines it wraps to. */
.aibk-checklist-line { flex: 1 1 260px; min-width: 0; display: flex; align-items: flex-start; gap: 12px; }
.aibk-checklist-dot { flex: none; width: 8px; height: 8px; margin-top: .6em; border-radius: 50%; background: var(--aibk-warn); }
.aibk-checklist-text { flex: 1 1 auto; min-width: 0; }
.aibk-checklist-item > .aibk-btn { flex: 0 0 auto; }

/* Bookings */
.aibk-bookings { list-style: none; display: grid; gap: 12px; }
.aibk-booking {
  display: grid; gap: 10px; padding: 16px 18px; min-width: 0;
  background: var(--aibk-surface); border: 1px solid var(--aibk-line); border-radius: var(--aibk-radius); box-shadow: var(--aibk-shadow);
}
@media (max-width: 480px) { .aibk-booking { padding: 14px; } }
.aibk-booking-off { opacity: .8; }
.aibk-booking-top { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 12px; }
.aibk-booking-who { display: grid; gap: 2px; min-width: 0; }
.aibk-booking-when { font-weight: 600; font-variant-numeric: tabular-nums; color: var(--aibk-ink); }
.aibk-booking-name { margin-top: 4px; font-size: 16px; font-weight: 700; color: var(--aibk-ink); overflow-wrap: anywhere; }
.aibk-booking-company { font-weight: 400; color: var(--aibk-muted); }
.aibk-booking-contact { font-size: 14px; overflow-wrap: anywhere; }
.aibk-booking-tags { gap: 6px; }
.aibk-booking-notes { max-width: 70ch; white-space: pre-wrap; color: var(--aibk-muted); overflow-wrap: anywhere; }
.aibk-booking-meta { font-size: 13px; color: var(--aibk-faint); gap: 4px 12px; }
.aibk-booking-meta:empty { display: none; }
.aibk-booking-actions { padding-top: 10px; border-top: 1px solid var(--aibk-line); }
.aibk-panel {
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; padding: 12px 14px; min-width: 0;
  border: 1px solid var(--aibk-line); border-radius: var(--aibk-radius-sm); background: var(--aibk-ground);
}
.aibk-history { list-style: none; font-size: 14px; }

/* The week */
.aibk-week { display: grid; }
.aibk-week-day {
  display: grid; grid-template-columns: 110px minmax(0, 1fr) auto; align-items: start; gap: 8px 12px;
  padding: 10px 0; border-bottom: 1px solid var(--aibk-line);
}
.aibk-week-day:last-child { border-bottom: 0; }
.aibk-week-name { padding-top: 11px; font-weight: 600; color: var(--aibk-ink); }
.aibk-week-windows { display: grid; gap: 8px; min-width: 0; }
.aibk-week-closed { padding-top: 11px; }
@media (max-width: 560px) { .aibk-week-day { grid-template-columns: minmax(0, 1fr); } .aibk-week-name, .aibk-week-closed { padding-top: 0; } }

/* Dated rows */
.aibk-rows { list-style: none; display: grid; gap: 6px; }
.aibk-list-row {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 8px 8px 8px 12px; min-width: 0;
  border: 1px solid var(--aibk-line); border-radius: var(--aibk-radius-sm); background: var(--aibk-surface);
}

/* The feed link, shown once */
.aibk-feed-once { display: grid; gap: 8px; padding: 12px; border-radius: var(--aibk-radius-sm); border: 1px solid var(--aibk-accent); background: var(--aibk-accent-soft); }
.aibk-feed-once .aibk-copy { background: var(--aibk-surface); }
`;

export function injectAdminStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS_TEXT;
  document.head.appendChild(style);
}

/** The admin stylesheet text (the widget's, `bookingWidgetCss()`, goes first), for a host that renders it itself. */
export function bookingAdminCss(): string {
  return CSS_TEXT;
}
