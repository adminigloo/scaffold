/**
 * The 0.11.0 surfaces' styles: the filter toolbar and its menus, the New
 * ticket dialog, the panel's editor and activity trail, and the settings
 * screens (./admin). Appended to the board's stylesheet (board-styles.tsx),
 * so every surface resolves the same `--aib-*` tokens — no new colour lives
 * here, only tokens (board-tokens.test.ts measures the pairs).
 *
 * 390px is the width every rule here is checked at: rows wrap, menus become a
 * sheet along the bottom of the screen, and no fixed width exceeds the phone.
 */
export const EXTRA_CSS = `
/* The filter toolbar (0.11.0) — Ask Lou's dropdown model. */
.aib-filterbar { position: relative; }
.aib-filter-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.aib-search { position: relative; flex: 1 1 260px; min-width: 0; max-width: 520px; }
.aib-search .aib-input { padding-left: 32px; }
.aib-search-icon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); width: 13px; height: 13px;
  border: 2px solid var(--aib-ink-faint); border-radius: 50%; box-sizing: border-box; pointer-events: none; }
.aib-search-icon::after { content: ""; position: absolute; width: 6px; height: 2px; background: var(--aib-ink-faint);
  right: -5px; bottom: -3px; transform: rotate(45deg); border-radius: 1px; }
.aib-menu-wrap { position: relative; }
.aib-menu-btn { gap: 6px; }
.aib-menu-btn[aria-expanded="true"], .aib-menu-btn.aib-on { border-color: var(--aib-accent); color: var(--aib-ink); }
.aib-menu-btn.aib-on { background: var(--aib-accent-soft); }
.aib-caret { width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent;
  border-top: 5px solid currentColor; margin-left: 2px; }
.aib-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px;
  box-sizing: border-box; border-radius: 999px; background: var(--aib-accent); color: var(--aib-on-accent); font-size: 11px;
  font-weight: 700; font-variant-numeric: tabular-nums; }
.aib-menu { position: absolute; top: calc(100% + 6px); left: 0; z-index: 30; width: 280px; max-width: calc(100vw - 32px);
  box-sizing: border-box; background: var(--aib-surface); color: var(--aib-ink); border: 1px solid var(--aib-line-strong);
  border-radius: 12px; box-shadow: var(--aib-shadow-panel); padding: 6px; display: flex; flex-direction: column; gap: 4px; }
/* The menu names its filter (on a phone it is a sheet away from its button). */
.aib-menu-title { margin: 0; padding: 6px 6px 0; font-size: 14px; font-weight: 700; color: var(--aib-ink); }
.aib-menu-head { display: flex; align-items: center; gap: 8px; padding: 4px 6px; font-size: 12px; color: var(--aib-ink-muted); }
.aib-menu-head .aib-link { margin-left: auto; }
.aib-link { all: unset; cursor: pointer; color: var(--aib-accent); font-size: 12px; font-weight: 600; padding: 6px 4px;
  border-radius: 6px; min-height: 32px; display: inline-flex; align-items: center; }
.aib-link:hover { text-decoration: underline; }
.aib-link:focus-visible { outline: 2px solid var(--aib-accent); outline-offset: 1px; }
.aib-menu-list { list-style: none; margin: 0; padding: 0; max-height: 300px; overflow-y: auto; }
.aib-option { display: flex; align-items: center; gap: 10px; padding: 0 8px; min-height: 40px; border-radius: 8px; cursor: pointer;
  font-size: 13px; }
.aib-option:hover, .aib-option.aib-active { background: var(--aib-surface-2); }
.aib-option input { width: 16px; height: 16px; accent-color: var(--aib-accent); margin: 0; flex: none; }
.aib-option-label { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.aib-option-count { font-size: 12px; color: var(--aib-ink-faint); font-variant-numeric: tabular-nums; }
.aib-menu-empty { font-size: 12px; color: var(--aib-ink-faint); padding: 10px 8px; }
.aib-dates { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 6px; }
.aib-dates label, .aib-field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .05em; color: var(--aib-ink-muted); min-width: 0; }
.aib-quick { border-radius: 999px; }
.aib-quick[aria-pressed="true"] { background: var(--aib-accent); color: var(--aib-on-accent); border-color: transparent; }
.aib-quick .aib-quick-count { font-variant-numeric: tabular-nums; opacity: .85; margin-left: 4px; }
.aib-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.aib-fchip { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; border: 1px solid var(--aib-line-strong);
  border-radius: 999px; background: var(--aib-surface-2); color: var(--aib-ink); font-size: 12px; padding: 0 2px 0 10px; }
.aib-fchip-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
.aib-fchip button { all: unset; cursor: pointer; width: 32px; height: 32px; display: inline-grid; place-content: center;
  border-radius: 999px; color: var(--aib-ink-muted); font-size: 15px; line-height: 1; }
.aib-fchip button:hover { background: var(--aib-line); color: var(--aib-ink); }
.aib-fchip button:focus-visible { outline: 2px solid var(--aib-accent); }
.aib-count-line { font-size: 13px; color: var(--aib-ink-muted); }
.aib-count-line b { color: var(--aib-ink); font-variant-numeric: tabular-nums; }
.aib-truncated { font-size: 13px; color: var(--aib-ink); border-left: 3px solid var(--aib-warn); padding: 2px 0 2px 10px; }
.aib-sheet-scrim { display: none; }
@media (max-width: 560px) {
  .aib-search { flex-basis: 100%; max-width: none; }
  .aib-menu { position: fixed; left: 8px; right: 8px; top: auto; bottom: 8px; width: auto; max-width: none; max-height: 75vh;
    z-index: 2147483004; }
  .aib-menu-list { max-height: 50vh; }
  .aib-sheet-scrim { display: block; position: fixed; inset: 0; z-index: 2147483003; background: var(--aib-scrim); }
  .aib-fchip-text { max-width: 200px; }
}

/* The column's "+" (0.11.0): New ticket, in this column. */
.aib-col-add { all: unset; cursor: pointer; width: 32px; height: 32px; margin: -6px -6px -6px 0; display: inline-grid;
  place-content: center; border-radius: 8px; color: var(--aib-ink-muted); font-size: 18px; line-height: 1; flex: none; }
.aib-col-add:hover { background: var(--aib-line); color: var(--aib-ink); }
.aib-col-add:focus-visible { outline: 2px solid var(--aib-accent); }

/* Dialogs (0.11.0): New ticket, and the settings screens' "where should these go". */
.aib-dialog-backdrop { position: fixed; inset: 0; z-index: calc(var(--aib-z-panel, 2147483003) + 1); background: var(--aib-scrim); }
.aib-dialog { position: fixed; z-index: calc(var(--aib-z-panel, 2147483003) + 2); left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: min(560px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow-y: auto; box-sizing: border-box;
  background: var(--aib-surface); color: var(--aib-ink); border: 1px solid var(--aib-line-strong); border-radius: 14px;
  box-shadow: var(--aib-shadow-panel); padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.aib-dialog:focus { outline: none; }
.aib-dialog-title { margin: 0; font-size: 16px; font-weight: 700; }
.aib-dialog-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.aib-dialog-grid .aib-wide { grid-column: 1 / -1; }
.aib-dialog textarea, .aib-textarea { border: 1px solid var(--aib-ink-faint); border-radius: 8px; padding: 8px 10px; font: inherit;
  font-size: 13px; background: var(--aib-surface); color: var(--aib-ink); min-height: 88px; resize: vertical; width: 100%;
  box-sizing: border-box; }
.aib-dialog textarea:focus-visible { outline: 2px solid var(--aib-accent); outline-offset: 1px; }
.aib-dialog-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.aib-error { font-size: 13px; color: var(--aib-danger); }
.aib-done { font-size: 14px; display: flex; flex-direction: column; gap: 10px; }
.aib-done-num { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 700; }
.aib-hint { font-size: 12px; color: var(--aib-ink-muted); text-transform: none; letter-spacing: 0; font-weight: 400; }
@media (max-width: 560px) {
  .aib-dialog { top: auto; bottom: 0; transform: translateX(-50%); border-radius: 14px 14px 0 0; max-height: 92vh;
    width: 100vw; }
  .aib-dialog-grid { grid-template-columns: 1fr; }
}

/* The panel's editor (0.11.0): a wrapping row of controls, the title editor, the trail. */
.aib-panel-controls { flex-wrap: wrap; }
.aib-panel-controls label { min-width: 130px; }
.aib-title-edit { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.aib-title-edit .aib-input { flex: 1 1 200px; }
.aib-edit-btn { all: unset; cursor: pointer; font-size: 12px; color: var(--aib-accent); font-weight: 600; padding: 4px 6px;
  border-radius: 6px; margin-left: 4px; }
.aib-edit-btn:hover { text-decoration: underline; }
.aib-edit-btn:focus-visible { outline: 2px solid var(--aib-accent); }
.aib-compose-note { margin: 0; padding: 8px 16px 0; font-size: 12px; color: var(--aib-ink-muted); border-top: 1px solid var(--aib-line); }
.aib-compose-note + .aib-compose { border-top: 0; padding-top: 6px; }
.aib-activity { border-top: 1px solid var(--aib-line); padding-top: 8px; }
.aib-activity summary { cursor: pointer; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
  color: var(--aib-ink-muted); min-height: 32px; display: flex; align-items: center; }
.aib-activity summary:focus-visible { outline: 2px solid var(--aib-accent); }
.aib-activity ol { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.aib-activity li { font-size: 12px; color: var(--aib-ink); overflow-wrap: anywhere; }
.aib-activity time { color: var(--aib-ink-muted); margin-left: 6px; font-size: 11px; }

/* The settings screens (./admin, 0.11.0). */
.aib-admin { display: flex; flex-direction: column; gap: 28px; color: var(--aib-ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.aib-admin-section { display: flex; flex-direction: column; gap: 10px; }
.aib-admin-h { margin: 0; font-size: 17px; font-weight: 700; }
.aib-admin-sub { margin: 0; font-size: 13px; color: var(--aib-ink-muted); line-height: 1.5; max-width: 70ch; }
.aib-admin-card { border: 1px solid var(--aib-line); border-radius: 12px; background: var(--aib-surface); padding: 12px;
  display: flex; flex-direction: column; gap: 8px; }
.aib-admin-row { border: 1px solid var(--aib-line); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 8px;
  background: var(--aib-surface); }
.aib-admin-line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
/* Only an input that IS a row item grows along the row (0.11.0 review): one
   inside a column-direction .aib-field took the flex basis as its HEIGHT and
   rendered 180px tall. */
.aib-admin-line > .aib-input { width: auto; flex: 1 1 180px; min-width: 0; }
.aib-field > .aib-input, .aib-field > .aib-select, .aib-field > textarea { flex: none; width: 100%; min-width: 0; }
.aib-admin-line .aib-narrow { flex: 0 1 96px; }
.aib-admin-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.aib-admin-opts { display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 12px; color: var(--aib-ink-muted); }
.aib-admin-opts label { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; }
.aib-admin-opts .aib-input { width: 72px; min-height: 36px; }
.aib-admin-opts input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--aib-accent); }
.aib-swatches { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.aib-swatch { all: unset; box-sizing: border-box; cursor: pointer; width: 28px; height: 28px; border-radius: 999px;
  border: 2px solid var(--aib-surface); box-shadow: 0 0 0 1px var(--aib-line-strong); }
.aib-swatch[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--aib-ink); }
.aib-swatch:focus-visible { outline: 2px solid var(--aib-accent); outline-offset: 2px; }
.aib-swatch-none { background: repeating-linear-gradient(45deg, var(--aib-surface-2), var(--aib-surface-2) 4px, var(--aib-line) 4px, var(--aib-line) 8px); }
.aib-pill { font-size: 11px; border-radius: 999px; padding: 2px 8px; background: var(--aib-surface-2); color: var(--aib-ink-muted);
  border: 1px solid var(--aib-line); white-space: nowrap; }
.aib-pill-on { background: var(--aib-accent-soft); color: var(--aib-ink); border-color: transparent; }
.aib-tool-danger { color: var(--aib-danger); }
.aib-code { margin: 0; overflow-x: auto; white-space: pre; border-radius: 8px; background: var(--aib-surface-2);
  border: 1px solid var(--aib-line); padding: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px; color: var(--aib-ink); max-width: 100%; box-sizing: border-box; }
.aib-admin a { color: var(--aib-accent); }
@media (max-width: 560px) {
  .aib-admin-actions { margin-left: 0; }
}
`;
