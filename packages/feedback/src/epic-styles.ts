/**
 * The epics' styles (0.12.0): the badge on a card, the progress bar, the
 * epics list, an epic's page. Appended to the board's stylesheet
 * (board-styles.tsx), so every rule resolves the same `--aib-*` tokens. Text
 * only ever sits on the pairs board-tokens.test.ts measures (ink and
 * ink-muted on surface and surface-2, accent on surface, on-accent on
 * accent); an epic's own colour is only ever a dot, never text.
 *
 * Checked at 390px: rows become cards, nothing has a fixed width past the
 * phone, and every button and field is at least 44px tall (a text link 32px).
 */
export const EPIC_CSS = `
/* The badge: on a card, in the panel, in a list. */
.aib-epic-badge { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; box-sizing: border-box;
  font-size: 11px; line-height: 1.4; color: var(--aib-ink); background: var(--aib-surface-2);
  border: 1px solid var(--aib-line-strong); border-radius: 999px; padding: 1px 8px; }
.aib-epic-badge-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.aib-epic-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.aib-card-epic { margin-top: 6px; display: flex; min-width: 0; }
@media (forced-colors: active) { .aib-epic-dot { forced-color-adjust: none; border: 1px solid CanvasText; } }

/* The progress bar: done, in progress, waiting, then the track (not started). */
.aib-progress { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.aib-progress-bar { display: flex; height: 8px; border-radius: 999px; overflow: hidden; background: var(--aib-line); }
.aib-progress-seg { height: 100%; }
.aib-seg-done { background: var(--aib-accent); }
.aib-seg-doing { background: var(--aib-warn); }
.aib-seg-waiting { background: var(--aib-ink-faint); }
.aib-progress-words { font-size: 12px; color: var(--aib-ink-muted); font-variant-numeric: tabular-nums; }
.aib-progress-key { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--aib-ink-muted); margin: 0; padding: 0; list-style: none; }
.aib-progress-key li { display: inline-flex; align-items: center; gap: 5px; }
.aib-key-swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.aib-key-open { background: var(--aib-line); box-shadow: inset 0 0 0 1px var(--aib-line-strong); }
@media (forced-colors: active) { .aib-progress-seg, .aib-key-swatch { forced-color-adjust: none; } }

/* The epics list. */
.aib-epics-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.aib-epics-head .aib-admin-h { margin-right: auto; }
.aib-epic-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.aib-epic-row { display: grid; grid-template-columns: minmax(0, 2.2fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.6fr); gap: 6px 16px;
  align-items: center; border: 1px solid var(--aib-line); border-radius: 12px; background: var(--aib-surface); padding: 12px 14px; }
.aib-epic-name { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 14px; font-weight: 600; }
.aib-epic-name a, .aib-epic-name button { color: var(--aib-ink); text-decoration: none; overflow-wrap: anywhere; min-width: 0; }
.aib-epic-name a:hover { text-decoration: underline; }
.aib-epic-name a:focus-visible { outline: 2px solid var(--aib-accent); outline-offset: 2px; border-radius: 4px; }
.aib-epic-meta { font-size: 12px; color: var(--aib-ink-muted); display: flex; flex-direction: column; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
.aib-epic-meta b { color: var(--aib-ink); font-weight: 600; }
.aib-late { color: var(--aib-danger); font-weight: 600; }
.aib-epic-status { justify-self: start; }
.aib-status-pill { font-size: 11px; font-weight: 600; border-radius: 999px; padding: 2px 9px; white-space: nowrap;
  border: 1px solid var(--aib-line-strong); background: var(--aib-surface-2); color: var(--aib-ink); }
.aib-status-in_progress { border-color: var(--aib-accent); }
.aib-status-completed { background: var(--aib-accent); color: var(--aib-on-accent); border-color: transparent; }
.aib-status-archived { border-style: dashed; color: var(--aib-ink-muted); }
.aib-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
.aib-tabs .aib-tool-btn[aria-pressed="true"] { background: var(--aib-accent); color: var(--aib-on-accent); border-color: transparent; }
.aib-empty-state { border: 1px dashed var(--aib-line-strong); border-radius: 12px; padding: 18px; font-size: 13px; color: var(--aib-ink-muted);
  background: var(--aib-surface); }
@media (max-width: 720px) {
  .aib-epic-row { grid-template-columns: minmax(0, 1fr) auto; }
  .aib-epic-row .aib-epic-name { grid-column: 1 / 2; }
  .aib-epic-row .aib-epic-status { grid-column: 2 / 3; grid-row: 1; justify-self: end; }
  .aib-epic-row .aib-epic-meta, .aib-epic-row .aib-progress { grid-column: 1 / -1; }
}

/* An epic's page. */
.aib-epic-page { display: flex; flex-direction: column; gap: 16px; }
.aib-epic-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0; font-size: 20px; font-weight: 700;
  overflow-wrap: anywhere; color: var(--aib-ink); }
.aib-epic-title .aib-epic-dot { width: 12px; height: 12px; }
.aib-epic-desc { margin: 0; font-size: 14px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--aib-ink); }
.aib-epic-facts { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 13px; color: var(--aib-ink-muted); margin: 0; }
.aib-epic-facts div { display: flex; gap: 6px; }
.aib-epic-facts dt { color: var(--aib-ink-muted); }
.aib-epic-facts dd { margin: 0; color: var(--aib-ink); font-weight: 600; }
.aib-epic-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
/* The status picker sits in a row-direction field: it grows beside its word
   and never past its own label (a full-width select there ran under Edit). */
.aib-epic-actions > .aib-field > .aib-select { flex: 1 1 auto; width: auto; min-width: 180px; }
.aib-all-done { border: 1px solid var(--aib-accent); border-radius: 12px; background: var(--aib-accent-soft); color: var(--aib-ink);
  padding: 12px 14px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 14px; }
.aib-all-done span { flex: 1 1 220px; }
.aib-group { display: flex; flex-direction: column; gap: 6px; }
.aib-group-h { margin: 0; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--aib-ink-muted);
  display: flex; align-items: center; gap: 8px; }
.aib-group-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.aib-epic-ticket { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; border: 1px solid var(--aib-line); border-radius: 10px;
  background: var(--aib-surface); padding: 6px 6px 6px 10px; min-height: 44px; box-sizing: border-box; }
.aib-epic-ticket.aib-archived { background: var(--aib-surface-2); border-style: dashed; }
.aib-epic-ticket-title { flex: 1 1 200px; min-width: 0; font-size: 13px; color: var(--aib-ink); overflow-wrap: anywhere; }
.aib-epic-ticket-title a { color: var(--aib-ink); }
.aib-epic-ticket-title a:focus-visible { outline: 2px solid var(--aib-accent); outline-offset: 2px; }
.aib-epic-ticket .aib-pill { flex: none; }
.aib-epic-ticket .aib-check { margin: -12px -6px -12px -12px; }
.aib-pick-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 50vh; overflow-y: auto; }
.aib-pick { display: flex; align-items: center; gap: 10px; padding: 4px 8px; min-height: 44px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.aib-pick:hover { background: var(--aib-surface-2); }
.aib-pick input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--aib-accent); flex: none; margin: 0; }
.aib-pick-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.aib-pick-note { font-size: 12px; color: var(--aib-ink-muted); }
.aib-color-pick { display: flex; flex-wrap: wrap; gap: 6px; }
.aib-color-pick .aib-swatch { width: 32px; height: 32px; }
@media (max-width: 560px) {
  .aib-epic-actions > .aib-field { flex: 1 1 100%; }
  .aib-epic-actions > .aib-field > .aib-select { min-width: 0; }
  .aib-epic-title { font-size: 18px; }
}
`;
